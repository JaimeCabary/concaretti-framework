/**
 * Work Diary — Calendar & Notepad interface inspired by Rainbow Diary.
 *
 * Left pane: Interactive monthly calendar with entry dots + past entries list.
 * Right pane: Dedicated Notepad for reading, composing, and editing entries for the selected date.
 * Features AI Agent-assisted drafting from today's work sessions.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { DiaryEntry } from "../types";

const toDateString = (d: Date) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const todayString = () => toDateString(new Date());

const formatDisplayDate = (dateStr: string) => {
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3) return { raw: dateStr, numeric: dateStr, full: dateStr, isToday: dateStr === todayString() };
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const day = String(parts[2]).padStart(2, "0");
  const month = String(parts[1]).padStart(2, "0");
  const year = parts[0];
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const monthName = d.toLocaleDateString("en-US", { month: "long" });
  return {
    raw: dateStr,
    numeric: `${day}/${month}/${year}`,
    full: `${weekday}, ${day} ${monthName} ${year}`,
    isToday: dateStr === todayString(),
  };
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const WEEK_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WorkDiary() {
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);
  const finalSummary = useAgentStore((s) => s.finalSummary);
  const sessions = useAgentStore((s) => s.sessions);

  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(todayString());
  const [activeLeftTab, setActiveLeftTab] = useState<"calendar" | "entries">("calendar");
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  // Calendar navigation state
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth()); // 0 - 11

  // Editor form state
  const [summary, setSummary] = useState("");
  const [reflection, setReflection] = useState("");
  const [assisted, setAssisted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load all diary entries from backend
  const load = useCallback(() => {
    void api
      .diary()
      .then((r) => {
        setEntries(r.entries);
        setErr(null);
      })
      .catch((e: unknown) =>
        setErr(
          e instanceof ApiError && e.isOffline
            ? "Offline — diary needs the backend."
            : e instanceof Error
              ? e.message
              : "Could not load diary entries",
        ),
      );
  }, []);

  useEffect(load, [load]);

  // Pull AI agent-written summary into the editor when ready
  useEffect(() => {
    if (finalSummary && assisted) {
      setSummary(finalSummary.trim());
    }
  }, [finalSummary, assisted]);

  // Map entries by date for instant calendar dot lookup
  const entriesByDate = useMemo(() => {
    const map = new Map<string, DiaryEntry[]>();
    for (const e of entries) {
      const list = map.get(e.day) ?? [];
      list.push(e);
      map.set(e.day, list);
    }
    return map;
  }, [entries]);

  // Calendar calculations
  const calendarDays = useMemo(() => {
    const firstDayIndex = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

    const days: Array<{
      dateStr: string;
      dayNumber: number;
      isCurrentMonth: boolean;
      hasEntries: boolean;
    }> = [];

    // Leading days from previous month
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const dayNum = daysInPrevMonth - i;
      const prevMonth = viewMonth === 0 ? 11 : viewMonth - 1;
      const prevYear = viewMonth === 0 ? viewYear - 1 : viewYear;
      const dStr = toDateString(new Date(prevYear, prevMonth, dayNum));
      days.push({
        dateStr: dStr,
        dayNumber: dayNum,
        isCurrentMonth: false,
        hasEntries: entriesByDate.has(dStr),
      });
    }

    // Days in current month
    for (let d = 1; d <= daysInMonth; d++) {
      const dStr = toDateString(new Date(viewYear, viewMonth, d));
      days.push({
        dateStr: dStr,
        dayNumber: d,
        isCurrentMonth: true,
        hasEntries: entriesByDate.has(dStr),
      });
    }

    // Trailing days from next month to complete 6 weeks (42 days)
    const remaining = 42 - days.length;
    for (let d = 1; d <= remaining; d++) {
      const nextMonth = viewMonth === 11 ? 0 : viewMonth + 1;
      const nextYear = viewMonth === 11 ? viewYear + 1 : viewYear;
      const dStr = toDateString(new Date(nextYear, nextMonth, d));
      days.push({
        dateStr: dStr,
        dayNumber: d,
        isCurrentMonth: false,
        hasEntries: entriesByDate.has(dStr),
      });
    }

    return days;
  }, [viewYear, viewMonth, entriesByDate]);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const jumpToToday = () => {
    const t = new Date();
    setViewYear(t.getFullYear());
    setViewMonth(t.getMonth());
    setSelectedDate(todayString());
  };

  const handleSelectDay = (dateStr: string) => {
    setSelectedDate(dateStr);
    const dayEntries = entriesByDate.get(dateStr) || [];
    if (dayEntries.length > 0) {
      const e = dayEntries[0];
      setEditingEntryId(e.id);
      setSummary(e.summary);
      setReflection(e.reflection || "");
      setAssisted(Boolean(e.agent_assisted));
    } else {
      setEditingEntryId(null);
      setSummary("");
      setReflection("");
      setAssisted(false);
    }
  };

  // Sync selected day's first entry to notebook on load
  useEffect(() => {
    const dayEntries = entriesByDate.get(selectedDate) || [];
    if (dayEntries.length > 0 && !editingEntryId && !summary) {
      const e = dayEntries[0];
      setEditingEntryId(e.id);
      setSummary(e.summary);
      setReflection(e.reflection || "");
      setAssisted(Boolean(e.agent_assisted));
    }
  }, [entriesByDate, selectedDate, editingEntryId, summary]);

  // Ask AI Agent to synthesize a summary from today's sessions
  const askAgent = () => {
    if (running) return;
    const sessionTitles = sessions
      .slice(0, 8)
      .map((s) => `- ${s.title || s.summary}`)
      .join("\n");
    setAssisted(true);
    void runPrompt(
      `Write a two-sentence work diary summary for ${selectedDate} based on these sessions. ` +
        `Plain prose, first person, no preamble.\n\n${sessionTitles || "- (no sessions recorded)"}`,
    );
  };

  // Start a blank page for the current date
  const startNewEntry = () => {
    setSummary("");
    setReflection("");
    setAssisted(false);
    setEditingEntryId(null);
  };

  const startEditEntry = (entry: DiaryEntry) => {
    setSummary(entry.summary);
    setReflection(entry.reflection || "");
    setAssisted(Boolean(entry.agent_assisted));
    setEditingEntryId(entry.id);
  };

  const saveEntry = async () => {
    if (!summary.trim() || saving) return;
    try {
      setSaving(true);
      // If editing existing, delete old and re-add
      if (editingEntryId) {
        await api.deleteDiaryEntry(editingEntryId);
      }
      const res = await api.addDiaryEntry({
        day: selectedDate,
        summary: summary.trim(),
        reflection: reflection.trim(),
        agent_assisted: assisted,
      });
      if (res && res.entry) {
        setEditingEntryId(res.entry.id);
      }
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save diary entry");
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (id: string) => {
    try {
      await api.deleteDiaryEntry(id);
      setEditingEntryId(null);
      setSummary("");
      setReflection("");
      setAssisted(false);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to delete entry");
    }
  };

  const selectedEntries = entriesByDate.get(selectedDate) ?? [];
  const dateInfo = formatDisplayDate(selectedDate);

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden space-y-3">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-2.5 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <span className="type-display text-xl sm:text-[22px]">DIARY & NOTEPAD</span>
            <span className="type-mono text-[10px] bg-diary text-fg px-2 py-0.5 border border-hairline font-bold uppercase">
              {entries.length} ENTRIES
            </span>
          </div>
          <p className="type-mono text-[11px] text-muted mt-0.5">
            Calendar view, past reflections & AI-assisted journaling
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={jumpToToday}
            className="btn bg-obsidian border-hairline hover:bg-elevated text-xs py-1 px-3 font-bold"
          >
            Today
          </button>
        </div>
      </div>

      {err && (
        <div className="p-2.5 bg-danger-soft border border-hairline text-xs text-fg flex items-center justify-between shrink-0">
          <span>{err}</span>
          <button type="button" onClick={() => setErr(null)} className="text-xs font-bold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Main Split Interface */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[330px_1fr] gap-4 min-h-0 overflow-hidden">
        {/* Left Side: Calendar & Past Entries */}
        <div className="flex flex-col space-y-3 min-h-0 h-full overflow-hidden">
          {/* Left Sub-tabs */}
          <div className="flex border border-hairline bg-obsidian p-1 gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setActiveLeftTab("calendar")}
              className={`flex-1 py-1 text-center text-xs font-bold uppercase tracking-wider transition-colors ${
                activeLeftTab === "calendar"
                  ? "bg-[#68D391] text-black border border-black shadow-[2px_2px_0px_#000]"
                  : "text-dim hover:text-fg hover:bg-elevated"
              }`}
            >
              Calendar
            </button>
            <button
              type="button"
              onClick={() => setActiveLeftTab("entries")}
              className={`flex-1 py-1 text-center text-xs font-bold uppercase tracking-wider transition-colors ${
                activeLeftTab === "entries"
                  ? "bg-[#68D391] text-black border border-black shadow-[2px_2px_0px_#000]"
                  : "text-dim hover:text-fg hover:bg-elevated"
              }`}
            >
              All Entries ({entries.length})
            </button>
          </div>

          {activeLeftTab === "calendar" ? (
            <div className="panel bg-obsidian border-2 border-fg p-3 flex flex-col space-y-1.5 shrink-0">
              {/* Month & Year Navigation */}
              <div className="flex items-center justify-between pb-1 border-b border-hairline shrink-0">
                <button
                  type="button"
                  onClick={prevMonth}
                  className="p-1 hover:bg-elevated transition-colors border border-transparent hover:border-hairline"
                  aria-label="Previous Month"
                >
                  ◀
                </button>
                <span className="type-display text-sm tracking-wide font-bold">
                  {MONTH_NAMES[viewMonth]} {viewYear}
                </span>
                <button
                  type="button"
                  onClick={nextMonth}
                  className="p-1 hover:bg-elevated transition-colors border border-transparent hover:border-hairline"
                  aria-label="Next Month"
                >
                  ▶
                </button>
              </div>

              {/* Day Names Row */}
              <div className="grid grid-cols-7 text-center font-mono text-[9px] text-muted uppercase font-bold py-0.5 shrink-0">
                {WEEK_DAYS.map((d) => (
                  <div key={d}>{d}</div>
                ))}
              </div>

              {/* Calendar Grid */}
              <div className="grid grid-cols-7 gap-1">
                {calendarDays.map((cd, idx) => {
                  const isSelected = cd.dateStr === selectedDate;
                  const isToday = cd.dateStr === todayString();

                  return (
                    <button
                      key={`${cd.dateStr}-${idx}`}
                      type="button"
                      onClick={() => handleSelectDay(cd.dateStr)}
                      className={`relative h-7 sm:h-8 flex flex-col items-center justify-center font-mono text-xs transition-all ${
                        isSelected
                          ? "bg-[#68D391] text-black font-extrabold border-2 border-black shadow-[2px_2px_0px_#000] z-10"
                          : isToday
                            ? "bg-elevated font-bold text-fg border border-hairline"
                            : cd.isCurrentMonth
                              ? "text-fg hover:bg-elevated"
                              : "text-muted/40 hover:bg-elevated"
                      }`}
                    >
                      <span className="text-[11px]">{cd.dayNumber}</span>
                      {cd.hasEntries && (
                        <span
                          className={`absolute bottom-0.5 size-1.5 rounded-full ${
                            isSelected ? "bg-black" : "bg-[#FF3366]"
                          }`}
                          title="Has diary entry"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Entries Feed for Selected Date or All */}
          <div className="flex-1 min-h-0 panel bg-obsidian border-2 border-fg p-3 overflow-y-auto flex flex-col space-y-2">
            <div className="flex items-center justify-between border-b border-hairline pb-1.5 mb-1 shrink-0">
              <span className="type-mono text-[10px] text-muted uppercase tracking-wider font-bold">
                {activeLeftTab === "calendar" ? `Entries on ${selectedDate}` : "Recent Entries"}
              </span>
            </div>

            {selectedEntries.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
                <p className="type-mono text-xs text-muted">
                  No entries recorded for this date
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {selectedEntries.map((e) => {
                  const isCurrent = editingEntryId === e.id;
                  return (
                    <div
                      key={e.id}
                      onClick={() => startEditEntry(e)}
                      className={`p-2.5 bg-void border ${
                        isCurrent ? "border-2 border-fg bg-elevated/80 shadow-2xs" : "border-hairline hover:border-fg"
                      } cursor-pointer transition-colors space-y-1 text-left rounded`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="type-mono text-[10px] text-muted">
                          {e.day}
                        </span>
                        {e.agent_assisted ? (
                          <span className="type-mono text-[8px] bg-info-soft text-info px-1 py-0.2 uppercase font-bold rounded">
                            AI
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs font-bold text-fg truncate">
                        {e.summary}
                      </p>
                      {e.reflection && (
                        <p className="text-[11px] text-dim line-clamp-2">
                          {e.reflection}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Authentic Lined Notebook Paper with Margins & Cursive Writing Area */}
        <div className="notebook-sheet rounded-2xl border-2 border-fg/20 p-0 flex flex-col min-h-0 h-full overflow-hidden shadow-sm relative">
          {/* 3-Hole Punch Binder Cutouts along far left margin */}
          <div className="absolute left-3.5 top-12 size-3.5 rounded-full bg-[#E8E3D7] border border-[#1A1A1A]/20 shadow-inner z-10 pointer-events-none" />
          <div className="absolute left-3.5 top-1/2 -translate-y-1/2 size-3.5 rounded-full bg-[#E8E3D7] border border-[#1A1A1A]/20 shadow-inner z-10 pointer-events-none" />
          <div className="absolute left-3.5 bottom-12 size-3.5 rounded-full bg-[#E8E3D7] border border-[#1A1A1A]/20 shadow-inner z-10 pointer-events-none" />

          {/* Notebook Header Bar */}
          <div className="pl-[70px] pr-5 pt-3.5 pb-2 border-b border-rose-200/50 flex flex-wrap items-center justify-between gap-2 shrink-0 bg-transparent">
            <div>
              <h2 className="font-cursive text-2xl sm:text-3xl text-fg font-bold tracking-wide select-none leading-none">
                {dateInfo.full}
              </h2>
              <div className="flex items-center gap-2 mt-1">
                <span className="type-mono text-[9.5px] uppercase tracking-widest text-muted font-bold">
                  {editingEntryId ? "Recorded Entry" : "New Entry"}
                </span>
                {assisted && (
                  <span className="type-mono text-[9px] bg-info-soft text-info px-1.5 py-0.5 rounded font-bold">
                    AI-Assisted
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={askAgent}
                disabled={running}
                className="type-mono text-[11px] font-bold px-3 py-1.5 bg-obsidian border border-hairline hover:border-fg text-fg rounded transition-colors shadow-2xs cursor-pointer flex items-center gap-1.5"
                title="Draft diary summary from today's work sessions"
              >
                {running && assisted ? "Council drafting..." : "Draft with Council AI"}
              </button>

              {editingEntryId && (
                <>
                  <button
                    type="button"
                    onClick={startNewEntry}
                    className="type-mono text-[11px] font-bold px-2.5 py-1.5 bg-obsidian border border-hairline hover:border-fg text-fg rounded transition-colors shadow-2xs cursor-pointer"
                    title="Write a new entry for this day"
                  >
                    + New Note
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteEntry(editingEntryId)}
                    className="type-mono text-[11px] font-bold px-2.5 py-1.5 bg-obsidian border border-hairline hover:border-danger hover:text-danger text-muted rounded transition-colors shadow-2xs cursor-pointer"
                    title="Delete this entry"
                  >
                    Delete
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={saveEntry}
                disabled={!summary.trim() || saving}
                className="btn btn-primary text-xs py-1.5 px-4 font-bold uppercase rounded shadow-2xs cursor-pointer"
              >
                {saving ? "Saving..." : editingEntryId ? "Update Note" : "Save Note"}
              </button>
            </div>
          </div>

          {/* Lined Notebook Writing Body with Cursive Handwriting */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden pl-[70px] pr-6 pt-2 pb-4">
            {/* Title / Day Highlight Input */}
            <div className="shrink-0 mb-1">
              <input
                type="text"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder={summary || reflection ? "" : "Day highlight or title..."}
                className="w-full font-cursive text-2xl sm:text-3xl font-bold text-fg bg-transparent outline-none placeholder:text-muted/40 focus:placeholder-transparent leading-[34px]"
                style={{ lineHeight: "34px" }}
              />
            </div>

            {/* Ruled Body Lines Textarea */}
            <div className="flex-1 min-h-0 flex flex-col pt-1">
              <textarea
                value={reflection}
                onChange={(e) => setReflection(e.target.value)}
                placeholder={summary || reflection ? "" : "Dear Diary, write your thoughts, progress, or reflections for today..."}
                className="w-full flex-1 font-cursive text-xl sm:text-2xl text-fg bg-transparent outline-none resize-none placeholder:text-muted/40 focus:placeholder-transparent leading-[34px]"
                style={{ lineHeight: "34px" }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
