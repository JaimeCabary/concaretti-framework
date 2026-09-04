/**
 * In-app browser.
 *
 * The page is rendered by Chromium on the backend and arrives here as text plus
 * a JPEG. That is a deliberate choice over an `<iframe>`: every site worth
 * opening sends `X-Frame-Options: DENY` or `frame-ancestors 'none'`, so an
 * iframe viewer shows a blank rectangle for exactly the pages that matter. It
 * also means the visited page's JavaScript never executes in this origin — the
 * agent's browser is a separate process with its own cookie jar, and what
 * crosses back is pixels and text.
 *
 * Navigation is a read and goes direct. Interaction (`browser_act`) is
 * HALO-gated and routed through the orchestrator, so clicking "Run steps"
 * suspends server-side until the gate is answered.
 */

import { useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { SpawnResult } from "../types";
import { Chip, Empty, Panel, Spinner } from "./ui";

type Page = Awaited<ReturnType<typeof api.browse>>;

export function BrowserPanel() {
  const running = useAgentStore((s) => s.running);
  const track = useAgentStore((s) => s.trackSpawned);

  const [url, setUrl] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"shot" | "text" | "links">("shot");

  const go = (target?: string) => {
    const next = (target ?? url).trim();
    if (!next || busy) return;
    setBusy(true);
    setErr(null);
    setUrl(next);
    void api
      .browse(next)
      .then((r) => {
        if (r.ok) {
          setPage(r);
          // A page with no capture has nothing to show on the shot tab.
          setView(r.image ? "shot" : "text");
        } else {
          setErr(r.summary);
        }
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Navigation failed"),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Panel
      title="Browser"
      accent="var(--color-agent-browser)"
      actions={
        page?.transport ? (
          <Chip title="Where the page was rendered — an attached CDP endpoint, or a locally installed Chrome or Edge">
            {page.transport.startsWith("cdp:")
              ? "remote"
              : page.transport.split(":")[1]}
          </Chip>
        ) : null
      }
    >
      <div className="flex items-center gap-2 border-b-2 border-fg p-3">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
          placeholder="example.com"
          aria-label="Address"
          className="field flex-1 font-mono text-[12px]"
        />
        <button
          type="button"
          className="btn btn-primary px-3 py-1.5 text-[12px]"
          disabled={busy || !url.trim()}
          onClick={() => go()}
        >
          {busy ? "Loading" : "Open"}
        </button>
      </div>

      {err && (
        <p className="border-b-2 border-fg bg-danger-soft px-3 py-2 text-[12px] leading-snug text-fg">
          {err}
        </p>
      )}

      {busy && !page ? (
        <div className="p-4">
          <Spinner label="Rendering page" />
        </div>
      ) : !page ? (
        <Empty>
          Type an address to render it. Loopback, private ranges and anything in
          .conca&rsquo;s blocked list are refused before Chromium is asked.
        </Empty>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b-2 border-fg px-3 py-2">
            {(["shot", "text", "links"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`chip ${view === v ? "bg-council-soft" : ""}`}
                aria-pressed={view === v}
              >
                {v === "shot"
                  ? "Page"
                  : v === "text"
                    ? "Text"
                    : `Links ${page.links?.length ?? 0}`}
              </button>
            ))}
            <span className="type-mono ml-auto truncate text-[10px] text-muted">
              {page.status} · {page.title}
            </span>
          </div>

          <div className="max-h-[58vh] overflow-auto">
            {view === "shot" ? (
              page.image ? (
                <img
                  src={page.image}
                  alt={`Rendered screenshot of ${page.title || page.url}`}
                  className="block w-full"
                />
              ) : (
                <Empty>{page.image_error ?? "No capture for this page."}</Empty>
              )
            ) : view === "text" ? (
              <pre className="whitespace-pre-wrap p-3 text-[12px] leading-relaxed text-fg">
                {page.text}
              </pre>
            ) : (
              <ul className="divide-y-2 divide-fg">
                {(page.links ?? []).map((l, i) => (
                  <li key={`${l.href}-${i}`}>
                    <button
                      type="button"
                      onClick={() => go(l.href)}
                      className="w-full px-3 py-2 text-left hover:bg-elevated"
                    >
                      <p className="truncate text-[12px] text-fg">{l.text}</p>
                      <p className="truncate font-mono text-[10px] text-muted">
                        {l.href}
                      </p>
                    </button>
                  </li>
                ))}
                {(page.links ?? []).length === 0 && (
                  <li>
                    <Empty>No links.</Empty>
                  </li>
                )}
              </ul>
            )}
          </div>

          <ActBar url={page.url ?? url} disabled={running} onSpawn={track} />
        </>
      )}
    </Panel>
  );
}

/**
 * Interaction, kept behind its own affordance.
 *
 * Collapsed by default because it is the gated half: the panel should read as a
 * reader first, and acting in someone's live session should take a deliberate
 * click rather than being one keystroke away from the address bar.
 */
function ActBar({
  url,
  disabled,
  onSpawn,
}: {
  url: string;
  disabled: boolean;
  onSpawn: (r: SpawnResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selector, setSelector] = useState("");
  const [value, setValue] = useState("");
  const [action, setAction] = useState<"click" | "fill" | "press">("click");
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    if (!selector.trim() || disabled) return;
    setErr(null);
    void api
      .browserAct(url, [{ action, selector: selector.trim(), value }])
      .then(onSpawn)
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Could not queue the step"),
      );
  };

  if (!open) {
    return (
      <div className="border-t-2 border-fg p-2.5">
        <button
          type="button"
          className="chip"
          onClick={() => setOpen(true)}
          title="Clicking and typing in a live page pauses for approval"
        >
          Interact — pauses for approval
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t-2 border-fg p-3">
      <div className="flex gap-2">
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as typeof action)}
          className="field w-24 text-[12px]"
          aria-label="Action"
        >
          <option value="click">click</option>
          <option value="fill">fill</option>
          <option value="press">press</option>
        </select>
        <input
          value={selector}
          onChange={(e) => setSelector(e.target.value)}
          placeholder="CSS selector"
          aria-label="Selector"
          className="field flex-1 font-mono text-[12px]"
        />
      </div>
      {action !== "click" && (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={action === "press" ? "Key, e.g. Enter" : "Text to type"}
          aria-label="Value"
          className="field font-mono text-[12px]"
        />
      )}
      {err && <p className="text-[11px] font-semibold text-danger">{err}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-primary flex-1 py-1.5 text-[12px]"
          disabled={disabled || !selector.trim()}
          onClick={run}
        >
          Run step
        </button>
        <button
          type="button"
          className="btn py-1.5 text-[12px]"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
