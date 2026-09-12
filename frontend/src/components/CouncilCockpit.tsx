/**
 * Prompt input plus attachment composer.
 *
 * Supports drag-and-drop and attachment of any file:
 * - Code and text files (.py, .ts, .tsx, .js, .json, .yaml, .md, .txt, .csv, etc.)
 * - Documents and images with interactive thumbnail chips and delete controls
 * - Uploads to backend /api/upload with seamless in-prompt contextual injection
 * - Push-to-talk dictation with wake-word awareness
 */

import { useEffect, useRef, useState, type DragEvent } from "react";
import { api } from "../lib/api";
import { useAgentStore } from "../store/agentStore";
import type { AttachedFile } from "../types";
import { MicButton } from "./MicButton";

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
  const stopRun = useAgentStore((s) => s.stopRun);
  const rule0 = useAgentStore((s) => s.rule0Excluded);
  const lastError = useAgentStore((s) => s.lastError);
  const dismissError = useAgentStore((s) => s.dismissError);

  const [text, setText] = useState(prefill);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [dropping, setDropping] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [isTemporary, setIsTemporary] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && running) {
        e.preventDefault();
        void stopRun();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [running, stopRun]);

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      box.current?.focus();
    }
  }, [prefill]);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setDropNote(`Attaching ${files.length} file(s)...`);

    const newAttachments: AttachedFile[] = [];
    for (const file of files) {
      try {
        // Try uploading to backend /api/upload
        const res = await api.uploadFile(file).catch(() => null);
        if (res && res.name) {
          newAttachments.push(res);
          continue;
        }

        // Client-side fallback if backend upload fails
        const isImage =
          file.type.startsWith("image/") ||
          /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);

        if (isImage) {
          const preview = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(file);
          });
          newAttachments.push({
            id: `client-${Date.now()}-${file.name}`,
            name: file.name,
            size: file.size,
            type: file.type || "image/png",
            preview,
          });
        } else {
          const content = await file.text().catch(() => "");
          newAttachments.push({
            id: `client-${Date.now()}-${file.name}`,
            name: file.name,
            size: file.size,
            type: file.type || "text/plain",
            content: content.slice(0, 200_000),
          });
        }
      } catch (err) {
        console.error("Failed to read file", file.name, err);
      }
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
      setDropNote(`Attached ${newAttachments.length} file(s)`);
    } else {
      setDropNote("Could not attach file");
    }
    box.current?.focus();
  };

  const send = () => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || running) return;
    const promptToSend = value || "Please inspect the attached file(s).";
    void runPrompt(promptToSend, attachments, isTemporary);
    setText("");
    setAttachments([]);
    setDropNote(null);
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropping(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      void handleFiles(files);
    }
  };

  return (
    <div className="space-y-3" data-tour="cockpit">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => void onDrop(e)}
        className={`rounded-2xl border bg-obsidian transition-all duration-300 shadow-[0_4px_24px_rgba(26,26,26,0.04)] focus-within:shadow-[0_8px_32px_rgba(26,26,26,0.09)] focus-within:border-fg/30 p-3.5 flex flex-col min-w-0 ${
          dropping
            ? "border-emerald-500 ring-2 ring-emerald-500/20 bg-emerald-500/5"
            : "border-hairline/90 hover:border-hairline"
        }`}
      >
        {/* Attachment Chips Display */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pt-1 pb-3 border-b border-hairline/40 mb-2">
            {attachments.map((att, i) => (
              <div
                key={att.id || i}
                className="flex items-center gap-2 bg-elevated/70 border border-hairline/80 rounded-lg px-2.5 py-1.5 text-[12px] text-fg transition-all shadow-xs"
              >
                {att.preview ? (
                  <img src={att.preview} alt="" className="size-5 object-cover rounded" />
                ) : (
                  <span className="text-[13px]">📄</span>
                )}
                <div className="flex flex-col min-w-0">
                  <span className="font-mono text-[11px] font-medium truncate max-w-[160px]">
                    {att.name}
                  </span>
                  <span className="text-dim text-[9px]">
                    {Math.round(att.size / 1024)} KB
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-muted hover:text-danger ml-1 p-0.5 rounded-full hover:bg-black/5 transition-colors cursor-pointer"
                  title="Remove attachment"
                >
                  <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Temporary Session Active Banner */}
        {isTemporary && (
          <div className="flex items-center gap-2 px-3 py-1.5 mb-2 mx-1 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-[11px] font-medium shadow-sm">
            <span className="text-[13px]">⏳</span>
            Temporary Chat Active · Automatically expires in 24 hours
          </div>
        )}

        {/* Textarea: Full width top input */}
        <textarea
          ref={box}
          rows={2}
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
          placeholder={dropping ? "Drop files to attach to this prompt…" : placeholder}
          className="w-full resize-none bg-transparent text-[15px] leading-relaxed
            text-fg placeholder:text-muted/70 focus:outline-none px-1 py-1 max-h-56 overflow-y-auto"
          style={{ minHeight: "46px" }}
          aria-label="Prompt"
        />

        {/* Bottom Toolbar: Neatly distributed and balanced */}
        <div className="flex items-center justify-between gap-3 pt-2.5 border-t border-hairline/30 mt-1">
          {/* Left Actions: Attachment + Helper Hint */}
          <div className="flex items-center gap-2 min-w-0">
            <label
              className="size-8 shrink-0 cursor-pointer rounded-full border border-hairline/80 bg-elevated/50 hover:bg-elevated text-dim hover:text-fg transition-all flex items-center justify-center hover:scale-105 active:scale-95 shadow-2xs"
              title="Attach files (code, documents, images)"
            >
              <input
                type="file"
                className="hidden"
                multiple
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length > 0) {
                    void handleFiles(files);
                  }
                  e.target.value = "";
                }}
              />
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </label>

            <button
              type="button"
              onClick={() => setIsTemporary(!isTemporary)}
              className={`size-8 shrink-0 cursor-pointer rounded-full border transition-all flex items-center justify-center hover:scale-105 active:scale-95 shadow-2xs ${
                isTemporary
                  ? "border-amber-500/50 bg-amber-500/20 text-amber-500"
                  : "border-hairline/80 bg-elevated/50 hover:bg-elevated text-dim hover:text-fg"
              }`}
              title="Temporary Chat (24h)"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            </button>

            <button
              type="button"
              onClick={() => {
                void runPrompt(
                  "Observe my active display and foreground window. Reason through what is visible, formulate hypothesis and next steps, and state clearly what you did and did not do."
                );
              }}
              disabled={running}
              className="px-2.5 py-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-[#00E5FF] text-[11px] font-medium flex items-center gap-1.5 transition-all hover:scale-105 active:scale-95 shadow-2xs cursor-pointer"
              title="Observe Screen, Reason, and Proactively Assist"
            >
              <span className="text-[12px]">👁️</span>
              <span className="hidden sm:inline">Observe Screen</span>
            </button>

            <span className="text-[11px] text-muted truncate hidden sm:inline select-none">
              {dropNote ?? (running ? "Council is working · Press Esc to Stop" : "Enter ↵ to send · Shift+Enter for newline")}
            </span>
          </div>

          {/* Right Actions: Modern Voice Controls + Send / Stop Button */}
          <div className="flex items-center gap-2 shrink-0">
            <MicButton
              onText={(said) => {
                setText((t) => (t ? `${t.replace(/\s+$/, "")} ${said}` : said));
                box.current?.focus();
              }}
            />

            {running ? (
              <button
                type="button"
                onClick={() => void stopRun()}
                aria-label="Emergency Stop"
                title="Stop Agent Execution (Esc)"
                className="h-8 px-3 rounded-full flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white font-mono text-[11px] font-bold tracking-wider uppercase transition-all duration-200 cursor-pointer shadow-md hover:scale-105 active:scale-95 animate-pulse"
              >
                <span className="size-2 rounded-xs bg-white" />
                <span>STOP</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!text.trim() && attachments.length === 0}
                aria-label="Send prompt"
                title="Send (Enter)"
                className={`size-8 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer ${
                  !text.trim() && attachments.length === 0
                    ? "bg-elevated text-muted/50 cursor-not-allowed border border-hairline/60"
                    : "bg-fg text-void hover:bg-black shadow-xs hover:shadow-md hover:scale-105 active:scale-95"
                }`}
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
                </svg>
              </button>
            )}
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
            className="shrink-0 text-[11px] text-dim hover:text-fg cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
