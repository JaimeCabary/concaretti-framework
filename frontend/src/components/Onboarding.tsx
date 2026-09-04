/**
 * First-run onboarding.
 *
 * Four slides explaining the things that make this app legible — delegation,
 * the policy boundary, the approval gate, and the privacy rule — then a step
 * that connects accounts.
 *
 * That last step is the useful one, and it is where the council PIN used to be.
 * A PIN at the end of onboarding asked the operator to prove they were allowed to
 * use a program running on their own machine; this asks them for the credentials
 * that make it able to do anything at all. First run is exactly the moment to ask,
 * because it is the only moment the operator is expecting to be asked for
 * something — and every panel in the app reads better with its account connected
 * than it does explaining that it is not.
 *
 * It appears only when the server says this caller can write the file: `me().setup`
 * is false off-loopback, and offering a connect step that 403s on submit is worse
 * than four slides and a Get started button.
 *
 * Animation is two CSS keyframe rules (`animate-slide-in` in `index.css`). No
 * animation library ships for four slides.
 *
 * Each slide takes an optional `art` path. When it's absent the well draws a
 * geometric stand-in from the logo's own vocabulary, so onboarding is complete
 * and shippable before any artwork exists and picks the artwork up with no code
 * change once files land in `public/onboarding/`.
 */

import { useState } from "react";
import { ConnectAccounts } from "./ConnectAccounts";
import { useAgentStore } from "../store/agentStore";
import { api } from "../lib/api";
import type { Role } from "../types";

/** Bumped if the slides ever change enough to be worth re-showing. */
const SEEN_KEY = "conca_onboarded_v1";

type Slide = {
  tagline: string;
  title: string;
  body: string;
  /** Fill for the illustration well. */
  tint: string;
  /** Optional artwork, e.g. `/onboarding/council.svg`. */
  art?: string;
};

const SLIDES: Slide[] = [
  {
    tagline: "Fifteen agents, one command —",
    title: "Tell the council",
    body: "Say what you want in plain language. A plan is drawn, each step goes to the agent that owns it, and the answers come back as one.",
    tint: "var(--color-agent-orchestrator)",
    art: "/onboarding/council.svg",
  },
  {
    tagline: "Policy is not a prompt —",
    title: "The .conca boundary",
    body: "Every plan is checked against a file you can read, after the model writes it and before any tool runs. The model cannot argue with it.",
    tint: "var(--color-agent-file)",
    art: "/onboarding/conca.svg",
  },
  {
    tagline: "Some things need a human —",
    title: "The HALO gate",
    body: "Mail, texts, calls, posts, file writes and code all stop and ask you first. Nothing outward-facing happens on a model’s say-so.",
    tint: "var(--color-council-soft)",
    art: "/onboarding/halo.svg",
  },
  {
    tagline: "Privacy is a rule, not a setting —",
    title: "Rule zero",
    body: "Sensitive turns are never indexed and never recalled. A hard conversation does not become tomorrow’s context.",
    tint: "var(--color-agent-therapy)",
    art: "/onboarding/rule-zero.svg",
  },
];

function Well({ slide }: { slide: Slide }) {
  const [broken, setBroken] = useState(false);

  return (
    <div
      className="mb-5 grid h-40 place-items-center border-2 border-fg"
      style={{ background: slide.tint, borderRadius: "var(--radius)" }}
    >
      {slide.art && !broken ? (
        <img
          src={slide.art}
          alt=""
          aria-hidden
          className="h-32 w-auto"
          onError={() => setBroken(true)}
        />
      ) : (
        /* Stand-in: the logo's hexagon and chords. Replaced silently the moment
           `slide.art` resolves. */
        <svg viewBox="0 0 96 96" className="h-28 w-28" aria-hidden>
          <polygon
            points="48,8 82,28 82,68 48,88 14,68 14,28"
            fill="none"
            stroke="#1A1A1A"
            strokeWidth="2.5"
          />
          <line
            x1="48"
            y1="8"
            x2="82"
            y2="68"
            stroke="#1A1A1A"
            strokeWidth="1.5"
          />
          <line
            x1="82"
            y1="28"
            x2="14"
            y2="68"
            stroke="#1A1A1A"
            strokeWidth="1.5"
          />
          <line
            x1="82"
            y1="68"
            x2="14"
            y2="28"
            stroke="#1A1A1A"
            strokeWidth="1.5"
          />
          <circle cx="48" cy="48" r="8" fill="#1A1A1A" />
        </svg>
      )}
    </div>
  );
}

