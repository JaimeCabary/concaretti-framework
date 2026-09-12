/**
 * Staff screen — the operations view.
 *
 * Everything the other two roles get, plus the parts that are only meaningful to
 * whoever runs the system: the layered plan with refusals visible, the thought
 * stream with model and tier per step, the policy engine, and every domain panel
 * the role is granted.
 *
 * Seven of the eleven destinations are grant-filtered and one more is
 * loopback-filtered, so the rail is a readable summary of what this role may
 * actually do — a revoked agent has no entry rather than an entry that 403s on
 * open. Staff is the only role granted all three money agents, which is why
 * Shopper, Market and Chain live here and only Market is echoed on the student
 * screen.
 *
 * **Nothing empty renders.** This screen previously laid out eight panels
 * unconditionally, so a first paint with no run was eight bordered white
 * rectangles each containing a sentence explaining that it had nothing to show —
 * the plan, the stream, the artifacts and the result all at once. The fix is not
 * smaller boxes, it is fewer: `hasRun` gates the whole work area, and before a
 * run there is a headline, a composer, and whitespace. Every one of those panels
 * appears the moment it has something in it, which is also the moment it earns
 * the space.
 *
 * The three-column ops layout also moved from `xl:` to `lg:`. At 150% display
 * scaling a 1920px screen is 1280 CSS px wide, which is *just* under the old
 * breakpoint — so the widest desktop most people have was getting the phone
 * layout, and that is what stacked those eight panels into one column.
 */

import { useState, useEffect, useRef } from "react";
import { AgentDock } from "../components/AgentDock";
import { ArtifactPanel } from "../components/ArtifactPanel";
import { BrowserPanel } from "../components/BrowserPanel";
import { CalendarScreen } from "../components/CalendarScreen";
import { ChainPanel } from "../components/ChainPanel";
import { ConcaPanel } from "../components/ConcaPanel";
import { ConnectAccounts } from "../components/ConnectAccounts";
import { CouncilCockpit } from "../components/CouncilCockpit";
import { DagOrchestrationStage } from "../components/DagOrchestrationStage";
import { DocsPanel } from "../components/DocsPanel";
import { EmailHub } from "../components/EmailHub";
import { MarketPanel } from "../components/MarketPanel";
import { ShopperPanel } from "../components/ShopperPanel";

import { RailProfile } from "../components/RailProfile";
import { RailSessions } from "../components/RailSessions";
import { Sidebar, type RailItem } from "../components/Sidebar";
import { TelecomInbox } from "../components/TelecomInbox";
import { ThoughtStream } from "../components/ThoughtStream";
import { ConversationFeed } from "../components/ConversationFeed";
import { WorkDiary } from "../components/WorkDiary";
import { AgentTag } from "../components/ui";
import { useAgentStore } from "../store/agentStore";
import type { Subtask } from "../types";

