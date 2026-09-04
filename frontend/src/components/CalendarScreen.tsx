/**
 * Calendar & Timetable — Blueprint Style
 *
 * Single month view takes up the full space with a generous 42-cell grid
 * and a dedicated Day Schedule & Quick-Add Agenda pane on the right (matching
 * the WorkDiary blueprint aesthetic).
 *
 * When "Expand Full Year" is toggled, it displays a 12-month overview where each
 * month is pressed to compact normal size, allowing instant visual scanning of the year
 * and 1-click zooming back into any month.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { CalendarEvent } from "../types";
import { clockTime } from "./ui";

const toDateString = (d: Date) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const todayString = () => toDateString(new Date());

const formatDisplayDate = (dateStr: string) => {
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3) {
    return { raw: dateStr, numeric: dateStr, full: dateStr, isToday: dateStr === todayString() };
  }
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const day = String(parts[2]).padStart(2, "0");
  const month = String(parts[1]).padStart(2, "0");
  const year = parts[0];
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const monthName = d.toLocaleDateString("en-US", { month: "long" });
  return {
    raw: dateStr,
    numeric: `${day} / ${month} / ${year}`,
    full: `${weekday}, ${day} ${monthName} ${year}`,
    isToday: dateStr === todayString(),
  };
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEK_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_DAYS_SHORT = ["S", "M", "T", "W", "T", "F", "S"];

const KIND_META: Record<string, { label: string; dot: string; bg: string; text: string }> = {
  exam: { label: "Exam", dot: "#FF3366", bg: "rgba(255, 51, 102, 0.15)", text: "#FF3366" },
  deadline: { label: "Deadline", dot: "#ECC94B", bg: "rgba(236, 201, 75, 0.15)", text: "#ECC94B" },
  revision: { label: "Revision", dot: "#9F7AEA", bg: "rgba(159, 122, 234, 0.15)", text: "#9F7AEA" },
  event: { label: "Event", dot: "#4FD1C5", bg: "rgba(79, 209, 197, 0.15)", text: "#4FD1C5" },
};

export function CalendarScreen() {
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);
  const finalSummary = useAgentStore((s) => s.finalSummary);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(todayString());
  const [err, setErr] = useState<string | null>(null);
  const [nl, setNl] = useState("");

  // Navigation state
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth()); // 0 - 11
  const [expandedYear, setExpandedYear] = useState(false);

  // Quick event form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newKind, setNewKind] = useState<"event" | "exam" | "deadline" | "revision">("event");
  const [newStartTime, setNewStartTime] = useState("09:00");
  const [newEndTime, setNewEndTime] = useState("10:00");
  const [newDesc, setNewDesc] = useState("");
  const [savingEvent, setSavingEvent] = useState(false);

  // Load events
  const load = useCallback(() => {
    void api
      .events({ days: 400 })
      .then((r) => {
        setEvents(r.events);
        setErr(null);
      })
      .catch((e: unknown) =>
        setErr(
          e instanceof ApiError && e.isOffline
            ? "Offline — showing what was cached."
            : e instanceof Error
              ? e.message
              : "Could not load events",
        ),
      );
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (finalSummary) load();
  }, [finalSummary, load]);

  // Group events by YYYY-MM-DD
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const d = new Date(e.start_ts * 1000);
      const k = toDateString(d);
      const list = map.get(k) ?? [];
      list.push(e);
      map.set(k, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.start_ts - b.start_ts);
    }
    return map;
  }, [events]);

  // Compute 42 calendar cells for any given month & year
  const getCalendarDays = useCallback(
    (year: number, month: number) => {
      const firstDayIndex = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const daysInPrevMonth = new Date(year, month, 0).getDate();

      const days: Array<{
        dateStr: string;
        dayNumber: number;
        isCurrentMonth: boolean;
        items: CalendarEvent[];
      }> = [];

      // Leading days from previous month
      for (let i = firstDayIndex - 1; i >= 0; i--) {
        const dayNum = daysInPrevMonth - i;
        const prevMonth = month === 0 ? 11 : month - 1;
        const prevYear = month === 0 ? year - 1 : year;
        const dStr = toDateString(new Date(prevYear, prevMonth, dayNum));
        days.push({
          dateStr: dStr,
          dayNumber: dayNum,
          isCurrentMonth: false,
          items: eventsByDate.get(dStr) ?? [],
        });
      }

      // Days in current month
      for (let d = 1; d <= daysInMonth; d++) {
        const dStr = toDateString(new Date(year, month, d));
        days.push({
          dateStr: dStr,
          dayNumber: d,
          isCurrentMonth: true,
          items: eventsByDate.get(dStr) ?? [],
        });
      }

      // Trailing days from next month to complete 42 days (6 weeks)
      const remaining = 42 - days.length;
      for (let d = 1; d <= remaining; d++) {
        const nextMonth = month === 11 ? 0 : month + 1;
        const nextYear = month === 11 ? year + 1 : year;
        const dStr = toDateString(new Date(nextYear, nextMonth, d));
        days.push({
          dateStr: dStr,
          dayNumber: d,
          isCurrentMonth: false,
          items: eventsByDate.get(dStr) ?? [],
        });
      }

      return days;
    },
    [eventsByDate],
  );

  const currentMonthDays = useMemo(
    () => getCalendarDays(viewYear, viewMonth),
    [getCalendarDays, viewYear, viewMonth],
  );

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
    const parts = dateStr.split("-").map(Number);
    if (parts.length === 3) {
      setViewYear(parts[0]);
      setViewMonth(parts[1] - 1);
    }
    if (expandedYear) {
      setExpandedYear(false);
    }
  };

  const submitNl = () => {
    const text = nl.trim();
    if (!text || running) return;
    void runPrompt(text);
    setNl("");
  };

  const removeEvent = (id: string) => {
    void api.deleteEvent(id).then(load);
  };

  const handleCreateEvent = async () => {
    if (!newTitle.trim() || savingEvent) return;
    try {
      setSavingEvent(true);
      const [sh, sm] = newStartTime.split(":").map(Number);
      const [eh, em] = newEndTime.split(":").map(Number);

      const parts = selectedDate.split("-").map(Number);
      const startDate = new Date(parts[0], parts[1] - 1, parts[2], sh || 9, sm || 0);
      const endDate = new Date(parts[0], parts[1] - 1, parts[2], eh || 10, em || 0);

      const startTs = Math.floor(startDate.getTime() / 1000);
      const endTs = Math.max(startTs + 1800, Math.floor(endDate.getTime() / 1000));

      await api.createEvent({
        title: newTitle.trim(),
        start: startTs,
        end: endTs,
        kind: newKind,
        description: newDesc.trim(),
      });

      setNewTitle("");
      setNewDesc("");
      setShowAddForm(false);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create event");
    } finally {
      setSavingEvent(false);
    }
  };

  const selectedEvents = eventsByDate.get(selectedDate) ?? [];
  const dateInfo = formatDisplayDate(selectedDate);

  return (
    <div className={`h-full flex flex-col min-h-0 ${expandedYear ? "overflow-y-auto space-y-4 pr-1" : "overflow-hidden space-y-3"}`}>
      {/* Top Header — Blueprint Aesthetic */}
      <div className="panel bg-obsidian border-2 border-fg p-3 shadow-[3px_3px_0px_#000] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <span className="type-display text-xl sm:text-[22px]">CALENDAR & TIMETABLE</span>
            <span className="type-mono text-[10px] bg-[#68D391] text-black px-2 py-0.5 border-2 border-black font-extrabold uppercase shadow-[2px_2px_0px_#000]">
              {events.length} EVENTS
            </span>
          </div>
          <p className="type-mono text-[11px] text-muted mt-0.5">
            Blueprint schedule, agenda & AI calendar agent
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={jumpToToday}
            className="btn bg-obsidian border-2 border-black shadow-[2px_2px_0px_#000] hover:bg-elevated text-xs py-1 px-3 font-bold uppercase"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setExpandedYear(!expandedYear)}
            className="btn bg-[#2D3748] text-white hover:bg-black border-2 border-black shadow-[2px_2px_0px_#000] text-xs py-1 px-3.5 font-bold uppercase tracking-wider"
          >
            {expandedYear ? "Focus Month View" : "Expand Full Year"}
          </button>
        </div>
      </div>

      {/* Ask the Calendar Agent Command Bar — Blueprint Console */}
      <div className="panel bg-obsidian border-2 border-fg p-2.5 shadow-[2px_2px_0px_#000] flex items-center gap-3 shrink-0">
        <span className="type-mono text-sm font-bold text-[#68D391] px-1">&gt;_</span>
        <input
          value={nl}
          onChange={(e) => setNl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitNl()}
          placeholder="Ask the calendar agent — e.g. 'Schedule team sync next Tuesday at 2pm' or 'What exams are coming up?'"
          className="min-w-0 flex-1 bg-transparent py-1 text-xs text-fg placeholder:text-muted focus:outline-none font-mono"
          aria-label="Ask the calendar agent"
        />
        <button
          type="button"
          onClick={submitNl}
          disabled={running || !nl.trim()}
          className="btn bg-[#68D391] text-black border-2 border-black shadow-[2px_2px_0px_#000] text-xs px-3.5 py-1 font-extrabold uppercase hover:brightness-95 disabled:opacity-50 shrink-0"
        >
          {running ? "Processing..." : "Ask Agent"}
        </button>
      </div>

      {err && (
        <div className="p-2.5 bg-danger-soft border-2 border-fg text-xs text-fg flex items-center justify-between shadow-[2px_2px_0px_#000] shrink-0">
          <span>{err}</span>
          <button type="button" onClick={() => setErr(null)} className="text-xs font-bold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Main View: Single Month (Fits 100% on screen) vs 12-Month Overview (Scrolls) */}
      {!expandedYear ? (
        /* SINGLE MONTH VIEW — Takes up the full space with Blueprint Month Grid + Agenda Split */
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 min-h-0 overflow-hidden">
          {/* Left: Large Interactive Month Calendar */}
          <div className="panel bg-obsidian border-2 border-fg p-3.5 shadow-[4px_4px_0px_#000] flex flex-col space-y-2 min-h-0 h-full overflow-hidden">
            {/* Month & Year Navigation Header */}
            <div className="flex items-center justify-between pb-2 border-b-2 border-hairline shrink-0">
              <button
                type="button"
                onClick={prevMonth}
                className="btn bg-void border-2 border-black shadow-[2px_2px_0px_#000] p-1 px-2.5 text-xs hover:bg-elevated font-bold"
                aria-label="Previous Month"
              >
                ◀
              </button>
              <div className="text-center">
                <span className="type-display text-base tracking-wide font-extrabold text-fg uppercase">
                  {MONTH_NAMES[viewMonth]} {viewYear}
                </span>
              </div>
              <button
                type="button"
                onClick={nextMonth}
                className="btn bg-void border-2 border-black shadow-[2px_2px_0px_#000] p-1 px-2.5 text-xs hover:bg-elevated font-bold"
                aria-label="Next Month"
              >
                ▶
              </button>
            </div>

            {/* Weekday Names Header */}
            <div className="grid grid-cols-7 text-center font-mono text-[10px] text-muted uppercase font-bold py-0.5 border-b border-hairline shrink-0">
              {WEEK_DAYS.map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>

            {/* Large Blueprint 42-Cell Calendar Grid — 6 rows evenly fitting container */}
            <div className="grid grid-cols-7 grid-rows-6 gap-1 flex-1 min-h-0 h-full overflow-hidden">
              {currentMonthDays.map((cd, idx) => {
                const isSelected = cd.dateStr === selectedDate;
                const isToday = cd.dateStr === todayString();

                return (
                  <button
                    key={`${cd.dateStr}-${idx}`}
                    type="button"
                    onClick={() => handleSelectDay(cd.dateStr)}
                    className={`relative p-1 flex flex-col items-start justify-start font-mono text-xs transition-all border text-left overflow-hidden h-full ${
                      isSelected
                        ? "bg-[#68D391] text-black font-extrabold border-2 border-black shadow-[2px_2px_0px_#000] z-10"
                        : isToday
                          ? "bg-elevated font-bold text-fg border-2 border-fg"
                          : cd.isCurrentMonth
                            ? "bg-void text-fg border-hairline hover:border-fg hover:bg-elevated"
                            : "bg-void/40 text-muted/40 border-hairline/40 hover:bg-elevated"
                    }`}
                  >
                    <div className="w-full flex items-center justify-between">
                      <span className={`text-[11px] font-bold leading-none ${isSelected ? "text-black" : ""}`}>
                        {cd.dayNumber}
                      </span>
                      {cd.items.length > 0 && !isSelected && (
                        <span className="size-1.5 rounded-full bg-[#FF3366]" />
                      )}
                    </div>

                    {/* Event Chips within Day Cell */}
                    <div className="w-full mt-0.5 space-y-0.5 overflow-hidden">
                      {cd.items.slice(0, 2).map((item) => {
                        const meta = KIND_META[item.kind] ?? KIND_META.event;
                        return (
                          <div
                            key={item.id}
                            className={`w-full truncate text-[9px] px-1 py-0.2 rounded-none font-mono flex items-center gap-1 leading-tight ${
                              isSelected
                                ? "bg-black text-white font-bold"
                                : "bg-obsidian border border-hairline text-fg"
                            }`}
                            title={`${item.title} (${clockTime(item.start_ts)})`}
                          >
                            <span
                              className="size-1 rounded-full shrink-0"
                              style={{ background: isSelected ? "#68D391" : meta.dot }}
                            />
                            <span className="truncate">{item.title}</span>
                          </div>
                        );
                      })}
                      {cd.items.length > 2 && (
                        <div
                          className={`text-[8px] font-bold px-0.5 leading-none ${
                            isSelected ? "text-black" : "text-muted"
                          }`}
                        >
                          +{cd.items.length - 2} more
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right: Selected Date Schedule, Agenda & Quick Add */}
          <div className="panel bg-obsidian border-2 border-fg p-4 shadow-[4px_4px_0px_#000] flex flex-col min-h-0 h-full overflow-hidden">
            {/* Date Header */}
            <div className="border-b-2 border-hairline pb-3 shrink-0">
              <div className="flex items-center justify-between">
                <p className="type-mono text-xs text-muted tracking-widest uppercase font-bold">
                  {dateInfo.isToday ? "TODAY" : "SELECTED DATE"}
                </p>
                <button
                  type="button"
                  onClick={() => setShowAddForm(!showAddForm)}
                  className="type-mono text-xs font-bold text-fg hover:underline uppercase"
                >
                  {showAddForm ? "✕ Close Form" : "+ Add Event"}
                </button>
              </div>

              <h2 className="type-display text-[28px] sm:text-[34px] leading-tight text-fg font-extrabold mt-1">
                {dateInfo.numeric}
              </h2>
              <p className="text-xs text-dim font-medium mt-0.5">
                {dateInfo.full}
              </p>
            </div>

            {/* Quick Add Event Form */}
            {showAddForm && (
              <div className="p-4 bg-void border-2 border-fg space-y-3 shadow-[2px_2px_0px_#000] animate-slide-in">
                <span className="type-mono text-[11px] font-bold uppercase text-fg block border-b border-hairline pb-1">
                  New Event / Schedule
                </span>

                <div>
                  <label className="type-mono block text-[10px] font-bold text-muted uppercase mb-1" htmlFor="cal-title">
                    Event Title
                  </label>
                  <input
                    id="cal-title"
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. Physics Revision, Math Exam, Team Sync"
                    className="w-full bg-obsidian border-2 border-hairline focus:border-fg p-2 text-xs font-medium outline-none text-fg"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="type-mono block text-[10px] font-bold text-muted uppercase mb-1" htmlFor="cal-start">
                      Start Time
                    </label>
                    <input
                      id="cal-start"
                      type="time"
                      value={newStartTime}
                      onChange={(e) => setNewStartTime(e.target.value)}
                      className="w-full bg-obsidian border-2 border-hairline p-1.5 text-xs text-fg font-mono outline-none"
                    />
                  </div>
                  <div>
                    <label className="type-mono block text-[10px] font-bold text-muted uppercase mb-1" htmlFor="cal-end">
                      End Time
                    </label>
                    <input
                      id="cal-end"
                      type="time"
                      value={newEndTime}
                      onChange={(e) => setNewEndTime(e.target.value)}
                      className="w-full bg-obsidian border-2 border-hairline p-1.5 text-xs text-fg font-mono outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="type-mono block text-[10px] font-bold text-muted uppercase mb-1" htmlFor="cal-kind">
                    Type
                  </label>
                  <select
                    id="cal-kind"
                    value={newKind}
                    onChange={(e) => setNewKind(e.target.value as any)}
                    className="w-full bg-obsidian border-2 border-hairline p-2 text-xs text-fg font-mono outline-none"
                  >
                    <option value="event">Event / Meeting</option>
                    <option value="revision">Revision Block</option>
                    <option value="deadline">Deadline</option>
                    <option value="exam">Exam</option>
                  </select>
                </div>

                <div>
                  <label className="type-mono block text-[10px] font-bold text-muted uppercase mb-1" htmlFor="cal-desc">
                    Description (optional)
                  </label>
                  <input
                    id="cal-desc"
                    type="text"
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    placeholder="Notes or location..."
                    className="w-full bg-obsidian border-2 border-hairline focus:border-fg p-2 text-xs font-medium outline-none text-fg"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="btn bg-obsidian border border-hairline px-3 py-1.5 text-xs uppercase"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateEvent}
                    disabled={!newTitle.trim() || savingEvent}
                    className="btn bg-[#68D391] text-black border-2 border-black shadow-[2px_2px_0px_#000] px-4 py-1.5 text-xs font-extrabold uppercase hover:brightness-95"
                  >
                    {savingEvent ? "Saving..." : "Save Event"}
                  </button>
                </div>
              </div>
            )}

            {/* Events on this Day */}
            <div className="flex-1 min-h-0 space-y-2.5 overflow-y-auto pr-1">
              <div className="flex items-center justify-between border-b border-hairline pb-1 mb-2">
                <span className="type-mono text-[10px] font-bold uppercase text-muted tracking-wider">
                  Day Schedule ({selectedEvents.length})
                </span>
              </div>

              {selectedEvents.length === 0 ? (
                <div className="p-8 text-center border-2 border-dashed border-hairline">
                  <p className="type-display text-base text-fg mb-1">
                    No events scheduled
                  </p>
                  <p className="type-mono text-xs text-muted max-w-xs mx-auto mb-4">
                    This day is currently open. Ask the agent or click below to schedule revision or events.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAddForm(true)}
                    className="btn bg-[#2D3748] text-white hover:bg-black text-xs px-5 py-2 border-2 border-black shadow-[3px_3px_0px_#000] font-bold uppercase tracking-wider"
                  >
                    + Add Event
                  </button>
                </div>
              ) : (
                selectedEvents.map((e) => {
                  const meta = KIND_META[e.kind] ?? KIND_META.event;
                  return (
                    <div
                      key={e.id}
                      className="p-3 bg-void border-2 border-fg shadow-[3px_3px_0px_#000] space-y-1.5 group"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="type-mono text-[9px] font-extrabold uppercase px-1.5 py-0.5 border border-black"
                          style={{ background: meta.dot, color: "#000" }}
                        >
                          {meta.label}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="type-mono text-[11px] font-bold text-fg">
                            {clockTime(e.start_ts)} – {clockTime(e.end_ts)}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeEvent(e.id)}
                            className="text-xs text-muted hover:text-danger font-bold ml-1"
                            title="Delete event"
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      <h4 className="text-xs font-bold text-fg leading-snug">
                        {e.title}
                      </h4>

                      {e.description && (
                        <p className="text-[11px] text-dim leading-normal font-sans">
                          {e.description}
                        </p>
                      )}

                      {e.source && e.source !== "local" && (
                        <div className="pt-1">
                          <span className="type-mono text-[9px] text-muted uppercase">
                            Source: {e.source}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : (
        /* 12-MONTH OVERVIEW — Pressed to compact normal size for all 12 months */
        <div className="flex-1 flex flex-col space-y-4 min-h-0">
          <div className="flex items-center justify-between border-b-2 border-hairline pb-2">
            <div>
              <span className="type-display text-xl font-extrabold text-fg uppercase">
                {viewYear} FULL YEAR AT A GLANCE
              </span>
              <p className="type-mono text-xs text-muted">
                Click any month or date to zoom into full size
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setViewYear(viewYear - 1)}
                className="btn bg-void border-2 border-black shadow-[2px_2px_0px_#000] px-3 py-1 text-xs font-bold"
              >
                ◀ {viewYear - 1}
              </button>
              <button
                type="button"
                onClick={() => setViewYear(viewYear + 1)}
                className="btn bg-void border-2 border-black shadow-[2px_2px_0px_#000] px-3 py-1 text-xs font-bold"
              >
                {viewYear + 1} ▶
              </button>
              <button
                type="button"
                onClick={() => setExpandedYear(false)}
                className="btn bg-[#68D391] text-black border-2 border-black shadow-[2px_2px_0px_#000] px-4 py-1 text-xs font-extrabold uppercase ml-2"
              >
                Return to Month View
              </button>
            </div>
          </div>

          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 overflow-y-auto">
            {MONTH_NAMES.map((mName, mIdx) => {
              const mDays = getCalendarDays(viewYear, mIdx);
              const isCurrentViewMonth = mIdx === viewMonth;

              return (
                <div
                  key={mName}
                  className={`panel bg-obsidian border-2 p-3 shadow-[3px_3px_0px_#000] flex flex-col space-y-2 transition-colors ${
                    isCurrentViewMonth ? "border-[#68D391]" : "border-fg"
                  }`}
                >
                  {/* Month Card Header */}
                  <div
                    className="flex items-center justify-between pb-1.5 border-b border-hairline cursor-pointer"
                    onClick={() => {
                      setViewMonth(mIdx);
                      setExpandedYear(false);
                    }}
                    title="Click to zoom in to this month"
                  >
                    <span className="type-display text-sm font-bold uppercase text-fg hover:underline">
                      {mName}
                    </span>
                    <span className="type-mono text-[10px] text-muted">
                      {mDays.reduce((acc, d) => (d.isCurrentMonth ? acc + d.items.length : acc), 0)} events
                    </span>
                  </div>

                  {/* Days of Week initials */}
                  <div className="grid grid-cols-7 text-center font-mono text-[9px] text-muted uppercase font-bold">
                    {WEEK_DAYS_SHORT.map((d, i) => (
                      <div key={i}>{d}</div>
                    ))}
                  </div>

                  {/* Compact 42-day cells — pressed to normal size */}
                  <div className="grid grid-cols-7 gap-1 text-center">
                    {mDays.map((cd, dIdx) => {
                      const isToday = cd.dateStr === todayString();
                      const isSelected = cd.dateStr === selectedDate;

                      return (
                        <button
                          key={`${cd.dateStr}-${dIdx}`}
                          type="button"
                          onClick={() => handleSelectDay(cd.dateStr)}
                          className={`relative h-6 flex flex-col items-center justify-center font-mono text-[10px] transition-all ${
                            isSelected
                              ? "bg-[#68D391] text-black font-extrabold border border-black"
                              : isToday
                                ? "bg-elevated font-bold text-fg border border-fg"
                                : cd.isCurrentMonth
                                  ? "text-fg hover:bg-elevated"
                                  : "text-muted/30 hover:bg-elevated"
                          }`}
                        >
                          <span>{cd.dayNumber}</span>
                          {cd.items.length > 0 && (
                            <span
                              className={`absolute bottom-0.5 size-1 rounded-full ${
                                isSelected ? "bg-black" : "bg-[#FF3366]"
                              }`}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
