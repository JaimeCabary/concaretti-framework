/**
 * Email Hub — read the inbox, draft a reply, send through the gate.
 *
 * Sending is routed as a prompt to the orchestrator rather than posted to a send
 * endpoint. That is deliberate and it is the whole point: `send_email` is a HALO
 * trigger, so a UI path that called the tool directly would let the interface
 * bypass the oversight the system claims. The cost is one indirection; the
 * benefit is that the guarantee holds for every caller.
 *
 * Gmail credentials are optional. Without them the backend returns
 * `connected: false` with an explanation, and this renders that rather than an
 * empty inbox that looks like a bug.
 */

import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { EmailMessage } from "../types";
import { Chip, Empty } from "./ui";

export function EmailHub() {
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);

  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [connected, setConnected] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<EmailMessage | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    api
      .emails()
      .then((r) => {
        setMessages(r.messages ?? []);
        setConnected(r.connected);
        setNotice(r.connected ? null : (r.error ?? "Gmail is not connected."));
      })
      .catch((e: unknown) => {
        setConnected(false);
        setNotice(
          e instanceof ApiError && e.isPolicyRefusal
            ? e.message
            : e instanceof ApiError && e.isOffline
              ? "Offline — the inbox needs the backend."
              : e instanceof Error
                ? e.message
                : "Could not load the inbox",
        );
      });
  }, []);

  const send = () => {
    if (!selected || !draft.trim() || running) return;
    void runPrompt(
      `Reply to the email from ${selected.from} with subject "${selected.subject}". ` +
        `Send this message: ${draft.trim()}`,
    );
    setDraft("");
  };

  const suggest = () => {
    if (!selected || running) return;
    void runPrompt(
      `Draft a reply to this email — do not send it, just write the text.\n\n` +
        `From: ${selected.from}\nSubject: ${selected.subject}\n\n${selected.snippet}`,
    );
  };

  const unreadCount = messages.filter((m) => m.unread).length;
  const recentCount = messages.length;
  const draftsCount = draft ? 1 : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="type-tagline text-[16px] text-dim mb-1">
            Agent managed
          </p>
          <h1 className="type-display text-[40px] leading-[0.9]">
            EMAIL AGENT
          </h1>
          <p className="type-mono mt-3 text-[10px] tracking-widest text-muted">
            AI-ASSISTED INBOX & OUTREACH
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <div className="mr-2">
            <Chip tone={connected ? "ok" : "warn"}>
              {connected ? "Gmail connected" : "Not connected"}
            </Chip>
          </div>
        </div>
      </div>

      {/* Metrics Pills */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div
          className="panel panel-quiet bg-agent-email p-4 border border-fg shadow-[2px_2px_0px_#000]"
          style={{ borderRadius: "0px" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2 font-bold">UNREAD</p>
          <p className="type-display text-[32px] text-fg">{unreadCount}</p>
        </div>
        <div
          className="panel panel-quiet bg-elevated p-4 border border-fg shadow-[2px_2px_0px_#000]"
          style={{ borderRadius: "0px" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2 font-bold">RECENT</p>
          <p className="type-display text-[32px] text-fg">{recentCount}</p>
        </div>
        <div
          className="panel panel-quiet bg-warn-soft p-4 border border-fg shadow-[2px_2px_0px_#000]"
          style={{ borderRadius: "0px" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2 font-bold">DRAFTS</p>
          <p className="type-display text-[32px] text-fg">{draftsCount}</p>
        </div>
      </div>

      {notice && (
        <p className="inset-flat bg-warn-soft px-3 py-2 text-[12px] text-fg">
          {notice}
        </p>
      )}

      {/* Inbox or Thread View */}
      <div className="flex flex-col min-h-0">
        {!selected ? (
          <div className="flex flex-col">
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
                  d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"
                />
              </svg>
              INBOX
            </p>
            <div
              className="panel bg-obsidian border-hairline shadow-none p-0 overflow-hidden flex-1 max-h-[800px] overflow-y-auto"
              style={{ borderRadius: "var(--radius-md)" }}
            >
              <ul className="divide-y divide-hairline">
                {messages.length === 0 ? (
                  <div className="p-8 text-center">
                    <Empty>
                      {connected ? "Inbox is empty." : "No messages to show."}
                    </Empty>
                  </div>
                ) : (
                  messages.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(m);
                          setDraft("");
                        }}
                        className="w-full flex items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-elevated group"
                      >
                        <div className="shrink-0 w-32 md:w-48 truncate">
                          <span
                            className={`text-[13px] ${m.unread ? "font-bold text-fg" : "text-fg/80"}`}
                          >
                            {m.from}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0 truncate">
                          <span
                            className={`text-[13px] ${m.unread ? "font-bold text-fg" : "text-fg/90"}`}
                          >
                            {m.subject || "(no subject)"}
                          </span>
                          <span className="text-[13px] text-dim ml-2 hidden sm:inline">
                            — {m.snippet}
                          </span>
                        </div>
                        <div className="shrink-0 text-right w-24">
                          <span
                            className={`type-mono text-[10px] ${m.unread ? "font-bold text-fg" : "text-muted"}`}
                          >
                            {m.date}
                          </span>
                        </div>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <p className="type-mono text-[11px] text-muted flex items-center gap-2">
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
                MESSAGE THREAD
              </p>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="chip bg-void border-hairline hover:bg-elevated text-fg transition-colors"
              >
                ← Back to Inbox
              </button>
            </div>
            <div
              className="panel bg-obsidian border-hairline shadow-none p-6 flex flex-col max-h-[800px]"
              style={{ borderRadius: "var(--radius-md)" }}
            >
              <div className="flex-1 overflow-y-auto min-h-[200px] mb-6">
                <p className="text-[11px] text-muted">{selected.date}</p>
                <p className="mt-1 text-[20px] font-semibold text-fg">
                  {selected.subject || "(no subject)"}
                </p>
                <p className="text-[13px] text-dim mt-2">{selected.from}</p>
                <div
                  className="mt-6 p-5 bg-void border border-hairline"
                  style={{ borderRadius: "var(--radius)" }}
                >
                  <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg">
                    {selected.snippet}
                  </p>
                </div>
              </div>

              <div className="mt-auto space-y-4 pt-5 border-t border-hairline">
                <textarea
                  rows={4}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Write a reply, or ask an agent to draft one…"
                  className="field resize-none bg-void border-hairline shadow-none"
                  aria-label="Reply"
                />
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={suggest}
                    disabled={running}
                    className="btn bg-void border-hairline hover:bg-elevated text-fg px-5 py-2.5"
                  >
                    Draft via agent
                  </button>
                  <button
                    type="button"
                    onClick={send}
                    disabled={running || !draft.trim()}
                    className="btn bg-agent-email border-none hover:brightness-95 text-fg shadow-none px-8 py-2.5 font-medium"
                  >
                    Send message
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
