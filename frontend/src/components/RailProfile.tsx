import { useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { Role } from "../types";

export function RailProfile({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: (tab: string) => void;
}) {
  const role = useAgentStore((s) => s.role);
  const rotator = useAgentStore((s) => s.rotator);
  const offline = useAgentStore((s) => s.offline);
  const userName = useAgentStore((s) => s.userName) || "Heccker";
  const bootstrap = useAgentStore((s) => s.bootstrap);
  const [open, setOpen] = useState(false);

  const switchRole = async (targetRole: Role) => {
    setOpen(false);
    if (targetRole === role) return;
    try {
      await api.login(targetRole);
      await bootstrap();
    } catch (e) {
      console.error("Failed to switch role:", e);
    }
  };

  const handleLogout = async () => {
    setOpen(false);
    try {
      await api.logout();
      await bootstrap();
    } catch (e) {
      console.error("Logout failed:", e);
    }
  };

  const roleLabels: Record<Role, { label: string; desc: string; color: string }> = {
    staff: {
      label: "STAFF",
      desc: "Full orchestration & HALO authority",
      color: "var(--color-agent-orchestrator, #e06c75)",
    },
    student: {
      label: "STUDENT",
      desc: "Curriculum, calendar & bounded tools",
      color: "var(--color-agent-research, #61afef)",
    },
    public: {
      label: "PUBLIC",
      desc: "Public guest & research access",
      color: "var(--color-agent-memory, #98c379)",
    },
  };

  return (
    <div className="relative w-full">
      {open && (
        <>
          {/* Backdrop to close menu when clicking outside */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />

          <div
            className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-hairline bg-obsidian p-2 shadow-[0px_8px_32px_rgba(0,0,0,0.3)] z-50 animate-in fade-in slide-in-from-bottom-2 duration-150"
            style={{ borderRadius: "12px" }}
          >
            {/* User Identity Header */}
            <div className="px-3 py-2 border-b border-hairline mb-1.5 flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-fg truncate">
                  {userName}
                </p>
                <p className="type-mono text-[9px] text-muted uppercase">
                  Designation: {role.toUpperCase()}
                </p>
              </div>
              <span
                className="size-2 rounded-full shrink-0"
                style={{
                  background: offline ? "var(--color-danger)" : "var(--color-ok)",
                }}
                title={offline ? "Offline" : "Connected"}
              />
            </div>

            {/* Switch Designation Section */}
            <div className="px-1 py-1">
              <p className="type-mono px-2 py-1 text-[9px] text-muted tracking-wider uppercase font-semibold">
                Switch Designation
              </p>
              {(["staff", "student", "public"] as const).map((r) => {
                const info = roleLabels[r];
                const active = r === role;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => void switchRole(r)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-[12px] transition-colors ${
                      active
                        ? "bg-elevated text-fg font-semibold"
                        : "text-dim hover:bg-elevated/60 hover:text-fg"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full shrink-0"
                        style={{ background: info.color }}
                      />
                      <span>{info.label}</span>
                    </div>
                    {active && (
                      <span className="type-mono text-[10px] text-muted">ACTIVE</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="my-1.5 border-t border-hairline" />

            {/* Navigation & Preferences */}
            <div className="px-1 py-0.5 space-y-0.5">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNavigate?.("setup");
                }}
                className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-dim transition-colors hover:bg-elevated hover:text-fg flex items-center gap-2"
              >
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span>Settings & Integrations</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNavigate?.("help");
                }}
                className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-dim transition-colors hover:bg-elevated hover:text-fg flex items-center gap-2"
              >
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span>Documentation & Guide</span>
              </button>
            </div>

            <div className="my-1.5 border-t border-hairline" />

            {/* Logout */}
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-danger transition-colors hover:bg-danger-soft flex items-center gap-2"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span>Log out</span>
            </button>
          </div>
        </>
      )}

      {/* Profile Bar Button */}
      {collapsed ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={`${roleLabels[role].label} (${userName})`}
          className="mx-auto flex size-10 items-center justify-center rounded-full border border-hairline bg-obsidian transition-all hover:bg-elevated"
        >
          <span
            className="type-display grid size-7 place-items-center rounded-full text-[11px] font-bold text-fg"
            style={{ background: roleLabels[role].color }}
          >
            {role.slice(0, 1).toUpperCase()}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full flex items-center gap-2.5 rounded-full border border-hairline/60 hover:border-hairline bg-obsidian px-2.5 py-1.5 transition-all cursor-pointer text-left shadow-sm hover:shadow"
        >
          <span
            aria-hidden
            className="type-display grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-bold text-fg shadow-inner"
            style={{ background: roleLabels[role].color }}
          >
            {role.slice(0, 1).toUpperCase()}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 leading-tight">
              <span className="text-[11px] font-bold uppercase tracking-wide text-fg">
                {roleLabels[role].label}
              </span>
              <span
                aria-hidden
                title={offline ? "Backend unreachable" : "Connected"}
                className="size-[5px] shrink-0 rounded-full"
                style={{
                  background: offline ? "var(--color-danger)" : "var(--color-ok)",
                }}
              />
            </div>
            {rotator ? (
              <p
                className="type-mono truncate text-[9px] text-muted leading-tight"
                title="Active models answering in the ladder"
              >
                {rotator.active_count}/{rotator.ladder_size} MODELS
              </p>
            ) : (
              <p className="type-mono truncate text-[9px] text-muted leading-tight">
                ONLINE
              </p>
            )}
          </div>

          <svg
            viewBox="0 0 24 24"
            className={`size-3.5 text-dim transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="m18 15-6-6-6 6" />
          </svg>
        </button>
      )}
    </div>
  );
}
