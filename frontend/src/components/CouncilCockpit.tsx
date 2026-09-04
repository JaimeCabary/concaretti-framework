/**
 * Prompt input plus the session timeline.
 *
 * The composer accepts dropped text files by inlining their contents — the
 * backend takes a prompt string, so there is no upload endpoint to hit and
 * inventing one for the demo would be scope the brief didn't ask for. Binary
 * drops are declined with a note rather than silently producing mojibake.
 *
 * Enter sends, Shift+Enter breaks the line. That's the ordinary chat contract
 * and violating it costs more than it saves.
 *
 * Dictation appends into the box and stops there — it never sends. Speech
 * recognition is wrong often enough that auto-running a transcript would put a
 * misheard instruction through the orchestrator, and the composer is the last
 * point where a human can still read what is about to happen.
 */

import { useEffect, useRef, useState, type DragEvent } from "react";
import { useAgentStore } from "../store/agentStore";
import { MicButton } from "./MicButton";

const MAX_INLINE_BYTES = 200_000;
const TEXTUAL =
  /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript))/;

export function CouncilCockpit({
  placeholder = "What needs doing?",
  autoFocus = false,
  prefill = "",
}: {
  placeholder?: string;
  showTimeline?: boolean;
  autoFocus?: boolean;
  prefill?: string;
}) {
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);
  const rule0 = useAgentStore((s) => s.rule0Excluded);
  const lastError = useAgentStore((s) => s.lastError);
  const dismissError = useAgentStore((s) => s.dismissError);

  const [text, setText] = useState(prefill);
  const [dropping, setDropping] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      box.current?.focus();
    }
  }, [prefill]);

  const send = () => {
    const value = text.trim();
    if (!value || running) return;
    void runPrompt(value);
    setText("");
    setDropNote(null);
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropping(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;

    if (
      !TEXTUAL.test(file.type) &&
      !/\.(txt|md|csv|json|ya?ml|log)$/i.test(file.name)
    ) {
      setDropNote(
        `${file.name} isn't a text file — paste the relevant part instead.`,
      );
      return;
    }
    if (file.size > MAX_INLINE_BYTES) {
      setDropNote(
        `${file.name} is ${Math.round(file.size / 1024)} KB; only the first 200 KB would fit in a prompt.`,
      );
      return;
    }

    const body = await file.text();
    setText((t) => `${t}${t ? "\n\n" : ""}--- ${file.name} ---\n${body}`);
    setDropNote(`Inlined ${file.name}`);
    box.current?.focus();
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => void onDrop(e)}
        className={`panel bg-obsidian border-hairline p-2.5 transition-colors flex items-end gap-2 ${dropping ? "bg-council-soft" : ""}`}
      >
        {/* Attachment Button */}
        <label className="shrink-0 cursor-pointer p-2 text-dim hover:text-fg transition-colors rounded-full hover:bg-elevated ml-1 mb-0.5">
          <input
            type="file"
            className="hidden"
            multiple
            onChange={(e) => {
              // Basic hookup for file selection (currently handles text injection as before)
              const files = Array.from(e.target.files || []);
              if (files.length > 0) {
                 const ev = { preventDefault: () => {}, dataTransfer: { files } } as unknown as DragEvent<HTMLDivElement>;
                 void onDrop(ev);
              }
              e.target.value = ''; // Reset
            }}
          />
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </label>

        <div className="flex-1 flex flex-col min-w-0">
          <textarea
            ref={box}
            rows={1}
          value={text}
          autoFocus={autoFocus}
          disabled={running}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
            placeholder={
              dropping ? "Drop a text file to inline it…" : placeholder
            }
            className="w-full resize-none bg-transparent text-[15px] leading-relaxed
              text-fg placeholder:text-muted focus:outline-none py-2 px-1 max-h-48 overflow-y-auto"
            style={{ minHeight: "40px" }}
            aria-label="Prompt"
          />

          <div className="flex items-center justify-between gap-3 pt-1 pb-1 pr-1">
            <p className="min-w-0 flex-1 text-[11px] text-muted px-2">
              {dropNote ?? (running ? "Running…" : "Enter to send · Shift+Enter for a new line")}
            </p>
            
            <div className="flex items-center gap-2">
              <MicButton
                onText={(said) => {
                  setText((t) => (t ? `${t.replace(/\s+$/, "")} ${said}` : said));
                  box.current?.focus();
                }}
              />
              <button
                type="button"
                onClick={send}
                disabled={running || !text.trim()}
                className="btn bg-fg hover:bg-black text-void border-none shadow-none shrink-0 px-4 py-1.5 rounded-full font-bold tracking-widest uppercase transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>

      {rule0 ? (
        <div className="inset-flat bg-diary px-3 py-2">
          <p className="text-[12px] leading-snug text-fg">
            This message is handled privately — it isn't embedded, indexed, or
            available to recall in any later session.
          </p>
        </div>
      ) : null}

      {lastError ? (
        <div className="inset-flat flex items-start justify-between gap-3 bg-danger-soft px-3 py-2">
          <p className="text-[12px] leading-snug text-fg">{lastError}</p>
          <button
            type="button"
            onClick={dismissError}
            className="shrink-0 text-[11px] text-dim hover:text-fg"
          >
            Dismiss
          </button>
        </div>
      ) : null}


    </div>
  );
}
