/**
 * Student timetable — the calendar filtered to what a student is revising for.
 *
 * Only `exam`, `deadline` and `revision` events, grouped by day. The filter runs
 * server-side via the `kinds` query parameter, so a full calendar of personal
 * events never reaches this screen in the first place.
 *
 * Adding a revision block writes a normal calendar event with `kind: revision`,
 * which means the agent can see and reason about it later — the quick-add isn't
 * a separate store.
 */

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { CalendarEvent } from "../types";
import { clockTime, Empty, Panel } from "./ui";

const KINDS = ["exam", "deadline", "revision"];

/** Fills only — the border and the label are black on all three, so an exam and
 *  a revision block are told apart by hue rather than by reading the word. */
const KIND_STYLE: Record<string, string> = {
  exam: "bg-danger-soft",
  deadline: "bg-warn-soft",
  revision: "bg-study",
};

const dayKey = (ts: number) => new Date(ts * 1000).toDateString();

const daysUntil = (ts: number) => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const then = new Date(ts * 1000);
  then.setHours(0, 0, 0, 0);
  return Math.round((then.getTime() - now.getTime()) / 86_400_000);
};

const countdown = (ts: number) => {
  const d = daysUntil(ts);
  if (d < 0) return "past";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
};

/** `datetime-local` yields local wall time; the backend stores epoch seconds. */
const toEpoch = (local: string) => new Date(local).getTime() / 1000;

export function StudentTimetable() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [hours, setHours] = useState(2);

  const load = useCallback(() => {
    // `void` rather than returning the chain: an effect callback must return a
    // cleanup function or nothing, never a Promise.
    void api
      .events({ days: 90, kinds: KINDS })
      .then((r) => {
        setEvents(r.events);
        setErr(null);
      })
      .catch((e: unknown) =>
        setErr(
          e instanceof ApiError && e.isOffline
            ? "Offline — showing nothing new."
            : e instanceof Error
              ? e.message
              : "Could not load the timetable",
        ),
      );
  }, []);

  useEffect(load, [load]);

  const submit = async () => {
    if (!title.trim() || !start) return;
    const startTs = toEpoch(start);
    await api.createEvent({
      title: title.trim(),
      start: startTs,
      end: startTs + hours * 3600,
      kind: "revision",
      description: "Revision block",
    });
    setTitle("");
    setStart("");
    setAdding(false);
    load();
  };

  const upcoming = events
    .filter((e) => daysUntil(e.start_ts) >= 0)
    .sort((a, b) => a.start_ts - b.start_ts);

  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of upcoming) {
    const k = dayKey(e.start_ts);
    const bucket = byDay.get(k);
    if (bucket) bucket.push(e);
    else byDay.set(k, [e]);
  }

  const nextExam = upcoming.find((e) => e.kind === "exam");

  return (
    <Panel
      title="Timetable"
      accent="var(--color-study)"
      actions={
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          className="chip"
        >
          {adding ? "Cancel" : "+ Revision block"}
        </button>
      }
      bodyClass="overflow-y-auto max-h-[60vh]"
    >
      {nextExam ? (
        <div className="border-b-2 border-fg bg-danger-soft px-3 py-2.5">
          <p className="type-mono text-[10px] text-fg">Next exam</p>
          <p className="mt-0.5 text-[14px] font-semibold text-fg">
            {nextExam.title}
          </p>
          <p className="text-[12px] font-semibold text-fg">
            {countdown(nextExam.start_ts)}
          </p>
        </div>
      ) : null}

      {adding ? (
        <div className="space-y-2 border-b-2 border-fg px-3 py-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What are you revising?"
            className="field"
            aria-label="Revision topic"
          />
          <div className="flex gap-2">
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="field flex-1"
              aria-label="Start time"
            />
            <select
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="field w-24"
              aria-label="Duration in hours"
            >
              {[1, 2, 3, 4].map((h) => (
                <option key={h} value={h}>
                  {h}h
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!title.trim() || !start}
            className="btn btn-primary w-full py-1.5 text-[13px]"
          >
            Add block
          </button>
        </div>
      ) : null}

      {err ? (
        <p className="border-b-2 border-fg bg-danger-soft px-3 py-2 text-[12px] text-fg">
          {err}
        </p>
      ) : byDay.size === 0 ? (
        <Empty>No exams, deadlines or revision blocks scheduled.</Empty>
      ) : (
        <div className="space-y-3 px-3 py-3">
          {[...byDay.entries()].map(([day, items]) => (
            <div key={day}>
              <p className="type-mono mb-1.5 flex items-baseline gap-2 text-[10px] text-muted">
                <span>{day}</span>
                <span className="h-0.5 flex-1 bg-fg" />
                <span className="normal-case">
                  {countdown(items[0].start_ts)}
                </span>
              </p>
              <ul className="space-y-1.5">
                {items.map((e) => (
                  <li key={e.id} className="inset px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] text-fg">
                          {e.title}
                        </p>
                        <p className="text-[11px] text-dim">
                          {clockTime(e.start_ts)} – {clockTime(e.end_ts)}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border-2 border-fg px-2 py-0.5
                          font-mono text-[10px] font-semibold uppercase tracking-wider text-fg ${
                            KIND_STYLE[e.kind] ?? "bg-elevated"
                          }`}
                      >
                        {e.kind}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
