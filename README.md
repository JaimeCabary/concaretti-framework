# Concaretti-Light

Concurrent agentic reasoning, execution and trust infrastructure. One FastAPI
process, one SQLite file, one React PWA. No Docker, no Redis, no Postgres, no
Electron.

The claim this codebase exists to demonstrate: **a stochastic model can produce
any plan it likes, and a deterministic policy layer decides what actually runs.**
Everything else is in service of making that visible.

---

## Run it

Two terminals. Backend first.

```bash
cd backend
uv sync                                    # creates .venv, installs deps
uv run pytest -v                           # 73 tests, all on the security engine
uv run uvicorn main:app --reload --port 8000
```

```bash
cd frontend
pnpm install
pnpm dev                                   # http://localhost:5173
```

The dev server proxies `/api` and `/sse` to port 8000, so the app uses the same
relative paths in development and production.

No API keys are needed. Without them the model rotator falls through to a
deterministic stub planner and every screen still works — that fallback exists
precisely so a demo cannot fail for want of a network.

### Serving as one process

```bash
cd frontend && pnpm build         # emits frontend/dist
cd ../backend && uv run uvicorn main:app --port 8000
```

FastAPI mounts `frontend/dist` at `/`, so [http://localhost:8000](http://localhost:8000) serves the
whole app — API, event stream and UI from a single process. That is the shape the
desktop and mobile wrappers point at; see [WRAPPERS.md](WRAPPERS.md), which are
scaffolded but not yet built.

### Optional credentials

Two ways in, writing the same file:

- **Staff → Setup**, which is also the last step of first-run onboarding. Grouped
  by what each account unlocks, with a masked tail beside anything already stored.
  Values are write-only — the server reports *that* a key is set and never sends it
  back, so the browser is never holding your credentials. Clearing a field
  disconnects it. Everything takes effect on the next request without a restart,
  because the modules that need a key read the environment at call time.
- **`backend/.env` by hand.** Copy `backend/.env.example` and fill in what you
  have; each key unlocks one capability and is independently optional, and the file
  documents which. The Setup page is line-oriented and rewrites keys in place, so
  your comments survive a save from the UI.

The page is loopback-only. It writes a file and names an interpreter's worth of
process environment, so it is restricted to the machine running the server — a
phone pointed at this port over the LAN is not offered it.

`CONCA_SECRET` is worth setting even locally — without it a random signing key is
generated per start, so role cookies are invalidated on every restart. It is also
the one key read at import rather than at call time, so it is the one that needs a
restart; the Setup page says so when you set it.

---

## The four things to demonstrate

**1. The `.conca` policy refuses what the model asked for.**
Staff → Policy tab. Paste an obfuscated command into the simulator and watch nine
normalisation stages collapse it before the verdict. `\x72\x6d -rf /finance`,
`r=rm; $r -rf ~/.ssh` and `ls && rm -rf /private` all reduce to the same
destructive payload and all get refused. Nothing is executed to produce that
answer.

Then try it end-to-end: ask the council to *"delete everything in
C:\Windows\System32"*. The plan is produced, the check runs between plan and
execution, and the subtask lands as **Refused** with the policy's reason
attached — not dropped, so the decision is auditable.

**2. HALO pauses before anything irreversible.**
Staff → Email. Draft a reply and press Send. The orchestrator suspends; the gate
opens with 2–3 options the model wrote for *this specific action*, plus a
free-text box. A condition typed there ("yes, but check the address first") can
inject a helper step before the send proceeds. Walk away and it refuses on
timeout — fail-closed, with the countdown visible so that isn't a surprise.

Sending from the UI is routed through the orchestrator rather than posted to a
send endpoint. That indirection is the point: a UI path that called the tool
directly would make the oversight claim false for the most common caller.

**3. Rule 0 — therapy content is never vectorised and never recalled.**
Submit something in emotional distress. The composer says so explicitly. The
transcript keeps it; the vector index never sees it. Then search the same words
in the Recall panel: it reports **Excluded by Rule 0** rather than an empty
result, because "no matches" and "we refuse to search this" are different claims.

**4. The model rotator survives quota exhaustion.**
Staff → Policy shows the current rung, how many of the ladder remain, and what
has been exhausted this session. A 429 marks that entry dead for the session and
rotates on — free tiers before paid, deterministic stub last.

---

## Layout

```
backend/
  security.py    .conca policy model + ShellNormalizer — the thesis core
  memory.py      SQLite + sqlite-vec, Rule-0 exclusion, sliding context window
  rotator.py     ModelRotator V11 port: ~30-entry ladder + DeterministicStub
  halo.py        the approval gate
  agents.py      orchestrator: decompose → screen → layered execute → synthesise
  tools.py       one async function per capability, re-checked at the boundary
  sse.py         per-session fan-out with history replay
  auth.py        HMAC-signed role cookie
  main.py        routes + static mount
  .conca         the policy. Edit this file; POST /api/conca/reload picks it up.
  tests/         security engine, one test per documented strategy

frontend/src/
  store/agentStore.ts   role, live run, SSE reducers (replay-idempotent)
  components/           shared panels + the six feature panels
  screens/              Public | Student | Staff
```

### Reading order

`security.py` first — it is the smallest file that contains the whole argument.
Then `agents.py:_conca_screen` for where the check sits relative to the model,
and `halo.py:request_approval` for the suspension. The frontend is downstream of
all three.

---

## Roles

Three role-scoped products over one backend, not three pages of one site.

|                     | Public          | Student                                                  | Staff                                                                     |
| ------------------- | --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Agents (`.conca`) | research        | + file, scheduler, calendar, therapy, news, browser, market | + email, sms, github, social, shopper, chain                              |
| Reasoning trace     | indicator only  | collapsed, no model internals                            | full, with model + tier per step                                          |
| Orchestration plan  | —              | —                                                       | layered, refusals visible                                                 |
| HALO surface        | none            | low-risk                                                 | full                                                                      |
| Panels              | chat, artifacts | timetable, recall, market                                | calendar, email, telecom, browser, shopper, market, chain, diary, policy, setup |

There is no login, no password and no PIN. **Authorisation is not stubbed** — every
`/api/*` request re-derives the role server-side and filters against `.conca`; the
frontend mirrors the scoping for layout and is never trusted for it. What is absent
is *authentication*, deliberately:

- A caller on the **loopback interface is staff outright.** Whoever is sitting at
  this machine already owns `.conca`, `.env` and the SQLite file and can grant
  themselves anything with a text editor, so a secret asked of them protects
  nothing. There used to be a council PIN here, and it was theatre: the login
  endpoint beside it would mint a staff cookie for anyone who asked, so the PIN was
  a locked door standing next to an open one.
- A caller from **any other host** gets `CONCA_OPEN_ROLE` — `public` unless you
  widen it — and cannot escalate. `POST /api/auth/login` and the setup routes are
  refused off-loopback, so there is no path from `public` to `staff` over the
  network. `X-Forwarded-For` is ignored rather than parsed, because it is set by
  the caller and trusting it would hand out the local role to anyone who adds a
  header.
- The cookie is checked **first**, so a deliberate step *down* — previewing the
  student or public surface — still wins over the ambient default.

---

## Deliberate omissions

Worth stating, because each looks like an oversight and isn't:

- **No node-graph DAG view.** At four to six subtasks an ordered list with layer
  grouping communicates more than a graph, for a fraction of the effort.
- **`.conca` editing is fenced rather than free.** Staff → Policy has an editor,
  but it is staff-only, validated before it is written, and it refuses any policy
  that would empty `off_limits.paths` or `allowed_paths`. An editor able to disarm
  the engine in one request would be worse than no editor at all. The previous
  file is kept as `.conca.bak` and the write goes through `os.replace`, because a
  half-written deny-list is the one corruption that fails *open*. The textarea
  loads `GET /api/conca/raw` — the real file text — rather than re-serialising the
  parsed policy, which would drop the comments recording why each disabled agent
  is disabled.
- **No Ollama rung in the rotator.** The original declared and health-checked one
  but registered zero models against it, so it was a fallback that could never
  fire. A `DeterministicStub` terminal tier does the job it was meant to.
- **Service worker uses runtime caching, not a precache manifest.** Hashed asset
  names aren't knowable at author time without a manifest plugin. First load must
  be online; every load after works offline.
- **No ADK.** It wants to own the reason-act loop, and the security claim depends
  on a deterministic checkpoint *between* plan and execution. The six-provider
  rotator would also have needed a custom `BaseLlm`.

Of the original 24 screens, ten were cut. Eight have since been rebuilt **as far as
the API only** — each has a working endpoint and no UI yet:

| Screen                    | Endpoint                                             |
| ------------------------- | ---------------------------------------------------- |
| Metrics & Telemetry       | `GET /api/metrics`                                 |
| Agent Explorer            | `GET /api/agents/registry`                         |
| Health Monitor            | `GET /api/health/probe`                            |
| Morning Briefing          | `POST /api/briefing/run`                           |
| Workflow Detection Wizard | `GET /api/workflows/detected`                      |
| Social Manager            | `GET /api/social/posts`, `POST /api/social/post` |
| GitHub Intelligence       | `GET /api/github/summary`                          |
| Project Creator           | `POST /api/projects/create`                        |

The ninth was a **Council PIN Gate**, and it is gone rather than pending: see
*Roles* for why a secret asked of someone who already owns the config file is not a
security boundary. `GET`/`POST /api/setup/integrations` took its place in the UI —
onboarding now ends by connecting accounts instead of by asking for a password, and
that is the trade the whole change is about.

Anything that writes or publishes on the list above — social, projects — is routed
through the orchestrator rather than calling its tool directly, so it meets the same
gate a model-initiated action would.
