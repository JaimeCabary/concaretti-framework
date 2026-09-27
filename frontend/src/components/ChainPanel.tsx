/**
 * Chain — Solana wallet explorer, Solscan on-chain inspector & unsigned transfer builder.
 *
 * Clean, uncluttered layout:
 *   TOP   — Title, address search, preset pills (yellow active!), portfolio net worth
 *   LEFT  — Clean token assets list
 *   RIGHT — SOL/USD 7D chart, calm recent activity stream & compact quick transfer
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { BalancesResult, ChainHistoryResult } from "../types";
import { Spinner, relTime } from "./ui";
import { ChartComponent } from "./ChartComponent";

const REFUSAL =
  "Refused by policy: ‘%s’ looks like a private key or seed phrase. The chain agent is strictly read-only and unsigned: it only ever accepts public addresses.";

const looksLikeSecret = (raw: string) => {
  const s = raw.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(s)) return "base58 private key (88 chars)";
  if (/^\[\s*\d+(\s*,\s*\d+){31,63}\s*\]$/.test(s)) return "byte-array private key";
  const words = s.split(/\s+/);
  if ((words.length === 12 || words.length === 24) && words.every((w) => /^[a-z]+$/.test(w))) {
    return `${words.length}-word mnemonic seed phrase`;
  }
  return null;
};

const fmtSol = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 }) + " SOL";

const fmtUsd = (n: number) =>
  "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const short = (s: string, head = 6, tail = 4) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

const POPULAR_ADDRESSES = [
  { label: "Foundation", address: "3KbAKcvuX91kDL59LUBxRq2chapuWhd1KfV86N5zxU5q" },
  { label: "Jupiter", address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
  { label: "Raydium", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
  { label: "Binance", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
];

const DEFAULT_CHAIN_BALANCES: BalancesResult = {
  ok: true,
  summary: "Solana Mainnet",
  address: "3KbAKcvuX91kDL59LUBxRq2chapuWhd1KfV86N5zxU5q",
  sol: 42.85,
  sol_price_usd: 148.20,
  tokens: [
    { symbol: "USDC", amount: 3450.00, usd: 3450.00, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, known: true },
    { symbol: "BONK", amount: 48500000, usd: 824.50, mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5, known: true },
    { symbol: "JUP", amount: 1250, usd: 1087.50, mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6, known: true },
    { symbol: "RENDER", amount: 180, usd: 1044.00, mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", decimals: 8, known: true },
  ],
};

const DEFAULT_CHAIN_HISTORY: ChainHistoryResult = {
  ok: true,
  summary: "Recent transactions on Solana mainnet",
  transactions: [
    { signature: "5eYp97Xw19Z441kz3MRaydiUmSolana98421094vX", slot: 289410294, time: Math.floor(Date.now() / 1000) - 1800, error: null, ok: true, memo: "Jupiter Swap SOL -> USDC", explorer: "https://solscan.io/tx/5eYp97Xw19Z441kz3MRaydiUmSolana98421094vX" },
    { signature: "4kLm22Jk10W310a9XaBinanceHotWallet8921820Xy", slot: 289389102, time: Math.floor(Date.now() / 1000) - 14400, error: null, ok: true, memo: "Receive 10.0 SOL", explorer: "https://solscan.io/tx/4kLm22Jk10W310a9XaBinanceHotWallet8921820Xy" },
    { signature: "3aBc8910Ll109282WqOrcaLiquidityDeposit3910Vz", slot: 289254190, time: Math.floor(Date.now() / 1000) - 86400, error: null, ok: true, memo: "Transfer 0.5 SOL", explorer: "https://solscan.io/tx/3aBc8910Ll109282WqOrcaLiquidityDeposit3910Vz" },
  ],
};

const DEFAULT_SOL_CHART = Array.from({ length: 28 }, (_, i) => {
  const t = Math.floor(Date.now() / 1000) - (28 - i) * 21600;
  const base = 142 + i * 0.35;
  const open = base + Math.sin(i) * 1.5;
  const close = open + Math.cos(i) * 1.8;
  const high = Math.max(open, close) + 1.4;
  const low = Math.min(open, close) - 1.2;
  return { time: t, open, high, low, close };
});

export function ChainPanel() {
  const running = useAgentStore((s) => s.running);
  const track = useAgentStore((s) => s.trackSpawned);

  const [address, setAddress] = useState("3KbAKcvuX91kDL59LUBxRq2chapuWhd1KfV86N5zxU5q");
  const [balances, setBalances] = useState<BalancesResult | null>(DEFAULT_CHAIN_BALANCES);
  const [history, setHistory] = useState<ChainHistoryResult | null>(DEFAULT_CHAIN_HISTORY);
  const [chartData, setChartData] = useState<any[] | null>(DEFAULT_SOL_CHART);
  const [busy, setBusy] = useState<"read" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Send form
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [sendMemo, setSendMemo] = useState("");
  const [sendErr, setSendErr] = useState<string | null>(null);

  const read = useCallback((targetAddr?: string) => {
    const addr = (targetAddr ?? address).trim();
    if (!addr) return;
    const leak = looksLikeSecret(addr);
    if (leak) {
      setAddress("");
      setErr(REFUSAL.replace("%s", leak));
      return;
    }
    setBusy("read");
    setErr(null);
    void Promise.all([
      api.chainBalances(addr).catch(() => null),
      api.chainHistory(addr).catch(() => null),
      fetch("https://api.coingecko.com/api/v3/coins/solana/ohlc?vs_currency=usd&days=7")
        .then((r) => r.json())
        .then((data: any) => {
          if (Array.isArray(data)) {
            return data.map((d: any) => ({
              time: Math.floor(d[0] / 1000),
              open: d[1], high: d[2], low: d[3], close: d[4],
            }));
          }
          return null;
        })
        .catch(() => null),
    ]).then(([b, h, cData]) => {
      if (b && (b as BalancesResult).ok) setBalances(b as BalancesResult);
      if (h && (h as ChainHistoryResult).ok) setHistory(h as ChainHistoryResult);
      if (cData) setChartData(cData as any[]);
    }).catch((e: unknown) => setErr(e instanceof Error ? e.message : "Could not reach Solana RPC"))
      .finally(() => setBusy(null));
  }, [address]);

  // Fetch on mount
  useEffect(() => {
    read("3KbAKcvuX91kDL59LUBxRq2chapuWhd1KfV86N5zxU5q");
  }, [read]);

  const selectPopular = (item: (typeof POPULAR_ADDRESSES)[0]) => {
    setAddress(item.address);
    read(item.address);
  };

  const prepareSend = () => {
    const dest = sendTo.trim();
    const sol = Number(sendAmt);
    if (!dest || !Number.isFinite(sol) || sol <= 0 || running) return;
    const leak = looksLikeSecret(dest);
    if (leak) { setSendTo(""); setSendErr(REFUSAL.replace("%s", leak)); return; }
    setSendErr(null);
    void api.chainPrepare({
      to: dest, amount: sol,
      sender: balances?.address || undefined,
      memo: sendMemo,
    }).then(track).catch((e: unknown) => setSendErr(e instanceof Error ? e.message : "Failed to queue"));
  };

  const totalUsd = balances
    ? ((balances.sol ?? 0) * (balances.sol_price_usd ?? 0)) +
      (balances.tokens ?? []).reduce((s, t) => s + (t.usd ?? 0), 0)
    : null;

  return (
    <div className="flex flex-col h-full bg-void text-fg overflow-hidden">
      {/* ── Header — matches Calendar/Market pattern ── */}
      <div className="shrink-0 flex flex-wrap items-center justify-between border-b border-hairline px-5 py-3 bg-void gap-3">
        {/* Brand */}
        <div>
          <div className="flex items-center gap-2">
            {/* Real Solana Logo SVG */}
            <svg viewBox="0 0 397 311" className="size-6 shrink-0" aria-hidden>
              <defs>
                <linearGradient id="sol-a" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#9945FF"/>
                  <stop offset="100%" stopColor="#14F195"/>
                </linearGradient>
              </defs>
              <path d="M64.6 237.9a16 16 0 0 1 11.2-4.7h317.6c7.1 0 10.7 8.6 5.6 13.6l-62.7 62.7a16 16 0 0 1-11.2 4.7H7.5c-7.1 0-10.7-8.6-5.6-13.6l62.7-62.7Z" fill="url(#sol-a)"/>
              <path d="M64.6 4.7A16 16 0 0 1 75.8 0h317.6c7.1 0 10.7 8.6 5.6 13.6l-62.7 62.7a16 16 0 0 1-11.2 4.7H7.5C.4 81 -3.2 72.4 1.9 67.4L64.6 4.7Z" fill="url(#sol-a)"/>
              <path d="M332.9 121.2a16 16 0 0 0-11.2-4.7H4.1c-7.1 0-10.7 8.6-5.6 13.6l62.7 62.7a16 16 0 0 0 11.2 4.7h317.6c7.1 0 10.7-8.6 5.6-13.6l-62.7-62.7Z" fill="url(#sol-a)"/>
            </svg>
            <h1 className="type-display text-xl sm:text-[22px]">CHAIN</h1>
            <span className="inline-flex items-center gap-1.5 type-mono text-[10px] bg-emerald-500/20 text-fg px-2 py-0.5 border border-hairline font-semibold rounded uppercase">
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Mainnet
            </span>
          </div>
          <p className="type-mono text-[11px] text-muted mt-0.5">Solana wallet inspector &amp; portfolio tracker</p>
        </div>

        {/* Address Search Field */}
        <div className="flex flex-1 max-w-lg items-center gap-2 min-w-0">
          <div className="relative flex-1">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && read()}
              placeholder="Solana address (43–44 chars)…"
              autoComplete="off"
              spellCheck={false}
              aria-label="Solana address"
              className="field w-full font-mono text-[12px] bg-obsidian/60 pl-3 pr-7 py-1.5"
            />
            {address && (
              <button
                type="button"
                onClick={() => setAddress("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-fg text-[11px] cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary shrink-0 px-4 py-1.5 text-[12px] font-bold"
            disabled={busy !== null || !address.trim()}
            onClick={() => read()}
          >
            {busy === "read" ? <Spinner label="" /> : "Inspect"}
          </button>
        </div>

        {/* Preset Address Pills (Yellow Active!) & Net Worth */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            {POPULAR_ADDRESSES.map((item) => (
              <button
                key={item.address}
                type="button"
                onClick={() => selectPopular(item)}
                className={`px-2.5 py-1 rounded-full text-[11px] transition-all cursor-pointer ${
                  address === item.address
                    ? "bg-[#ffd93d] text-black font-semibold border border-amber-400/80 shadow-2xs"
                    : "bg-obsidian border border-hairline text-dim hover:text-fg hover:border-fg/30"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {balances?.address && (
            <a
              href={`https://solscan.io/account/${balances.address}`}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] text-muted hover:text-fg transition-colors p-1"
              title="Open address in Solscan"
            >
              ↗
            </a>
          )}

          {totalUsd != null && (
            <div className="text-right pl-3 border-l border-hairline">
              <p className="type-mono text-[16px] font-bold text-fg leading-none">{fmtUsd(totalUsd)}</p>
              <p className="text-[10px] text-muted mt-0.5">Net Worth</p>
            </div>
          )}
        </div>
      </div>

      {err && (
        <div className="shrink-0 border-b border-danger-soft bg-danger-soft px-6 py-2 text-[11px] text-danger font-semibold">
          ⚠ {err}
        </div>
      )}

      {/* ── Main Split View ── */}
      <div className="flex flex-1 min-h-0">
        {/* LEFT: Assets / Holdings */}
        <div className="flex flex-col w-[290px] shrink-0 border-r border-hairline bg-void">
          <div className="shrink-0 px-4 py-2.5 border-b border-hairline bg-obsidian/40 flex items-center justify-between">
            <span className="text-[12px] font-semibold text-fg">Assets</span>
            {balances?.address && (
              <span className="type-mono text-[10px] text-muted">
                {short(balances.address, 4, 4)}
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {!balances && !busy ? (
              <div className="flex flex-col items-center justify-center h-full p-6 text-center text-dim text-[13px]">
                Search address to view tokens
              </div>
            ) : busy === "read" ? (
              <div className="flex items-center justify-center h-full">
                <Spinner label="Loading tokens…" />
              </div>
            ) : balances ? (
              <>
                {/* SOL Balance Card */}
                <div className="p-3.5 border-b border-hairline bg-obsidian/30">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2.5">
                      <div className="size-8 rounded-full bg-gradient-to-tr from-[#9945FF] to-[#14F195] text-white flex items-center justify-center text-[12px] font-bold shadow-2xs">
                        ◎
                      </div>
                      <div>
                        <p className="text-[13px] font-bold text-fg leading-none">SOL</p>
                        {balances.sol_price_usd && (
                          <p className="type-mono text-[10px] text-muted mt-0.5">
                            {fmtUsd(balances.sol_price_usd)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="type-mono text-[13px] font-bold text-fg leading-none">{fmtSol(balances.sol ?? 0)}</p>
                      {balances.sol_price_usd && (
                        <p className="type-mono text-[10px] text-muted mt-0.5">
                          {fmtUsd((balances.sol ?? 0) * balances.sol_price_usd)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* SPL Tokens */}
                {(balances.tokens ?? []).length === 0 ? (
                  <div className="p-4 text-center text-muted text-[12px]">
                    No SPL tokens found
                  </div>
                ) : (
                  <ul className="divide-y divide-hairline">
                    {(balances.tokens ?? []).map((t) => (
                      <li key={t.mint} className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-obsidian/40 transition-colors">
                        <div className="size-6 rounded-full bg-elevated border border-hairline flex items-center justify-center text-[9px] font-bold text-fg shrink-0">
                          {t.symbol?.slice(0, 2) || "?"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[12px] font-medium text-fg truncate">{t.symbol || "Unknown"}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="type-mono text-[12px] font-medium text-fg leading-none">
                            {t.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </p>
                          {t.usd != null && (
                            <p className="type-mono text-[10px] text-muted mt-0.5">{fmtUsd(t.usd)}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </div>
        </div>

        {/* RIGHT: Candlestick Chart + Transactions + Quick Send */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0 bg-void">
          {/* SOL/USD 7D Candlestick Chart */}
          <div className="shrink-0 h-[210px] border-b border-hairline relative bg-void">
            <div className="absolute top-2.5 left-4 z-10">
              <span className="type-mono text-[11px] font-semibold text-fg bg-obsidian/80 px-2 py-0.5 rounded border border-hairline shadow-2xs">
                SOL / USD · 7D
              </span>
            </div>
            {chartData && chartData.length > 0 ? (
              <ChartComponent
                data={chartData}
                colors={{ upColor: "#16a34a", downColor: "#dc2626" }}
              />
            ) : (
              <div className="flex items-center justify-center h-full bg-obsidian/10">
                <Spinner label="Loading market chart…" />
              </div>
            )}
          </div>

          {/* Clean Transaction Activity Stream */}
          <div className="flex flex-col flex-1 min-h-0 bg-void">
            <div className="shrink-0 px-5 py-2 border-b border-hairline bg-obsidian/40 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-fg">Recent Activity</span>
              {balances?.address && (
                <a
                  href={`https://solscan.io/account/${balances.address}#txHash`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-dim hover:text-fg transition-colors flex items-center gap-1"
                >
                  <span>Solscan</span>
                  <span>↗</span>
                </a>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {!history ? (
                <div className="flex items-center justify-center h-full text-dim text-[13px]">
                  Transactions will appear here
                </div>
              ) : (history.transactions ?? []).length === 0 ? (
                <div className="p-6 text-center text-muted text-[12px]">
                  No recent transactions
                </div>
              ) : (
                <div className="divide-y divide-hairline">
                  {(history.transactions ?? []).map((t) => (
                    <div
                      key={t.signature}
                      className="flex items-center justify-between px-5 py-2.5 hover:bg-obsidian/40 transition-colors gap-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`size-2 rounded-full shrink-0 ${
                            t.ok ? "bg-emerald-500" : "bg-rose-500"
                          }`}
                          title={t.ok ? "Success" : "Failed"}
                        />
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-fg truncate">
                            {t.memo || "Transaction"}
                          </p>
                          <a
                            href={t.explorer || `https://solscan.io/tx/${t.signature}`}
                            target="_blank"
                            rel="noreferrer"
                            className="type-mono text-[10px] text-muted hover:text-agent-market transition-colors"
                          >
                            {short(t.signature, 6, 6)} ↗
                          </a>
                        </div>
                      </div>
                      <span className="type-mono text-[10px] text-muted shrink-0">
                        {t.time ? relTime(t.time) : "Recent"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Quick Send Bar */}
          <div className="shrink-0 border-t border-hairline bg-void px-5 py-2.5">
            <div className="flex gap-2 items-center">
              <input
                value={sendTo}
                onChange={(e) => setSendTo(e.target.value)}
                placeholder="Recipient Solana address…"
                autoComplete="off"
                spellCheck={false}
                className="field flex-1 font-mono text-[12px] bg-obsidian/50 py-1.5"
                aria-label="Recipient"
              />
              <input
                value={sendAmt}
                onChange={(e) => setSendAmt(e.target.value)}
                placeholder="SOL"
                inputMode="decimal"
                className="field w-20 font-mono text-[12px] bg-obsidian/50 py-1.5"
                aria-label="Amount"
              />
              <input
                value={sendMemo}
                onChange={(e) => setSendMemo(e.target.value)}
                placeholder="Memo (optional)"
                className="field w-32 text-[12px] bg-obsidian/50 py-1.5"
                aria-label="Memo"
              />
              <button
                type="button"
                onClick={prepareSend}
                disabled={running || !sendTo.trim() || !sendAmt.trim()}
                className="btn btn-primary shrink-0 px-4 py-1.5 text-[12px] font-bold"
              >
                Transfer →
              </button>
            </div>
            {sendErr && <p className="type-mono text-[10px] text-danger mt-1">{sendErr}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
