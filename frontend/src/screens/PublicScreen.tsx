/**
 * Public screen — unified multi-agent operating interface with public guest scoping.
 *
 * All usecases are visible across the council, with un-onboarded services clearly
 * designated as PENDING (designed to link via automated zero-config onboarding rather
 * than developer .env configuration).
 */

import { useState } from "react";
import { CouncilCockpit } from "../components/CouncilCockpit";
import { ArtifactPanel } from "../components/ArtifactPanel";
import { CalendarScreen } from "../components/CalendarScreen";
import { EmailHub } from "../components/EmailHub";
import { WorkDiary } from "../components/WorkDiary";
import { TelecomInbox } from "../components/TelecomInbox";
import { DocsPanel } from "../components/DocsPanel";
import { ShopperPanel } from "../components/ShopperPanel";
import { MarketPanel } from "../components/MarketPanel";
import { ChainPanel } from "../components/ChainPanel";
import { GithubPanel } from "../components/GithubPanel";
import { ConcaPanel } from "../components/ConcaPanel";
import { ConnectAccounts } from "../components/ConnectAccounts";
import { Sidebar, type RailItem } from "../components/Sidebar";
import { RailProfile } from "../components/RailProfile";
import { RailSessions } from "../components/RailSessions";
import { ConversationFeed } from "../components/ConversationFeed";
import { useAgentStore } from "../store/agentStore";

type Tab =
  | "ops"
  | "calendar"
  | "email"
  | "telecom"
  | "github"
  | "shopper"
  | "market"
  | "chain"
  | "diary"
  | "conca"
  | "help"
  | "setup";

const ITEMS: ReadonlyArray<RailItem<Tab>> = [
  { key: "ops", label: "Council", agent: "research" },
  { key: "calendar", label: "Calendar", agent: "calendar", pending: true },
  { key: "email", label: "Email", agent: "email", pending: true },
  { key: "telecom", label: "Telecom", agent: "sms", pending: true },
  { key: "github", label: "GitHub", pending: true },
  { key: "diary", label: "Diary", pending: true },
  { key: "shopper", label: "Shopper", agent: "shopper", secondary: true, pending: true },
  { key: "market", label: "Market", agent: "market", secondary: true, pending: true },
  { key: "chain", label: "Chain", agent: "chain", secondary: true, pending: true },
  { key: "conca", label: ".conca Rules", footer: true },
  { key: "help", label: "Documentation", footer: true },
  { key: "setup", label: "Settings", footer: true },
];

const SUGGESTIONS = [
  "What is a multi-agent system, in plain terms?",
  "Summarise the case for human oversight of autonomous agents",
  "Find recent research on AI safety evaluation",
];

function PendingNotice({ serviceName, onConnect }: { serviceName: string; onConnect: () => void }) {
  return (
    <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/25 px-6 py-3 flex items-center justify-between shadow-2xs">
      <div className="flex items-center gap-3">
        <span className="type-mono text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/20 text-amber-500 border border-amber-500/30 shrink-0">
          Pending Onboarding
        </span>
        <span className="text-[12px] text-fg/90">
          <strong>{serviceName}</strong> is pending automated account linking. In Public mode, services link via zero-config user onboarding rather than developer <code>.env</code> setup.
        </span>
      </div>
      <button
        type="button"
        onClick={onConnect}
        className="type-mono text-[11px] font-bold text-amber-500 hover:text-amber-400 border border-amber-500/40 px-3 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 transition-all shrink-0 cursor-pointer"
      >
        Onboard Service →
      </button>
    </div>
  );
}

