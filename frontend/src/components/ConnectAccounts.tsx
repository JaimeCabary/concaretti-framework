/**
 * Connect accounts & Settings — Operator Profile and Credential surface.
 *
 * For all roles: Operator Name, Active Role switcher, and Integration Status.
 * For Staff: Full write access to .env credentials, model ladder, and keys.
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

function FieldRow({
  field,
  value,
  readOnly = false,
  onChange,
}: {
  field: IntegrationField;
  value: string | undefined;
  readOnly?: boolean;
  onChange: (next: string | undefined) => void;
}) {
  const clearing = field.set && value === "";
  const id = `env-${field.key}`;

  return (
    <div className="space-y-1">
      <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
        <label htmlFor={id} className="type-mono text-[10px] text-muted whitespace-nowrap">
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
          <span className="flex items-center gap-1.5 min-w-0 sm:justify-end">
            <span
              className="font-mono text-[10px] text-dim truncate"
              title={
                field.secret
                  ? "Stored on this machine. The server never sends the value back."
                  : "Stored on this machine."
              }
            >
              {field.hint}
            </span>
            {!readOnly && (
              <button
                type="button"
                className="chip"
                onClick={() => onChange(clearing ? undefined : "")}
              >
                {clearing ? "Keep" : "Disconnect"}
              </button>
            )}
          </span>
        ) : null}
      </div>

      <input
        id={id}
        type={field.secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        disabled={readOnly}
        className={`w-full rounded-xl text-sm bg-void border border-hairline focus:border-fg p-3 outline-none ${readOnly ? "opacity-60 cursor-not-allowed bg-elevated" : ""}`}
        placeholder={field.set ? "Stored on machine" : field.placeholder}
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
    </div>
  );
}

export function ConnectAccounts({ onSaved, hideHeader }: { onSaved?: () => void; hideHeader?: boolean }) {
  const role = useAgentStore((s) => s.role);
  const userName = useAgentStore((s) => s.userName);
  const setUserName = useAgentStore((s) => s.setUserName);
  const bootstrap = useAgentStore((s) => s.bootstrap);

  const [nameInput, setNameInput] = useState(userName);
  const [nameSaved, setNameSaved] = useState(false);
  const [switchingRole, setSwitchingRole] = useState(false);

  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [restart, setRestart] = useState<string[]>([]);

  const isStaff = role === "staff";

  useEffect(() => {
    setNameInput(userName);
  }, [userName]);

  useEffect(() => {
    let alive = true;
    void api
      .integrations()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setLoadError(null);
        setOpen(s.groups.find((g) => g.state !== "on")?.id ?? null);
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(
          e instanceof Error ? e.message : "Could not read settings",
        );
      });
    return () => {
      alive = false;
    };
  }, [role]);

  const handleSaveName = () => {
    setUserName(nameInput.trim());
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  };

  const handleSwitchRole = async (nextRole: "public" | "student" | "staff") => {
    if (nextRole === role || switchingRole) return;
    setSwitchingRole(true);
    try {
      await api.login(nextRole);
      await bootstrap();
    } finally {
      setSwitchingRole(false);
    }
  };

  const fields = status ? status.groups.flatMap((g) => g.fields) : [];

  const payload: Record<string, string> = {};
  for (const [key, raw] of Object.entries(draft)) {
    const value = raw.trim();
    if (value || fields.find((f) => f.key === key)?.set) payload[key] = value;
  }
  const pending = Object.keys(payload).length;

  const saveIntegrations = async () => {
    if (!pending || !isStaff) return;
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
      void useAgentStore.getState().refreshRotator();
      void useAgentStore.getState().refreshConca();
      onSaved?.();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save refused");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-start justify-between border-b border-hairline pb-4">
          <div>
            <span className="type-mono text-[10px] text-muted tracking-widest uppercase">
              System Preferences
            </span>
            <h1 className="type-display text-[28px] text-fg leading-none mt-1">
              SETTINGS & IDENTITY
            </h1>
            <p className="type-mono mt-1 text-[11px] text-dim">
              Operator credentials, role permissions, and service integrations
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span
              className="type-mono text-[10px] font-bold px-2.5 py-1 border border-hairline uppercase rounded-xl shadow-sm"
              style={{
                background:
                  role === "staff"
                    ? "var(--color-agent-orchestrator)"
                    : role === "student"
                      ? "var(--color-council-soft)"
                      : "var(--color-elevated)",
              }}
            >
              ROLE: {role}
            </span>
          </div>
        </div>
      )}

      {/* ── 1. Operator Profile (All Roles) ── */}
      <div className="bg-obsidian border border-hairline rounded-2xl p-6 shadow-sm">
        <h2 className="type-mono text-[12px] font-bold text-fg uppercase tracking-wider mb-3 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          OPERATOR PROFILE
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="operator-name-input"
              className="type-mono block text-[10px] text-muted font-bold uppercase mb-1"
            >
              Operator Name
            </label>
            <div className="flex gap-2">
              <input
                id="operator-name-input"
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="What should agents call you?"
                className="flex-1 rounded-xl text-sm bg-void border border-hairline focus:border-fg p-3 outline-none"
              />
              <button
                type="button"
                onClick={handleSaveName}
                className="bg-fg text-void hover:opacity-90 px-4 rounded-xl text-xs font-bold uppercase tracking-wider transition-opacity"
              >
                {nameSaved ? "Saved ✓" : "Save"}
              </button>
            </div>
            <p className="text-[10px] text-muted mt-1">
              Used across agent dialogues and personal diary reflections.
            </p>
          </div>

          <div>
            <span className="type-mono block text-[10px] text-muted font-bold uppercase mb-1">
              Active Role Switcher
            </span>
            <div className="flex gap-1.5 pt-0.5">
              {(["public", "student", "staff"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled={switchingRole}
                  onClick={() => void handleSwitchRole(r)}
                  className={`flex-1 py-2 rounded-xl text-[10px] font-bold uppercase border transition-all ${
                    role === r
                      ? "bg-fg text-void border-fg shadow-sm"
                      : "bg-void text-dim border-hairline hover:border-fg"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted mt-1">
              Switch surfaces to inspect policy differences.
            </p>
          </div>
        </div>
      </div>

      {/* ── 2. Integrations & Credentials ── */}
      <div className="bg-obsidian border border-hairline rounded-2xl p-6 shadow-sm space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-3">
          <div>
            <h2 className="type-mono text-[12px] font-bold text-fg uppercase tracking-wider flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
              CONNECTED SERVICES & API KEYS
            </h2>
            <p className="text-[11px] text-dim mt-0.5">
              {isStaff
                ? "Manage model providers, search engines, and communication tokens."
                : "Live integration status across council agents."}
            </p>
          </div>

          {status && (
            <div className="flex items-center gap-2">
              <span className="type-mono text-[10px] bg-void border border-hairline px-2.5 py-1 text-fg">
                MODELS: {status.models_active} / {status.models_total} ACTIVE
              </span>
            </div>
          )}
        </div>

        {!isStaff && (
          <div className="p-3 bg-council-soft/30 rounded-xl border border-hairline text-xs text-fg flex items-center gap-3">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span>
              <strong>Student Role Notice:</strong> Secret API keys and environment variables are write-restricted to the <strong>Staff</strong> role. You can view connectivity status below.
            </span>
          </div>
        )}

        {loadError && (
          <div className="p-3 bg-danger-soft border border-hairline text-xs text-fg">
            <span>{loadError}</span>
          </div>
        )}

        {saveError && (
          <div className="p-3 bg-danger-soft border border-hairline text-xs text-fg">
            <span>{saveError}</span>
          </div>
        )}

        {saved && (
          <div className="p-3 bg-ok-soft border border-hairline text-xs text-ok font-bold">
            <span>{saved}</span>
          </div>
        )}

        {restart.length > 0 && (
          <div className="p-3 bg-warn-soft border border-hairline text-xs text-warn font-bold">
            Restart server to apply: {restart.join(", ")}
          </div>
        )}

        {/* Integration Groups */}
        {!status ? (
          <div className="py-6 text-center">
            <Spinner label="Loading service integrations…" />
          </div>
        ) : (
          <div className="space-y-3">
            {status.groups.map((group) => {
              const isOpen = open === group.id;

              return (
                <div
                  key={group.id}
                  className="border border-hairline rounded-xl bg-void overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : group.id)}
                    className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-elevated transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`size-2.5 rounded-full ${
                          group.state === "on"
                            ? "bg-[#22c55e]"
                            : group.state === "partial"
                              ? "bg-[#eab308]"
                              : "bg-[#9ca3af]"
                        }`}
                      />
                      <span className="type-mono text-xs font-bold text-fg">
                        {group.title}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <Chip tone={TONE[group.state]}>
                        {STATE_LABEL[group.state]}
                      </Chip>
                      <span className="text-muted">
                        {isOpen ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        )}
                      </span>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-4 pt-2 border-t border-hairline bg-obsidian space-y-3">
                      <p className="text-[11px] text-dim">{group.blurb}</p>
                      <div className="flex flex-col gap-4 pt-1">
                        {group.fields.map((field) => (
                          <FieldRow
                            key={field.key}
                            field={field}
                            value={draft[field.key]}
                            readOnly={!isStaff}
                            onChange={(next) =>
                              setDraft((d) => {
                                const copy = { ...d };
                                if (next === undefined) delete copy[field.key];
                                else copy[field.key] = next;
                                return copy;
                              })
                            }
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Save Bar for Staff */}
        {isStaff && pending > 0 && (
          <div className="flex items-center justify-between pt-3 border-t border-hairline">
            <span className="type-mono text-xs text-muted">
              {pending} pending credential change(s)
            </span>
            <button
              type="button"
              onClick={saveIntegrations}
              disabled={saving}
              className="bg-[#FF3366] text-white hover:bg-[#E62E5C] rounded-xl px-6 py-2 text-xs font-bold uppercase tracking-wider transition-colors shadow-sm"
            >
              {saving ? "Saving…" : "Save Credentials"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
