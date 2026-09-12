/**
 * Shared types, mirroring the backend's wire shapes.
 *
 * Hand-written rather than generated: the surface is small, and a generator
 * would be another build step to keep alive for the sake of a couple of dozen
 * interfaces. Each block names the `backend/` source it mirrors so the two can
 * be diffed by eye when either changes.
 */

export type Role = "public" | "student" | "staff";

// ── agents.py ──────────────────────────────────────────────────────────────

export type SubtaskStatus =
  "pending" | "running" | "done" | "failed" | "skipped" | "rejected";

export interface Subtask {
  id: string;
  agent: string;
  task_type: string;
  description: string;
  layer: number;
  payload: Record<string, unknown>;
  status: SubtaskStatus;
  result: string;
  error: string;
  model_used: string;
  blocked_reason: string;
}

// ── halo.py ────────────────────────────────────────────────────────────────

export interface HaloOption {
  label: string;
  approves: boolean;
  note: string;
}

export interface HaloRequest {
  id: string;
  session_id: string;
  agent: string;
  action: string;
  details: string;
  options: HaloOption[];
  created_at: number;
  status: string;
  /** Which rung of the rotator wrote these options, or a stub marker. */
  generated_by: string;
}

export interface HaloResolved {
  id: string;
  approved: boolean;
  reason: string;
  chosen?: string;
  injection?: { agent: string; task: string; result: string };
}

// ── sse.py ─────────────────────────────────────────────────────────────────

export type SseEventType =
  | "activity"
  | "thought"
  | "subtask_update"
  | "halo_request"
  | "halo_resolved"
  | "artifact"
  | "error"
  | "token"
  | "done";

export interface ClientContext {
  timezone: string;
  local_time: string;
  locale: string;
  city?: string;
}

/**
 * Every frame carries `ts` and `session_id`; the rest depends on the type.
 * Kept as one loose interface rather than a discriminated union because the
 * broker's `**extra` kwargs mean the payload is genuinely open-ended.
 */
export interface SseEvent {
  type: SseEventType;
  ts: number;
  session_id: string;
  /** activity, error */
  message?: string;
  /** thought */
  text?: string;
  model?: string;
  tier?: string;
  /**
   * Present on the per-subtask thought frames, absent on the orchestrator's own
   * (decomposition, synthesis) — those belong to no single agent, so a step with
   * no agent is colourless rather than mis-attributed.
   */
  agent?: string;
  /** done */
  summary?: string;
  [key: string]: unknown;
}

// ── memory.py ──────────────────────────────────────────────────────────────

export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  preview?: string;
  content?: string;
  path?: string;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  agent?: string;
  status?: "running" | "done" | "error";
  thoughts?: SseEvent[];
  subtasks?: Subtask[];
  artifacts?: Artifact[];
  attachments?: AttachedFile[];
}

export interface Artifact {
  id: string;
  session_id: string;
  filename: string;
  mime: string;
  path: string;
  sha256: string;
  prompt: string;
  ts: number;
}

export interface SessionSummary {
  id: string;
  created_at: number;
  role: string | null;
  title: string;
  summary: string;
  is_temporary?: boolean | number;
  expires_at?: number | null;
}

export interface ContextEntry {
  role: string;
  content: string;
  agent: string | null;
  ts: number;
  /** 1 when Rule-0 matched: stored in the transcript, never vectorised. */
  sensitive: number;
}

export interface SessionDetail {
  session_id: string;
  entries: ContextEntry[];
  artifacts: Artifact[];
}

export interface RecallHit {
  session_id: string;
  role: string;
  agent: string | null;
  content: string;
  ts: number;
  distance: number | null;
}

export interface RecallResponse {
  hits: RecallHit[];
  /** True when the query itself tripped Rule 0 — no search was performed. */
  excluded: boolean;
  reason?: string;
  backend?: "sqlite-vec" | "lexical-fallback";
}

