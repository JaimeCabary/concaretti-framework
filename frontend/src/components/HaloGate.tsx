/**
 * HALO Gate — Human-Agent Loop Oversight.
 *
 * The orchestrator is suspended on a future while this is open. Three properties
 * matter and are load-bearing:
 *
 *   1. Fail-closed. The backend refuses on timeout, so the countdown is shown
 *      rather than hidden — an operator who walks away should know the action
 *      will be refused, not silently wonder which way it went.
 *   2. Options come from the model, so the labels are contextual to the action
 *      instead of a generic yes/no. `generated_by` says which rung produced
 *      them, including when it fell back to the stub.
 *   3. Free text is a real path, not a comment box. The backend classifies it
 *      and may run a helper agent before resuming — so the placeholder invites
 *      a condition rather than an opinion.
 *
 * Not dismissible by backdrop click or Escape. A stray click must not resolve a
 * gate on an irreversible action.
 */

import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "../store/agentStore";
import { AgentTag, Chip } from "./ui";

/** Mirrors `halo.DEFAULT_TIMEOUT_SECONDS`. */
const TIMEOUT_SECONDS = 300;

export function HaloGate() {
  const req = useAgentStore((s) => s.pendingHalo);
  const resolve = useAgentStore((s) => s.resolveHalo);

  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(TIMEOUT_SECONDS);
  const firstAction = useRef<HTMLButtonElement>(null);

  // Reset per gate: a second approval in the same run must not inherit the
  // first one's typed text or its expired countdown.
  useEffect(() => {
    if (!req) return;
    setCustom("");
    setBusy(false);
    const elapsed = Math.max(0, Date.now() / 1000 - req.created_at);
    setRemaining(Math.max(0, Math.round(TIMEOUT_SECONDS - elapsed)));
    firstAction.current?.focus();
  }, [req?.id, req]);

  useEffect(() => {
    if (!req) return;
    const t = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(t);
  }, [req?.id, req]);

  if (!req) return null;

  const send = async (choiceIndex: number | null, text?: string) => {
    setBusy(true);
    await resolve(choiceIndex, text);
  };

  const mins = Math.floor(remaining / 60);
  const secs = String(remaining % 60).padStart(2, "0");
  const urgent = remaining <= 45;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      /*
        Flat ink scrim, no blur. A backdrop filter is the one effect this style
        has no vocabulary for, and at 30% the panel behind still reads — which
        matters here, because the gate is asking about an action the operator can
        only judge in the context of the run underneath it.
      */
      style={{ background: "rgba(26, 26, 26, 0.3)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="halo-title"
    >
      <div
        className="w-full max-w-lg bg-obsidian"
        /* Deeper offset than a resting panel: the gate is the frontmost thing on
           screen and should sit visibly above it. */
        style={{
          border: "var(--border-thick)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-xl)",
        }}
      >
        <header className="panel-head bg-warn-soft">
          <div className="flex items-center gap-2">
            <span className="size-2.5 animate-pulse-soft rounded-full border-2 border-fg bg-obsidian" />
            <h2 id="halo-title" className="type-display text-[14px] text-fg">
              Approval required
            </h2>
          </div>
          <span
            className={`font-mono text-[11px] font-semibold tabular-nums ${
              urgent ? "text-danger" : "text-fg"
            }`}
            title="The gate refuses automatically when this reaches zero"
          >
            {mins}:{secs}
          </span>
        </header>

        <div className="space-y-4 px-4 py-4">
          <div>
            <div className="flex items-center gap-1.5">
              <AgentTag agent={req.agent} />
              <span className="type-mono text-[10px] text-muted">
                is asking
              </span>
            </div>
            <p className="mt-1 text-[15px] font-medium leading-snug text-fg">
              {req.action}
            </p>
            {req.details ? (
              <pre
                className="inset mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap px-3 py-2
                  font-mono text-[12px] leading-relaxed text-dim"
              >
                {req.details}
              </pre>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            {req.options.map((opt, i) => (
              <button
                key={`${opt.label}-${i}`}
                ref={i === 0 ? firstAction : undefined}
                type="button"
                disabled={busy}
                onClick={() => void send(i)}
                className={`btn w-full justify-start text-left ${
                  opt.approves ? "btn-primary" : "btn-danger"
                }`}
              >
                <span className="flex-1">
                  <span className="block">{opt.label}</span>
                  {opt.note ? (
                    <span className="block text-[11px] font-normal text-dim">
                      {opt.note}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>

          <div className="space-y-2 border-t-2 border-fg pt-3">
            <label
              htmlFor="halo-custom"
              className="type-mono text-[10px] text-muted"
            >
              Or answer in your own words
            </label>
            <textarea
              id="halo-custom"
              rows={2}
              value={custom}
              disabled={busy}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  (e.metaKey || e.ctrlKey) &&
                  custom.trim()
                ) {
                  e.preventDefault();
                  void send(null, custom.trim());
                }
              }}
              placeholder="e.g. yes, but check the address against my contacts first"
              className="field resize-none"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] leading-snug text-muted">
                A condition here may run a helper step before this action
                proceeds. Anything unparseable is treated as a refusal.
              </p>
              <button
                type="button"
                disabled={busy || !custom.trim()}
                onClick={() => void send(null, custom.trim())}
                className="btn shrink-0"
              >
                Submit
              </button>
            </div>
          </div>

          <p className="text-[10px] text-muted">
            Options written by{" "}
            <Chip title="The rotator rung that generated these options">
              {req.generated_by || "stub"}
            </Chip>
          </p>
        </div>
      </div>
    </div>
  );
}