function AutonomousHudBanner({
  agent,
  description,
  isFinished,
  countdown,
  onReturn,
}: {
  agent: string;
  description: string;
  isFinished: boolean;
  countdown: number | null;
  onReturn: () => void;
}) {
  return (
    <div className="shrink-0 bg-obsidian border-b-2 border-hairline/80 px-4 py-2.5 flex items-center justify-between shadow-md z-30 transition-all">
      <div className="flex items-center gap-3 min-w-0 pr-2">
        <span className="relative flex size-2.5 shrink-0">
          <span
            className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
              isFinished ? "bg-ok" : "bg-[#00E5FF] animate-ping"
            }`}
          />
          <span
            className={`relative inline-flex size-2.5 rounded-full ${
              isFinished ? "bg-ok" : "bg-[#00E5FF]"
            }`}
          />
        </span>
        <AgentTag agent={agent} />
        <span className="type-mono text-[12px] text-fg font-medium truncate">
          {isFinished
            ? `✓ Action complete! Returning to Council in ${countdown ?? 2}s...`
            : `Autonomous Action in Progress: ${description}`}
        </span>
      </div>

      <button
        type="button"
        onClick={onReturn}
        className="btn btn-primary text-[11px] py-1 px-3 flex items-center gap-1.5 shrink-0 font-mono font-bold hover:brightness-110 active:scale-95 transition-transform cursor-pointer"
      >
        <span>← Return to Council</span>
      </button>
    </div>
  );
}

type Tab =
  | "ops"
  | "calendar"
  | "email"
  | "telecom"
  | "browser"
  | "shopper"
  | "market"
  | "chain"
  | "diary"
  | "policy"
  | "help"
  | "setup";

/**
 * `secondary` puts an entry under the MORE rule; `footer` pins it to the bottom
 * of the rail. Policy and Setup are pinned together on purpose: both are
 * configuration, and between them they are the whole answer to "why can't it do
 * X" — either the policy withholds the capability or the account behind it was
 * never connected.
 */
const ITEMS: ReadonlyArray<RailItem<Tab> & { local?: boolean }> = [
  { key: "ops", label: "Create new chat" },
  { key: "calendar", label: "Calendar", agent: "calendar" },
  { key: "email", label: "Email", agent: "email" },
  { key: "telecom", label: "Telecom", agent: "sms" },
  { key: "browser", label: "Browser", agent: "browser" },
  { key: "diary", label: "Diary" },
  // The three money agents. Each is gated on its own grant rather than on a
  // shared "money" flag, because the policy grants per agent: a role can hold
  // `market` — whose whole surface is a read or a local paper write — without
  // holding `chain`, which owns `chain_prepare_tx`.
  { key: "shopper", label: "Shopper", agent: "shopper", secondary: true },
  { key: "market", label: "Market", agent: "market", secondary: true },
  { key: "chain", label: "Chain", agent: "chain", secondary: true },
  { key: "policy", label: ".conca Rules", footer: true },
  { key: "help", label: "Documentation", footer: true },
  { key: "setup", label: "Settings", footer: true, local: true },
];

/**
 * First paint: a headline, a composer, nothing else.
 *
 * Nothing under the fold. The session list moved to the rail and the agent list
 * moved to the rules page, which is what makes this a single screen with one
 * thing on it rather than a scroll.
 */
function Idle() {
  const userName = useAgentStore((s) => s.userName);
  const displayName = userName ? `, ${userName}` : "";
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
      </div>

      <div className="w-full">
        <CouncilCockpit
          placeholder="Ask anything or tell the council what you need…"
          showTimeline={false}
          autoFocus
        />
      </div>
    </div>
  );
}

/**
 * A live or finished run: the answer, then the plan and the stream beside it.
 *
 * Two columns rather than three. The recall panel and the agent list were the
 * third, and neither is about the run in progress — they were there because the
 * column existed.
 */
function Run() {
  return (
    <div className="flex flex-col h-full w-full">
      {/* Independent Scrolling Columns */}
      <div className="flex-1 min-h-0 px-5 pt-6 pb-6 sm:px-8 lg:px-12">
        <div className="mx-auto w-full h-full max-w-[86rem]">
          <div className="grid gap-x-10 h-full lg:grid-cols-2">
            <div className="min-w-0 flex flex-col gap-8 h-full overflow-y-auto pb-8 pr-2">
              <ConversationFeed role="staff" />
              <DagOrchestrationStage />
              <ArtifactPanel />
            </div>
            <div className="min-w-0 flex flex-col gap-8 h-full overflow-y-auto pb-8 pl-2">
              <ThoughtStream role="staff" />
            </div>
          </div>
        </div>
      </div>

      {/* Pinned Bottom Command Bar */}
      <div className="shrink-0 border-t-2 border-fg bg-obsidian p-4 shadow-[0px_-4px_10px_rgba(0,0,0,0.04)]">
        <div className="max-w-4xl mx-auto">
          <CouncilCockpit
            placeholder="Send follow-up or give the council another command…"
            showTimeline={false}
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}
export function StaffScreen() {
  const agents = useAgentStore((s) => s.agents);
  const canSetup = useAgentStore((s) => s.canSetup);
  const hasRun = useAgentStore((s) => s.sessionId !== null);
  const clearRun = useAgentStore((s) => s.clearRun);
  const subtasks = useAgentStore((s) => s.subtasks);
  const running = useAgentStore((s) => s.running);
  const [tab, setTab] = useState<Tab>("ops");
  const autoSwitchRef = useRef<string | null>(null);
  const [returnCountdown, setReturnCountdown] = useState<number | null>(null);
  const [lastActiveTask, setLastActiveTask] = useState<Subtask | null>(null);

  useEffect(() => {
    const runningTask = subtasks.find((t) => t.status === "running");
    if (runningTask && runningTask.agent) {
      setLastActiveTask(runningTask);
      if (autoSwitchRef.current !== runningTask.id) {
        autoSwitchRef.current = runningTask.id;
        const agentToTab: Record<string, Tab> = {
          calendar: "calendar",
          email: "email",
          sms: "telecom",
          telecom: "telecom",
          browser: "browser",
          shopper: "shopper",
          market: "market",
          chain: "chain",
          diary: "diary",
        };
        const newTab = agentToTab[runningTask.agent];
        if (newTab) {
          setTab(newTab);
        }
      }
    } else if (!running && autoSwitchRef.current) {
      // Run completed: give 2.5s graceful countdown to show success on screen before rerouting
      setReturnCountdown(2);
      const timer = setInterval(() => {
        setReturnCountdown((c) => {
          if (c === null || c <= 1) {
            clearInterval(timer);
            setTab("ops");
            autoSwitchRef.current = null;
            return null;
          }
          return c - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [subtasks, running]);

  const returnToOps = () => {
    setTab("ops");
    autoSwitchRef.current = null;
    setReturnCountdown(null);
  };

  const visible = ITEMS.filter(
    (t) => (!t.agent || agents.includes(t.agent)) && (!t.local || canSetup),
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
        {/* Floating Autonomous HUD Banner when agent is manipulating screen outside ops */}
        {tab !== "ops" && (running || returnCountdown !== null) && lastActiveTask && (
          <AutonomousHudBanner
            agent={lastActiveTask.agent}
            description={lastActiveTask.description || lastActiveTask.task_type}
            isFinished={!running}
            countdown={returnCountdown}
            onReturn={returnToOps}
          />
        )}

        {tab === "ops" ? (
          hasRun ? (
            <Run />
          ) : (
            <div className="flex-1 overflow-y-auto px-5 pb-20 pt-6 sm:px-8 lg:px-12">
              <Idle />
            </div>
          )
        ) : tab === "help" ? (
          <div className="flex-1 overflow-y-auto">
            <DocsPanel />
          </div>
        ) : tab === "setup" ? (
          /* Capped, and alone. A live thought stream beside a form full of
             password fields has nothing to say about it. */
          <div className="flex-1 overflow-y-auto px-5 pb-20 pt-6 sm:px-8 lg:px-12">
            <div className="max-w-3xl">
              <ConnectAccounts />
            </div>
          </div>
        ) : tab === "policy" ? (
          <div className="flex-1 overflow-y-auto px-5 pb-20 pt-6 sm:px-8 lg:px-12">
            <div className="max-w-5xl space-y-10">
              <ConcaPanel />
              <div className="max-w-2xl">
                <CouncilCockpit
                  placeholder="Try something the policy should refuse…"
                  showTimeline={false}
                />
              </div>

              {/*
                The agent list lives here rather than under the composer on the
                Council page, because it is a readout of what the policy granted —
                every entry in it is an `enabled` line in the file above, and a
                revoked agent simply is not in it. On the Council page it was a
                grid of sixteen tiles between the operator and the whitespace the
                page is for; here it is the answer to the question the page raises.
              */}
              <div>
                <h2 className="type-display mb-1 text-[20px]">
                  What this grants
                </h2>
                <p className="mb-5 text-[13px] leading-relaxed text-dim">
                  Every agent below is an enabled line in the file. Revoke one and
                  it disappears from here, from the rail, and from the plan.
                </p>
                <AgentDock />
              </div>
            </div>
          </div>
        ) : tab === "calendar" ? (
          <div className="flex-1 min-h-0 p-3 sm:p-5 flex flex-col overflow-hidden">
            <CalendarScreen />
          </div>
        ) : tab === "diary" ? (
          <div className="flex-1 min-h-0 p-3 sm:p-5 flex flex-col overflow-hidden">
            <WorkDiary />
          </div>
        ) : (
          /* One column at full width. Clean domain panels without stage clipping. */
          <div className="flex-1 overflow-y-auto px-5 pb-20 pt-6 sm:px-8 lg:px-12">
            <div className="space-y-10">
              <div className="min-w-0">
                {tab === "email" ? (
                  <EmailHub />
                ) : tab === "telecom" ? (
                  <TelecomInbox />
                ) : tab === "browser" ? (
                  <BrowserPanel />
                ) : tab === "shopper" ? (
                  <ShopperPanel />
                ) : tab === "market" ? (
                  <MarketPanel />
                ) : (
                  <ChainPanel />
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