export interface AuditEntry {
  id: number;
  session_id: string | null;
  agent: string;
  action: string;
  decision: string;
  reason: string;
  payload_hash: string;
  ts: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start_ts: number;
  end_ts: number;
  description: string;
  kind: "event" | "exam" | "deadline" | "revision" | (string & {});
  source: string;
}

export interface SmsMessage {
  id: string;
  direction: "inbound" | "outbound";
  peer: string;
  body: string;
  ts: number;
  status: string;
  pending_approval: number;
  /** `"call"` rows hold the spoken script in `body`. Older rows predate the
   *  column and arrive undefined, so treat a missing value as `"sms"`. */
  kind?: "sms" | "call";
}

export interface SmsThread {
  peer: string;
  messages: SmsMessage[];
  last_ts: number;
}

export interface DiaryEntry {
  id: string;
  day: string;
  summary: string;
  reflection: string;
  agent_assisted: number;
  ts: number;
}

export interface ScheduledJob {
  id: string;
  cron: string;
  prompt: string;
  enabled: number;
  last_run: number | null;
}

// ── tools.py ───────────────────────────────────────────────────────────────

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread?: boolean;
}

// ── security.py / main.py ──────────────────────────────────────────────────

export interface ConcaStatus {
  version: number;
  security_overrides: Record<string, unknown>;
  agent_permissions: Record<string, string>;
  agents_enabled: string[];
  agents_for_your_role: string[];
  role: Role;
  off_limits_paths: string[];
  allowed_paths: string[];
  rules: Record<string, unknown>;
  connectors: Array<Record<string, unknown>>;
  schedules: Array<Record<string, unknown>>;
  halo_triggers: string[];
  policy_path: string;
}

/** Output of the dry-run defence endpoint. Nothing is executed to produce it. */
export interface SimulateResult {
  input: string;
  normalized: string;
  segments: string[];
  destructive: boolean;
  destructive_verb: string;
  allowed: boolean;
  reason: string;
}

export interface RotatorStatus {
  current: string;
  current_provider: string;
  ladder_size: number;
  active_count: number;
  providers_available: string[];
  exhausted: string[];
  live_provider_configured: boolean;
}

export interface HealthStatus {
  status: string;
  policy_loaded: boolean;
  policy_version: number;
  agents_enabled: string[];
  models_active: number;
  live_provider: boolean;
  vector_memory: boolean;
  frontend_built: boolean;
  uptime_seconds: number;
}

/**
 * What every write-path endpoint returns.
 *
 * None of them return a result, deliberately: the action they trigger goes
 * through the orchestrator and may be suspended at the HALO gate, so there is
 * nothing to report synchronously. The caller subscribes to `stream` and watches.
 */
export interface SpawnResult {
  ok: boolean;
  session_id: string;
  stream: string;
}

// ── main.py: agent explorer ────────────────────────────────────────────────

export interface AgentRegistryEntry {
  name: string;
  /** Raw `.conca` value: 'enabled' | 'disabled' | 'not declared'. */
  state: string;
  enabled: boolean;
  capabilities: string[];
  /** The subset of `capabilities` that sits in HALO_TRIGGERS. */
  gated_capabilities: string[];
  granted_to_roles: string[];
  available_to_you: boolean;
  /**
   * False when the policy names an agent but no tool is registered for it.
   * Surfaced rather than hidden: such an agent falls through `resolve_tool` and
   * reports "unsupported" at dispatch, which reads as a bug unless the gap is
   * visible. `orchestrator` dispatches rather than being dispatched to, so it is
   * expected to have none.
   */
  has_tools: boolean;
  dispatchable: boolean;
}

export interface AgentRegistry {
  agents: AgentRegistryEntry[];
  your_role: Role;
  your_agents: string[];
}

// ── main.py + memory.py: metrics ───────────────────────────────────────────

export interface AgentMetric {
  agent: string;
  calls: number;
  refusals: number;
}

