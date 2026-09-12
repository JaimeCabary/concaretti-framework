/**
 * Student screen — scoped for student operations.
 *
 * Claude / Grok-style central command experience:
 * - When Idle: Dead-center prompt box, headline, and quick action chips (Zero scrolling).
 * - When Active: Real-time live Thought Stream & Results in scrollable feed,
 *   with the Command Composer permanently PINNED at the bottom (never scrolls away).
 * - Scoped agents: Research, File, Calendar, Scheduler, Telecom (SMS), Shopper, Market, Browser, Diary, .conca, Settings.
 */

import { useState } from "react";
import { AgentDock } from "../components/AgentDock";
import { ArtifactPanel } from "../components/ArtifactPanel";
import { BrowserPanel } from "../components/BrowserPanel";
import { CouncilCockpit } from "../components/CouncilCockpit";
import { MarketPanel } from "../components/MarketPanel";
import { ShopperPanel } from "../components/ShopperPanel";
import { TelecomInbox } from "../components/TelecomInbox";
import { ConcaPanel } from "../components/ConcaPanel";
import { ConnectAccounts } from "../components/ConnectAccounts";
import { DocsPanel } from "../components/DocsPanel";
import { RecallPanel } from "../components/RecallPanel";
import { StudentTimetable } from "../components/StudentTimetable";
import { CalendarScreen } from "../components/CalendarScreen";
import { EmailHub } from "../components/EmailHub";
import { WorkDiary } from "../components/WorkDiary";
import { ConversationFeed } from "../components/ConversationFeed";
import { relTime } from "../components/ui";
import { Sidebar, type RailItem } from "../components/Sidebar";
import { RailProfile } from "../components/RailProfile";
import { RailSessions } from "../components/RailSessions";
import { useAgentStore } from "../store/agentStore";

type Tab =
  | "work"
  | "calendar"
  | "email"
  | "diary"
  | "timetable"
  | "telecom"
  | "browser"
  | "shopper"
  | "market"
  | "conca"
  | "help"
  | "settings";

const TABS: ReadonlyArray<{ key: Tab; label: string; agent?: string }> = [
  { key: "work", label: "Work" },
  { key: "calendar", label: "Calendar", agent: "calendar" },
  { key: "email", label: "Email", agent: "email" },
  { key: "diary", label: "Diary" },
  { key: "timetable", label: "Timetable" },
  { key: "telecom", label: "Telecom", agent: "sms" },
  { key: "browser", label: "Browser", agent: "browser" },
  { key: "shopper", label: "Shopper", agent: "shopper" },
  { key: "market", label: "Market", agent: "market" },
  { key: "conca", label: ".conca Rules" },
  { key: "help", label: "Documentation" },
  { key: "settings", label: "Settings" },
];

const RAIL_ITEMS: ReadonlyArray<RailItem<Tab>> = TABS.map((tab) => ({
  ...tab,
  secondary:
    tab.key === "timetable" ||
    tab.key === "telecom" ||
    tab.key === "browser" ||
    tab.key === "shopper" ||
    tab.key === "market" ||
    tab.key === "conca" ||
    tab.key === "settings",
}));



