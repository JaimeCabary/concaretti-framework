/**
 * Telecom Inbox — SMS threads and call history from SQLite.
 *
 * Threads are read from the local store, not from Twilio. Inbound arrives via
 * the webhook when a tunnel is up and persists immediately; when no tunnel is
 * running the thread still renders correctly from whatever was stored and
 * outbound keeps working. So the panel degrades to read-plus-send rather than
 * going blank, which is the behaviour that survives a demo on hotel wifi.
 *
 * Calls and texts share one thread per contact because that is the conversation
 * as the operator remembers it — "I texted them, then I rang them" is one
 * history, not two. A call row holds the spoken script in `body` and is marked
 * with a `kind` of `"call"`.
 *
 * Like email, both sending and calling are routed through the orchestrator so
 * `send_sms` and `make_call` hit the HALO gate. Messages awaiting approval are
 * marked, because the row exists locally before delivery is decided.
 */

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { SmsThread } from "../types";
import { Empty, relTime } from "./ui";

/** SMS or voice. Which one the compose box will produce. */
type Mode = "sms" | "call";

export function TelecomInbox() {
  const running = useAgentStore((s) => s.running);
  const finalSummary = useAgentStore((s) => s.finalSummary);
  const events = useAgentStore((s) => s.events);
  const track = useAgentStore((s) => s.trackSpawned);

  const [threads, setThreads] = useState<SmsThread[]>([]);
  const [peer] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [newTo, setNewTo] = useState("");
  const [mode, setMode] = useState<Mode>("sms");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    // `void` rather than returning the chain: an effect callback must return a
    // cleanup function or nothing, never a Promise.
    void api
      .smsThreads()
      .then((r) => {
        setThreads(r.threads);
        setErr(null);
      })
      .catch((e: unknown) =>
        setErr(
          e instanceof ApiError && e.isPolicyRefusal
            ? e.message
            : e instanceof ApiError && e.isOffline
              ? "Offline — threads need the backend."
              : e instanceof Error
                ? e.message
                : "Could not load threads",
        ),
      );
  }, []);

  useEffect(load, [load]);

  // A completed send, or an inbound webhook narrating on the telecom channel,
  // both mean the stored threads have moved on.
  useEffect(() => {
    if (finalSummary) load();
  }, [finalSummary, load]);

  useEffect(() => {
    const last = events[events.length - 1];
    if (
      last?.type === "activity" &&
      String(last.message ?? "").startsWith("SMS from")
    ) {
      load();
    }
  }, [events, load]);

  const active = threads.find((t) => t.peer === peer) ?? null;

  const send = () => {
    const text = body.trim();
    const to = active?.peer ?? newTo.trim();
    if (!text || !to || running) return;
    // The returned session has to be handed to the store, not discarded.
    // `send_sms` and `make_call` are both HALO triggers, so this request suspends
    // server-side waiting for approval — and the gate is only ever rendered from
    // the SSE stream. A fire-and-forget send would open a gate with nothing
    // subscribed to it, and 300s later it would fail closed having refused for
    // reasons nobody saw.
    void (mode === "call" ? api.placeCall(to, text) : api.sendSms(to, text))
      .then(track)
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : "Send failed");
      });
    setBody("");
    setNewTo("");
    // The orchestrator writes the outbound row; give it a beat, then refetch.
    setTimeout(load, 1200);
  };

  /** SMS / Call selector. Two buttons rather than a toggle, so which one is
   *  armed is legible without reading a label — mixing these up dials someone. */
  const ModePicker = () => (
    <div className="flex gap-1.5 mb-2">
      {(["sms", "call"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          aria-pressed={mode === m}
          className={`chip ${mode === m ? "bg-council-soft" : ""}`}
        >
          {m === "sms" ? "Text" : "Call"}
        </button>
      ))}
    </div>
  );

  const sentTodayCount = threads.reduce(
    (acc, t) =>
      acc +
      t.messages.filter(
        (m) => m.direction === "outbound" && m.status === "delivered",
      ).length,
    0,
  );
  const pendingCount = threads.reduce(
    (acc, t) =>
      acc +
      t.messages.filter(
        (m) =>
          m.direction === "outbound" &&
          (m.status === "queued" ||
            m.status === "sending" ||
            m.pending_approval),
      ).length,
    0,
  );
  const failedCount = threads.reduce(
    (acc, t) =>
      acc +
      t.messages.filter(
        (m) => m.direction === "outbound" && m.status === "failed",
      ).length,
    0,
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="type-tagline text-[16px] text-dim mb-1">
            Agent managed
          </p>
          <h1 className="type-display text-[40px] leading-[0.9]">SMS AGENT</h1>
          <p className="type-mono mt-3 text-[10px] tracking-widest text-muted">
            OUTBOUND & INBOUND MESSAGE LOG
          </p>
        </div>
      </div>

      {/* Metrics Pills */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div
          className="panel panel-quiet bg-agent-sms p-4 border border-fg shadow-[2px_2px_0px_#000]"
          style={{ borderRadius: "0px" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2 font-bold">SENT TODAY</p>
          <p className="type-display text-[32px] text-fg">{sentTodayCount}</p>
        </div>
        <div
          className="panel panel-quiet bg-warn-soft p-4 border border-fg shadow-[2px_2px_0px_#000]"
          style={{ borderRadius: "0px" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2 font-bold">PENDING</p>
          <p className="type-display text-[32px] text-fg">{pendingCount}</p>
        </div>
        <div
          className="panel panel-quiet bg-danger-soft p-4 border border-fg shadow-[2px_2px_0px_#000]"
          style={{ borderRadius: "0px" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2 font-bold">FAILED</p>
          <p className="type-display text-[32px] text-fg">{failedCount}</p>
        </div>
      </div>

      {err && (
        <p className="inset-flat bg-warn-soft px-3 py-2 text-[12px] text-fg">
          {err}
        </p>
      )}

      {/* Compose Box */}
      <div
        className="panel bg-obsidian border-hairline shadow-none p-5"
        style={{ borderRadius: "var(--radius-md)" }}
      >
        <p className="type-mono text-[11px] text-muted mb-4 flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
          SEND VIA SMS AGENT
        </p>
        <ModePicker />
        <div className="space-y-3">
          <input
            value={newTo}
            onChange={(e) => setNewTo(e.target.value)}
            placeholder="+1 555 000 0000"
            className="field font-mono bg-void border-hairline shadow-none"
            aria-label="Recipient number"
          />
          <textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              mode === "call" ? "What should the call say?" : "Message body..."
            }
            className="field resize-none bg-void border-hairline shadow-none"
            aria-label={mode === "call" ? "Spoken script" : "Message body"}
          />
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={send}
              disabled={running || !body.trim() || !newTo.trim()}
              className="btn bg-agent-sms hover:bg-agent-sms text-fg border-none shadow-none px-6"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-3.5 mr-2"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
              {mode === "call" ? "Call" : "Send message"}
            </button>
          </div>
        </div>
      </div>

      {/* Log */}
      <div>
        <p className="type-mono text-[11px] text-muted mb-4 flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <path d="M12 18h.01" />
          </svg>
          MESSAGE LOG
        </p>
        <div
          className="panel bg-obsidian border-hairline p-0 overflow-hidden"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          {threads.length === 0 ? (
            <div className="p-8">
              <Empty>No messages yet.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {threads.map((t) => {
                const last = t.messages[t.messages.length - 1];
                return (
                  <li
                    key={t.peer}
                    className="p-4 hover:bg-elevated transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <p className="font-mono text-[13px] text-fg">{t.peer}</p>
                      <span className="shrink-0 type-mono text-[10px] text-muted">
                        {relTime(t.last_ts)}
                      </span>
                    </div>
                    <p className="text-[13px] text-dim line-clamp-1">
                      {last?.kind === "call" ? "☎ " : ""}
                      {last?.direction === "outbound" ? "You: " : ""}
                      {last?.body}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
