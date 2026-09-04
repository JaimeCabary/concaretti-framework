/**
 * Connect accounts — the credential surface.
 *
 * This is the page that replaced the council PIN. The PIN asked you to prove you
 * were allowed to be here; this asks you for the things that actually make the
 * app able to do anything. One of those is theatre on a machine you already own
 * and the other is the whole product, and the swap is the point.
 *
 * Three properties it holds, all of them enforced server-side and merely
 * *respected* here:
 *
 * **Values are write-only.** A set key arrives as `set: true` plus a masked tail,
 * never as the value. So this component can show that Twilio is connected and
 * cannot show you the token — a settings page that can display your credentials
 * has re-created the problem the `.env` file exists to avoid, and the browser is
 * the last place that should be holding them.
 *
 * **An empty field disconnects.** Sending `''` for a key that is currently set
 * removes it, which is the difference between a settings page and a one-way
 * funnel. That is why "Disconnect" is a real button and not a note telling you to
 * go and edit a file.
 *
 * **The confirmation is the ladder count, not a checkmark.** After a save the
 * model total is re-read from the rotator. `7 of 56 slots live` moving to
 * `12 of 56` is evidence the key was accepted by the process; a green tick would
 * only be evidence the form submitted. No live probe is fired to prove it, because
 * that would spend a request against the quota the key was pasted in to preserve.
 *
 * Only the changed fields are sent. The whole catalogue is 29 keys and posting all
 * of them would rewrite lines nobody touched, which would turn `.env`'s modified
 * time into noise and the audit entry into a list of everything.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type {
  IntegrationField,
  IntegrationState,
  IntegrationStatus,
} from "../types";
import { Chip, Spinner } from "./ui";

const TONE: Record<IntegrationState, "ok" | "warn" | "neutral"> = {
  on: "ok",
  partial: "warn",
  off: "neutral",
};

const STATE_LABEL: Record<IntegrationState, string> = {
  on: "connected",
  partial: "incomplete",
  off: "not connected",
};

/**
 * One credential row.
 *
 * `value === undefined` means untouched, `''` means the operator explicitly
 * cleared it. The two are different submissions — untouched is omitted from the
 * payload entirely, cleared is a disconnect — so the draft cannot just be a
 * `Record<string, string>` initialised from the status.
 */
