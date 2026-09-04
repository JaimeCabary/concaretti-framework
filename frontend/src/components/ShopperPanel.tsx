/**
 * The shopper — search, compare under a combined budget, buy, then watch.
 *
 * Laid out in the order the errand actually runs, because that ordering *is* the
 * feature: an errand like "I have $200, buy me the best affordable keyboard and
 * phone stand and see it through to delivery" is four different actions with four
 * different risk levels, and flattening them into one button would hide that.
 *
 *   Errand   — the whole chain, orchestrated. Spawns a run and returns.
 *   Search   — direct, because it is a read. Prices one item across merchants.
 *   Buy      — orchestrated, always. `shop_checkout` is a HALO trigger.
 *   Orders   — what was bought and where it is. Re-readable on demand.
 *   Card     — hidden unless the policy already permits an autonomous payment.
 *
 * The budget is typed as text and sent as text. The backend reads "$200 or 400k
 * naira", takes the lower of the two, and says how it read it — a second parser
 * here would be a second thing to keep in step with the first.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { OrdersResponse, ShopCandidate, ShopSearchResult } from "../types";
import { Chip, Empty, Spinner, relTime } from "./ui";

/** Terminal states get a flat chip; anything else is still in motion. */
const DONE = new Set(["delivered", "cancelled", "failed"]);

