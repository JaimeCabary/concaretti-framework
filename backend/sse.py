"""
Server-Sent Events transport.

One in-process broker replaces the old Redis pub/sub. Each session gets a fan-out
list of subscriber queues, so a reconnecting tab or a second window both keep
receiving without stealing each other's events.

SSE rather than WebSockets because the traffic is strictly one-directional
(server narrates, client watches), it survives proxies that mangle upgrades, and
the browser reconnects on its own. Approvals travel back over a normal POST.

Queues are bounded. A subscriber that stops reading — a backgrounded mobile tab,
typically — must not let the producer grow the process heap without limit, so the
oldest event is dropped once the buffer fills.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

EventType = Literal[
    "activity",
    "thought",
    "subtask_update",
    "halo_request",
    "halo_resolved",
    "artifact",
    "error",
    "done",
    "voice_trigger",
]

QUEUE_MAXSIZE = 256
HEARTBEAT_SECONDS = 15.0


def _format_sse(event: str, data: Any) -> str:
    """
    Encode one SSE frame.

    Newlines inside the payload have to be split across `data:` lines or the
    frame terminates early, so the JSON is emitted compactly and split
    defensively.
    """
    payload = json.dumps(data, default=str, separators=(",", ":"))
    lines = "\n".join(f"data: {chunk}" for chunk in payload.split("\n"))
    return f"event: {event}\n{lines}\n\n"


class SseBroker:
    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue[str]]] = {}
        self._history: dict[str, list[tuple[str, Any]]] = {}
        self._lock = asyncio.Lock()

    # ── subscription ─────────────────────────────────────────────────────

    async def subscribe(self, session_id: str) -> asyncio.Queue[str]:
        async with self._lock:
            q: asyncio.Queue[str] = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
            self._subscribers.setdefault(session_id, []).append(q)
            # Replay what already happened so a client that connects after the
            # run started still sees the trace from the beginning.
            for event, data in self._history.get(session_id, []):
                with_frame = _format_sse(event, data)
                if not q.full():
                    q.put_nowait(with_frame)
            return q

    async def unsubscribe(self, session_id: str, q: asyncio.Queue[str]) -> None:
        async with self._lock:
            subs = self._subscribers.get(session_id)
            if not subs:
                return
            if q in subs:
                subs.remove(q)
            if not subs:
                self._subscribers.pop(session_id, None)

    # ── publication ──────────────────────────────────────────────────────

    def publish(self, session_id: str, event: EventType, data: dict[str, Any]) -> None:
        """
        Fan an event out to every subscriber of a session.

        Synchronous and non-blocking so agent code can narrate without
        awaiting — a slow reader must never stall the orchestrator.
        """
        enriched = {**data, "ts": time.time(), "session_id": session_id}
        frame = _format_sse(event, enriched)

        hist = self._history.setdefault(session_id, [])
        hist.append((event, enriched))
        if len(hist) > QUEUE_MAXSIZE:
            del hist[: len(hist) - QUEUE_MAXSIZE]

        for q in self._subscribers.get(session_id, []):
            if q.full():
                # Drop the oldest frame to make room; losing a stale narration
                # line beats unbounded growth or blocking the producer.
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(frame)
            except asyncio.QueueFull:
                pass

    def activity(self, session_id: str, message: str, **extra: Any) -> None:
        self.publish(session_id, "activity", {"message": message, **extra})

    def thought(
        self, session_id: str, text: str, *, model: str = "", tier: str = "", **extra: Any
    ) -> None:
        """
        Emit one reasoning step.

        `model` and `tier` ride along so the Staff thought stream can show which
        rung of the rotator produced each step — that visibility is the point of
        having a rotator at all.
        """
        self.publish(
            session_id,
            "thought",
            {"text": text, "model": model, "tier": tier, **extra},
        )

    def subtask(self, session_id: str, subtask: dict[str, Any]) -> None:
        self.publish(session_id, "subtask_update", subtask)

    def error(self, session_id: str, message: str, **extra: Any) -> None:
        self.publish(session_id, "error", {"message": message, **extra})

    def token(self, session_id: str, delta: str) -> None:
        self.publish(session_id, "token", {"delta": delta})

    def done(self, session_id: str, summary: str = "") -> None:
        self.publish(session_id, "done", {"summary": summary})

    def voice_trigger(self, session_id: str, message: str = "") -> None:
        self.publish(session_id, "voice_trigger", {"message": message})

    def clear_history(self, session_id: str) -> None:
        self._history.pop(session_id, None)

    # ── streaming ────────────────────────────────────────────────────────

    async def stream(self, session_id: str) -> AsyncIterator[str]:
        """
        Body generator for a `StreamingResponse`.

        Emits a comment heartbeat when idle: without it, intermediaries close a
        quiet connection and the client silently stops receiving updates.
        """
        q = await self.subscribe(session_id)
        try:
            yield _format_sse("activity", {"message": "stream connected"})
            while True:
                try:
                    frame = await asyncio.wait_for(q.get(), timeout=HEARTBEAT_SECONDS)
                    yield frame
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            raise
        finally:
            await self.unsubscribe(session_id, q)


_broker: SseBroker | None = None


def get_broker() -> SseBroker:
    global _broker
    if _broker is None:
        _broker = SseBroker()
    return _broker
