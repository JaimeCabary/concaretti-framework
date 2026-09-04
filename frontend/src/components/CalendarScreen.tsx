/**
 * Calendar — the year at a glance.
 *
 * Twelve month cards in a grid, which is what the reference app shows and what
 * the page's own tagline promises. The previous revision was a 30-day agenda
 * list and argued that a grid "reads poorly at the density this app produces" —
 * true of a *single* month blown up to fill a screen, and not true of twelve
 * small ones, where the point is not to read individual events but to see the
 * shape of the year and find the day you want.
 *
 * So the agenda did not disappear, it moved: clicking a day opens it as a
 * schedule, which is the only place an event's description, time and delete
 * button are worth the room. The grid is navigation; the modal is content.
 *
 * A day carries a dot per event, capped at three, tinted by kind. That is the
 * entire density budget for a cell 32px wide — a title would not fit and a count
 * badge would compete with the date it sits next to.
 *
 * Creation still goes through natural language, handed to the orchestrator so the
 * calendar agent parses the date. That is the behaviour worth showing, and it is
 * the reference's `Ask the calendar agent` bar.
 */

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { CalendarEvent } from "../types";
import { clockTime, Empty } from "./ui";

const KIND_DOT: Record<string, string> = {
  exam: "var(--color-danger-soft)",
  deadline: "var(--color-warn-soft)",
  revision: "var(--color-study)",
  event: "var(--color-calendar)",
};

/**
 * Month header tints, three months to a season.
 *
 * Seasonal rather than twelve distinct pastels: twelve hues in one viewport is a
 * swatch book, and the grouping is information — a glance tells you which
 * quarter you are looking at without reading a single month name.
 */
const SEASON = [
  "var(--color-agent-research)", // Dec–Feb
  "var(--color-agent-file)", // Mar–May
  "var(--color-warn-soft)", // Jun–Aug
  "var(--color-agent-news)", // Sep–Nov
];
const tintFor = (month: number) => SEASON[Math.floor(((month + 1) % 12) / 3)];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Sunday-first, matching the reference. Keys are indices — the letters repeat. */
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

const dayKey = (ts: number) => new Date(ts * 1000).toDateString();

function Sparkle() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[18px] shrink-0 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z" />
      <path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </svg>
  );
}

function Chevron({ dir }: { dir: "prev" | "next" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path
        d={
          dir === "prev" ? "M14.5 5.5 8 12l6.5 6.5" : "M9.5 5.5 16 12l-6.5 6.5"
        }
      />
    </svg>
  );
}

/**
 * One month.
 *
 * Leading blanks rather than trailing days from the previous month: a greyed-out
 * `29 30 31` in the first row of January is three numbers that belong to a
 * different card, and at this size the eye reads them as January's.
 */
