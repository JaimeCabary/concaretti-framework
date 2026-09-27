/**
 * Telecom Inbox — iMessage-style split pane.
 *
 * LEFT: contacts/thread list (scrolls internally)
 * RIGHT: conversation bubbles + pinned compose bar at bottom
 *
 * No page-level scroll. The panel claims 100% of the height given by StaffScreen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { SmsThread } from "../types";
import { Empty, relTime } from "./ui";

type Mode = "sms" | "call";

export function TelecomInbox() {
  const running = useAgentStore((s) => s.running);
  const finalSummary = useAgentStore((s) => s.finalSummary);
  const events = useAgentStore((s) => s.events);
  const track = useAgentStore((s) => s.trackSpawned);

  const [threads, setThreads] = useState<SmsThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePeer, setActivePeer] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [newTo, setNewTo] = useState("");
  const [mode, setMode] = useState<Mode>("sms");
  const [err, setErr] = useState<string | null>(null);
  const bubbleEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    void api
      .smsThreads()
      .then((r) => {
        setThreads(r.threads);
        setErr(null);
        // Auto-select first thread if none active
        if (r.threads.length > 0 && !activePeer) {
          setActivePeer(r.threads[0].peer);
        }
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
      )
      .finally(() => setLoading(false));
  }, [activePeer]);

  useEffect(load, [load]);

  useEffect(() => {
    if (finalSummary) load();
  }, [finalSummary, load]);

  useEffect(() => {
    const last = events[events.length - 1];
    if (last?.type === "activity" && String(last.message ?? "").startsWith("SMS from")) {
      load();
    }
  }, [events, load]);

  // Scroll bubbles to bottom when active thread or messages change
  useEffect(() => {
    bubbleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activePeer, threads]);

  const activeThread = threads.find((t) => t.peer === activePeer) ?? null;

  const send = () => {
    const text = body.trim();
    const to = activePeer ?? newTo.trim();
    if (!text || !to || running) return;
    void (mode === "call" ? api.placeCall(to, text) : api.sendSms(to, text))
      .then(track)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Send failed"));
    setBody("");
    setNewTo("");
    setTimeout(load, 1200);
  };

  // Stats
  const sentToday = threads.reduce(
    (a, t) => a + t.messages.filter((m) => m.direction === "outbound" && m.status === "delivered").length, 0
  );
  const pending = threads.reduce(
    (a, t) => a + t.messages.filter((m) => m.direction === "outbound" && (m.status === "queued" || m.status === "sending" || m.pending_approval)).length, 0
  );
  const failed = threads.reduce(
    (a, t) => a + t.messages.filter((m) => m.direction === "outbound" && m.status === "failed").length, 0
  );

  return (
    <div className="flex flex-col h-full">
      {/* ── Top header bar ── */}
      <div className="shrink-0 flex items-center justify-between border-b border-hairline px-5 py-3 bg-void">
        <div>
          <h1 className="type-display text-[22px] leading-none">TELECOM AGENT</h1>
        </div>
        {/* Stats row */}
        <div className="flex gap-4">
          <div className="text-center">
            <p className="type-mono text-[18px] font-bold text-fg">{sentToday}</p>
            <p className="type-mono text-[9px] text-muted uppercase">Sent</p>
          </div>
          <div className="text-center">
            <p className="type-mono text-[18px] font-bold text-fg">{pending}</p>
            <p className="type-mono text-[9px] text-muted uppercase">Pending</p>
          </div>
          <div className="text-center">
            <p className={`type-mono text-[18px] font-bold ${failed > 0 ? "text-danger" : "text-fg"}`}>{failed}</p>
            <p className="type-mono text-[9px] text-muted uppercase">Failed</p>
          </div>
          <div className="text-center">
            <p className="type-mono text-[18px] font-bold text-fg">{threads.length}</p>
            <p className="type-mono text-[9px] text-muted uppercase">Threads</p>
          </div>
        </div>
      </div>

      {err && (
        <div className="shrink-0 border-b border-danger-soft bg-danger-soft px-4 py-1.5 text-[11px] text-danger font-semibold">
          ⚠ {err}
        </div>
      )}

      {/* ── Split pane ── */}
      <div className="flex flex-1 min-h-0">

        {/* LEFT: Contacts / thread list */}
        <div className="flex flex-col w-[280px] shrink-0 border-r border-hairline">
          <div className="shrink-0 px-4 py-2.5 border-b border-hairline bg-obsidian/30">
            <p className="type-mono text-[9px] text-muted uppercase tracking-widest">Conversations</p>
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* New conversation row */}
            <button
              className={`w-full text-left px-4 py-3 border-b border-hairline/60 transition-colors hover:bg-agent-sms/20 ${activePeer === null ? "bg-agent-sms/30" : ""}`}
              onClick={() => { setActivePeer(null); setNewTo(""); setBody(""); }}
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-agent-sms border border-fg flex items-center justify-center shrink-0">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4 text-fg">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-fg">New message</p>
                  <p className="type-mono text-[10px] text-muted">Send to a new number</p>
                </div>
              </div>
            </button>

            {loading && threads.length === 0 ? (
              <div className="p-4 space-y-3 animate-pulse">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3 py-1">
                    <div className="size-9 rounded-full bg-fg/10 shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-3/4 bg-fg/15 rounded" />
                      <div className="h-2 w-1/2 bg-fg/10 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : threads.length === 0 ? (
              <div className="p-6">
                <Empty>No conversations yet. The agent will populate this when it sends or receives messages.</Empty>
              </div>
            ) : (
              threads.map((t) => {
                const last = t.messages[t.messages.length - 1];
                const hasPending = t.messages.some((m) => m.pending_approval);
                return (
                  <button
                    key={t.peer}
                    className={`w-full text-left px-4 py-3 border-b border-hairline/60 transition-colors hover:bg-agent-sms/20 ${activePeer === t.peer ? "bg-agent-sms/30" : ""}`}
                    onClick={() => setActivePeer(t.peer)}
                  >
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                      <div className="w-9 h-9 rounded-full bg-obsidian border border-hairline flex items-center justify-center shrink-0 text-[13px] font-bold text-fg uppercase">
                        {t.peer.replace(/\D/g, "").slice(-2) || "?"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between items-baseline">
                          <p className="type-mono text-[12px] font-bold text-fg truncate">{t.peer}</p>
                          <span className="type-mono text-[9px] text-muted shrink-0 ml-1">{relTime(t.last_ts)}</span>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          {hasPending && <span className="w-1.5 h-1.5 rounded-full bg-warn-soft border border-fg shrink-0"></span>}
                          <p className="text-[11px] text-muted truncate">
                            {last?.kind === "call" ? "☎ " : last?.direction === "outbound" ? "You: " : ""}
                            {last?.body}
                          </p>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* RIGHT: Conversation view */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {activePeer && activeThread ? (
            <>
              {/* Contact header */}
              <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-hairline bg-obsidian/20">
                <div className="w-8 h-8 rounded-full bg-obsidian border border-hairline flex items-center justify-center text-[12px] font-bold text-fg uppercase">
                  {activePeer.replace(/\D/g, "").slice(-2) || "?"}
                </div>
                <div>
                  <p className="type-mono text-[13px] font-bold text-fg">{activePeer}</p>
                  <p className="type-mono text-[9px] text-muted">{activeThread.messages.length} messages</p>
                </div>
                <div className="ml-auto flex gap-2">
                  {(["sms", "call"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`chip text-[10px] ${mode === m ? "bg-agent-sms border-fg" : ""}`}
                    >
                      {m === "sms" ? "💬 Text" : "📞 Call"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Chat bubbles */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {activeThread.messages.map((msg, i) => {
                  const isOut = msg.direction === "outbound";
                  return (
                    <div key={i} className={`flex flex-col ${isOut ? "items-end" : "items-start"}`}>
                      {msg.kind === "call" ? (
                        <div className={`max-w-[75%] p-3 rounded-xl border text-[12px] space-y-1.5 shadow-2xs ${
                          isOut
                            ? "bg-agent-sms/20 border-agent-sms/60 text-fg rounded-br-sm"
                            : "bg-void border-hairline text-fg rounded-bl-sm"
                        }`}>
                          <div className="flex items-center justify-between gap-2 border-b border-hairline/60 pb-1">
                            <span className="type-mono text-[10px] font-bold text-fg flex items-center gap-1.5">
                              <span>📞</span>
                              <span>{isOut ? "Outbound Voice Call" : "Incoming Voice Call"}</span>
                            </span>
                            <span className="type-mono text-[9px] text-muted">{relTime(msg.ts)}</span>
                          </div>
                          <p className="text-[12px] leading-relaxed italic text-dim">
                            "{msg.body || "Voice conversation conducted by Telecom Agent"}"
                          </p>
                          {msg.status && (
                            <div className="flex items-center justify-between text-[10px] type-mono pt-1 text-muted">
                              <span>Status: <span className={msg.status === "completed" || msg.status === "delivered" ? "text-ok font-semibold" : "text-fg"}>{msg.status}</span></span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className={`max-w-[70%] px-4 py-2.5 rounded-2xl text-[13px] leading-relaxed shadow-sm ${
                          isOut
                            ? "bg-agent-sms border border-fg/20 text-fg rounded-br-sm"
                            : "bg-void border border-hairline text-fg rounded-bl-sm"
                        }`}>
                          {msg.pending_approval && (
                            <p className="type-mono text-[9px] text-muted mb-1 flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-warn-soft border border-fg animate-pulse"></span>
                              Awaiting HALO approval
                            </p>
                          )}
                          {msg.body}
                          <div className={`flex items-center gap-1 mt-1 ${isOut ? "justify-end" : "justify-start"}`}>
                            <span className="type-mono text-[9px] text-muted">{relTime(msg.ts)}</span>
                            {isOut && msg.status && (
                              <span className={`type-mono text-[9px] ${msg.status === "failed" ? "text-danger" : msg.status === "delivered" ? "text-ok" : "text-muted"}`}>
                                · {msg.status}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                <div ref={bubbleEndRef} />
              </div>

              {/* Compose bar — pinned at bottom */}
              <div className="shrink-0 border-t border-hairline bg-void px-4 py-3">
                <div className="flex items-end gap-3">
                  <textarea
                    rows={2}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder={mode === "call" ? "Script for the call…" : "Message…"}
                    className="field flex-1 resize-none text-[13px] min-h-[44px]"
                  />
                  <button
                    type="button"
                    onClick={send}
                    disabled={running || !body.trim()}
                    className="btn bg-agent-sms border-fg shrink-0 px-4 py-2 h-[44px] flex items-center gap-2 text-[12px] font-bold"
                  >
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                    {mode === "call" ? "Call" : "Send"}
                  </button>
                </div>
                <p className="type-mono text-[9px] text-muted mt-1.5">Enter to send · Shift+Enter for new line · All messages pass through HALO gate</p>
              </div>
            </>
          ) : (
            /* New conversation composer */
            <div className="flex flex-col flex-1 min-h-0">
              <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-hairline bg-obsidian/20">
                <p className="type-mono text-[11px] text-muted uppercase tracking-widest">New Conversation</p>
                <div className="ml-auto flex gap-2">
                  {(["sms", "call"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`chip text-[10px] ${mode === m ? "bg-agent-sms border-fg" : ""}`}
                    >
                      {m === "sms" ? "💬 Text" : "📞 Call"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 flex flex-col items-center justify-center p-8 gap-6">
                <svg viewBox="0 0 24 24" className="w-16 h-16 text-muted" fill="none" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                <p className="text-[14px] text-dim text-center max-w-sm">
                  The agent handles messaging automatically. You can also compose manually below.
                </p>
              </div>

              {/* New number compose bar */}
              <div className="shrink-0 border-t border-hairline bg-void px-4 py-3 space-y-2">
                <input
                  value={newTo}
                  onChange={(e) => setNewTo(e.target.value)}
                  placeholder="Recipient number e.g. +2349136356595"
                  className="field w-full font-mono text-[12px]"
                  aria-label="Recipient number"
                />
                <div className="flex items-end gap-3">
                  <textarea
                    rows={2}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder={mode === "call" ? "Script for the call…" : "Message body…"}
                    className="field flex-1 resize-none text-[13px]"
                  />
                  <button
                    type="button"
                    onClick={send}
                    disabled={running || !body.trim() || !newTo.trim()}
                    className="btn bg-agent-sms border-fg shrink-0 px-4 py-2 h-[44px] flex items-center gap-2 text-[12px] font-bold"
                  >
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                    {mode === "call" ? "Call" : "Send"}
                  </button>
                </div>
                <p className="type-mono text-[9px] text-muted">All messages pass through HALO gate before delivery</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