/**
 * All of this is derived from the audit log on read — there is no counter and no
 * metrics table anywhere in the backend. A second store would be a second source
 * of truth about what the policy decided, and if the two disagreed the wrong one
 * would be the one on screen.
 */
export interface Metrics {
  window_hours: number;
  sessions_total: number;
  sessions_window: number;
  actions_window: number;
  /** Keyed by audit decision — allowed, executed, blocked, refused, deferred. */
  decisions: Record<string, number>;
  refusal_rate: number;
  by_agent: AgentMetric[];
  artifacts_total: number;
  entries_total: number;
  /** Rule-0 count: kept in the transcript, never vectorised. */
  rule0_excluded: number;
  vectorised: number;
  sms_total: number;
  events_total: number;
  social_total: number;
  /**
   * Distinct clock hours in which a human typed, versus hours in which an agent
   * acted. Counted from rows that already exist, not timed — see
   * `MemoryStore._attention_hours` for why that is the honest reading.
   * `delegated_hours` is the swarm hours with no human hour beside them: work
   * that happened while nobody was at the keyboard.
   */
  human_hours: number;
  swarm_hours: number;
  delegated_hours: number;
  rotator: RotatorStatus;
  scheduler_running: boolean;
  uptime_seconds: number;
}

// ── main.py: health probe ──────────────────────────────────────────────────

export interface HealthProbe {
  /**
   * In-flight runs and unanswered gates, the only two things that queue work
   * here. Not a CPU measurement and not presented as one.
   */
  load: "idle" | "busy" | "strained";
  pid: number;
  python: string;
  platform: string;
  uptime_seconds: number;
  threads: number;
  runs_in_flight: number;
  approvals_pending: number;
  scheduler_running: boolean;
  vector_memory: boolean;
  policy_version: number;
  /** A count here, unlike `HealthStatus.agents_enabled`, which is the names. */
  agents_enabled: number;
  models_active: number;
  frontend_built: boolean;
}

// ── main.py: policy editing ────────────────────────────────────────────────

/**
 * The policy as text rather than as the parsed model.
 *
 * `ConcaStatus` cannot be edited and saved back: serialising it to YAML would
 * drop every comment in `.conca`, and the comments are where the reasons live.
 */
export interface PolicyRaw {
  content: string;
  path: string;
  bytes: number;
}

export interface PolicySaveResult {
  ok: boolean;
  version: number;
  agents_enabled: string[];
  /** The previous policy, kept beside the new one. */
  backup: string;
}

// ── main.py: briefing + workflow detection ─────────────────────────────────

export interface BriefingResult extends SpawnResult {
  /** Composed from what the caller's role grants, not from a fixed script. */
  covering: string[];
}

export interface WorkflowCandidate {
  agent: string;
  action: string;
  occurrences: number;
  typical_hour: number;
  last_seen: string | null;
  suggested_cron: string;
  suggested_prompt: string;
  /**
   * Formatted local time, or null when the expression never fires within the
   * search horizon — which is also what an unparseable cron returns, so the UI
   * shows "—" rather than a wrong time for a typo.
   */
  next_fire_if_armed: string | null;
}

export interface WorkflowsDetected {
  candidates: WorkflowCandidate[];
  scanned: number;
  min_occurrences: number;
  /** Always false. A suggestion is armed by editing `.conca`, never from here. */
  armed: boolean;
}

// ── main.py: system telemetry ──────────────────────────────────────────────

/** One psutil reading. `proc_*` is this Python process; the rest is the machine. */
export interface SystemSample {
  ts: number;
  cpu_pct: number;
  mem_pct: number;
  proc_cpu_pct: number;
  proc_rss_mb: number;
  threads: number;
  load_state: string;
}

