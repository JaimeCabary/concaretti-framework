/**
 * The navigation rail.
 *
 * Replaces the wrapping row of shadowed pill buttons that used to sit above the
 * content. Eleven of those pills wrapped to two lines and then competed with
 * every panel beneath them for the same visual weight; a rail puts navigation
 * permanently at the edge and leaves the middle of the screen for one thing.
 *
 * Three deliberate departures from the rest of the app's vocabulary, because
 * chrome is not content:
 *
 *  - **The active item is a soft pastel pill with no border and no shadow.** A
 *    2px black outline and a hard offset shadow say "this is a button you may
 *    press"; eleven of them say it eleven times. Fill alone is unambiguous when
 *    exactly one item in a list ever carries it.
 *  - **The divider is a hairline at 12% ink, not a 2px slab.** It separates two
 *    regions of chrome, which is a quieter job than separating a card from the
 *    page.
 *  - **Icons are 18px strokes.** Inline SVG rather than an icon dependency —
 *    eleven glyphs is not worth 40kB and a build step.
 *
 * The status dot is the only live element: it takes the accent of the agent that
 * owns the tab, so the rail doubles as a legend for the colours used in the plan
 * and the thought stream.
 */

import { useState, type ReactNode } from "react";
import { ConcarettiLogo } from "./ui";

const SW = 1.8;

/**
 * Glyphs, keyed by tab. Kept here rather than passed in by each screen because
 * the shape belongs to the destination, not to whoever links to it.
 */
const ICONS: Record<string, ReactNode> = {
  ops: <path d="M12 3.2 19 7.3v8.4L12 19.8 5 15.7V7.3z" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8.5 3v4M15.5 3v4" />
    </>
  ),
  email: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="m3.8 7.2 7.3 5.4a1.5 1.5 0 0 0 1.8 0l7.3-5.4" />
    </>
  ),
  telecom: (
    <path d="M20.5 11.7A8.4 8.4 0 0 1 12 20a8.6 8.6 0 0 1-3.8-.9L3.5 20.5l1.4-4.7A8.4 8.4 0 0 1 12 3.5a8.4 8.4 0 0 1 8.5 8.2z" />
  ),
  browser: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z" />
    </>
  ),
  shopper: (
    <>
      <path d="M4.5 8h15l-1.2 11.2a1.5 1.5 0 0 1-1.5 1.3H7.2a1.5 1.5 0 0 1-1.5-1.3z" />
      <path d="M8.8 8V6.3a3.2 3.2 0 0 1 6.4 0V8" />
    </>
  ),
  market: <path d="M4 18.5V9M9.3 18.5V5M14.7 18.5v-6.2M20 18.5V7.5" />,
  chain: (
    <>
      <path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1 1" />
      <path d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1-1" />
    </>
  ),
  diary: (
    <>
      <path d="M6 3.5h9.5L19.5 7v13.5H6z" />
      <path d="M9 11h7.5M9 14.5h7.5M9 7.8h3.5" />
    </>
  ),
  policy: (
    <path d="M12 3.3 19.3 6v6c0 4-3 7.2-7.3 8.7-4.3-1.5-7.3-4.7-7.3-8.7V6z" />
  ),
  setup: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.8v2.4M12 18.8v2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M2.8 12h2.4M18.8 12h2.4M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.6V12l3 2" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </>
  ),
};

function Icon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={SW}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name] ?? ICONS.ops}
    </svg>
  );
}

export type RailItem<T extends string> = {
  key: T;
  label: string;
  /** Drives the status dot's colour, via `--color-agent-<agent>`. */
  agent?: string;
  /** Below the MORE rule rather than in the primary group. */
  secondary?: boolean;
  /** Pinned to the bottom, under the divider — configuration, not a workspace. */
  footer?: boolean;
};

function Item<T extends string>({
  item,
  active,
  collapsed,
  onSelect,
}: {
  item: RailItem<T>;
  active: boolean;
  collapsed: boolean;
  onSelect: (key: T) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={collapsed ? item.label : undefined}
      onClick={() => onSelect(item.key)}
      className={`flex w-full items-center gap-3 rounded-full py-2 text-left
        text-[14px] transition-colors ${collapsed ? "justify-center px-0" : "px-3"} ${
          active
            ? "text-fg"
            : "text-dim hover:bg-elevated hover:text-fg"
        }`}
      style={
        active
          ? {
              background: item.agent
                ? `var(--color-agent-${item.agent}, var(--color-council-soft))`
                : "var(--color-council-soft)",
            }
          : undefined
      }
    >
      <Icon name={item.key} />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.agent && !active && (
            <span
              aria-hidden
              className="size-[5px] shrink-0 rounded-full"
              style={{
                background: `var(--color-agent-${item.agent}, var(--color-council-soft))`,
              }}
            />
          )}
        </>
      )}
    </button>
  );
}