const money = (amount: number, currency: string) =>
  `${currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function ShopperPanel() {
  const running = useAgentStore((s) => s.running);
  const track = useAgentStore((s) => s.trackSpawned);
  const role = useAgentStore((s) => s.role);

  const [orders, setOrders] = useState<OrdersResponse | null>(null);
  const [found, setFound] = useState<ShopSearchResult | null>(null);
  const [busy, setBusy] = useState<"search" | "errand" | "track" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [items, setItems] = useState("");
  const [budget, setBudget] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    void api
      .shopperOrders()
      .then(setOrders)
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Could not read orders"),
      );
  }, []);

  useEffect(load, [load]);

  const search = () => {
    if (!query.trim() || busy) return;
    setBusy("search");
    setErr(null);
    void api
      .shopSearch({ query: query.trim(), budget: budget.trim() })
      .then(setFound)
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Search failed"),
      )
      .finally(() => setBusy(null));
  };

  const errand = () => {
    const list = items
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length || busy || running) return;
    setBusy("errand");
    setErr(null);
    void api
      .shopErrand({ items: list, budget: budget.trim() })
      .then(track)
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Could not start the errand"),
      )
      .finally(() => setBusy(null));
  };

  const buy = (c: ShopCandidate) => {
    if (running) return;
    setErr(null);
    void api
      .shopCheckout({
        url: c.url,
        item: c.title,
        total: c.price_converted ?? c.price,
        currency: c.price_in ?? c.currency,
      })
      .then(track)
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Could not queue the checkout"),
      );
  };

  const retrack = (id?: string) => {
    if (busy) return;
    setBusy("track");
    setErr(null);
    void api
      .shopTrack(id)
      .then((r) => {
        if (!r.ok) setErr(r.summary);
        load();
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Could not re-read"),
      )
      .finally(() => setBusy(null));
  };

  const mode = orders?.checkout_mode ?? "handoff";
  const canSpend = orders?.can_spend ?? false;

  const openOrdersCount =
    orders?.orders.filter((o) => !DONE.has(o.status)).length ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="type-tagline text-[16px] text-dim mb-1">
            Agent managed
          </p>
          <h1 className="type-display text-[40px] leading-[0.9]">
            SHOPPER AGENT
          </h1>
          <p className="type-mono mt-3 text-[10px] tracking-widest text-muted">
            BUDGET, CART & TRACKING
          </p>
        </div>
        <button
          onClick={load}
          className="btn bg-obsidian border border-hairline shadow-none hover:bg-elevated transition-colors"
          style={{ borderRadius: "var(--radius)" }}
        >
          <span className="type-mono text-[12px] flex items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Refresh
          </span>
        </button>
      </div>

      {/* Metrics Pills */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div
          className="panel panel-quiet bg-agent-shopper p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2">CHECKOUT MODE</p>
          <p className="type-display text-[24px] text-fg truncate">
            {mode.toUpperCase()}
          </p>
        </div>
        <div
          className="panel panel-quiet bg-obsidian border-hairline p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-muted mb-2">OPEN ORDERS</p>
          <p className="type-display text-[32px] text-fg">{openOrdersCount}</p>
        </div>
        <div
          className="panel panel-quiet bg-obsidian border-hairline p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-muted mb-2">
            SPEND PERMITTED
          </p>
          <p className="type-display text-[32px] text-fg">
            {canSpend ? "YES" : "NO"}
          </p>
        </div>
      </div>

      {err && (
        <p className="inset-flat bg-warn-soft px-3 py-2 text-[12px] text-fg">
          {err}
        </p>
      )}

      {/* ── the whole errand, in one line ── */}
      <div
        className="panel bg-obsidian border-hairline shadow-none p-5"
        style={{ borderRadius: "var(--radius-md)" }}
      >
        <p className="type-mono text-[11px] text-muted mb-4 flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="9" cy="21" r="1" />
            <circle cx="20" cy="21" r="1" />
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
          </svg>
          RUN FULL ERRAND
        </p>
        <div className="space-y-3">
          <label
            className="type-mono block text-[10px] text-muted"
            htmlFor="shop-items"
          >
            Errand — everything at once, under one combined ceiling
          </label>
          <input
            id="shop-items"
            value={items}
            onChange={(e) => setItems(e.target.value)}
            placeholder="keyboard, phone stand"
            className="field w-full text-[13px]"
          />
          <div className="flex gap-2">
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="$200 or 400k naira"
              aria-label="Budget"
              className="field min-w-0 flex-1 text-[13px]"
            />
            <button
              type="button"
              className="btn btn-primary shrink-0 px-3 py-1.5 text-[12px]"
              disabled={busy !== null || running || !items.trim()}
              onClick={errand}
            >
              {busy === "errand" ? "Starting" : "Run errand"}
            </button>
          </div>
          <p className="text-[11px] leading-snug text-dim mt-2">
            Two affordable things are routinely unaffordable together, so the
            comparison is over the <em>total</em>, not per item. Paying stops
            for your approval whatever the mode.
          </p>
        </div>
      </div>

      {/* ── one item, priced now ── */}
      <div
        className="panel bg-void border-hairline shadow-none p-5"
        style={{ borderRadius: "var(--radius-md)" }}
      >
        <p className="type-mono text-[11px] text-muted mb-4 flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          PRICE ONE THING
        </p>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search();
            }}
            placeholder="Price one thing — mechanical keyboard"
            aria-label="Search"
            className="field min-w-0 flex-1 text-[13px]"
          />
          <button
            type="button"
            className="btn shrink-0 px-3 py-1.5 text-[12px]"
            disabled={busy !== null || !query.trim()}
            onClick={search}
          >
            {busy === "search" ? "Pricing" : "Search"}
          </button>
        </div>

        {busy === "search" && !found && (
          <div className="p-4">
            <Spinner label="Reading product pages" />
          </div>
        )}

        {found && (
          <div className="mt-4">
            <p className="px-3 py-2 text-[12px] leading-snug text-dim">
              {found.summary}
            </p>
            <ul className="divide-y divide-hairline border-t border-hairline">
              {(found.candidates ?? []).map((c) => (
                <li key={c.url} className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-fg">
                        {c.title}
                      </p>
                      <p className="type-mono truncate text-[10px] text-muted">
                        {c.merchant}
                        {c.rating ? ` · ${c.rating}★` : ""}
                        {c.reviews
                          ? ` · ${c.reviews.toLocaleString()} reviews`
                          : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[13px] font-semibold text-fg">
                        {money(c.price, c.currency)}
                      </p>
                      {c.price_converted != null &&
                        c.price_in &&
                        c.price_in !== c.currency && (
                          <p className="type-mono text-[10px] text-muted">
                            ≈ {money(c.price_converted, c.price_in)}
                          </p>
                        )}
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    {c.within_budget === false && (
                      <Chip title="Over the ceiling you typed. Shown anyway — knowing the cheapest thing that would work is part of shopping.">
                        over budget
                      </Chip>
                    )}
                    {c.availability.toLowerCase().includes("outofstock") && (
                      <Chip>out of stock</Chip>
                    )}
                    <button
                      type="button"
                      className="chip ml-auto"
                      disabled={running}
                      onClick={() => buy(c)}
                      title="Adds to cart and stops at the payment page. Pauses for your approval first."
                    >
                      Buy — pauses for approval
                    </button>
                  </div>
                </li>
              ))}
              {(found.candidates ?? []).length === 0 && (
                <li>
                  <Empty>
                    No candidate published a readable price. Try a narrower
                    query.
                  </Empty>
                </li>
              )}
            </ul>
          </div>
        )}
      </div>

      {/* ── what was bought, and where it is ── */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <p className="type-mono text-[11px] text-muted flex items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
            ORDERS {orders ? `· ${orders.open.length} OPEN` : ""}
          </p>
          <button
            type="button"
            className="chip ml-auto"
            disabled={busy !== null}
            onClick={() => retrack()}
            title="The scheduler already re-reads open orders every 26 minutes. This does it now."
          >
            {busy === "track" ? "Reading" : "Re-read now"}
          </button>
        </div>

        <div
          className="panel bg-obsidian border-hairline p-0 overflow-hidden"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <ul className="divide-y divide-hairline">
            {(orders?.orders ?? []).map((o) => (
              <li key={o.id} className="px-3 py-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-fg">{o.item}</p>
                    <p className="type-mono truncate text-[10px] text-muted">
                      {o.merchant} ·{" "}
                      {o.last_checked
                        ? `checked ${relTime(o.last_checked)}`
                        : "not read yet"}
                    </p>
                  </div>
                  <Chip
                    title={
                      DONE.has(o.status)
                        ? "Terminal — no longer polled"
                        : "Still watched"
                    }
                  >
                    {o.status}
                  </Chip>
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <span className="type-mono text-[10px] text-dim">
                    {money(o.total, o.currency)}
                  </span>
                  {o.tracking_url && (
                    <a
                      href={o.tracking_url}
                      target="_blank"
                      rel="noreferrer"
                      className="type-mono text-[10px] underline"
                    >
                      tracking
                    </a>
                  )}
                  {!DONE.has(o.status) && (
                    <button
                      type="button"
                      className="type-mono ml-auto text-[10px] underline"
                      disabled={busy !== null}
                      onClick={() => retrack(o.id)}
                    >
                      re-read
                    </button>
                  )}
                </div>
              </li>
            ))}
            {orders && orders.orders.length === 0 && (
              <li className="px-3 py-2">
                <Empty>
                  Nothing ordered yet. An errand fills a cart; the cart becomes
                  an order once checkout runs.
                </Empty>
              </li>
            )}
          </ul>
        </div>
      </div>

      {/*
        Card entry appears only when the policy has already been edited to permit
        an autonomous payment. Rendering it greyed-out the rest of the time would
        advertise a field for a card number on a screen where a card number can
        never be used, which is the wrong thing to teach.
      */}
      {role === "staff" && canSpend && mode === "autonomous" && <CardBar />}
    </div>
  );
}

/**
 * Card details for exactly one checkout.
 *
 * Collapsed, and honest about what happens to the number. It goes to
 * `POST /api/shopper/secret`, which stores it in a module-level dict for 180
 * seconds, hands it out exactly once, and returns brand and last four. It is not
 * logged, not hashed into the audit table, not embedded, and — the part that is
 * easy to get wrong — not screenshotted: `shop_checkout` suppresses the capture
 * for the card-entry step entirely, because a picture of a filled card field is
 * the same leak with an audit trail's credibility.
 *
 * `ref` is a handle the checkout prompt can safely carry. It is meaningless on
 * its own and outlives the details by nothing.
 */
function CardBar() {
  const [open, setOpen] = useState(false);
  const [pan, setPan] = useState("");
  const [exp, setExp] = useState("");
  const [cvc, setCvc] = useState("");
  const [name, setName] = useState("");
  const [postal, setPostal] = useState("");
  const [held, setHeld] = useState<{
    brand: string;
    last4: string;
    ref: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const stash = () => {
    if (!pan.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const ref = `card-${Math.random().toString(36).slice(2, 10)}`;
    void api
      .stashCard({ ref, pan: pan.trim(), exp, cvc, name, postal })
      .then((r) => {
        setHeld({ brand: r.brand, last4: r.last4, ref: r.ref });
        // Cleared from component state the moment the server has it, so the
        // number is not sitting in a React tree waiting for a re-render.
        setPan("");
        setCvc("");
        setExp("");
        setPostal("");
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Card not accepted"),
      )
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <div className="mt-4">
        <button type="button" className="chip" onClick={() => setOpen(true)}>
          Card for one checkout — RAM only, 180 seconds
        </button>
      </div>
    );
  }

  return (
    <div
      className="panel bg-void border-hairline p-5 space-y-4"
      style={{ borderRadius: "var(--radius-md)" }}
    >
      <p className="type-mono text-[11px] text-muted mb-2 flex items-center gap-2">
        <svg
          viewBox="0 0 24 24"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
        </svg>
        AUTONOMOUS PAYMENT CARD
      </p>
      <p className="text-[11px] leading-snug text-dim">
        Held in memory for 180 seconds and readable once. Never written to the
        database, the audit log, the embedding index or a screenshot — the
        capture is suppressed for the card step rather than redacted after the
        fact.
      </p>
      <input
        value={pan}
        onChange={(e) => setPan(e.target.value)}
        placeholder="Card number"
        aria-label="Card number"
        inputMode="numeric"
        autoComplete="off"
        className="field w-full font-mono text-[13px]"
      />
      <div className="flex gap-2">
        <input
          value={exp}
          onChange={(e) => setExp(e.target.value)}
          placeholder="MM/YY"
          aria-label="Expiry"
          autoComplete="off"
          className="field w-24 font-mono text-[13px]"
        />
        <input
          value={cvc}
          onChange={(e) => setCvc(e.target.value)}
          placeholder="CVC"
          aria-label="Security code"
          autoComplete="off"
          className="field w-20 font-mono text-[13px]"
        />
        <input
          value={postal}
          onChange={(e) => setPostal(e.target.value)}
          placeholder="Postal"
          aria-label="Postal code"
          autoComplete="off"
          className="field min-w-0 flex-1 font-mono text-[13px]"
        />
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name on card"
        aria-label="Name on card"
        autoComplete="off"
        className="field w-full text-[13px]"
      />
      {err && <p className="text-[11px] font-semibold text-danger">{err}</p>}
      {held && (
        <p className="text-[11px] font-semibold text-fg">
          Holding {held.brand} •••• {held.last4} as{" "}
          <span className="font-mono">{held.ref}</span> — pass that ref to a
          checkout within three minutes.
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-primary flex-1 py-1.5 text-[12px]"
          disabled={busy || !pan.trim()}
          onClick={stash}
        >
          {busy ? "Checking" : "Hold for one checkout"}
        </button>
        <button
          type="button"
          className="btn py-1.5 text-[12px]"
          onClick={() => {
            setPan("");
            setCvc("");
            setOpen(false);
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
