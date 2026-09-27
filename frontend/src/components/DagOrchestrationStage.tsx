/**
 * The execution plan, as a list.
 *
 * Deliberately not a node graph. The old app rendered one and it cost real
 * effort for something that, at four to six subtasks, communicated less than an
 * ordered list does: a reader wants to know what ran, in what order, and what
 * was refused. Layers give the ordering, badges give the outcome.
 *
 * A refused subtask stays visible with its reason. Dropping it would hide the
 * `.conca` decision, which is the single most important thing on this panel.
 */

import { useState } from "react";
import { selectLayers, useAgentStore } from "../store/agentStore";
import type { Subtask } from "../types";
import { AgentTag, agentColor, Panel, StatusBadge } from "./ui";

const AGENT_SCREEN_MAP: Record<string, string> = {
  sms: "telecom",
  telecom: "telecom",
  browser: "browser",
  calendar: "calendar",
  email: "email",
  shopper: "shopper",
  market: "market",
  chain: "chain",
  diary: "diary",
};

function SubtaskRow({ task }: { task: Subtask }) {
  const [open, setOpen] = useState(false);
  const blocked = task.status === "rejected" || task.status === "skipped";
  const detail = task.blocked_reason || task.error || task.result;
  const hasDetail = Boolean(detail);
  const screenTab = task.agent ? AGENT_SCREEN_MAP[task.agent.toLowerCase()] : null;

  return (
    <li
      className={`inset-flat px-3 py-2 ${blocked ? "bg-danger-soft" : ""}`}
      // A refusal keeps the danger fill: what the policy decided outranks whose
      // step it was. Everything else is filled with the colour of the agent that
      // ran it, so one agent's steps can be followed down the plan without
      // reading the labels. The full pastel rather than a wash of it — these
      // tokens are already pale, and 7% of one over white is white.
      style={blocked ? undefined : { background: agentColor(task.agent) }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <AgentTag agent={task.agent} />
            <span className="font-mono text-[10px] text-dim">
              {task.task_type}
            </span>
            {task.model_used ? (
              <span
                className="font-mono text-[10px] text-dim"
                title="Model that executed this step"
              >
                · {task.model_used}
              </span>
            ) : null}
            {screenTab && (
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("conca_switch_tab", { detail: screenTab }),
                  )
                }
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-elevated hover:bg-fg hover:text-bg text-fg/80 border border-hairline transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-2xs"
                title={`Open ${screenTab.toUpperCase()} screen to see ${task.agent} in action`}
              >
                <span className="size-1 rounded-full bg-ok" />
                <span>View Screen ↗</span>
              </button>
            )}
          </div>
          <p className="mt-0.5 text-[13px] leading-snug text-fg">
            {task.description}
          </p>

          {task.blocked_reason ? (
            <p className="mt-1 text-[12px] leading-snug text-fg">
              {task.blocked_reason}
            </p>
          ) : null}

          {task.error ? (
            <p className="mt-1 text-[11px] font-mono text-danger font-medium">
              ⚠ {task.error}
            </p>
          ) : null}

          {hasDetail && !task.blocked_reason ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="mt-1 text-[11px] text-dim underline hover:text-fg"
            >
              {open ? "Hide output" : "Show output"}
            </button>
          ) : null}

          {open && hasDetail ? (
            <pre
              className="inset mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap
                px-2.5 py-2 font-mono text-[11px] leading-relaxed text-dim"
            >
              {detail}
            </pre>
          ) : null}
        </div>
        <StatusBadge status={task.status} />
      </div>
    </li>
  );
}

export function DagOrchestrationStage() {
  const layers = useAgentStore(selectLayers);
  const total = useAgentStore((s) => s.subtasks.length);
  const running = useAgentStore((s) => s.running);
  const blocked = useAgentStore(
    (s) =>
      s.subtasks.filter(
        (t) => t.status === "rejected" || t.status === "skipped",
      ).length,
  );

  if (total === 0) {
    if (!running) return null;
    return (
      <Panel
        title="Orchestration Plan"
        accent="var(--color-reports)"
        collapsible
        defaultOpen={true}
        actions={
          <span className="type-mono text-[10px] text-muted flex items-center gap-1.5 font-bold">
            <span className="size-2 rounded-full bg-[#00E5FF] animate-pulse" />
            SYNTHESIZING DAG...
          </span>
        }
      >
        <div className="p-3.5 space-y-2 animate-pulse">
          <div className="h-9 rounded-lg bg-obsidian/70 border border-hairline/50 flex items-center px-3 gap-2.5">
            <span className="size-2 rounded-full bg-blue-400" />
            <div className="h-3 bg-fg/20 rounded w-1/3" />
            <div className="h-2.5 bg-fg/10 rounded w-16 ml-auto" />
          </div>
          <div className="h-9 rounded-lg bg-obsidian/70 border border-hairline/50 flex items-center px-3 gap-2.5">
            <span className="size-2 rounded-full bg-purple-400" />
            <div className="h-3 bg-fg/20 rounded w-2/5" />
            <div className="h-2.5 bg-fg/10 rounded w-16 ml-auto" />
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Orchestration"
      accent="var(--color-reports)"
      collapsible
      defaultOpen={false}
      actions={
        <span className="type-mono text-[10px] text-muted">
          {blocked > 0 ? (
            <>
              {total} steps · <span className="text-danger">{blocked} refused</span>
            </>
          ) : (
            `${total} steps`
          )}
        </span>
      }
    >
      <div className="space-y-3 px-3 py-3">
          {layers.slice().reverse().map(([layer, tasks]) => (
            <div key={layer}>
              <p className="type-mono mb-1.5 flex items-center gap-2 text-[10px] text-muted">
                <span>Layer {layer}</span>
                <span className="h-0.5 flex-1 bg-fg" />
                {tasks.length > 1 ? (
                  <span>{tasks.length} in parallel</span>
                ) : null}
              </p>
              <ul className="space-y-1.5">
                {tasks.slice().reverse().map((t) => (
                  <SubtaskRow key={t.id} task={t} />
                ))}
              </ul>
            </div>
          ))}
        </div>
    </Panel>
  );
}
