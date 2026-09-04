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
    <div className="flex flex-col h-[calc(100dvh-4rem)] bg-void overflow-hidden py-4">
      {/* If they have other tabs, show the TabBar */}
      {visible.length > 1 && (
        <div className="shrink-0 px-4 mb-4">
          <TabBar tabs={visible} active={tab} onSelect={setTab} />
        </div>
      )}

      {tab === "work" ? (
        <div className="flex-1 overflow-hidden flex flex-col w-full max-w-3xl mx-auto h-full">
          {!hasRun ? (
            <div className="flex-1 overflow-y-auto space-y-4 px-4 pt-[10vh]">
              <div className="text-center flex flex-col items-center mb-8">
                <img src="/favicon.png" alt="Logo" className="size-10 mb-4" />
                <h1 className="type-tagline text-[clamp(28px,4vw,40px)] text-fg tracking-tight">
                  Good afternoon, {useAgentStore((s) => s.userName) || "User"}
                </h1>
              </div>

              <CouncilCockpit
                placeholder="Ask anything…"
                showTimeline={false}
                autoFocus
              />

              <ul className="flex flex-wrap justify-center gap-1.5 mt-4">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      disabled={running}
                      onClick={() => void runPrompt(s)}
                      className="chip transition-colors hover:bg-council-soft cursor-pointer"
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex-1 overflow-hidden flex flex-col h-full w-full">
              {/* Scrollable Real-Time Content Feed */}
              <div className="flex-1 overflow-y-auto px-4 pt-6 pb-6 space-y-6">
                <ThoughtStream role="public" />
                <Answer />
                <ArtifactPanel compact />
              </div>
              
              {/* Pinned Bottom Command Bar */}
              <div className="shrink-0 border-t-2 border-fg bg-obsidian p-4 shadow-[0px_-4px_10px_rgba(0,0,0,0.04)]">
                <div className="max-w-4xl mx-auto">
                  <CouncilCockpit
                    placeholder="Send follow-up..."
                    showTimeline={false}
                    autoFocus
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      ) : tab === "calendar" ? (
        <div className="flex-1 overflow-y-auto px-4 mx-auto w-full max-w-5xl">
          <CalendarScreen />
        </div>
      ) : tab === "email" ? (
        <div className="flex-1 overflow-y-auto px-4 mx-auto w-full max-w-5xl">
          <EmailHub />
        </div>
      ) : tab === "telecom" ? (
        <div className="flex-1 overflow-y-auto px-4 mx-auto w-full max-w-5xl">
          <TelecomInbox />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 mx-auto w-full max-w-5xl">
          <WorkDiary />
        </div>
      )}
    </div>
  );
}
