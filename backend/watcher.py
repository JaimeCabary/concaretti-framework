"""
Autonomous Sentinel Watcher Loop.

Runs intermittently in the background, auditing and recording system telemetry:
- Upcoming calendar deadlines (<24h)
- Active paper market positions
- Zero-trust security perimeter integrity

All events are recorded strictly to the audit log (viewable under Settings -> Logs).
Sentinel telemetry is NEVER emitted as an agent thought into active user conversation streams.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from memory import get_store
from security import load_policy, DEFAULT_POLICY_PATH


async def sentinel_loop(state: dict[str, Any]) -> None:
    store = get_store()
    ticks = 0

    while True:
        try:
            await asyncio.sleep(30)
            ticks += 1

            # 1. Calendar check -> log to audit log only
            now_ts = int(time.time())
            horizon = now_ts + 86400
            try:
                events = store.list_events_range(now_ts, horizon)
                if events and ticks % 4 == 0:
                    ev = events[0]
                    store.log_audit(
                        None,
                        "sentinel",
                        "calendar_watch",
                        "monitored",
                        f"Upcoming milestone '{ev.get('title', 'event')}' within 24h",
                    )
            except Exception:
                pass

            # 2. Market / Portfolio check -> log to audit log only
            if ticks % 4 == 0:
                try:
                    book = store.read_book() if hasattr(store, "read_book") else {}
                    pos_count = len(book.get("positions", []))
                    store.log_audit(
                        None,
                        "sentinel",
                        "market_watch",
                        "monitored",
                        f"Tracking {pos_count} paper trading position(s).",
                    )
                except Exception:
                    pass

            # 3. Security & Zero-Trust Perimeter pulse -> log to audit log only
            if ticks % 4 == 0:
                try:
                    p = load_policy(DEFAULT_POLICY_PATH)
                    enabled = len(p.enabled_agents())
                    store.log_audit(
                        None,
                        "sentinel",
                        "perimeter_heartbeat",
                        "active",
                        f"Council perimeter active. {enabled} agents authorized under .conca zero-trust policy.",
                    )
                except Exception:
                    pass

        except asyncio.CancelledError:
            break
        except Exception as exc:
            print(f"[concaretti-sentinel] watcher error: {exc}")
