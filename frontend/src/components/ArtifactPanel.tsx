/**
 * Files produced by a run.
 *
 * Every artifact carries the sha256 of its bytes and the prompt that caused it —
 * that pairing is the provenance claim, so both are shown rather than just a
 * filename. Downloads go through the backend so the file is served from where it
 * was actually written, and a 410 tells you the row outlived the file.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { Artifact } from "../types";
import { Empty, Panel, relTime } from "./ui";

const sizeHint = (mime: string | undefined) =>
  mime?.split("/")[1]?.toUpperCase() ?? "FILE";

export function ArtifactPanel({ compact = false }: { compact?: boolean }) {
  const live = useAgentStore((s) => s.artifacts);
  const sessionId = useAgentStore((s) => s.sessionId);
  const running = useAgentStore((s) => s.running);
  const [fetched, setFetched] = useState<Artifact[]>([]);

  // The stream carries artifacts as they're produced, but a reload or a
  // late-joined session needs the stored set too.
  useEffect(() => {
    if (!sessionId || running) return;
    let cancelled = false;
    api
      .artifacts(sessionId)
      .then((r) => {
        if (!cancelled) setFetched(r.artifacts);
      })
      .catch(() => {
        /* the live list still renders */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, running]);

  const byId = new Map<string, Artifact>();
  for (const a of [...fetched, ...live]) byId.set(a.id, a);
  const artifacts = [...byId.values()].sort((a, b) => b.ts - a.ts);

  if (compact && artifacts.length === 0) return null;

  return (
    <Panel
      title="Artifacts"
      accent="var(--color-study)"
      actions={
        artifacts.length ? (
          <span className="text-[11px] text-muted">{artifacts.length}</span>
        ) : null
      }
      bodyClass="overflow-y-auto max-h-[40vh]"
    >
      {artifacts.length === 0 ? (
        <Empty>Nothing generated yet.</Empty>
      ) : (
        <ul className="divide-y-2 divide-fg">
          {artifacts.map((a) => (
            <li key={a.id} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-fg">
                    {a.filename}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <span className="font-mono">{sizeHint(a.mime)}</span>
                    <span>·</span>
                    <span>{relTime(a.ts)}</span>
                    {a.sha256 ? (
                      <>
                        <span>·</span>
                        <span
                          className="font-mono"
                          title={`sha256: ${a.sha256}`}
                        >
                          {a.sha256.slice(0, 10)}
                        </span>
                      </>
                    ) : null}
                  </p>
                  {a.prompt ? (
                    <p
                      className="mt-1 line-clamp-2 text-[11px] italic leading-snug text-muted"
                      title={a.prompt}
                    >
                      “{a.prompt}”
                    </p>
                  ) : null}
                </div>
                <a
                  href={api.artifactDownloadUrl(a.id)}
                  download={a.filename}
                  className="btn shrink-0 px-2.5 py-1 text-[12px]"
                >
                  Download
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
