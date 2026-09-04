/**
 * Chain — Solana, read-only plus unsigned transaction construction.
 *
 * Solana only, by decision. One chain done properly beats two done by analogy: the
 * address format, the decimals, the fee model and the transaction encoding all
 * differ from EVM's, and a panel that half-knows a chain is a panel that
 * confidently shows the wrong balance.
 *
 * Nothing here can move funds. The backend holds no key, has no signing code and
 * makes no submit call — `chain_prepare_tx` returns a Solana Pay URI, an unsigned
 * base64 transaction and the plain fields, and the only thing that can make any of
 * them real is the user's own wallet. It is HALO-gated anyway, because the thing a
 * human needs to check is the *recipient*: a Solana transfer is final, and the
 * moment to catch a wrong address is before a wallet opens.
 *
 * The address field is screened client-side before anything is sent. That check is
 * redundant — `_looks_like_secret` in the tool refuses without logging, and the
 * request model caps `to` at 64 characters, below a secret key's 87 — and it is
 * here precisely because it is redundant: a pasted seed phrase should never reach
 * the network at all, not even to be refused.
 */

import { useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { BalancesResult, ChainHistoryResult, SpawnResult } from "../types";
import { Empty, Spinner, relTime } from "./ui";

/**
 * Does this look like key material rather than an address?
 *
 * Structural, not a wordlist. A 32-byte public key is 43–44 base58 characters with
 * no spaces; a 64-byte secret key is 87–88; a BIP39 phrase is 12–24 lowercase words;
 * a raw key is often pasted as 64 hex characters or a bracketed byte array. Each of
 * those is separable from an address by shape alone, and shipping a BIP39 wordlist
 * to the browser to catch the third case would be 2,048 words of payload to detect
 * something whitespace already reveals.
 */
function looksLikeSecret(text: string): string {
  const t = text.trim();
  if (/\s/.test(t) && t.split(/\s+/).length >= 11) return "a recovery phrase";
  if (/^\[[\s\d,]+\]$/.test(t)) return "a raw key byte array";
  if (/^[0-9a-fA-F]{64}$/.test(t)) return "a 64-character hex key";
  if (/^[1-9A-HJ-NP-Za-km-z]{80,}$/.test(t)) return "a base58 secret key";
  return "";
}

const REFUSAL =
  "That looks like %s, so it was not sent anywhere — not to this app, not to an " +
  "RPC node, not to a log. Paste a public address instead: 43 or 44 characters, " +
  "no spaces. Nothing here ever needs a key.";

const short = (s: string, head = 6, tail = 4) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

export function ChainPanel() {
  const running = useAgentStore((s) => s.running);
  const track = useAgentStore((s) => s.trackSpawned);

  const [address, setAddress] = useState("");
  const [balances, setBalances] = useState<BalancesResult | null>(null);
  const [history, setHistory] = useState<ChainHistoryResult | null>(null);
  const [busy, setBusy] = useState<"read" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const read = () => {
    const addr = address.trim();
    if (!addr || busy) return;

    const leak = looksLikeSecret(addr);
    if (leak) {
      // Cleared as well as refused. Leaving it in the input would keep it in a
      // React tree and one paste away from being re-submitted.
      setAddress("");
      setErr(REFUSAL.replace("%s", leak));
      return;
    }

    setBusy("read");
    setErr(null);
    void Promise.all([api.chainBalances(addr), api.chainHistory(addr)])
      .then(([b, h]) => {
        setBalances(b);
        setHistory(h);
        if (!b.ok) setErr(b.summary);
      })
      .catch((e: unknown) =>
        setErr(
          e instanceof Error ? e.message : "Could not reach the Solana RPC",
        ),
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
            CHAIN AGENT
          </h1>
          <p className="type-mono mt-3 text-[10px] tracking-widest text-muted">
            SOLANA NETWORK · READ-ONLY
          </p>
        </div>
        <button
          onClick={read}
          disabled={!address.trim() || busy !== null}
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
          className="panel panel-quiet bg-agent-chain p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2">
            TOTAL VALUE (USD)
          </p>
          <p className="type-display text-[32px] text-fg truncate">
            {balances?.usd_total != null
              ? `$${balances.usd_total.toLocaleString()}`
              : "—"}
          </p>
        </div>
        <div
          className="panel panel-quiet bg-obsidian border-hairline p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-muted mb-2">TOKENS HELD</p>
          <p className="type-display text-[32px] text-fg">
            {balances ? (balances.tokens?.length ?? 0) : "—"}
          </p>
        </div>
      </div>

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
          QUERY ADDRESS
        </p>
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") read();
              }}
              placeholder="Public address"
              aria-label="Solana address"
              autoComplete="off"
              spellCheck={false}
              className="field min-w-0 flex-1 font-mono text-[12px] bg-void border-hairline shadow-none"
            />
            <button
              type="button"
              className="btn bg-agent-chain text-fg border-none shadow-none hover:bg-agent-chain shrink-0 px-6 font-semibold"
              disabled={busy !== null || !address.trim()}
              onClick={read}
            >
              {busy === "read" ? "READING" : "READ"}
            </button>
          </div>
          <p className="text-[11px] leading-snug text-dim">
            A public address, never a key. Anything shaped like a seed phrase or
            a secret key is refused in this field before a request is made.
          </p>
        </div>
      </div>

      {err && (
        <p className="border-b-2 border-fg bg-danger-soft px-3 py-2 text-[12px] leading-snug text-fg">
          {err}
        </p>
      )}

      {busy === "read" && !balances ? (
        <div className="p-4">
          <Spinner label="Reading mainnet" />
        </div>
      ) : !balances ? (
        <Empty>
          Balances, recent signatures, and an unsigned transfer you sign
          yourself.
        </Empty>
      ) : (
        <div className="space-y-6">
          <div
            className="panel bg-obsidian border-hairline p-0 overflow-hidden"
            style={{ borderRadius: "var(--radius-md)" }}
          >
            <div className="border-b border-hairline px-4 py-3 bg-elevated/50">
              <div className="flex items-baseline gap-2">
                <span className="type-mono min-w-0 flex-1 truncate text-[11px] text-muted">
                  {balances.address}
                </span>
              </div>
            </div>

            <ul className="divide-y divide-hairline">
              <li className="flex items-baseline gap-2 px-3 py-2">
                <span className="type-mono shrink-0 text-[12px] font-semibold text-fg">
                  SOL
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
                  {balances.sol_price_usd
                    ? `$${balances.sol_price_usd.toLocaleString()} each`
                    : "no price available"}
                </span>
                <span className="type-mono shrink-0 text-[13px] text-fg">
                  {(balances.sol ?? 0).toLocaleString(undefined, {
                    maximumFractionDigits: 6,
                  })}
                </span>
              </li>
              {(balances.tokens ?? []).slice(0, 15).map((t) => (
                <li
                  key={t.mint}
                  className="flex items-baseline gap-2 px-3 py-2"
                >
                  <span className="type-mono shrink-0 text-[12px] font-semibold text-fg">
                    {t.symbol}
                  </span>
                  <span className="type-mono min-w-0 flex-1 truncate text-[10px] text-muted">
                    {t.known ? "" : t.mint}
                  </span>
                  {t.usd != null && (
                    <span className="type-mono shrink-0 text-[10px] text-dim">
                      ${t.usd.toLocaleString()}
                    </span>
                  )}
                  <span className="type-mono shrink-0 text-[13px] text-fg">
                    {t.amount.toLocaleString(undefined, {
                      maximumFractionDigits: 6,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {history?.transactions && history.transactions.length > 0 && (
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
                RECENT SIGNATURES
                {history.failed ? ` · ${history.failed} FAILED` : ""}
              </p>
              <div
                className="panel bg-obsidian border-hairline p-0 overflow-hidden"
                style={{ borderRadius: "var(--radius-md)" }}
              >
                <ul className="max-h-56 divide-y divide-hairline overflow-auto">
                  {history.transactions.map((t) => (
                    <li
                      key={t.signature}
                      className="flex items-baseline gap-2 px-3 py-1.5 text-[11px]"
                    >
                      <span
                        className={`type-mono w-12 shrink-0 uppercase ${
                          t.ok ? "text-dim" : "text-danger"
                        }`}
                        title={t.error ?? undefined}
                      >
                        {t.ok ? "ok" : "failed"}
                      </span>
                      <a
                        href={t.explorer}
                        target="_blank"
                        rel="noreferrer"
                        className="type-mono shrink-0 underline"
                      >
                        {short(t.signature, 8, 6)}
                      </a>
                      <span className="min-w-0 flex-1 truncate text-muted">
                        {t.memo}
                      </span>
                      <span className="type-mono shrink-0 text-muted">
                        {t.time ? relTime(t.time) : "unconfirmed"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      <PrepareBar
        sender={balances?.address ?? ""}
        disabled={running}
        onSpawn={track}
      />
    </div>
  );
}

/**
 * Build a transfer for a wallet to sign.
 *
 * Collapsed behind a deliberate click, like `BrowserPanel`'s interaction bar and
 * for the same reason: the panel should read as a reader first, and the one action
 * here with consequences should not sit one keystroke from the address box.
 *
 * The result does not come back to this component. It arrives on the run stream as
 * the closing summary — the payment URI, the unsigned base64 transaction and the
 * fields in plain text — because the run suspends at the HALO gate in between, and
 * a promise that resolved before the gate was answered would be lying about what
 * had happened.
 */
function PrepareBar({
  sender,
  disabled,
  onSpawn,
}: {
  sender: string;
  disabled: boolean;
  onSpawn: (r: SpawnResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const go = () => {
    const dest = to.trim();
    const sol = Number(amount);
    if (!dest || !Number.isFinite(sol) || sol <= 0 || disabled) return;

    const leak = looksLikeSecret(dest);
    if (leak) {
      setTo("");
      setErr(REFUSAL.replace("%s", leak));
      return;
    }

    setErr(null);
    void api
      .chainPrepare({
        to: dest,
        amount: sol,
        sender: sender || undefined,
        memo,
      })
      .then(onSpawn)
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Could not queue the transfer"),
      );
  };

  if (!open) {
    return (
      <div className="mt-4">
        <button
          type="button"
          className="chip"
          onClick={() => setOpen(true)}
          title="Builds an unsigned transaction. You sign it in your own wallet; this app cannot."
        >
          Prepare a transfer — unsigned, pauses for approval
        </button>
      </div>
    );
  }

  return (
    <div
      className="panel bg-void border-hairline p-5 space-y-4"
      style={{ borderRadius: "var(--radius-md)" }}
    >
      <p className="type-mono text-[11px] text-muted flex items-center gap-2">
        <svg
          viewBox="0 0 24 24"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
        PREPARE TRANSFER
      </p>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="Recipient address"
        aria-label="Recipient"
        autoComplete="off"
        spellCheck={false}
        className="field w-full font-mono text-[12px]"
      />
      <div className="flex gap-2">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="SOL"
          aria-label="Amount in SOL"
          inputMode="decimal"
          className="field w-24 font-mono text-[12px]"
        />
        <input
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="Memo (optional)"
          aria-label="Memo"
          className="field min-w-0 flex-1 text-[12px]"
        />
      </div>
      <p className="text-[11px] leading-snug text-muted">
        {sender
          ? `From ${short(sender)}, the address read above.`
          : "No sender read yet — the transaction will come back as a payment link for whichever wallet you open it in."}{" "}
        Check the recipient against a source you trust: a Solana transfer cannot
        be recalled by anyone, including us.
      </p>
      {err && <p className="text-[11px] font-semibold text-danger">{err}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn bg-agent-chain border-none shadow-none text-fg flex-1 py-2 text-[12px] font-semibold"
          disabled={disabled || !to.trim() || !amount.trim()}
          onClick={go}
        >
          PREPARE — PAUSES FOR APPROVAL
        </button>
        <button
          type="button"
          className="btn bg-transparent border-hairline text-fg py-2 px-6 text-[12px] font-semibold"
          onClick={() => setOpen(false)}
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}
