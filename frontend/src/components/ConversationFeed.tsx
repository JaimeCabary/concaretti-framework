/**
 * Sequential Conversational Feed.
 *
 * Renders conversation turns sequentially:
 * - User prompt bubble with avatar, timestamp, and any attached file chips.
 * - Assistant turn with a clearly separated, collapsible "Thought Process" card
 *   (showing reasoning trace, subtask execution, and agent badges), followed by
 *   the final Markdown response and any produced artifacts.
 *
 * Persists all turns across follow-up prompts within the session.
 */

import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "../store/agentStore";
import type { ChatTurn, Role, SseEvent } from "../types";
import { AgentTag, StatusBadge, relTime } from "./ui";

function ThoughtRow({ event }: { event: SseEvent }) {
  const isError = event.type === "error";
  const text = String(event.text ?? event.message ?? "");
  if (!text) return null;

  const agent = typeof event.agent === "string" ? event.agent : "";
  const body =
    agent && text.startsWith(`${agent}:`)
      ? text.slice(agent.length + 1).trim()
      : text;

  return (
    <div className="flex items-start gap-2 text-[12px] py-1 border-b border-hairline/20 last:border-0">
      {agent && <AgentTag agent={agent} className="shrink-0" />}
      <p className={`whitespace-pre-wrap leading-relaxed ${isError ? "text-danger" : "text-dim"}`}>
        {body}
      </p>
    </div>
  );
}

