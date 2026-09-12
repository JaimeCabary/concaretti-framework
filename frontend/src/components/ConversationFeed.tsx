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
      {event.model && (
        <span className="font-mono text-[9px] uppercase px-1.5 py-0.5 bg-elevated rounded text-muted shrink-0 mt-0.5">
          {event.model}
        </span>
      )}
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

  // Filter out any background sentinel heartbeats from thought display
  const thoughts = (turn.thoughts || []).filter(
    (t) =>
      !/\[sentinel\b/i.test(String(t.text ?? t.message ?? "")) &&
      t.agent !== "sentinel",
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

          <span className="type-mono text-[11px] font-bold text-fg tracking-wide uppercase truncate">
            {isRunning ? "Council Deliberating & Executing" : "Thought Process"}
          </span>

          <span className="type-mono text-[10px] text-muted shrink-0">
            · {subtasks.length} step(s) {thoughts.length > 0 ? `· ${thoughts.length} trace(s)` : ""}
          </span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-1.5 flex-nowrap">
            {agentsUsed.slice(0, 3).map((a) => (
              <AgentTag key={a} agent={a} />
            ))}
          </div>

          <span className="type-mono text-[9px] text-muted hidden sm:inline uppercase">
            {open ? "collapse" : "view"}
          </span>
        </div>
      </button>

      {open && (
        <div className="p-3 bg-void/50 space-y-3">
          {subtasks.length > 0 && (
            <div className="space-y-1.5 pb-2 border-b border-hairline/30">
              <p className="type-mono text-[9px] uppercase tracking-wider text-muted">Execution Plan</p>
              <div className="space-y-1">
                {subtasks.map((st) => (
                  <div key={st.id} className="flex items-center justify-between gap-2 text-[11px] py-1 px-2 rounded bg-obsidian/40">
                    <div className="flex items-center gap-2 min-w-0">
                      <AgentTag agent={st.agent} />
                      <span className="truncate text-fg font-medium">{st.description || st.task_type}</span>
                    </div>
                    <StatusBadge status={st.status} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {thoughts.length > 0 && (
            <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
              <p className="type-mono text-[9px] uppercase tracking-wider text-muted">Reasoning Trace</p>
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
      className="inline-flex items-center gap-1 text-[11px] font-mono text-muted hover:text-fg px-2 py-0.5 rounded hover:bg-elevated transition-colors cursor-pointer"
    >
      {copied ? (
        <>
          <svg viewBox="0 0 24 24" className="size-3 text-ok" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          <span className="text-ok font-semibold text-[10px]">Copied</span>
        </>
      ) : (
        <>
          <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
          <span className="text-[10px]">{label}</span>
        </>
      )}
    </button>
  );
}

export function ConversationFeed({ role = "staff" }: { role?: Role }) {
  const turns = useAgentStore((s) => s.turns);
  const userName = useAgentStore((s) => s.userName) || "Operator";
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  if (turns.length === 0) {
    return null;
  }

  const allConversationText = turns
    .map((t) => `${t.role === "user" ? userName : "CONCARETTI"}: ${t.content || ""}`)
    .join("\n\n");

  return (
    <div id="concaretti-conversation-feed" className="space-y-6 pb-6 select-text">
      {/* Top Action Bar: Copy All & Select All */}
      <div className="flex items-center justify-between px-2 pb-2 border-b border-hairline/40">
        <span className="type-mono text-[10px] text-muted uppercase tracking-wider">
          {turns.length} Turn{turns.length > 1 ? "s" : ""} Recorded
        </span>
        <div className="flex items-center gap-2">
          <CopyButton text={allConversationText} label="Copy All" />
          <button
            type="button"
            onClick={() => {
              const feed = document.getElementById("concaretti-conversation-feed");
              if (feed) {
                const range = document.createRange();
                range.selectNodeContents(feed);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
              }
            }}
            className="inline-flex items-center gap-1 text-[11px] font-mono text-muted hover:text-fg px-2 py-0.5 rounded hover:bg-elevated transition-colors cursor-pointer"
          >
            <span className="text-[10px]">Select All</span>
          </button>
        </div>
      </div>

      {turns.map((turn, index) => {
        const isUser = turn.role === "user";

        if (isUser) {
          return (
            <div key={turn.id || index} className="flex flex-col items-end group">
              <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl bg-elevated/90 border border-hairline px-4 py-3 text-fg shadow-xs">
                <div className="flex items-center justify-between gap-3 mb-1 pb-1 border-b border-hairline/30">
                  <div className="flex items-center gap-1.5">
                    <span className="size-4 rounded-full bg-fg text-void text-[9px] font-bold flex items-center justify-center">
                      {userName.charAt(0).toUpperCase()}
                    </span>
                    <span className="type-mono text-[10px] font-bold text-fg uppercase tracking-wider">
                      {userName}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CopyButton text={turn.content} label="Copy" />
                    <span className="type-mono text-[9px] text-muted">
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
                        <span className="font-mono truncate max-w-[140px] text-dim">{att.name}</span>
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
              {/* Header */}
              <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-hairline/30">
                <div className="flex items-center gap-2">
                  <img src="/favicon.png" alt="" className="size-4.5 rounded" />
                  <span className="type-display text-[13px] font-bold text-fg">
                    Concaretti Council
                  </span>
                  <span className="type-mono text-[9px] uppercase px-1.5 py-0.5 rounded bg-council-soft/30 text-dim border border-hairline">
                    {role.toUpperCase()}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {hasContent && <CopyButton text={turn.content} label="Copy response" />}
                  <span className="type-mono text-[9px] text-muted">
                    {relTime(turn.ts)}
                  </span>
                </div>
              </div>

              {/* Differentiated Thought Process Accordion */}
              <TurnThoughts turn={turn} isLatest={index === turns.length - 1} />

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

              {/* Turn Artifacts */}
              {turn.artifacts && turn.artifacts.length > 0 && (
                <div className="mt-4 pt-3 border-t border-hairline/40">
                  <p className="type-mono text-[10px] text-muted uppercase tracking-wider mb-2">
                    Generated Artifacts ({turn.artifacts.length})
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {turn.artifacts.map((art) => (
                      <div key={art.id} className="panel p-2.5 bg-elevated/40 border border-hairline flex items-center justify-between">
                        <div className="min-w-0 pr-2">
                          <p className="font-mono text-[12px] font-bold text-fg truncate">{art.filename}</p>
                          <p className="type-mono text-[9px] text-muted">{art.mime}</p>
                        </div>
                        <a
                          href={`/api/artifacts/${art.id}/download`}
                          target="_blank"
                          rel="noreferrer"
                          className="btn text-[11px] px-2.5 py-1 shrink-0"
                        >
                          Download
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
