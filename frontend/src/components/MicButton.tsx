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

export interface MicButtonProps {
  onText: (text: string) => void;
  onStreamText?: (text: string) => void;
  onRecordingStart?: () => void;
}

export function MicButton({ onText, onStreamText, onRecordingStart }: MicButtonProps) {
  const ready = useAgentStore((s) => s.voiceReady);

  const [state, setState] = useState<"idle" | "recording" | "sending">("idle");
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [wakeActive, setWakeActive] = useState(() => {
    try {
      const saved = localStorage.getItem("conca_wake_active");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [toast, setToast] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0); // drives live volume bar

  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const ticker = useRef<number | null>(null);
  const animFrame = useRef<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const audioCtxRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const speechRec = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const liveDictateRec = useRef<any>(null);
  const latestTranscriptRef = useRef<string>("");

  const teardown = () => {
    if (ticker.current !== null) {
      window.clearInterval(ticker.current);
      ticker.current = null;
    }
    if (animFrame.current !== null) {
      cancelAnimationFrame(animFrame.current);
      animFrame.current = null;
    }
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {
        /* ignore */
      }
      audioCtxRef.current = null;
    }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    rec.current = null;
    setAudioLevel(0);
    if (speechRec.current) {
      try {
        speechRec.current.stop();
      } catch {
        /* ignore */
      }
      speechRec.current = null;
    }
    if (liveDictateRec.current) {
      try {
        liveDictateRec.current.stop();
      } catch {
        /* ignore */
      }
      liveDictateRec.current = null;
    }
  };

  useEffect(() => teardown, []);

  // ── Global Wake Word SSE Trigger ──
  useEffect(() => {
    const onVoiceTrigger = () => {
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

  // Check if running inside any desktop shell (Tauri, PyWebView, WebView2)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isDesktop = typeof window !== "undefined" && Boolean(
    (window as any).__TAURI__ ||
    (window as any).pywebview ||
    (window as any).chrome?.webview
  );

  // ── Wake Word Engine ──
  useEffect(() => {
    if (!wakeActive || state === "recording" || state === "sending") {
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

    // In standard browsers with working SpeechRecognition (desktop shells use MediaRecorder):
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechAPI = !isDesktop && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

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
          
          const match = transcript.match(
            /\b(?:hey|hi|hello|yo|ok|okay)?\s*(?:concaretti|concarretti|conca\s*ready|con\s*karate|conca|conker|conquer|concrete|conchetti|council)\b(?:\s*(.*))?/i,
          );
          if (match) {
            playChime();
            setToast('✓ "Hi Concaretti" listening…');
            setTimeout(() => setToast(null), 3000);

            const trailing = (match[1] || "").trim();
            if (trailing) {
              onText(trailing);
            } else {
              try {
                sr.stop();
              } catch {
                /* ignore */
              }
              speechRec.current = null;
              void start();
            }
          }
        };

        sr.onerror = () => {
          /* restart loop on error */
        };

        sr.onend = () => {
          if (wakeActive && state === "idle") {
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
  }, [wakeActive, state, isDesktop, onText]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasNativeSpeech = typeof window !== "undefined" && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  const container = pickContainer();

  if (
    (!ready && !hasNativeSpeech) ||
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    return null;
  }

  const [mime, ext] = container || ["audio/webm", "webm"];
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
          setErr("Nothing recognisable in that clip. Try speaking closer to the mic.");
        }
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Transcription failed"),
      )
      .finally(() => setState("idle"));
  };

  const stop = () => {
    if (liveDictateRec.current) {
      try {
        liveDictateRec.current.stop();
      } catch {
        /* ignore */
      }
      liveDictateRec.current = null;
    }
    if (latestTranscriptRef.current.trim()) {
      onText(latestTranscriptRef.current.trim());
      latestTranscriptRef.current = "";
    }
    if (rec.current?.state === "recording") {
      rec.current.stop();
    } else {
      teardown();
      setState("idle");
    }
  };

  // Hardware MediaRecorder audio capture with live audio level meter
  const startMediaRecorder = async () => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stream.current = media;
      chunks.current = [];

      // Connect Web Audio API to measure live mic volume in real time
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const actx = new AudioCtx();
          audioCtxRef.current = actx;
          const src = actx.createMediaStreamSource(media);
          const analyser = actx.createAnalyser();
          analyser.fftSize = 64;
          analyser.smoothingTimeConstant = 0.5;
          src.connect(analyser);

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          const checkVolume = () => {
            if (!stream.current) return;
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const avg = sum / dataArray.length;
            setAudioLevel(Math.min(100, Math.round((avg / 128) * 100)));
            animFrame.current = requestAnimationFrame(checkVolume);
          };
          animFrame.current = requestAnimationFrame(checkVolume);
        }
      } catch {
        /* AudioContext failed, recording still works */
      }

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
      r.start(250);

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
          ? "Microphone access blocked. Allow mic in Windows Privacy settings."
          : e instanceof Error
            ? e.message
            : "Could not open microphone",
      );
    }
  };

  const start = async () => {
    setErr(null);
    latestTranscriptRef.current = "";
    onRecordingStart?.();

    // In desktop webview (Tauri / PyWebView / Edge WebView2): webkitSpeechRecognition
    // lacks Google Speech endpoints and throws 'network' error. Always use native hardware MediaRecorder!
    if (isDesktop) {
      await startMediaRecorder();
      return;
    }

    // In standard browser (Chrome/Edge): try SpeechRecognition for live word-for-word streaming
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (SpeechAPI) {
      try {
        const sr = new SpeechAPI();
        sr.continuous = true;
        sr.interimResults = true;
        sr.lang = "en-US";

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sr.onresult = (e: any) => {
          let finalWords = "";
          let interimWords = "";
          for (let i = 0; i < e.results.length; ++i) {
            const item = e.results[i];
            const text = item[0]?.transcript || "";
            if (item.isFinal) {
              finalWords += text + " ";
            } else {
              interimWords += text;
            }
          }
          const liveText = (finalWords + interimWords).trim();
          if (liveText) {
            latestTranscriptRef.current = liveText;
            if (onStreamText) {
              onStreamText(liveText);
            } else {
              onText(liveText);
            }
          }
        };

        sr.onerror = (e: any) => {
          // If browser speech API hits network error or blocked, fall back immediately to hardware MediaRecorder
          if (e.error === "network" || e.error === "audio-capture" || e.error === "not-allowed" || e.error === "service-not-allowed") {
            try { sr.stop(); } catch {}
            liveDictateRec.current = null;
            setErr(null);
            void startMediaRecorder();
          } else if (e.error !== "no-speech") {
            setErr(`Voice error: ${e.error}`);
          }
        };

        sr.onend = () => {
          if (latestTranscriptRef.current.trim()) {
            onText(latestTranscriptRef.current.trim());
            latestTranscriptRef.current = "";
          }
          setState("idle");
        };

        sr.start();
        liveDictateRec.current = sr;
        setState("recording");
        setSecs(0);
        const t0 = performance.now();
        ticker.current = window.setInterval(() => {
          const elapsed = Math.round((performance.now() - t0) / 1000);
          setSecs(elapsed);
          if (elapsed >= MAX_SECONDS) stop();
        }, 1000);
        return;
      } catch {
        /* fallback to MediaRecorder below */
      }
    }

    // Default hardware recording fallback
    await startMediaRecorder();
  };

  // Trigger system push notification and floating non-disruptive toast on toggle
  const toggleWake = (active: boolean) => {
    setWakeActive(active);
    try {
      localStorage.setItem("conca_wake_active", String(active));
    } catch {
      /* ignore */
    }
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
              {/* Live volume bar */}
              <span className="w-10 h-1 rounded-full bg-white/30 overflow-hidden shrink-0">
                <span className="block h-full bg-white rounded-full transition-all duration-75" style={{ width: `${audioLevel}%` }} />
              </span>
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