/** Small uppercase group label — the rail's only typography that isn't a link. */
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="type-mono px-3 pb-1 pt-4 text-[10px] text-muted">
      {children}
    </p>
  );
}

/**
 * A labelled region in the rail, with an optional action on the right.
 *
 * Exists so a screen can hang its own list off the rail — sessions, in practice —
 * without the rail knowing what a session is. The label takes an icon because the
 * reference pairs one with `SESSIONS` and the eye needs something to anchor on at
 * 10px; the action is the `+` beside it.
 */
export function RailGroup({
  label,
  icon,
  action,
  children,
}: {
  label: string;
  icon?: string;
  action?: { title: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <section className="pt-5">
      <header className="flex items-center justify-between gap-2 px-3 pb-1.5">
        <span className="type-mono flex items-center gap-1.5 text-[10px] text-muted">
          {icon && <Icon name={icon} />}
          {label}
        </span>
        {action && (
          <button
            type="button"
            title={action.title}
            aria-label={action.title}
            onClick={action.onClick}
            className="grid size-5 place-items-center rounded-full text-[15px]
              leading-none text-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            +
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

export function Sidebar<T extends string>({
  items,
  active,
  onSelect,
  middle,
  footer,
}: {
  items: ReadonlyArray<RailItem<T>>;
  active: T;
  onSelect: (key: T) => void;
  /** A screen-supplied region under MORE — the sessions list. */
  middle?: ReactNode;
  /** Live readouts pinned under the nav — role, provider count, connection. */
  footer?: ReactNode;
}) {
  // Collapse is local and deliberately not persisted. It is a momentary "give me
  // the width back" on a narrow desktop, not a preference — and a rail that
  // remembers it was hidden is a rail a returning user cannot find.
  const [open, setOpen] = useState(true);

  const primary = items.filter((i) => !i.secondary && !i.footer);
  const more = items.filter((i) => i.secondary);
  const pinned = items.filter((i) => i.footer);

  return (
    <nav
      role="tablist"
      aria-label="Sections"
      className={`relative flex shrink-0 flex-col gap-1 pb-4
        lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto
        ${open ? "w-[236px] px-3" : "w-[68px] px-2"}`}
      style={{ borderRight: "var(--border)" }}
    >
      {/* Header with Logo and Sidebar Toggle Icon */}
      {open ? (
        <div className="sticky top-0 z-10 bg-void pt-5 pb-3 mb-6 flex items-center justify-between px-2">
          <span className="flex items-center gap-2.5">
            <ConcarettiLogo />
            <span className="flex flex-col leading-none">
              <span className="type-display text-[17px]">Concaretti</span>
              <span className="type-mono text-[9px] text-muted">
                multi-agent os
              </span>
            </span>
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Retract sidebar"
            aria-label="Retract sidebar"
            className="grid size-7 place-items-center rounded-lg text-dim transition-colors hover:bg-elevated hover:text-fg"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
              <path d="m14 9-3 3 3 3" />
            </svg>
          </button>
        </div>
      ) : (
        <div className="sticky top-0 z-10 bg-void pt-5 pb-3 mb-6 flex justify-center">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            className="group grid size-9 place-items-center rounded-lg transition-colors hover:bg-elevated"
          >
            <ConcarettiLogo />
          </button>
        </div>
      )}

      {primary.map((i) => (
        <Item
          key={i.key}
          item={i}
          active={i.key === active}
          collapsed={!open}
          onSelect={onSelect}
        />
      ))}

      {more.length > 0 && (
        <>
          {open ? <GroupLabel>More</GroupLabel> : <div className="h-3" />}
          {more.map((i) => (
            <Item
              key={i.key}
              item={i}
              active={i.key === active}
              collapsed={!open}
              onSelect={onSelect}
            />
          ))}
        </>
      )}

      {open && middle}

      {/* Everything above scrolls; configuration and status sit at the bottom. */}
      <div className="min-h-6 flex-1" />

      {pinned.length > 0 && (
        <div
          className="mt-4 flex flex-col gap-1 pt-3"
          style={{ borderTop: "var(--border)" }}
        >
          {pinned.map((i) => (
            <Item
              key={i.key}
              item={i}
              active={i.key === active}
              collapsed={!open}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {footer && open && <div className="px-3 pt-3">{footer}</div>}
    </nav>
  );
}