function FieldRow({
  field,
  value,
  onChange,
}: {
  field: IntegrationField;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const clearing = field.set && value === "";
  const id = `env-${field.key}`;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="type-mono text-[10px] text-muted">
          {field.label}
          {field.required ? (
            <span
              className="text-danger"
              title="Required for this group to work"
            >
              {" "}
              *
            </span>
          ) : null}
        </label>

        {field.set ? (
          <span className="flex items-center gap-1.5">
            <span
              className="font-mono text-[10px] text-dim"
              title={
                field.secret
                  ? "Stored on this machine. The server never sends the value back."
                  : "Stored on this machine."
              }
            >
              {field.hint}
            </span>
            <button
              type="button"
              className="chip"
              onClick={() => onChange(clearing ? undefined : "")}
            >
              {clearing ? "Keep" : "Disconnect"}
            </button>
          </span>
        ) : null}
      </div>

      <input
        id={id}
        type={field.secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        className="field mt-0.5 w-full font-mono text-[12px]"
        placeholder={field.set ? "Stored — type to replace" : field.placeholder}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />

      {clearing ? (
        <p className="mt-1 text-[10px] leading-snug text-danger">
          Will be removed on save.
        </p>
      ) : field.help ? (
        <p className="mt-1 text-[10px] leading-snug text-muted">{field.help}</p>
      ) : null}

      {field.restart && value ? (
        <p className="mt-1 text-[10px] leading-snug text-dim">
          Read once at startup — this one needs the server restarted.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The group list plus the save bar, with no panel chrome of its own.
 *
 * Chromeless because it has two hosts that frame it differently: the Setup tab
 * wraps it in a `Panel`, and onboarding drops it into a modal that already has a
 * heading and its own progress pills. Rendering a panel inside either would be a
 * box in a box.
 */
export function ConnectAccounts({ onSaved }: { onSaved?: () => void }) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [restart, setRestart] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void api
      .integrations()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        // Open the first thing that needs attention rather than the first group.
        // With everything connected nothing expands, which is the correct resting
        // state for a page you visit once.
        setOpen(s.groups.find((g) => g.state !== "on")?.id ?? null);
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(
          e instanceof Error ? e.message : "Could not read the settings",
        );
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loadError) {
    return (
      <p className="inset-flat bg-danger-soft px-3 py-2.5 text-[12px] leading-snug text-fg">
        {loadError}
      </p>
    );
  }

  if (!status) {
    return (
      <div className="px-1 py-3">
        <Spinner label="Reading settings" />
      </div>
    );
  }

  const fields = status.groups.flatMap((g) => g.fields);

  // Only send what changed, and only send an empty string for a key that is
  // actually set — clearing a field that was already blank would otherwise write
  // `KEY=` into `.env` for no reason.
  const payload: Record<string, string> = {};
  for (const [key, raw] of Object.entries(draft)) {
    const value = raw.trim();
    if (value || fields.find((f) => f.key === key)?.set) payload[key] = value;
  }
  const pending = Object.keys(payload).length;

  const save = async () => {
    if (!pending) return;
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const res = await api.connect(payload);
      setStatus(res);
      setDraft({});
      setRestart(res.restart_required);
      setSaved(
        res.changed.length
          ? `Saved ${res.changed.join(", ")}.`
          : "Nothing needed changing.",
      );
      // A model key changes the ladder and a Google key changes what the panels
      // report, so the ambient state is re-read rather than left stale until the
      // next reload.
      void useAgentStore.getState().refreshRotator();
      void useAgentStore.getState().refreshConca();
      onSaved?.();
    } catch (e) {
      // Shown verbatim: a 400 here is the server naming the key it refused and
      // why, which is more useful than "save failed".
      setSaveError(e instanceof Error ? e.message : "Save refused");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="type-tagline text-[16px] text-dim mb-1">
            System managed
          </p>
          <h1 className="type-display text-[40px] leading-[0.9]">
            CONNECTED ACCOUNTS
          </h1>
          <p className="type-mono mt-3 text-[10px] tracking-widest text-muted">
            CREDENTIALS AND INTEGRATIONS
          </p>
        </div>
        <button
          onClick={() => void window.location.reload()}
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
            Reload
          </span>
        </button>
      </div>

      {/* Metrics Pills */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          className="panel panel-quiet bg-agent-orchestrator p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-fg/70 mb-2">
            MODEL SLOTS LIVE
          </p>
          <p className="type-display text-[32px] text-fg">
            {status.models_active}{" "}
            <span className="text-[20px] text-fg/70">
              / {status.models_total}
            </span>
          </p>
        </div>
        <div
          className="panel panel-quiet bg-obsidian border-hairline p-4"
          style={{ borderRadius: "var(--radius-md)" }}
        >
          <p className="type-mono text-[11px] text-muted mb-2">
            PENDING CHANGES
          </p>
          <p className="type-display text-[32px] text-fg">{pending}</p>
        </div>
      </div>

      <p className="type-mono text-[11px] leading-relaxed text-dim">
        Keys are written to a file on this machine and used from there. They are
        never sent to a model, never stored in the database, and never read back
        into this page — a connected account shows as connected and nothing
        more.
      </p>

      {!status.writable ? (
        <p className="inset-flat bg-warn-soft px-3 py-2 text-[11px] leading-snug text-fg">
          <span className="font-mono">{status.path}</span> cannot be written.
          Fix the permissions on it, or edit the file by hand.
        </p>
      ) : null}

      <ul className="space-y-1.5">
        {status.groups.map((group) => {
          const expanded = open === group.id;
          const touched = group.fields.filter((f) => f.key in draft).length;

          return (
            <li
              key={group.id}
              className="panel bg-obsidian border-hairline p-0 overflow-hidden"
              style={{ borderRadius: "var(--radius-md)" }}
            >
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : group.id)}
                className="flex w-full items-center justify-between gap-4 p-4 text-left hover:bg-elevated transition-colors"
              >
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-fg mb-0.5">
                    {group.title}
                  </span>
                  {/* Wraps rather than truncating. `truncate` clipped this to
                      "…both behind the appr…", which turns the one line that says
                      what connecting the account buys you into a riddle. Two
                      lines of 11px costs less than that. */}
                  <span className="block text-[11px] leading-snug text-dim">
                    {group.unlocks}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {touched ? <Chip tone="info">{touched} edited</Chip> : null}
                  <Chip tone={TONE[group.state]}>
                    {STATE_LABEL[group.state]}
                  </Chip>
                  <span
                    aria-hidden
                    className="type-mono text-[11px] text-muted"
                  >
                    {expanded ? "−" : "+"}
                  </span>
                </span>
              </button>

              {expanded ? (
                <div className="animate-slide-in space-y-4 border-t border-hairline p-4 bg-void">
                  <p className="type-mono text-[11px] leading-relaxed text-dim mb-4">
                    {group.blurb}
                  </p>
                  {group.fields.map((f) => (
                    <FieldRow
                      key={f.key}
                      field={f}
                      value={draft[f.key]}
                      onChange={(next) =>
                        setDraft((d) => {
                          if (next !== undefined)
                            return { ...d, [f.key]: next };
                          const rest = { ...d };
                          delete rest[f.key];
                          return rest;
                        })
                      }
                    />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div
        className="panel bg-obsidian border-hairline p-4 flex flex-wrap items-center gap-3"
        style={{ borderRadius: "var(--radius-md)" }}
      >
        <button
          type="button"
          className="btn bg-agent-orchestrator text-fg shadow-none border-none hover:bg-agent-orchestrator/90 px-6 py-2 text-[13px] type-mono font-semibold"
          disabled={saving || !pending || !status.writable}
          onClick={() => void save()}
        >
          {saving
            ? "SAVING…"
            : pending
              ? `SAVE ${pending} CHANGE${pending === 1 ? "" : "S"}`
              : "SAVE"}
        </button>
        {pending ? (
          <button
            type="button"
            className="btn bg-transparent border-hairline text-fg px-4 py-2 text-[13px] type-mono"
            onClick={() => setDraft({})}
          >
            DISCARD
          </button>
        ) : null}
      </div>

      {saveError ? (
        <p className="text-[11px] leading-snug text-danger">{saveError}</p>
      ) : null}
      {saved ? (
        <p className="text-[11px] leading-snug text-ok">{saved}</p>
      ) : null}
      {restart.length ? (
        <p className="inset-flat bg-warn-soft px-3 py-2 text-[11px] leading-snug text-fg">
          Restart the server for{" "}
          <span className="font-mono">{restart.join(", ")}</span> to take
          effect. Everything else is already live.
        </p>
      ) : null}

      <p className="font-mono text-[10px] break-all text-muted">
        {status.path}
      </p>
    </div>
  );
}