export interface SystemMetrics {
  /** False when psutil is not installed — the strip greys out, nothing throws. */
  available: boolean;
  error: string | null;
  /** Empty object when unavailable, so read it behind `available`. */
  current: Partial<SystemSample> & { cores?: number };
  /** Oldest-first, ready to plot. Empty when the sampler has never run. */
  samples: SystemSample[];
  window_hours: number;
  /** Whether the series will keep growing — the sampler rides the scheduler. */
  sampling: boolean;
}

// ── memory.py: social ──────────────────────────────────────────────────────

export interface SocialPost {
  id: string;
  platform: string;
  body: string;
  /**
   * 'draft' | 'published' | 'failed: <ExceptionName>'. Refusals and failures are
   * kept, not dropped — a list of successes only would imply nothing had ever
   * been attempted.
   */
  status: string;
  session_id: string | null;
  external_id: string;
  ts: number;
}

// ── tools.py: github ───────────────────────────────────────────────────────

export interface GithubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface GithubPullRequest {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  updated: string;
}

export interface GithubWorkflowRun {
  name: string;
  status: string;
  /** Never empty: a queued run's null conclusion is reported as 'in_progress'. */
  conclusion: string;
  branch: string;
  url: string;
}

/**
 * Everything past `summary` is optional because a failure returns only
 * `{ok: false, summary}` — the tool's `_fail` carries no detail, so a panel that
 * assumed these were present would crash on the error path.
 */
export interface GithubSummary {
  ok: boolean;
  summary: string;
  repo?: string;
  description?: string;
  stars?: number;
  open_issues?: number;
  default_branch?: string;
  pushed_at?: string;
  private?: boolean;
  commits?: GithubCommit[];
  pull_requests?: GithubPullRequest[];
  workflow_runs?: GithubWorkflowRun[];
  ci_status?: string;
  authenticated?: boolean;
}

// ── main.py: projects ──────────────────────────────────────────────────────

/** Mirrors the `Literal` on `ProjectRequest.kind`; anything else is a 422. */
export type ProjectKind = "python" | "node" | "web" | "blank";

// ── main.py: connecting accounts ───────────────────────────────────────────

/** One credential. `hint` is a masked tail for secrets, the literal value otherwise. */
export interface IntegrationField {
  key: string;
  label: string;
  /** Rendered as a password input and never echoed back by the server. */
  secret: boolean;
  /** Counts toward the group's `state`. */
  required: boolean;
  placeholder: string;
  help: string;
  /** True when the server reads this once at import and needs restarting. */
  restart: boolean;
  set: boolean;
  hint: string;
}

export type IntegrationState = "off" | "partial" | "on";

export interface IntegrationGroup {
  id: string;
  title: string;
  blurb: string;
  unlocks: string;
  state: IntegrationState;
  fields: IntegrationField[];
}

export interface IntegrationStatus {
  /** Absolute path to the `.env` being written — shown so it can be edited by hand. */
  path: string;
  writable: boolean;
  groups: IntegrationGroup[];
  models_active: number;
  models_total: number;
}

/** The save response: the new status, plus what changed and what needs a restart. */
export interface ConnectResult extends IntegrationStatus {
  ok: boolean;
  changed: string[];
  restart_required: string[];
}

// ── main.py: voice ─────────────────────────────────────────────────────────

/**
 * What one recording came back as.
 *
 * `text` only, and never a run id: the route transcribes and stops. Whether the
 * words become a prompt is the user's next decision, not this response's.
 *
 * `model` names which of the two Whisper IDs answered, so a fall-through is
 * visible rather than silent — the same reason `RotatorStatus` reports the model
 * that actually served a step.
 */
export interface TranscriptResult {
  ok: boolean;
  text: string;
  model: string;
}

// ── tools.py: shopper ──────────────────────────────────────────────────────

/**
 * One product page, as `_extract_product` read it.
 *
 * `price` is in the merchant's own `currency`; `price_converted` is the same
 * money in whatever currency the budget was stated in, and is **null** when no
 * FX rate was available. Both are present because a comparison happens in one
 * currency while a price tag is quoted in another, and collapsing the two would
 * lose the ability to say which is which.
 */
