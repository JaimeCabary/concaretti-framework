/**
 * Voice input with Push-to-Talk and native "Hey Concaretti" Wake-Word Detection.
 *
 * Modes:
 * 1. Push-to-talk: Click to record, click again to stop, transcribed via Groq Whisper.
 * 2. Wake-word mode: Continuous background listening for "Hey Concaretti".
 *    When detected, plays an audible chime, captures the command, and populates the composer.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";

const MAX_SECONDS = 60;

const CONTAINERS: ReadonlyArray<[mime: string, ext: string]> = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/ogg;codecs=opus", "ogg"],
  ["audio/mp4", "m4a"],
];

function pickContainer(): [string, string] | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const row of CONTAINERS) {
    if (typeof MediaRecorder.isTypeSupported !== "function") return null;
    if (MediaRecorder.isTypeSupported(row[0])) return row;
  }
  return null;
}

function playChime() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    /* AudioContext not allowed before user interaction */
  }
}

export function MicButton({ onText }: { onText: (text: string) => void }) {
  const ready = useAgentStore((s) => s.voiceReady);

  const [state, setState] = useState<"idle" | "recording" | "sending">("idle");
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [wakeActive, setWakeActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const ticker = useRef<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const speechRec = useRef<any>(null);

  const teardown = () => {
    if (ticker.current !== null) {
      window.clearInterval(ticker.current);
      ticker.current = null;
    }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    rec.current = null;
    if (speechRec.current) {
      try {
        speechRec.current.stop();
      } catch {
        /* ignore */
      }
      speechRec.current = null;
    }
  };

  useEffect(() => teardown, []);

  // ── Global Wake Word SSE Trigger ──
  useEffect(() => {
    const onVoiceTrigger = () => {
      // Play chime to acknowledge wake word, then start recording immediately
      playChime();
      setToast('✓ "Hey Concaretti" detected');
      setTimeout(() => setToast(null), 3000);
      if (state === "idle") {
        void start();
      }
    };
    window.addEventListener("conca_voice_trigger", onVoiceTrigger);
    return () => window.removeEventListener("conca_voice_trigger", onVoiceTrigger);
  }, [state]);

  // ── Wake Word Recognition Engine ──
  useEffect(() => {
    if (!wakeActive) {
      if (speechRec.current) {
        try {
          speechRec.current.stop();
        } catch {
          /* ignore */
        }
        speechRec.current = null;
      }
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (SpeechAPI) {
      try {
        const sr = new SpeechAPI();
        sr.continuous = true;
        sr.interimResults = false;
        sr.lang = "en-US";

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sr.onresult = (e: any) => {
          const results = e.results;
          if (!results || results.length === 0) return;
          const transcript = results[results.length - 1][0]?.transcript || "";
          if (/\b(hey\s+)?concaretti\b/i.test(transcript)) {
            playChime();
            setToast('✓ "Hey Concaretti" detected');
            onText(transcript.trim());
            setTimeout(() => setToast(null), 3000);
          }
        };

        sr.onerror = () => {
          /* restart loop on error */
        };

        sr.onend = () => {
          if (wakeActive) {
            try {
              sr.start();
            } catch {
              /* ignore */
            }
          }
        };

        sr.start();
        speechRec.current = sr;
      } catch {
        /* ignore */
      }
    }

    return () => {
      if (speechRec.current) {
        try {
          speechRec.current.stop();
        } catch {
          /* ignore */
        }
        speechRec.current = null;
      }
    };
  }, [wakeActive, onText]);

  const container = pickContainer();

  if (
    !ready ||
    container === null ||
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    return null;
  }

  const [mime, ext] = container;
  const uploadType = mime.split(";")[0];

  const send = (clip: Blob) => {
    if (!clip.size) {
      setErr("Nothing was recorded — check that microphone is not muted.");
      setState("idle");
      return;
    }
    setState("sending");
    void api
      .transcribe(clip, `speech.${ext}`)
      .then((r) => {
        if (r.text) {
          playChime();
          onText(r.text);
        } else {
          setErr("Nothing recognisable in that clip. Try again, closer to the mic.");
        }
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Transcription failed"),
      )
      .finally(() => setState("idle"));
  };

  const stop = () => {
    if (rec.current?.state === "recording") rec.current.stop();
    if (ticker.current !== null) {
      window.clearInterval(ticker.current);
      ticker.current = null;
    }
  };

  const start = async () => {
    setErr(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      stream.current = media;
      chunks.current = [];

      const r = new MediaRecorder(media, { mimeType: mime });
      rec.current = r;
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onstop = () => {
        const clip = new Blob(chunks.current, { type: uploadType });
        chunks.current = [];
        teardown();
        send(clip);
      };
      r.start();

      setSecs(0);
      setState("recording");
      const t0 = performance.now();
      ticker.current = window.setInterval(() => {
        const elapsed = Math.round((performance.now() - t0) / 1000);
        setSecs(elapsed);
        if (elapsed >= MAX_SECONDS) stop();
      }, 1000);
    } catch (e: unknown) {
      teardown();
      setState("idle");
      setErr(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Microphone blocked for this site. Allow it in browser permissions."
          : e instanceof Error
            ? e.message
            : "Could not open microphone",
      );
    }
  };

  // Trigger system push notification and floating non-disruptive toast on toggle
  const toggleWake = (active: boolean) => {
    setWakeActive(active);
    if (active) {
      // 1. Native system push notification
      if (typeof window !== "undefined" && "Notification" in window) {
        if (Notification.permission === "granted") {
          try {
            new Notification("Concaretti Voice", {
              body: "Listening for 'Hey Concaretti'…",
              icon: "/favicon.png",
            });
          } catch {
            /* ignore */
          }
        } else if (Notification.permission !== "denied") {
          Notification.requestPermission().then((perm) => {
            if (perm === "granted") {
              try {
                new Notification("Concaretti Voice", {
                  body: "Listening for 'Hey Concaretti'…",
                  icon: "/favicon.png",
                });
              } catch {
                /* ignore */
              }
            }
          });
        }
      }

      // 2. Subtle top-of-screen floating toast (fixed overlay, zero layout shift)
      setToast('Listening for "Hey Concaretti"');
      setTimeout(() => setToast(null), 2500);
    } else {
      setToast(null);
    }
  };

  return (
    <>
      {/* Floating Top Push Notification (Fixed Overlay — Zero Layout Shift) */}
      {toast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-50 pointer-events-none animate-slide-in">
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#1a1a1a] text-white shadow-xl text-[12px] font-medium border border-white/10">
            <span className="size-2 rounded-full bg-rose-500 animate-ping" />
            <span>{toast}</span>
          </div>
        </div>
      )}

      {/* Toolbar Voice Section — Strictly Fixed-Width Elements (Zero Movement on Toggle) */}
      <div className="flex items-center gap-2 shrink-0 select-none">
        {/* Real Toggle Switch */}
        <label
          className="flex items-center gap-2 cursor-pointer group py-1"
          title={wakeActive ? "Wake-word active: say 'Hey Concaretti'" : "Toggle Wake Word ('Hey Concaretti')"}
        >
          <div className="relative">
            <input
              type="checkbox"
              checked={wakeActive}
              onChange={(e) => toggleWake(e.target.checked)}
              className="sr-only"
            />
            {/* Real Switch Track */}
            <div
              className={`w-9 h-5 rounded-full transition-colors duration-200 ease-in-out border ${wakeActive
                  ? "bg-rose-500 border-rose-600 shadow-[0_0_8px_rgba(244,63,94,0.35)]"
                  : "bg-neutral-300 dark:bg-neutral-700 border-neutral-300 dark:border-neutral-600"
                }`}
            >
              {/* Real Switch Sliding Circle */}
              <div
                className={`size-4 bg-white rounded-full shadow-xs transition-transform duration-200 ease-in-out absolute top-[1px] left-[1px] ${wakeActive ? "translate-x-4" : "translate-x-0"
                  }`}
              />
            </div>
          </div>

          {/* Label + Red Pulse (Fixed Width, No Text Changes) */}
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-dim group-hover:text-fg transition-colors">
            {/* Red Pulse Dot when Active (Fixed-Size Container) */}
            <span className="relative flex size-2 items-center justify-center shrink-0">
              {wakeActive && (
                <>
                  <span className="animate-ping absolute inline-flex size-full rounded-full bg-rose-400 opacity-80" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-rose-500" />
                </>
              )}
            </span>
            <span className="whitespace-nowrap">Wake Word</span>
          </div>
        </label>

        {/* Dictate / Push-to-Talk Button (Fixed Dimensions) */}
        <button
          type="button"
          onClick={() => (state === "recording" ? stop() : void start())}
          disabled={state === "sending"}
          aria-pressed={state === "recording"}
          title="Push to talk: records voice note and transcribes via Whisper"
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all cursor-pointer shrink-0 ${state === "recording"
              ? "bg-rose-500 text-white shadow-[0_0_12px_rgba(244,63,94,0.4)] animate-pulse"
              : state === "sending"
                ? "bg-elevated text-dim border border-hairline"
                : "bg-elevated/70 hover:bg-elevated text-dim hover:text-fg border border-hairline/70 hover:border-fg/20 shadow-xs hover:shadow-sm active:scale-95"
            }`}
        >
          {state === "recording" ? (
            <>
              <span className="size-2 rounded-full bg-white animate-ping" />
              <span>Stop · {Math.max(0, MAX_SECONDS - secs)}s</span>
            </>
          ) : state === "sending" ? (
            <>
              <svg className="animate-spin size-3 text-dim" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>Transcribing…</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" strokeLinecap="round" />
              </svg>
              <span>Dictate</span>
            </>
          )}
        </button>

        {err && (
          <span role="status" className="text-[11px] text-danger truncate max-w-[140px]">
            {err}
          </span>
        )}
      </div>
    </>
  );
}
