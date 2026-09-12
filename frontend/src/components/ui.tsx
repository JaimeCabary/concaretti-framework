/**
 * Small presentational primitives shared across screens.
 *
 * Kept in one file because each is a handful of lines and they're always
 * imported together; a directory of eight one-component files would be more
 * navigation than code.
 */

import type { ReactNode } from "react";
import { useAgentStore } from "../store/agentStore";
import type { SubtaskStatus } from "../types";

// ── brand ──────────────────────────────────────────────────────────────────

/**
 * The Concaretti mark.
 *
 * `public/favicon.png` is the same artwork the original app ships, so the
 * header logo, the browser tab and the installed-PWA icon are one file rather
 * than three drifting copies. Decoding is left async and the box is reserved by
 * width/height so the header never reflows around it on first paint.
 *
 * The asset is dropped in by hand rather than generated, so a missing file hides
 * the element instead of leaving a broken-image glyph in the header — the
 * wordmark beside it already identifies the app.
 */
export function ConcarettiLogo({ size = 28 }: { size?: number }) {
  return (
    <img
      src="/favicon.png"
      width={size}
      height={size}
      alt=""
      aria-hidden
      decoding="async"
      className="shrink-0"
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
      style={{
        inlineSize: size,
        blockSize: size,
        border: "2px solid var(--color-fg)",
        borderRadius: 6,
      }}
    />
  );
}

/** Wordmark + mark, as the original sidebar draws it. */
export function Brand({ subtitle = "multi-agent os" }: { subtitle?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <ConcarettiLogo />
      <span className="flex flex-col leading-none">
        <span className="type-display text-[17px]">Concaretti</span>
        <span className="type-mono text-[9px] text-muted">{subtitle}</span>
      </span>
    </span>
  );
}

// ── layout ─────────────────────────────────────────────────────────────────

