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
  AttachedFile,
  CalendarEvent,
  ChatTurn,
  ConcaStatus,
  EmailMessage,
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
  turns: ChatTurn[];
  /** True when the prompt tripped Rule 0 — the UI says so rather than hiding it. */
  rule0Excluded: boolean;
  events: SseEvent[];
  subtasks: Subtask[];
  pendingHalo: HaloRequest | null;
  artifacts: Artifact[];
  conn: ConnState;
  lastError: string | null;
  finalSummary: string | null;
  streamingText: string | null;

  conca: ConcaStatus | null;
  rotator: RotatorStatus | null;
  sessions: SessionSummary[];
  offline: boolean;

  // ── cached services (instantly fetched on load) ──────────────────────────
  emails: EmailMessage[];
  emailsLoading: boolean;
  emailsConnected: boolean;
  emailsNotice: string | null;
  refreshEmails: () => Promise<void>;

  calendarEvents: CalendarEvent[];
  calendarLoading: boolean;
  refreshCalendar: () => Promise<void>;

  // ── actions ─────────────────────────────────────────────────────────────
  bootstrap: () => Promise<void>;
  runPrompt: (
    prompt: string,
    attachments?: AttachedFile[],
    isTemporary?: boolean,
  ) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
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
  stopRun: () => Promise<void>;
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

