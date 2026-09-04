/**
 * Thin fetch wrapper.
 *
 * Every call sends credentials so the HMAC role cookie rides along — the backend
 * derives the role from that cookie and never from anything the client claims.
 * Paths here mirror `backend/main.py` exactly; there is no rewriting layer, so a
 * rename on either side shows up as a 404 in development rather than a subtle
 * mismatch in production.
 */

import type {
  AgentRegistry,
  Artifact,
  AuditEntry,
  BalancesResult,
  BriefingResult,
  CalendarEvent,
  CaptureResult,
  CaptureStatus,
  CardStashed,
  ChainHistoryResult,
  ConcaStatus,
  ConnectResult,
  DiaryEntry,
  EmailMessage,
  FundamentalsResult,
  GithubSummary,
  HaloRequest,
  HealthProbe,
  HealthStatus,
  IntegrationStatus,
  Metrics,
  OrdersResponse,
  PolicyRaw,
  PolicySaveResult,
  PortfolioResult,
  ProjectKind,
  QuotesResult,
  RecallResponse,
  Role,
  RotatorStatus,
  ScheduledJob,
  SessionDetail,
  SessionSummary,
  ShopSearchResult,
  SimulateResult,
  SmsThread,
  SocialPost,
  SpawnResult,
  SystemMetrics,
  TradeResult,
  TrackResult,
  TranscriptResult,
  WorkflowsDetected,
} from "../types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 403 means `.conca` or the role gate refused — worth surfacing verbatim. */
  get isPolicyRefusal(): boolean {
    return this.status === 403;
  }

  get isOffline(): boolean {
    return this.status === 0;
  }
}

