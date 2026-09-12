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

function CouncilIllustration() {
  return (
    <svg viewBox="0 0 160 120" className="h-28 w-auto" aria-hidden="true" fill="none">
      <circle cx="80" cy="60" r="44" stroke="#1A1A1A" strokeWidth="1.2" strokeDasharray="3 3" opacity="0.35" />
      <circle cx="80" cy="60" r="26" stroke="#1A1A1A" strokeWidth="1.2" opacity="0.3" />
      <circle cx="80" cy="60" r="14" fill="#1A1A1A" />
      <path d="M74 60h12M80 54v12" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
      <line x1="80" y1="60" x2="38" y2="34" stroke="#1A1A1A" strokeWidth="1.5" />
      <circle cx="38" cy="34" r="9" fill="#F472B6" stroke="#1A1A1A" strokeWidth="2" />
      <text x="38" y="37" fontSize="7" fontWeight="bold" textAnchor="middle" fill="#1A1A1A">PLAN</text>
      <line x1="80" y1="60" x2="122" y2="34" stroke="#1A1A1A" strokeWidth="1.5" />
      <circle cx="122" cy="34" r="9" fill="#38BDF8" stroke="#1A1A1A" strokeWidth="2" />
      <text x="122" y="37" fontSize="7" fontWeight="bold" textAnchor="middle" fill="#1A1A1A">CODE</text>
      <line x1="80" y1="60" x2="36" y2="86" stroke="#1A1A1A" strokeWidth="1.5" />
      <circle cx="36" cy="86" r="9" fill="#A7F3D0" stroke="#1A1A1A" strokeWidth="2" />
      <text x="36" y="89" fontSize="7" fontWeight="bold" textAnchor="middle" fill="#1A1A1A">CAL</text>
      <line x1="80" y1="60" x2="124" y2="86" stroke="#1A1A1A" strokeWidth="1.5" />
      <circle cx="124" cy="86" r="9" fill="#FDBA74" stroke="#1A1A1A" strokeWidth="2" />
      <text x="124" y="89" fontSize="7" fontWeight="bold" textAnchor="middle" fill="#1A1A1A">MAIL</text>
      <line x1="80" y1="60" x2="80" y2="16" stroke="#1A1A1A" strokeWidth="1.5" strokeDasharray="2 2" />
      <circle cx="80" cy="16" r="6.5" fill="#E9D5FF" stroke="#1A1A1A" strokeWidth="1.8" />
    </svg>
  );
}

