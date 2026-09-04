"""
Durable + vector memory on a single SQLite file.

Replaces the old Redis-plus-Postgres split with one `concaretti.db`:

  durable tier   sessions, audit log, artifacts, SMS threads, diary entries —
                 the chronological record, including a content hash per
                 artifact so a generated file can be traced back to the prompt
                 and reasoning path that produced it.

  vector tier    `sqlite-vec` virtual table over context entries, giving
                 cross-session semantic recall without a separate service.

Rule 0 (the privacy boundary) is enforced here rather than in the agent layer.
Emotionally sensitive content is recorded in its own session transcript so the
live conversation stays coherent, but it is never embedded, never indexed, and
never returned by recall — including to a later session that asks for it
directly. The exclusion is applied twice: once at write time (no vector row is
created) and again at read time (`sensitive = 0` filter), so a bug in either
path alone cannot leak it.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import struct
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import sqlite_vec

DB_PATH = Path(__file__).parent / "concaretti.db"

EMBED_DIM = 768
COMPRESS_TOKEN_THRESHOLD = 10_000
MAX_ENTRIES_KEPT = 30


# ═══════════════════════════════════════════════════════════════════════════
# Rule 0 — therapy / distress exclusion
# ═══════════════════════════════════════════════════════════════════════════

# Ported verbatim from the original ContextWindowService. These decide what
# never reaches long-term semantic memory. Kept as five separate patterns
# rather than one union so the matching family is identifiable when auditing.
SENSITIVE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"\b(depress(ed|ion|ing)?|anxiet(y|ies)|anxious|suicid\w*|self[- ]?harm)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(want to die|kill (myself|me)|end (it all|my life)|hopeless|worthless)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(panic attack|mental(ly)? (health|ill)|therapy|therapist|counsel(ing|lor))\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(i('m| am) (dying|struggling|hurting|broken|not ok(ay)?)"
        r"|can'?t go on|giving up)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(grief|grieving|trauma(tic|tized)?|abuse[dr]?|lonely|loneliness|crisis)\b",
        re.IGNORECASE,
    ),
)


def is_sensitive(text: str) -> bool:
    """True when text trips any Rule-0 pattern. Cheap enough to call freely."""
    if not text:
        return False
    return any(p.search(text) for p in SENSITIVE_PATTERNS)


def matched_rule0_families(text: str) -> list[int]:
    """Which pattern families matched — for the audit log, never for recall."""
    return [i for i, p in enumerate(SENSITIVE_PATTERNS) if p.search(text)]


# ═══════════════════════════════════════════════════════════════════════════
# Invariant 3 — a key or a seed phrase must never be persisted
# ═══════════════════════════════════════════════════════════════════════════

# `tools._looks_like_secret` already refuses key-shaped chain arguments, and its
# comment explains that a purely structural seed match is safe there "because of
# where it is applied": an address field holding twelve lowercase words is never
# legitimate. That reasoning is sound and that check still stands.
#
# Its precondition does not hold one layer up, and end-to-end verification found
# the gap that leaves. An inbound prompt is written to disk twice before any tool
# is chosen — `create_session` stores it in `sessions.prompt` and `sessions.title`,
# and the orchestrator appends it as the user turn — so a phrase pasted mid
# sentence reached the write-ahead log with `sensitive = 0` while the chain screen,
# which runs later against an already-parsed payload, never saw it. The refusal
# was written correctly. It was simply downstream of the persistence.
#
# So this layer needs its own matcher, differing from the tool one in two ways:
#
#   * Windowed, not anchored. The phrase that got through arrived as
#     `… transfer 0.1 SOL to So111… with memo "abandon abandon … about"`, and an
#     anchored whole-string pattern cannot see a run embedded in prose.
#   * Every word in the run must be 3-8 letters joined by single spaces. The
#     upper bound is the longest entry in the BIP39 wordlist, and the strictness
#     is what keeps ordinary prose out: English is dense with one- and two-letter
#     function words, and a comma, a digit or a hyphen ends a run.
#
# Matching is done on the lowercased text, so a phrase pasted with capitals is
# still caught. That widens the prose exposure, which is why `test_invariants`
# runs a corpus of real operator phrasings through it rather than trusting the
# reasoning here.
#
# A false positive costs one rephrase, and the message says exactly that. A miss
# is unrecoverable — there is no rotate and no revoke for a seed phrase — so this
# fails closed, the same way the approval gate rejects on timeout rather than
# reading silence as consent.
_SEED_RUN = re.compile(r"(?:\b[a-z]{3,8}\b ){11,}\b[a-z]{3,8}\b")
_HEX64_RUN = re.compile(r"\b[0-9a-fA-F]{64}\b")
# A Solana secret key is 64 bytes, or 85-90 base58 characters. Public keys are
# 32 bytes and 43-44 characters, so length alone separates them.
_B58_SECRET_RUN = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{85,90}\b")
_BYTE_ARRAY_RUN = re.compile(r"\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]")


def contains_secret_material(text: str) -> str:
    """
    Name the kind of secret `text` appears to carry, or "" when it looks clean.

    Called before the first write of an inbound prompt, so a match must not be
    logged, hashed, embedded or summarised anywhere — the record would itself be
    the leak. Callers refuse and forget; they do not describe what they saw.
    """
    if not text:
        return ""
    probe = " ".join(text.split())
    if _SEED_RUN.search(probe.lower()):
        return "a recovery phrase"
    if _B58_SECRET_RUN.search(probe):
        return "a base58 secret key"
    if _HEX64_RUN.search(probe):
        return "a 64-character hex key"
    if _BYTE_ARRAY_RUN.search(probe):
        return "a keypair byte array"
    return ""


# What replaces a prompt that trips the screen. The row still exists — a refused
# run should be visible as having happened — but it holds this instead of the
# text, because `sessions.prompt` is read back by `/api/sessions` and rendered.
SECRET_PLACEHOLDER = "[refused: possible secret material — never stored]"

# One message for both layers that can refuse: the orchestrator screening an
# inbound prompt, and the chain tools screening their own arguments. Shared
# rather than duplicated because the last paragraph is the part that matters and
# it should not be possible for one copy to drift into omitting it.
KEY_REFUSAL = (
    "That input looks like {what}, so I stopped before doing anything with it — "
    "including logging it. I have not stored it, hashed it, embedded it or sent it "
    "anywhere, and I am not going to ask for it again.\n\n"
    "I never need one. This agent reads public addresses and builds *unsigned* "
    "transactions; you sign them in your own wallet, where the key stays. If that "
    "phrase or key has ever been pasted into any chatbot, treat it as compromised "
    "and move the funds to a fresh wallet.\n\n"
    "If that was not a key — twelve or more short lowercase words in a row will "
    "trip this — rephrase with any punctuation and it will go through."
)


# ═══════════════════════════════════════════════════════════════════════════
# Records
# ═══════════════════════════════════════════════════════════════════════════


@dataclass
class ContextEntry:
    id: int
    session_id: str
    role: str
    content: str
    agent: str | None
    ts: float
    sensitive: bool = False
    distance: float | None = None


@dataclass
class Artifact:
    id: str
    session_id: str
    filename: str
    mime: str
    path: str
    sha256: str
    prompt: str
    ts: float


@dataclass
class SmsMessage:
    id: str
    direction: str  # "inbound" | "outbound"
    peer: str
    body: str
    ts: float
    status: str = "delivered"
    pending_approval: bool = False
    kind: str = "sms"  # "sms" | "call"


@dataclass
class DiaryEntry:
    id: str
    day: str
    summary: str
    reflection: str
    agent_assisted: bool
    ts: float


@dataclass
class ScheduledJob:
    id: str
    cron: str
    prompt: str
    enabled: bool
    last_run: float | None = None


# ═══════════════════════════════════════════════════════════════════════════
# Embeddings
# ═══════════════════════════════════════════════════════════════════════════


def _serialize_f32(vec: Iterable[float]) -> bytes:
    """Pack a float list into the little-endian blob sqlite-vec expects."""
    values = list(vec)
    return struct.pack(f"<{len(values)}f", *values)


_TOKEN_RE = re.compile(r"[a-z0-9']+")


def _hashed_embedding(text: str, dim: int = EMBED_DIM) -> list[float]:
    """
    Deterministic feature-hashed embedding, used when no embedding API is
    reachable.

    This is lexical rather than semantic — it will match "exam revision plan"
    to "revision plan for exams" but not to "study schedule". That is a real
    limitation, and it is the right trade for a demo that has to work with the
    network unplugged. Sub-linear term weighting keeps long documents from
    dominating the vector.
    """
    vec = [0.0] * dim
    counts: dict[str, int] = {}
    for token in _TOKEN_RE.findall(text.lower()):
        if len(token) < 3:
            continue
        counts[token] = counts.get(token, 0) + 1

    for token, count in counts.items():
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        idx = int.from_bytes(digest[:4], "little") % dim
        sign = 1.0 if digest[4] & 1 else -1.0
        vec[idx] += sign * (1.0 + math.log(count))

    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


def _gemini_embedding(text: str, api_key: str) -> list[float] | None:
    """Try Gemini's embedding endpoint. Returns None on any failure."""
    import httpx

    url = (
        "https://generativelanguage.googleapis.com/v1beta/"
        "models/text-embedding-004:embedContent"
    )
    try:
        resp = httpx.post(
            url,
            params={"key": api_key},
            json={
                "model": "models/text-embedding-004",
                "content": {"parts": [{"text": text[:8000]}]},
            },
            timeout=8.0,
        )
        if resp.status_code != 200:
            return None
        values = resp.json().get("embedding", {}).get("values")
        if not values or len(values) != EMBED_DIM:
            return None
        return [float(v) for v in values]
    except Exception:
        return None


