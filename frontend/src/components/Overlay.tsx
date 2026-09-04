/**
 * The overlay window — "heyclicky but better".
 *
 * A separate Tauri window on `index.html#overlay`, raised by Ctrl+Shift+Space,
 * rendered instead of the app shell rather than on top of it. It is not a floating
 * prompt box: the *better* part is what it carries that a prompt box cannot —
 * the plan, the agent that owns each step, and the HALO gate, so an irreversible
 * action can be approved or refused without opening the main window.
 *
 * Everything here goes through the same store and the same API as the staff
 * screen. There is no overlay-only route and no overlay-only tool, because a
 * second dispatch path is a second thing `.conca` would have to be taught about.
 * The capture button is the one addition, and it is a POST to a route that already
 * screens itself.
 *
 * In a browser this file still compiles and still runs — the Tauri global is
 * simply absent, so the capture button reports that there is no display to read
 * and the rest of the overlay works. That is deliberate: the overlay is a window
 * onto the same backend, not a feature that only exists in a wrapper.
 */

import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { CaptureStatus } from "../types";
import { HaloGate } from "./HaloGate";
import { AgentTag, StatusBadge } from "./ui";

/**
 * Tauri's IPC, reached through the global rather than through `@tauri-apps/api`.
 *
 * `withGlobalTauri: true` in `tauri.conf.json` exposes this, which means the
 * frontend gains a native command without gaining an npm dependency — and the
 * web build, where the global is undefined, needs no separate code path.
 */
type TauriGlobal = {
  core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
};

const invoke = async (cmd: string): Promise<unknown> => {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!t?.core?.invoke) throw new Error("not running in the desktop app");
  return t.core.invoke(cmd);
};

/** Why the capture button is unavailable, in the operator's terms. */
function captureBlocker(status: CaptureStatus | null): string | null {
  if (!status) return "checking…";
  if (status.mode === "off")
    return "`rules.screen_capture` is off in .conca — the screen is not read";
  if (!status.granted) return "this role has no desktop agent";
  if (!status.local) return "reading the screen is loopback-only";
  return null;
}

function CaptureButton({ question }: { question: string }) {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const track = useAgentStore((s) => s.trackSpawned);

  // Asked once on open, not on click. A refusal discovered after the capture
  // would mean the display had been read in order to be told it should not be.
  useEffect(() => {
    api
      .captureStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const blocked = captureBlocker(status);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const png = await invoke("capture_screen");
      if (typeof png !== "string" || png.length < 32)
        throw new Error("the capture command returned nothing");
      const res = await api.capture(png, question);
      track(res);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "capture failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className="btn text-[12px]"
        disabled={busy || blocked !== null}
        title={blocked ?? "Read the screen and ask the council about it"}
        onClick={() => void run()}
      >
        {busy ? "reading…" : "read my screen"}
      </button>
      {/* The gate is worth announcing before the click, not after: `ask` means
          this button opens an approval card rather than doing the thing. */}
      {status?.gated && !blocked && (
        <span className="text-[10px] text-dim">
          approval required each time
        </span>
      )}
      {blocked && blocked !== "checking…" && (
        <span className="text-[10px] text-dim">{blocked}</span>
      )}
      {error && <span className="text-[10px] text-danger">{error}</span>}
    </div>
  );
}

/**
 * The plan, one line per step.
 *
 * Layer is shown because it is the only thing that explains why step four has
 * not started: the DAG runs a layer at a time, so a step waits on its layer, not
 * on the step above it.
 */
function Plan() {
  const subtasks = useAgentStore((s) => s.subtasks);
  const summary = useAgentStore((s) => s.finalSummary);
  const running = useAgentStore((s) => s.running);
  const error = useAgentStore((s) => s.lastError);

  if (error) return <p className="text-[12px] text-danger">{error}</p>;
  if (!subtasks.length)
    return (
      <p className="text-[12px] text-dim">
        {running ? "planning…" : "Ctrl+Shift+Space hides this again."}
      </p>
    );

  return (
    <div className="flex flex-col gap-1.5">
      {subtasks.map((t) => (
        <div key={t.id} className="flex items-center gap-2">
          <span className="type-mono w-4 shrink-0 text-[10px] text-muted">
            L{t.layer}
          </span>
          <AgentTag agent={t.agent} />
          <span className="min-w-0 flex-1 truncate text-[12px]">
            {t.description || t.task_type}
          </span>
          <StatusBadge status={t.status} />
        </div>
      ))}
      {summary && (
        <p className="mt-1 border-t-2 border-fg pt-1.5 text-[12px]">
          {summary}
        </p>
      )}
    </div>
  );
}

export function Overlay() {
  const [prompt, setPrompt] = useState("");
  const roleLoaded = useAgentStore((s) => s.roleLoaded);
  const running = useAgentStore((s) => s.running);
  const bootstrap = useAgentStore((s) => s.bootstrap);
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const clearRun = useAgentStore((s) => s.clearRun);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || running) return;
    setPrompt("");
    void runPrompt(text);
  }

  return (
    <>
      {/* One card, drawn by this component rather than by the window: the Tauri
          window is transparent and undecorated, so the border and the shadow
          here are the whole chrome. */}
      <div className="flex h-dvh flex-col gap-2 p-3">
        <div className="panel flex min-h-0 flex-1 flex-col gap-2 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h1 className="type-display text-[15px]">Concaretti</h1>
            <button
              type="button"
              className="type-mono text-[10px] text-muted hover:text-fg"
              onClick={clearRun}
              title="Clear this run from the overlay. It does not stop the agents."
            >
              clear
            </button>
          </div>

          <form onSubmit={submit} className="flex gap-2">
            <input
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="what needs doing?"
              className="field min-w-0 flex-1 text-[13px]"
              disabled={!roleLoaded}
            />
            <button
              type="submit"
              className="btn btn-primary text-[12px]"
              disabled={!prompt.trim() || running || !roleLoaded}
            >
              {running ? "running" : "run"}
            </button>
          </form>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <Plan />
          </div>

          <CaptureButton question={prompt.trim()} />
        </div>
      </div>

      {/* The point of the overlay. A gate raised by a run started anywhere —
          including the scheduler — is answerable here without opening the app. */}
      <HaloGate />
    </>
  );
}