export interface ShopCandidate {
  title: string;
  url: string;
  price: number;
  currency: string;
  /** Absent from the page more often than not — most retailers omit it. */
  rating: number | null;
  reviews: number;
  availability: string;
  merchant: string;
  /** Which currency `price_converted` is in. Added by `shop_search`. */
  price_in?: string;
  price_converted?: number | null;
  /** null when there was no budget, or no convertible price to test against it. */
  within_budget?: boolean | null;
  /** `_score`: rating, review volume, budget headroom, stock. Higher is better. */
  score?: number;
  /** Which slot of a multi-item errand this fills. `shop_compare` only. */
  slot?: string;
}

export interface ShopSearchResult {
  ok: boolean;
  summary: string;
  query?: string;
  candidates?: ShopCandidate[];
  /** The currency everything was converted into for comparison. */
  currency?: string;
  budget?: number | null;
  /** How the budget string was read, e.g. "$200 (lower of 2 figures)". */
  budget_note?: string;
}

/** Mirrors the `orders` table. `status` is free text — see `_ORDER_STATES`. */
export interface Order {
  id: string;
  session_id: string | null;
  merchant: string;
  item: string;
  url: string;
  total: number;
  currency: string;
  status: string;
  tracking_url: string;
  note: string;
  /** null until the tracker has read it once. */
  last_checked: number | null;
  created_at: number;
}

export interface OrdersResponse {
  orders: Order[];
  /** The subset not in a terminal state — what the 26-minute cron re-reads. */
  open: Order[];
  /** `.conca` → `rules.checkout_mode`. Widened, because the file is hand-edited. */
  checkout_mode: "handoff" | "autonomous" | "wallet" | (string & {});
  /** `security_overrides.financial_transactions`. False means nothing can pay. */
  can_spend: boolean;
}

export interface TrackResult {
  ok: boolean;
  summary: string;
  orders?: Order[];
  /** Only the ones whose status moved, each carrying the status it moved from. */
  changed?: Array<Order & { was: string }>;
  checked?: number;
}

/**
 * The whole of what `POST /api/shopper/secret` returns.
 *
 * Brand and last four, and nothing else, ever. The number itself is in a
 * module-level dict in the backend for `ttl_seconds`, is readable exactly once,
 * and is never logged, hashed, embedded or screenshotted.
 */
export interface CardStashed {
  ref: string;
  brand: string;
  last4: string;
  ttl_seconds: number;
}

// ── tools.py: market ───────────────────────────────────────────────────────

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  previous_close: number;
  change: number;
  change_pct: number;
  currency: string;
  exchange: string;
  day_high: number | null;
  day_low: number | null;
  year_high: number | null;
  year_low: number | null;
  volume: number | null;
  instrument: string;
  /** Yahoo's `regularMarketTime`, in seconds. */
  as_of: number | null;
}

export interface QuotesResult {
  ok: boolean;
  summary: string;
  quotes?: Quote[];
  /** Symbols the host had nothing for — reported, not silently dropped. */
  missing?: string[];
  paper?: boolean;
  disclaimer?: string;
}

/**
 * Every field past `currency` may be null: `quoteSummary` is behind a session
 * cookie some of the time, and the tool reports the gap rather than filling it
 * with zeros. Check `partial` on the response before reading these.
 */
export interface Fundamentals {
  symbol: string;
  name: string;
  price: number | null;
  currency: string;
  market_cap: number | null;
  pe_trailing: number | null;
  pe_forward: number | null;
  eps: number | null;
  dividend_yield: number | null;
  beta: number | null;
  profit_margin: number | null;
  revenue: number | null;
  debt_to_equity: number | null;
  recommendation: string | null;
  target_mean: number | null;
  sector: string;
  industry: string;
  employees: number | null;
  website: string;
  summary: string;
  year_high: number | null;
  year_low: number | null;
}

