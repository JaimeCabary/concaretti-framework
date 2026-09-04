"""
Concaretti-Light — FastAPI entrypoint.

One process serves everything: the JSON API, the SSE stream, and the built
frontend as static files. That is the whole point of the rebuild — the old system
needed nineteen services, Redis, and Postgres running before it would answer a
request.

Run it:
    uv run uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import threading
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any, Literal

import httpx
import yaml
from dotenv import load_dotenv
from fastapi import (
    Body,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

from agents import Orchestrator  # noqa: E402
from auth import (  # noqa: E402
    COOKIE_NAME,
    VALID_ROLES,
    Role,
    current_role,
    is_local,
    make_cookie,
    require_local,
)
import envfile  # noqa: E402
from halo import get_gate  # noqa: E402
from memory import get_store, is_sensitive  # noqa: E402
from operator_notes import notes_status  # noqa: E402
from rotator import get_rotator  # noqa: E402
from security import (  # noqa: E402
    DEFAULT_POLICY_PATH,
    HALO_TRIGGERS,
    ConcaPolicy,
    ShellNormalizer,
    is_safe,
    load_policy,
    requires_halo,
)
from sse import get_broker  # noqa: E402

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

state: dict[str, Any] = {}


# ═══════════════════════════════════════════════════════════════════════════
# Cron scheduler
# ═══════════════════════════════════════════════════════════════════════════


def _cron_field_matches(field: str, value: int, lo: int, hi: int) -> bool:
    """
    Match one field of a cron expression against a value.

    Supports `*`, `*/n`, `a,b,c`, `a-b` and `a-b/n` — the subset that covers
    every expression this app ships and every one a user is likely to type. An
    unparseable part is skipped rather than raised on, so a typo in .conca costs
    that job its run instead of taking down the whole loop.
    """
    for part in field.split(","):
        part = part.strip()
        if not part:
            continue

        step = 1
        if "/" in part:
            part, _, raw_step = part.partition("/")
            if not raw_step.isdigit() or int(raw_step) < 1:
                continue
            step = int(raw_step)

        if part in ("*", ""):
            start, end = lo, hi
        elif "-" in part:
            a, _, b = part.partition("-")
            if not (a.isdigit() and b.isdigit()):
                continue
            start, end = int(a), int(b)
        elif part.isdigit():
            start = end = int(part)
        else:
            continue

        if start > end or start < lo or end > hi:
            continue
        if value in range(start, end + 1, step):
            return True

    return False


def _cron_date_matches(dom: str, month: str, dow: str, when: time.struct_time) -> bool:
    """
    Match the three date fields of a cron expression.

    Split out from `cron_matches` because `next_fire` tests these alone to decide
    whether a candidate day is worth walking minute by minute.

    When day-of-month and day-of-week are both restricted they are OR-ed, which is
    what Vixie cron does and what people expect: `0 0 1 * 1` means the first of the
    month *and* every Monday, not only Mondays that fall on the first.
    """
    if not _cron_field_matches(month, when.tm_mon, 1, 12):
        return False

    # struct_time has Monday=0; cron has Sunday=0, and accepts 7 for Sunday too.
    cron_dow = (when.tm_wday + 1) % 7
    dow_ok = _cron_field_matches(dow, cron_dow, 0, 7)
    if not dow_ok and cron_dow == 0:
        dow_ok = _cron_field_matches(dow, 7, 0, 7)
    dom_ok = _cron_field_matches(dom, when.tm_mday, 1, 31)

    dom_restricted = dom.strip() != "*"
    dow_restricted = dow.strip() != "*"
    if dom_restricted and dow_restricted:
        return dom_ok or dow_ok
    if dom_restricted:
        return dom_ok
    if dow_restricted:
        return dow_ok
    return True


def cron_matches(expr: str, when: time.struct_time) -> bool:
    """
    Whether a 5-field cron expression fires at `when`, in local time.

    Fields are minute hour day-of-month month day-of-week.
    """
    fields = expr.split()
    if len(fields) != 5:
        return False
    minute, hour, dom, month, dow = fields
    return (
        _cron_field_matches(minute, when.tm_min, 0, 59)
        and _cron_field_matches(hour, when.tm_hour, 0, 23)
        and _cron_date_matches(dom, month, dow, when)
    )


def next_fire(expr: str, after: float, horizon_days: int = 400) -> str | None:
    """
    The next local time `expr` fires strictly after `after`, or None.

    Searched rather than solved. A day whose date fields don't match is skipped
    whole — one check instead of 1440 — so the common case costs a few hundred
    comparisons and the pathological one (a cron that never fires, e.g. `0 0 30 2
    *`) terminates at the horizon instead of spinning. 400 days covers every
    annual expression including a leap-year offset.

    None is also what an unparseable expression returns, which is why the UI shows
    "—" rather than a wrong time for a typo in .conca.
    """
    fields = expr.split()
    if len(fields) != 5:
        return None
    minute_f, hour_f, dom_f, month_f, dow_f = fields

    cursor = float((int(after) // 60 + 1) * 60)  # next whole minute

    for _ in range(horizon_days):
        day = time.localtime(cursor)
        if not _cron_date_matches(dom_f, month_f, dow_f, day):
            cursor = time.mktime(
                (day.tm_year, day.tm_mon, day.tm_mday + 1, 0, 0, 0, 0, 0, -1)
            )
            continue

        # Walk this day's remaining minutes. A DST spring-forward hour simply
        # doesn't occur in localtime, so a job scheduled inside it is skipped for
        # that day — the same thing system cron does.
        probe = cursor
        while True:
            t = time.localtime(probe)
            if t.tm_yday != day.tm_yday:
                break
            if _cron_field_matches(hour_f, t.tm_hour, 0, 23) and _cron_field_matches(
                minute_f, t.tm_min, 0, 59
            ):
                return time.strftime("%Y-%m-%dT%H:%M", t)
            probe += 60
        cursor = probe

    return None


async def _scheduler_loop() -> None:
    """
    Fire the .conca `schedules:` entries at their cron times, and sample the
    machine once per minute on the way past.

    Dispatch goes through the orchestrator, so a scheduled prompt meets exactly
    the same .conca screen and HALO gate as a typed one. That is deliberate: a
    cron entry must not become a way to run something the policy would refuse
    interactively. The orchestrator kill-switch in `run()` still applies, and
    runs are attributed to `staff` because there is no interactive caller.

    Each job remembers the minute it last fired, so a tick landing twice inside
    the same minute cannot double-dispatch.

    The system sampler lives here rather than in a thread of its own because this
    loop already wakes on the minute boundary, which is exactly the resolution
    wanted — a second timer would double the machinery for the same series.
    """
    last_fired: dict[str, str] = state.setdefault("cron_last_fired", {})

    async def _dispatch(session_id: str, prompt: str) -> None:
        try:
            await orch().run(session_id, prompt, "staff")
        except Exception as exc:
            broker().error(session_id, f"{type(exc).__name__}: {exc}")
            broker().done(session_id, "scheduled run failed")

    ticks = 0
    while True:
        try:
            _sample_system()
            ticks += 1
            # Retention, folded into the tick that writes. Hourly is often
            # enough for a 72h window and avoids a DELETE every minute.
            if ticks % 60 == 0:
                store().prune_system_samples()

            now = time.localtime()
            stamp = time.strftime("%Y-%m-%dT%H:%M", now)

            for job in policy().schedules:
                key = f"{job.cron}|{job.prompt}"
                if last_fired.get(key) == stamp or not cron_matches(job.cron, now):
                    continue
                last_fired[key] = stamp

                session_id = f"cron-{job.id}"
                store().ensure_session(
                    session_id, role="staff", prompt=job.prompt, title=f"scheduled — {job.cron}"
                )
                store().log_audit(
                    session_id, "scheduler", "cron_dispatch", "allowed", job.cron
                )
                task = asyncio.create_task(_dispatch(session_id, job.prompt))
                state.setdefault("tasks", set()).add(task)
                task.add_done_callback(lambda t: state["tasks"].discard(t))

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # A scheduler that dies quietly is worse than one that complains and
            # keeps ticking — a bad .conca edit must not stop every later job.
            print(f"[concaretti] scheduler tick failed: {type(exc).__name__}: {exc}")

        # Sleep to just past the next minute boundary rather than a flat 60s, so
        # accumulated drift cannot walk a job off its minute and skip it.
        await asyncio.sleep(61 - time.localtime().tm_sec)


def _read_system() -> dict | None:
    """
    One psutil reading, or None when psutil is absent.

    Imported lazily and inside the try: psutil is a compiled dependency, and a
    machine that fails to build it should still get a working app with one strip
    greyed out rather than an ImportError at module load.

    `cpu_percent()` is called with no interval, which returns the average since
    the *previous* call rather than blocking. That is why the first reading after
    boot is meaningless and the sampler is what makes the series real — by the
    time a user opens the panel, a minute-spaced call has already primed it.
    """
    try:
        import psutil

        proc = state.get("psutil_proc")
        if proc is None:
            proc = psutil.Process(os.getpid())
            state["psutil_proc"] = proc
            # Prime both counters so the next call has a baseline to divide by.
            psutil.cpu_percent(None)
            proc.cpu_percent(None)

        inflight = len(state.get("tasks", set()))
        pending = len(gate().list_pending(None))
        if inflight >= 8 or pending >= 4:
            load = "strained"
        elif inflight >= 3 or pending >= 1:
            load = "busy"
        else:
            load = "idle"

        with proc.oneshot():
            return {
                "cpu_pct": round(psutil.cpu_percent(None), 1),
                "mem_pct": round(psutil.virtual_memory().percent, 1),
                "proc_cpu_pct": round(proc.cpu_percent(None), 1),
                "proc_rss_mb": round(proc.memory_info().rss / 1_048_576, 1),
                "threads": threading.active_count(),
                "load_state": load,
                "cores": psutil.cpu_count(logical=True) or 0,
                "ts": time.time(),
            }
    except Exception:
        # ImportError, or psutil losing the process on a platform that restricts
        # it. Either way the caller reports "unavailable" and nothing else breaks.
        return None


def _sample_system() -> None:
    """Write one reading, if psutil is there. Never raises into the loop."""
    reading = _read_system()
    if not reading:
        return
    try:
        store().record_system_sample(
            cpu_pct=reading["cpu_pct"],
            mem_pct=reading["mem_pct"],
            proc_cpu_pct=reading["proc_cpu_pct"],
            proc_rss_mb=reading["proc_rss_mb"],
            threads=reading["threads"],
            load_state=reading["load_state"],
        )
    except Exception as exc:
        print(f"[concaretti] system sample failed: {type(exc).__name__}: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    policy = load_policy(DEFAULT_POLICY_PATH)
    store = get_store()
    store.seed_demo_data()

    broker = get_broker()
    rotator = get_rotator()
    gate = get_gate(broker, rotator)

    state["policy"] = policy
    state["store"] = store
    state["broker"] = broker
    state["rotator"] = rotator
    state["gate"] = gate
    state["orchestrator"] = Orchestrator(policy, store, broker, rotator, gate)
    state["normalizer"] = ShellNormalizer()
    state["started"] = time.time()

    # Autonomous Sentinel watcher loop: continually monitors calendar, market, and perimeter
    from watcher import sentinel_loop
    state["sentinel"] = asyncio.create_task(sentinel_loop(state))
    print("[concaretti] autonomous sentinel loop active — continuous monitoring & listening engaged")

    if os.getenv("CONCA_DISABLE_SCHEDULER", "").lower() not in ("1", "true", "yes"):
        state["scheduler"] = asyncio.create_task(_scheduler_loop())
        print(
            f"[concaretti] scheduler running — {len(policy.schedules)} "
            f".conca schedule(s) armed, sampling the machine each minute"
        )
    else:
        print("[concaretti] scheduler disabled — no cron, no system sampling")

    status = rotator.status()
    print(
        f"[concaretti] policy v{policy.version} loaded — "
        f"{len(policy.enabled_agents())} agents enabled"
    )
    print(
        f"[concaretti] rotator: {status['active_count']}/{status['ladder_size']} "
        f"entries active across {status['providers_available']}"
    )
    if not status["live_provider_configured"]:
        print(
            "[concaretti] no live provider key found — running on the "
            "deterministic stub. Set GEMINI_API_KEY or GROQ_API_KEY for real output."
        )
    if not FRONTEND_DIST.is_dir():
        print(
            f"[concaretti] {FRONTEND_DIST} not built yet — API only. "
            "Run `pnpm build` in frontend/ to serve the UI from here."
        )

    yield

    sentinel = state.pop("sentinel", None)
    if sentinel is not None:
        sentinel.cancel()
        with suppress(asyncio.CancelledError):
            await sentinel
    sched = state.pop("scheduler", None)
    if sched is not None:
        sched.cancel()
        with suppress(asyncio.CancelledError):
            await sched
    store.close()


app = FastAPI(title="Concaretti-Light", version="0.1.0", lifespan=lifespan)

# The Vite dev server runs on a different origin, and SSE plus cookies need
# credentialed CORS. Locked to localhost rather than "*", which is incompatible
# with allow_credentials anyway.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:1420",  # Tauri dev
        "tauri://localhost",
        "capacitor://localhost",  # Capacitor iOS
        "https://localhost",  # Capacitor Android, androidScheme: 'https'
        "http://localhost",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def orch() -> Orchestrator:
    return state["orchestrator"]


def store():
    return state["store"]


def broker():
    return state["broker"]


def gate():
    return state["gate"]


def policy():
    return state["policy"]


# ═══════════════════════════════════════════════════════════════════════════
# Health & policy
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/health")
async def health() -> dict:
    p = policy()
    status = state["rotator"].status()
    return {
        "status": "ok",
        "policy_loaded": True,
        "policy_version": p.version,
        "agents_enabled": p.enabled_agents(),
        "models_active": status["active_count"],
        "live_provider": status["live_provider_configured"],
        "vector_memory": store().vec_enabled,
        "frontend_built": FRONTEND_DIST.is_dir(),
        "uptime_seconds": round(time.time() - state["started"], 1),
    }


@app.get("/api/conca/status")
async def conca_status(role: Role = Depends(current_role)) -> dict:
    p = policy()
    return {
        "version": p.version,
        "security_overrides": p.security_overrides.model_dump(),
        "agent_permissions": p.agent_permissions,
        "agents_enabled": p.enabled_agents(),
        "agents_for_your_role": p.agents_for_role(role),
        "role": role,
        "off_limits_paths": p.off_limits_paths,
        "allowed_paths": p.allowed_paths,
        "rules": p.rules.model_dump(),
        "connectors": [c.model_dump() for c in p.connectors],
        "schedules": [s.model_dump() for s in p.schedules],
        "halo_triggers": sorted(HALO_TRIGGERS),
        "policy_path": str(DEFAULT_POLICY_PATH),
        # The operator tier. Reported as presence and size only — the notes
        # themselves are the operator's own text and there is no reason for a
        # status endpoint to echo them back over the network.
        "operator_notes": notes_status(),
    }


@app.post("/api/conca/reload")
async def conca_reload() -> dict:
    """Re-read `.conca` from disk so policy edits apply without a restart."""
    try:
        p = load_policy(DEFAULT_POLICY_PATH)
    except Exception as exc:
        raise HTTPException(400, f"policy failed to load: {exc}") from exc
    state["policy"] = p
    orch().reload_policy(p)
    return {"ok": True, "version": p.version, "agents_enabled": p.enabled_agents()}


class SimulateRequest(BaseModel):
    command: str


@app.post("/api/conca/simulate")
async def conca_simulate(req: SimulateRequest) -> dict:
    """
    Dry-run the security engine against a command without executing anything.

    This is the endpoint to drive during a defence: paste an obfuscated command,
    show the nine normalisation stages collapsing it, and show the verdict. No
    subprocess is ever spawned here.
    """
    normalizer: ShellNormalizer = state["normalizer"]
    allowed, reason = is_safe(policy(), req.command)
    destructive, verb = normalizer.is_destructive(req.command)
    return {
        "input": req.command,
        "normalized": normalizer.normalize(req.command),
        "segments": normalizer.segments(req.command),
        "destructive": destructive,
        "destructive_verb": verb,
        "allowed": allowed,
        "reason": reason,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Auth
# ═══════════════════════════════════════════════════════════════════════════


class LoginRequest(BaseModel):
    role: Literal["public", "student", "staff"]


@app.post("/api/auth/login")
async def login(req: LoginRequest, request: Request, response: Response) -> dict:
    """
    Set the role cookie explicitly.

    Local callers only. This route used to mint a staff cookie for anyone who asked
    — which is what made the council PIN sitting beside it decorative — so it is now
    bounded by the same machine boundary that grants the local role in the first
    place. What it is *for* is stepping down: previewing the student or public
    surface without editing `.conca`, and `logout` to return to the default.
    """
    require_local(request)
    if req.role not in VALID_ROLES:
        raise HTTPException(400, f"role must be one of {VALID_ROLES}")
    response.set_cookie(
        key=COOKIE_NAME,
        value=make_cookie(req.role),
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )
    return {"ok": True, "role": req.role, "agents": policy().agents_for_role(req.role)}


@app.post("/api/auth/logout")
async def logout(response: Response) -> dict:
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True, "role": "public"}


@app.get("/api/auth/me")
async def me(request: Request, role: Role = Depends(current_role)) -> dict:
    return {
        "role": role,
        "agents": policy().agents_for_role(role),
        "halo_visible": role in {"student", "staff"},
        # Whether the mic is worth showing at all. Sent with identity because the
        # client needs it before the first click, and a button that only reveals
        # itself to be unavailable once pressed is worse than no button.
        "voice": _voice_ready(),
        # Same reasoning for the setup surface: the two conditions that gate it are
        # both known here, and offering a "connect your accounts" step that 403s on
        # submit is worse than not offering it. False on the phone wrapper, which
        # reaches the server over a LAN and cannot write its `.env`.
        "setup": role == "staff" and is_local(request),
    }


class ProfilePayload(BaseModel):
    name: str = ""
    role: str = "staff"
    onboarded: bool = True


PROFILE_FILE = Path(__file__).parent.parent / "user_profile.json"


@app.get("/api/profile")
async def get_profile() -> dict:
    if PROFILE_FILE.exists():
        try:
            return json.loads(PROFILE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"name": "Heccker", "role": "staff", "onboarded": True}


@app.post("/api/profile")
async def update_profile(payload: ProfilePayload) -> dict:
    data = {"name": payload.name, "role": payload.role, "onboarded": payload.onboarded}
    try:
        PROFILE_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as err:
        print("[!] Failed writing profile file:", err)
    return {"ok": True, **data}


# ═══════════════════════════════════════════════════════════════════════════
# Agent runs
# ═══════════════════════════════════════════════════════════════════════════


class RunRequest(BaseModel):
    prompt: str = Field(min_length=1)
    session_id: str | None = None


@app.post("/api/agents/run")
async def run_agents(req: RunRequest, role: Role = Depends(current_role)) -> dict:
    """
    Start a run and return immediately.

    The orchestrator executes as a background task so the HTTP request does not
    hold open for the length of a HALO pause — a gate can wait minutes for a
    human. Progress arrives over `/sse/{session_id}`, which replays from the
    start, so a client that subscribes after this returns misses nothing.
    """
    session_id = req.session_id or store().create_session(role=role, prompt=req.prompt)

    async def _run() -> None:
        try:
            await orch().run(session_id, req.prompt, role)
        except Exception as exc:
            broker().error(session_id, f"{type(exc).__name__}: {exc}")
            broker().done(session_id, "run failed")

    task = asyncio.create_task(_run())
    # Hold a reference so the task is not garbage-collected mid-flight.
    state.setdefault("tasks", set()).add(task)
    task.add_done_callback(lambda t: state["tasks"].discard(t))

    return {
        "ok": True,
        "session_id": session_id,
        "stream": f"/sse/{session_id}",
        "rule0_excluded": is_sensitive(req.prompt),
    }


@app.get("/api/sessions")
async def sessions() -> dict:
    return {"sessions": store().list_sessions()}


@app.get("/api/sessions/{session_id}")
async def session_detail(session_id: str) -> dict:
    window = store().get_window(session_id)
    return {
        "session_id": session_id,
        "entries": [
            {
                "role": e.role,
                "content": e.content,
                "agent": e.agent,
                "ts": e.ts,
                "sensitive": e.sensitive,
            }
            for e in window
        ],
        "artifacts": store().list_artifacts(session_id),
    }


@app.get("/sse/{session_id}")
async def sse(session_id: str) -> StreamingResponse:
    return StreamingResponse(
        broker().stream(session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # stops nginx buffering the stream
        },
    )


# ═══════════════════════════════════════════════════════════════════════════
# HALO
# ═══════════════════════════════════════════════════════════════════════════


class ResolveRequest(BaseModel):
    choice_index: int | None = None
    custom_text: str | None = None


@app.get("/api/halo/pending")
async def halo_pending(session_id: str | None = None) -> dict:
    return {"pending": gate().list_pending(session_id)}


@app.post("/api/halo/{approval_id}/resolve")
async def halo_resolve(approval_id: str, req: ResolveRequest) -> dict:
    result = await gate().resolve(
        approval_id, choice_index=req.choice_index, custom_text=req.custom_text
    )
    if not result.get("ok"):
        raise HTTPException(400, result.get("error", "could not resolve"))
    return result


# ═══════════════════════════════════════════════════════════════════════════
# Memory
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/memory/recall")
async def recall(q: str, session_id: str | None = None, k: int = 5) -> dict:
    """
    Semantic recall.

    Returns an empty set for a Rule-0 query and says so explicitly, so the
    exclusion is observable from the UI rather than looking like a search that
    happened to miss.
    """
    if is_sensitive(q):
        return {
            "hits": [],
            "excluded": True,
            "reason": "Query matches a Rule-0 sensitive pattern; recall is disabled for it.",
        }
    hits = store().semantic_search(q, k=k, exclude_session=session_id)
    return {
        "hits": [
            {
                "session_id": h.session_id,
                "role": h.role,
                "agent": h.agent,
                "content": h.content[:500],
                "ts": h.ts,
                "distance": h.distance,
            }
            for h in hits
        ],
        "excluded": False,
        "backend": "sqlite-vec" if store().vec_enabled else "lexical-fallback",
    }


@app.get("/api/memory/audit")
async def audit(session_id: str | None = None, limit: int = 100) -> dict:
    return {"entries": store().list_audit(session_id, limit)}


# ═══════════════════════════════════════════════════════════════════════════
# Artifacts
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/artifacts")
async def artifacts(session_id: str | None = None) -> dict:
    return {"artifacts": store().list_artifacts(session_id)}


@app.get("/api/artifacts/{artifact_id}/download")
async def download_artifact(artifact_id: str) -> FileResponse:
    matches = [a for a in store().list_artifacts() if a["id"] == artifact_id]
    if not matches:
        raise HTTPException(404, "no such artifact")
    art = matches[0]
    p = Path(art["path"])
    if not p.is_file():
        raise HTTPException(410, "artifact file no longer on disk")
    return FileResponse(p, filename=art["filename"], media_type=art["mime"])


# ═══════════════════════════════════════════════════════════════════════════
# Calendar
# ═══════════════════════════════════════════════════════════════════════════


class EventRequest(BaseModel):
    title: str
    start: str | float | None = None
    end: str | float | None = None
    description: str = ""
    kind: str = "event"


@app.get("/api/calendar/events")
async def calendar_events(days: float = 30, kinds: str | None = None) -> dict:
    now = time.time()
    kind_list = [k.strip() for k in kinds.split(",")] if kinds else None
    return {
        "events": store().list_events(now - 7 * 86_400, now + days * 86_400, kind_list)
    }


@app.post("/api/calendar/events")
async def create_calendar_event(
    req: EventRequest, role: Role = Depends(current_role)
) -> dict:
    from tools import ExecContext, create_event

    ctx = ExecContext(
        session_id=store().create_session(role=role, prompt=f"create event: {req.title}"),
        role=role,
        policy=policy(),
        store=store(),
        broker=broker(),
    )
    return await create_event(req.model_dump(), ctx)


@app.delete("/api/calendar/events/{event_id}")
async def remove_calendar_event(event_id: str) -> dict:
    ok = store().delete_event(event_id)
    if not ok:
        raise HTTPException(404, "no such event")
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════
# Email
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/email/list")
async def email_list(max_results: int = 12, role: Role = Depends(current_role)) -> dict:
    from tools import ExecContext, list_emails

    if "email" not in policy().agents_for_role(role):
        raise HTTPException(403, f'role "{role}" has no email access under .conca')

    ctx = ExecContext(
        session_id="inbox-browse",
        role=role,
        policy=policy(),
        store=store(),
        broker=broker(),
    )
    return await list_emails({"max_results": max_results}, ctx)


# ═══════════════════════════════════════════════════════════════════════════
# SMS / Telecom
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/sms/threads")
async def sms_threads(role: Role = Depends(current_role)) -> dict:
    if "sms" not in policy().agents_for_role(role):
        raise HTTPException(403, f'role "{role}" has no telecom access under .conca')
    return {"threads": store().list_sms_threads()}


class SmsSendRequest(BaseModel):
    to: str
    body: str


def _spawn_prompt(prompt: str, role: Role) -> dict:
    """
    Run `prompt` through the orchestrator and return its session handle.

    Every UI action that maps to a gated tool goes through here rather than
    calling the tool directly. That is what keeps the oversight claim true: the
    approval gate, the audit row and the SSE narration are produced by the same
    code path whether a human clicked the button or a model proposed the step. A
    direct tool call from a route handler would skip all three.
    """
    session_id = store().create_session(role=role, prompt=prompt)

    async def _run() -> None:
        await orch().run(session_id, prompt, role)

    task = asyncio.create_task(_run())
    state.setdefault("tasks", set()).add(task)
    task.add_done_callback(lambda t: state["tasks"].discard(t))

    return {"ok": True, "session_id": session_id, "stream": f"/sse/{session_id}"}


@app.post("/api/sms/send")
async def sms_send(req: SmsSendRequest, role: Role = Depends(current_role)) -> dict:
    """
    Send an SMS through the orchestrator so the HALO gate applies.

    Deliberately not a direct call to the Twilio tool: routing it as a prompt
    means the approval gate, the audit entry, and the SSE narration all happen
    exactly as they would for a model-initiated send. A UI path that bypassed the
    gate would make the oversight claim false.
    """
    if "sms" not in policy().agents_for_role(role):
        raise HTTPException(403, f'role "{role}" has no telecom access under .conca')

    return _spawn_prompt(
        f"Send an SMS to {req.to} with the message: {req.body}", role
    )


class CallRequest(BaseModel):
    to: str
    script: str


@app.post("/api/sms/call")
async def sms_call(req: CallRequest, role: Role = Depends(current_role)) -> dict:
    """
    Place a voice call, through the same orchestrator path as a text.

    The prompt says "place a phone call" and names `make_call`, because the
    planner picks the task type from this wording — and picking `send_sms` here
    would text someone a script meant to be spoken. `TASK_ALIASES` in `tools.py`
    is the backstop for that, and this is the front stop.
    """
    if "sms" not in policy().agents_for_role(role):
        raise HTTPException(403, f'role "{role}" has no telecom access under .conca')

    return _spawn_prompt(
        f"Place a phone call (make_call) to {req.to} and say exactly: {req.script}",
        role,
    )


@app.post("/api/sms/webhook")
async def sms_webhook(
    From: str = Form(default=""),
    Body: str = Form(default=""),
    request: Request = None,  # type: ignore[assignment]
) -> Response:
    """
    Twilio inbound webhook.

    Twilio posts form-encoded and expects TwiML back. Inbound messages persist to
    SQLite immediately so the Telecom thread is correct even if no client is
    connected, and an SSE event lets an open Staff screen update live.

    Reaching this from Twilio needs a public URL — a tunnel in development. When
    no tunnel is running, inbound simply does not arrive; the thread still renders
    from whatever is already stored, and outbound continues to work.
    """
    peer = (From or "unknown").strip()
    body = (Body or "").strip()
    if body:
        msg = store().add_sms("inbound", peer, body, status="received")
        broker().publish(
            "telecom",
            "activity",
            {"message": f"SMS from {peer}: {body[:120]}", "sms": msg.__dict__},
        )
    return Response(
        content='<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        media_type="application/xml",
    )


# ═══════════════════════════════════════════════════════════════════════════
# Diary
# ═══════════════════════════════════════════════════════════════════════════


class DiaryRequest(BaseModel):
    day: str | None = None
    summary: str
    reflection: str = ""
    agent_assisted: bool = False


@app.get("/api/diary")
async def diary_list() -> dict:
    return {"entries": store().list_diary()}


@app.post("/api/diary")
async def diary_add(req: DiaryRequest) -> dict:
    day = req.day or time.strftime("%Y-%m-%d")
    entry = store().add_diary_entry(
        day, req.summary, req.reflection, req.agent_assisted
    )
    return {"ok": True, "entry": entry.__dict__}


@app.delete("/api/diary/{entry_id}")
async def diary_delete(entry_id: str) -> dict:
    ok = store().delete_diary_entry(entry_id)
    return {"ok": ok}


# ═══════════════════════════════════════════════════════════════════════════
# Scheduler & rotator
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/scheduler/jobs")
async def scheduler_jobs() -> dict:
    """
    Reminders the scheduler agent has set, plus the `.conca` cron entries.

    `next_fire` is computed on read rather than stored, so it stays honest after a
    policy reload rewrites a cron expression. `last_fired` is in-process state and
    resets with the server: a window missed while the process was down is not
    replayed, which is the right call for a 7am briefing whose entire value was
    being on time.
    """
    now = time.time()
    fired: dict[str, str] = state.get("cron_last_fired", {})
    task = state.get("scheduler")

    schedules = []
    for s in policy().schedules:
        row = s.model_dump()
        row["next_fire"] = next_fire(s.cron, now)
        row["last_fired"] = fired.get(f"{s.cron}|{s.prompt}")
        schedules.append(row)

    return {
        "jobs": store().list_jobs(),
        "policy_schedules": schedules,
        "running": task is not None and not task.done(),
    }


@app.get("/api/rotator/status")
async def rotator_status() -> dict:
    return state["rotator"].status()


# ═══════════════════════════════════════════════════════════════════════════
# Agent registry & telemetry
# ═══════════════════════════════════════════════════════════════════════════


def _spawn(session_id: str, prompt: str, role: Role) -> dict:
    """
    Start an orchestrator run in the background and describe where to watch it.

    Every UI action that touches something irreversible goes through here rather
    than calling its tool directly. That indirection is the whole oversight claim:
    if the Send button reached the Twilio tool without passing the gate, the most
    common caller in the system would be the one exempt from it.
    """

    async def _run() -> None:
        try:
            await orch().run(session_id, prompt, role)
        except Exception as exc:
            broker().error(session_id, f"{type(exc).__name__}: {exc}")
            broker().done(session_id, "run failed")

    task = asyncio.create_task(_run())
    state.setdefault("tasks", set()).add(task)
    task.add_done_callback(lambda t: state["tasks"].discard(t))
    return {"ok": True, "session_id": session_id, "stream": f"/sse/{session_id}"}


@app.get("/api/agents/registry")
async def agents_registry(role: Role = Depends(current_role)) -> dict:
    """
    Every agent the policy knows about, whether it is switched on, and what it
    can actually do.

    `has_tools` is reported rather than hidden because a switched-on agent with no
    tool registered falls through `resolve_tool` to None and reports "unsupported"
    at dispatch — which reads as a bug. Surfacing it here makes the gap legible.
    `orchestrator` is the dispatcher rather than a dispatch target, so it is
    expected to have none.
    """
    from tools import AGENT_CAPABILITIES

    p = policy()
    yours = set(p.agents_for_role(role))
    agents = []
    for name in sorted(set(p.agent_permissions) | set(AGENT_CAPABILITIES)):
        caps = AGENT_CAPABILITIES.get(name, [])
        agents.append(
            {
                "name": name,
                "state": p.agent_permissions.get(name, "not declared"),
                "enabled": p.agent_permissions.get(name) == "enabled",
                "capabilities": caps,
                "gated_capabilities": sorted(c for c in caps if c in HALO_TRIGGERS),
                "granted_to_roles": sorted(
                    r for r, granted in p.role_permissions.items() if name in granted
                ),
                "available_to_you": name in yours,
                "has_tools": bool(caps),
                "dispatchable": name != "orchestrator" and bool(caps),
            }
        )
    return {"agents": agents, "your_role": role, "your_agents": sorted(yours)}


@app.get("/api/metrics")
async def metrics(window_hours: float = 24.0) -> dict:
    """
    Telemetry, derived on read from the audit log.

    There is not a single counter in this app. A metrics table would be a second
    source of truth about what the policy decided, and the audit log is the one
    that has to be authoritative — so if the two ever disagreed, the wrong one
    would be the one on screen.
    """
    data = store().metrics(window_hours=window_hours)
    sched = state.get("scheduler")
    data["rotator"] = state["rotator"].status()
    data["scheduler_running"] = sched is not None and not sched.done()
    data["uptime_seconds"] = round(time.time() - state["started"], 1)
    return data


@app.get("/api/health/probe")
async def health_probe() -> dict:
    """
    Process telemetry, reported by the process about itself.

    This exists instead of a `health` agent. An agent asked to report on its own
    liveness can only answer while it is alive, which makes the answer worthless
    in the one case it matters — so the endpoint reads real interpreter state and
    the agent stays disabled in .conca.

    `load` is a crude signal and is labelled as one: it counts in-flight runs and
    unanswered gates, the only two things that actually queue work here. It is
    *not* a CPU measurement and does not pretend to be — for that, see
    `/api/metrics/system`, which reads psutil.
    """
    inflight = len(state.get("tasks", set()))
    pending = len(gate().list_pending(None))
    sched = state.get("scheduler")

    if inflight >= 8 or pending >= 4:
        load = "strained"
    elif inflight >= 3 or pending >= 1:
        load = "busy"
    else:
        load = "idle"

    return {
        "load": load,
        "pid": os.getpid(),
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "uptime_seconds": round(time.time() - state["started"], 1),
        "threads": threading.active_count(),
        "runs_in_flight": inflight,
        "approvals_pending": pending,
        "scheduler_running": sched is not None and not sched.done(),
        "vector_memory": store().vec_enabled,
        "policy_version": policy().version,
        "agents_enabled": len(policy().enabled_agents()),
        "models_active": state["rotator"].status()["active_count"],
        "frontend_built": FRONTEND_DIST.is_dir(),
    }


@app.get("/api/metrics/system")
async def metrics_system(window_hours: float = 6.0) -> dict:
    """
    Real machine telemetry: a live reading plus the stored series.

    `available` is false — with everything else zero and `error` set — when psutil
    is not installed. Reported rather than raised: psutil is a convenience here,
    not a requirement, and a missing optional dependency should grey out one strip
    rather than 500 the panel it sits in.

    The series is what the sampler wrote on each scheduler tick; if the scheduler
    is disabled it is empty and only `current` has anything in it. That is stated
    in the response instead of being inferred from an empty array.
    """
    live = _read_system() or {}
    samples = store().list_system_samples(window_hours=window_hours)
    sched = state.get("scheduler")
    return {
        "available": bool(live),
        "error": None if live else "psutil is not installed",
        "current": live,
        "samples": samples,
        "window_hours": window_hours,
        # The sampler rides the scheduler loop, so this says whether the series
        # will keep growing — not merely whether cron jobs fire.
        "sampling": sched is not None and not sched.done(),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Policy editing
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/conca/raw")
async def conca_raw(role: Role = Depends(current_role)) -> dict:
    """
    The policy file as text, comments intact.

    The editor needs this because `.conca` cannot be reconstructed from
    `/api/conca/status`: that returns the *parsed* model, and serialising it back
    to YAML would silently discard every comment in the file — including the
    per-agent notes recording why `deploy`, `browser` and `chaos` are switched
    off. Losing the reason an agent is disabled is how it comes to be switched
    back on, so the editor round-trips the real text rather than a reconstruction.

    Staff only, matching the save route. The exact deny-list is not something a
    public caller needs the text of.
    """
    if role != "staff":
        raise HTTPException(403, "only staff may read the raw policy")

    target = Path(DEFAULT_POLICY_PATH)
    if not target.is_file():
        raise HTTPException(404, f"no policy file at {target}")

    text = target.read_text(encoding="utf-8")
    return {
        "content": text,
        "path": str(target),
        "bytes": len(text.encode("utf-8")),
    }


class PolicySaveRequest(BaseModel):
    content: str = Field(min_length=1)


@app.post("/api/conca/save")
async def conca_save(
    req: PolicySaveRequest, role: Role = Depends(current_role)
) -> dict:
    """
    Overwrite `.conca` from the UI, then hot-reload it.

    An HTTP route that rewrites the security policy is itself a
    privilege-escalation surface, so it is fenced rather than trusted: staff only,
    must parse, must validate, and must not disarm either path rule. A policy
    editor able to submit `off_limits: {}` would let one request switch the engine
    off and the next one delete anything — strictly worse than shipping no editor,
    which is why the README argued against having one at all.

    The previous file is kept as `.conca.bak` and the write is atomic via
    `os.replace`, so a failure mid-write cannot leave a truncated policy on disk —
    a half-written deny-list is the one corruption that fails *open*.
    """
    if role != "staff":
        raise HTTPException(403, "only staff may edit the policy")

    try:
        raw = yaml.safe_load(req.content)
    except yaml.YAMLError as exc:
        raise HTTPException(400, f"not valid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise HTTPException(400, "policy must be a mapping at the top level")

    if "off_limits_paths" in raw and "off_limits" not in raw:
        raw["off_limits"] = {"paths": raw.pop("off_limits_paths")}

    try:
        candidate = ConcaPolicy.model_validate(raw)
    except Exception as exc:
        raise HTTPException(400, f"policy failed validation: {exc}") from exc

    if not candidate.off_limits_paths:
        raise HTTPException(400, "refused: off_limits.paths would be empty")
    if not candidate.allowed_paths:
        raise HTTPException(
            400, "refused: allowed_paths would be empty, disabling deny-by-default"
        )

    target = Path(DEFAULT_POLICY_PATH)
    tmp = target.with_suffix(".tmp")
    try:
        if target.is_file():
            target.with_suffix(".bak").write_text(
                target.read_text(encoding="utf-8"), encoding="utf-8"
            )
        tmp.write_text(req.content, encoding="utf-8")
        os.replace(tmp, target)
    except OSError as exc:
        raise HTTPException(500, f"could not write policy: {exc}") from exc

    state["policy"] = candidate
    orch().reload_policy(candidate)
    store().log_audit(
        "policy-edit",
        "orchestrator",
        "conca_save",
        "executed",
        f"policy v{candidate.version} written by {role}",
    )
    return {
        "ok": True,
        "version": candidate.version,
        "agents_enabled": candidate.enabled_agents(),
        "backup": target.with_suffix(".bak").name,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Briefing & workflow detection
# ═══════════════════════════════════════════════════════════════════════════


@app.post("/api/briefing/run")
async def briefing_run(role: Role = Depends(current_role)) -> dict:
    """
    Run the morning briefing — the same thing the 7am `.conca` entry dispatches.

    Composed from what the caller's role actually grants rather than from a fixed
    script, so a student's briefing does not quietly ask for their email and then
    report a refusal as a result.
    """
    granted = set(policy().agents_for_role(role))
    wanted = [
        ("calendar", "today's and tomorrow's calendar"),
        ("email", "unread email that needs a reply"),
        ("sms", "unanswered messages"),
        ("news", "relevant headlines"),
        ("github", "repository and CI activity"),
    ]
    parts = [label for agent, label in wanted if agent in granted]
    if not parts:
        raise HTTPException(
            403, f'role "{role}" grants nothing a briefing could read'
        )

    prompt = "Give me a morning briefing covering " + ", ".join(parts) + "."
    session_id = store().create_session(
        role=role, prompt=prompt, title="morning briefing"
    )
    return _spawn(session_id, prompt, role) | {"covering": parts}


@app.get("/api/workflows/detected")
async def workflows_detected(limit: int = 400, min_occurrences: int = 3) -> dict:
    """
    Repetition worth automating, inferred from the audit log.

    Deliberately not a model call. The evidence for "you do this often" is the
    record of having done it, so this counts what happened rather than asking an
    LLM to imagine what someone might repeat — and every candidate carries its own
    occurrence count, so a suggestion can be checked instead of trusted.

    HALO-gated actions are excluded on principle. An unattended irreversible send
    is the exact failure the gate exists to prevent; a wizard offering to schedule
    one would be arguing against the rest of the system.

    Nothing here is armed. A suggestion becomes a schedule only when it is copied
    into `.conca`, which is the same file the scheduler reads.
    """
    rows = store().list_audit(limit=limit)

    buckets: dict[tuple[str, str], dict] = {}
    for r in rows:
        if r.get("decision") not in ("allowed", "executed"):
            continue
        ts = float(r.get("ts") or 0.0)
        key = (r.get("agent") or "unknown", r.get("action") or "unknown")
        b = buckets.setdefault(key, {"count": 0, "hours": [], "last_ts": 0.0})
        b["count"] += 1
        b["last_ts"] = max(b["last_ts"], ts)
        if ts:
            b["hours"].append(time.localtime(ts).tm_hour)

    already = {s.prompt for s in policy().schedules}
    now = time.time()
    candidates = []
    for (agent, action), b in sorted(
        buckets.items(), key=lambda kv: kv[1]["count"], reverse=True
    ):
        if b["count"] < min_occurrences or action in HALO_TRIGGERS:
            continue
        hour = max(set(b["hours"]), key=b["hours"].count) if b["hours"] else 8
        cron = f"0 {hour} * * *"
        prompt = f"Run the usual {action.replace('_', ' ')} via the {agent} agent"
        if prompt in already:
            continue
        candidates.append(
            {
                "agent": agent,
                "action": action,
                "occurrences": b["count"],
                "typical_hour": hour,
                "last_seen": time.strftime(
                    "%Y-%m-%dT%H:%M", time.localtime(b["last_ts"])
                )
                if b["last_ts"]
                else None,
                "suggested_cron": cron,
                "suggested_prompt": prompt,
                "next_fire_if_armed": next_fire(cron, now),
            }
        )

    return {
        "candidates": candidates,
        "scanned": len(rows),
        "min_occurrences": min_occurrences,
        # Always false, and not a placeholder: a suggestion is armed by editing
        # `.conca`, never from here. Detection that could also schedule itself
        # would make the policy file stop being the record of what runs.
        "armed": False,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Social
# ═══════════════════════════════════════════════════════════════════════════


def _require_agent(agent: str, role: Role, label: str) -> None:
    if agent not in policy().agents_for_role(role):
        raise HTTPException(403, f'role "{role}" has no {label} access under .conca')


@app.get("/api/social/posts")
async def social_posts(limit: int = 50, role: Role = Depends(current_role)) -> dict:
    """
    Everything the social agent has attempted, drafts and failures included.

    A panel that listed only successes would imply nothing had ever been refused,
    which is the opposite of what this app is trying to show.
    """
    _require_agent("social", role, "social")
    return {"posts": store().list_social_posts(limit=limit)}


class SocialPostRequest(BaseModel):
    platform: str = "mastodon"
    body: str = Field(min_length=1)


@app.post("/api/social/post")
async def social_post_route(
    req: SocialPostRequest, role: Role = Depends(current_role)
) -> dict:
    """Publish via the orchestrator, so the HALO gate applies. See `_spawn`."""
    _require_agent("social", role, "social")
    prompt = f"Post to {req.platform}: {req.body}"
    session_id = store().create_session(role=role, prompt=prompt, title="social post")
    return _spawn(session_id, prompt, role)


# ═══════════════════════════════════════════════════════════════════════════
# Browser
# ═══════════════════════════════════════════════════════════════════════════


class BrowseRequest(BaseModel):
    url: str = Field(min_length=1)
    shot: bool = True


@app.post("/api/browser/open")
async def browser_open(
    req: BrowseRequest, role: Role = Depends(current_role)
) -> dict:
    """
    Open a URL and return its text and a screenshot.

    Direct rather than orchestrated, on the same grounds as `/api/github/summary`:
    reading a page is read-only, and `check_url` has already refused loopback,
    private ranges, non-http schemes and anything in `.conca`'s
    `blocked_domains` before Chromium is asked for it. There is no write path here
    for the gate to interrupt.

    The screenshot is what makes this an in-app browser rather than a text
    extractor. An `<iframe>` cannot do this job: `X-Frame-Options: DENY` and
    `frame-ancestors 'none'` are set by most of the sites anyone would want to
    open, so an iframe-based viewer shows a blank box for exactly the pages that
    matter. Rendering server-side and shipping the pixels works on all of them,
    and has the side benefit that the page's JavaScript never runs in the
    operator's origin.
    """
    from tools import ExecContext, browse_page, screenshot_page

    _require_agent("browser", role, "browser")
    ctx = ExecContext(
        session_id="browser-open",
        role=role,
        policy=policy(),
        store=store(),
        broker=broker(),
    )

    read = await browse_page({"url": req.url}, ctx)
    if not req.shot or not read.get("ok"):
        return read

    # A failed screenshot must not lose the text that already succeeded — the
    # page is readable either way, and a viewport-sized capture is the garnish.
    shot = await screenshot_page({"url": req.url}, ctx)
    if shot.get("ok"):
        read["image"] = shot.get("image")
    else:
        read["image_error"] = shot.get("summary")
    return read


class BrowserActRequest(BaseModel):
    url: str = Field(min_length=1)
    steps: list[dict] = Field(min_length=1)


@app.post("/api/browser/act")
async def browser_act_route(
    req: BrowserActRequest, role: Role = Depends(current_role)
) -> dict:
    """
    Click or type in a page — through the orchestrator, so HALO applies.

    This is the one browser route that is *not* direct. `browser_act` is in
    HALO_TRIGGERS, and a direct call would run it without ever opening the gate,
    which is precisely the hole this app exists to close.

    The step values are redacted before being described. This route builds a
    *prompt*, and a prompt is stored as a session title, written to
    `context_entries` and embedded — so a card number typed into the browser panel
    would be retained here even though `browser_act` itself scrubs its output.
    """
    from tools import redact_secrets

    _require_agent("browser", role, "browser")
    described = "; ".join(
        f"{s.get('action')} {s.get('selector')}"
        + (f" = {redact_secrets(str(s.get('value')))[:40]}" if s.get("value") else "")
        for s in req.steps
    )
    return _spawn_prompt(
        f"Use browser_act on {req.url} with these steps: {described}", role
    )


# ═══════════════════════════════════════════════════════════════════════════
# GitHub
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/github/summary")
async def github_summary_route(repo: str, role: Role = Depends(current_role)) -> dict:
    """
    Repository telemetry. Called directly rather than through the orchestrator
    because it is strictly read-only — there is no write path in the tool, so
    there is nothing for the gate to interrupt.
    """
    from tools import ExecContext, github_summary

    _require_agent("github", role, "github")
    ctx = ExecContext(
        session_id="github-browse",
        role=role,
        policy=policy(),
        store=store(),
        broker=broker(),
    )
    return await github_summary({"repo": repo}, ctx)


# ═══════════════════════════════════════════════════════════════════════════
# Projects
# ═══════════════════════════════════════════════════════════════════════════


class ProjectRequest(BaseModel):
    name: str = Field(min_length=1)
    kind: Literal["python", "node", "web", "blank"] = "python"
    description: str = ""
    path: str | None = None


@app.post("/api/projects/create")
async def create_project(
    req: ProjectRequest, role: Role = Depends(current_role)
) -> dict:
    """
    Scaffold a project via the orchestrator, so `project_create` meets its gate.

    One gate covers the whole scaffold rather than one per file. N approvals for a
    single intended action trains people to click through them, which costs more
    safety than the extra prompts buy.
    """
    _require_agent("file", role, "file")
    where = f" under {req.path}" if req.path else ""
    detail = f" — {req.description}" if req.description else ""
    prompt = f"Create a new {req.kind} project called {req.name}{where}{detail}"
    session_id = store().create_session(
        role=role, prompt=prompt, title=f"scaffold {req.name}"
    )
    return _spawn(session_id, prompt, role)


# ═══════════════════════════════════════════════════════════════════════════
# Shopper
# ═══════════════════════════════════════════════════════════════════════════


def _shopper_ctx(role: Role, session_id: str = "shopper-read"):
    from tools import ExecContext

    return ExecContext(
        session_id=session_id,
        role=role,
        policy=policy(),
        store=store(),
        broker=broker(),
    )


@app.get("/api/shopper/orders")
async def shopper_orders(limit: int = 50, role: Role = Depends(current_role)) -> dict:
    """Every order the shopper has opened, including the ones still in a cart."""
    _require_agent("shopper", role, "shopper")
    return {
        "orders": store().list_orders(limit=limit),
        "open": store().open_orders(),
        "checkout_mode": policy().rules.checkout_mode,
        "can_spend": policy().security_overrides.financial_transactions,
    }


class ShopSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    budget: str = ""
    currency: str = "USD"
    limit: int = 6


@app.post("/api/shopper/search")
async def shopper_search(
    req: ShopSearchRequest, role: Role = Depends(current_role)
) -> dict:
    """
    Price a product across shops. Direct, because it is a read.

    Same reasoning as `/api/browser/open`: every URL it touches has been through
    `check_url`, nothing is clicked, and there is no write path for a gate to
    interrupt. Buying is `/api/shopper/checkout`, which is not direct.
    """
    _require_agent("shopper", role, "shopper")
    from tools import shop_search

    return await shop_search(
        {
            "query": req.query,
            "budget": req.budget or None,
            "currency": req.currency,
            "limit": req.limit,
        },
        _shopper_ctx(role),
    )


class ShopErrandRequest(BaseModel):
    """
    A whole errand in one sentence, plus the ceiling it has to fit inside.

    `items` is a list because the interesting version of this problem is more than
    one thing at once — a keyboard *and* a phone stand — where each is affordable
    alone and the pair might not be. `shop_compare` is what enforces the combined
    ceiling; this just gets the errand to it.
    """

    items: list[str] = Field(min_length=1)
    budget: str = ""
    currency: str = "USD"


@app.post("/api/shopper/errand")
async def shopper_errand(
    req: ShopErrandRequest, role: Role = Depends(current_role)
) -> dict:
    """Hand a full errand to the orchestrator so it plans the whole chain."""
    _require_agent("shopper", role, "shopper")
    listed = ", ".join(i.strip() for i in req.items if i.strip())
    ceiling = f" I have {req.budget} in total." if req.budget else ""
    prompt = (
        f"Shop for the best affordable {listed}.{ceiling} Search for each, compare "
        "them so the combined total fits the budget, load the cart, and then watch "
        "the order until it is delivered."
    )
    session_id = store().create_session(role=role, prompt=prompt, title=f"shop: {listed[:40]}")
    return _spawn(session_id, prompt, role)


class CardRequest(BaseModel):
    """
    Card details, for one checkout, held in RAM for three minutes.

    Its own request model and its own route rather than a field on the checkout
    request, because a tool payload is hashed into the audit table and echoed into
    the run summary. Nothing on this model is ever returned, logged or persisted —
    the response is brand and last four.
    """

    ref: str = Field(min_length=4, max_length=64)
    pan: str = Field(min_length=12, max_length=32)
    exp: str = ""
    cvc: str = ""
    name: str = ""
    postal: str = ""


@app.post("/api/shopper/secret")
async def shopper_secret(req: CardRequest, role: Role = Depends(current_role)) -> dict:
    """
    Accept a card for the next autonomous checkout. Staff only.

    Refuses outright unless the policy already permits spending, so the number
    cannot be collected "just in case" against a setting that is off. That ordering
    matters: a jar that accepts details it will never be allowed to use is a jar
    holding a card for no reason.

    Note what is *not* here. No `store()` call, no `log_audit`, no `ctx.note`, no
    SSE publish. `stash_card` returns brand and last four and that is the only
    thing this route has ever seen fit to speak about.
    """
    if role != "staff":
        raise HTTPException(403, "card entry is staff-only")
    _require_agent("shopper", role, "shopper")

    if not policy().security_overrides.financial_transactions:
        raise HTTPException(
            403,
            "financial_transactions is false in .conca, so nothing can be paid for "
            "and there is no reason to hold a card. Use checkout_mode: handoff — the "
            "agent fills the cart and you click pay.",
        )
    if policy().rules.checkout_mode != "autonomous":
        raise HTTPException(
            403,
            f'checkout_mode is "{policy().rules.checkout_mode}", which never types a '
            "card. Set it to autonomous first if that is really what you want.",
        )

    from tools import stash_card

    try:
        return stash_card(req.ref, req.model_dump(exclude={"ref"}))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


class CheckoutRequest(BaseModel):
    url: str = Field(min_length=1)
    item: str = ""
    total: float = 0.0
    currency: str = "USD"
    cart_url: str = ""
    card_ref: str = ""


@app.post("/api/shopper/checkout")
async def shopper_checkout(
    req: CheckoutRequest, role: Role = Depends(current_role)
) -> dict:
    """
    Buy — through the orchestrator, so `shop_checkout` meets its HALO gate.

    Never direct. `shop_checkout` is in HALO_TRIGGERS precisely because it is the
    one shopper action that spends money, and a route that called it directly would
    be a payment path with no human in it.

    `card_ref` is a handle, not a card. It travels in this prompt because it is
    meaningless on its own: the details it points at live in RAM for 180 seconds,
    are readable exactly once, and are gone before this prompt is embedded.
    """
    _require_agent("shopper", role, "shopper")
    what = req.item or req.url
    prompt = (
        f"Check out {what} at {req.url} for {req.currency} {req.total:,.2f}"
        + (f", cart at {req.cart_url}" if req.cart_url else "")
        + (f", card_ref {req.card_ref}" if req.card_ref else "")
    )
    session_id = store().create_session(role=role, prompt=prompt, title=f"buy {what[:40]}")
    return _spawn(session_id, prompt, role)


@app.post("/api/shopper/track")
async def shopper_track(
    order_id: str = Body("", embed=True), role: Role = Depends(current_role)
) -> dict:
    """
    Re-read an order now instead of waiting for the cron tick. Direct: a read.

    With no `order_id` this sweeps everything open, which is the same call the
    `*/26 * * * *` schedule makes.
    """
    _require_agent("shopper", role, "shopper")
    from tools import order_track

    return await order_track({"order_id": order_id} if order_id else {}, _shopper_ctx(role))


# ═══════════════════════════════════════════════════════════════════════════
# Market
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/market/quote")
async def market_quote(symbols: str, role: Role = Depends(current_role)) -> dict:
    """Live prices. Read-only and keyless, so direct."""
    _require_agent("market", role, "market")
    from tools import quote

    return await quote({"symbols": symbols}, _shopper_ctx(role, "market-read"))


@app.get("/api/market/chart")
async def market_chart(symbol: str, range: str = "1mo", interval: str = "1d", role: Role = Depends(current_role)) -> dict:
    """Historical chart data."""
    _require_agent("market", role, "market")
    import httpx
    import urllib.parse
    headers = {"User-Agent": "Mozilla/5.0"}
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol.upper())}?range={range}&interval={interval}",
            headers=headers
        )
        if res.status_code == 200:
            return {"ok": True, "chart": res.json()}
        return {"ok": False, "summary": f"Failed to fetch chart: {res.status_code}"}


@app.get("/api/market/fundamentals")
async def market_fundamentals(symbol: str, role: Role = Depends(current_role)) -> dict:
    _require_agent("market", role, "market")
    from tools import fundamentals

    return await fundamentals({"symbol": symbol}, _shopper_ctx(role, "market-read"))


@app.get("/api/market/portfolio")
async def market_portfolio(role: Role = Depends(current_role)) -> dict:
    """The paper book, marked to market."""
    _require_agent("market", role, "market")
    from tools import portfolio

    return await portfolio({}, _shopper_ctx(role, "market-read"))


class TradeRequest(BaseModel):
    symbol: str = Field(min_length=1)
    side: Literal["buy", "sell"] = "buy"
    qty: float = Field(gt=0)
    note: str = ""


@app.post("/api/market/trade")
async def market_trade(req: TradeRequest, role: Role = Depends(current_role)) -> dict:
    """
    Record a simulated fill. Direct, and deliberately ungated.

    There is no brokerage wired and no venue to reach, so this writes a row to a
    local SQLite table and nothing else. Sending it through HALO would put a gate in
    front of an action that cannot lose anything — and every gate answered out of
    habit makes the gates on `shop_checkout` and `chain_prepare_tx` worth less.
    """
    _require_agent("market", role, "market")
    from tools import paper_trade

    return await paper_trade(req.model_dump(), _shopper_ctx(role, "market-trade"))


# ═══════════════════════════════════════════════════════════════════════════
# Chain (Solana)
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/api/chain/balances")
async def chain_balances(address: str, role: Role = Depends(current_role)) -> dict:
    """Balances for a public Solana address. Read-only, keyless, direct."""
    _require_agent("chain", role, "chain")
    from tools import wallet_balances

    return await wallet_balances({"address": address}, _shopper_ctx(role, "chain-read"))


@app.get("/api/chain/history")
async def chain_history_route(
    address: str, limit: int = 15, role: Role = Depends(current_role)
) -> dict:
    _require_agent("chain", role, "chain")
    from tools import chain_history

    return await chain_history(
        {"address": address, "limit": limit}, _shopper_ctx(role, "chain-read")
    )


class PrepareTxRequest(BaseModel):
    to: str = Field(min_length=32, max_length=64)
    amount: float = Field(gt=0)
    sender: str = ""
    memo: str = ""


@app.post("/api/chain/prepare")
async def chain_prepare(
    req: PrepareTxRequest, role: Role = Depends(current_role)
) -> dict:
    """
    Build an unsigned transfer — through the orchestrator, so HALO applies.

    The transaction this produces is unsigned and this process holds no key, so it
    cannot move funds by itself. It is gated anyway, because the thing a human needs
    to check is the recipient: a Solana transfer to the wrong address is final, and
    the moment to catch that is before a wallet is opened, not after.

    The field length bounds are not cosmetic. A Solana address is 32 bytes in base58
    — 43 or 44 characters — while a secret key is 64 bytes and 87 or 88. Capping at
    64 means a pasted secret key is rejected by the request model before any handler
    sees it, on top of `_looks_like_secret` in the tool.
    """
    _require_agent("chain", role, "chain")
    prompt = (
        f"Prepare an unsigned Solana transfer of {req.amount:g} SOL to {req.to}"
        + (f" from {req.sender}" if req.sender else "")
        + (f' with memo "{req.memo}"' if req.memo else "")
    )
    session_id = store().create_session(role=role, prompt=prompt, title="prepare transfer")
    return _spawn(session_id, prompt, role)


# ═══════════════════════════════════════════════════════════════════════════
# Voice — speech into the prompt box
# ═══════════════════════════════════════════════════════════════════════════

# Groq's transcription endpoint is OpenAI-shaped, and `GROQ_API_KEY` is already in
# `.env` and already read by five ladder slots — so this is a new capability on an
# existing credential rather than a new thing to provision.
_WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

# Turbo first, the full model as a fallback. Which of the two names a given account
# can reach is exactly the sort of thing I could not check from here, and the
# rotator's design argument applies unchanged: an unverified model ID should cost
# one attempt and a fall-through, not a dead feature.
_WHISPER_MODELS = ("whisper-large-v3-turbo", "whisper-large-v3")

# Groq's own upload ceiling, enforced here as well so an oversized clip fails
# locally with a sentence about it instead of spending a round trip to be told the
# same thing less clearly.
MAX_AUDIO_BYTES = 25 * 1024 * 1024

# Domain words Whisper has no reason to know. A short prompt biases the decoder
# without constraining it; without one, "Concaretti" comes back as "concert eddy"
# and every transcript needs hand-fixing before it can be sent.
_WHISPER_HINT = (
    "Concaretti, HALO, .conca policy, orchestrator, subtask, shopper, "
    "portfolio, fundamentals, Solana, naira."
)


def _voice_ready() -> bool:
    """
    Whether transcription can work at all.

    Read at request time rather than captured at import, so adding the key to
    `.env` and restarting is the whole setup — and so this cannot disagree with
    what the transcribe route will actually find a moment later.
    """
    return bool(os.getenv("GROQ_API_KEY", "").strip())


@app.post("/api/voice/transcribe")
async def voice_transcribe(
    audio: UploadFile = File(...), role: Role = Depends(current_role)
) -> dict:
    """
    Turn a recording into text. Returns the text; does not run it.

    The audio is read into memory, forwarded, and dropped. It is never written to
    disk, never stored in SQLite, never embedded — there is no path here that
    could persist it, which is a stronger statement than a cleanup step.

    The transcript comes back to the composer for the user to read and send. It
    does not auto-run, and that is the deliberate part: a misheard prompt that
    executes itself is precisely the wrong failure mode for a system whose whole
    argument is that consequential actions stop for a human. Whisper mishears.

    503 rather than a silent stub when the key is absent, because the client uses
    `voice` on `/api/auth/me` to hide the mic and a 503 here is the backstop for
    the race where the key was removed after the page loaded.
    """
    if not _voice_ready():
        raise HTTPException(
            503,
            "voice input needs GROQ_API_KEY in backend/.env — the same key the "
            "model ladder already uses. Type the prompt instead.",
        )

    data = await audio.read()
    if not data:
        raise HTTPException(400, "the recording was empty")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(
            413,
            f"{len(data) // 1_048_576} MB of audio; the ceiling is "
            f"{MAX_AUDIO_BYTES // 1_048_576} MB. Record a shorter clip.",
        )

    key = os.getenv("GROQ_API_KEY", "").strip()
    name = audio.filename or "speech.webm"
    mime = audio.content_type or "audio/webm"

    last = ""
    for model in _WHISPER_MODELS:
        try:
            async with httpx.AsyncClient(timeout=90.0) as client:
                resp = await client.post(
                    _WHISPER_URL,
                    headers={"Authorization": f"Bearer {key}"},
                    files={"file": (name, data, mime)},
                    data={
                        "model": model,
                        "response_format": "json",
                        "temperature": "0",
                        "prompt": _WHISPER_HINT,
                    },
                )
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
            continue

        if resp.status_code == 200:
            text = str((resp.json() or {}).get("text") or "").strip()
            # Size and role, never the transcript. The words become a prompt only
            # if the user sends them, and logging text they chose not to send
            # would record a thought they withdrew.
            store().log_audit(
                "voice",
                "orchestrator",
                "voice_transcribe",
                "executed",
                f"{len(data) // 1024} KB from {role} via {model}",
            )
            return {"ok": True, "text": text, "model": model}

        last = f"{resp.status_code} {resp.text[:200]}"
        # A rejected model name is worth retrying under the other name. A rejected
        # key or a spent quota is not, and retrying would only double the wait
        # before saying the same thing.
        if resp.status_code not in (400, 404):
            break

    raise HTTPException(502, f"transcription failed: {last}")


# ═══════════════════════════════════════════════════════════════════════════
# Desktop overlay
# ═══════════════════════════════════════════════════════════════════════════


class CaptureRequest(BaseModel):
    #: Base64 PNG from the Tauri `capture_screen()` command. A `data:` prefix is
    #: tolerated so the overlay can post the same string it renders in an `<img>`.
    image_b64: str = Field(min_length=32)
    question: str = ""
    mime_type: str = "image/png"


@app.get("/api/desktop/capture")
async def desktop_capture_status(
    request: Request, role: Role = Depends(current_role)
) -> dict:
    """
    What the overlay needs to know before it offers the shortcut at all.

    Reported rather than inferred, so the overlay can grey the button out and say
    why instead of capturing a frame and discovering on POST that the policy
    forbids it — which would mean pixels were read before the refusal.
    """
    from tools import SCREEN_TTL, screen_mode

    mode = screen_mode(policy())
    return {
        "mode": mode,
        "available": mode != "off" and "desktop" in policy().agents_for_role(role),
        "gated": requires_halo(policy(), "screen_capture"),
        "local": is_local(request),
        "granted": "desktop" in policy().agents_for_role(role),
        "ttl_seconds": int(SCREEN_TTL),
    }


@app.post("/api/desktop/capture")
async def desktop_capture(
    req: CaptureRequest, request: Request, role: Role = Depends(current_role)
) -> dict:
    """
    Hand a captured frame to the council — through the orchestrator, so the gate
    applies.

    The pixels stop here. `stash_screen` puts them in a RAM-only jar under a random
    handle and returns a byte count; the prompt that goes on to the planner carries
    the handle. That is what keeps a screenshot of the operator's desktop out of the
    transcript, the embedding index and the SSE replay buffer, all three of which
    the prompt itself lands in verbatim.

    Loopback-only, for a different reason than the setup routes. There, the argument
    is that writing `.env` is safe in the hands of whoever owns the filesystem. Here
    it is that the *only* legitimate caller is a Tauri process on this machine
    photographing this machine's display — a frame arriving over the network is by
    definition not that, so there is nothing to serve by accepting one.

    `off` refuses here, before `_spawn`, and refuses again inside the tool. Two
    checks rather than one because a gate cannot express "never": if this route
    orchestrated the request anyway, the operator would be shown an approval card
    for an action that was already forbidden, and approving it would still fail.
    """
    from tools import screen_mode, stash_screen

    require_local(request)
    _require_agent("desktop", role, "desktop overlay")

    mode = screen_mode(policy())
    if mode == "off":
        raise HTTPException(
            403,
            "`rules.screen_capture` is `off` in backend/.conca, so the screen is not "
            "read. Set it to `ask` to allow captures with an approval each time, or "
            "`on` to allow them without one.",
        )

    ref = f"cap_{secrets.token_urlsafe(12)}"
    try:
        receipt = stash_screen(ref, req.image_b64, req.mime_type)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    question = req.question.strip() or "Describe what is on my screen."
    prompt = f"Look at my screen and answer: {question} (capture_ref {ref})"
    session_id = store().create_session(
        role=role, prompt=prompt, title="read the screen"
    )
    return {**_spawn(session_id, prompt, role), **receipt, "mode": mode}


# ═══════════════════════════════════════════════════════════════════════════
# Connecting accounts
# ═══════════════════════════════════════════════════════════════════════════


class IntegrationsRequest(BaseModel):
    #: Key → value. An empty value disconnects that key.
    values: dict[str, str] = Field(default_factory=dict)


@app.get("/api/setup/integrations")
async def setup_integrations(
    request: Request, role: Role = Depends(current_role)
) -> dict:
    """
    What is connected, and what could be. Never any secret values.

    Local and staff both, which on a loopback caller is the same condition twice —
    the belt is `require_local` and the braces are the role, so stepping down to
    preview the student surface also closes this page, as it should.
    """
    require_local(request)
    if role not in ("staff", "student"):
        raise HTTPException(403, "only operators may read the integration list")
    return {
        **envfile.status(),
        # Reported alongside so the UI can show the ladder growing as keys land,
        # which is the only honest confirmation available without spending a call
        # on a live probe.
        "models_active": state["rotator"].status()["active_count"],
        "models_total": state["rotator"].status()["ladder_size"],
    }


@app.post("/api/setup/integrations")
async def setup_integrations_save(
    req: IntegrationsRequest, request: Request, role: Role = Depends(current_role)
) -> dict:
    """
    Write credentials into `.env` and into the live environment.

    The audit entry records **key names only**. A credential in the audit log is
    the same leak as a credential in a model prompt, arriving by a duller route,
    and the log is the one place in this system that is meant to be readable
    forever.
    """
    require_local(request)
    if role != "staff":
        raise HTTPException(403, "only staff may connect accounts")
    try:
        result = envfile.apply(req.values)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(500, f"could not write .env: {exc}") from exc

    store().log_audit(
        "setup",
        "orchestrator",
        "connect_accounts",
        "executed",
        f"updated {len(result['changed'])} key(s): {', '.join(result['changed'])}",
    )
    status = state["rotator"].status()
    return {
        "ok": True,
        **result,
        **envfile.status(),
        "models_active": status["active_count"],
        "models_total": status["ladder_size"],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Static frontend — mounted last so /api and /sse win
# ═══════════════════════════════════════════════════════════════════════════

if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
else:

    @app.get("/")
    async def no_frontend() -> dict:
        return {
            "message": "Concaretti-Light API is running; the frontend is not built.",
            "build_it": "cd frontend && pnpm install && pnpm build",
            "api_docs": "/docs",
        }
