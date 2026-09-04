/**
 * Market — live quotes, fundamentals, and a paper book that owns no money.
 *
 * The prices are real; the fills are not, and the panel says so in three places
 * rather than one. That redundancy is deliberate: the single most consequential
 * thing this agent could be unclear about is whether an order reached a venue, and
 * a number on a screen cannot carry that distinction by itself. There is no
 * brokerage integration anywhere in the backend to enable.
 *
 * Fills are priced at the live quote rather than at a price typed in here, so a
 * position cannot book a profit by naming its own entry.
 */

import { useCallback, useEffect, useState, useRef } from "react";
import { api } from "../lib/api";
import type {
  FundamentalsResult,
  PortfolioResult,
  QuotesResult,
} from "../types";
import { Empty, Spinner, relTime } from "./ui";

const num = (v: number | null | undefined, digits = 2): string =>
  v == null
    ? "—"
    : Math.abs(v) >= 1_000_000_000
      ? `${(v / 1_000_000_000).toFixed(2)}B`
      : Math.abs(v) >= 1_000_000
        ? `${(v / 1_000_000).toFixed(2)}M`
        : v.toLocaleString(undefined, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          });

const signed = (v: number | null | undefined) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${num(v)}`;

/**
 * Gain green, loss red, flat neutral — the only place colour means direction.
 *
 * `text-ok`, not `text-success`: the theme's token is `--color-ok`, and Tailwind v4
 * silently drops a utility whose token does not exist, so the wrong name here would
 * compile clean and render every P&L figure in the inherited colour.
 */
const tone = (v: number | null | undefined) =>
  v == null || v === 0 ? "text-dim" : v > 0 ? "text-ok" : "text-danger";

export function MarketPanel() {
  const [symbols, setSymbols] = useState("AAPL, MSFT, NVDA, TSLA, BTC-USD, ^GSPC");
  const [quotes, setQuotes] = useState<QuotesResult | null>(null);
  const autoLoaded = useRef(false);
  const [facts, setFacts] = useState<FundamentalsResult | null>(null);
  const [book, setBook] = useState<PortfolioResult | null>(null);
  const [view, setView] = useState<"quotes" | "book">("quotes");
  const [busy, setBusy] = useState<"quotes" | "facts" | "trade" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("1");
  const [tradeSym, setTradeSym] = useState("");

  const loadBook = useCallback(() => {
    void api
      .marketPortfolio()
      .then(setBook)
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Could not read the book"),
      );
  }, []);

  useEffect(loadBook, [loadBook]);

  const price = () => {
    if (!symbols.trim() || busy) return;
    setBusy("quotes");
    setErr(null);
    setFacts(null);
    void api
      .marketQuote(symbols.trim())
      .then((r) => {
        setQuotes(r);
        setView("quotes");
        if (!r.ok) setErr(r.summary);
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Quote failed"),
      )
      .finally(() => setBusy(null));
  };

  useEffect(() => {
    if (!autoLoaded.current && !quotes && symbols) {
      autoLoaded.current = true;
      price();
    }
  }, [quotes, symbols]);

  const dig = (symbol: string) => {
    if (busy) return;
    setBusy("facts");
    setErr(null);
    void api
      .marketFundamentals(symbol)
      .then((r) => {
        setFacts(r);
        if (!r.ok) setErr(r.summary);
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Fundamentals failed"),
      )
      .finally(() => setBusy(null));
  };

  const fill = () => {
    const n = Number(qty);
    if (!tradeSym.trim() || !Number.isFinite(n) || n <= 0 || busy) return;
    setBusy("trade");
    setErr(null);
    void api
      .paperTrade({ symbol: tradeSym.trim().toUpperCase(), side, qty: n })
      .then((r) => {
        if (!r.ok) setErr(r.summary);
        else setTradeSym("");
        loadBook();
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Could not record the fill"),
      )
      .finally(() => setBusy(null));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="type-tagline text-[16px] text-dim mb-1">
            Agent managed
          </p>
          <h1 className="type-display text-[40px] leading-[0.9]">
            MARKET AGENT
          </h1>
          <p className="type-mono mt-3 text-[10px] tracking-widest text-muted">
            QUOTES & PAPER TRADING
          </p>
        </div>
        <button
          onClick={loadBook}
          className="btn bg-obsidian border border-hairline shadow-none hover:bg-elevated transition-colors disabled:opacity-50"
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          className="panel panel-quiet bg-agent-market p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2">POSITIONS</p>
          <p className="type-display text-[32px] text-fg truncate">
            {book ? book.positions.length : "—"}
          </p>
        </div>
        <div
          className="panel panel-quiet bg-obsidian border-hairline p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-muted mb-2">TOTAL RETURN</p>
          <p className="type-display text-[32px] text-fg">
            {book ? signed(book.total ?? book.realized) : "—"}
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        {(["quotes", "book"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`chip ${view === v ? "bg-council-soft" : ""}`}
            aria-pressed={view === v}
          >
            {v === "quotes"
              ? "Quotes"
              : `Book ${book?.positions.length ? `· ${book.positions.length}` : ""}`}
          </button>
        ))}
        {book && (
          <span
            className={`type-mono ml-auto text-[10px] ${tone(book.total ?? book.realized)}`}
            title="Unrealised plus realised, in the quote currency of each position"
          >
            {signed(book.total ?? book.realized)}
          </span>
        )}
      </div>

      {err && (
        <p className="border-b-2 border-fg bg-danger-soft px-3 py-2 text-[12px] leading-snug text-fg">
          {err}
        </p>
      )}

      {view === "quotes" ? (
        <div className="space-y-6">
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
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              {symbols === "AAPL, MSFT, NVDA, TSLA, BTC-USD, ^GSPC" ? "TRENDING ASSETS" : "PRICE SYMBOLS"}
            </p>
            <div className="flex gap-2">
              <input
                value={symbols}
                onChange={(e) => setSymbols(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") price();
                }}
                placeholder="AAPL, BTC-USD, EURUSD=X, ^GSPC"
                aria-label="Symbols"
                className="field min-w-0 flex-1 font-mono text-[12px]"
              />
              <button
                type="button"
                className="btn btn-primary shrink-0 px-3 py-1.5 text-[12px]"
                disabled={busy !== null || !symbols.trim()}
                onClick={price}
              >
                {busy === "quotes" ? "Pricing" : "Price"}
              </button>
            </div>

            {busy === "quotes" && !quotes ? (
              <div className="p-4">
                <Spinner label="Reading the tape" />
              </div>
            ) : !quotes ? (
              <div className="mt-4 border-t border-hairline pt-4">
                <Empty>
                  Up to ten symbols at a time. Yahoo&rsquo;s own suffixes apply
                  —<span className="font-mono"> BTC-USD</span> for crypto,
                  <span className="font-mono"> EURUSD=X</span> for FX,
                  <span className="font-mono"> DANGCEM.LG</span> for Lagos.
                </Empty>
              </div>
            ) : (
              <div className="mt-4 border-t border-hairline">
                <ul className="divide-y divide-hairline">
                  {(quotes.quotes ?? []).map((q) => (
                    <li key={q.symbol} className="px-3 py-2">
                      <div className="flex items-baseline gap-2">
                        <button
                          type="button"
                          className="type-mono shrink-0 text-[12px] font-semibold underline"
                          onClick={() => dig(q.symbol)}
                          title="Read the fundamentals for this symbol"
                        >
                          {q.symbol}
                        </button>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
                          {q.name}
                        </span>
                        <span className="shrink-0 text-[13px] font-semibold text-fg">
                          {q.currency} {num(q.price, q.price < 10 ? 4 : 2)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-3">
                        <span
                          className={`type-mono text-[10px] ${tone(q.change)}`}
                        >
                          {signed(q.change)} ({signed(q.change_pct)}%)
                        </span>
                        <span className="type-mono text-[10px] text-muted">
                          Vol: {num(q.volume)}
                        </span>
                        <button
                          type="button"
                          className="type-mono ml-auto text-[10px] underline"
                          onClick={() => {
                            setTradeSym(q.symbol);
                            setView("book");
                          }}
                        >
                          trade (paper)
                        </button>
                      </div>
                    </li>
                  ))}
                  {(quotes.missing ?? []).length > 0 && (
                    <li className="px-3 py-2 text-[11px] text-muted">
                      Not found: {(quotes.missing ?? []).join(", ")}
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>

          {busy === "facts" && (
            <div className="p-4">
              <Spinner label="Reading fundamentals" />
            </div>
          )}

          {facts?.fundamentals && (
            <div
              className="panel bg-void border-hairline p-5 space-y-4 mt-6"
              style={{ borderRadius: "var(--radius-md)" }}
            >
              <h3 className="type-display text-[13px]">
                {facts.fundamentals.name || facts.fundamentals.symbol}
                {facts.fundamentals.sector
                  ? ` · ${facts.fundamentals.sector}`
                  : ""}
              </h3>
              {facts.partial && (
                <p className="mt-1 text-[11px] leading-snug text-muted">
                  Only quote-level data was available — the fundamentals
                  endpoint is behind a session cookie right now. The blanks
                  below are blank rather than guessed.
                </p>
              )}
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                {(
                  [
                    ["Market cap", facts.fundamentals.market_cap],
                    ["P/E trailing", facts.fundamentals.pe_trailing],
                    ["EPS", facts.fundamentals.eps],
                    ["Revenue", facts.fundamentals.revenue],
                    ["Profit margin", facts.fundamentals.profit_margin],
                    ["Analyst target", facts.fundamentals.target_mean],
                    ["52w high", facts.fundamentals.year_high],
                    ["52w low", facts.fundamentals.year_low],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <dt className="text-muted">{label}</dt>
                    <dd className="type-mono text-fg">{num(value)}</dd>
                  </div>
                ))}
              </dl>
              {facts.fundamentals.summary && (
                <p className="mt-2 text-[12px] leading-relaxed text-dim">
                  {facts.fundamentals.summary}
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── the paper book ── */}
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
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              PAPER TRADE
            </p>
            <div className="flex gap-2">
              <input
                value={tradeSym}
                onChange={(e) => setTradeSym(e.target.value)}
                placeholder="Symbol"
                aria-label="Symbol to trade"
                className="field w-24 font-mono text-[12px]"
              />
              <select
                value={side}
                onChange={(e) => setSide(e.target.value as "buy" | "sell")}
                aria-label="Side"
                className="field w-20 text-[12px]"
              >
                <option value="buy">buy</option>
                <option value="sell">sell</option>
              </select>
              <input
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="Qty"
                aria-label="Quantity"
                inputMode="decimal"
                className="field w-20 font-mono text-[12px]"
              />
              <button
                type="button"
                className="btn btn-primary min-w-0 flex-1 py-1.5 text-[12px]"
                disabled={busy !== null || !tradeSym.trim()}
                onClick={fill}
              >
                {busy === "trade" ? "Filling" : "Fill at market"}
              </button>
            </div>
          </div>

          <div
            className="panel bg-obsidian border-hairline p-0 overflow-hidden"
            style={{ borderRadius: "var(--radius-md)" }}
          >
            {book && book.positions.length > 0 && (
              <div className="border-b border-hairline px-4 py-3 bg-elevated/50">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                  <span className="text-muted">
                    cost{" "}
                    <span className="type-mono text-fg">{num(book.cost)}</span>
                  </span>
                  <span className="text-muted">
                    value{" "}
                    <span className="type-mono text-fg">{num(book.value)}</span>
                  </span>
                  <span className="text-muted">
                    unrealised{" "}
                    <span className={`type-mono ${tone(book.unrealized)}`}>
                      {signed(book.unrealized)}
                    </span>
                  </span>
                  <span className="text-muted">
                    realised{" "}
                    <span className={`type-mono ${tone(book.realized)}`}>
                      {signed(book.realized)}
                    </span>
                  </span>
                </div>
              </div>
            )}

            <ul className="divide-y divide-hairline">
              {(book?.positions ?? []).map((p) => (
                <li
                  key={p.symbol}
                  className="flex items-baseline gap-2 px-3 py-2"
                >
                  <span className="type-mono shrink-0 text-[12px] font-semibold text-fg">
                    {p.symbol}
                  </span>
                  <span className="type-mono min-w-0 flex-1 truncate text-[10px] text-muted">
                    {num(p.qty, p.qty < 1 ? 4 : 0)} @ {num(p.avg_cost)}
                    {p.stale ? " · no live price, held at cost" : ""}
                  </span>
                  <span className="shrink-0 text-[12px] text-fg">
                    {num(p.value)}
                  </span>
                  <span
                    className={`type-mono shrink-0 text-[10px] ${tone(p.unrealized)}`}
                  >
                    {signed(p.unrealized)}
                  </span>
                </li>
              ))}
              {book && book.positions.length === 0 && (
                <li>
                  <Empty>
                    The paper book is empty.
                    {book.realized
                      ? ` Realised to date: ${signed(book.realized)}.`
                      : " Nothing bought yet."}
                  </Empty>
                </li>
              )}
            </ul>
          </div>

          {(book?.fills ?? []).length > 0 && (
            <div>
              <p className="type-mono text-[11px] text-muted mb-3 flex items-center gap-2">
                <svg
                  viewBox="0 0 24 24"
                  className="size-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
                FILLS LEDGER
              </p>
              <div
                className="panel bg-obsidian border-hairline p-0 overflow-hidden"
                style={{ borderRadius: "var(--radius-md)" }}
              >
                <ul className="max-h-48 divide-y divide-hairline overflow-auto">
                  {(book?.fills ?? []).map((f) => (
                    <li
                      key={f.id}
                      className="flex items-baseline gap-2 px-3 py-1.5 text-[11px]"
                    >
                      <span
                        className={`type-mono w-8 shrink-0 uppercase ${
                          f.side === "sell" ? "text-danger" : "text-dim"
                        }`}
                      >
                        {f.side}
                      </span>
                      <span className="type-mono shrink-0 font-semibold text-fg">
                        {f.symbol}
                      </span>
                      <span className="type-mono min-w-0 flex-1 truncate text-muted">
                        {num(f.qty, f.qty < 1 ? 4 : 0)} @ {num(f.price)}
                      </span>
                      {f.realized !== 0 && (
                        <span
                          className={`type-mono shrink-0 ${tone(f.realized)}`}
                        >
                          {signed(f.realized)}
                        </span>
                      )}
                      <span className="type-mono shrink-0 text-muted">
                        {relTime(f.ts)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
