/**
 * Public screen — unified multi-agent operating interface with public guest scoping.
 *
 * Adopts the identical side panel, session history, fixed header, and bottom designation
 * profile as the Staff and Student screens, ensuring seamless visual consistency
 * across all roles.
 */

import { useState } from "react";
import { CouncilCockpit } from "../components/CouncilCockpit";
import { ArtifactPanel } from "../components/ArtifactPanel";
import { CalendarScreen } from "../components/CalendarScreen";
import { EmailHub } from "../components/EmailHub";
import { WorkDiary } from "../components/WorkDiary";
import { TelecomInbox } from "../components/TelecomInbox";
import { DocsPanel } from "../components/DocsPanel";
import { Sidebar, type RailItem } from "../components/Sidebar";
import { RailProfile } from "../components/RailProfile";
import { RailSessions } from "../components/RailSessions";
import { ConversationFeed } from "../components/ConversationFeed";
import { useAgentStore } from "../store/agentStore";

type Tab = "ops" | "calendar" | "diary" | "email" | "telecom" | "help";

const ITEMS: ReadonlyArray<RailItem<Tab>> = [
  { key: "ops", label: "Council", agent: "research" },
  { key: "calendar", label: "Calendar", agent: "calendar" },
  { key: "diary", label: "Diary" },
  { key: "email", label: "Email", agent: "email" },
  { key: "telecom", label: "Telecom", agent: "sms" },
  { key: "help", label: "Documentation", footer: true },
];

const SUGGESTIONS = [
  "What is a multi-agent system, in plain terms?",
  "Summarise the case for human oversight of autonomous agents",
  "Find recent research on AI safety evaluation",
];

function PublicIdle() {
  const userName = useAgentStore((s) => s.userName);
  const displayName = userName ? `, ${userName}` : "";
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);

  const hour = new Date().getHours();
  let greeting = "Good evening";
  if (hour < 12) greeting = "Good morning";
  else if (hour < 17) greeting = "Good afternoon";

  return (
    <div className="mx-auto w-full max-w-[46rem] pt-[15vh]">
      <div className="text-center flex flex-col items-center mb-8">
        <img src="/favicon.png" alt="Logo" className="size-10 mb-4" />
        <h1 className="type-tagline text-[clamp(28px,4vw,40px)] text-fg tracking-tight">
          {greeting}{displayName}
        </h1>
        <p className="type-mono text-[11px] text-muted tracking-widest mt-1 uppercase">
          PUBLIC RESEARCH & GUEST ACCESS
        </p>
      </div>

      <div className="w-full space-y-4">
        <CouncilCockpit
          placeholder="Ask anything or request academic research…"
          showTimeline={false}
          autoFocus
        />

        <ul className="flex flex-wrap justify-center gap-2 pt-2">
          {SUGGESTIONS.map((s) => (
            <li key={s}>
              <button
                type="button"
                disabled={running}
                onClick={() => void runPrompt(s)}
                className="type-mono text-[11px] px-3 py-1.5 rounded-full border border-hairline bg-obsidian hover:bg-elevated text-dim hover:text-fg transition-colors cursor-pointer"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PublicRun() {
  return (
    <div className="flex flex-col h-full w-full">
      {/* Scrollable Real-Time Content Feed */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-6 pb-6 sm:px-8 lg:px-12">
        <div className="mx-auto w-full max-w-4xl space-y-6">
          <ConversationFeed role="public" />
          <ArtifactPanel />
        </div>
      </div>

      {/* Pinned Bottom Command Bar — Always Accessible */}
      <div className="shrink-0 border-t-2 border-fg bg-obsidian p-4 shadow-[0px_-4px_10px_rgba(0,0,0,0.04)]">
        <div className="max-w-4xl mx-auto">
          <CouncilCockpit
            placeholder="Send follow-up or ask another research question…"
            showTimeline={false}
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}

export function PublicScreen() {
  const agents = useAgentStore((s) => s.agents);
  const hasRun = useAgentStore((s) => s.sessionId !== null);
  const running = useAgentStore((s) => s.running);
  const clearRun = useAgentStore((s) => s.clearRun);
  const [tab, setTab] = useState<Tab>("ops");

  const visible = ITEMS.filter(
    (t) => !t.agent || agents.includes(t.agent),
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-void">
      <Sidebar
        items={visible}
        active={tab}
        onSelect={(key) => {
          if (key === "ops") clearRun();
          setTab(key);
        }}
        middle={<RailSessions onSelectSession={() => setTab("ops")} />}
        footer={<RailProfile onNavigate={(t) => setTab(t as Tab)} />}
      />

      <main className="min-w-0 flex-1 overflow-hidden flex flex-col">
        {tab === "ops" ? (
          hasRun || running ? (
            <PublicRun />
          ) : (
            <div className="flex-1 overflow-y-auto px-5 pb-20 pt-6 sm:px-8 lg:px-12">
              <PublicIdle />
            </div>
          )
        ) : tab === "help" ? (
          <div className="flex-1 overflow-y-auto">
            <DocsPanel />
          </div>
        ) : tab === "calendar" ? (
          <div className="flex-1 min-h-0 p-3 sm:p-5 flex flex-col overflow-hidden">
            <CalendarScreen />
          </div>
        ) : tab === "diary" ? (
          <div className="flex-1 min-h-0 p-3 sm:p-5 flex flex-col overflow-hidden">
            <WorkDiary />
          </div>
        ) : tab === "email" ? (
          <div className="flex-1 overflow-y-auto p-6">
            <EmailHub />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <TelecomInbox />
          </div>
        )}
      </main>
    </div>
  );
}
