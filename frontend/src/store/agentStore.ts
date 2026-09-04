/**
 * Single store for role, the live run, and everything the SSE stream produces.
 *
 * One store rather than several because the pieces are genuinely coupled: a HALO
 * gate belongs to a subtask, which belongs to a run, which belongs to a role.
 * Splitting them would mean synchronising three stores on every frame.
 *
 * Replay-safety matters here. The broker replays a session's whole history to
 * each new subscriber, so every reducer below is written to be idempotent —
 * applying the same frame twice must not duplicate a thought or resurrect a
 * resolved gate.
 */

import { create } from "zustand";
import { api, ApiError } from "../lib/api";
import { subscribe, type SseHandle } from "../lib/sse";
import type {
  Artifact,
  ConcaStatus,
  HaloRequest,
  Role,
  RotatorStatus,
  SessionSummary,
  SpawnResult,
  SseEvent,
  Subtask,
} from "../types";

/** Cap the retained trace: a long run can emit thousands of frames. */
const MAX_EVENTS = 600;

export type ConnState = "idle" | "open" | "error" | "closed";

interface AgentState {
  // ── identity ────────────────────────────────────────────────────────────
  role: Role;
  userName: string;
  agents: string[];
  haloVisible: boolean;
  roleLoaded: boolean;
  /**
   * Whether the server can transcribe at all. Held here rather than fetched by
   * the mic itself because `bootstrap` already asks `/api/auth/me`, and a second
   * request per composer would mean three or four on every screen that mounts
   * more than one.
   */
  voiceReady: boolean;
  /**
   * Whether this caller may connect accounts — staff, and on the machine running
   * the server. Same reasoning as `voiceReady`: it arrives with identity, and a
   * setup tab that 403s on open is worse than no tab.
   */
  canSetup: boolean;

  // ── live run ────────────────────────────────────────────────────────────
  sessionId: string | null;
  running: boolean;
  /** True when the prompt tripped Rule 0 — the UI says so rather than hiding it. */
  rule0Excluded: boolean;
  events: SseEvent[];
  subtasks: Subtask[];
  pendingHalo: HaloRequest | null;
  artifacts: Artifact[];
  conn: ConnState;
  lastError: string | null;
  finalSummary: string | null;

  // ── ambient ─────────────────────────────────────────────────────────────
  conca: ConcaStatus | null;
  rotator: RotatorStatus | null;
  sessions: SessionSummary[];
  offline: boolean;

  // ── actions ─────────────────────────────────────────────────────────────
  bootstrap: () => Promise<void>;
  runPrompt: (prompt: string) => Promise<void>;
  attachSession: (sessionId: string) => void;
  /**
   * Adopt a run a panel started instead of the composer.
   *
   * The Social, Project and Briefing panels post to endpoints that route through
   * the orchestrator, which means any of them can suspend at the HALO gate. The
   * modal is driven by `pendingHalo`, and `pendingHalo` is only ever populated by
   * the SSE subscription — so a panel that fired its request and ignored the
   * returned session would open a gate nobody could see and then time out, having
   * refused for reasons the operator was never shown.
   */
  trackSpawned: (res: SpawnResult) => void;
  resolveHalo: (
    choiceIndex: number | null,
    customText?: string,
  ) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshRotator: () => Promise<void>;
  /** Re-read the policy after an edit, so the panel shows what is now enforced. */
  refreshConca: () => Promise<void>;
  clearRun: () => void;
  dismissError: () => void;
  setUserName: (name: string) => void;
}

/** Module-scoped: a live EventSource is not serialisable state. */
let handle: SseHandle | null = null;

const detach = () => {
  handle?.close();
  handle = null;
};

/**
 * Identity for dedupe. The backend stamps `ts` from `time.time()`, which is
 * distinct per frame in practice, so type+ts+body is a sufficient key.
 */
const eventKey = (e: SseEvent) =>
  `${e.type}:${e.ts}:${e.text ?? e.message ?? e.summary ?? ""}`;

