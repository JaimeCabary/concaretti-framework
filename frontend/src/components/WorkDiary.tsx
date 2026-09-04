/**
 * Work Diary — one entry per day, with an optional agent-written summary.
 *
 * `agent_assisted` is stored per entry and shown, so a reader can tell which
 * reflections a person wrote and which an agent drafted. Blurring that would
 * make the diary useless as a record of the person's own thinking.
 *
 * The suggestion path sends the day's sessions to the orchestrator and lets the
 * operator edit the result before saving — nothing is written on their behalf.
 */

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { DiaryEntry } from "../types";
import { Chip, Empty } from "./ui";

const today = () => new Date().toISOString().slice(0, 10);

const prettyDay = (day: string) => {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  if (day === today()) return "Today";
  return d.toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
};

export function WorkDiary() {
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);
  const finalSummary = useAgentStore((s) => s.finalSummary);
  const sessions = useAgentStore((s) => s.sessions);

  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [summary, setSummary] = useState("");
  const [reflection, setReflection] = useState("");
  const [assisted, setAssisted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pulled, setPulled] = useState(false);

  const load = useCallback(() => {
    // `void` rather than returning the chain: an effect callback must return a
    // cleanup function or nothing, never a Promise.
    void api
      .diary()
      .then((r) => {
        setEntries(r.entries);
        setErr(null);
      })
      .catch((e: unknown) =>
        setErr(
          e instanceof ApiError && e.isOffline
            ? "Offline — the diary needs the backend."
            : e instanceof Error
              ? e.message
              : "Could not load the diary",
        ),
      );
  }, []);

  useEffect(load, [load]);

  // Pull an agent-written summary into the form once, when it arrives. Guarded
  // so a later unrelated run doesn't overwrite text the operator has since
  // edited.
  useEffect(() => {
    if (finalSummary && assisted && !pulled) {
      setSummary(finalSummary.trim());
      setPulled(true);
    }
  }, [finalSummary, assisted, pulled]);

  const askAgent = () => {
    if (running) return;
    const titles = sessions
      .slice(0, 8)
      .map((s) => `- ${s.title || s.summary}`)
      .join("\n");
    setAssisted(true);
    setPulled(false);
    void runPrompt(
      `Write a two-sentence work diary summary for today based on these sessions. ` +
        `Plain prose, first person, no preamble.\n\n${titles || "- (no sessions recorded)"}`,
    );
  };

  const save = async () => {
    if (!summary.trim()) return;
    await api.addDiaryEntry({
      day: today(),
      summary: summary.trim(),
      reflection: reflection.trim(),
      agent_assisted: assisted,
    });
    setSummary("");
    setReflection("");
    setAssisted(false);
    setPulled(false);
    load();
  };

  const totalEntries = entries.length;
  const assistedCount = entries.filter((e) => e.agent_assisted).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="type-tagline text-[16px] text-dim mb-1">
            Agent managed
          </p>
          <h1 className="type-display text-[40px] leading-[0.9]">
            DIARY AGENT
          </h1>
          <p className="type-mono mt-3 text-[10px] tracking-widest text-muted">
            WORK LOG & REFLECTIONS
          </p>
        </div>
        <button
          onClick={load}
          className="btn bg-obsidian border border-hairline shadow-none hover:bg-elevated transition-colors"
          style={{ borderRadius: "var(--radius)" }}
        >
          <span className="type-mono text-[12px] flex items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Refresh
          </span>
        </button>
      </div>

      {/* Metrics Pills */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          className="panel panel-quiet bg-diary p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2">TOTAL ENTRIES</p>
          <p className="type-display text-[32px] text-fg">{totalEntries}</p>
        </div>
        <div
          className="panel panel-quiet bg-info-soft p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2">
            AGENT ASSISTED
          </p>
          <p className="type-display text-[32px] text-fg">{assistedCount}</p>
        </div>
      </div>

      {/* Compose */}
      <div
        className="panel bg-obsidian border-hairline shadow-none p-5"
        style={{ borderRadius: "var(--radius-md)" }}
      >
        <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
          <div className="shrink-0 sm:w-28 sm:mt-0.5">
            <p className="type-mono text-[10px] text-muted flex items-center gap-1.5 mb-2">
              <svg
                viewBox="0 0 24 24"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
              NEW ENTRY
            </p>
            <p className="type-mono text-[10px] text-fg/70 mb-4">
              {prettyDay(today())}
            </p>
            <button
              type="button"
              onClick={askAgent}
              disabled={running}
              className="chip bg-void border-hairline hover:bg-elevated text-fg transition-colors w-full justify-center"
            >
              {running && assisted ? "Drafting…" : "Agent summary"}
            </button>
          </div>
          <div className="flex-1 min-w-0 space-y-3">
          <textarea
            rows={2}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="What did you get done today?"
            className="field resize-none bg-void border-hairline shadow-none"
            aria-label="Summary"
          />
          <textarea
            rows={2}
            value={reflection}
            onChange={(e) => setReflection(e.target.value)}
            placeholder="Anything worth remembering (optional)"
            className="field resize-none bg-void border-hairline shadow-none"
            aria-label="Reflection"
          />
          <div className="flex items-center justify-between pt-2">
            {assisted ? (
              <Chip tone="info" title="Recorded on the entry">
                agent-assisted
              </Chip>
            ) : (
              <div />
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={!summary.trim()}
              className="btn bg-agent-social border-none hover:brightness-95 text-fg shadow-none px-6"
            >
              Save entry
            </button>
          </div>
        </div>
        </div>
      </div>

      {/* Log */}
      <div>
        <p className="type-mono text-[11px] text-muted mb-4 flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <path d="M12 18h.01" />
          </svg>
          PAST ENTRIES
        </p>
        <div
          className="panel bg-obsidian border-hairline p-0 overflow-hidden"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          {err ? (
            <p className="px-5 py-4 text-[12px] text-warn">{err}</p>
          ) : entries.length === 0 ? (
            <div className="p-8">
              <Empty>No entries yet.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="px-5 py-4 hover:bg-elevated transition-colors flex flex-col sm:flex-row gap-4 sm:gap-6"
                >
                  <div className="shrink-0 sm:w-28 sm:mt-0.5">
                    <p className="type-mono text-[10px] text-muted mb-2">
                      {prettyDay(e.day)}
                    </p>
                    {e.agent_assisted && (
                      <span className="type-mono text-[9px] text-info bg-info-soft px-2 py-0.5 rounded-full inline-block">
                        assisted
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
                    {e.summary}
                  </p>
                  {e.reflection && (
                    <div
                      className="mt-3 bg-void border border-hairline px-4 py-3"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-dim">
                        {e.reflection}
                      </p>
                    </div>
                  )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
