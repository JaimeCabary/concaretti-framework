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
  AgentTag,
  agentColor,
  Chip,
  clockTime,
  Empty,
  Panel,
  Spinner,
} from "./ui";

const NEAR_BOTTOM_PX = 48;

function ThoughtRow({
  event,
  showModel,
}: {
  event: SseEvent;
  showModel: boolean;
}) {
  const isError = event.type === "error";
  const isActivity = event.type === "activity";
  const text = String(event.text ?? event.message ?? "");
  if (!text) return null;

  // The rail is the agent's colour where a step belongs to one. Errors keep the
  // danger rail regardless — what went wrong outranks who was running.
  const agent = typeof event.agent === "string" ? event.agent : "";
  const rail = isError
    ? "var(--color-danger)"
    : agent
      ? agentColor(agent)
      : isActivity
        ? "var(--color-hairline)"
        : "var(--color-council)";

  // The backend prefixes the text with `agent: ` so the line reads on its own in
  // a plain log. Here the tag carries that, so strip the duplicate.
  const body =
    agent && text.startsWith(`${agent}:`)
      ? text.slice(agent.length + 1).trim()
      : text;

  return (
    <li className="border-l-2 py-2 pl-3 pr-1" style={{ borderColor: rail }}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[10px] tabular-nums text-muted">
          {clockTime(event.ts)}
        </span>
        {agent ? <AgentTag agent={agent} /> : null}
        {showModel && event.model ? (
          <span
            className="font-mono text-[10px] text-muted"
            title={`tier: ${String(event.tier ?? "unknown")}`}
          >
            {String(event.model)}
            {event.tier ? ` · ${String(event.tier)}` : ""}
          </span>
        ) : null}
      </div>
      {event.type === "thought" && body.includes("\n") ? (
        <details className="mt-1 group">
          <summary className="cursor-pointer text-[13px] text-dim hover:text-fg select-none list-none flex items-center gap-1.5 [&::-webkit-details-marker]:hidden">
            <svg
              viewBox="0 0 24 24"
              className="size-3.5 transition-transform group-open:rotate-90 text-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
            <span className="truncate">{body.split("\n")[0]}</span>
          </summary>
          <div className="mt-2 pl-5">
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg opacity-90">
              {body.slice(body.indexOf("\n") + 1)}
            </p>
          </div>
        </details>
      ) : (
        <p
          className={`mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed ${
            isError ? "text-danger" : isActivity ? "text-dim" : "text-fg"
          }`}
        >
          {body}
        </p>
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

  const visible = events.filter(
    (e) => e.type === "thought" || e.type === "activity" || e.type === "error",
  );

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
