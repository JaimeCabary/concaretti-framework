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

import { useEffect, useState } from "react";
import { HaloGate } from "./components/HaloGate";
import { Onboarding } from "./components/Onboarding";
import { LockScreen } from "./components/LockScreen";
import { TutorialTour } from "./components/TutorialTour";
import { Overlay } from "./components/Overlay";
import { useAgentStore } from "./store/agentStore";
import { StaffScreen } from "./screens/StaffScreen";
import { StudentScreen } from "./screens/StudentScreen";
import { PublicScreen } from "./screens/PublicScreen";


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
  const loggedOut = useAgentStore((s) => s.loggedOut);
  const onboarded = useAgentStore((s) => s.onboarded);
  const bootstrap = useAgentStore((s) => s.bootstrap);

  const [inAppOverlayOpen, setInAppOverlayOpen] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Matches Ctrl+Shift+Space OR Ctrl+Alt+Space
      const isSpace = e.code === "Space" || e.key === " ";
      const isOverlayKey = isSpace && e.ctrlKey && (e.shiftKey || e.altKey);

      if (isOverlayKey) {
        e.preventDefault();
        e.stopPropagation();

        // 1. If running inside Tauri desktop app, invoke the native overlay window
        const tauri = (window as unknown as { __TAURI__?: { core?: { invoke: (cmd: string) => Promise<unknown> } } }).__TAURI__;
        if (tauri?.core?.invoke) {
          void tauri.core.invoke("toggle_overlay").catch((err) => {
            console.warn("[overlay] toggle_overlay invoke error:", err);
          });
        } else {
          // 2. In browser / dev server mode without Tauri, toggle in-app overlay dialog
          setInAppOverlayOpen((prev) => !prev);
        }
      } else if (e.key === "Escape" && inAppOverlayOpen) {
        setInAppOverlayOpen(false);
      }
    };

    const handleCustomToggle = () => {
      const tauri = (window as unknown as { __TAURI__?: { core?: { invoke: (cmd: string) => Promise<unknown> } } }).__TAURI__;
      if (tauri?.core?.invoke) {
        void tauri.core.invoke("toggle_overlay").catch(() => {});
      } else {
        setInAppOverlayOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("conca_toggle_overlay", handleCustomToggle);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("conca_toggle_overlay", handleCustomToggle);
    };
  }, [inAppOverlayOpen]);

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
      ) : role === "student" ? (
        <StudentScreen />
      ) : (
        <PublicScreen />
      )}

      {/* Mounted at the root: a gate can open from any screen, and the
          orchestrator stays suspended until it is answered. */}
      <HaloGate />

      {/* First run only, and self-gating on localStorage. Rendered last so it
          paints over the shell it is describing. */}
      {loggedOut ? <LockScreen /> : <Onboarding />}

      {/* Interactive feature tour — only after onboarding is done */}
      {onboarded && <TutorialTour />}

      {/* Browser-mode Overlay Modal (accessible via Ctrl+Shift+Space or Ctrl+Alt+Space) */}
      {inAppOverlayOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="relative w-full max-w-[620px] shadow-2xl rounded-2xl overflow-hidden border border-hairline bg-obsidian">
            <button
              type="button"
              onClick={() => setInAppOverlayOpen(false)}
              className="absolute top-4 right-4 z-50 size-7 rounded-full bg-elevated/80 hover:bg-elevated text-dim hover:text-fg flex items-center justify-center text-xs font-bold border border-hairline shadow-xs cursor-pointer transition-colors"
              title="Close Overlay (Esc or Ctrl+Shift+Space)"
            >
              ✕
            </button>
            <Overlay />
          </div>
        </div>
      )}
    </>
  );
}
