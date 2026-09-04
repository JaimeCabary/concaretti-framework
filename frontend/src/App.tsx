/**
 * App shell: screen routing by role, and the global HALO gate.
 *
 * Routing is by role, not by URL. The three role screens are different products
 * sharing a backend rather than pages of one site, and the brief scopes them
 * that way. Deep links aren't part of the product, so a router library would be
 * dependency for its own sake.
 *
 * Role is whatever the server says, and the header reports it rather than
 * offering to change it. Two things have stood here before: a segmented control,
 * which meant anyone could become staff by clicking, and then a council PIN,
 * which asked whoever was sitting at this machine to type a secret before they
 * could reach a program whose policy file, database and `.env` they could already
 * open in a text editor. Both are gone. A caller on the loopback interface is
 * granted staff outright; a caller from any other host gets `CONCA_OPEN_ROLE`
 * — `public` unless it is deliberately widened — and has no way to escalate,
 * because the one endpoint that sets the cookie refuses off-loopback.
 */

import { useEffect } from "react";
import { HaloGate } from "./components/HaloGate";
import { Onboarding } from "./components/Onboarding";
import { useAgentStore } from "./store/agentStore";
import { PublicScreen } from "./screens/PublicScreen";
import { StaffScreen } from "./screens/StaffScreen";
import { StudentScreen } from "./screens/StudentScreen";
import { Brand } from "./components/ui";

/**
 * Which tier the server granted this request.
 *
 * A readout, not a control. It is worth a chip rather than nothing at all because
 * the screens differ enough that "why is there no Email tab" is a real question,
 * and the answer is always this word.
 */
function RoleChip() {
  const role = useAgentStore((s) => s.role);
  return (
    <span
      className={`chip ${role === "staff" ? "bg-ok-soft" : ""}`}
      title={
        role === "staff"
          ? "Granted because this request came from this machine"
          : "Granted to callers from other hosts — set CONCA_OPEN_ROLE to widen it"
      }
    >
      {role}
    </span>
  );
}

function OfflineBanner() {
  const offline = useAgentStore((s) => s.offline);
  if (!offline) return null;
  return (
    <div className="border-b-2 border-fg bg-warn-soft px-4 py-1.5 text-center text-[12px] font-semibold text-fg">
      Offline — showing the last cached view. New runs need the backend.
    </div>
  );
}

export function App() {
  const role = useAgentStore((s) => s.role);
  const roleLoaded = useAgentStore((s) => s.roleLoaded);
  const bootstrap = useAgentStore((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!roleLoaded) {
    return (
      <>
        <div className="rainbow-bar" aria-hidden />
        <div className="flex min-h-dvh items-center justify-center">
          <span className="size-3 animate-pulse-soft rounded-full border-2 border-fg bg-council-soft" />
        </div>
      </>
    );
  }

  return (
    <>
      {/* Fixed, 4px, above everything. The one piece of pure decoration in the
          app, and the first thing that identifies it. */}
      <div className="rainbow-bar" aria-hidden />

      <OfflineBanner />

      {/*
        Staff is full-bleed: it owns a navigation rail that has to reach both
        edges of the viewport, and the rail already carries the wordmark and the
        role readout that the top bar used to. A centred `max-w` column with a
        sticky header above it would put a second horizontal rule across a screen
        whose whole point is that there is one thing on it.

        The other two roles keep the framed shell — neither has enough
        destinations to earn a rail.
      */}
      {role === "staff" ? (
        <StaffScreen />
      ) : (
        <div className="min-h-dvh pt-1">
          {/* Solid cream, not a blur: nothing in this style is translucent, and a
              backdrop-filter on a sticky header is the most expensive way to draw
              a rectangle. */}
          <header className="sticky top-0 z-30 border-b-2 border-fg bg-void">
            <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-2.5">
              <Brand />
              <div className="flex items-center gap-3">
                <span className="type-mono hidden text-[10px] text-muted lg:inline">
                  concurrent agentic reasoning, execution &amp; trust
                </span>
                <RoleChip />
              </div>
            </div>
          </header>

          <main className="mx-auto max-w-[1600px] px-4 py-4">
            {role === "student" ? <StudentScreen /> : <PublicScreen />}
          </main>
        </div>
      )}

      {/* Mounted at the root: a gate can open from any screen, and the
          orchestrator stays suspended until it is answered. */}
      <HaloGate />

      {/* First run only, and self-gating on localStorage. Rendered last so it
          paints over the shell it is describing. */}
      <Onboarding />
    </>
  );
}