export function Panel({
  title,
  accent,
  actions,
  children,
  className = "",
  bodyClass = "",
  quiet = false,
}: {
  title?: ReactNode;
  accent?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  /**
   * Drop the box: no fill, no border, no shadow — a title, a hairline, and
   * whitespace. For ambient readouts that sit alongside the thing they describe
   * rather than being objects in their own right. See `.panel-quiet`.
   */
  quiet?: boolean;
}) {
  return (
    <section
      className={`panel ${quiet ? "panel-quiet" : ""} flex min-h-0 flex-col ${className}`}
    >
      {title !== undefined && (
        <header className="panel-head">
          {/*
            The accent is a swatch, not the title colour.

            Every accent in this palette is a pastel fill; painting 13px text in
            one puts it around 1.6:1 on white. The original app draws its panel
            headings in black for the same reason and carries screen identity in
            filled shapes, so the accent moves to a 12px square and the title
            stays legible.
          */}
          <h2 className="type-display flex min-w-0 items-center gap-2 text-[14px]">
            {accent && (
              <span
                aria-hidden
                className="panel-swatch"
                style={{ background: accent }}
              />
            )}
            <span className="truncate">{title}</span>
          </h2>
          {actions}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 py-8 text-center text-[13px] text-muted">{children}</p>
  );
}

/**
 * The screen-level tab strip.
 *
 * One implementation shared by Staff and Student, which previously carried
 * near-identical copies. The generic keeps each screen's own `Tab` union intact —
 * `<TabBar<Tab> …>` — so a typo in a key is still a compile error rather than
 * being widened to `string` by the extraction.
 *
 * The active tab is a filled pill with a hard shadow rather than a tinted
 * background: with a cream page and white panels, a tonal shift alone is close to
 * invisible, and the original app marks its active nav item exactly this way.
 */
export function TabBar<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: ReadonlyArray<{ key: T; label: string }>;
  active: T;
  onSelect: (key: T) => void;
}) {
  return (
    <nav className="flex flex-wrap gap-1.5" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          type="button"
          aria-selected={active === t.key}
          onClick={() => onSelect(t.key)}
          className={
            active === t.key
              ? "btn btn-primary px-3 py-1.5 text-[13px]"
              : "btn px-3 py-1.5 text-[13px]"
          }
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * The run's closing summary.
 *
 * Reads the store directly rather than taking a prop because both screens
 * rendered it from the same field, and threading it down meant every parent
 * re-rendered on each frame of the stream. Renders nothing until a run finishes,
 * so it can sit unconditionally in a column.
 */
export function Result({ fixed = false }: { fixed?: boolean }) {
  const summary = useAgentStore((s) => s.finalSummary);
  if (!summary) return null;
  return (
    <article
      className={`${fixed ? "fixed bottom-[12rem] left-1/2 z-40 w-[min(720px,calc(100vw-2rem))] -translate-x-1/2" : ""} panel px-4 py-3`}
    >
      <h2 className="type-mono text-[10px] text-muted">Result</h2>
      <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-fg">
        {summary}
      </p>
    </article>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-dim">
      <span className="size-2 animate-pulse-soft rounded-full border-2 border-fg bg-council-soft" />
      {label ?? "Working"}
    </span>
  );
}

// ── status ─────────────────────────────────────────────────────────────────

/**
 * Flat pastel fill, black border, black text — the `.neo-badge` shape.
 *
 * The previous revision tinted a single ink token at 15% and drew the label in
 * that same ink (`bg-ok/15 text-ok`). That composites to a pale wash with
 * low-contrast coloured text; here the pastel does the identifying and black
 * does the reading, which is both legible and the style the app is in.
 */
const STATUS_STYLE: Record<SubtaskStatus, { cls: string; label: string }> = {
  pending: { cls: "bg-elevated", label: "Pending" },
  running: { cls: "bg-info-soft animate-pulse-soft", label: "Running" },
  done: { cls: "bg-ok-soft", label: "Done" },
  failed: { cls: "bg-danger-soft", label: "Failed" },
  // Skipped and rejected are visually distinct on purpose: "skipped" means the
  // plan moved on, "rejected" means .conca or a human refused it. Collapsing
  // them would hide exactly the outcome this app exists to make visible.
  skipped: { cls: "bg-warn-soft", label: "Skipped" },
  rejected: { cls: "bg-danger-soft line-through", label: "Refused" },
};

export function StatusBadge({ status }: { status: SubtaskStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.pending;
  return (
    <span
      className={`inline-flex items-center rounded-full border-2 border-fg px-2 py-0.5
        font-mono text-[10px] font-semibold uppercase tracking-wider text-fg ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

export function Chip({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "danger" | "info";
  title?: string;
}) {
  const tones = {
    neutral: "",
    ok: "bg-ok-soft",
    warn: "bg-warn-soft",
    danger: "bg-danger-soft",
    info: "bg-info-soft",
  };
  return (
    <span className={`chip ${tones[tone]}`} title={title}>
      {children}
    </span>
  );
}

// ── agent identity ─────────────────────────────────────────────────────────

/**
 * The CSS custom property holding an agent's colour.
 *
 * Resolved by name instead of through a table here, which keeps `index.css` the
 * single source of truth for the palette: an agent added to `.conca` without a
 * token falls back to the council accent rather than rendering colourless, and
 * there is no second list to drift out of step. The trade is that a typo in a
 * token name fails silently as "council" — acceptable for colour, and the reason
 * the fallback is a real accent and not `inherit`.
 *
 * The name is sanitised on the way through. It comes from the policy file and is
 * interpolated into a `style` attribute, and `[a-z0-9-]` is the whole alphabet a
 * custom-property name needs here.
 *
 * These are **fill** colours. Do not use one as a text colour — see `AgentTag`.
 */
export const agentColor = (agent: string): string => {
  const slug = agent.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const normalized = slug === "concaretti" ? "orchestrator" : slug;
  return `var(--color-agent-${normalized}, var(--color-council-soft))`;
};

/**
 * An agent's name, on that agent's colour.
 */
export function AgentTag({
  agent,
  title,
  className = "",
}: {
  agent: string;
  title?: string;
  className?: string;
}) {
  const isOrch = agent.toLowerCase() === "orchestrator";
  const display = isOrch ? "Concaretti" : agent;
  return (
    <span
      title={title || (isOrch ? "Concaretti (Orchestrator Council)" : agent)}
      className={`inline-flex items-center rounded-full border border-fg/30 px-2 py-0.5
        font-mono text-[9.5px] font-bold uppercase tracking-normal text-fg shrink-0 shadow-2xs ${className}`}
      style={{ background: agentColor(agent) }}
    >
      {display}
    </span>
  );
}

// ── formatting ─────────────────────────────────────────────────────────────

/** Backend timestamps are float seconds (`time.time()`), not JS milliseconds. */
const toDate = (ts: number) => new Date(ts * 1000);

export function relTime(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 604_800) return `${Math.round(diff / 86_400)}d ago`;
  return toDate(ts).toLocaleDateString();
}

export const clockTime = (ts: number) =>
  toDate(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
