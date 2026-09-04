/**
 * Public screen — chat-first, single column.
 *
 * The brief's constraints, and why each one holds:
 *   · no agent dock, no DAG — a visitor has no plan to inspect
 *   · a thinking indicator rather than a reasoning trace
 *   · no HALO surface, because `.conca` grants public the research agent only
 *     and nothing it can dispatch trips a gate
 *   · artifacts appear only if a run produced one
 *
 * The answer is drawn from `done`, with activity as the fallback while a run is
 * in flight — the same events the other screens use, filtered down.
 */

import { useState } from "react";
import { CouncilCockpit } from "../components/CouncilCockpit";
import { ArtifactPanel } from "../components/ArtifactPanel";
import { ThoughtStream } from "../components/ThoughtStream";
import { CalendarScreen } from "../components/CalendarScreen";
import { EmailHub } from "../components/EmailHub";
import { WorkDiary } from "../components/WorkDiary";
import { TelecomInbox } from "../components/TelecomInbox";
import { TabBar } from "../components/ui";
import { useAgentStore } from "../store/agentStore";

type Tab = "work" | "calendar" | "email" | "diary" | "telecom";

const TABS: ReadonlyArray<{ key: Tab; label: string; agent?: string }> = [
  { key: "work", label: "Work" },
  { key: "calendar", label: "Calendar", agent: "calendar" },
  { key: "email", label: "Email", agent: "email" },
  { key: "telecom", label: "Telecom", agent: "sms" },
  { key: "diary", label: "Diary" },
];

const SUGGESTIONS = [
  "What is a multi-agent system, in plain terms?",
  "Summarise the case for human oversight of autonomous agents",
  "Find recent research on AI safety evaluation",
];

function Answer() {
  const summary = useAgentStore((s) => s.finalSummary);
  const running = useAgentStore((s) => s.running);
  const events = useAgentStore((s) => s.events);

  if (!summary && !running) return null;

  // Before `done` lands, the most recent activity line is the honest status.
  const latest = [...events]
    .reverse()
    .find((e) => e.type === "activity" && e.message)?.message;

  return (
    <article className="panel px-4 py-4 mt-4">
      {summary ? (
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg">
          {summary}
        </p>
      ) : (
        <p className="text-[13px] text-muted">
          {typeof latest === "string" ? latest : "Working on it…"}
        </p>
      )}
    </article>
  );
}

export function PublicScreen() {
  const agents = useAgentStore((s) => s.agents);
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);
  const hasRun = useAgentStore((s) => s.sessionId !== null);

  const [tab, setTab] = useState<Tab>("work");

  // Filter tabs by agents if applicable, but we let public/workspace role see what they have.
  // Actually, for public we might not have agents in the store if it's strictly public,
  // but if this acts as the "workspace" role it will have agents granted by the server.
  const visible = TABS.filter((t) => !t.agent || agents.includes(t.agent));

  return (
    <div className="space-y-4 py-4">
      {/* If they have other tabs, show the TabBar */}
      {visible.length > 1 && (
        <TabBar tabs={visible} active={tab} onSelect={setTab} />
      )}

      {tab === "work" ? (
        <div className="mx-auto max-w-3xl space-y-4">
          {!hasRun ? (
            <div className="pb-2 text-center">
              <h1 className="text-[22px] font-semibold tracking-tight text-fg">
                Workspace
              </h1>
              <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-muted">
                Your AI-assisted workspace for managing tasks, research, and
                correspondence.
              </p>
            </div>
          ) : null}

          <CouncilCockpit
            placeholder="Ask anything…"
            showTimeline={false}
            autoFocus
          />

          {!hasRun ? (
            <ul className="flex flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => void runPrompt(s)}
                    className="chip transition-colors hover:bg-council-soft"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <ThoughtStream role="public" />
          <Answer />
          <ArtifactPanel compact />
        </div>
      ) : tab === "calendar" ? (
        <div className="mx-auto max-w-5xl">
          <CalendarScreen />
        </div>
      ) : tab === "email" ? (
        <div className="mx-auto max-w-5xl">
          <EmailHub />
        </div>
      ) : tab === "telecom" ? (
        <div className="mx-auto max-w-5xl">
          <TelecomInbox />
        </div>
      ) : (
        <div className="mx-auto max-w-5xl">
          <WorkDiary />
        </div>
      )}
    </div>
  );
}