def embed(text: str) -> tuple[list[float], str]:
    """
    Embed text, returning `(vector, source)`.

    Prefers the real embedding API so recall is semantic; degrades to feature
    hashing rather than failing, because an offline demo still needs a working
    Recall panel.
    """
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key and not key.startswith("YOUR_"):
        vec = _gemini_embedding(text, key)
        if vec is not None:
            return vec, "text-embedding-004"
    return _hashed_embedding(text), "hashed-local"


# ═══════════════════════════════════════════════════════════════════════════
# Store
# ═══════════════════════════════════════════════════════════════════════════

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    created_at  REAL NOT NULL,
    role        TEXT,
    title       TEXT,
    summary     TEXT DEFAULT '',
    prompt      TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS context_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    agent       TEXT,
    ts          REAL NOT NULL,
    sensitive   INTEGER NOT NULL DEFAULT 0,
    embedded    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ctx_session ON context_entries(session_id, ts);

CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT,
    agent         TEXT,
    action        TEXT,
    decision      TEXT,
    reason        TEXT,
    payload_hash  TEXT,
    ts            REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id, ts);

CREATE TABLE IF NOT EXISTS artifacts (
    id          TEXT PRIMARY KEY,
    session_id  TEXT,
    filename    TEXT,
    mime        TEXT,
    path        TEXT,
    sha256      TEXT,
    prompt      TEXT,
    ts          REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_messages (
    id                TEXT PRIMARY KEY,
    direction         TEXT NOT NULL,
    peer              TEXT NOT NULL,
    body              TEXT NOT NULL,
    ts                REAL NOT NULL,
    status            TEXT DEFAULT 'delivered',
    pending_approval  INTEGER DEFAULT 0,
    -- "sms" | "call". Calls live in the same table because the thread a user
    -- reads is per-contact, not per-medium: "I texted them, then I rang them"
    -- is one conversation and belongs in one ordered list.
    kind              TEXT DEFAULT 'sms'
);
CREATE INDEX IF NOT EXISTS idx_sms_peer ON sms_messages(peer, ts);

CREATE TABLE IF NOT EXISTS diary_entries (
    id              TEXT PRIMARY KEY,
    day             TEXT NOT NULL,
    summary         TEXT NOT NULL,
    reflection      TEXT DEFAULT '',
    agent_assisted  INTEGER DEFAULT 0,
    ts              REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_day ON diary_entries(day);

CREATE TABLE IF NOT EXISTS calendar_events (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    start_ts     REAL NOT NULL,
    end_ts       REAL NOT NULL,
    description  TEXT DEFAULT '',
    kind         TEXT DEFAULT 'event',
    source       TEXT DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_cal_start ON calendar_events(start_ts);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id        TEXT PRIMARY KEY,
    cron      TEXT NOT NULL,
    prompt    TEXT NOT NULL,
    enabled   INTEGER DEFAULT 1,
    last_run  REAL
);

CREATE TABLE IF NOT EXISTS social_posts (
    id          TEXT PRIMARY KEY,
    platform    TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft',
    session_id  TEXT,
    external_id TEXT DEFAULT '',
    ts          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_ts ON social_posts(ts DESC);

-- Machine telemetry, one row per scheduler tick (~60s).
--
-- Stored rather than only read live because a single instantaneous reading says
-- nothing: "CPU 4%" is not information, "CPU 4% having been 90% for the last six
-- minutes" is. Sampling is done by the loop that already exists, so this table
-- costs no thread and no process.
--
-- `proc_*` is this Python process; `cpu_pct`/`mem_pct` are the whole machine.
-- Both are kept because the interesting failure is the machine being busy with
-- something that is *not* Concaretti.
CREATE TABLE IF NOT EXISTS system_samples (
    ts            REAL PRIMARY KEY,
    cpu_pct       REAL NOT NULL,
    mem_pct       REAL NOT NULL,
    proc_cpu_pct  REAL NOT NULL,
    proc_rss_mb   REAL NOT NULL,
    threads       INTEGER NOT NULL,
    load_state    TEXT NOT NULL DEFAULT 'idle'
);
CREATE INDEX IF NOT EXISTS idx_system_ts ON system_samples(ts DESC);

-- Shopping errands the agent is watching.
--
-- Exists so "forsee everything till delivery" survives a restart. A run that
-- ends at "order placed" has done half the job; the half that matters to the
-- person waiting is the week afterwards, and that cannot live in a session.
--
-- `status` moves cart → placed → confirmed → shipped → delivered, with
-- cancelled/failed as terminal exits. The scheduler re-reads anything not
-- terminal, which is why the index is on (status, last_checked) rather than ts.
--
-- `total` is stored in `currency` as charged, not normalised to one currency.
-- Converting on the way in would bake that day's FX rate into the record and
-- quietly disagree with the receipt.
CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    session_id    TEXT,
    merchant      TEXT NOT NULL,
    item          TEXT NOT NULL,
    url           TEXT DEFAULT '',
    total         REAL NOT NULL DEFAULT 0,
    currency      TEXT NOT NULL DEFAULT 'USD',
    status        TEXT NOT NULL DEFAULT 'cart',
    tracking_url  TEXT DEFAULT '',
    note          TEXT DEFAULT '',
    last_checked  REAL,
    created_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, last_checked);

-- Paper portfolio. No brokerage is wired and none is planned here.
--
-- Keyed on symbol alone, with no owner column, because this app has one user —
-- the same assumption `calendar_events` and `diary_entries` already make.
--
-- Positions are derived state: `fills` is the ledger and this is the running
-- total. Kept as a table rather than recomputed per request because the average
-- cost has to be updated inside the same write as the fill that changes it.
CREATE TABLE IF NOT EXISTS positions (
    symbol     TEXT PRIMARY KEY,
    qty        REAL NOT NULL,
    avg_cost   REAL NOT NULL,
    opened_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS fills (
    id          TEXT PRIMARY KEY,
    symbol      TEXT NOT NULL,
    side        TEXT NOT NULL,
    qty         REAL NOT NULL,
    price       REAL NOT NULL,
    realized    REAL NOT NULL DEFAULT 0,
    session_id  TEXT,
    note        TEXT DEFAULT '',
    ts          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_ts ON fills(ts DESC);
"""


class MemoryStore:
    """
    Single-writer SQLite store.

    `check_same_thread=False` plus a coarse lock is sufficient here: writes are
    short, traffic is one user, and it avoids threading a connection pool
    through the agent layer for no measurable gain.
    """

    def __init__(self, path: str | Path = DB_PATH) -> None:
        self.path = Path(path)
        self.vec_enabled = False
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._load_vec_extension()
        self._conn.executescript(SCHEMA)
        self._migrate()
        self._create_vec_table()
        self._conn.commit()

    # ── setup ────────────────────────────────────────────────────────────

    # Columns added to tables that shipped earlier. `CREATE TABLE IF NOT EXISTS`
    # is a no-op on an existing table, so a new column in SCHEMA would never
    # reach a database created before it — the app would start clean and then
    # fail on the first query. Listed as (table, column, DDL).
    _ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
        ("sms_messages", "kind", "TEXT DEFAULT 'sms'"),
    )

    def _migrate(self) -> None:
        """
        Bring an older database up to the current SCHEMA, idempotently.

        Deliberately additive only: no drops, no rewrites, no version counter to
        get out of step with the file. `PRAGMA table_info` is the source of
        truth, so running this against a fresh database — where SCHEMA already
        created every column — does nothing at all.
        """
        for table, column, ddl in self._ADDED_COLUMNS:
            cols = {
                r["name"]
                for r in self._conn.execute(f"PRAGMA table_info({table})").fetchall()
            }
            if not cols:
                continue  # table absent entirely; SCHEMA owns creating it
            if column not in cols:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
                print(f"[memory] migrated: added {table}.{column}")
        self._conn.commit()

    def _load_vec_extension(self) -> None:
        try:
            self._conn.enable_load_extension(True)
            sqlite_vec.load(self._conn)
            self._conn.enable_load_extension(False)
            self.vec_enabled = True
        except Exception as exc:  # pragma: no cover - platform dependent
            # Recall degrades to lexical LIKE search rather than 500ing.
            print(f"[memory] sqlite-vec unavailable ({exc}); recall will use LIKE")
            self.vec_enabled = False

    def _create_vec_table(self) -> None:
        if not self.vec_enabled:
            return
        self._conn.execute(
            f"""
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
                entry_id INTEGER PRIMARY KEY,
                embedding FLOAT[{EMBED_DIM}]
            )
            """
        )

    def close(self) -> None:
        self._conn.close()

    # ── sessions ─────────────────────────────────────────────────────────

    def create_session(
        self, role: str | None = None, prompt: str = "", title: str = ""
    ) -> str:
        """
        Open a session row.

        The prompt is screened here as well as in the orchestrator, and not
        because one of the two is redundant. This runs *first* — `_spawn_prompt`
        needs a session id before it can start a run — so an orchestrator-side
        refusal cannot unwrite a row this method has already committed. Screening
        only there would leave the text on disk and merely decline to act on it.
        """
        sid = uuid.uuid4().hex[:16]
        if contains_secret_material(prompt) or contains_secret_material(title):
            prompt = SECRET_PLACEHOLDER
            title = SECRET_PLACEHOLDER
        self._conn.execute(
            "INSERT INTO sessions (id, created_at, role, title, prompt) "
            "VALUES (?, ?, ?, ?, ?)",
            (sid, time.time(), role, title or prompt[:80], prompt),
        )
        self._conn.commit()
        return sid

    def list_sessions(self, limit: int = 40) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, created_at, role, title, summary FROM sessions "
            "ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def set_summary(self, session_id: str, summary: str) -> None:
        self._conn.execute(
            "UPDATE sessions SET summary = ? WHERE id = ?", (summary, session_id)
        )
        self._conn.commit()

    # ── context entries + Rule 0 ─────────────────────────────────────────

    def append_entry(
        self,
        session_id: str,
        role: str,
        content: str,
        agent: str | None = None,
        sensitive: bool | None = None,
    ) -> ContextEntry:
        """
        Record one turn.

        Sensitive content is written to the transcript but deliberately left
        un-embedded: no vector row means it cannot surface in recall for this
        session or any future one. The skip is audited so the boundary is
        demonstrable rather than merely asserted.

        `sensitive` lets a caller assert the exclusion for a turn whose *text* will
        never match a pattern family but whose *provenance* makes it private — a
        description of the operator's screen being the case this exists for. See
        `security.PROVENANCE_SENSITIVE`.

        It is OR-ed with the content check, never substituted for it, so the
        parameter can only ever add sensitivity. That asymmetry is the same one
        `requires_halo` holds for gates: passing `sensitive=False` over text that
        matches a family must not be a way to get it embedded, or the flag becomes
        a switch for turning Rule 0 off one call at a time.
        """
        matched = is_sensitive(content)
        sensitive = matched or bool(sensitive)
        ts = time.time()

        cur = self._conn.execute(
            "INSERT INTO context_entries "
            "(session_id, role, content, agent, ts, sensitive, embedded) "
            "VALUES (?, ?, ?, ?, ?, ?, 0)",
            (session_id, role, content, agent, ts, int(sensitive)),
        )
        entry_id = int(cur.lastrowid or 0)

        if sensitive:
            self.log_audit(
                session_id,
                agent or "memory",
                "rule0_exclusion",
                decision="excluded",
                reason=(
                    "Rule 0: matched sensitive pattern family "
                    f"{matched_rule0_families(content)}; no embedding created"
                    if matched
                    else f"Rule 0: excluded by provenance ({agent or 'caller'}); "
                    "no embedding created"
                ),
                payload=content,
            )
        else:
            self._embed_entry(entry_id, content)

        self._conn.commit()
        return ContextEntry(
            id=entry_id,
            session_id=session_id,
            role=role,
            content=content,
            agent=agent,
            ts=ts,
            sensitive=sensitive,
        )

    def _embed_entry(self, entry_id: int, content: str) -> None:
        if not self.vec_enabled or not content.strip():
            return
        vector, _source = embed(content)
        self._conn.execute(
            "INSERT INTO vec_entries (entry_id, embedding) VALUES (?, ?)",
            (entry_id, _serialize_f32(vector)),
        )
        self._conn.execute(
            "UPDATE context_entries SET embedded = 1 WHERE id = ?", (entry_id,)
        )

    def semantic_search(
        self, query: str, k: int = 3, exclude_session: str | None = None
    ) -> list[ContextEntry]:
        """
        Cross-session recall.

        Returns nothing for a sensitive query — asking about distress must not
        become a way to fish for previously excluded material. The
        `sensitive = 0` join condition is the second, redundant guard.
        """
        if not query.strip() or is_sensitive(query):
            return []

        if not self.vec_enabled:
            return self._lexical_search(query, k, exclude_session)

        vector, _ = embed(query)
        # Over-fetch, then filter: the vector table cannot express the
        # sensitivity join itself.
        rows = self._conn.execute(
            """
            SELECT c.id, c.session_id, c.role, c.content, c.agent, c.ts,
                   c.sensitive, v.distance
            FROM vec_entries v
            JOIN context_entries c ON c.id = v.entry_id
            WHERE v.embedding MATCH ? AND k = ?
              AND c.sensitive = 0
            ORDER BY v.distance
            """,
            (_serialize_f32(vector), max(k * 4, 12)),
        ).fetchall()

        out: list[ContextEntry] = []
        for r in rows:
            if exclude_session and r["session_id"] == exclude_session:
                continue
            out.append(
                ContextEntry(
                    id=r["id"],
                    session_id=r["session_id"],
                    role=r["role"],
                    content=r["content"],
                    agent=r["agent"],
                    ts=r["ts"],
                    sensitive=bool(r["sensitive"]),
                    distance=r["distance"],
                )
            )
            if len(out) >= k:
                break
        return out

    def _lexical_search(
        self, query: str, k: int, exclude_session: str | None
    ) -> list[ContextEntry]:
        terms = [t for t in _TOKEN_RE.findall(query.lower()) if len(t) > 3][:6]
        if not terms:
            return []
        where = " OR ".join("LOWER(content) LIKE ?" for _ in terms)
        params: list[Any] = [f"%{t}%" for t in terms]
        sql = (
            "SELECT id, session_id, role, content, agent, ts, sensitive "
            f"FROM context_entries WHERE sensitive = 0 AND ({where})"
        )
        if exclude_session:
            sql += " AND session_id != ?"
            params.append(exclude_session)
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(k)

        return [
            ContextEntry(
                id=r["id"],
                session_id=r["session_id"],
                role=r["role"],
                content=r["content"],
                agent=r["agent"],
                ts=r["ts"],
                sensitive=bool(r["sensitive"]),
            )
            for r in self._conn.execute(sql, params).fetchall()
        ]

    # ── sliding context window ───────────────────────────────────────────

    def get_window(
        self,
        session_id: str,
        summarizer: Callable[[str], str] | None = None,
    ) -> list[ContextEntry]:
        """
        The session transcript, compressed when it grows past the thresholds.

        Over `MAX_ENTRIES_KEPT` entries or `COMPRESS_TOKEN_THRESHOLD` estimated
        tokens, the oldest half is folded into a single summary entry. Without a
        summarizer the fold is still performed using a truncated concatenation,
        so context length stays bounded even with no model available.
        """
        rows = self._conn.execute(
            "SELECT id, session_id, role, content, agent, ts, sensitive "
            "FROM context_entries WHERE session_id = ? ORDER BY ts",
            (session_id,),
        ).fetchall()

        entries = [
            ContextEntry(
                id=r["id"],
                session_id=r["session_id"],
                role=r["role"],
                content=r["content"],
                agent=r["agent"],
                ts=r["ts"],
                sensitive=bool(r["sensitive"]),
            )
            for r in rows
        ]

        approx_tokens = sum(len(e.content) for e in entries) // 4
        if len(entries) <= MAX_ENTRIES_KEPT and approx_tokens <= COMPRESS_TOKEN_THRESHOLD:
            return entries

        split = len(entries) // 2
        older, newer = entries[:split], entries[split:]
        joined = "\n".join(f"[{e.role}] {e.content}" for e in older)

        if summarizer is not None:
            try:
                summary_text = summarizer(joined)
            except Exception:
                summary_text = joined[:1500]
        else:
            summary_text = joined[:1500]

        self.set_summary(session_id, summary_text)
        folded = ContextEntry(
            id=-1,
            session_id=session_id,
            role="summary",
            content=f"[EARLIER IN THIS SESSION]\n{summary_text}",
            agent=None,
            ts=older[0].ts if older else time.time(),
        )
        return [folded, *newer]

    def build_prompt_context(
        self, session_id: str, prompt: str, summarizer: Callable[[str], str] | None = None
    ) -> str:
        """
        Assemble the context block handed to the orchestrator.

        Recall is appended only for non-sensitive prompts, mirroring the write
        path so the two directions cannot disagree.
        """
        parts: list[str] = []
        window = self.get_window(session_id, summarizer)
        if window:
            parts.append(
                "\n".join(f"[{e.role}] {e.content[:600]}" for e in window[-12:])
            )

        if not is_sensitive(prompt):
            hits = self.semantic_search(prompt, k=3, exclude_session=session_id)
            if hits:
                recall = "\n".join(
                    f"• [{h.agent or h.role}] {h.content[:300]}" for h in hits
                )
                parts.append(f"[SEMANTIC RECALL — related past work]\n{recall}")

        return "\n\n".join(parts)

    # ── audit ────────────────────────────────────────────────────────────

    def log_audit(
        self,
        session_id: str | None,
        agent: str,
        action: str,
        decision: str,
        reason: str = "",
        payload: Any = None,
    ) -> None:
        """
        Append to the tamper-evident action record.

        Only a hash of the payload is stored: enough to prove which bytes an
        action carried, without copying the bytes themselves into a second
        place. This is what makes an excluded therapy prompt auditable without
        being retrievable.
        """
        payload_hash = ""
        if payload is not None:
            blob = payload if isinstance(payload, str) else json.dumps(payload, default=str)
            payload_hash = hashlib.sha256(blob.encode("utf-8")).hexdigest()

        self._conn.execute(
            "INSERT INTO audit_log "
            "(session_id, agent, action, decision, reason, payload_hash, ts) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (session_id, agent, action, decision, reason, payload_hash, time.time()),
        )
        self._conn.commit()

    def list_audit(self, session_id: str | None = None, limit: int = 100) -> list[dict]:
        if session_id:
            rows = self._conn.execute(
                "SELECT * FROM audit_log WHERE session_id = ? ORDER BY ts DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    # ── artifacts (lineage) ──────────────────────────────────────────────

    def record_artifact(
        self,
        session_id: str,
        filename: str,
        mime: str,
        path: str,
        content: bytes,
        prompt: str,
    ) -> Artifact:
        """Hash the bytes and link them to the originating prompt."""
        art = Artifact(
            id=uuid.uuid4().hex[:16],
            session_id=session_id,
            filename=filename,
            mime=mime,
            path=path,
            sha256=hashlib.sha256(content).hexdigest(),
            prompt=prompt,
            ts=time.time(),
        )
        self._conn.execute(
            "INSERT INTO artifacts "
            "(id, session_id, filename, mime, path, sha256, prompt, ts) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                art.id,
                art.session_id,
                art.filename,
                art.mime,
                art.path,
                art.sha256,
                art.prompt,
                art.ts,
            ),
        )
        self._conn.commit()
        return art

    def list_artifacts(self, session_id: str | None = None) -> list[dict]:
        if session_id:
            rows = self._conn.execute(
                "SELECT * FROM artifacts WHERE session_id = ? ORDER BY ts DESC",
                (session_id,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM artifacts ORDER BY ts DESC LIMIT 100"
            ).fetchall()
        return [dict(r) for r in rows]

    # ── SMS ──────────────────────────────────────────────────────────────

    def add_sms(
        self,
        direction: str,
        peer: str,
        body: str,
        status: str = "delivered",
        pending_approval: bool = False,
        kind: str = "sms",
    ) -> SmsMessage:
        msg = SmsMessage(
            id=uuid.uuid4().hex[:16],
            direction=direction,
            peer=peer,
            body=body,
            ts=time.time(),
            status=status,
            pending_approval=pending_approval,
            kind=kind,
        )
        self._conn.execute(
            "INSERT INTO sms_messages "
            "(id, direction, peer, body, ts, status, pending_approval, kind) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                msg.id,
                msg.direction,
                msg.peer,
                msg.body,
                msg.ts,
                msg.status,
                int(msg.pending_approval),
                msg.kind,
            ),
        )
        self._conn.commit()
        return msg

    def list_sms_threads(self) -> list[dict]:
        """Group messages by peer, newest thread first."""
        rows = self._conn.execute(
            "SELECT * FROM sms_messages ORDER BY ts ASC"
        ).fetchall()
        threads: dict[str, dict[str, Any]] = {}
        for r in rows:
            t = threads.setdefault(
                r["peer"], {"peer": r["peer"], "messages": [], "last_ts": 0.0}
            )
            t["messages"].append(dict(r))
            t["last_ts"] = max(t["last_ts"], r["ts"])
        return sorted(threads.values(), key=lambda t: t["last_ts"], reverse=True)

    def update_sms_status(self, msg_id: str, status: str) -> None:
        self._conn.execute(
            "UPDATE sms_messages SET status = ?, pending_approval = 0 WHERE id = ?",
            (status, msg_id),
        )
        self._conn.commit()

    # ── diary ────────────────────────────────────────────────────────────

    def add_diary_entry(
        self, day: str, summary: str, reflection: str = "", agent_assisted: bool = False
    ) -> DiaryEntry:
        entry = DiaryEntry(
            id=uuid.uuid4().hex[:16],
            day=day,
            summary=summary,
            reflection=reflection,
            agent_assisted=agent_assisted,
            ts=time.time(),
        )
        self._conn.execute(
            "INSERT INTO diary_entries "
            "(id, day, summary, reflection, agent_assisted, ts) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                entry.id,
                entry.day,
                entry.summary,
                entry.reflection,
                int(entry.agent_assisted),
                entry.ts,
            ),
        )
        self._conn.commit()
        return entry

    def list_diary(self, limit: int = 60) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM diary_entries ORDER BY day DESC, ts DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    # ── calendar ─────────────────────────────────────────────────────────

    def add_event(
        self,
        title: str,
        start_ts: float,
        end_ts: float,
        description: str = "",
        kind: str = "event",
        source: str = "local",
        event_id: str | None = None,
    ) -> dict:
        eid = event_id or uuid.uuid4().hex[:16]
        self._conn.execute(
            "INSERT OR REPLACE INTO calendar_events "
            "(id, title, start_ts, end_ts, description, kind, source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (eid, title, start_ts, end_ts, description, kind, source),
        )
        self._conn.commit()
        return {
            "id": eid,
            "title": title,
            "start_ts": start_ts,
            "end_ts": end_ts,
            "description": description,
            "kind": kind,
            "source": source,
        }

    def list_events(
        self,
        start_ts: float | None = None,
        end_ts: float | None = None,
        kinds: list[str] | None = None,
    ) -> list[dict]:
        sql = "SELECT * FROM calendar_events WHERE 1=1"
        params: list[Any] = []
        if start_ts is not None:
            sql += " AND end_ts >= ?"
            params.append(start_ts)
        if end_ts is not None:
            sql += " AND start_ts <= ?"
            params.append(end_ts)
        if kinds:
            sql += f" AND kind IN ({','.join('?' * len(kinds))})"
            params.extend(kinds)
        sql += " ORDER BY start_ts"
        return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def delete_event(self, event_id: str) -> bool:
        cur = self._conn.execute(
            "DELETE FROM calendar_events WHERE id = ?", (event_id,)
        )
        self._conn.commit()
        return cur.rowcount > 0

    # ── schedules ────────────────────────────────────────────────────────

    def upsert_job(self, cron: str, prompt: str, job_id: str | None = None) -> dict:
        jid = job_id or uuid.uuid4().hex[:12]
        self._conn.execute(
            "INSERT OR REPLACE INTO scheduled_jobs (id, cron, prompt, enabled) "
            "VALUES (?, ?, ?, 1)",
            (jid, cron, prompt),
        )
        self._conn.commit()
        return {"id": jid, "cron": cron, "prompt": prompt, "enabled": True}

    def list_jobs(self) -> list[dict]:
        return [
            dict(r)
            for r in self._conn.execute("SELECT * FROM scheduled_jobs").fetchall()
        ]

    # ── social ───────────────────────────────────────────────────────────

    def add_social_post(
        self,
        platform: str,
        body: str,
        status: str = "draft",
        session_id: str | None = None,
        external_id: str = "",
    ) -> dict:
        """
        Record a social post. `status` is 'draft' | 'published' | 'failed'.

        Drafts are stored too, deliberately: a post that HALO refused should stay
        visible with its refusal rather than vanishing, or the manager screen would
        quietly imply nothing was ever attempted.
        """
        pid = uuid.uuid4().hex[:12]
        row = {
            "id": pid,
            "platform": platform,
            "body": body,
            "status": status,
            "session_id": session_id,
            "external_id": external_id,
            "ts": time.time(),
        }
        self._conn.execute(
            "INSERT INTO social_posts "
            "(id, platform, body, status, session_id, external_id, ts) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            tuple(row.values()),
        )
        self._conn.commit()
        return row

    def list_social_posts(self, limit: int = 50) -> list[dict]:
        return [
            dict(r)
            for r in self._conn.execute(
                "SELECT * FROM social_posts ORDER BY ts DESC LIMIT ?", (limit,)
            ).fetchall()
        ]

    # ── metrics ──────────────────────────────────────────────────────────

    def metrics(self, window_hours: float = 24.0) -> dict:
        """
        Counts for the telemetry panel, computed on read.

        No metrics tables and no counters: everything here is derived from the
        audit log and the session rows that already exist. A separate metrics
        store would be a second source of truth about what the policy did, and
        the audit log is the one that has to be authoritative.
        """
        since = time.time() - window_hours * 3600
        q = self._conn.execute

        decisions = {
            r["decision"]: r["n"]
            for r in q(
                "SELECT decision, COUNT(*) AS n FROM audit_log "
                "WHERE ts >= ? GROUP BY decision",
                (since,),
            ).fetchall()
        }
        by_agent = [
            dict(r)
            for r in q(
                "SELECT agent, COUNT(*) AS calls, "
                "SUM(CASE WHEN decision IN ('blocked','refused') THEN 1 ELSE 0 END) "
                "AS refusals FROM audit_log WHERE ts >= ? "
                "GROUP BY agent ORDER BY calls DESC",
                (since,),
            ).fetchall()
        ]
        scalar = lambda sql, params=(): q(sql, params).fetchone()[0]  # noqa: E731

        total = sum(decisions.values())
        blocked = decisions.get("blocked", 0) + decisions.get("refused", 0)
        return {
            "window_hours": window_hours,
            "sessions_total": scalar("SELECT COUNT(*) FROM sessions"),
            "sessions_window": scalar(
                "SELECT COUNT(*) FROM sessions WHERE created_at >= ?", (since,)
            ),
            "actions_window": total,
            "decisions": decisions,
            "refusal_rate": round(blocked / total, 3) if total else 0.0,
            "by_agent": by_agent,
            "artifacts_total": scalar("SELECT COUNT(*) FROM artifacts"),
            "entries_total": scalar("SELECT COUNT(*) FROM context_entries"),
            "rule0_excluded": scalar(
                "SELECT COUNT(*) FROM context_entries WHERE sensitive = 1"
            ),
            "vectorised": scalar(
                "SELECT COUNT(*) FROM context_entries WHERE embedded = 1"
            ),
            "sms_total": scalar("SELECT COUNT(*) FROM sms_messages"),
            "events_total": scalar("SELECT COUNT(*) FROM calendar_events"),
            "social_total": scalar("SELECT COUNT(*) FROM social_posts"),
            **self._attention_hours(since),
        }

    def _attention_hours(self, since: float) -> dict:
        """
        Human hours versus swarm hours, over the same window.

        Both are counted the way `/api/workflows/detected` already counts
        repetition — by bucketing existing rows into clock hours — rather than by
        timing anything. A *distinct hour in which the human typed* is one human
        hour; a distinct hour in which an agent acted is one swarm hour. That is
        an honest reading of "hours spent", and it is the only one available
        without a wall-clock collector following the user around.

        The two overlap freely: an hour where you typed and the council then
        worked counts once on each side. The interesting number is the ratio, and
        double-counting shared hours understates rather than flatters it.
        """
        q = self._conn.execute
        human = {
            r["h"]
            for r in q(
                "SELECT strftime('%Y-%m-%dT%H', ts, 'unixepoch') AS h "
                "FROM context_entries WHERE role = 'user' AND ts >= ?",
                (since,),
            ).fetchall()
        }
        swarm = {
            r["h"]
            for r in q(
                "SELECT strftime('%Y-%m-%dT%H', ts, 'unixepoch') AS h "
                "FROM audit_log WHERE agent != 'user' AND ts >= ?",
                (since,),
            ).fetchall()
        }
        return {
            "human_hours": len(human),
            "swarm_hours": len(swarm),
            "delegated_hours": len(swarm - human),
        }

    # ── shopping errands ─────────────────────────────────────────────────

    # Terminal states. Anything not in here is still worth re-reading, which is
    # the whole basis of the scheduler's polling query.
    ORDER_TERMINAL: tuple[str, ...] = ("delivered", "cancelled", "failed")

    def add_order(
        self,
        *,
        session_id: str | None,
        merchant: str,
        item: str,
        url: str = "",
        total: float = 0.0,
        currency: str = "USD",
        status: str = "cart",
        note: str = "",
    ) -> dict[str, Any]:
        oid = uuid.uuid4().hex[:12]
        now = time.time()
        self._conn.execute(
            "INSERT INTO orders (id, session_id, merchant, item, url, total, "
            "currency, status, tracking_url, note, last_checked, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, NULL, ?)",
            (oid, session_id, merchant, item, url, float(total), currency, status, note, now),
        )
        self._conn.commit()
        return self.get_order(oid) or {}

    def get_order(self, order_id: str) -> dict[str, Any] | None:
        row = self._conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        return dict(row) if row else None

    def list_orders(self, limit: int = 50) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self._conn.execute(
                "SELECT * FROM orders ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        ]

    def open_orders(self, *, stale_before: float | None = None) -> list[dict[str, Any]]:
        """
        Orders still worth checking, oldest-checked first.

        `stale_before` is the throttle: pass `time.time() - 1800` and an order
        already read in the last half hour is skipped. Without it the scheduler
        would re-read every open order every minute, which is a lot of traffic at
        a merchant for information that changes daily.

        `last_checked IS NULL` sorts first under SQLite's NULL ordering, so a
        brand-new order is looked at on the next tick rather than last.
        """
        marks = ", ".join("?" * len(self.ORDER_TERMINAL))
        sql = f"SELECT * FROM orders WHERE status NOT IN ({marks})"
        args: list[Any] = list(self.ORDER_TERMINAL)
        if stale_before is not None:
            sql += " AND (last_checked IS NULL OR last_checked < ?)"
            args.append(stale_before)
        sql += " ORDER BY last_checked ASC"
        return [dict(r) for r in self._conn.execute(sql, tuple(args)).fetchall()]

    # Column names accepted by `update_order`. A whitelist rather than trust,
    # because the column name goes into the SQL text where a placeholder cannot.
    _ORDER_MUTABLE: frozenset[str] = frozenset(
        {"status", "tracking_url", "note", "total", "currency", "url", "last_checked"}
    )

    def update_order(self, order_id: str, **fields: Any) -> dict[str, Any] | None:
        bad = set(fields) - self._ORDER_MUTABLE
        if bad:
            raise ValueError(f"not updatable: {', '.join(sorted(bad))}")
        if not fields:
            return self.get_order(order_id)

        sets = ", ".join(f"{col} = ?" for col in fields)
        self._conn.execute(
            f"UPDATE orders SET {sets} WHERE id = ?",
            (*fields.values(), order_id),
        )
        self._conn.commit()
        return self.get_order(order_id)

    # ── paper portfolio ──────────────────────────────────────────────────

    def record_fill(
        self,
        *,
        symbol: str,
        side: str,
        qty: float,
        price: float,
        session_id: str | None = None,
        note: str = "",
    ) -> dict[str, Any]:
        """
        Append a simulated fill and move the position it belongs to.

        Both writes happen here rather than in the tool because an average cost
        that disagrees with the ledger is unfixable after the fact — there is no
        second source to reconcile against. `fills` is the truth; `positions` is
        a cache of it that must never be updated separately.

        Selling more than is held raises rather than clamping. A short position is
        a different instrument with different risk, and silently opening one
        because the arithmetic allowed it would misreport what the user asked for.
        """
        symbol = symbol.upper().strip()
        side = side.lower().strip()
        if side not in ("buy", "sell"):
            raise ValueError(f'side must be "buy" or "sell", got "{side}"')
        if qty <= 0 or price <= 0:
            raise ValueError("qty and price must both be positive")

        row = self._conn.execute(
            "SELECT qty, avg_cost, opened_at FROM positions WHERE symbol = ?", (symbol,)
        ).fetchone()
        held = float(row["qty"]) if row else 0.0
        avg = float(row["avg_cost"]) if row else 0.0
        realized = 0.0
        now = time.time()

        if side == "buy":
            new_qty = held + qty
            new_avg = ((held * avg) + (qty * price)) / new_qty
            self._conn.execute(
                "INSERT INTO positions (symbol, qty, avg_cost, opened_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(symbol) DO UPDATE SET qty = ?, avg_cost = ?",
                (symbol, new_qty, new_avg, now, new_qty, new_avg),
            )
        else:
            if qty > held + 1e-9:
                raise ValueError(
                    f"cannot sell {qty:g} {symbol} — the paper portfolio holds {held:g}"
                )
            realized = (price - avg) * qty
            new_qty = held - qty
            if new_qty <= 1e-9:
                self._conn.execute("DELETE FROM positions WHERE symbol = ?", (symbol,))
            else:
                self._conn.execute(
                    "UPDATE positions SET qty = ? WHERE symbol = ?", (new_qty, symbol)
                )

        fid = uuid.uuid4().hex[:12]
        self._conn.execute(
            "INSERT INTO fills (id, symbol, side, qty, price, realized, session_id, note, ts) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (fid, symbol, side, qty, price, realized, session_id, note, now),
        )
        self._conn.commit()
        return {
            "id": fid,
            "symbol": symbol,
            "side": side,
            "qty": qty,
            "price": price,
            "realized": realized,
            "note": note,
            "ts": now,
        }

    def list_positions(self) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self._conn.execute(
                "SELECT * FROM positions ORDER BY symbol ASC"
            ).fetchall()
        ]

    def list_fills(self, limit: int = 60) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self._conn.execute(
                "SELECT * FROM fills ORDER BY ts DESC LIMIT ?", (limit,)
            ).fetchall()
        ]

    def realized_total(self) -> float:
        row = self._conn.execute("SELECT COALESCE(SUM(realized), 0) AS t FROM fills").fetchone()
        return float(row["t"] or 0.0)

    # ── system telemetry ─────────────────────────────────────────────────

    def record_system_sample(
        self,
        *,
        cpu_pct: float,
        mem_pct: float,
        proc_cpu_pct: float,
        proc_rss_mb: float,
        threads: int,
        load_state: str = "idle",
    ) -> None:
        """
        Store one reading. `INSERT OR REPLACE` because `ts` is the key and two
        ticks inside the same float second would otherwise raise.
        """
        self._conn.execute(
            "INSERT OR REPLACE INTO system_samples "
            "(ts, cpu_pct, mem_pct, proc_cpu_pct, proc_rss_mb, threads, load_state) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                time.time(),
                round(cpu_pct, 1),
                round(mem_pct, 1),
                round(proc_cpu_pct, 1),
                round(proc_rss_mb, 1),
                threads,
                load_state,
            ),
        )
        self._conn.commit()

    def list_system_samples(self, window_hours: float = 6.0, limit: int = 360) -> list[dict]:
        """
        Oldest-first inside the window, so the caller can plot it directly.

        `ORDER BY ts DESC LIMIT ?` then reverse, rather than `ASC LIMIT`: a long
        uptime means the window holds more rows than the cap, and the newest are
        the ones worth keeping.
        """
        since = time.time() - window_hours * 3600
        rows = self._conn.execute(
            "SELECT * FROM system_samples WHERE ts >= ? ORDER BY ts DESC LIMIT ?",
            (since, limit),
        ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def prune_system_samples(self, keep_hours: float = 72.0) -> int:
        """
        Drop readings past the retention window.

        Unbounded, a minute-resolution sampler writes ~525k rows a year for data
        nobody will read. Called from the same tick that writes, so retention
        needs no separate job.
        """
        cur = self._conn.execute(
            "DELETE FROM system_samples WHERE ts < ?",
            (time.time() - keep_hours * 3600,),
        )
        self._conn.commit()
        return cur.rowcount or 0

    # ── demo seeding ─────────────────────────────────────────────────────

    def seed_demo_data(self) -> None:
        """
        Populate empty tables with sample rows. **Off unless asked for.**

        Gated on `CONCA_SEED_DEMO` and default off, because seeded rows are
        indistinguishable from real ones once they are in the table — a first run
        would silently present three invented text messages as the user's inbox,
        and there is no way to tell afterwards which of them were fabricated.
        The panels handle emptiness properly on their own (`Empty` in `ui.tsx`),
        so nothing is broken by an empty database; it is simply new.

        Set `CONCA_SEED_DEMO=1` when a screenshot or an offline walkthrough needs
        content. Still guarded per-table, so it never overwrites real data and
        re-running it is a no-op.
        """
        if os.getenv("CONCA_SEED_DEMO", "").lower() not in ("1", "true", "yes"):
            return

        now = time.time()
        day = 86_400

        if not self._conn.execute("SELECT 1 FROM sms_messages LIMIT 1").fetchone():
            self.add_sms("inbound", "+441632960011", "Is the Friday demo still on?")
            self.add_sms(
                "outbound",
                "+441632960011",
                "Yes — 3pm, room B14. I'll bring the slides.",
            )
            self.add_sms(
                "inbound", "+441632960042", "Can you send the reading list?"
            )

        if not self._conn.execute("SELECT 1 FROM diary_entries LIMIT 1").fetchone():
            self.add_diary_entry(
                time.strftime("%Y-%m-%d", time.localtime(now - day)),
                "Ported the .conca policy engine and shell normalizer.",
                "The nine-strategy normalizer is the part worth defending — "
                "obfuscation is the whole attack surface.",
            )
            self.add_diary_entry(
                time.strftime("%Y-%m-%d", time.localtime(now)),
                "Wired the HALO gate to the SSE stream.",
                "",
            )

        if not self._conn.execute("SELECT 1 FROM calendar_events LIMIT 1").fetchone():
            self.add_event(
                "Concaretti demo — dry run", now + 2 * day, now + 2 * day + 3600
            )
            self.add_event(
                "Distributed Systems exam",
                now + 6 * day,
                now + 6 * day + 7200,
                kind="exam",
            )
            self.add_event(
                "Thesis chapter 4 deadline",
                now + 9 * day,
                now + 9 * day + 1800,
                kind="deadline",
            )
            self.add_event(
                "Revision block — security models",
                now + day,
                now + day + 5400,
                kind="revision",
            )


_store: MemoryStore | None = None


def get_store() -> MemoryStore:
    """Process-wide store handle, created on first use."""
    global _store
    if _store is None:
        _store = MemoryStore()
    return _store
