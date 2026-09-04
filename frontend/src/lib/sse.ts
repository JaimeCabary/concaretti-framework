/**
 * SSE subscription.
 *
 * `EventSource` handles reconnection itself, but it cannot send credentials
 * cross-origin and it only speaks GET — both fine here, since the stream is a
 * GET and the cookie is same-origin through the Vite proxy.
 *
 * The backend replays a session's history to every new subscriber, so a client
 * that connects late (or reconnects after a drop) receives the full run rather
 * than joining mid-way. That means the consumer must be idempotent: this module
 * hands every frame to the callback and the store dedupes by event identity.
 */

import type { SseEvent, SseEventType } from "../types";
import { sseUrl } from "./api";

const EVENT_TYPES: SseEventType[] = [
  "activity",
  "thought",
  "subtask_update",
  "halo_request",
  "halo_resolved",
  "artifact",
  "error",
  "done",
];

export interface SseHandle {
  close: () => void;
  readonly sessionId: string;
}

export function subscribe(
  sessionId: string,
  onEvent: (event: SseEvent) => void,
  onStatus?: (status: "open" | "closed" | "error") => void,
): SseHandle {
  const source = new EventSource(sseUrl(sessionId));

  source.onopen = () => onStatus?.("open");
  source.onerror = () => {
    // EventSource retries on its own; report the state without tearing down,
    // otherwise a transient blip would end the run's narration permanently.
    onStatus?.(source.readyState === EventSource.CLOSED ? "closed" : "error");
  };

  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (raw) => {
      const msg = raw as MessageEvent<string>;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        // A malformed frame should not kill the stream.
        return;
      }
      onEvent({ ...data, type } as SseEvent);
    });
  }

  return {
    sessionId,
    close: () => {
      source.close();
      onStatus?.("closed");
    },
  };
}
