/**
 * Security panel — `.conca` as the authority it is, plus the normalizer dry-run.
 *
 * The simulator is the defence surface. It runs the same `is_safe` path a real
 * tool call takes and spawns no subprocess, so an obfuscated command can be
 * pasted in front of an audience safely — the point being that the normalizer
 * collapses it to the same payload regardless of how it was spelled.
 *
 * Editing is fenced rather than free, and staff-only. The textarea holds the real
 * file text, not a re-serialisation of the parsed policy, because YAML
 * round-tripping would drop the comments that record why each disabled agent is
 * disabled. Validation happens server-side and refuses any policy that would
 * empty the deny-list or the writable roots, so the worst a bad edit can do is
 * be rejected. Reload re-reads from disk for changes made in an editor instead.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { SimulateResult, SystemMetrics } from "../types";
import { Chip, Panel, AgentTag } from "./ui";

/** Each probes a different normalizer strategy. */
const SAMPLES: Array<{ label: string; cmd: string }> = [
  { label: "plain", cmd: "rm -rf C:\\Windows\\System32" },
  { label: "hex escapes", cmd: "\\x72\\x6d -rf /finance" },
  { label: "variable", cmd: "cat $HOME/.ssh/id_rsa" },
  { label: "alias", cmd: "r=rm; $r -rf ~/.ssh" },
  { label: "chained", cmd: "ls -la && rm -rf /private" },
  {
    label: "traversal",
    cmd: "cat C:\\Users\\Admin\\Desktop\\..\\..\\..\\Windows\\win.ini",
  },
  { label: "allowed", cmd: "cat C:\\Users\\Admin\\Documents\\notes.txt" },
];

/** A CSS bar. No charting library — three runtime dependencies is the budget,
 *  and a percentage is one `width`. */
