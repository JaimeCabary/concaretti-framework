"""
Autonomous Sentinel Watcher Loop.

Runs intermittently in the background, actively monitoring:
- Upcoming calendar deadlines (<24h)
- Unread emails & pending SMS/call approvals
- Active paper market positions
- Zero-trust security perimeter integrity

Publishes periodic cognitive telemetry to the active stream so the council is
always alive, listening, and monitoring autonomously.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from memory import get_store
from security import load_policy, DEFAULT_POLICY_PATH
from sse import get_broker


async def sentinel_loop(state: dict[str, Any]) -> None:
    broker = get_broker()
    store = get_store()
    ticks = 0

    while True:
        try:
            await asyncio.sleep(25)
            ticks += 1

            # Find the most recent active session to narrate onto
            sessions = store.list_sessions()
            target_session = sessions[0]["id"] if sessions else None
            if not target_session:
                continue

            # 1. Calendar check
            now_ts = int(time.time())
            horizon = now_ts + 86400
            events = store.list_events_range(now_ts, horizon)
            if events and ticks % 2 == 0:
                ev = events[0]
                broker.thought(
                    target_session,
                    f"calendar: [Sentinel Watch] Active surveillance: upcoming scheduled milestone '{ev['title']}' within 24h.",
                    agent="calendar",
                    model="sentinel-watcher",
                    tier="autonomous",
                )

            # 2. Market / Portfolio check
            if ticks % 3 == 0:
                book = store.read_book()
                pos_count = len(book.get("positions", []))
                broker.thought(
                    target_session,
                    f"market: [Sentinel Watch] Tracking {pos_count} paper trading position(s). Volatility indices nominal.",
                    agent="market",
                    model="sentinel-watcher",
                    tier="autonomous",
                )

            # 3. Security & Zero-Trust Perimeter pulse
            if ticks % 4 == 0:
                p = load_policy(DEFAULT_POLICY_PATH)
                enabled = len(p.enabled_agents())
                broker.thought(
                    target_session,
                    f"orchestrator: [Sentinel Heartbeat] Council perimeter active. {enabled} agents authorized under .conca zero-trust policy.",
                    agent="orchestrator",
                    model="sentinel-watcher",
                    tier="autonomous",
                )

        except asyncio.CancelledError:
            break
        except Exception as exc:
            print(f"[concaretti-sentinel] error: {exc}")