function Month({
  year,
  month,
  byDay,
  onPick,
}: {
  year: number;
  month: number;
  byDay: Map<string, CalendarEvent[]>;
  onPick: (d: Date) => void;
}) {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const today = new Date().toDateString();

  return (
    <section
      className="panel bg-obsidian overflow-hidden border-hairline shadow-none"
      style={{ borderRadius: "var(--radius-lg)" }}
    >
      <header
        className="flex items-baseline justify-between gap-2 px-5 py-3"
        style={{ background: tintFor(month) }}
      >
        <h3 className="type-display text-[16px] uppercase">{MONTHS[month]}</h3>
        <span className="type-mono text-[11px] text-fg/40">{year}</span>
      </header>

      <div className="grid grid-cols-7 gap-y-2 gap-x-1 px-4 pb-4 pt-3">
        {DOW.map((d, n) => (
          <span
            key={n}
            aria-hidden
            className="type-mono grid h-6 place-items-center text-[10px] text-muted font-semibold"
          >
            {d}
          </span>
        ))}

        {Array.from({ length: first.getDay() }, (_, n) => (
          <span key={`pad${n}`} aria-hidden />
        ))}

        {Array.from({ length: days }, (_, n) => {
          const date = new Date(year, month, n + 1);
          const items = byDay.get(date.toDateString()) ?? [];
          const isToday = date.toDateString() === today;

          return (
            <button
              key={n}
              type="button"
              onClick={() => onPick(date)}
              aria-label={`${n + 1} ${MONTHS[month]} ${year}, ${items.length} events`}
              className={`relative grid h-8 place-items-center rounded-lg text-[12px]
                transition-colors ${
                  isToday
                    ? "font-semibold text-fg"
                    : items.length
                      ? "text-fg hover:bg-elevated"
                      : "text-dim hover:bg-elevated"
                }`}
              style={
                isToday ? { background: "var(--color-elevated)" } : undefined
              }
            >
              {n + 1}
              {items.length > 0 && (
                <span className="absolute bottom-[3px] flex gap-[2px]">
                  {items.slice(0, 3).map((e) => (
                    <span
                      key={e.id}
                      aria-hidden
                      className="size-[3px] rounded-full"
                      style={{
                        background:
                          KIND_DOT[e.kind] ?? "var(--color-agent-calendar)",
                      }}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The day schedule. A dialog, because it is the only modal state this screen has. */
function DayModal({
  date,
  items,
  onClose,
  onDelete,
}: {
  date: Date;
  items: CalendarEvent[];
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[8000] grid place-items-center p-4"
      style={{ background: "#1a1a1a29" }}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="panel flex max-h-[80svh] w-full max-w-lg flex-col"
        style={{ boxShadow: "var(--shadow-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-4">
          <h2 className="type-tagline text-[22px] leading-tight text-fg">
            {date.toLocaleDateString([], {
              weekday: "long",
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="type-mono shrink-0 text-[10px] text-dim underline"
          >
            Close
          </button>
        </header>

        {items.length === 0 ? (
          <p className="type-mono px-5 pb-6 pt-2 text-center text-[11px] text-muted">
            It&rsquo;s quiet here today.
          </p>
        ) : (
          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-5 pb-5 pt-1">
            {items.map((e) => (
              <li
                key={e.id}
                className="inset group flex items-start gap-2.5 px-3 py-2.5"
              >
                <span
                  aria-hidden
                  className="mt-1 size-2.5 shrink-0 rounded-full"
                  style={{
                    background:
                      KIND_DOT[e.kind] ?? "var(--color-agent-calendar)",
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-fg">{e.title}</p>
                  <p className="text-[11px] text-dim">
                    {clockTime(e.start_ts)} – {clockTime(e.end_ts)}
                    {e.source !== "local" ? ` · ${e.source}` : ""}
                  </p>
                  {e.description ? (
                    <p className="mt-0.5 text-[11px] leading-snug text-dim">
                      {e.description}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onDelete(e.id)}
                  className="shrink-0 text-[11px] text-dim underline opacity-0
                    transition-opacity hover:text-danger focus:opacity-100
                    group-hover:opacity-100"
                  aria-label={`Delete ${e.title}`}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function CalendarScreen() {
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);
  const finalSummary = useAgentStore((s) => s.finalSummary);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [nl, setNl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [picked, setPicked] = useState<Date | null>(null);
  const [expandedYear, setExpandedYear] = useState(false);

  // A year of grid needs a year of events. One request rather than twelve: the
  // endpoint takes a horizon in days, and 400 covers the whole grid plus the
  // spill either side that a January or December card shows.
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

  // A finished run may have created an event; refetch rather than guess.
  useEffect(() => {
    if (finalSummary) load();
  }, [finalSummary, load]);

  const submit = () => {
    const text = nl.trim();
    if (!text || running) return;
    void runPrompt(text);
    setNl("");
  };

  const remove = (id: string) => {
    void api.deleteEvent(id).then(load);
  };

  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of [...events].sort((a, b) => a.start_ts - b.start_ts)) {
    const k = dayKey(e.start_ts);
    const bucket = byDay.get(k);
    if (bucket) bucket.push(e);
    else byDay.set(k, [e]);
  }

  const thisYear = new Date().getFullYear();

  return (
    <div className="space-y-5">
      {/* Year nav matching the screenshot */}
      <div
        className="panel bg-obsidian flex items-center justify-between p-4"
        style={{ borderRadius: "999px" }}
      >
        <button
          type="button"
          onClick={() => {
            /* back button logic if any, or just visual */
          }}
          className="btn bg-void border-hairline shadow-none size-[46px] rounded-full p-0 flex items-center justify-center text-dim hover:text-fg transition-colors"
        >
          <Chevron dir="prev" />
        </button>

        <div className="flex items-center gap-4">
          <div className="bg-calendar size-12 rounded-2xl flex items-center justify-center text-fg">
            <svg
              viewBox="0 0 24 24"
              className="size-6"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
              <path d="M3.5 10h17M8.5 3v4M15.5 3v4" />
            </svg>
          </div>
          <div className="flex flex-col justify-center">
            <span className="type-tagline text-[16px] text-dim leading-none mb-1">
              Your year at a glance
            </span>
            <span className="type-display text-[32px] leading-none text-fg">
              CALENDAR {year}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {year !== thisYear && (
            <button
              type="button"
              onClick={() => setYear(thisYear)}
              className="btn bg-calendar border-none shadow-none text-fg px-5"
            >
              This Year
            </button>
          )}
          <button
            type="button"
            onClick={() => setYear(year - 1)}
            className="btn bg-void border-hairline shadow-none size-[46px] rounded-full p-0 flex items-center justify-center text-dim hover:text-fg transition-colors"
          >
            <Chevron dir="prev" />
          </button>
          <button
            type="button"
            onClick={() => setYear(year + 1)}
            className="btn bg-void border-hairline shadow-none size-[46px] rounded-full p-0 flex items-center justify-center text-dim hover:text-fg transition-colors"
          >
            <Chevron dir="next" />
          </button>
        </div>
      </div>

      {/* Ask the agent bar */}
      <div
        className="panel bg-obsidian flex items-center gap-3 px-4 py-2"
        style={{ borderRadius: "999px" }}
      >
        <Sparkle />
        <input
          value={nl}
          onChange={(e) => setNl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Ask the calendar agent — e.g. 'Find me a free hour next week for lunch'"
          className="min-w-0 flex-1 bg-transparent py-2 text-[14px] text-fg
            placeholder:text-muted focus:outline-none"
          aria-label="Ask the calendar agent"
        />
        <button
          type="button"
          onClick={submit}
          disabled={running || !nl.trim()}
          className="btn bg-calendar border-none shadow-none text-fg shrink-0 px-5"
        >
          Ask Agent
        </button>
      </div>

      {err ? (
        <p className="inset-flat bg-warn-soft px-3 py-2 text-[12px] text-fg">
          {err}
        </p>
      ) : null}

      {events.length === 0 && !err ? (
        <Empty>
          Nothing scheduled yet — ask the agent, or say it in plain words.
        </Empty>
      ) : null}

      <div className="flex justify-between items-center px-2">
        <h2 className="type-display text-[20px] text-fg">
          {expandedYear ? "FULL YEAR" : "CURRENT MONTH"}
        </h2>
        <button
          type="button"
          onClick={() => setExpandedYear(!expandedYear)}
          className="btn bg-obsidian border border-hairline shadow-none hover:bg-elevated transition-colors px-4 py-1.5"
          style={{ borderRadius: "var(--radius)" }}
        >
          <span className="type-mono text-[11px] font-semibold flex items-center gap-2">
            {expandedYear ? "Collapse Year" : "Expand Full Year"}
          </span>
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {MONTHS.map((_, m) => {
          // If not expanded, only show the current active month for this year
          const currentMonth = new Date().getMonth();
          if (!expandedYear && (m !== currentMonth || year !== thisYear)) {
             // If we're viewing a past/future year and not expanded, show January by default
             if (!expandedYear && year !== thisYear && m !== 0) return null;
             // If we're viewing this year and not expanded, show the current month
             if (!expandedYear && year === thisYear && m !== currentMonth) return null;
          }

          return (
            <Month
              key={m}
              year={year}
              month={m}
              byDay={byDay}
              onPick={setPicked}
            />
          );
        })}
      </div>

      {picked && (
        <DayModal
          date={picked}
          items={byDay.get(picked.toDateString()) ?? []}
          onClose={() => setPicked(null)}
          onDelete={remove}
        />
      )}
    </div>
  );
}