export interface FundamentalsResult {
  ok: boolean;
  summary: string;
  fundamentals?: Fundamentals;
  /** True when only quote-level data came back. The blanks are real, not a bug. */
  partial?: boolean;
  paper?: boolean;
  disclaimer?: string;
}

/** A `positions` row, plus the mark-to-market fields `portfolio` adds. */
export interface Position {
  symbol: string;
  qty: number;
  avg_cost: number;
  opened_at: number;
  price?: number | null;
  currency?: string;
  value?: number;
  cost?: number;
  unrealized?: number;
  unrealized_pct?: number;
  day_change_pct?: number;
  /** No live quote: the row is held at cost rather than dropped or zeroed. */
  stale?: boolean;
}

export interface Fill {
  id: string;
  symbol: string;
  side: "buy" | "sell" | (string & {});
  qty: number;
  price: number;
  /** Non-zero only on sells. Booked against average cost at the time. */
  realized: number;
  session_id: string | null;
  note: string;
  ts: number;
}

export interface PortfolioResult {
  ok: boolean;
  summary: string;
  positions: Position[];
  fills: Fill[];
  cost?: number;
  value?: number;
  unrealized?: number;
  realized: number;
  total?: number;
  paper: boolean;
  disclaimer: string;
}

export interface TradeResult {
  ok: boolean;
  summary: string;
  fill?: Fill;
  /** The live quote it filled against — not a price the caller named. */
  quote?: Quote;
  positions?: Position[];
  paper?: boolean;
  disclaimer?: string;
}

// ── tools.py: chain (Solana) ───────────────────────────────────────────────

export interface TokenBalance {
  mint: string;
  /** The ticker when the mint is one of the known few, otherwise a short mint. */
  symbol: string;
  amount: number;
  decimals: number | null;
  known: boolean;
  /** Present for USDC and USDT only, counted at par. Nothing else is quoted. */
  usd?: number;
}

export interface BalancesResult {
  ok: boolean;
  summary: string;
  address?: string;
  chain?: string;
  sol?: number;
  sol_price_usd?: number | null;
  usd_total?: number | null;
  tokens?: TokenBalance[];
  /** `"secret_material"` when the input looked like a key and was refused. */
  refused?: string;
}

export interface ChainTx {
  signature: string;
  slot: number | null;
  /** Block time in seconds, or null on an unconfirmed signature. */
  time: number | null;
  ok: boolean;
  error: string | null;
  memo: string;
  explorer: string;
}

export interface ChainHistoryResult {
  ok: boolean;
  summary: string;
  address?: string;
  chain?: string;
  transactions?: ChainTx[];
  failed?: number;
  refused?: string;
}

// ── main.py: desktop overlay ───────────────────────────────────────────────

/**
 * Answered by `GET /api/desktop/capture` before a frame is ever read.
 *
 * The point of asking first is that a refusal after capture would mean the
 * pixels had already been taken to be told no.
 */
export interface CaptureStatus {
  /** `.conca` `rules.screen_capture`, normalised: 'off' | 'ask' | 'on'. */
  mode: string;
  /** Policy allows it *and* this role has the desktop agent. */
  available: boolean;
  /** True when a capture opens a HALO gate first. */
  gated: boolean;
  /** POST is loopback-only; false in the phone wrapper. */
  local: boolean;
  granted: boolean;
  ttl_seconds: number;
}

/**
 * What comes back from a posted frame: a run to watch, and a receipt.
 *
 * No `image` key, by design. The bytes stay in the server's RAM-only jar under
 * `ref` and the prompt carries the handle, so the screenshot never enters the
 * transcript, the embedding index or the SSE replay buffer.
 */
export interface CaptureResult extends SpawnResult {
  ref: string;
  bytes: number;
  ttl_seconds: number;
  mode: string;
}
