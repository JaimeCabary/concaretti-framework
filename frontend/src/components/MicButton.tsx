/**
 * Speak instead of typing. The words land in the composer, not in a run.
 *
 * Click to start, click again to stop — not hold-to-talk. Holding reads well in a
 * demo and badly everywhere else: it fights scrolling on a touch screen, it has no
 * keyboard equivalent, and a finger that slips mid-sentence loses the sentence.
 *
 * The button is absent, not disabled, when transcription cannot work. Three
 * separate things can make that true — no `GROQ_API_KEY` on the server, no
 * `MediaRecorder` in the engine, no microphone permission API — and none of them
 * is fixable from this screen, so a greyed-out mic would only be a promise the
 * page cannot keep. The Web Speech API is not one of the paths considered: it does
 * not exist in WebView2, which is what the desktop wrapper renders in.
 *
 * The recording never touches disk on either side. It lives in a `Blob` here, is
 * streamed to `/api/voice/transcribe`, forwarded, and dropped; the tracks are
 * stopped the moment recording ends, so the browser's mic indicator goes out when
 * the user expects it to rather than when the component unmounts.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";

/**
 * A minute is the ceiling, because a prompt is not a dictation session.
 *
 * It also keeps the upload comfortably inside the 25 MB the route enforces: Opus
 * at these bitrates is roughly 1 MB a minute, so the size cap is a backstop for
 * an engine that ignores the codec hint rather than a limit anyone will meet.
 */
const MAX_SECONDS = 60;

/**
 * Container preference, most-wanted first, paired with the extension the provider
 * needs to see. Opus in WebM is what Chromium gives; the `mp4` row is for WebKit,
 * which offers no WebM at all.
 */
const CONTAINERS: ReadonlyArray<[mime: string, ext: string]> = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/ogg;codecs=opus", "ogg"],
  ["audio/mp4", "m4a"],
];

/** The first container this engine will actually record, or null if none. */
function pickContainer(): [string, string] | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const row of CONTAINERS) {
    // `isTypeSupported` is itself missing on some older engines, in which case
    // there is nothing to interrogate and no reason to trust a guess.
    if (typeof MediaRecorder.isTypeSupported !== "function") return null;
    if (MediaRecorder.isTypeSupported(row[0])) return row;
  }
  return null;
}

export function MicButton({ onText }: { onText: (text: string) => void }) {
  const ready = useAgentStore((s) => s.voiceReady);

  const [state, setState] = useState<"idle" | "recording" | "sending">("idle");
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const ticker = useRef<number | null>(null);

  /** Release the hardware and the timer. Safe to call twice. */
  const teardown = () => {
    if (ticker.current !== null) {
      window.clearInterval(ticker.current);
      ticker.current = null;
    }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    rec.current = null;
  };

  // A component unmounted mid-recording — a tab switch, a route change — must not
  // leave the microphone live. Nothing else would ever stop it.
  useEffect(() => teardown, []);

  const container = pickContainer();

  // Checked as three separate conditions rather than one `canRecord` boolean so
  // the compiler can narrow `container` past this line; a combined flag would be
  // just as correct and would still leave it possibly-null below.
  if (
    !ready ||
    container === null ||
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    return null;
  }

  const [mime, ext] = container;
  // The codec parameter belongs on the recorder, not on the upload: some
  // providers match the content type exactly and reject `audio/webm;codecs=opus`
  // while accepting `audio/webm` for the identical bytes. The extension carries
  // the container either way.
  const uploadType = mime.split(";")[0];

  const send = (clip: Blob) => {
    if (!clip.size) {
      setErr("Nothing was recorded — check the microphone is not muted.");
      setState("idle");
      return;
    }
    setState("sending");
    void api
      .transcribe(clip, `speech.${ext}`)
      .then((r) => {
        if (r.text) onText(r.text);
        else
          setErr(
            "Nothing recognisable in that clip. Try again, closer to the mic.",
          );
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : "Transcription failed"),
      )
      .finally(() => setState("idle"));
  };

  const stop = () => {
    // Guarded on the recorder's own state, because `stop()` on an inactive
    // recorder throws — and this is reached from two places that can race: the
    // button, and the one-minute ceiling in the ticker.
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
        // Browser-side cleanup is free and Whisper is measurably better on it.
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
        // `stop()` fires this, and this is where the blob is assembled — so the
        // teardown lives here rather than in the caller, where it would run
        // before the final chunk had arrived.
        const clip = new Blob(chunks.current, { type: uploadType });
        chunks.current = [];
        teardown();
        send(clip);
      };
      r.start();

      setSecs(0);
      setState("recording");
      // Elapsed is derived from a clock rather than accumulated in the state
      // updater. An updater that also calls `stop()` would fire it twice under
      // StrictMode's double-invoke, and a counter that adds 1 per tick drifts
      // whenever the tab is throttled in the background.
      const t0 = performance.now();
      ticker.current = window.setInterval(() => {
        const elapsed = Math.round((performance.now() - t0) / 1000);
        setSecs(elapsed);
        if (elapsed >= MAX_SECONDS) stop();
      }, 1000);
    } catch (e: unknown) {
      teardown();
      setState("idle");
      // A refused permission is the common case by a wide margin, and the browser's
      // own `NotAllowedError` says nothing about how to undo it.
      setErr(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Microphone blocked for this site. Allow it in the address-bar permissions, then try again."
          : e instanceof Error
            ? e.message
            : "Could not open the microphone",
      );
    }
  };

  const label =
    state === "recording"
      ? // Clamped, because a backgrounded tab can be throttled past the ceiling
        // before the ticker gets a slice to stop on.
        `Stop · ${Math.max(0, MAX_SECONDS - secs)}s`
      : state === "sending"
        ? "Transcribing"
        : "Speak";

  return (
    <>
      <button
        type="button"
        onClick={() => (state === "recording" ? stop() : void start())}
        disabled={state === "sending"}
        aria-pressed={state === "recording"}
        title="Records up to a minute, transcribes it into the box, and stops there. Nothing runs until you send."
        className={`chip shrink-0 rounded-none px-4 py-2 text-[11px] font-bold tracking-widest uppercase transition-colors ${
          state === "recording" 
            ? "bg-danger text-white hover:bg-danger" 
            : "bg-[#00E5FF] text-black hover:bg-[#00C2D9]"
        }`}
      >
        <svg 
          viewBox="0 0 24 24" 
          className={`size-3.5 mr-1.5 ${state === "recording" ? "animate-pulse" : ""}`} 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2.5" 
          strokeLinecap="square"
          strokeLinejoin="miter"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
        {label}
      </button>
      {err && (
        <p
          role="status"
          className="basis-full text-[11px] leading-snug text-danger"
        >
          {err}
        </p>
      )}
    </>
  );
}