function RecentSessionsCollapsible() {
  const sessions = useAgentStore((s) => s.sessions);
  const attach = useAgentStore((s) => s.attachSession);
  const [open, setOpen] = useState(false);

  if (sessions.length === 0) return null;

  return (
    <div className="panel bg-obsidian border-2 border-hairline p-4 w-full">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="type-mono text-[11px] text-muted tracking-widest flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          PAST SESSIONS ({sessions.length})
        </span>
        <span className="type-mono text-[11px] text-dim hover:text-fg font-bold">
          {open ? "HIDE ↑" : "SHOW ↓"}
        </span>
      </button>
      {open && (
        <ul className="mt-3 max-h-52 divide-y divide-hairline overflow-y-auto border-t border-hairline pt-2">
          {sessions.slice(0, 8).map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => attach(s.id)}
                className="w-full px-2 py-2 text-left transition-colors hover:bg-elevated flex items-center justify-between"
              >
                <p className="truncate text-[13px] font-semibold text-fg flex-1 mr-2">
                  {s.title || s.summary || "Untitled session"}
                </p>
                <p className="type-mono text-[9px] text-dim shrink-0">
                  {relTime(s.created_at).toUpperCase()}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Centered Claude/Grok Idle View — Dead center prompt box, zero scroll.
 */
function StudentIdle({ onPick }: { onPick: (hint: string) => void }) {
  const userName = useAgentStore((s) => s.userName);
  const displayName = userName ? `, ${userName}` : "";
  const hour = new Date().getHours();
  let greeting = "Good evening";
  if (hour < 12) greeting = "Good morning";
  else if (hour < 17) greeting = "Good afternoon";

  return (
    <div className="h-full flex flex-col justify-center items-center px-4 max-w-3xl mx-auto -mt-6">
      <div className="text-center flex flex-col items-center mb-8">
        <img src="/favicon.png" alt="Logo" className="size-10 mb-4" />
        <h1 className="type-tagline text-[clamp(28px,4vw,40px)] text-fg tracking-tight">
          {greeting}{displayName}
        </h1>
      </div>

      {/* Central Command Box */}
      <div className="w-full">
        <CouncilCockpit
          placeholder="Ask the council to research, draft, schedule, shop, or write code…"
          showTimeline={false}
          autoFocus
        />
      </div>

      {/* Quick Agent Suggestion Chips */}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {[
          { label: "Research", hint: "Research " },
          { label: "Files & Code", hint: "Write a file that " },
          { label: "Calendar", hint: "Schedule " },
          { label: "Telecom (SMS)", hint: "Text " },
          { label: "Shopper", hint: "Find prices for " },
          { label: "Market", hint: "Analyse stock " },
          { label: "Browser", hint: "Search the web for " },
        ].map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => onPick(item.hint)}
            className="type-mono text-[11px] font-bold px-3 py-1.5 bg-obsidian border-2 border-fg shadow-[2px_2px_0px_#000] hover:translate-y-0.5 transition-all text-fg"
          >
            + {item.label}
          </button>
        ))}
      </div>

      {/* Past Sessions Collapsible */}
      <div className="mt-8 w-full">
        <RecentSessionsCollapsible />
      </div>
    </div>
  );
}

/**
 * Active Run View — Real-time live Thought Stream & Results, with Command Box
 * permanently PINNED at the bottom (never scrolls away).
 */
function StudentActive({
  prefill,
  onPick,
}: {
  prefill: string;
  onPick: (hint: string) => void;
}) {
  const clearRun = useAgentStore((s) => s.clearRun);

  return (
    <div className="h-full flex overflow-hidden">
      {/* Center Feed Column + Pinned Command Bar */}
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        {/* Top Session Actions Header */}
        <div className="shrink-0 px-6 py-2.5 border-b border-hairline flex items-center justify-between bg-void">
          <span className="type-mono text-[10px] text-muted tracking-wider uppercase font-bold flex items-center gap-2">
            <span className="size-2 rounded-full bg-[#22c55e] animate-pulse" />
            LIVE COUNCIL WORKSPACE
          </span>

          <button
            type="button"
            onClick={clearRun}
            className="type-mono text-[11px] font-bold text-dim hover:text-fg border border-hairline px-2.5 py-1 bg-obsidian"
          >
            + New Chat
          </button>
        </div>

        {/* Scrollable Real-Time Content Feed */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          <ConversationFeed role="student" />
          <ArtifactPanel />
        </div>

        {/* Pinned Bottom Command Bar — NEVER SCROLLS AWAY */}
        <div className="shrink-0 border-t-2 border-fg bg-obsidian p-4 shadow-[0px_-4px_10px_rgba(0,0,0,0.04)]">
          <div className="max-w-4xl mx-auto">
            <CouncilCockpit
              placeholder="Send follow-up or give the council another command…"
              showTimeline={false}
              autoFocus
              prefill={prefill}
            />
          </div>
        </div>
      </div>

      {/* Right Column: Active Agent Dock & Recall */}
      <aside className="w-80 shrink-0 border-l border-hairline p-4 overflow-y-auto space-y-4 hidden lg:block bg-void">
        <AgentDock onPick={onPick} />
        <RecallPanel />
        <RecentSessionsCollapsible />
      </aside>
    </div>
  );
}

export function StudentScreen() {
  const agents = useAgentStore((s) => s.agents);
  const hasRun = useAgentStore((s) => s.sessionId !== null);
  const running = useAgentStore((s) => s.running);
  const [tab, setTab] = useState<Tab>("work");
  const [prefillPrompt, setPrefillPrompt] = useState("");

  const visibleRail = RAIL_ITEMS.filter(
    (item) => !item.agent || agents.includes(item.agent),
  );

  const handlePickAgent = (hint: string) => {
    setPrefillPrompt(hint);
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-void">
      <Sidebar
        items={visibleRail}
        active={tab}
        onSelect={setTab}
        middle={<RailSessions onSelectSession={() => setTab("work")} />}
        footer={<RailProfile onNavigate={(t) => setTab(t as Tab)} />}
      />

      <main className="min-w-0 flex-1 h-full overflow-hidden flex flex-col">
        {tab === "work" ? (
          hasRun || running ? (
            <StudentActive
              prefill={prefillPrompt}
              onPick={handlePickAgent}
            />
          ) : (
            <StudentIdle onPick={handlePickAgent} />
          )
        ) : tab === "shopper" ? (
          <div className="flex-1 overflow-y-auto p-6">
            <ShopperPanel />
          </div>
        ) : tab === "telecom" ? (
          <div className="flex-1 overflow-y-auto p-6">
            <TelecomInbox />
          </div>
        ) : tab === "diary" ? (
          <div className="flex-1 min-h-0 p-3 sm:p-5 flex flex-col overflow-hidden">
            <WorkDiary />
          </div>
        ) : tab === "conca" ? (
          <div className="flex-1 overflow-y-auto p-6 max-w-5xl">
            <ConcaPanel />
          </div>
        ) : tab === "settings" ? (
          <div className="flex-1 overflow-y-auto p-6 max-w-4xl">
            <ConnectAccounts />
          </div>
        ) : tab === "help" ? (
          <div className="flex-1 overflow-y-auto">
            <DocsPanel />
          </div>
        ) : tab === "calendar" ? (
          <div className="flex-1 min-h-0 p-3 sm:p-5 flex flex-col overflow-hidden">
            <CalendarScreen />
          </div>
        ) : tab === "email" ? (
          <div className="flex-1 overflow-y-auto p-6">
            <EmailHub />
          </div>
        ) : tab === "browser" ? (
          <div className="flex-1 overflow-y-auto p-6">
            <BrowserPanel />
          </div>
        ) : tab === "market" ? (
          <div className="flex-1 overflow-y-auto p-6">
            <MarketPanel />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <StudentTimetable />
          </div>
        )}
      </main>
    </div>
  );
}
