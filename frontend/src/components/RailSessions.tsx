import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "../store/agentStore";
import { RailGroup } from "./Sidebar";
import { relTime } from "./ui";
import type { SessionSummary } from "../types";

function decipherSessionTitle(rawTitle: string): string {
  const t = (rawTitle || "").trim();
  if (!t) return "Untitled Run";

  if (/^scheduled\s*[-—:]/i.test(t) || /^\*\/\d+/i.test(t)) {
    if (/sentinel|heartbeat|health/i.test(t)) return "Scheduled Health Check";
    if (/calendar|event|agenda/i.test(t)) return "Scheduled Agenda Sync";
    if (/email|inbox/i.test(t)) return "Scheduled Inbox Scan";
    return "Scheduled Routine Check";
  }

  if (/^use\s+browser_act/i.test(t) || /^open\s+https?:\/\//i.test(t) || /browse/i.test(t)) {
    return "Web Page Automation";
  }
  if (/^write\s+a\s+two[- ]sentence/i.test(t) || /^write\s+a\s+short/i.test(t) || /^draft\s+an?\s+email/i.test(t)) {
    return "Draft Email / Memo";
  }
  if (/^add\s+birthday/i.test(t) || /^schedule\s+a\s+meeting/i.test(t) || /^create\s+event/i.test(t)) {
    return "Birthday / Calendar Event";
  }
  if (/^create\s+a\s+diagram/i.test(t) || /^draw\s+a\s+diagram/i.test(t) || /diagram/i.test(t)) {
    return "Architecture Diagram";
  }
  if (/^hi,?\s+how/i.test(t) || /^hello/i.test(t) || /^hey/i.test(t)) {
    return "Council Introduction";
  }

  // If it's all uppercase, convert to Title Case
  if (t === t.toUpperCase() && t.length > 3) {
    const words = t.toLowerCase().split(/\s+/).slice(0, 5);
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  return t;
}

export function RailSessions({
  onSelectSession,
}: {
  onSelectSession?: () => void;
}) {
  const sessions = useAgentStore((s) => s.sessions);
  const current = useAgentStore((s) => s.sessionId);
  const attach = useAgentStore((s) => s.attachSession);
  const renameSession = useAgentStore((s) => s.renameSession);
  const deleteSession = useAgentStore((s) => s.deleteSession);

  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [menu, setMenu] = useState<{
    session: SessionSummary;
    x: number;
    y: number;
  } | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Close context menu on click outside or escape
  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setEditingId(null);
      }
    };
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, []);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleStartRename = (s: SessionSummary) => {
    setEditingId(s.id);
    setEditTitle(s.title || s.id.slice(0, 8));
    setMenu(null);
  };

  const handleSaveRename = async (id: string) => {
    if (!editTitle.trim()) {
      setEditingId(null);
      return;
    }
    await renameSession(id, editTitle.trim());
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    setMenu(null);
    await deleteSession(id);
  };

  const handleContextMenu = (e: React.MouseEvent, s: SessionSummary) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 190);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    setMenu({ session: s, x, y });
  };

  const filtered = sessions.filter((s) =>
    (decipherSessionTitle(s.title) || s.id).toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <RailGroup label="SESSIONS" icon="clock">
      <div className="px-1 mb-2 mt-1">
        <input
          type="text"
          placeholder="Search runs..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-void border border-hairline rounded-md px-2 py-1 text-[11px] text-fg focus:outline-none focus:border-fg transition-colors"
        />
      </div>

      {sessions.length === 0 ? (
        <p className="type-mono px-2 py-1 text-[11px] text-muted">
          No runs yet
        </p>
      ) : (
        <ul className="space-y-0.5 relative">
          {filtered.slice(0, 12).map((s) => {
            const isEditing = editingId === s.id;
            const isSelected = s.id === current;
            const isTemp = Boolean(s.is_temporary);

            return (
              <li
                key={s.id}
                className="group relative"
                onContextMenu={(e) => handleContextMenu(e, s)}
              >
                {isEditing ? (
                  <div className="px-1.5 py-1">
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSaveRename(s.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={() => void handleSaveRename(s.id)}
                      className="w-full bg-void border border-accent rounded px-2 py-0.5 text-[11px] text-fg focus:outline-none ring-1 ring-accent"
                    />
                  </div>
                ) : (
                  <div
                    className={`type-mono flex w-full items-center justify-between rounded-full px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-elevated font-semibold text-fg"
                        : "text-dim hover:bg-elevated hover:text-fg"
                    }`}
                    onClick={() => {
                      attach(s.id);
                      onSelectSession?.();
                    }}
                  >
                    <div className="min-w-0 flex-1 flex items-center gap-1.5 truncate">
                      {isTemp && (
                        <span
                          title="Temporary 24h session"
                          className="shrink-0 text-[10px] text-amber-500"
                        >
                          ⏳
                        </span>
                      )}
                      <span className="truncate" title={s.title}>
                        {decipherSessionTitle(s.title) || s.id.slice(0, 8)}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0 ml-1.5">
                      <span className="text-[9px] text-muted group-hover:hidden">
                        {relTime(s.created_at)}
                      </span>
                      {/* 3-dots action button on hover */}
                      <button
                        type="button"
                        title="Session options"
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          setMenu({
                            session: s,
                            x: Math.min(rect.right, window.innerWidth - 190),
                            y: Math.min(rect.bottom + 4, window.innerHeight - 130),
                          });
                        }}
                        className="hidden group-hover:flex items-center justify-center size-5 rounded-full hover:bg-fg/10 text-muted hover:text-fg transition-colors"
                      >
                        <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor">
                          <circle cx="5" cy="12" r="2" />
                          <circle cx="12" cy="12" r="2" />
                          <circle cx="19" cy="12" r="2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}

          {filtered.length === 0 && query && (
            <li className="type-mono px-2 py-1 text-[10px] text-muted text-center italic mt-1">
              No matches found
            </li>
          )}
        </ul>
      )}

      {/* Floating Context Menu */}
      {menu && (
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: `${menu.y}px`,
            left: `${menu.x}px`,
            zIndex: 9999,
          }}
          className="w-44 rounded-xl border border-hairline/80 bg-elevated/95 backdrop-blur-md p-1 shadow-xl text-[12px] font-sans"
        >
          {menu.session.is_temporary && (
            <div className="px-2.5 py-1 text-[10px] text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1 border-b border-hairline/40 mb-1">
              <span>⏳</span>
              <span>Temporary (24h TTL)</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => handleStartRename(menu.session)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-fg hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 24 24" className="size-3.5 text-muted" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
            </svg>
            <span>Rename Session</span>
          </button>

          <button
            type="button"
            onClick={() => void handleDelete(menu.session.id)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-danger hover:bg-danger-soft transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 24 24" className="size-3.5 text-danger" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
            <span>Delete Session</span>
          </button>
        </div>
      )}
    </RailGroup>
  );
}
