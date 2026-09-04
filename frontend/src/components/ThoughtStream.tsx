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
}: {
  event: SseEvent;
  showModel?: boolean;
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

  return (
    <li className="mb-2">
      {event.type === "thought" ? (
        <details className="group rounded-lg bg-obsidian/50 border border-transparent hover:border-hairline overflow-hidden transition-all">
          <summary className="cursor-pointer text-[12px] text-dim select-none list-none flex items-center gap-2 px-3 py-2 hover:bg-elevated hover:text-fg transition-colors [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-1.5 font-medium">
              <svg
                viewBox="0 0 24 24"
                className="size-3.5 transition-transform group-open:rotate-90"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
              </svg>
              {(() => {
                if (agent) {
                  return `${agent.charAt(0).toUpperCase() + agent.slice(1)} agent thinking`;
                }
                return "Concaretti thinking";
              })()}
            </span>
          </summary>
          <div className="px-3 py-2.5 bg-void border-t border-hairline/50">
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-dim">
              {body}
            </p>
          </div>
        </details>
      ) : (
        <div
          className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] transition-colors border ${
            isError
              ? "bg-danger-soft/20 text-danger border-danger/30"
              : "bg-transparent border-transparent hover:bg-elevated/30 text-dim"
          }`}
        >
          {isError ? (
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 mt-[1px]" fill="none" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          ) : (
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 mt-[1px] text-fg/40" fill="none" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
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
  const rotator = useAgentStore((s) => s.rotator);

  const [collapsed, setCollapsed] = useState(role === "student");
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const visible = events
    .filter((e) => e.type === "thought" || e.type === "activity" || e.type === "error")
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

  // Public gets an indicator only — no trace, per the brief.
  if (role === "public") {
    return running ? (
      <div className="flex items-center gap-2 px-1 py-2">
        <Spinner label="Thinking through your request" />
      </div>
    ) : null;
  }

  const showModel = role === "staff";

  return (
    <Panel
      title="Thought stream"
      accent="var(--color-council)"
      className="min-h-[220px]"
      actions={
        <div className="flex items-center gap-2">
          {showModel && rotator ? (
            <Chip
              tone={rotator.live_provider_configured ? "ok" : "warn"}
              title={
                rotator.live_provider_configured
                  ? `${rotator.active_count} of ${rotator.ladder_size} models available`
                  : "No live API key configured — running on the deterministic stub"
              }
            >
              {rotator.current}
            </Chip>
          ) : null}
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
            <Empty>
              {running ? "Waiting for the first step…" : "No run yet."}
            </Empty>
          ) : (
            <ul className="space-y-0.5">
              {visible.slice().reverse().map((e, i) => (
                <ThoughtRow
                  key={`${e.ts}-${i}`}
                  event={e}
                  showModel={showModel}
                />
              ))}
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
