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

// 6 light pastel week-row tints — airy, fresh, clean, and distinct
const WEEK_ROW_TINTS = [
  "#F0F4FF",   // row 0 — soft pastel sky / lavender blue
  "#FFF1F2",   // row 1 — soft pastel rose / blush
  "#FEFCE8",   // row 2 — soft pastel butter / lemon chiffon
  "#F0FDF4",   // row 3 — soft pastel mint / sage
  "#FAF5FF",   // row 4 — soft pastel lilac / violet
  "#FFF7ED",   // row 5 — soft pastel peach / apricot
];

const KIND_META: Record<string, { label: string; dot: string; bg: string; text: string }> = {
  exam:     { label: "Exam",     dot: "#e53e3e", bg: "#FEE2E2", text: "#991B1B" },
  deadline: { label: "Deadline", dot: "#d69e2e", bg: "#FEF9C3", text: "#92400E" },
  revision: { label: "Revision", dot: "#7c3aed", bg: "#EDE9FE", text: "#4C1D95" },
  event:    { label: "Event",    dot: "#0891b2", bg: "#CFFAFE", text: "#164E63" },
};

export function CalendarScreen() {
  const subtasks = useAgentStore((s) => s.subtasks);
  const storeEvents = useAgentStore((s) => s.calendarEvents);
  const calendarLoading = useAgentStore((s) => s.calendarLoading);
  const refreshCalendar = useAgentStore((s) => s.refreshCalendar);
  const finalSummary = useAgentStore((s) => s.finalSummary);

  const [localEvents, setLocalEvents] = useState<CalendarEvent[]>([]);
  const events = localEvents.length > 0 ? localEvents : storeEvents;
  const [selectedDate, setSelectedDate] = useState<string>(todayString());
  const [err, setErr] = useState<string | null>(null);

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
        setLocalEvents(r.events);
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

  useEffect(() => {
    if (storeEvents.length === 0 && !calendarLoading) {
      void refreshCalendar();
    }
  }, [storeEvents.length, calendarLoading, refreshCalendar]);

  useEffect(load, [load]);

  useEffect(() => {
    if (finalSummary) load();
  }, [finalSummary, load]);

  useEffect(() => {
    const calendarDone = subtasks.some(
      (s) => s.agent === "calendar" && s.status === "done",
    );
    if (calendarDone) load();
  }, [subtasks, load]);

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

  const handleSelectDay = (dateStr: string, openForm = true) => {
    setSelectedDate(dateStr);
    const parts = dateStr.split("-").map(Number);
    if (parts.length === 3) {
      setViewYear(parts[0]);
      setViewMonth(parts[1] - 1);
    }
    if (expandedYear) {
      setExpandedYear(false);
    }
    if (openForm) {
      setShowAddForm(true);
      setTimeout(() => {
        const input = document.getElementById("cal-title");
        if (input) {
          input.focus();
          (input as HTMLInputElement).select?.();
        }
      }, 50);
    }
  };


  const removeEvent = (id: string) => {
    setLocalEvents((prev) => prev.filter((e) => e.id !== id));
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

      const res = await api.createEvent({
        title: newTitle.trim(),
        start: startTs,
        end: endTs,
        kind: newKind,
        description: newDesc.trim(),
      });

      // Optimistic update so event chip appears on the clicked box immediately
      const createdItem: CalendarEvent = res?.event || {
        id: `ev-${Date.now()}`,
        title: newTitle.trim(),
        start_ts: startTs,
        end_ts: endTs,
        kind: newKind,
        description: newDesc.trim(),
        source: "local",
      };
      setLocalEvents((prev) => [...prev, createdItem]);

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
      {/* Top Header */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3 bg-void">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="type-display text-xl sm:text-[22px]">CALENDAR & TIMETABLE</h1>
            <span className="type-mono text-[10px] bg-agent-chain/20 text-fg px-2 py-0.5 border border-hairline font-semibold rounded uppercase">
              {events.length} Events
            </span>
          </div>
          <p className="type-mono text-[11px] text-muted mt-0.5">
            Schedule, agenda & AI calendar agent
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={jumpToToday}
            className="btn text-xs py-1.5 px-3 font-semibold rounded-lg border-hairline bg-void hover:bg-obsidian/40"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setExpandedYear(!expandedYear)}
            className="btn text-xs py-1.5 px-3.5 font-semibold rounded-lg border-hairline bg-obsidian/40 hover:bg-obsidian/70"
          >
            {expandedYear ? "Month View" : "Full Year"}
          </button>
        </div>
      </div>


      {err && (
        <div className="p-2.5 bg-danger-soft border-b border-danger/30 text-xs text-fg flex items-center justify-between shrink-0">
          <span>{err}</span>
          <button type="button" onClick={() => setErr(null)} className="text-xs font-bold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Main View: Single Month (Fits 100% on screen) vs 12-Month Overview (Scrolls) */}
      {!expandedYear ? (
        /* SINGLE MONTH VIEW — Takes up the full space with Blueprint Month Grid + Agenda Split */
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3 min-h-0 overflow-hidden px-3 pb-3">
          {/* Left: Large Interactive Month Calendar */}
          <div className="panel bg-void border border-hairline rounded-xl p-3.5 flex flex-col space-y-2 min-h-0 h-full overflow-hidden">
            {/* Month & Year Navigation Header */}
            <div className="flex items-center justify-between pb-2 border-b border-hairline shrink-0">
              <button
                type="button"
                onClick={prevMonth}
                className="btn bg-void border border-hairline rounded-lg p-1.5 px-2.5 text-xs hover:bg-obsidian/40 font-bold"
                aria-label="Previous Month"
              >
                ◀
              </button>
              <div className="text-center">
                <span className="type-display text-base tracking-wide font-bold text-fg uppercase">
                  {MONTH_NAMES[viewMonth]} {viewYear}
                </span>
              </div>
              <button
                type="button"
                onClick={nextMonth}
                className="btn bg-void border border-hairline rounded-lg p-1.5 px-2.5 text-xs hover:bg-obsidian/40 font-bold"
                aria-label="Next Month"
              >
                ▶
              </button>
            </div>

            {/* Day Number header row + 6 week rows rendered together for colour banding */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              {/* Weekday Names */}
              <div className="grid grid-cols-7 text-center font-mono text-[11px] text-muted uppercase font-bold py-1.5 border-b border-hairline shrink-0 bg-void">
                {WEEK_DAYS.map((d) => (
                  <div key={d}>{d}</div>
                ))}
              </div>

              {/* 6 week rows, each with its own background tint */}
              <div className="flex-1 flex flex-col min-h-0 gap-px bg-hairline">
                {Array.from({ length: 6 }, (_, weekIdx) => (
                  <div
                    key={weekIdx}
                    className="flex-1 grid grid-cols-7 gap-px min-h-0"
                    style={{ background: WEEK_ROW_TINTS[weekIdx] }}
                  >
                    {currentMonthDays.slice(weekIdx * 7, weekIdx * 7 + 7).map((cd, dayIdx) => {
                      const isSelected = cd.dateStr === selectedDate;
                      const isToday    = cd.dateStr === todayString();
                      const isWeekend  = dayIdx === 0 || dayIdx === 6;

                      return (
                        <button
                          key={`${cd.dateStr}-${weekIdx}-${dayIdx}`}
                          type="button"
                          onClick={() => handleSelectDay(cd.dateStr, true)}
                          style={{ background: isSelected ? "#DDD6FE" : WEEK_ROW_TINTS[weekIdx] }}
                          className={`relative flex flex-col items-start justify-start p-1.5 transition-all text-left group h-full cursor-pointer ${
                            isSelected
                              ? "ring-2 ring-purple-500 ring-inset z-10 shadow-xs"
                              : isToday
                                ? "ring-2 ring-fg ring-inset"
                                : "hover:brightness-95"
                          } ${
                            !cd.isCurrentMonth ? "opacity-40" : ""
                          }`}
                          title={`Click to add event to ${cd.dateStr}`}
                        >
                          {/* Day Number and hover + indicator */}
                          <div className="flex items-center justify-between w-full mb-1">
                            <span
                              className={`text-[15px] font-bold leading-none ${
                                isSelected
                                  ? "text-fg"
                                  : isToday
                                    ? "text-fg underline underline-offset-2 decoration-2"
                                    : isWeekend
                                      ? "text-muted"
                                      : "text-fg"
                              }`}
                            >
                              {cd.dayNumber}
                            </span>
                            <span
                              className={`opacity-0 group-hover:opacity-100 transition-opacity text-[9px] font-bold px-1 py-0.5 rounded leading-none ${
                                isSelected ? "bg-fg text-void" : "bg-fg text-void"
                              }`}
                              title="Add event to this date"
                            >
                              + Add
                            </span>
                          </div>

                          {/* Event chips (up to 2 visible) */}
                          <div className="w-full space-y-0.5 overflow-hidden">
                            {cd.items.slice(0, 2).map((item) => {
                              const meta = KIND_META[item.kind] ?? KIND_META.event;
                              return (
                                <div
                                  key={item.id}
                                  className="w-full truncate text-[9px] px-1 py-px rounded font-semibold leading-tight flex items-center gap-1"
                                  style={{
                                    background: isSelected ? "rgba(0,0,0,0.08)" : meta.bg,
                                    color: isSelected ? "var(--color-fg)" : meta.text,
                                  }}
                                  title={item.title}
                                >
                                  <span
                                    className="size-1 rounded-full shrink-0"
                                    style={{ background: isSelected ? "var(--color-fg)" : meta.dot }}
                                  />
                                  <span className="truncate">{item.title}</span>
                                </div>
                              );
                            })}
                            {cd.items.length > 2 && (
                              <div
                                className="text-[8px] font-bold px-1"
                                style={{ color: isSelected ? "rgba(255,255,255,0.8)" : "var(--color-muted)" }}
                              >
                                +{cd.items.length - 2} more
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: Selected Date Schedule, Agenda & Quick Add */}
          <div className="panel bg-void border border-hairline rounded-xl p-4 flex flex-col min-h-0 h-full overflow-hidden">
            {/* Date Header */}
            <div className="border-b border-hairline pb-3 shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {dateInfo.isToday && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-agent-chain bg-agent-chain/10 border border-agent-chain/30 rounded-full px-2 py-0.5">
                      <span className="size-1.5 rounded-full bg-agent-chain animate-pulse" />
                      Today
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next = !showAddForm;
                    setShowAddForm(next);
                    if (next) {
                      setTimeout(() => {
                        const input = document.getElementById("cal-title");
                        if (input) input.focus();
                      }, 50);
                    }
                  }}
                  className={`btn text-xs font-semibold px-3 py-1 rounded-lg border transition-all cursor-pointer ${
                    showAddForm
                      ? "border-hairline bg-void text-dim hover:text-fg"
                      : "btn-primary"
                  }`}
                >
                  {showAddForm ? "✕ Close Form" : "+ Add Event"}
                </button>
              </div>

              <h2 className="type-display text-[32px] sm:text-[38px] leading-none text-fg font-extrabold mt-2">
                {dateInfo.numeric}
              </h2>
              <p className="text-xs text-dim font-medium mt-1">
                {dateInfo.full}
              </p>
            </div>

            {/* Quick Add Event Form */}
            {showAddForm && (
              <div className="p-3.5 bg-obsidian/40 border border-hairline rounded-xl space-y-3 shrink-0 animate-fade-in">
                <div className="flex items-center justify-between border-b border-hairline pb-1.5">
                  <span className="type-mono text-[11px] font-bold uppercase text-fg flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-ok" />
                    <span>Add to {dateInfo.numeric}</span>
                  </span>
                  <span className="type-mono text-[10px] text-muted">Press Enter to save</span>
                </div>

                <div>
                  <label className="type-mono block text-[10px] font-bold text-muted uppercase mb-1" htmlFor="cal-title">
                    Event Title *
                  </label>
                  <input
                    id="cal-title"
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newTitle.trim()) {
                        e.preventDefault();
                        void handleCreateEvent();
                      }
                    }}
                    placeholder="e.g. Physics Revision, Math Exam, Team Sync"
                    className="w-full bg-obsidian border-2 border-hairline focus:border-fg p-2 text-xs font-medium outline-none text-fg rounded"
                    autoFocus
                  />
                </div>

                {/* Category Pills */}
                <div>
                  <label className="type-mono block text-[10px] font-bold text-muted uppercase mb-1">
                    Event Category
                  </label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(["event", "revision", "deadline", "exam"] as const).map((k) => {
                      const meta = KIND_META[k];
                      const isSelectedKind = newKind === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setNewKind(k)}
                          className={`py-1 px-1 rounded text-[10px] font-mono font-bold uppercase transition-all flex items-center justify-center gap-1 cursor-pointer border ${
                            isSelectedKind
                              ? "bg-fg text-void border-fg shadow-xs"
                              : "bg-void text-dim border-hairline hover:text-fg hover:border-fg/40"
                          }`}
                        >
                          <span
                            className="size-1.5 rounded-full shrink-0"
                            style={{ background: isSelectedKind ? "currentColor" : meta.dot }}
                          />
                          <span className="truncate">{meta.label}</span>
                        </button>
                      );
                    })}
                  </div>
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
                      className="w-full bg-obsidian border-2 border-hairline p-1.5 text-xs text-fg font-mono outline-none rounded"
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
                      className="w-full bg-obsidian border-2 border-hairline p-1.5 text-xs text-fg font-mono outline-none rounded"
                    />
                  </div>
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
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newTitle.trim()) {
                        e.preventDefault();
                        void handleCreateEvent();
                      }
                    }}
                    placeholder="Notes or location..."
                    className="w-full bg-obsidian border-2 border-hairline focus:border-fg p-2 text-xs font-medium outline-none text-fg rounded"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="btn bg-void border border-hairline px-3 py-1.5 text-xs rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateEvent}
                    disabled={!newTitle.trim() || savingEvent}
                    className="btn btn-primary px-4 py-1.5 text-xs font-semibold rounded-lg cursor-pointer"
                  >
                    {savingEvent ? "Saving…" : "Save Event"}
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

              {calendarLoading && events.length === 0 ? (
                <div className="space-y-3 animate-pulse p-2">
                  {[1, 2, 3].map((n) => (
                    <div key={n} className="p-3 bg-void border-2 border-hairline space-y-2 rounded">
                      <div className="flex justify-between items-center">
                        <div className="h-3 w-16 bg-fg/15 rounded" />
                        <div className="h-3 w-20 bg-fg/10 rounded" />
                      </div>
                      <div className="h-3.5 w-3/4 bg-fg/15 rounded" />
                      <div className="h-2.5 w-full bg-fg/10 rounded" />
                    </div>
                  ))}
                </div>
              ) : selectedEvents.length === 0 ? (
                <div className="p-8 text-center border border-dashed border-hairline rounded-xl">
                  <p className="text-[13px] font-semibold text-fg mb-1">
                    No events scheduled
                  </p>
                  <p className="type-mono text-xs text-muted max-w-xs mx-auto mb-4">
                    This day is open. Ask the agent or click below to add an event.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAddForm(true)}
                    className="btn btn-primary text-xs px-5 py-2 rounded-lg font-semibold"
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
                      className="p-3 rounded-xl space-y-1.5 group hover:brightness-105 transition-all"
                      style={{ background: meta.bg, borderLeft: `3px solid ${meta.dot}` }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full"
                          style={{ background: meta.dot, color: "#000" }}
                        >
                          {meta.label}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="type-mono text-[11px] font-bold" style={{ color: meta.text }}>
                            {clockTime(e.start_ts)} – {clockTime(e.end_ts)}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeEvent(e.id)}
                            className="text-xs text-muted hover:text-danger font-bold ml-1 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Delete event"
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      <h4 className="text-[13px] font-bold text-fg leading-snug">
                        {e.title}
                      </h4>

                      {e.description && (
                        <p className="text-[11px] text-dim leading-normal font-sans">
                          {e.description}
                        </p>
                      )}

                      {e.source && e.source !== "local" && (
                        <div className="pt-0.5">
                          <span className="type-mono text-[9px] text-muted uppercase">
                            via {e.source}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
              {selectedEvents.length > 0 && !showAddForm && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(true)}
                    className="btn w-full bg-void hover:bg-obsidian/30 text-xs py-2 border border-hairline rounded-lg font-semibold text-dim hover:text-fg transition-colors"
                  >
                    + Add Event
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* 12-MONTH OVERVIEW — Pressed to compact normal size for all 12 months */
        <div className="flex-1 flex flex-col space-y-4 min-h-0">
          <div className="flex items-center justify-between border-b border-hairline pb-2 px-1">
            <div>
              <span className="type-display text-xl font-bold text-fg">
                {viewYear} — Full Year Overview
              </span>
              <p className="type-mono text-xs text-muted">
                Click any month or date to zoom in
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setViewYear(viewYear - 1)}
                className="btn bg-void border border-hairline rounded-lg px-3 py-1 text-xs font-semibold hover:bg-obsidian/40"
              >
                ◀ {viewYear - 1}
              </button>
              <button
                type="button"
                onClick={() => setViewYear(viewYear + 1)}
                className="btn bg-void border border-hairline rounded-lg px-3 py-1 text-xs font-semibold hover:bg-obsidian/40"
              >
                {viewYear + 1} ▶
              </button>
              <button
                type="button"
                onClick={() => setExpandedYear(false)}
                className="btn btn-primary px-4 py-1 text-xs font-semibold rounded-lg ml-2"
              >
                Month View
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
                  className={`panel bg-void border rounded-xl p-3 flex flex-col space-y-2 transition-colors ${
                    isCurrentViewMonth ? "border-agent-chain shadow-sm" : "border-hairline"
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
