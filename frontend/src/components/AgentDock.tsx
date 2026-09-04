/**
 * Which agents this role may dispatch, from `.conca`.
 *
 * Read-only, and shows the whole roster rather than only the granted subset:
 * an agent the role cannot use, or one killed by the global switch, is greyed
 * with the reason. A dock that silently omitted them would look like the
 * capability doesn't exist rather than like it was withheld — and the second is
 * the claim the policy engine actually makes.
 *
 * Clicking a granted agent prefills the composer. It's a hint to the
 * orchestrator, never a bypass: the decomposer still chooses, and the policy
 * check still runs.
 */

import { useAgentStore } from "../store/agentStore";
import { agentColor, Panel } from "./ui";

interface AgentMeta {
  key: string;
  label: string;
  blurb: string;
  hint: string;
}

/**
 * Descriptions are UI copy; the authoritative roster comes from `.conca`.
 *
 * Every dispatchable agent in the policy appears here — including the five that
 * are switched off. `orchestrator` is the one omission: it dispatches rather than
 * being dispatched to, so it is never in `role_permissions` and prefilling a
 * prompt with it would mean nothing. Anything else missing from this list would
 * be granted by the policy and invisible in the UI, which is how the count came
 * to read "10 of 9".
 */
const CATALOGUE: AgentMeta[] = [
  {
    key: "research",
    label: "Research",
    blurb: "Search, read and summarise sources",
    hint: "Research ",
  },
  {
    key: "file",
    label: "Files & Code",
    blurb: "Read, write and run code in allowed paths",
    hint: "Write a file that ",
  },
  {
    key: "calendar",
    label: "Calendar",
    blurb: "Create and check events",
    hint: "Schedule ",
  },
  {
    key: "scheduler",
    label: "Scheduler",
    blurb: "Recurring reminders and jobs",
    hint: "Remind me to ",
  },
  {
    key: "email",
    label: "Email",
    blurb: "Read the inbox, draft and send",
    hint: "Draft an email to ",
  },
  {
    key: "sms",
    label: "Telecom",
    blurb: "Send and receive SMS",
    hint: "Text ",
  },
  {
    key: "news",
    label: "News",
    blurb: "Headlines by topic",
    hint: "What's the news on ",
  },
  {
    key: "social",
    label: "Social",
    blurb: "Draft and publish posts",
    hint: "Post about ",
  },
  {
    key: "therapy",
    label: "Support",
    blurb: "Confidential — never stored for recall",
    hint: "",
  },
  {
    key: "github",
    label: "GitHub",
    blurb: "Repository activity, read-only",
    hint: "Summarise the repo ",
  },
  {
    key: "deploy",
    label: "Deploy",
    blurb: "Ship to hosting",
    hint: "",
  },
  {
    key: "browser",
    label: "Browser",
    blurb: "Drive a headless browser",
    hint: "",
  },
  {
    key: "coding",
    label: "Codegen",
    blurb: "Multi-turn code generation",
    hint: "",
  },
  {
    key: "chaos",
    label: "Chaos",
    blurb: "Prompt morphing and stress tests",
    hint: "",
  },
  {
    key: "shopper",
    label: "Shopper",
    blurb: "Product search, price comparison & cart",
    hint: "Find prices for ",
  },
  {
    key: "market",
    label: "Market",
    blurb: "Stock research, quotes & paper trade",
    hint: "Analyse ",
  },
  {
    key: "chain",
    label: "Chain",
    blurb: "Solana balance and transaction staging",
    hint: "Check balance for ",
  },
  {
    key: "health",
    label: "Health",
    blurb: "Process telemetry",
    hint: "",
  },
];

export function AgentDock({
  onPick,
  className = "",
}: {
  onPick?: (hint: string) => void;
  className?: string;
}) {
  const granted = useAgentStore((s) => s.agents);
  const grantedSet = new Set(granted);

  // Show only agents that the current role is actually granted
  const visible = CATALOGUE.filter((a) => grantedSet.has(a.key));

  return (
    <Panel
      title="Agents"
      accent="var(--color-council)"
      className={className}
      actions={
        <span className="text-[11px] text-muted">
          {visible.length} available
        </span>
      }
      bodyClass="overflow-y-auto"
    >
      <ul className="grid grid-cols-2 gap-1.5 px-3 py-3">
        {visible.map((a) => (
          <li key={a.key}>
            <button
              type="button"
              disabled={!onPick}
              onClick={() => onPick?.(a.hint)}
              title={a.blurb}
              className="tile w-full px-2.5 py-2 text-left transition-transform active:translate-y-0.5"
              style={{ background: agentColor(a.key) }}
            >
              <span className="truncate block text-[12px] font-semibold text-fg">
                {a.label}
              </span>
              <span className="mt-0.5 block text-[10px] leading-snug text-dim line-clamp-2">
                {a.blurb}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="px-3 pb-3 text-[10px] leading-snug text-muted">
        Scoping comes from <code className="font-mono">.conca</code>. Picking an
        agent prefills your prompt.
      </p>
    </Panel>
  );
}
