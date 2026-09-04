import { useState } from "react";
import { useAgentStore } from "../store/agentStore";
import { RailGroup } from "./Sidebar";
import { relTime } from "./ui";

export function RailSessions({
  onSelectSession,
}: {
  onSelectSession?: () => void;
}) {
  const sessions = useAgentStore((s) => s.sessions);
  const current = useAgentStore((s) => s.sessionId);
  const attach = useAgentStore((s) => s.attachSession);
  const [query, setQuery] = useState("");

  const filtered = sessions.filter((s) =>
    (s.title || s.id).toLowerCase().includes(query.toLowerCase()),
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
        <ul className="space-y-0.5">
          {filtered.slice(0, 8).map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  attach(s.id);
                  onSelectSession?.();
                }}
                className={`type-mono flex w-full items-center justify-between rounded-full px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                  s.id === current
                    ? "bg-elevated font-semibold text-fg"
                    : "text-dim hover:bg-elevated hover:text-fg"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {s.title || s.id.slice(0, 8)}
                </span>
                <span className="shrink-0 text-[9px] text-muted ml-1.5">
                  {relTime(s.created_at)}
                </span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && query && (
            <li className="type-mono px-2 py-1 text-[10px] text-muted text-center italic mt-1">
              No matches found
            </li>
          )}
        </ul>
      )}
    </RailGroup>
  );
}
