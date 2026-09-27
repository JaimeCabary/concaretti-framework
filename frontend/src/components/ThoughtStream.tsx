/**
 * The live reasoning trace.
 *
 * Detail is role-scoped, which is the point rather than an afterthought:
 *
 *   staff   — every step, with the model and rotator tier that produced it, so
 *             a fallback down the ladder is visible as it happens
 *   student — steps without model internals, collapsed by default
 *   public  — a single "thinking" indicator; the trace exists but isn't shown
 *
 * Auto-scroll follows the tail only while the reader is already at the bottom.
 * Yanking the viewport back down while someone is reading an earlier step is
 * the classic log-panel mistake.
 */

import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "../store/agentStore";
import type { Role, SseEvent } from "../types";
import {
  Chip,
  Empty,
  Panel,
  Spinner,
} from "./ui";

const NEAR_BOTTOM_PX = 48;

function ThoughtRow({
  event,
  defaultOpen = false,
  forceOpen = null,
  isMostRecent = false,
}: {
  event: SseEvent;
  defaultOpen?: boolean;
  forceOpen?: boolean | null;
  isMostRecent?: boolean;
}) {
  const isError = event.type === "error";
  const text = String(event.text ?? event.message ?? "");
  if (!text) return null;

  const agent = typeof event.agent === "string" ? event.agent : "";

  // The backend prefixes the text with `agent: ` so the line reads on its own in
  // a plain log. Here the tag carries that, so strip the duplicate.
  const body =
    agent && text.startsWith(`${agent}:`)
      ? text.slice(agent.length + 1).trim()
      : text;

  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    if (forceOpen !== null && forceOpen !== undefined) {
      setIsOpen(forceOpen);
    }
  }, [forceOpen]);

  useEffect(() => {
    if (defaultOpen && forceOpen === null) {
      setIsOpen(true);
    }
  }, [defaultOpen, forceOpen]);

  return (
    <li className="mb-2">
      {event.type === "thought" ? (
        <details
          open={forceOpen !== null && forceOpen !== undefined ? forceOpen : (isMostRecent || isOpen)}
          onToggle={(e) => setIsOpen(e.currentTarget.open)}
          className={`group rounded-lg overflow-hidden transition-all border ${
            isMostRecent
              ? "bg-obsidian/80 border-council/40 shadow-xs ring-1 ring-council/20"
              : "bg-obsidian/50 border-hairline/60 hover:border-hairline"
          }`}
        >
          <summary
            onClick={(e) => {
              e.preventDefault();
              setIsOpen((prev) => !prev);
            }}
            className="cursor-pointer text-[12px] select-none list-none flex items-center justify-between px-3 py-2 hover:bg-elevated hover:text-fg transition-colors [&::-webkit-details-marker]:hidden"
          >
            <span className="flex items-center gap-1.5 font-medium">
              <svg
                viewBox="0 0 24 24"
                className={`size-3.5 transition-transform duration-150 ${
                  isOpen ? "rotate-90 text-council" : "text-dim"
                }`}
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
              </svg>
              <span className={isMostRecent ? "text-fg font-semibold" : "text-dim"}>
                {agent
                  ? `${agent.charAt(0).toUpperCase() + agent.slice(1)} agent thinking`
                  : "Concaretti thinking"}
              </span>
              {isMostRecent && (
                <span className="ml-1 px-1.5 py-0.5 text-[9px] uppercase tracking-wider rounded bg-council/20 text-council font-bold border border-council/30 shadow-2xs">
                  Latest Thought
                </span>
              )}
            </span>
            <span className="text-[11px] text-muted hover:text-fg">
              {isOpen ? "Collapse" : "Expand"}
            </span>
          </summary>
          {isOpen && (
            <div className="px-3.5 py-2.5 bg-void border-t border-hairline/50">
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg select-text">
                {body}
              </p>
            </div>
          )}
        </details>
      ) : (
        <div
          className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] transition-colors border ${isError
              ? "bg-danger-soft/20 text-danger border-danger/30"
              : "bg-transparent border-transparent hover:bg-elevated/30 text-dim"
            }`}
        >
          {isError ? (
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 mt-[1px]" fill="none" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 mt-[1px] text-fg/40" fill="none" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          )}
          <span className="whitespace-pre-wrap leading-relaxed">{body}</span>
        </div>
      )}
    </li>
  );
}

export function ThoughtStream({ role }: { role: Role }) {
  const events = useAgentStore((s) => s.events);
  const running = useAgentStore((s) => s.running);
  const conn = useAgentStore((s) => s.conn);

  const [collapsed, setCollapsed] = useState(role === "student");
  const [expandAll, setExpandAll] = useState<boolean | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const visible = events
    .filter((e) => {
      if (e.type !== "thought" && e.type !== "activity" && e.type !== "error") return false;
      const msg = String(e.text ?? e.message ?? "").trim();
      return !/^(stream connected|connected|keepalive)$/i.test(msg);
    })
    .reduce((acc, e) => {
      if (e.type === "thought" && acc.length > 0) {
        const last = acc[acc.length - 1];
        if (last.type === "thought" && last.agent === e.agent) {
          const t1 = String(last.text ?? last.message ?? "");
          const t2 = String(e.text ?? e.message ?? "");
          last.text = t1 + (t1 && t2 ? "\n\n" : "") + t2;
          return acc;
        }
      }
      acc.push({ ...e });
      return acc;
    }, [] as SseEvent[]);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const reversedVisible = visible.slice().reverse();
  const latestThoughtIdx = reversedVisible.findIndex((e) => e.type === "thought");

  return (
    <Panel
      title="Thought stream"
      accent="var(--color-council)"
      className="min-h-[220px]"
      actions={
        <div className="flex items-center gap-2">
          {visible.some((e) => e.type === "thought") && (
            <button
              type="button"
              onClick={() => setExpandAll((prev) => (prev ? false : true))}
              className="text-[11px] font-semibold text-dim hover:text-fg px-2.5 py-1 rounded bg-elevated/70 hover:bg-elevated border border-hairline/70 transition-colors cursor-pointer"
              title={expandAll ? "Collapse all reasoning steps" : "Expand all reasoning steps"}
            >
              {expandAll ? "Collapse All" : "Expand All"}
            </button>
          )}
          <Chip
            tone={
              conn === "open" ? "ok" : conn === "error" ? "warn" : "neutral"
            }
            title={`SSE ${conn}`}
          >
            {conn === "open" ? "live" : conn}
          </Chip>
          {role === "student" ? (
            <button
              type="button"
              className="text-[11px] text-muted hover:text-fg"
              onClick={() => setCollapsed((c) => !c)}
            >
              {collapsed ? "Show" : "Hide"}
            </button>
          ) : null}
        </div>
      }
    >
      {collapsed ? (
        <div className="px-4 py-3 text-[13px] text-muted">
          {running ? (
            <Spinner label={`${visible.length} steps so far`} />
          ) : (
            `${visible.length} reasoning steps — hidden`
          )}
        </div>
      ) : (
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
          }}
          className="h-full max-h-[52vh] overflow-y-auto px-3 py-2"
        >
          {visible.length === 0 ? (
            running ? (
              <div className="p-4 space-y-3 animate-pulse">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-fg">
                  <span className="size-2 rounded-full bg-[#00E5FF] animate-ping" />
                  <span>Streaming live deductive reasoning trace…</span>
                </div>
                <div className="space-y-2">
                  <div className="p-3 rounded-lg bg-obsidian/50 border border-hairline/40 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="h-3 bg-fg/20 rounded w-24" />
                      <div className="h-2 bg-fg/10 rounded w-12" />
                    </div>
                    <div className="h-3 bg-fg/10 rounded w-full" />
                    <div className="h-3 bg-fg/10 rounded w-4/5" />
                  </div>
                  <div className="p-3 rounded-lg bg-obsidian/50 border border-hairline/40 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="h-3 bg-fg/20 rounded w-20" />
                      <div className="h-2 bg-fg/10 rounded w-14" />
                    </div>
                    <div className="h-3 bg-fg/10 rounded w-5/6" />
                  </div>
                </div>
              </div>
            ) : (
              <Empty>No run yet.</Empty>
            )
          ) : (
            <ul className="space-y-0.5">
              {reversedVisible.map((e, i) => {
                const isMostRecent = i === latestThoughtIdx;
                return (
                  <ThoughtRow
                    key={`${e.ts}-${i}`}
                    event={e}
                    defaultOpen={isMostRecent || (running && i === 0)}
                    forceOpen={expandAll}
                    isMostRecent={isMostRecent}
                  />
                );
              })}
            </ul>
          )}
          {running && visible.length > 0 ? (
            <div className="py-2 pl-3">
              <Spinner />
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