export const useAgentStore = create<AgentState>((set, get) => ({
  role: "public",
  userName: typeof window !== "undefined" ? localStorage.getItem("conca_user_name") || "" : "",
  agents: [],
  haloVisible: false,
  roleLoaded: false,
  voiceReady: false,
  canSetup: false,

  sessionId: null,
  running: false,
  rule0Excluded: false,
  events: [],
  subtasks: [],
  pendingHalo: null,
  artifacts: [],
  conn: "idle",
  lastError: null,
  finalSummary: null,

  conca: null,
  rotator: null,
  sessions: [],
  offline: false,

  // ────────────────────────────────────────────────────────────────────────

  async bootstrap() {
    try {
      const [me, conca, profile] = await Promise.all([
        api.me(),
        api.concaStatus(),
        api.getProfile().catch(() => null),
      ]);
      if (profile) {
        if (profile.name) {
          try {
            localStorage.setItem("conca_user_name", profile.name);
          } catch {
            /* ignore */
          }
          set({ userName: profile.name });
        }
        if (profile.onboarded) {
          try {
            localStorage.setItem("conca_onboarded_v1", "1");
          } catch {
            /* ignore */
          }
        }
      }
      set({
        role: me.role,
        agents: me.agents,
        haloVisible: me.halo_visible,
        voiceReady: me.voice,
        canSetup: me.setup,
        roleLoaded: true,
        conca,
        offline: false,
      });
      // Non-critical; a missing rotator status should not block the app shell.
      void get().refreshRotator();
      void get().refreshSessions();
    } catch (err) {
      // Offline start-up is a supported path for the PWA: fall through to the
      // public screen from cache rather than showing a dead page.
      set({
        roleLoaded: true,
        offline: err instanceof ApiError && err.isOffline,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async runPrompt(prompt) {
    const trimmed = prompt.trim();
    if (!trimmed || get().running) return;

    const currentSessionId = get().sessionId;
    const isNewSession = !currentSessionId;

    if (isNewSession) {
      detach();
      set({
        running: true,
        events: [],
        subtasks: [],
        artifacts: [],
        pendingHalo: null,
        finalSummary: null,
        lastError: null,
        conn: "idle",
        rule0Excluded: false,
      });
    } else {
      set({ running: true, lastError: null, finalSummary: null });
    }

    try {
      const res = await api.run(trimmed, currentSessionId || undefined);
      set({ sessionId: res.session_id, rule0Excluded: res.rule0_excluded });
      if (isNewSession) {
        get().attachSession(res.session_id);
      }
    } catch (err) {
      set({
        running: false,
        offline: err instanceof ApiError && err.isOffline,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  attachSession(sessionId) {
    detach();
    set({ sessionId, conn: "idle" });

    handle = subscribe(
      sessionId,
      (event) => {
        const s = get();
        // Frames for a session we've since moved off are stale — drop them.
        if (event.session_id && event.session_id !== s.sessionId) return;

        const patch: Partial<AgentState> = {};

        switch (event.type) {
          case "subtask_update": {
            const incoming = event as unknown as Subtask;
            const idx = s.subtasks.findIndex((t) => t.id === incoming.id);
            patch.subtasks =
              idx === -1
                ? [...s.subtasks, incoming]
                : s.subtasks.map((t, i) =>
                    i === idx ? { ...t, ...incoming } : t,
                  );
            break;
          }

          case "halo_request": {
            const req = event as unknown as HaloRequest;
            if (
              !s.events.some(
                (e) => e.type === "halo_resolved" && e.id === req.id,
              )
            ) {
              patch.pendingHalo = req;
              
              if (typeof window !== "undefined" && "Notification" in window) {
                const taskDesc = req.action || req.details || "task";
                if (Notification.permission === "granted") {
                  new Notification("Concaretti Authorization Required", {
                    body: `Agent is requesting permission to execute: ${taskDesc}.`,
                  });
                } else if (Notification.permission !== "denied") {
                  Notification.requestPermission().then((perm) => {
                    if (perm === "granted") {
                      new Notification("Concaretti Authorization Required", {
                        body: `Agent is requesting permission to execute: ${taskDesc}.`,
                      });
                    }
                  });
                }
              }
            }
            break;
          }

          case "halo_resolved":
            if (s.pendingHalo?.id === event.id) patch.pendingHalo = null;
            break;

          case "artifact": {
            const art = event as unknown as Artifact;
            if (art.id && !s.artifacts.some((a) => a.id === art.id)) {
              patch.artifacts = [...s.artifacts, art];
            }
            break;
          }

          case "error":
            patch.lastError = String(event.message ?? "run failed");
            break;

          case "done":
            patch.running = false;
            patch.finalSummary = String(event.summary ?? "");
            void get().refreshSessions();
            break;
        }

        // Keep the raw trace for the thought stream, deduped against replay.
        const key = eventKey(event);
        if (!s.events.some((e) => eventKey(e) === key)) {
          const next = [...s.events, event];
          patch.events =
            next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        }

        if (Object.keys(patch).length) set(patch);
      },
      (status) => {
        set({ conn: status === "open" ? "open" : status });
        // A gate opened while we were disconnected is still waiting server-side.
        if (status === "open") {
          void api
            .haloPending(sessionId)
            .then(({ pending }) => {
              const live = pending.find((p) => p.status === "pending");
              if (live && !get().pendingHalo) set({ pendingHalo: live });
            })
            .catch(() => {
              /* recovery is best-effort */
            });
        }
      },
    );
  },

  trackSpawned(res) {
    // Same reset-then-attach order as `runPrompt`: detaching first means the
    // outgoing stream cannot land a stale frame in the freshly cleared run.
    detach();
    set({
      sessionId: res.session_id,
      running: true,
      events: [],
      subtasks: [],
      artifacts: [],
      pendingHalo: null,
      finalSummary: null,
      lastError: null,
      conn: "idle",
      rule0Excluded: false,
    });
    get().attachSession(res.session_id);
  },

  async resolveHalo(choiceIndex, customText) {
    const req = get().pendingHalo;
    if (!req) return;
    // Clear optimistically: the modal must not sit there while the orchestrator
    // resumes, and `halo_resolved` will confirm.
    set({ pendingHalo: null });
    try {
      await api.resolveHalo(req.id, choiceIndex, customText);
    } catch (err) {
      set({
        pendingHalo: req,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async refreshSessions() {
    try {
      set({ sessions: (await api.sessions()).sessions });
    } catch {
      /* the timeline is decoration; failing quietly is correct here */
    }
  },

  async refreshRotator() {
    try {
      set({ rotator: await api.rotatorStatus() });
    } catch {
      /* ditto */
    }
  },

  async refreshConca() {
    try {
      set({ conca: await api.concaStatus() });
    } catch {
      /* ditto */
    }
  },

  clearRun() {
    detach();
    set({
      sessionId: null,
      running: false,
      events: [],
      subtasks: [],
      artifacts: [],
      pendingHalo: null,
      finalSummary: null,
      conn: "idle",
      rule0Excluded: false,
    });
  },

  dismissError() {
    set({ lastError: null });
  },

  setUserName(name: string) {
    if (typeof window !== "undefined") {
      localStorage.setItem("conca_user_name", name);
    }
    set({ userName: name });
  },
}));

// ── selectors ──────────────────────────────────────────────────────────────
// Derived views live here so components don't recompute them on every frame.
//
// Every selector below that derives a new array MUST be memoised on the slice it
// reads. `useSyncExternalStore`, which is what zustand's hook is built on,
// compares snapshots by reference: a selector ending in `.filter()` or building a
// fresh Map returns a new array each call, so the snapshot never matches the
// previous one, so React re-renders, so the selector runs again. That is an
// infinite loop, and it does not degrade gracefully — it throws
// "Maximum update depth exceeded" and the whole tree unmounts, leaving a blank
// page with no failed request to point at.
//
// This is not hypothetical: `selectLayers` did exactly that, and because
// `StaffScreen` mounts the orchestration panel three times it took the app down
// on first paint. Memoising on the input reference fixes it at the source rather
// than asking every call site to remember `useShallow` — and shallow equality
// would not have saved `selectLayers` anyway, whose elements are themselves
// freshly built tuples.

/**
 * Cache one result against one input, by reference.
 *
 * The store replaces `events` and `subtasks` wholesale on update, so the input
 * reference changing is exactly the signal that the derived value is stale.
 */
function memoOne<In, Out>(compute: (input: In) => Out): (input: In) => Out {
  let lastInput: In;
  let lastOutput: Out;
  let primed = false;
  return (input: In) => {
    if (primed && input === lastInput) return lastOutput;
    lastInput = input;
    lastOutput = compute(input);
    primed = true;
    return lastOutput;
  };
}

const thoughtsOf = memoOne((events: AgentState["events"]) =>
  events.filter((e) => e.type === "thought"),
);

export const selectThoughts = (s: AgentState) => thoughtsOf(s.events);

const activityOf = memoOne((events: AgentState["events"]) =>
  events.filter((e) => e.type === "activity" || e.type === "error"),
);

export const selectActivity = (s: AgentState) => activityOf(s.events);

/** Subtasks grouped by execution layer, ascending — how the DAG stage renders. */
const layersOf = memoOne((subtasks: AgentState["subtasks"]) => {
  const byLayer = new Map<number, Subtask[]>();
  for (const t of subtasks) {
    const bucket = byLayer.get(t.layer);
    if (bucket) bucket.push(t);
    else byLayer.set(t.layer, [t]);
  }
  return [...byLayer.entries()].sort(([a], [b]) => a - b);
});

export const selectLayers = (s: AgentState): Array<[number, Subtask[]]> =>
  layersOf(s.subtasks);

export const selectCanUse = (agent: string) => (s: AgentState) =>
  s.agents.includes(agent);