function TurnThoughts({ turn, isLatest = false }: { turn: ChatTurn; isLatest?: boolean }) {
  const isRunning = turn.status === "running";
  const [open, setOpen] = useState(isRunning || isLatest);

  // Filter out any background sentinel heartbeats or stream connection artifacts
  const thoughts = (turn.thoughts || []).filter(
    (t) => {
      const msg = String(t.text ?? t.message ?? "");
      return (
        !/\[sentinel\b/i.test(msg) &&
        !/^(stream connected|connected|keepalive)$/i.test(msg.trim()) &&
        t.agent !== "sentinel"
      );
    },
  );
  const subtasks = turn.subtasks || [];

  // Auto-open while running or if it is the latest turn
  useEffect(() => {
    if (isRunning || isLatest) setOpen(true);
  }, [isRunning, isLatest]);

  if (thoughts.length === 0 && subtasks.length === 0 && !isRunning) {
    return null;
  }

  const agentsUsed = Array.from(
    new Set([
      ...thoughts.map((t) => t.agent).filter(Boolean),
      ...subtasks.map((s) => s.agent).filter(Boolean),
    ]),
  ) as string[];

  return (
    <div className="my-3 rounded-lg border border-hairline/70 bg-obsidian/60 overflow-hidden shadow-2xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 bg-elevated/40 hover:bg-elevated text-left transition-colors cursor-pointer group"
      >
        <div className="flex items-center gap-2 min-w-0 pr-2">
          {/* Explicit Chevron Right (collapsed) and Chevron Down (expanded) */}
          <svg
            viewBox="0 0 24 24"
            className={`size-4 shrink-0 text-muted transition-transform duration-200 ${
              open ? "rotate-90 text-fg" : "group-hover:text-fg"
            }`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>

          {isRunning ? (
            <span className="size-2 shrink-0 rounded-full bg-[#00E5FF] animate-pulse" />
          ) : (
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-ok" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          )}

          <span className="text-[12px] font-semibold text-fg tracking-wide truncate">
            {isRunning ? "Council Deliberating & Executing" : "Thought Process"}
          </span>

          <span className="text-[11px] text-muted truncate min-w-0">
            · {subtasks.length} step(s) {thoughts.length > 0 ? `· ${thoughts.length} trace(s)` : ""}
          </span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-1.5 flex-nowrap">
            {agentsUsed.slice(0, 3).map((a) => (
              <AgentTag key={a} agent={a} />
            ))}
          </div>

          <span className="text-[11px] text-muted hidden sm:inline">
            {open ? "collapse" : "view"}
          </span>
        </div>
      </button>

      {open && (
        <div className="p-3 bg-void/50 space-y-3">
          {subtasks.length === 0 && thoughts.length === 0 && isRunning && (
            <div className="space-y-2.5 py-1">
              <div className="flex items-center justify-between text-[11px] text-fg font-medium">
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-[#00E5FF] animate-ping" />
                  <span className="text-[#00E5FF] font-semibold">Council convened · Decomposing task & dispatching agents...</span>
                </span>
                <span className="text-[10px] text-muted font-medium">ACTIVE</span>
              </div>
              <div className="space-y-1.5 animate-pulse">
                <div className="h-8 rounded-lg bg-obsidian/80 border border-hairline/60 flex items-center px-3 gap-2.5">
                  <span className="size-2 rounded-full bg-blue-400 shrink-0 animate-pulse" />
                  <span className="text-[11px] text-fg font-semibold">orchestrator</span>
                  <div className="h-2.5 bg-fg/15 rounded w-1/3" />
                  <div className="h-2 bg-fg/10 rounded w-1/4 ml-auto" />
                </div>
                <div className="h-8 rounded-lg bg-obsidian/80 border border-hairline/60 flex items-center px-3 gap-2.5">
                  <span className="size-2 rounded-full bg-purple-400 shrink-0 animate-pulse" />
                  <span className="text-[11px] text-fg font-semibold">rotator</span>
                  <div className="h-2.5 bg-fg/15 rounded w-1/4" />
                  <div className="h-2 bg-fg/10 rounded w-1/3 ml-auto" />
                </div>
                <div className="h-8 rounded-lg bg-obsidian/80 border border-hairline/60 flex items-center px-3 gap-2.5">
                  <span className="size-2 rounded-full bg-amber-400 shrink-0 animate-pulse" />
                  <span className="text-[11px] text-fg font-semibold">policy</span>
                  <div className="h-2.5 bg-fg/15 rounded w-2/5" />
                  <div className="h-2 bg-fg/10 rounded w-1/5 ml-auto" />
                </div>
              </div>
            </div>
          )}

          {subtasks.length > 0 && (
            <div className="space-y-1.5 pb-2 border-b border-hairline/30">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Execution Plan</p>
              <div className="space-y-1">
                {subtasks.map((st) => (
                  <div key={st.id} className="space-y-1 py-1.5 px-2.5 rounded bg-obsidian/40 border border-hairline/40">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <div className="flex items-center gap-2 min-w-0">
                        <AgentTag agent={st.agent} />
                        <span className="truncate text-fg font-medium">{st.description || st.task_type}</span>
                      </div>
                      <StatusBadge status={st.status} />
                    </div>
                    {st.error && (
                      <p className="text-[10px] text-danger font-mono truncate px-1">
                        ⚠ {st.error}
                      </p>
                    )}
                    {st.blocked_reason && (
                      <p className="text-[10px] text-amber-500 font-mono truncate px-1">
                        🛡 {st.blocked_reason}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {thoughts.length > 0 && (
            <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Reasoning Trace</p>
              {thoughts.map((e, idx) => (
                <ThoughtRow key={idx} event={e} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied!" : label}
      aria-label={copied ? "Copied!" : label}
      className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg px-1.5 py-0.5 rounded hover:bg-elevated transition-colors cursor-pointer"
    >
      {copied ? (
        <svg viewBox="0 0 24 24" className="size-3.5 text-ok transition-transform scale-110" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-3.5 transition-transform hover:scale-105" fill="none" stroke="currentColor" strokeWidth={2}>
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
    </button>
  );
}

export function ConversationFeed({ role = "staff" }: { role?: Role }) {
  const turns = useAgentStore((s) => s.turns);
  const running = useAgentStore((s) => s.running);
  const userName = useAgentStore((s) => s.userName) || "Operator";
  const bottomRef = useRef<HTMLDivElement>(null);
  const latestPromptRef = useRef<HTMLDivElement>(null);

  const scrollToCurrent = (behavior: ScrollBehavior = "smooth") => {
    if (latestPromptRef.current) {
      latestPromptRef.current.scrollIntoView({ behavior, block: "start" });
    } else if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior, block: "end" });
    }
  };

  useEffect(() => {
    scrollToCurrent("smooth");
  }, [turns.length, running]);

  if (turns.length === 0) {
    return null;
  }

  // Find the index of the last user turn
  let lastUserIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  return (
    <div id="concaretti-conversation-feed" className="space-y-6 pb-6 select-text relative">

      {turns.map((turn, index) => {
        const isUser = turn.role === "user";

        if (isUser) {
          return (
            <div
              key={turn.id || index}
              ref={index === lastUserIdx ? latestPromptRef : undefined}
              className="flex flex-col items-end group scroll-mt-6"
            >
              <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl bg-elevated/90 border border-hairline px-4 py-3 text-fg shadow-xs">
                <div className="flex items-center justify-between gap-3 mb-1.5 pb-1.5 border-b border-hairline/30">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="size-4.5 rounded-full bg-fg text-void text-[10px] font-bold flex items-center justify-center shrink-0">
                      {userName.charAt(0).toUpperCase()}
                    </span>
                    <span className="text-[11px] font-semibold text-fg whitespace-nowrap truncate">
                      {userName}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <CopyButton text={turn.content} label="Copy" />
                    <span className="text-[11px] text-muted whitespace-nowrap shrink-0">
                      {relTime(turn.ts)}
                    </span>
                  </div>
                </div>

                <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg select-text">
                  {turn.content}
                </p>

                {turn.attachments && turn.attachments.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-hairline/40 flex flex-wrap gap-2">
                    {turn.attachments.map((att, i) => (
                      <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded bg-obsidian text-[11px] border border-hairline">
                        {att.preview ? (
                          <img src={att.preview} alt="" className="size-4 rounded object-cover" />
                        ) : (
                          <span>📄</span>
                        )}
                        <span className="truncate max-w-[140px] text-dim">{att.name}</span>
                        <span className="text-muted text-[9px]">({Math.round(att.size / 1024)} KB)</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        }

        // Assistant Turn
        const hasContent = Boolean(turn.content);
        const isTurnRunning = turn.status === "running";

        return (
          <div key={turn.id || index} className="flex flex-col items-start w-full group">
            <div className="w-full rounded-2xl bg-obsidian border border-hairline/70 p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3 mb-2 pb-2 border-b border-hairline/30">
                  <div className="flex items-center gap-2 min-w-0">
                    <img src="/favicon.png" alt="" className="size-4.5 rounded shrink-0" />
                    <span className="text-[13px] font-bold text-fg whitespace-nowrap tracking-tight">
                      Concaretti Council
                    </span>
                    <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 whitespace-nowrap shrink-0">
                      {role.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {hasContent && <CopyButton text={turn.content} label="Copy response" />}
                    <span className="text-[11px] text-muted whitespace-nowrap shrink-0">
                      {relTime(turn.ts)}
                    </span>
                  </div>
                </div>

              {/* Differentiated Thought Process Accordion */}
              <TurnThoughts turn={turn} isLatest={index === turns.length - 1} />

              {/* Turn Artifacts & Generated Art — Displayed First */}
              {turn.artifacts && turn.artifacts.length > 0 && (
                <div className="mb-3 pb-3 border-b border-hairline/40">
                  <div className="flex items-center justify-between mb-2">
                    <p className="type-mono text-[10px] text-muted uppercase tracking-wider font-bold">
                      Generated Artifacts & Art ({turn.artifacts.length})
                    </p>
                  </div>
                  <div className="space-y-3">
                    {turn.artifacts.map((art) => {
                      const isImage = art.mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/i.test(art.filename);
                      const downloadUrl = `/api/artifacts/${art.id}/download`;

                      return (
                        <div key={art.id} className="rounded-xl border border-hairline bg-void overflow-hidden shadow-xs">
                          {isImage && (
                            <div className="relative bg-obsidian/30 max-h-[420px] overflow-hidden flex items-center justify-center p-2 border-b border-hairline">
                              <img
                                src={downloadUrl}
                                alt={art.filename}
                                className="max-h-[380px] w-auto max-w-full rounded-lg object-contain shadow-sm hover:scale-[1.01] transition-transform duration-200"
                                loading="lazy"
                              />
                            </div>
                          )}
                          <div className="p-3 flex items-center justify-between gap-3 bg-elevated/30">
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-[12px] font-bold text-fg truncate flex items-center gap-1.5">
                                <span>{isImage ? "🎨" : "📄"}</span>
                                <span>{art.filename}</span>
                              </p>
                              <p className="type-mono text-[10px] text-muted">{art.mime}</p>
                            </div>
                            <a
                              href={downloadUrl}
                              target="_blank"
                              rel="noreferrer"
                              download={art.filename}
                              className="btn btn-primary text-[11px] px-3 py-1.5 font-bold shrink-0 rounded-lg shadow-2xs"
                            >
                              Open / Download
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Distinct Final Response */}
              {hasContent ? (
                <article className="prose prose-invert max-w-none text-[14px] leading-relaxed text-fg pt-1 select-text">
                  <div className="whitespace-pre-wrap select-text font-normal">
                    {turn.content}
                  </div>
                </article>
              ) : isTurnRunning ? (
                <div className="flex items-center gap-2 py-2 text-[13px] text-muted animate-pulse">
                  <span className="size-2 rounded-full bg-[#00E5FF]" />
                  <span>Synthesizing multi-agent council findings…</span>
                </div>
              ) : (
                <p className="text-[13px] text-muted italic">Run completed with no response summary.</p>
              )}
            </div>
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
