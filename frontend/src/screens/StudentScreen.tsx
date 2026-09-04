/**
 * Student screen — narrower than the staff equivalent at every tab.
 *
 * The differences from Staff are policy, not decoration: the dock is scoped by
 * `.conca` (no email, no telecom), the thought stream is collapsed by default
 * and omits model internals, and there is no DAG panel. A student wants the
 * outcome and a way to check the work; the orchestration internals belong to
 * whoever operates the system.
 *
 * The Browser and Market tabs are grant-filtered the same way Staff's domain tabs
 * are, so revoking either in `.conca` removes it from the strip rather than leaving
 * a tab that 403s when opened. Market is here and Shopper and Chain are not for the
 * reason the policy file gives: `market` is the only one of the three money agents
 * whose entire surface is a read or a write to a local paper ledger, so it is the
 * only one that can be handed to a wider role without also handing over a path to
 * money.
 */

import { useState } from "react";
import { AgentDock } from "../components/AgentDock";
import { ArtifactPanel } from "../components/ArtifactPanel";
import { BrowserPanel } from "../components/BrowserPanel";
import { CouncilCockpit } from "../components/CouncilCockpit";
import { MarketPanel } from "../components/MarketPanel";
import { RecallPanel } from "../components/RecallPanel";
import { StudentTimetable } from "../components/StudentTimetable";
import { ThoughtStream } from "../components/ThoughtStream";
import { CalendarScreen } from "../components/CalendarScreen";
import { EmailHub } from "../components/EmailHub";
import { WorkDiary } from "../components/WorkDiary";
import { Result, TabBar } from "../components/ui";
import { useAgentStore } from "../store/agentStore";

type Tab =
  "work" | "timetable" | "browser" | "market" | "calendar" | "email" | "diary";

const TABS: ReadonlyArray<{ key: Tab; label: string; agent?: string }> = [
  { key: "work", label: "Work" },
  { key: "calendar", label: "Calendar", agent: "calendar" },
  { key: "email", label: "Email", agent: "email" },
  { key: "diary", label: "Diary" },
  { key: "timetable", label: "Timetable" },
  { key: "browser", label: "Browser", agent: "browser" },
  { key: "market", label: "Market", agent: "market" },
];

export function StudentScreen() {
  const agents = useAgentStore((s) => s.agents);
  const [tab, setTab] = useState<Tab>("work");

  const visible = TABS.filter((t) => !t.agent || agents.includes(t.agent));

  return (
    <div className="space-y-4">
      <TabBar tabs={visible} active={tab} onSelect={setTab} />

      {tab === "work" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-4">
            <CouncilCockpit placeholder="What are you working on?" autoFocus />
            <Result />
            <ThoughtStream role="student" />
            <ArtifactPanel />
          </div>
          <aside className="space-y-4">
            <AgentDock />
            <RecallPanel />
          </aside>
        </div>
      ) : tab === "calendar" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <CalendarScreen />
          <aside className="space-y-4">
            <CouncilCockpit
              placeholder="Ask about your schedule…"
              showTimeline={false}
            />
            <ThoughtStream role="student" />
          </aside>
        </div>
      ) : tab === "email" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <EmailHub />
          <aside className="space-y-4">
            <CouncilCockpit
              placeholder="Ask the council to draft an email…"
              showTimeline={false}
            />
            <ThoughtStream role="student" />
          </aside>
        </div>
      ) : tab === "diary" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <WorkDiary />
          <aside className="space-y-4">
            <CouncilCockpit
              placeholder="Ask the council to summarize your day…"
              showTimeline={false}
            />
            <ThoughtStream role="student" />
          </aside>
        </div>
      ) : tab === "browser" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <BrowserPanel />
          <aside className="space-y-4">
            <CouncilCockpit
              placeholder="Ask the council to read something for you…"
              showTimeline={false}
            />
            <ThoughtStream role="student" />
          </aside>
        </div>
      ) : tab === "market" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <MarketPanel />
          <aside className="space-y-4">
            <CouncilCockpit
              placeholder="Ask about a company — “is DANGCEM cheap right now?”"
              showTimeline={false}
            />
            <ThoughtStream role="student" />
          </aside>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <StudentTimetable />
          <aside className="space-y-4">
            <CouncilCockpit
              placeholder="Ask about your schedule — “when should I revise for stats?”"
              showTimeline={false}
            />
            <ThoughtStream role="student" />
          </aside>
        </div>
      )}
    </div>
  );
}
