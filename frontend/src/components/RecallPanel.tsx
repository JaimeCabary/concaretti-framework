/**
 * Cross-session semantic recall.
 *
 * Two things this panel has to be honest about:
 *
 *   1. Rule 0. When a query trips a sensitive pattern the backend performs no
 *      search at all and says so. That is rendered as an explicit statement, not
 *      as an empty result — "no matches" and "we refuse to search this" are
 *      different claims and conflating them would misrepresent the guarantee.
 *   2. The backend. `sqlite-vec` when the extension loaded, a lexical fallback
 *      otherwise. Distance is only meaningful in the former case, so it's shown
 *      conditionally.
 */

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { RecallResponse } from "../types";
import { Chip, Empty, Panel, relTime } from "./ui";

const DEBOUNCE_MS = 300;

export function RecallPanel() {
  const sessionId = useAgentStore((s) => s.sessionId);
  const [q, setQ] = useState("");
  const [res, setRes] = useState<RecallResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 3) {
      setRes(null);
      setErr(null);
      return;
    }

    const mine = ++seq.current;
    setBusy(true);
    const timer = setTimeout(() => {
      api
        .recall(query, { sessionId: sessionId ?? undefined })
        .then((r) => {
          // Ignore a response that a newer keystroke has superseded.
          if (mine === seq.current) {
            setRes(r);
            setErr(null);
          }
        })
        .catch((e: unknown) => {
          if (mine !== seq.current) return;
          setRes(null);
          setErr(
            e instanceof ApiError && e.isOffline
              ? "Recall needs the backend — offline."
              : e instanceof Error
                ? e.message
                : "Recall failed",
          );
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [q, sessionId]);

  return (
    <Panel
      title="Recall"
      accent="var(--color-diary)"
      actions={
        res && !res.excluded && res.backend ? (
          <Chip
            tone={res.backend === "sqlite-vec" ? "ok" : "warn"}
            title={
              res.backend === "sqlite-vec"
                ? "Vector search via the sqlite-vec extension"
                : "Vector extension unavailable — keyword fallback in use"
            }
          >
            {res.backend === "sqlite-vec" ? "vector" : "lexical"}
          </Chip>
        ) : null
      }
    >
      <div className="space-y-2 px-3 py-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search earlier sessions…"
          className="field"
          aria-label="Search earlier sessions"
        />

        {busy ? (
          <p className="px-1 text-[12px] text-muted">Searching…</p>
        ) : err ? (
          <p className="px-1 text-[12px] text-warn">{err}</p>
        ) : res?.excluded ? (
          <div className="inset-flat bg-diary px-3 py-2.5">
            <p className="type-display text-[12px] text-fg">
              Excluded by Rule 0
            </p>
            <p className="mt-1 text-[12px] leading-snug text-fg">
              {res.reason ??
                "This query matches a protected pattern. No search was run."}
            </p>
            <p className="mt-1.5 text-[11px] leading-snug text-dim">
              Content of this kind is never embedded and never recalled — the
              conversation itself is kept, but it is not searchable.
            </p>
          </div>
        ) : res && res.hits.length === 0 ? (
          <Empty>No earlier context matched.</Empty>
        ) : res ? (
          <ul className="space-y-1.5">
            {res.hits.map((h, i) => (
              <li
                key={`${h.session_id}-${h.ts}-${i}`}
                className="inset px-3 py-2"
              >
                <p className="type-mono flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
                  <span>{h.agent ?? h.role}</span>
                  <span>·</span>
                  <span>{relTime(h.ts)}</span>
                  {h.distance !== null ? (
                    <>
                      <span>·</span>
                      <span
                        className="font-mono normal-case"
                        title="Cosine distance — lower is closer"
                      >
                        d={h.distance.toFixed(3)}
                      </span>
                    </>
                  ) : null}
                </p>
                <p className="mt-1 line-clamp-4 text-[12px] leading-relaxed text-dim">
                  {h.content}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-1 text-[11px] leading-snug text-muted">
            Recall spans every past session. Type at least three characters.
          </p>
        )}
      </div>
    </Panel>
  );
}