function findLastAssistantIndex(turns: ChatTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return i;
  }
  return -1;
}

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
  turns: [],
  rule0Excluded: false,
  events: [],
  subtasks: [],
  pendingHalo: null,
  artifacts: [],
  conn: "idle",
  lastError: null,
  finalSummary: null,
  streamingText: null,

  conca: null,
  rotator: null,
  sessions: [],
  offline: false,

  emails: [],
  emailsLoading: false,
  emailsConnected: true,
  emailsNotice: null,

  calendarEvents: [],
  calendarLoading: false,

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
      // Pre-fetch live emails and calendar events instantly on load
      void get().refreshEmails();
      void get().refreshCalendar();
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

  async runPrompt(prompt, attachments, isTemporary) {
    const trimmed = prompt.trim();
    if (!trimmed || get().running) return;

    const currentSessionId = get().sessionId;
    const isNewSession = !currentSessionId;

    const userTurn: ChatTurn = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
      ts: Date.now() / 1000,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };
    const asstTurn: ChatTurn = {
      id: `asst-${Date.now() + 1}`,
      role: "assistant",
      content: "",
      ts: Date.now() / 1000,
      status: "running",
      thoughts: [],
      subtasks: [],
      artifacts: [],
    };

    if (isNewSession) {
      detach();
      set({
        running: true,
        turns: [userTurn, asstTurn],
        events: [],
        subtasks: [],
        artifacts: [],
        pendingHalo: null,
        finalSummary: null,
        streamingText: "",
        lastError: null,
        conn: "idle",
        rule0Excluded: false,
      });
    } else {
      set({
        running: true,
        turns: [...get().turns, userTurn, asstTurn],
        lastError: null,
        finalSummary: null,
        streamingText: "",
      });
    }

    try {
      const res = await api.run(
        trimmed,
        currentSessionId || undefined,
        attachments,
        undefined,
        isTemporary,
      );
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

    // Restore conversation history from SQLite for persistence across re-attachments
    void api.session(sessionId).then((detail) => {
      // Never wipe in-flight running turns or existing populated turns in current session
      if (get().running) return;
      if (detail && detail.entries && detail.entries.length > 0) {
        if (get().sessionId === sessionId && get().turns.length >= detail.entries.length) {
          return;
        }
        const loadedTurns: ChatTurn[] = [];
        for (const entry of detail.entries) {
          if (entry.role === "user") {
            loadedTurns.push({
              id: `user-${entry.ts}`,
              role: "user",
              content: entry.content,
              ts: entry.ts,
            });
          } else if (entry.role === "assistant") {
            loadedTurns.push({
              id: `asst-${entry.ts}`,
              role: "assistant",
              content: entry.content,
              agent: entry.agent ?? undefined,
              ts: entry.ts,
              status: "done",
              thoughts: [],
              subtasks: [],
              artifacts: detail.artifacts || [],
            });
          }
        }
        set({ turns: loadedTurns, artifacts: detail.artifacts || [] });
      }
    }).catch(() => {});

    handle = subscribe(
      sessionId,
      (event) => {
        const s = get();
        // Frames for a session we've since moved off are stale — drop them.
        if (event.session_id && event.session_id !== s.sessionId) return;

        // Sentinel heartbeat & watch telemetry belongs strictly in Settings -> Logs, NEVER in user thought streams
        const isSentinel =
          /\[sentinel\b/i.test(String(event.text ?? event.message ?? "")) ||
          event.agent === "sentinel";
        if (isSentinel) {
          return;
        }

        const patch: Partial<AgentState> = {};

        switch (event.type) {
          case "subtask_update": {
            const incoming = event as unknown as Subtask;
            const idx = s.subtasks.findIndex((t) => t.id === incoming.id);
            const nextSubtasks =
              idx === -1
                ? [...s.subtasks, incoming]
                : s.subtasks.map((t, i) =>
                    i === idx ? { ...t, ...incoming } : t,
                  );
            patch.subtasks = nextSubtasks;

            const activeTurns = [...(patch.turns || s.turns)];
            let lastAsstIdx = findLastAssistantIndex(activeTurns);
            if (lastAsstIdx === -1) {
              activeTurns.push({
                id: `asst-${Date.now()}`,
                role: "assistant",
                content: "",
                ts: Date.now() / 1000,
                status: "running",
                thoughts: [],
                subtasks: [incoming],
                artifacts: [],
              });
              patch.turns = activeTurns;
            } else {
              const curr = activeTurns[lastAsstIdx];
              const stList = curr.subtasks || [];
              const sIdx = stList.findIndex((t) => t.id === incoming.id);
              activeTurns[lastAsstIdx] = {
                ...curr,
                subtasks: sIdx === -1 ? [...stList, incoming] : stList.map((t, i) => i === sIdx ? { ...t, ...incoming } : t),
              };
              patch.turns = activeTurns;
            }
            break;
          }

          case "token": {
            const delta = String((event as unknown as { delta?: string }).delta || "");
            if (delta) {
              const activeTurns = [...(patch.turns || s.turns)];
              let lastAsstIdx = findLastAssistantIndex(activeTurns);
              if (lastAsstIdx === -1) {
                activeTurns.push({
                  id: `asst-${Date.now()}`,
                  role: "assistant",
                  content: delta,
                  ts: Date.now() / 1000,
                  status: "running",
                  thoughts: [],
                  subtasks: [],
                  artifacts: [],
                });
              } else {
                activeTurns[lastAsstIdx] = {
                  ...activeTurns[lastAsstIdx],
                  content: (activeTurns[lastAsstIdx].content || "") + delta,
                };
              }
              patch.turns = activeTurns;
              patch.streamingText = (s.streamingText || "") + delta;
            }
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

          case "done": {
            patch.running = false;
            const summaryText = String(event.summary ?? "");
            patch.finalSummary = summaryText;

            const activeTurns = [...(patch.turns || s.turns)];
            let lastAsstIdx = findLastAssistantIndex(activeTurns);
            if (lastAsstIdx !== -1) {
              activeTurns[lastAsstIdx] = {
                ...activeTurns[lastAsstIdx],
                content: summaryText || activeTurns[lastAsstIdx].content,
                status: "done",
                artifacts: s.artifacts,
              };
            } else {
              activeTurns.push({
                id: `asst-${Date.now()}`,
                role: "assistant",
                content: summaryText,
                status: "done",
                thoughts: [],
                subtasks: [],
                artifacts: s.artifacts,
                ts: Date.now() / 1000,
              });
            }
            patch.turns = activeTurns;
            void get().refreshSessions();
            break;
          }

          case "voice_trigger":
            if (typeof window !== "undefined") {
              // Dispatch an event that the Cockpit/Microphone component can catch
              window.dispatchEvent(new CustomEvent("conca_voice_trigger"));
            }
            break;
        }

        // Attach thoughts / activity to active assistant turn
        if (event.type === "thought" || event.type === "activity") {
          const activeTurns = [...(patch.turns || s.turns)];
          let lastAsstIdx = findLastAssistantIndex(activeTurns);
          if (lastAsstIdx === -1) {
            activeTurns.push({
              id: `asst-${Date.now()}`,
              role: "assistant",
              content: "",
              ts: Date.now() / 1000,
              status: "running",
              thoughts: [event],
              subtasks: [],
              artifacts: [],
            });
            patch.turns = activeTurns;
          } else {
            const curr = activeTurns[lastAsstIdx];
            activeTurns[lastAsstIdx] = {
              ...curr,
              thoughts: [...(curr.thoughts || []), event],
            };
            patch.turns = activeTurns;
          }
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

  async renameSession(sessionId, title) {
    try {
      await api.renameSession(sessionId, title);
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? { ...sess, title } : sess,
        ),
      }));
    } catch (err) {
      console.error("Failed to rename session", err);
    }
  },

  async deleteSession(sessionId) {
    try {
      await api.deleteSession(sessionId);
      set((s) => ({
        sessions: s.sessions.filter((sess) => sess.id !== sessionId),
      }));
      if (get().sessionId === sessionId) {
        get().clearRun();
      }
    } catch (err) {
      console.error("Failed to delete session", err);
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
      turns: [],
      events: [],
      subtasks: [],
      artifacts: [],
      pendingHalo: null,
      finalSummary: null,
      conn: "idle",
      rule0Excluded: false,
    });
  },

  async stopRun() {
    const s = get();
    const sid = s.sessionId;
    detach();
    set({
      running: false,
      conn: "closed",
      lastError: null,
    });
    if (sid) {
      try {
        await api.cancelRun(sid);
      } catch (err) {
        console.error("Failed to cancel run server-side", err);
      }
    }
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

  async refreshEmails() {
    set({ emailsLoading: true });
    try {
      const res = await api.emails(50);
      set({
        emails: res.messages ?? [],
        emailsConnected: res.connected,
        emailsNotice: res.connected ? null : (res.error ?? "Gmail is not connected."),
        emailsLoading: false,
      });
    } catch (err) {
      set({
        emailsConnected: false,
        emailsNotice: err instanceof Error ? err.message : "Could not load emails",
        emailsLoading: false,
      });
    }
  },

  async refreshCalendar() {
    set({ calendarLoading: true });
    try {
      const res = await api.events({ days: 400 });
      set({
        calendarEvents: res.events ?? [],
        calendarLoading: false,
      });
    } catch {
      set({ calendarLoading: false });
    }
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