function ConcaBoundaryIllustration() {
  return (
    <svg viewBox="0 0 160 120" className="h-28 w-auto" aria-hidden="true" fill="none">
      <rect x="44" y="18" width="72" height="84" rx="6" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="2" />
      <line x1="54" y1="32" x2="82" y2="32" stroke="#1A1A1A" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="54" y1="42" x2="106" y2="42" stroke="#1A1A1A" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
      <line x1="54" y1="50" x2="94" y2="50" stroke="#1A1A1A" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
      <line x1="54" y1="58" x2="102" y2="58" stroke="#1A1A1A" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
      <circle cx="98" cy="82" r="18" fill="#C4F135" stroke="#1A1A1A" strokeWidth="2" />
      <path d="M98 70l11 4v8c0 7-5 12-11 14-6-2-11-7-11-14v-8l11-4z" fill="#1A1A1A" />
      <path d="M94 82l3 3 6-6" stroke="#C4F135" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HaloGateIllustration() {
  return (
    <svg viewBox="0 0 160 120" className="h-28 w-auto" aria-hidden="true" fill="none">
      <circle cx="80" cy="60" r="44" stroke="#1A1A1A" strokeWidth="1.2" strokeDasharray="4 4" opacity="0.35" />
      <rect x="52" y="30" width="56" height="58" rx="14" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="2.5" />
      <circle cx="80" cy="52" r="10" fill="#ffd93d" stroke="#1A1A1A" strokeWidth="2" />
      <path d="M80 48v8M80 64v6" stroke="#1A1A1A" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="80" cy="52" r="4" fill="#1A1A1A" />
      <rect x="61" y="72" width="38" height="14" rx="7" fill="#1A1A1A" />
      <text x="80" y="82" fontSize="7" fontWeight="bold" textAnchor="middle" fill="#FFFFFF">HALO</text>
    </svg>
  );
}

function RuleZeroIllustration() {
  return (
    <svg viewBox="0 0 160 120" className="h-28 w-auto" aria-hidden="true" fill="none">
      <rect x="46" y="22" width="68" height="74" rx="12" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="2.5" />
      <circle cx="80" cy="59" r="22" fill="#FECDD3" stroke="#1A1A1A" strokeWidth="2" />
      <circle cx="80" cy="59" r="13" stroke="#1A1A1A" strokeWidth="2.5" strokeDasharray="5 2" />
      <path d="M73 68L87 50" stroke="#1A1A1A" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="80" cy="59" r="3" fill="#1A1A1A" />
      <circle cx="55" cy="32" r="2" fill="#1A1A1A" />
      <circle cx="105" cy="32" r="2" fill="#1A1A1A" />
      <circle cx="55" cy="86" r="2" fill="#1A1A1A" />
      <circle cx="105" cy="86" r="2" fill="#1A1A1A" />
    </svg>
  );
}

function Well({ slide, index }: { slide: Slide; index: number }) {
  const illustrations = [
    <CouncilIllustration key="0" />,
    <ConcaBoundaryIllustration key="1" />,
    <HaloGateIllustration key="2" />,
    <RuleZeroIllustration key="3" />,
  ];

  return (
    <div
      className="mb-5 grid h-40 place-items-center border-2 border-fg shadow-[3px_3px_0px_#000]"
      style={{ background: slide.tint, borderRadius: "var(--radius)" }}
    >
      {illustrations[index % illustrations.length]}
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
  const userName = useAgentStore((s) => s.userName);
  const setUserName = useAgentStore((s) => s.setUserName);
  const canSetup = useAgentStore((s) => s.canSetup);

  const [selectedRole, setSelectedRole] = useState<Role>(role || "staff");
  const [nameInput, setNameInput] = useState<string>(userName || "Heccker");
  const [savingRole, setSavingRole] = useState(false);
  const bootstrap = useAgentStore((s) => s.bootstrap);

  if (dismissed) return null;

  const finish = () => {
    localStorage.setItem(SEEN_KEY, "1");
    localStorage.setItem("conca_start_tutorial", "1");
    window.dispatchEvent(new Event("conca_start_tutorial"));
    setDismissed(true);
    void api.saveProfile({
      name: nameInput.trim() || userName || "Heccker",
      role: selectedRole || role || "staff",
      onboarded: true,
    });
  };

  const showRoleStep = canSetup;
  const steps = SLIDES.length + (canSetup ? 1 : 0) + (showRoleStep ? 1 : 0);

  const onRoleStep = showRoleStep && i === 0;
  const onConnectStep = canSetup && i === steps - 1;
  const slideIndex = showRoleStep ? i - 1 : i;
  const slide = !onRoleStep && !onConnectStep ? SLIDES[slideIndex] : null;

  const handleProceedFromRoleStep = async () => {
    try {
      setSavingRole(true);
      const cleanName = nameInput.trim() || "Heccker";
      setUserName(cleanName);
      await api.login(selectedRole);
      await api.saveProfile({
        name: cleanName,
        role: selectedRole,
        onboarded: true,
      });
      await bootstrap();
      setI(i + 1);
    } catch (err) {
      console.error("Failed to set role and name:", err);
      setI(i + 1);
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
              <div className="animate-slide-in space-y-4">
                <div>
                  <p className="type-tagline text-[15px] text-dim">
                    Who are you? —
                  </p>
                  <h2 className="type-display mb-1 mt-0.5 text-[clamp(24px,4vw,30px)]">
                    Setup your profile
                  </h2>
                  <p className="text-[13px] leading-relaxed text-dim">
                    Choose your display name and role to tailor the workspace and agent permissions.
                  </p>
                </div>

                <div className="p-3 bg-void border-2 border-fg shadow-[2px_2px_0px_#000]">
                  <label className="block text-xs font-mono font-bold uppercase tracking-wider text-muted mb-1" htmlFor="operator-name">
                    Operator / Display Name
                  </label>
                  <input
                    id="operator-name"
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="e.g. Heccker, Alex, Researcher..."
                    className="w-full rounded bg-obsidian px-3 py-2 text-sm border-2 border-hairline outline-none focus:border-fg font-medium transition-colors text-fg"
                  />
                </div>

                <div className="space-y-2.5">
                  <span className="type-mono text-[11px] font-bold uppercase tracking-wider text-muted block">
                    Choose Workspace Role
                  </span>

                  <button
                    type="button"
                    className={`flex w-full items-center justify-between rounded-lg border-2 p-3.5 text-left transition-all cursor-pointer ${
                      selectedRole === "staff"
                        ? "border-fg bg-elevated shadow-[2px_2px_0px_#000]"
                        : "border-hairline hover:border-fg bg-obsidian"
                    }`}
                    onClick={() => setSelectedRole("staff")}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="type-mono font-bold text-fg text-sm">
                          Staff (Council)
                        </h3>
                        {selectedRole === "staff" && (
                          <span className="text-[10px] bg-[#68D391] text-black font-extrabold px-1.5 py-0.5 border border-black">
                            SELECTED
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] text-muted">
                        Full access to operations, policies, and all council agents.
                      </p>
                    </div>
                    <div className={`size-5 rounded-full border-2 border-fg grid place-items-center shrink-0 ml-3 ${selectedRole === "staff" ? "bg-fg text-void" : "bg-transparent"}`}>
                      {selectedRole === "staff" && <span className="text-xs font-bold leading-none text-white">✓</span>}
                    </div>
                  </button>

                  <button
                    type="button"
                    className={`flex w-full items-center justify-between rounded-lg border-2 p-3.5 text-left transition-all cursor-pointer ${
                      selectedRole === "student"
                        ? "border-fg bg-elevated shadow-[2px_2px_0px_#000]"
                        : "border-hairline hover:border-fg bg-obsidian"
                    }`}
                    onClick={() => setSelectedRole("student")}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="type-mono font-bold text-fg text-sm">
                          Student
                        </h3>
                        {selectedRole === "student" && (
                          <span className="text-[10px] bg-[#68D391] text-black font-extrabold px-1.5 py-0.5 border border-black">
                            SELECTED
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] text-muted">
                        Personal timetable, revision calendar, diary and research agents.
                      </p>
                    </div>
                    <div className={`size-5 rounded-full border-2 border-fg grid place-items-center shrink-0 ml-3 ${selectedRole === "student" ? "bg-fg text-void" : "bg-transparent"}`}>
                      {selectedRole === "student" && <span className="text-xs font-bold leading-none text-white">✓</span>}
                    </div>
                  </button>

                  <button
                    type="button"
                    className={`flex w-full items-center justify-between rounded-lg border-2 p-3.5 text-left transition-all cursor-pointer ${
                      selectedRole === "public"
                        ? "border-fg bg-elevated shadow-[2px_2px_0px_#000]"
                        : "border-hairline hover:border-fg bg-obsidian"
                    }`}
                    onClick={() => setSelectedRole("public")}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="type-mono font-bold text-fg text-sm">
                          Public
                        </h3>
                        {selectedRole === "public" && (
                          <span className="text-[10px] bg-[#68D391] text-black font-extrabold px-1.5 py-0.5 border border-black">
                            SELECTED
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] text-muted">
                        Public research, guest overview and read-only surfaces.
                      </p>
                    </div>
                    <div className={`size-5 rounded-full border-2 border-fg grid place-items-center shrink-0 ml-3 ${selectedRole === "public" ? "bg-fg text-void" : "bg-transparent"}`}>
                      {selectedRole === "public" && <span className="text-xs font-bold leading-none text-white">✓</span>}
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
                onClick={handleProceedFromRoleStep}
              >
                {savingRole ? "Saving..." : "Continue"}
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
                <p className="mb-8 text-[13px] leading-relaxed text-dim max-w-lg">
                  Agents need credentials to reach out to the real world. You can set them up now or skip and do it later in Settings.
                </p>
                <ConnectAccounts hideHeader />
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
        ) : slide ? (
          <>
            <div
              key={i}
              className="min-h-0 flex-1 animate-slide-in overflow-y-auto px-6"
            >
              <Well slide={slide} index={slideIndex} />
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
        ) : null}
      </div>
    </div>
  );
}