/**
 * Where the backend lives.
 *
 * Served by FastAPI or behind the Vite proxy this is empty, so every request
 * stays same-origin and relative — which is what lets the cookie ride along
 * without CORS. The wrappers are the exception: Tauri and Capacitor load the
 * bundle from `tauri://` / `capacitor://`, where a relative `/api` resolves
 * against the custom scheme and never reaches the server. There they set
 * `VITE_API_BASE` to the host the backend is actually reachable on.
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      credentials: "include",
      ...init,
      headers: {
        // JSON unless the body is a multipart form, in which case the browser
        // has to set the header itself — it is the only party that knows the
        // boundary token, and naming the type without one produces a body the
        // server cannot parse.
        ...(init?.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    // Offline, or the backend isn't up. Callers render a banner rather than a
    // stack trace, and telling this apart from a 500 matters for the PWA.
    throw new ApiError(
      err instanceof Error ? err.message : "network unreachable",
      0,
    );
  }

  if (!res.ok) {
    let detail: unknown;
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      detail = body;
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      /* non-JSON error body; the status line is all we have */
    }
    throw new ApiError(message, res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const qs = (params: Record<string, string | number | undefined | null>) => {
  const pairs = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  return pairs.length
    ? "?" +
        pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
    : "";
};

export const api = {
  // ── auth ─────────────────────────────────────────────────────────────────
  me: () =>
    request<{
      role: Role;
      agents: string[];
      halo_visible: boolean;
      /** False when `GROQ_API_KEY` is unset — the mic hides rather than 503s. */
      voice: boolean;
      /**
       * Whether this caller may connect accounts: staff **and** on the machine
       * running the server. False in the phone wrapper, where the setup step is
       * skipped rather than offered and then refused.
       */
      setup: boolean;
    }>("/api/auth/me"),
  /**
   * Set the role cookie explicitly. Local callers only, and mainly useful for
   * stepping *down* to preview the student or public surface — the default for a
   * local caller is already staff.
   */
  login: (role: Role) =>
    post<{ ok: boolean; role: Role; agents: string[] }>("/api/auth/login", {
      role,
    }),
  /** Clears the cookie, which drops a local caller back to the staff default. */
  logout: () => post<{ ok: boolean; role: Role }>("/api/auth/logout"),
  getProfile: () =>
    request<{ name: string; role: Role; onboarded: boolean }>("/api/profile"),
  saveProfile: (data: { name: string; role: Role; onboarded: boolean }) =>
    post<{ ok: boolean; name: string; role: Role; onboarded: boolean }>(
      "/api/profile",
      data,
    ),

  // ── policy, security engine, models ──────────────────────────────────────
  concaStatus: () => request<ConcaStatus>("/api/conca/status"),
  concaReload: () =>
    post<{ ok: boolean; version: number; agents_enabled: string[] }>(
      "/api/conca/reload",
    ),
  /** Dry-runs the normalizer. Never executes anything — the defence endpoint. */
  concaSimulate: (command: string) =>
    post<SimulateResult>("/api/conca/simulate", { command }),
  /**
   * The policy as text, comments intact. `concaStatus` returns the parsed model,
   * which cannot be saved back — YAML round-tripping drops every comment, and in
   * `.conca` the comments record why each disabled agent is disabled.
   */
  concaRaw: () => request<PolicyRaw>("/api/conca/raw"),
  /**
   * Overwrites `.conca` and hot-reloads it. Staff only, validated server-side,
   * and refused outright if the submitted policy would empty either path list —
   * so a 400 from here is the engine declining to be disarmed, not a client bug.
   */
  concaSave: (content: string) =>
    post<PolicySaveResult>("/api/conca/save", { content }),
  rotatorStatus: () => request<RotatorStatus>("/api/rotator/status"),
  health: () => request<HealthStatus>("/api/health"),
  /**
   * Process telemetry reported by the process about itself. Deliberately not an
   * agent: one asked about its own liveness can only answer while it is alive.
   */
  healthProbe: () => request<HealthProbe>("/api/health/probe"),
  metrics: (windowHours = 24) =>
    request<Metrics>("/api/metrics" + qs({ window_hours: windowHours })),
  /**
   * Real machine telemetry from psutil — a live reading plus the stored series.
   * `available: false` rather than a 500 when psutil is missing, so the strip
   * greys out instead of taking its panel down.
   */
  systemMetrics: (windowHours = 6) =>
    request<SystemMetrics>(
      "/api/metrics/system" + qs({ window_hours: windowHours }),
    ),

  // ── agent runs ───────────────────────────────────────────────────────────
  run: (prompt: string, sessionId?: string) =>
    post<{
      ok: boolean;
      session_id: string;
      stream: string;
      rule0_excluded: boolean;
    }>("/api/agents/run", { prompt, session_id: sessionId ?? null }),
  sessions: () => request<{ sessions: SessionSummary[] }>("/api/sessions"),
  session: (sessionId: string) =>
    request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`),

  // ── HALO ─────────────────────────────────────────────────────────────────
  /** Recovers a gate opened before this client connected (or after a reload). */
  haloPending: (sessionId?: string) =>
    request<{ pending: HaloRequest[] }>(
      "/api/halo/pending" + qs({ session_id: sessionId }),
    ),
  resolveHalo: (id: string, choiceIndex: number | null, customText?: string) =>
    post<{
      ok: boolean;
      approved: boolean;
      reason: string;
      chosen?: string;
    }>(`/api/halo/${encodeURIComponent(id)}/resolve`, {
      choice_index: choiceIndex,
      custom_text: customText ?? null,
    }),

  // ── memory ───────────────────────────────────────────────────────────────
  recall: (q: string, opts?: { sessionId?: string; k?: number }) =>
    request<RecallResponse>(
      "/api/memory/recall" + qs({ q, session_id: opts?.sessionId, k: opts?.k }),
    ),
  audit: (sessionId?: string, limit = 100) =>
    request<{ entries: AuditEntry[] }>(
      "/api/memory/audit" + qs({ session_id: sessionId, limit }),
    ),

  // ── artifacts ────────────────────────────────────────────────────────────
  artifacts: (sessionId?: string) =>
    request<{ artifacts: Artifact[] }>(
      "/api/artifacts" + qs({ session_id: sessionId }),
    ),
  artifactDownloadUrl: (id: string) =>
    `${API_BASE}/api/artifacts/${encodeURIComponent(id)}/download`,

  // ── calendar ─────────────────────────────────────────────────────────────
  events: (opts?: { days?: number; kinds?: string[] }) =>
    request<{ events: CalendarEvent[] }>(
      "/api/calendar/events" +
        qs({ days: opts?.days, kinds: opts?.kinds?.join(",") }),
    ),
  createEvent: (body: {
    title: string;
    start?: string | number;
    end?: string | number;
    description?: string;
    kind?: string;
  }) =>
    post<{ ok: boolean; event?: CalendarEvent; error?: string }>(
      "/api/calendar/events",
      body,
    ),
  deleteEvent: (id: string) =>
    request<{ ok: boolean }>(`/api/calendar/events/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // ── email ────────────────────────────────────────────────────────────────
  emails: (maxResults = 12) =>
    request<{
      ok: boolean;
      messages: EmailMessage[];
      connected: boolean;
      error?: string;
    }>("/api/email/list" + qs({ max_results: maxResults })),

  // ── telecom ──────────────────────────────────────────────────────────────
  smsThreads: () => request<{ threads: SmsThread[] }>("/api/sms/threads"),
  /** Routed through the orchestrator server-side, so HALO applies. */
  sendSms: (to: string, body: string) =>
    post<SpawnResult>("/api/sms/send", { to, body }),
  /** Voice. Also orchestrated — `make_call` is a HALO trigger. */
  placeCall: (to: string, script: string) =>
    post<SpawnResult>("/api/sms/call", { to, script }),

  // ── browser ──────────────────────────────────────────────────────────────
  /**
   * Render a page server-side and return its text plus a JPEG.
   *
   * Not gated, because it is a read — see the route docstring for why an iframe
   * cannot do this job.
   */
  browse: (url: string, shot = true) =>
    post<{
      ok: boolean;
      summary: string;
      url?: string;
      title?: string;
      status?: number;
      text?: string;
      links?: { text: string; href: string }[];
      image?: string;
      image_error?: string;
      transport?: string;
    }>("/api/browser/open", { url, shot }),
  /** In-page interaction. Orchestrated, so it suspends for approval. */
  browserAct: (
    url: string,
    steps: { action: string; selector: string; value?: string }[],
  ) => post<SpawnResult>("/api/browser/act", { url, steps }),

  // ── diary ────────────────────────────────────────────────────────────────
  diary: () => request<{ entries: DiaryEntry[] }>("/api/diary"),
  addDiaryEntry: (body: {
    day?: string;
    summary: string;
    reflection?: string;
    agent_assisted?: boolean;
  }) => post<{ ok: boolean; entry: DiaryEntry }>("/api/diary", body),
  deleteDiaryEntry: (id: string) =>
    request<{ ok: boolean }>(`/api/diary/${id}`, { method: "DELETE" }),

  // ── scheduler ────────────────────────────────────────────────────────────
  jobs: () =>
    request<{ jobs: ScheduledJob[]; policy_schedules: unknown[] }>(
      "/api/scheduler/jobs",
    ),

  // ── agent explorer ───────────────────────────────────────────────────────
  agentRegistry: () => request<AgentRegistry>("/api/agents/registry"),

  // ── briefing + workflow detection ────────────────────────────────────────
  /** 403 when the caller's role grants nothing a briefing could read. */
  briefing: () => post<BriefingResult>("/api/briefing/run"),
  /**
   * Repetition inferred by counting the audit log rather than by asking a model —
   * the evidence for "you do this often" is the record of having done it.
   * HALO-gated actions never appear: scheduling an unattended irreversible send
   * is the exact failure the gate exists to prevent.
   */
  workflowsDetected: (opts?: { limit?: number; minOccurrences?: number }) =>
    request<WorkflowsDetected>(
      "/api/workflows/detected" +
        qs({ limit: opts?.limit, min_occurrences: opts?.minOccurrences }),
    ),

  // ── social ───────────────────────────────────────────────────────────────
  /** Drafts and failures included — a success-only list would imply no refusals. */
  socialPosts: (limit = 50) =>
    request<{ posts: SocialPost[] }>("/api/social/posts" + qs({ limit })),
  /** Routed through the orchestrator, so a publish meets the same gate a send does. */
  socialPost: (platform: string, body: string) =>
    post<SpawnResult>("/api/social/post", { platform, body }),

  // ── github ───────────────────────────────────────────────────────────────
  /**
   * `owner/name` or a full URL; the tool strips the prefix either way. Read-only
   * by construction, which is why this one calls its tool directly instead of
   * going through the orchestrator — there is no write path for a gate to catch.
   */
  githubSummary: (repo: string) =>
    request<GithubSummary>("/api/github/summary" + qs({ repo })),

  // ── projects ─────────────────────────────────────────────────────────────
  /** One gate covers the whole scaffold; N approvals per action trains click-through. */
  createProject: (body: {
    name: string;
    kind?: ProjectKind;
    description?: string;
    path?: string;
  }) => post<SpawnResult>("/api/projects/create", body),

  // ── shopper ──────────────────────────────────────────────────────────────
  /** Every order the shopper has opened, plus the two policy keys that bound it. */
  shopperOrders: (limit = 50) =>
    request<OrdersResponse>("/api/shopper/orders" + qs({ limit })),
  /**
   * Price one item across merchants. Direct, because it is a read — every URL has
   * been through `check_url` and nothing is clicked.
   *
   * `budget` is a *string*, not a number: the backend parses "$200 or 400k naira"
   * itself, takes the lower of two stated figures, and returns how it read them in
   * `budget_note`. Parsing it here would mean two parsers to keep in step.
   */
  shopSearch: (body: {
    query: string;
    budget?: string;
    currency?: string;
    limit?: number;
  }) => post<ShopSearchResult>("/api/shopper/search", body),
  /**
   * Hand a whole multi-item errand to the orchestrator: search each, fit the
   * combined ceiling, load the cart, then watch it to delivery. Orchestrated, so
   * the checkout step inside it meets HALO.
   */
  shopErrand: (body: { items: string[]; budget?: string; currency?: string }) =>
    post<SpawnResult>("/api/shopper/errand", body),
  /**
   * Card details for one autonomous checkout. Staff only, and refused outright
   * unless `financial_transactions` **and** `checkout_mode: autonomous` are both
   * set — a jar holding a card the policy will never let it use is a jar holding a
   * card for no reason. What comes back is brand and last four.
   */
  stashCard: (body: {
    ref: string;
    pan: string;
    exp?: string;
    cvc?: string;
    name?: string;
    postal?: string;
  }) => post<CardStashed>("/api/shopper/secret", body),
  /** Buy. Orchestrated, always — `shop_checkout` is a HALO trigger. */
  shopCheckout: (body: {
    url: string;
    item?: string;
    total?: number;
    currency?: string;
    cart_url?: string;
    card_ref?: string;
  }) => post<SpawnResult>("/api/shopper/checkout", body),
  /** Re-read now instead of waiting for the cron tick. No id sweeps everything open. */
  shopTrack: (orderId?: string) =>
    post<TrackResult>("/api/shopper/track", { order_id: orderId ?? "" }),

  // ── market ───────────────────────────────────────────────────────────────
  /** Comma- or space-separated, up to ten. Yahoo's own suffixes: `BTC-USD`, `^GSPC`. */
  marketQuote: (symbols: string) =>
    request<QuotesResult>("/api/market/quote" + qs({ symbols })),
  marketChart: (symbol: string, range = "1mo", interval = "1d") =>
    request<any>("/api/market/chart" + qs({ symbol, range, interval })),
  marketFundamentals: (symbol: string) =>
    request<FundamentalsResult>("/api/market/fundamentals" + qs({ symbol })),
  marketPortfolio: () => request<PortfolioResult>("/api/market/portfolio"),
  /**
   * A simulated fill, priced at the live quote rather than at a price passed in.
   * Direct and ungated on purpose: there is no brokerage wired, so this writes one
   * row to a local table, and a gate on an action that cannot lose anything only
   * teaches people to click through the gates that matter.
   */
  paperTrade: (body: {
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    note?: string;
  }) => post<TradeResult>("/api/market/trade", body),

  // ── chain (Solana) ───────────────────────────────────────────────────────
  /** A public address, never a key. Read-only and keyless. */
  chainBalances: (address: string) =>
    request<BalancesResult>("/api/chain/balances" + qs({ address })),
  chainHistory: (address: string, limit = 15) =>
    request<ChainHistoryResult>("/api/chain/history" + qs({ address, limit })),
  /**
   * Build an **unsigned** transfer. Orchestrated, so it stops at HALO before the
   * recipient is committed to — the moment to catch a wrong Solana address is
   * before a wallet opens, because the transfer itself is final.
   *
   * The result arrives on the stream, not from here: the returned summary carries
   * the Solana Pay URI, the unsigned base64 transaction and the plain fields.
   */
  chainPrepare: (body: {
    to: string;
    amount: number;
    sender?: string;
    memo?: string;
  }) => post<SpawnResult>("/api/chain/prepare", body),

  // ── voice ────────────────────────────────────────────────────────────────
  /**
   * One recording in, a transcript out. Nothing runs as a result.
   *
   * `FormData` rather than a base64 JSON field: base64 inflates the body by a
   * third for no gain, and the browser already knows how to stream a Blob. The
   * filename carries the container so the provider can pick a decoder — the MIME
   * type on the Blob alone is not always enough.
   */
  transcribe: (clip: Blob, filename = "speech.webm") => {
    const form = new FormData();
    form.append("audio", clip, filename);
    return request<TranscriptResult>("/api/voice/transcribe", {
      method: "POST",
      body: form,
    });
  },

  // ── desktop overlay ──────────────────────────────────────────────────────
  /**
   * Ask before reading, not after.
   *
   * The overlay calls this on open so it can grey the capture button out and say
   * which `.conca` key to change. The alternative — capture, post, get a 403 —
   * means the screen was read in order to be told it should not have been.
   */
  captureStatus: () => request<CaptureStatus>("/api/desktop/capture"),
  /**
   * Post one frame from the Tauri `capture_screen()` command.
   *
   * The base64 goes up and does not come back: the response is a run handle plus
   * a byte count, because the pixels are held server-side under `ref` and only
   * the handle travels on into the prompt. Loopback-only — a frame arriving over
   * a LAN is by definition not this machine photographing its own display.
   */
  capture: (imageB64: string, question = "") =>
    post<CaptureResult>("/api/desktop/capture", {
      image_b64: imageB64,
      question,
    }),

  // ── connecting accounts ──────────────────────────────────────────────────
  /**
   * What is connected, and what could be. Contains no secret values — a set key
   * comes back as `set: true` plus a masked tail, because the reason credentials
   * live in a file outside the bundle is that the browser never holds them.
   *
   * 403 off-loopback: the phone wrapper reaches the server over a LAN and cannot
   * write its `.env`, so `me().setup` is false there and this is never called.
   */
  integrations: () => request<IntegrationStatus>("/api/setup/integrations"),
  /**
   * Write credentials into `backend/.env` and into the live environment.
   *
   * Send only the fields that changed. An empty string **disconnects** that key,
   * which is the difference between a settings page and a one-way funnel. Keys
   * outside the server's catalogue are refused with a 400 — notably `PYTHON_EXE`,
   * which names the interpreter `python_execute` shells out to and so is not
   * something a form should be able to set.
   *
   * Everything takes effect on the next request except `CONCA_SECRET`; the
   * response names anything needing a restart in `restart_required`.
   */
  connect: (values: Record<string, string>) =>
    post<ConnectResult>("/api/setup/integrations", { values }),
};

/**
 * Relative when same-origin, so the Vite proxy and the served build behave
 * identically; absolute only in a wrapper, where `VITE_API_BASE` is set.
 */
export const sseUrl = (sessionId: string) =>
  `${API_BASE}/sse/${encodeURIComponent(sessionId)}`;
