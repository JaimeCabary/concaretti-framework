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

import { useRef, useState, type DragEvent } from "react";
import { useAgentStore } from "../store/agentStore";
import { MicButton } from "./MicButton";
import { Empty, relTime } from "./ui";

const MAX_INLINE_BYTES = 200_000;
const TEXTUAL =
  /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript))/;

export function CouncilCockpit({
  placeholder = "What needs doing?",
  showTimeline = true,
  autoFocus = false,
}: {
  placeholder?: string;
  showTimeline?: boolean;
  autoFocus?: boolean;
}) {
  const runPrompt = useAgentStore((s) => s.runPrompt);
  const running = useAgentStore((s) => s.running);
  const sessions = useAgentStore((s) => s.sessions);
  const attach = useAgentStore((s) => s.attachSession);
  const rule0 = useAgentStore((s) => s.rule0Excluded);
  const lastError = useAgentStore((s) => s.lastError);
  const dismissError = useAgentStore((s) => s.dismissError);

  const [text, setText] = useState("");
  const [dropping, setDropping] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

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
        className={`panel bg-obsidian border-hairline p-5 transition-colors ${dropping ? "bg-council-soft" : ""}`}
        style={{ borderRadius: "32px" }}
      >
        <div className="flex items-center gap-3 mb-2">
          <svg
            viewBox="0 0 24 24"
            className="size-4 text-dim"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z" />
          </svg>
          <span className="type-mono text-[11px] text-muted tracking-widest">
            COUNCIL COMMAND
          </span>
        </div>
        <textarea
          ref={box}
          rows={3}
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
          className="w-full resize-none bg-transparent text-[16px] leading-relaxed
            text-fg placeholder:text-muted focus:outline-none px-2"
          aria-label="Prompt"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
          <p className="min-w-0 flex-1 text-[11px] text-muted">
            {dropNote ??
              (running
                ? "Running…"
                : "Enter to send · Shift+Enter for a new line")}
          </p>
          {/*
            Appends rather than replaces, and focuses afterwards. Two thoughts
            spoken thirty seconds apart are one prompt as often as they are two,
            and overwriting the first would be unrecoverable — whereas an
            unwanted paragraph is one undo away.
          */}
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
            className="btn bg-[#FF3366] hover:bg-[#E62E5C] text-white border-none shadow-none shrink-0 px-8 py-2.5 rounded-none font-bold tracking-widest uppercase transition-colors"
          >
            {running ? "WORKING" : "SEND"}
          </button>
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

      {showTimeline ? (
        <div className="panel bg-void border-none shadow-none mt-8">
          <header className="mb-4">
            <h2 className="type-mono text-[11px] text-muted tracking-widest flex items-center gap-2">
              <svg
                viewBox="0 0 24 24"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              RECENT SESSIONS
            </h2>
          </header>
          {sessions.length === 0 ? (
            <Empty>No sessions yet.</Empty>
          ) : (
            <ul className="max-h-52 divide-y divide-hairline overflow-y-auto">
              {sessions.slice(0, 12).map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => attach(s.id)}
                    className="w-full px-4 py-3 text-left transition-colors hover:bg-elevated rounded-xl"
                  >
                    <p className="truncate text-[14px] font-semibold text-fg">
                      {s.title || s.summary || "Untitled session"}
                    </p>
                    <p className="type-mono mt-1.5 text-[10px] text-dim tracking-wide">
                      {s.role?.toUpperCase() ?? "PUBLIC"} ·{" "}
                      {relTime(s.created_at).toUpperCase()}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