function PublicIdle({ onPick }: { onPick: (hint: string) => void }) {
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
          PUBLIC GUEST & RESEARCH ROLE
        </p>
      </div>

      <div className="w-full space-y-4">
        <CouncilCockpit
          placeholder="Ask anything or request academic research…"
          showTimeline={false}
          autoFocus
        />

        {/* Suggestion Chips */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {[
            { label: "Research", hint: "Research ", pending: false },
            { label: "Files & Code", hint: "Write a file that ", pending: true },
            { label: "Calendar", hint: "Schedule ", pending: true },
            { label: "Telecom (SMS)", hint: "Text ", pending: true },
            { label: "Shopper", hint: "Find prices for ", pending: true },
            { label: "Market", hint: "Analyse stock ", pending: true },
            { label: "GitHub", hint: "Check GitHub repo ", pending: true },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => onPick(item.hint)}
              className="type-mono text-[11px] font-bold px-3 py-1.5 bg-obsidian border-2 border-fg shadow-[2px_2px_0px_#000] hover:translate-y-0.5 transition-all text-fg flex items-center gap-1.5 cursor-pointer"
            >
              <span>+ {item.label}</span>
              {item.pending && (
                <span className="text-[8px] uppercase tracking-wider px-1 rounded bg-amber-500/20 text-amber-500 font-extrabold border border-amber-500/30">
                  Pending
                </span>
              )}
            </button>
          ))}
        </div>

        <ul className="flex flex-wrap justify-center gap-2 pt-4">
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

function PublicRun({ prefill }: { prefill: string }) {
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
            prefill={prefill}
          />
        </div>
      </div>
    </div>
  );
}

export function PublicScreen() {
  const hasRun = useAgentStore((s) => s.sessionId !== null);
  const running = useAgentStore((s) => s.running);
  const clearRun = useAgentStore((s) => s.clearRun);
  const [tab, setTab] = useState<Tab>("ops");
  const [prefill, setPrefill] = useState("");

  const handlePick = (hint: string) => {
    setPrefill(hint);
    setTab("ops");
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-void">
      <Sidebar
        items={ITEMS}
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
            <PublicRun prefill={prefill} />
          ) : (
            <div className="flex-1 overflow-y-auto px-5 pb-20 pt-6 sm:px-8 lg:px-12">
              <PublicIdle onPick={handlePick} />
            </div>
          )
        ) : tab === "help" ? (
          <div className="flex-1 overflow-y-auto">
            <DocsPanel />
          </div>
        ) : tab === "conca" ? (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            <ConcaPanel />
          </div>
        ) : tab === "setup" ? (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            <ConnectAccounts />
          </div>
        ) : tab === "calendar" ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PendingNotice serviceName="Calendar" onConnect={() => setTab("setup")} />
            <div className="flex-1 min-h-0 p-3 sm:p-5 flex flex-col overflow-hidden">
              <CalendarScreen />
            </div>
          </div>
        ) : tab === "email" ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PendingNotice serviceName="Email Hub" onConnect={() => setTab("setup")} />
            <div className="flex-1 overflow-y-auto p-6">
              <EmailHub />
            </div>
          </div>
        ) : tab === "telecom" ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PendingNotice serviceName="Telecom & SMS" onConnect={() => setTab("setup")} />
            <div className="flex-1 overflow-y-auto p-6">
              <TelecomInbox />
            </div>
          </div>
        ) : tab === "github" ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PendingNotice serviceName="GitHub Intelligence" onConnect={() => setTab("setup")} />
            <div className="flex-1 overflow-y-auto p-6">
              <GithubPanel />
            </div>
          </div>
        ) : tab === "shopper" ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PendingNotice serviceName="Autonomous Shopper" onConnect={() => setTab("setup")} />
            <div className="flex-1 overflow-y-auto p-6">
              <ShopperPanel />
            </div>
          </div>
        ) : tab === "market" ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PendingNotice serviceName="Market Intelligence" onConnect={() => setTab("setup")} />
            <div className="flex-1 overflow-y-auto p-6">
              <MarketPanel />
            </div>
          </div>
        ) : tab === "chain" ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PendingNotice serviceName="Solana & On-Chain Tools" onConnect={() => setTab("setup")} />
            <div className="flex-1 overflow-y-auto p-6">
              <ChainPanel />
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PendingNotice serviceName="Work Diary" onConnect={() => setTab("setup")} />
            <div className="flex-1 min-h-0 p-3 sm:p-5 flex flex-col overflow-hidden">
              <WorkDiary />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