export function Onboarding() {
  // Read once, at mount. Checking on every render would re-show the flow the
  // instant another tab wrote the key.
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(SEEN_KEY) === "1",
  );
  const [i, setI] = useState(0);
  const role = useAgentStore((s) => s.role);
  const canSetup = useAgentStore((s) => s.canSetup);

  const [initialCanSetup] = useState(canSetup);
  const [savingRole, setSavingRole] = useState(false);
  const bootstrap = useAgentStore((s) => s.bootstrap);

  if (dismissed) return null;

  const finish = () => {
    localStorage.setItem(SEEN_KEY, "1");
    setDismissed(true);
  };

  const showRoleStep = initialCanSetup;
  const steps = SLIDES.length + (canSetup ? 1 : 0) + (showRoleStep ? 1 : 0);

  const onRoleStep = showRoleStep && i === 0;
  const onConnectStep = canSetup && i === steps - 1;
  const slideIndex = showRoleStep ? i - 1 : i;
  const slide = !onRoleStep && !onConnectStep ? SLIDES[slideIndex] : null;

  const handleRoleSelect = async (newRole: Role) => {
    try {
      setSavingRole(true);
      await api.login(newRole);
      await bootstrap();
      setI(i + 1);
    } catch (err) {
      console.error("Failed to set role:", err);
    } finally {
      setSavingRole(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9000] grid place-items-center bg-void p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Concaretti"
    >
      <div
        /*
          One scroll region, and it is the middle of the card.

          The connect step used to cap an inner `<div>` at `46vh` while the card
          itself was free to grow, so on a short viewport the card overflowed the
          screen *and* the inner list scrolled inside it — two bars, and the
          footer buttons pushed off the bottom edge. Now the card is a flex column
          capped at the viewport: the heading and the buttons are fixed rows, and
          only the region between them scrolls. Nothing can leave the screen.
        */
        className={`flex w-full flex-col border-2 border-fg bg-obsidian ${
          onConnectStep ? "max-w-xl" : "max-w-md"
        }`}
        style={{
          boxShadow: "var(--shadow-lg)",
          borderRadius: "var(--radius)",
          maxHeight: "min(94svh, 60rem)",
        }}
      >
        {/* Progress pills — one per step, so the strip is four long on a phone
            wrapper that cannot reach the connect step and five here. */}
        <div className="flex shrink-0 items-center justify-between gap-3 px-6 pb-4 pt-6">
          <div className="flex gap-1.5">
            {Array.from({ length: steps }, (_, n) => (
              <span
                key={n}
                className="h-2 rounded-full border-2 border-fg transition-all"
                style={{
                  inlineSize: n === i ? 22 : 8,
                  background: n === i ? "#1A1A1A" : "transparent",
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="type-mono text-[10px] text-dim underline"
            onClick={finish}
          >
            Skip
          </button>
        </div>

        {onRoleStep ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6">
              <div className="animate-slide-in">
                <p className="type-tagline text-[15px] text-dim">
                  Who are you? —
                </p>
                <h2 className="type-display mb-2 mt-1 text-[clamp(24px,4vw,32px)]">
                  Select your role
                </h2>
                <p className="mb-5 text-[13px] leading-relaxed text-dim">
                  You are running this on your own machine, which means you have
                  full access. Choose a role to see how the system adapts to
                  different users.
                </p>

                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    disabled={savingRole}
                    className={`flex items-center justify-between rounded-lg border-2 p-4 text-left transition-colors ${role === "staff" ? "border-fg bg-elevated" : "border-hairline hover:border-fg"}`}
                    onClick={() => handleRoleSelect("staff")}
                  >
                    <div>
                      <h3 className="type-mono font-bold text-fg">
                        Staff (Council)
                      </h3>
                      <p className="mt-1 text-[12px] text-muted">
                        Full access to operations, policies, and agents.
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={savingRole}
                    className={`flex items-center justify-between rounded-lg border-2 p-4 text-left transition-colors ${role === "student" ? "border-fg bg-elevated" : "border-hairline hover:border-fg"}`}
                    onClick={() => handleRoleSelect("student")}
                  >
                    <div>
                      <h3 className="type-mono font-bold text-fg">Student</h3>
                      <p className="mt-1 text-[12px] text-muted">
                        Limited access. Can explore some agents and use the
                        sandbox.
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={savingRole}
                    className={`flex items-center justify-between rounded-lg border-2 p-4 text-left transition-colors ${role === "public" ? "border-fg bg-elevated" : "border-hairline hover:border-fg"}`}
                    onClick={() => handleRoleSelect("public")}
                  >
                    <div>
                      <h3 className="type-mono font-bold text-fg">Public</h3>
                      <p className="mt-1 text-[12px] text-muted">
                        Restricted access. Only sees the public-facing surfaces.
                      </p>
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 gap-2 px-6 pb-6 pt-4">
              <button
                type="button"
                disabled={savingRole}
                className="btn btn-primary flex-1"
                onClick={() => setI(i + 1)}
              >
                {savingRole ? "Saving..." : "Next"}
              </button>
            </div>
          </>
        ) : onConnectStep ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6">
              <div className="animate-slide-in">
                <p className="type-tagline text-[15px] text-dim">
                  One last thing —
                </p>
                <h2 className="type-display mb-2 mt-1 text-[clamp(24px,4vw,32px)]">
                  Connect your accounts
                </h2>
                <p className="mb-5 text-[13px] leading-relaxed text-dim">
                  You are <strong className="text-fg">{role}</strong> here,
                  which is everything. The agents just need somewhere to reach —
                  a model provider at minimum. All of it can wait; Settings has
                  this page.
                </p>
                <ConnectAccounts />
              </div>
            </div>

            <div className="flex shrink-0 gap-2 px-6 pb-6 pt-4">
              <button type="button" className="btn" onClick={() => setI(i - 1)}>
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary flex-1"
                onClick={finish}
              >
                Get started
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              key={i}
              className="min-h-0 flex-1 animate-slide-in overflow-y-auto px-6"
            >
              <Well slide={slide} />
              <p className="type-tagline text-[15px] text-dim">
                {slide.tagline}
              </p>
              <h2 className="type-display mb-2 mt-1 text-[clamp(24px,4vw,32px)]">
                {slide.title}
              </h2>
              <p className="mb-2 text-[13px] leading-relaxed text-dim">
                {slide.body}
              </p>
            </div>

            <div className="flex shrink-0 gap-2 px-6 pb-6 pt-4">
              {i > 0 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setI(i - 1)}
                >
                  Back
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary flex-1"
                onClick={
                  i === steps - 1 || (i === steps - 2 && !canSetup)
                    ? finish
                    : () => setI(i + 1)
                }
              >
                {i === steps - 1 || (i === steps - 2 && !canSetup)
                  ? canSetup
                    ? "Almost done"
                    : "Get started"
                  : "Next"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
