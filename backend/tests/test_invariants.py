"""
The security invariants, as executable claims.

`test_security.py` tests the policy engine — can it parse a `.conca`, can it see
through nine layers of shell obfuscation, does a deny-list beat an allow-list.
This file tests the properties that span *modules*: a card that must not reach a
disk, a private key that must not reach a log, a gate that must fail closed, a
screenshot that must not become an embedding.

Each test corresponds to a numbered invariant in the design notes, and each one
was written to be capable of failing. Two of them have already caught something:
the HALO trigger set naming `file_write` when the tool was `write_file`, and
`screen_capture` sitting in that set for a tool that did not exist yet. Both read
as gates and gated nothing.

    uv run pytest -v
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import sqlite3
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import tools  # noqa: E402
from memory import MemoryStore, contains_secret_material  # noqa: E402
from security import (  # noqa: E402
    HALO_TRIGGERS,
    PROVENANCE_SENSITIVE,
    ConcaPolicy,
    check_url,
    load_policy,
    requires_halo,
)
from sse import SseBroker  # noqa: E402
from tools import TOOL_REGISTRY, ExecContext  # noqa: E402

POLICY_PATH = Path(__file__).parent.parent / ".conca"

# A real 1×1 PNG. Small enough to inline, valid enough that `base64.b64decode`
# with `validate=True` accepts it — which is the thing `stash_screen` checks.
PNG_1PX = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/"
    "q842iQAAAABJRU5ErkJggg=="
)


@pytest.fixture(scope="module")
def policy() -> ConcaPolicy:
    return load_policy(POLICY_PATH)


@pytest.fixture
def store(tmp_path: Path) -> MemoryStore:
    """A real SQLite file, not a mock. The invariant is about what lands on disk."""
    return MemoryStore(tmp_path / "invariants.db")


@pytest.fixture
def ctx(policy: ConcaPolicy, store: MemoryStore) -> ExecContext:
    return ExecContext(
        session_id="inv",
        role="staff",
        policy=policy,
        store=store,
        broker=SseBroker(),
    )


def _all_bytes(store: MemoryStore) -> bytes:
    """
    Every byte SQLite has written for this store, including the write-ahead log.

    Reading only the `.db` file misses rows that are committed but not yet
    checkpointed — which would make a leak test pass for the wrong reason.
    """
    base = Path(store.path)
    out = b""
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(base) + suffix)
        if p.exists():
            out += p.read_bytes()
    return out


def _mode(policy: ConcaPolicy, value: str) -> ConcaPolicy:
    """A copy of the policy with one rule changed, so tests cannot leak into each other."""
    clone = policy.model_copy(deep=True)
    clone.rules.screen_capture = value
    return clone


# ═══════════════════════════════════════════════════════════════════════════
# Registry drift — the class of bug that hid two real holes
# ═══════════════════════════════════════════════════════════════════════════


def test_halo_triggers_are_registered() -> None:
    """
    Every gated name is a task type some tool answers to.

    `requires_halo` is exact membership. A name in the trigger set that no tool
    emits is not a stricter gate, it is no gate at all — and it is worse than
    nothing because the list reads as though the action is covered.
    """
    registered = {task for _agent, task in TOOL_REGISTRY}
    orphaned = HALO_TRIGGERS - registered
    assert not orphaned, f"gates nothing: {sorted(orphaned)}"


def test_provenance_sensitive_are_registered() -> None:
    """The same drift check for the other declarative set, for the same reason."""
    registered = {task for _agent, task in TOOL_REGISTRY}
    orphaned = PROVENANCE_SENSITIVE - registered
    assert not orphaned, f"excludes nothing: {sorted(orphaned)}"


def test_every_registered_agent_is_named_in_the_policy(policy: ConcaPolicy) -> None:
    """
    A tool whose agent the policy has never heard of cannot be switched off.

    `check_agent_permission` refuses an unknown agent, so this is not a hole
    today — but it means the kill switch for that capability does not exist as a
    line anyone can find, and the whole claim is that capability is granted by a
    file a human can read.
    """
    unknown = {agent for agent, _task in TOOL_REGISTRY} - set(policy.agent_permissions)
    assert not unknown, f"agents with tools but no .conca switch: {sorted(unknown)}"


# ═══════════════════════════════════════════════════════════════════════════
# Invariant 2 — the agent cannot spend money unless the policy says so
# ═══════════════════════════════════════════════════════════════════════════


def test_financial_transactions_is_off_in_the_shipped_policy(policy: ConcaPolicy) -> None:
    """The default must be the safe one, or the other tests are testing a fork."""
    assert policy.security_overrides.financial_transactions is False
    assert policy.rules.checkout_mode == "handoff"


def test_spending_modes_refuse_while_the_flag_is_false(
    policy: ConcaPolicy, store: MemoryStore
) -> None:
    """
    `autonomous` and `wallet` refuse under `financial_transactions: false`, and the
    refusal names the key — a refusal that does not say what to change is a bug
    report addressed to nobody.
    """
    for mode in ("autonomous", "wallet"):
        clone = policy.model_copy(deep=True)
        clone.rules.checkout_mode = mode
        local = ExecContext(
            session_id="inv", role="staff", policy=clone, store=store, broker=SseBroker()
        )
        got = asyncio.run(
            tools.shop_checkout({"url": "https://example.com/cart", "total": 10.0}, local)
        )
        assert not got["ok"], f"{mode} must refuse while spending is disabled"
        assert "financial_transactions" in got["summary"], (
            f"{mode} refused without naming the key to change: {got['summary']}"
        )


# ═══════════════════════════════════════════════════════════════════════════
# Invariant 1 — a card never reaches a model, a log, a database or a disk
# ═══════════════════════════════════════════════════════════════════════════

PAN = "4242424242424242"


def test_card_jar_is_single_use() -> None:
    """Popped on first read, so a replayed reference buys nothing."""
    tools.stash_card("ref-single", {"pan": PAN, "exp": "12/30", "cvc": "123"})
    assert tools._take_card("ref-single") is not None
    assert tools._take_card("ref-single") is None


def test_card_jar_expires() -> None:
    """The TTL is enforced by the sweep, not by a promise in a docstring."""
    tools.stash_card("ref-ttl", {"pan": PAN, "exp": "12/30", "cvc": "123"})
    tools._sweep_jar(now=time.time() + tools._CARD_TTL + 1)
    assert tools._take_card("ref-ttl") is None


def test_stash_card_returns_no_pan() -> None:
    """
    What the rest of the system learns about a card is brand and last four.

    This is the boundary the HALO details string, the audit payload, the SSE feed
    and the order row all sit behind, so it is the one place to assert it.
    """
    receipt = tools.stash_card("ref-safe", {"pan": PAN, "exp": "12/30", "cvc": "123"})
    tools._take_card("ref-safe")
    flat = str(receipt)
    assert PAN not in flat
    assert "123" not in flat, "the CVC must not travel either"
    assert receipt["last4"] == "4242"


def test_card_number_fails_its_check_digit(store: MemoryStore) -> None:
    """A mistyped PAN is caught before it is stored, not after it is submitted."""
    with pytest.raises(ValueError):
        tools.stash_card("ref-bad", {"pan": "4242424242424243", "exp": "12/30", "cvc": "1"})


def test_pan_never_reaches_the_database(ctx: ExecContext) -> None:
    """
    Run a checkout the policy will refuse, then read every byte of the SQLite file.

    The refusal is the point rather than a limitation: `handoff` is the shipped
    mode, so this is the path the system actually takes, and a card that is never
    accepted cannot be leaked by the code that would have used it. The scan covers
    the whole file — tables, indexes, freelist pages — because a `SELECT` only
    finds the rows someone thought to look at.
    """
    tools.stash_card("ref-db", {"pan": PAN, "exp": "12/30", "cvc": "123"})
    asyncio.run(
        tools.shop_checkout(
            {"url": "https://example.com/cart", "total": 10.0, "card_ref": "ref-db"}, ctx
        )
    )
    ctx.store.append_entry("inv", "user", "buy it with the card ending 4242")

    blob = _all_bytes(ctx.store)
    assert PAN.encode() not in blob, "a PAN reached the database file"


def test_luhn_rejects_a_random_digit_run() -> None:
    """The validator is real arithmetic, not a length check."""
    assert tools._luhn_ok(PAN)
    assert not tools._luhn_ok("1234567812345678")


# ═══════════════════════════════════════════════════════════════════════════
# Invariant 3 — the agent never holds a private key or seed phrase
# ═══════════════════════════════════════════════════════════════════════════

SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
HEX64 = "a" * 64


@pytest.mark.parametrize("secret", [SEED, HEX64])
def test_key_shaped_input_refuses(ctx: ExecContext, secret: str) -> None:
    """A seed phrase or a 64-hex run is refused before anything else happens."""
    got = asyncio.run(
        tools.chain_prepare_tx({"to": "11111111111111111111111111111111", "memo": secret}, ctx)
    )
    assert not got["ok"], "key-shaped input must refuse"


@pytest.mark.parametrize("secret", [SEED, HEX64])
def test_refused_key_is_not_logged(ctx: ExecContext, secret: str) -> None:
    """
    The refusal must not write the thing it refused.

    This is the one failure mode with no recovery: a leaked key cannot be rotated
    back out of a log file someone already copied. So the rule is refuse *and
    forget*, and "forget" has to be checked at the file, because a hash of a seed
    phrase is a hash of a 2048-word dictionary lookup and is not protection.
    """
    asyncio.run(
        tools.chain_prepare_tx({"to": "11111111111111111111111111111111", "memo": secret}, ctx)
    )
    blob = _all_bytes(ctx.store)
    assert secret.encode() not in blob
    assert SEED.split()[0].encode() * 3 not in blob


def test_prepare_tx_carries_no_signature_field(ctx: ExecContext) -> None:
    """
    What comes back is unsigned, and says so.

    There is no signing path in this codebase to disable — the assertion is that
    the result never claims otherwise, because a payload with a `signature` key is
    an invitation for a caller to assume one was produced here.
    """
    got = asyncio.run(
        tools.chain_prepare_tx(
            {"to": "11111111111111111111111111111111", "amount": 0.01}, ctx
        )
    )
    flat = str(got).lower()
    for word in ("private_key", "secret_key", "seed", "mnemonic", "signature"):
        assert word not in flat, f"prepare_tx mentioned {word}"


# The four tests below exist because the two above passed while the invariant was
# broken. Both call a chain tool directly, so they proved the tool screen worked
# and said nothing about the layers above it. End-to-end verification then found a
# real seed phrase sitting in `concaretti.db-wal` in plaintext: the prompt is
# persisted by `create_session` and `append_entry` before a tool is ever selected,
# and the screen ran after both.
#
# So these enter through the front door instead — the session row and the
# orchestrator — and assert on the bytes on disk rather than on a return value.


def test_a_seed_phrase_embedded_in_a_sentence_is_caught() -> None:
    """
    The shape that actually got through.

    The old tool-layer pattern was anchored (`^…$`) on the argument that a chain
    argument is only ever an address or an amount. The phrase that leaked arrived
    inside a `memo`, wrapped in prose and quotes, where an anchored pattern cannot
    match. Windowed matching is the fix and this is its regression test.
    """
    buried = (
        'send 0.1 SOL to So11111111111111111111111111111111111111112 '
        f'with memo "{SEED}" please'
    )
    assert contains_secret_material(buried) == "a recovery phrase"


def test_the_session_row_never_holds_the_phrase(tmp_path: Path) -> None:
    """
    `create_session` writes the prompt twice — into `prompt` and into `title` —
    before any orchestrator or tool code runs, so it has to screen for itself. A
    refusal one layer up cannot unwrite a row that is already committed.
    """
    store = MemoryStore(tmp_path / "session.db")
    sid = store.create_session(role="staff", prompt=f"my recovery phrase is {SEED}")
    row = next(s for s in store.list_sessions() if s["id"] == sid)
    assert SEED.split()[0] not in (row["title"] or "")
    assert "refused" in (row["title"] or "").lower()
    assert SEED.encode() not in _all_bytes(store)


def test_the_orchestrator_refuses_before_it_writes_anything(
    policy: ConcaPolicy, tmp_path: Path
) -> None:
    """
    The end-to-end version, and the one that would have caught the leak.

    Enters through `Orchestrator.run` exactly as an HTTP prompt does, then reads
    the database file plus its write-ahead log. Asserting on bytes rather than on
    the returned dict is deliberate: the run *did* return a refusal when the leak
    was found, and the phrase was on disk anyway.
    """
    from agents import Orchestrator
    from halo import HaloGate
    from rotator import ModelRotator

    store = MemoryStore(tmp_path / "orch.db")
    broker = SseBroker()
    rotator = ModelRotator()
    orch = Orchestrator(
        policy=policy,
        store=store,
        broker=broker,
        rotator=rotator,
        gate=HaloGate(broker=broker, rotator=rotator),
    )
    sid = store.create_session(role="staff", prompt="placeholder")
    got = asyncio.run(orch.run(sid, f'transfer 0.1 SOL with memo "{SEED}"', "staff"))

    assert not got["ok"]
    assert got["refused"] == "secret_material"

    blob = _all_bytes(store)
    assert SEED.encode() not in blob, "the phrase reached the database"
    assert b"abandon abandon" not in blob, "a fragment of the phrase reached the database"
    # Not even a hash: `log_audit` stores sha256(payload), and a hash of a phrase
    # drawn from a 2048-word list is a dictionary attack, not protection.
    assert hashlib.sha256(SEED.encode()).hexdigest().encode() not in blob


@pytest.mark.parametrize(
    "prompt",
    [
        "buy me the best affordable keyboard and phone stand under 400000 naira and see it to delivery",
        "i have two tests this week help me prepare and keep track of what i still need to revise",
        "remind me to take my medicine every morning at eight and to eat breakfast before i leave",
        "research the latest papers on agentic ai memory systems and summarise the most cited ones",
        "i am feeling really low today and could use someone to talk to about how hard this week was",
    ],
)
def test_ordinary_prompts_are_not_mistaken_for_secrets(prompt: str) -> None:
    """
    The screen runs on every prompt, so a false positive is a refused request.

    A structural matcher trades exactness for not shipping a 2048-word list, and
    the cost of that trade lands here. These are the phrasings this app is for —
    the errand, the study plan, the medication reminder, a research request and a
    distress message — and every one of them must go through. The last one matters
    most: refusing it would route someone in distress to a parse error.
    """
    assert contains_secret_material(prompt) == ""


# ═══════════════════════════════════════════════════════════════════════════
# Invariant 4 + 5 — screen capture obeys the policy and fails towards asking
# ═══════════════════════════════════════════════════════════════════════════


def test_capture_is_gated_by_default(policy: ConcaPolicy) -> None:
    """The shipped policy is `ask`, and `ask` opens a gate."""
    assert policy.rules.screen_capture == "ask"
    assert requires_halo(policy, "screen_capture")


@pytest.mark.parametrize(
    "value", ["", "true", "yes", "ON ", "enabled", "1", "asks", "of", "nonsense"]
)
def test_only_the_exact_string_on_lowers_the_gate(policy: ConcaPolicy, value: str) -> None:
    """
    Every spelling that is not `on` still gates.

    `"ON "` is in this list on purpose: it *should* lower the gate after
    normalisation, and asserting it does is how the whitespace handling stays
    honest. Everything else is a plausible thing someone types into a YAML file,
    and none of it may be read as permission.
    """
    gated = requires_halo(_mode(policy, value), "screen_capture")
    assert gated is (value.strip().lower() != "on")


def test_capture_mode_normalises_unknown_values_to_ask(policy: ConcaPolicy) -> None:
    """`screen_mode` is the single reader, so a typo cannot mean different things."""
    assert tools.screen_mode(_mode(policy, "banana")) == "ask"
    assert tools.screen_mode(_mode(policy, "")) == "ask"
    assert tools.screen_mode(_mode(policy, " OFF ")) == "off"
    assert tools.screen_mode(_mode(policy, "On")) == "on"


def test_capture_refuses_when_off_and_names_the_key(
    policy: ConcaPolicy, store: MemoryStore
) -> None:
    """`off` is enforced by refusal, because a gate cannot express "never"."""
    local = ExecContext(
        session_id="inv",
        role="staff",
        policy=_mode(policy, "off"),
        store=store,
        broker=SseBroker(),
    )
    tools.stash_screen("cap-off", PNG_1PX)
    got = asyncio.run(tools.screen_capture({"capture_ref": "cap-off"}, local))
    assert not got["ok"]
    assert "screen_capture" in got["summary"], "the refusal must name the key"


def test_capture_refuses_without_a_handle(ctx: ExecContext) -> None:
    """Pixels are not a tool argument. The only way in is the jar."""
    got = asyncio.run(tools.screen_capture({"image_b64": PNG_1PX}, ctx))
    assert not got["ok"]
    assert "capture_ref" in got["summary"]


def test_capture_recovers_the_handle_from_the_prompt(ctx: ExecContext) -> None:
    """
    A planner that drops the payload key must not silently read nothing.

    The handle is safe to match out of prose: it is meaningless without the jar,
    single-use, and gone in two minutes. What this asserts is that the fallback
    finds it — the failure it prevents is an operator pressing a hotkey, having
    their screen captured, and being answered about nothing.
    """
    tools.stash_screen("cap_FromThePrompt", PNG_1PX)
    ctx.prompt = "Look at my screen and answer: what is this? (capture_ref cap_FromThePrompt)"
    assert tools._SCREEN_REF.search(ctx.prompt), "the fallback regex must match"
    tools._take_screen("cap_FromThePrompt")


def test_screen_jar_is_single_use_and_expires() -> None:
    """Same two properties as the card jar, asserted separately from it."""
    tools.stash_screen("cap-once", PNG_1PX)
    assert tools._take_screen("cap-once") is not None
    assert tools._take_screen("cap-once") is None

    tools.stash_screen("cap-ttl", PNG_1PX)
    tools._sweep_screens(now=time.time() + tools.SCREEN_TTL + 1)
    assert tools._take_screen("cap-ttl") is None


def test_stash_screen_returns_no_pixels_and_no_dimensions() -> None:
    """
    The receipt is a handle and a byte count.

    Dimensions are withheld deliberately as well as pixels: "3840×2160" identifies
    which monitor was photographed, which is a fact about the operator's desk.
    """
    receipt = tools.stash_screen("cap-receipt", PNG_1PX)
    tools._take_screen("cap-receipt")
    assert set(receipt) == {"ref", "bytes", "ttl_seconds"}
    assert PNG_1PX[:32] not in str(receipt)


def test_stash_screen_rejects_junk() -> None:
    """Invalid base64 is refused at the door rather than sent to a provider."""
    for junk in ("", "   ", "not base64 at all!!", "a" * 5):
        with pytest.raises(ValueError):
            tools.stash_screen("cap-junk", junk)


def test_stash_screen_enforces_a_ceiling() -> None:
    """A looping overlay cannot make the jar the largest object in the process."""
    oversize = "A" * (tools._MAX_SCREEN_B64 + 4)
    with pytest.raises(ValueError):
        tools.stash_screen("cap-big", oversize)
    assert "cap-big" not in tools._SCREEN_JAR


def test_capture_result_carries_no_image(ctx: ExecContext, monkeypatch) -> None:
    """
    Whatever the model says, no pixels come back out.

    The vision call is stubbed rather than skipped, so this exercises the success
    path — the one where there is something to leak.
    """

    class _Result:
        text = "A code editor is open on the left and a terminal on the right."
        model_id, provider, tier, stubbed = "fake-vision", "gemini", "free", False

    class _Rotator:
        async def complete_vision(self, *_a, **_k):
            return _Result()

    monkeypatch.setattr(tools, "get_rotator", lambda: _Rotator())
    tools.stash_screen("cap-ok", PNG_1PX)
    got = asyncio.run(tools.screen_capture({"capture_ref": "cap-ok"}, ctx))

    assert got["ok"]
    assert got["persisted"] is False
    assert "image" not in got and "b64" not in got
    assert PNG_1PX[:32] not in str(got)
    assert "cap-ok" not in tools._SCREEN_JAR, "the frame must be popped, not copied"


def test_capture_reports_failure_rather_than_inventing(ctx: ExecContext, monkeypatch) -> None:
    """
    With no vision model reachable, the answer is an admission.

    `complete_vision` has no stub planner behind it on purpose: confident prose
    about the operator's display would be the worst possible output, because it is
    the one kind of answer they cannot check by looking.
    """

    class _Stub:
        text = "The screen was not read — no vision-capable model was reachable."
        model_id, provider, tier, stubbed = "stub", "stub", "free", True

    class _Rotator:
        async def complete_vision(self, *_a, **_k):
            return _Stub()

    monkeypatch.setattr(tools, "get_rotator", lambda: _Rotator())
    tools.stash_screen("cap-stub", PNG_1PX)
    got = asyncio.run(tools.screen_capture({"capture_ref": "cap-stub"}, ctx))

    assert not got["ok"], "an unread screen is not a successful read"
    assert got["stubbed"] is True


# ═══════════════════════════════════════════════════════════════════════════
# Rule 0 — content and provenance are two doors to the same exclusion
# ═══════════════════════════════════════════════════════════════════════════


def _embedded(store: MemoryStore, entry_id: int) -> int:
    row = store._conn.execute(
        "SELECT embedded, sensitive FROM context_entries WHERE id = ?", (entry_id,)
    ).fetchone()
    return int(row[0]), int(row[1])


def test_distress_content_is_not_embedded(store: MemoryStore) -> None:
    """The original Rule 0: the transcript keeps it, the index never sees it."""
    entry = store.append_entry("s", "user", "i feel hopeless and want to hurt myself")
    embedded, sensitive = _embedded(store, entry.id)
    assert sensitive == 1
    assert embedded == 0


def test_provenance_excludes_text_no_pattern_can_catch(store: MemoryStore) -> None:
    """
    A screen description is private because of where it came from.

    "The invoice shows £4,000 owed to Ashworth Ltd" contains no distress
    vocabulary and never will. If the exclusion were content-only, this sentence
    would become a vector row that a later session could retrieve — turning one
    frame the operator chose to show one model into a permanent searchable fact.
    """
    text = "The invoice on screen shows GBP 4,000 owed to Ashworth Ltd, due Friday."
    assert not __import__("memory").is_sensitive(text), "premise: no family matches this"

    entry = store.append_entry("s", "agent", text, agent="desktop", sensitive=True)
    embedded, sensitive = _embedded(store, entry.id)
    assert sensitive == 1
    assert embedded == 0


def test_the_flag_can_only_add_sensitivity(store: MemoryStore) -> None:
    """
    `sensitive=False` over matching text must not be a way to get it embedded.

    Same asymmetry `requires_halo` holds for gates: a caller may tighten, never
    loosen. Without this the parameter is a switch for turning Rule 0 off one call
    at a time.
    """
    entry = store.append_entry(
        "s", "user", "i feel hopeless and want to hurt myself", sensitive=False
    )
    embedded, sensitive = _embedded(store, entry.id)
    assert sensitive == 1, "an explicit False must not override a pattern match"
    assert embedded == 0


def test_exclusion_is_audited(store: MemoryStore) -> None:
    """
    The skip is recorded, so the boundary is demonstrable rather than asserted.

    Both doors write the row, with different reasons — a reader can tell which
    rule fired without holding the excluded text.
    """
    store.append_entry("s", "user", "i feel hopeless and want to hurt myself")
    store.append_entry("s", "agent", "A terminal is open.", agent="desktop", sensitive=True)
    rows = store._conn.execute(
        "SELECT reason FROM audit_log WHERE action = 'rule0_exclusion'"
    ).fetchall()
    reasons = " ".join(r[0] for r in rows)
    assert len(rows) == 2
    assert "pattern family" in reasons
    assert "provenance" in reasons


def test_the_audit_log_holds_a_hash_not_the_text(store: MemoryStore) -> None:
    """
    The record proves which bytes an action carried without copying them.

    This is what makes an excluded turn auditable and still unretrievable — and it
    is why `payload=content` on the exclusion row is safe.
    """
    secret = "i feel hopeless and want to hurt myself"
    store.append_entry("s", "user", secret)
    kept = store._conn.execute(
        "SELECT content FROM context_entries WHERE session_id = 's'"
    ).fetchone()
    assert kept and kept[0] == secret, "premise: the transcript does keep it"
    row = store._conn.execute(
        "SELECT payload_hash FROM audit_log WHERE action = 'rule0_exclusion'"
    ).fetchone()
    assert row and len(row[0]) == 64, "the audit row should carry a sha256"
    assert secret not in row[0]


# ═══════════════════════════════════════════════════════════════════════════
# Invariant 6 — nothing existing is relaxed
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/api/conca/raw",
        "http://localhost:8000/",
        "http://[::1]/",
        "http://169.254.169.254/latest/meta-data/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://172.16.4.4/",
        "file:///etc/passwd",
    ],
)
def test_check_url_blocks_ssrf_targets(policy: ConcaPolicy, url: str) -> None:
    """
    Loopback, private ranges, metadata services and non-http schemes.

    Asserted against the shipped policy rather than a fixture, because the point
    is that the block holds however `blocked_domains` is edited: an agent that can
    be talked into fetching the metadata URL hands over cloud credentials, and it
    is reachable from any process that can open a socket.
    """
    ok, _ = check_url(policy, url)
    assert not ok, f"{url} must be refused"


def test_check_url_permits_an_ordinary_host(policy: ConcaPolicy) -> None:
    """The block must be narrow enough to leave the browser useful."""
    ok, _ = check_url(policy, "https://arxiv.org/abs/2401.00001")
    assert ok


def test_shipped_policy_still_holds_its_floors(policy: ConcaPolicy) -> None:
    """
    The lines that must not quietly move.

    Every one of these has a comment in `.conca` explaining why it is set the way
    it is. This test is what makes the comment load-bearing.
    """
    assert policy.off_limits_paths, "an empty deny-list fails open"
    assert policy.allowed_paths, "an empty allow-list fails open"
    assert policy.rules.confirm_before_send_email
    assert policy.rules.confirm_before_send_sms
    assert policy.rules.confirm_before_call
    assert policy.rules.max_file_size_mb == 50
    assert "research" == "".join(policy.agents_for_role("public")), "public is research only"
    assert "desktop" not in policy.agents_for_role("student"), (
        "the student role must not be able to read the operator's screen"
    )
    assert "chain" not in policy.agents_for_role("student")
    assert "shopper" not in policy.agents_for_role("student")


def test_sqlite_file_is_the_only_thing_written(tmp_path: Path) -> None:
    """
    A fresh store creates one file and no stray artefacts.

    Cheap, and it is the assertion that would fail first if something started
    spooling pixels or audio to a temp directory beside the database.
    """
    before = set(tmp_path.iterdir())
    store = MemoryStore(tmp_path / "one.db")
    store.append_entry("s", "user", "hello")
    made = {p.name for p in set(tmp_path.iterdir()) - before}
    stray = {n for n in made if not n.startswith("one.db")}
    assert not stray, f"unexpected files: {sorted(stray)}"
    with sqlite3.connect(tmp_path / "one.db") as conn:
        assert conn.execute("SELECT count(*) FROM context_entries").fetchone()[0] == 1


# ═══════════════════════════════════════════════════════════════════════════
# The offline planner reaches every agent
# ═══════════════════════════════════════════════════════════════════════════


def test_the_stub_can_route_to_every_agent_that_owns_a_tool() -> None:
    """
    With no provider reachable, the keyword router is the only planner there is.

    It held seven agents while fifteen owned tools, and the eight it was missing
    were the ones carrying the gated actions — so offline, a prompt aimed at
    `desktop` or `shopper` fell through to the `research` default and quietly ran
    a web search. The gate was not bypassed; it was simply never reached, which
    looks the same from the outside and is the more misleading of the two.

    Asserted rather than eyeballed because the registry is where new agents get
    added and this map is not.
    """
    from rotator import _AGENT_KEYWORDS, _DEFAULT_TASK_TYPE, _STUB_DESCRIPTION
    from tools import TOOL_REGISTRY

    registered = {agent for agent, _task in TOOL_REGISTRY}
    unroutable = sorted(registered - set(_AGENT_KEYWORDS))
    assert not unroutable, (
        f"{len(unroutable)} agent(s) own a tool but no keyword reaches them "
        f"offline: {unroutable}"
    )
    assert not sorted(registered - set(_DEFAULT_TASK_TYPE)), "missing default task"
    assert not sorted(registered - set(_STUB_DESCRIPTION)), "missing description"


def test_every_stub_default_task_is_a_real_registry_key() -> None:
    """
    A default naming a task no tool emits is the `file_write`/`write_file` bug
    again, one layer up: `resolve_tool` returns None, the step reports
    "unsupported", and the agent reads as broken rather than as unconfigured.
    """
    from rotator import _DEFAULT_TASK_TYPE
    from tools import TOOL_REGISTRY

    bad = sorted(
        f"{agent}/{task}"
        for agent, task in _DEFAULT_TASK_TYPE.items()
        if (agent, task) not in TOOL_REGISTRY
    )
    assert not bad, f"stub defaults that no tool implements: {bad}"


def test_the_stub_routes_the_prompts_the_new_agents_exist_for() -> None:
    """
    The keyword sets are only useful if they win against the generic ones, so the
    assertion is on the *leading* agent — the one the stub puts in layer 0 — not
    on mere membership.
    """
    from rotator import DeterministicStub

    stub = DeterministicStub()
    for prompt, expected in [
        ("what is on my screen right now?", "desktop"),
        ("buy me the best affordable keyboard under $200", "shopper"),
        ("what is the stock price of NVDA", "market"),
        ("check my solana wallet balance", "chain"),
        ("post this to linkedin", "social"),
        ("summarise my github repo", "github"),
        ("find me papers on agent oversight", "research"),
    ]:
        plan = stub.plan(prompt)
        leading = plan["subtasks"][0]["agent"]
        assert leading == expected, f"{prompt!r} led with {leading}, not {expected}"


# ═══════════════════════════════════════════════════════════════════════════
# The gate has to be reachable to be a gate
# ═══════════════════════════════════════════════════════════════════════════


def test_every_halo_trigger_is_reachable_with_no_provider() -> None:
    """
    The check that was missing, and the reason nine gates went unexercised.

    `test_halo_triggers_are_registered` proves every trigger names a real tool.
    It cannot prove anything *dispatches* that tool. Offline the planner is the
    keyword stub, and the stub proposed one tool per agent — so nine of the twelve
    triggers could not be reached at all, and a checkout request quietly ran
    `shop_search` instead. A gate nothing routes to is indistinguishable from a
    gate that is not there: both look like a clean transcript.
    """
    from rotator import _DEFAULT_TASK_TYPE, _TASK_KEYWORDS

    reachable = set(_DEFAULT_TASK_TYPE.values())
    for entries in _TASK_KEYWORDS.values():
        for _words, task, _description in entries:
            reachable.add(task)

    gated = {task for _agent, task in TOOL_REGISTRY if task in HALO_TRIGGERS}
    missing = sorted(gated - reachable)
    assert not missing, f"gated but unreachable offline: {missing}"


def test_stub_task_keywords_name_real_tools() -> None:
    """Every override is a registered `(agent, task)` pair, not a plausible guess."""
    from rotator import _TASK_KEYWORDS

    for agent, entries in _TASK_KEYWORDS.items():
        for _words, task, _description in entries:
            assert (agent, task) in TOOL_REGISTRY, f"{agent}/{task} is not a real tool"


@pytest.mark.parametrize(
    ("prompt", "expected"),
    [
        ("check out the cart and pay for it", ("shopper", "shop_checkout")),
        ("where is my order, has it shipped", ("shopper", "order_track")),
        ("prepare an unsigned solana transfer of 0.1", ("chain", "chain_prepare_tx")),
        ("cancel my calendar event on friday", ("calendar", "delete_event")),
        ("log in to the website and click through", ("browser", "browser_act")),
    ],
)
def test_the_stub_reaches_the_gated_task_the_prompt_asks_for(
    prompt: str, expected: tuple[str, str]
) -> None:
    """The behavioural half: a prompt naming a gated action dispatches it."""
    from rotator import DeterministicStub

    plan = DeterministicStub().plan(prompt)
    pairs = [(s["agent"], s["task_type"]) for s in plan["subtasks"]]
    assert expected in pairs, f"{prompt!r} produced {pairs}"