function Meter({
  label,
  pct,
  detail,
}: {
  label: string;
  pct: number;
  detail?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="type-mono text-[9px] text-muted">{label}</span>
        <span className="font-mono text-[10px] font-semibold tabular-nums text-fg">
          {clamped.toFixed(0)}%
          {detail ? <span className="text-dim"> {detail}</span> : null}
        </span>
      </div>
      <div
        className="mt-0.5 h-2.5 overflow-hidden border-2 border-fg bg-void"
        role="img"
        aria-label={`${label} ${clamped.toFixed(0)} percent`}
      >
        <div
          className={
            clamped >= 85
              ? "h-full bg-danger-soft"
              : clamped >= 60
                ? "h-full bg-warn-soft"
                : "h-full bg-ok-soft"
          }
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Real machine telemetry, in the panel that already reports what the system is
 * running rather than on a screen of its own.
 *
 * Polled every 15s rather than streamed: a sample only lands once a minute, so a
 * subscription would idle for 45 of every 60 seconds to deliver the same numbers.
 * The sparkline is a row of divs — a charting library for seven bars would be the
 * largest dependency in the app.
 */
function SystemStrip() {
  const [sys, setSys] = useState<SystemMetrics | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      void api
        .systemMetrics()
        .then((r) => alive && setSys(r))
        // Silent: this strip is supplementary, and a banner for it would sit
        // above the policy view, which is the part that matters on this screen.
        .catch(() => alive && setSys(null));
    tick();
    const t = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!sys) return null;

  if (!sys.available) {
    return (
      <div className="border-t-2 border-fg pt-2.5">
        <p className="type-mono text-[10px] text-muted">Machine</p>
        <p className="mt-1 text-[11px] leading-snug text-dim">
          {sys.error ?? "No reading available."} Install it with{" "}
          <span className="font-mono">uv sync</span> to see CPU and memory here.
        </p>
      </div>
    );
  }

  const now = sys.current;
  const series = sys.samples.slice(-48);

  return (
    <div className="border-t-2 border-fg pt-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="type-mono text-[10px] text-muted">Machine</p>
        {!sys.sampling ? (
          <Chip title="CONCA_DISABLE_SCHEDULER is set, so nothing is being recorded">
            live only
          </Chip>
        ) : null}
      </div>

      <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
        <Meter
          label="CPU"
          pct={now.cpu_pct ?? 0}
          detail={now.cores ? `· ${now.cores} cores` : undefined}
        />
        <Meter label="Memory" pct={now.mem_pct ?? 0} />
      </div>

      <p className="mt-1.5 font-mono text-[10px] text-dim">
        this process: {(now.proc_rss_mb ?? 0).toFixed(0)} MB ·{" "}
        {(now.proc_cpu_pct ?? 0).toFixed(0)}% cpu · {now.threads ?? 0} threads
      </p>

      {series.length > 1 ? (
        <div className="mt-1.5">
          {/* Fixed 32px track: bars scaled to whatever the window's peak is
              would make an idle machine look as busy as a loaded one. */}
          <div className="flex h-8 items-end gap-px" aria-hidden>
            {series.map((s) => (
              <span
                key={s.ts}
                className="flex-1 border-t-2 border-fg bg-council-soft"
                style={{ height: `${Math.max(4, Math.min(100, s.cpu_pct))}%` }}
                title={`${s.cpu_pct}% cpu`}
              />
            ))}
          </div>
          <p className="type-mono mt-1 text-[9px] text-muted">
            cpu · last {series.length} sample{series.length === 1 ? "" : "s"}
          </p>
        </div>
      ) : (
        <p className="mt-1.5 text-[10px] leading-snug text-muted">
          One sample a minute — the series fills in as the app stays open.
        </p>
      )}
    </div>
  );
}

export function ConcaPanel() {
  const conca = useAgentStore((s) => s.conca);
  const rotator = useAgentStore((s) => s.rotator);

  const [cmd, setCmd] = useState(SAMPLES[0].cmd);
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [busy, setBusy] = useState(false);

  // ── editor ──────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const openEditor = async () => {
    setSaveErr(null);
    setSaved(null);
    try {
      setDraft((await api.concaRaw()).content);
      setEditing(true);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not read the policy");
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    setSaved(null);
    try {
      const res = await api.concaSave(draft);
      setSaved(`Saved as v${res.version} — previous kept as ${res.backup}`);
      setEditing(false);
      // What is on screen must be what is now enforced, not what was submitted.
      await useAgentStore.getState().refreshConca();
    } catch (e) {
      // A 400 here is usually the engine refusing to be disarmed, and its reason
      // is worth showing verbatim rather than flattening to "save failed".
      setSaveErr(e instanceof Error ? e.message : "Save refused");
    } finally {
      setSaving(false);
    }
  };

  const simulate = async (value: string) => {
    setBusy(true);
    setCmd(value);
    try {
      setResult(await api.concaSimulate(value));
    } catch {
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    await api.concaReload();
    // The policy view is derived from the store; re-bootstrap the parts affected.
    await useAgentStore.getState().bootstrap();
  };

  return (
    <Panel
      title="Policy engine"
      accent="var(--color-reports)"
      actions={
        <div className="flex items-center gap-2">
          {conca ? <Chip tone="ok">v{conca.version}</Chip> : null}
          <button
            type="button"
            onClick={() => void reload()}
            className="chip"
            title="Re-read .conca from disk"
          >
            Reload
          </button>
        </div>
      }
      bodyClass="overflow-y-auto max-h-[68vh]"
    >
      <div className="space-y-3 px-3 py-3">
        {/* ── dry-run ─────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <p className="type-mono text-[10px] text-muted">Command simulator</p>
          <div className="flex gap-2">
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void simulate(cmd)}
              className="field flex-1 font-mono text-[12px]"
              aria-label="Command to simulate"
            />
            <button
              type="button"
              onClick={() => void simulate(cmd)}
              disabled={busy || !cmd.trim()}
              className="btn shrink-0 px-3 py-1.5 text-[12px]"
            >
              Check
            </button>
          </div>
          <ul className="flex flex-wrap gap-1">
            {SAMPLES.map((s) => (
              <li key={s.label}>
                <button
                  type="button"
                  onClick={() => void simulate(s.cmd)}
                  className="chip"
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[10px] leading-snug text-muted">
            Nothing is executed. This runs the same check a tool call goes
            through, then reports the verdict.
          </p>

          {result ? (
            <div
              className={`inset-flat space-y-2 px-3 py-2.5 ${
                result.allowed ? "bg-ok-soft" : "bg-danger-soft"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="type-display text-[13px] text-fg">
                  {result.allowed ? "Allowed" : "Refused"}
                </span>
                {result.destructive ? (
                  <Chip tone="warn" title="Destructive verb detected">
                    {result.destructive_verb || "destructive"}
                  </Chip>
                ) : null}
              </div>
              <p className="text-[12px] leading-snug text-fg">
                {result.reason}
              </p>

              <dl className="space-y-1 border-t-2 border-fg pt-2 text-[11px]">
                <div>
                  <dt className="text-dim">As typed</dt>
                  <dd className="break-all font-mono text-fg">
                    {result.input}
                  </dd>
                </div>
                <div>
                  <dt className="text-dim">Normalised</dt>
                  <dd className="break-all font-mono font-semibold text-fg">
                    {result.normalized}
                  </dd>
                </div>
                {result.segments.length > 1 ? (
                  <div>
                    <dt className="text-dim">
                      Segments ({result.segments.length}) — every one is checked
                    </dt>
                    <dd className="space-y-0.5 font-mono text-fg">
                      {result.segments.map((s, i) => (
                        <p key={i} className="break-all">
                          {s}
                        </p>
                      ))}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : null}
        </div>

        {/* ── policy ──────────────────────────────────────────────────── */}
        {conca ? (
          <div className="space-y-2.5 border-t-2 border-fg pt-3">
            <div>
              <p className="type-mono text-[10px] text-muted">
                Agents for {conca.role}
              </p>
              <ul className="mt-1 flex flex-wrap gap-1">
                {conca.agents_for_your_role.map((a) => (
                  <li key={a}>
                    <AgentTag
                      agent={a}
                      title="Granted to your role and enabled"
                    />
                  </li>
                ))}
                {Object.entries(conca.agent_permissions)
                  .filter(([, v]) => v !== "enabled")
                  .map(([a]) => (
                    <li key={a}>
                      {/* Off keeps the danger tone rather than its own hue: the
                          agent colours mean "this can run", and a disabled agent
                          in full colour would contradict the label beside it. */}
                      <Chip tone="danger" title="Disabled in .conca">
                        {a}
                      </Chip>
                    </li>
                  ))}
              </ul>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-2">
              <div>
                <p className="type-mono text-[10px] text-muted">Off-limits</p>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-danger">
                  {conca.off_limits_paths.map((p) => (
                    <li key={p} className="break-all">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="type-mono text-[10px] text-muted">
                  Writable roots
                </p>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-ok">
                  {conca.allowed_paths.map((p) => (
                    <li key={p} className="break-all">
                      {p}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[10px] leading-snug text-muted">
                  Anything outside these is refused, not merely unlisted.
                </p>
              </div>
            </div>

            <div>
              <p className="type-mono text-[10px] text-muted">
                Actions requiring approval
              </p>
              <ul className="mt-1 flex flex-wrap gap-1">
                {conca.halo_triggers.map((t) => (
                  <li key={t}>
                    <Chip tone="warn">{t}</Chip>
                  </li>
                ))}
              </ul>
            </div>

            {rotator ? (
              <div className="border-t-2 border-fg pt-2.5">
                <p className="type-mono text-[10px] text-muted">Model ladder</p>
                <p className="mt-1 text-[12px] text-dim">
                  <span className="font-mono font-semibold text-fg">
                    {rotator.current}
                  </span>{" "}
                  <span className="text-dim">({rotator.current_provider})</span>
                  {" · "}
                  {rotator.active_count} of {rotator.ladder_size} available
                  {rotator.exhausted.length
                    ? ` · ${rotator.exhausted.length} exhausted this session`
                    : ""}
                </p>
                {!rotator.live_provider_configured ? (
                  <p className="inset-flat mt-1.5 bg-warn-soft px-2.5 py-1.5 text-[11px] leading-snug text-fg">
                    Planning locally — no model provider is configured, so plans
                    and approval options are composed on this machine. Set a
                    provider key to hand that back to a model.
                  </p>
                ) : null}
              </div>
            ) : null}

            <SystemStrip />

            {/* ── fenced editor ─────────────────────────────────────────── */}
            {conca.role === "staff" ? (
              <div className="space-y-2 border-t-2 border-fg pt-2.5">
                <div className="flex items-center justify-between">
                  <p className="type-mono text-[10px] text-muted">
                    Edit policy
                  </p>
                  <button
                    type="button"
                    onClick={
                      editing
                        ? () => setEditing(false)
                        : () => void openEditor()
                    }
                    className="chip"
                  >
                    {editing ? "Cancel" : "Open"}
                  </button>
                </div>

                {editing ? (
                  <>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      spellCheck={false}
                      rows={16}
                      className="field w-full resize-y font-mono text-[11px] leading-snug"
                      aria-label="Policy YAML"
                    />
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => void save()}
                        disabled={saving || !draft.trim()}
                        className="btn shrink-0 px-3 py-1.5 text-[12px]"
                      >
                        {saving ? "Saving…" : "Save & reload"}
                      </button>
                      <p className="text-[10px] leading-snug text-muted">
                        Parsed and validated before it is written, and refused
                        outright if it would empty the deny-list or the writable
                        roots. The previous file is kept as{" "}
                        <span className="font-mono">.conca.bak</span>.
                      </p>
                    </div>
                  </>
                ) : (
                  <p className="text-[10px] leading-snug text-muted">
                    Loads the real file, comments included — the parsed view
                    above cannot be saved back without losing them.
                  </p>
                )}

                {saveErr ? (
                  <p className="text-[11px] leading-snug text-danger">
                    {saveErr}
                  </p>
                ) : null}
                {saved ? (
                  <p className="text-[11px] leading-snug text-ok">{saved}</p>
                ) : null}
              </div>
            ) : null}

            <p className="border-t-2 border-fg pt-2 font-mono text-[10px] text-muted">
              {conca.policy_path}
            </p>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
