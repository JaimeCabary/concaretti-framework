/**
 * Email Hub — 3-pane Gmail-style layout.
 *
 * LEFT   — inbox list (decoded HTML entities, unread indicators, avatar initials)
 * RIGHT  — full email reading pane with live body fetching, rich HTML & clean LaTeX/Reader modes
 *
 * "Compose new" button opens draft composer.
 * Zero truncated emails, clean typography.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { EmailMessage } from "../types";
import { Chip, Empty } from "./ui";

type RightView = "email" | "compose" | null;

export function decodeHtml(text: string): string {
  if (!text) return "";
  let res = text
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "’")
    .replace(/&#8216;/g, "‘")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8212;/g, "—")
    .replace(/&#8211;/g, "–")
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCharCode(Number(dec));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return "";
      }
    });
  return res;
}

function renderLatexAndText(rawText: string) {
  const decoded = decodeHtml(rawText);
  const paragraphs = decoded.split(/\n\s*\n/);

  return (
    <div className="space-y-3 text-[14px] leading-relaxed select-text font-sans text-fg">
      {paragraphs.map((p, pIdx) => {
        const text = p.trim();
        if (!text) return null;

        // Replace common LaTeX symbol tokens for clean visual math presentation
        const mathCleaned = text
          .replace(/\\times/g, "×")
          .replace(/\\div/g, "÷")
          .replace(/\\pm/g, "±")
          .replace(/\\approx/g, "≈")
          .replace(/\\neq/g, "≠")
          .replace(/\\leq/g, "≤")
          .replace(/\\geq/g, "≥")
          .replace(/\\infty/g, "∞")
          .replace(/\\alpha/g, "α")
          .replace(/\\beta/g, "β")
          .replace(/\\pi/g, "π")
          .replace(/\\theta/g, "θ")
          .replace(/\\sigma/g, "σ")
          .replace(/\\mu/g, "μ");

        // Format math block $ ... $ or inline text
        return (
          <p key={pIdx} className="leading-relaxed whitespace-pre-wrap">
            {mathCleaned}
          </p>
        );
      })}
    </div>
  );
}

export function EmailHub() {
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);
  const messages = useAgentStore((s) => s.emails);
  const loading = useAgentStore((s) => s.emailsLoading);
  const connected = useAgentStore((s) => s.emailsConnected);
  const notice = useAgentStore((s) => s.emailsNotice);
  const refreshEmails = useAgentStore((s) => s.refreshEmails);

  const [selected, setSelected] = useState<EmailMessage | null>(null);
  const [fullMessage, setFullMessage] = useState<EmailMessage | null>(null);
  const [fetchingBody, setFetchingBody] = useState(false);
  const [viewMode, setViewMode] = useState<"rich" | "reader">("rich");

  const [rightView, setRightView] = useState<RightView>(null);
  const [dismissNotice, setDismissNotice] = useState(false);
  const [draft, setDraft] = useState("");
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");

  useEffect(() => {
    if (messages.length === 0 && !loading) void refreshEmails();
  }, [messages.length, loading, refreshEmails]);

  // Auto-select first email once loaded
  useEffect(() => {
    if (messages.length > 0 && !selected && rightView === null) {
      setSelected(messages[0]);
      setRightView("email");
    }
  }, [messages, selected, rightView]);

  // When selected email changes, fetch its full body from /api/email/:id
  useEffect(() => {
    if (!selected) {
      setFullMessage(null);
      return;
    }
    setFetchingBody(true);
    let cancelled = false;

    void api
      .email(selected.id)
      .then((res) => {
        if (cancelled) return;
        if (res && res.message) {
          setFullMessage(res.message);
        } else {
          setFullMessage(selected);
        }
      })
      .catch(() => {
        if (!cancelled) setFullMessage(selected);
      })
      .finally(() => {
        if (!cancelled) setFetchingBody(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  const sendReply = () => {
    if (!selected || !draft.trim() || running) return;
    void runPrompt(
      `Reply to the email from ${selected.from} with subject "${selected.subject}". ` +
        `Send this message: ${draft.trim()}`,
    );
    setDraft("");
  };

  const sendNew = () => {
    if (!composeTo.trim() || !composeBody.trim() || running) return;
    void runPrompt(
      `Send an email to ${composeTo.trim()} with subject "${composeSubject.trim() || "(no subject)"}" and body: ${composeBody.trim()}`,
    );
    setComposeTo("");
    setComposeSubject("");
    setComposeBody("");
    setRightView(null);
  };

  const suggestReply = () => {
    if (!selected || running) return;
    const bodySnippet = fullMessage?.body ? fullMessage.body.slice(0, 600) : selected.snippet;
    void runPrompt(
      `Draft a reply to this email — do not send it, just write the text.\n\n` +
        `From: ${selected.from}\nSubject: ${selected.subject}\n\n${bodySnippet}`,
    );
  };

  const unreadCount = messages.filter((m) => m.unread).length;

  const getInitials = (from: string) => {
    const clean = decodeHtml(from);
    const name = clean.replace(/<[^>]+>/g, "").trim() || clean;
    const match = name.match(/[a-zA-Z]/);
    return match ? match[0].toUpperCase() : "?";
  };

  const stringToColor = (str: string) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 82%)`;
  };

  const formatShortDate = (dateStr: string) => {
    try {
      const cleanDate = dateStr.replace(/\([A-Z]{3,4}\)/i, "").trim();
      const d = new Date(cleanDate);
      if (isNaN(d.getTime())) return dateStr.split(" ")[0] || dateStr;
      const now = new Date();
      if (d.toDateString() === now.toDateString())
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    } catch {
      return dateStr;
    }
  };

  const activeBody = fullMessage?.body || selected?.snippet || "";
  const isHtml = /<[a-z][\s\S]*>/i.test(activeBody);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Top bar ── */}
      <div className="shrink-0 flex items-center justify-between border-b border-hairline px-5 py-3 bg-void">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="type-display text-[22px] leading-none">EMAIL AGENT</h1>
          </div>
          <Chip tone={connected ? "ok" : "warn"}>
            {connected ? "Gmail Connected" : "Not connected"}
          </Chip>
        </div>
        <div className="flex items-center gap-2">
          {/* Stats */}
          <div className="flex gap-4 mr-4">
            <div className="text-center">
              <p className="type-mono text-[17px] font-bold text-fg">{unreadCount}</p>
              <p className="type-mono text-[9px] text-muted uppercase">Unread</p>
            </div>
            <div className="text-center">
              <p className="type-mono text-[17px] font-bold text-fg">{messages.length}</p>
              <p className="type-mono text-[9px] text-muted uppercase">Total</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setRightView("compose");
              setSelected(null);
            }}
            className="btn btn-primary size-8 p-0 rounded-lg flex items-center justify-center shadow-xs cursor-pointer hover:brightness-105 active:scale-95 transition-transform shrink-0"
            title="Compose new message"
            aria-label="Compose new message"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => void refreshEmails()}
            disabled={loading}
            className="btn px-3 py-1.5 text-[12px] flex items-center gap-1.5 cursor-pointer disabled:opacity-70 rounded-lg border-hairline bg-void hover:bg-obsidian/40"
            title="Refresh emails"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className={`size-3.5 shrink-0 ${loading ? "animate-spin text-fg" : "text-fg/80"}`}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
            <span>{loading ? "Syncing…" : "Sync"}</span>
          </button>
        </div>
      </div>

      {notice && !dismissNotice && (
        <div className="shrink-0 flex items-center justify-between border-b border-hairline bg-obsidian/60 px-5 py-2 text-[11px] text-dim">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-warn shrink-0" />
            <span>{notice}</span>
          </div>
          <button
            type="button"
            onClick={() => setDismissNotice(true)}
            className="text-muted hover:text-fg text-[12px] p-0.5 cursor-pointer ml-2"
            title="Dismiss banner"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Split pane ── */}
      <div className="flex flex-1 min-h-0">
        {/* LEFT: Inbox list */}
        <div className="flex flex-col w-[340px] shrink-0 border-r border-hairline bg-void">
          <div className="shrink-0 px-4 py-2.5 border-b border-hairline bg-obsidian/20 flex items-center justify-between">
            <p className="type-mono text-[10px] text-muted uppercase tracking-widest font-bold">Inbox</p>
            {unreadCount > 0 && (
              <span className="type-mono text-[9px] font-bold text-fg bg-agent-email px-2 py-0.5 rounded">
                {unreadCount} UNREAD
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-hairline/60">
            {loading && messages.length === 0 ? (
              <div className="p-4 space-y-3 animate-pulse">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="flex items-center gap-3 py-2">
                    <div className="size-8 rounded-full bg-fg/10 shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-3/4 bg-fg/15 rounded" />
                      <div className="h-2.5 w-full bg-fg/10 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : messages.length === 0 ? (
              <div className="p-8">
                <Empty>{connected ? "Inbox is empty." : "Connect Gmail in Settings to see emails."}</Empty>
              </div>
            ) : (
              messages.map((m) => {
                const isCurrent = selected?.id === m.id && rightView === "email";
                const cleanSubject = decodeHtml(m.subject || "(no subject)");
                const cleanFrom = decodeHtml(m.from.replace(/<[^>]+>/g, "").trim() || m.from);
                const cleanSnippet = decodeHtml(m.snippet);

                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setSelected(m);
                      setRightView("email");
                      setDraft("");
                    }}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors cursor-pointer ${
                      isCurrent
                        ? "bg-agent-email/25 border-l-3 border-agent-email"
                        : m.unread
                          ? "bg-void hover:bg-obsidian/30"
                          : "bg-obsidian/15 hover:bg-obsidian/35 opacity-85 hover:opacity-100"
                    }`}
                  >
                    {/* Unread indicator */}
                    <div className="shrink-0 mt-2">
                      <span
                        className={`block size-2 rounded-full ${
                          m.unread ? "bg-amber-500 ring-2 ring-amber-500/20" : "bg-transparent"
                        }`}
                      />
                    </div>

                    {/* Avatar */}
                    <div
                      className="shrink-0 size-8 rounded-full flex items-center justify-center text-[12px] font-bold text-fg/90 border border-fg/15 mt-0.5"
                      style={{ backgroundColor: stringToColor(m.from) }}
                    >
                      {getInitials(m.from)}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline gap-1">
                        <span className={`text-[12px] truncate ${m.unread ? "font-bold text-fg" : "text-fg/80"}`}>
                          {cleanFrom}
                        </span>
                        <span className={`type-mono text-[9.5px] shrink-0 ${m.unread ? "text-fg font-semibold" : "text-muted"}`}>
                          {formatShortDate(m.date)}
                        </span>
                      </div>
                      <p className={`text-[12px] truncate mt-0.5 ${m.unread ? "font-semibold text-fg" : "text-fg/70"}`}>
                        {cleanSubject}
                      </p>
                      <p className="text-[11px] text-muted truncate mt-0.5 font-sans leading-relaxed">
                        {cleanSnippet}
                      </p>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* RIGHT: reading pane or compose */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0 bg-void">
          {rightView === "compose" ? (
            /* ── Compose new email ── */
            <>
              <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-hairline bg-obsidian/20">
                <p className="type-mono text-[11px] text-muted uppercase tracking-widest font-bold">New Message</p>
                <button
                  type="button"
                  onClick={() => setRightView(selected ? "email" : null)}
                  className="chip text-[10px] cursor-pointer"
                >
                  ✕ Discard
                </button>
              </div>
              <div className="flex-1 flex flex-col p-5 gap-3 overflow-y-auto">
                <input
                  value={composeTo}
                  onChange={(e) => setComposeTo(e.target.value)}
                  placeholder="To: recipient@email.com"
                  className="field text-[13px]"
                  aria-label="To"
                />
                <input
                  value={composeSubject}
                  onChange={(e) => setComposeSubject(e.target.value)}
                  placeholder="Subject"
                  className="field text-[13px]"
                  aria-label="Subject"
                />
                <textarea
                  value={composeBody}
                  onChange={(e) => setComposeBody(e.target.value)}
                  placeholder="Write your message here…"
                  className="field flex-1 resize-none text-[13px] min-h-[200px]"
                  aria-label="Body"
                />
                <p className="type-mono text-[9px] text-muted">
                  Message will be sent through the Email Agent — it passes the HALO approval gate before delivery.
                </p>
              </div>
              <div className="shrink-0 border-t border-hairline bg-void px-5 py-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (!composeTo.trim() || running) return;
                    void runPrompt(`Draft an email to ${composeTo.trim()} about "${composeSubject.trim() || "no subject"}" — do not send yet, just write a draft`);
                  }}
                  disabled={running || !composeTo.trim()}
                  className="btn text-[12px] px-4 py-2"
                >
                  ✦ Draft with AI
                </button>
                <button
                  type="button"
                  onClick={sendNew}
                  disabled={running || !composeTo.trim() || !composeBody.trim()}
                  className="btn btn-primary text-[12px] px-6 py-2 font-bold ml-auto"
                >
                  Send via Agent
                </button>
              </div>
            </>
          ) : rightView === "email" && selected ? (
            /* ── Reading pane ── */
            <>
              {/* Email header */}
              <div className="shrink-0 px-6 py-4 border-b border-hairline bg-void">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[20px] font-bold text-fg leading-snug tracking-tight">
                      {decodeHtml(selected.subject || "(no subject)")}
                    </h2>
                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      <div
                        className="size-7 rounded-full flex items-center justify-center border border-fg/20 text-[12px] font-bold text-fg/90 shrink-0"
                        style={{ backgroundColor: stringToColor(selected.from) }}
                      >
                        {getInitials(selected.from)}
                      </div>
                      <span className="text-[13px] font-semibold text-fg">
                        {decodeHtml(selected.from)}
                      </span>
                      <span className="type-mono text-[10px] text-muted border-l border-hairline pl-3">
                        {selected.date}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {/* View Switcher Toggle if body has HTML */}
                    {isHtml && (
                      <div className="flex border border-hairline rounded-lg p-0.5 bg-obsidian/30 mr-1">
                        <button
                          type="button"
                          onClick={() => setViewMode("rich")}
                          className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-colors cursor-pointer ${
                            viewMode === "rich" ? "bg-fg text-void shadow-2xs" : "text-muted hover:text-fg"
                          }`}
                        >
                          Rich HTML
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewMode("reader")}
                          className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-colors cursor-pointer ${
                            viewMode === "reader" ? "bg-fg text-void shadow-2xs" : "text-muted hover:text-fg"
                          }`}
                        >
                          Clean Reader
                        </button>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={suggestReply}
                      disabled={running}
                      className="btn text-[11px] px-3 py-1.5 flex items-center gap-1.5 cursor-pointer rounded-lg border-hairline bg-void hover:bg-obsidian/40"
                    >
                      ✦ AI Draft
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setComposeTo(selected.from);
                        setComposeSubject(`Re: ${decodeHtml(selected.subject)}`);
                        setComposeBody("");
                        setRightView("compose");
                      }}
                      className="btn btn-primary text-[11px] px-3.5 py-1.5 flex items-center gap-1.5 font-bold cursor-pointer rounded-lg shadow-xs"
                    >
                      ↩ Reply
                    </button>
                  </div>
                </div>
              </div>

              {/* Email body container — clean rendering */}
              <div className="flex-1 overflow-y-auto p-6 bg-void">
                {fetchingBody ? (
                  <div className="space-y-4 animate-pulse p-4">
                    <div className="h-4 bg-fg/10 rounded w-3/4" />
                    <div className="h-4 bg-fg/10 rounded w-full" />
                    <div className="h-4 bg-fg/10 rounded w-5/6" />
                    <div className="h-4 bg-fg/10 rounded w-2/3" />
                  </div>
                ) : isHtml && viewMode === "rich" ? (
                  <div className="w-full h-full min-h-[500px] rounded-xl overflow-hidden border border-hairline/80 bg-white shadow-xs">
                    <iframe
                      title="Email Content"
                      srcDoc={`
                        <!DOCTYPE html>
                        <html>
                          <head>
                            <meta charset="utf-8">
                            <base target="_blank">
                            <style>
                              body {
                                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                                color: #1c1917;
                                background-color: #ffffff;
                                padding: 24px;
                                margin: 0;
                                line-height: 1.6;
                                font-size: 14px;
                                word-break: break-word;
                              }
                              img { max-width: 100% !important; height: auto !important; }
                              a { color: #2563eb; text-decoration: underline; }
                              table { max-width: 100% !important; }
                            </style>
                          </head>
                          <body>
                            ${activeBody}
                          </body>
                        </html>
                      `}
                      className="w-full h-full border-0 min-h-[520px]"
                      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
                    />
                  </div>
                ) : (
                  <div className="bg-obsidian/20 border border-hairline p-6 rounded-xl shadow-2xs">
                    {renderLatexAndText(
                      isHtml
                        ? activeBody.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "\n").replace(/\n{3,}/g, "\n\n")
                        : activeBody
                    )}
                  </div>
                )}
              </div>

              {/* Inline reply bar — pinned at bottom */}
              <div className="shrink-0 border-t border-hairline bg-void px-6 py-3.5">
                <p className="type-mono text-[9px] text-muted uppercase tracking-widest mb-2 font-bold">Quick Reply</p>
                <div className="flex items-end gap-3">
                  <textarea
                    rows={2}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.metaKey) {
                        e.preventDefault();
                        sendReply();
                      }
                    }}
                    placeholder="Write a reply… (⌘Enter to send)"
                    className="field flex-1 resize-none text-[13px] min-h-[52px]"
                    aria-label="Reply"
                  />
                  <button
                    type="button"
                    onClick={sendReply}
                    disabled={running || !draft.trim()}
                    className="btn btn-primary shrink-0 px-5 py-2 h-[52px] text-[12px] font-bold rounded-lg shadow-xs cursor-pointer"
                  >
                    Send Reply
                  </button>
                </div>
              </div>
            </>
          ) : loading && messages.length === 0 ? (
            /* Loading Reading Pane Skeleton */
            <div className="p-8 space-y-4 animate-pulse flex-1">
              <div className="h-6 bg-fg/10 rounded w-2/3" />
              <div className="h-4 bg-fg/10 rounded w-1/3" />
              <div className="h-px bg-hairline my-4" />
              <div className="space-y-2.5">
                <div className="h-3.5 bg-fg/10 rounded w-full" />
                <div className="h-3.5 bg-fg/10 rounded w-5/6" />
                <div className="h-3.5 bg-fg/10 rounded w-4/6" />
              </div>
            </div>
          ) : (
            /* Empty state */
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
              <svg viewBox="0 0 24 24" className="w-14 h-14 text-muted/60" fill="none" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
              <p className="text-[14px] font-medium text-fg">Select an email to view conversation</p>
              <p className="type-mono text-[11px] text-muted">Use the pen icon above to compose or ask the Email Agent in chat</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
