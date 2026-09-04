"""
diag_run.py — is the pipeline broken, or the dispatch mechanism?

`POST /api/agents/run` returns 200 and then writes nothing but the user turn,
even after 200 s of settling. Two candidates: the orchestrator itself raises or
hangs, or the background task carrying it is dropped before it runs.

The orchestrator is built during startup and stored in lifespan state, so it
cannot be reached without entering the lifespan first — this enters it
explicitly rather than going through the HTTP layer, so an exception in the
pipeline surfaces here instead of being swallowed by whatever schedules the run.
"""

from __future__ import annotations

import asyncio
import inspect
import traceback

import main

PROMPT = ("I have 400,000 naira to spend. Find the best affordable keyboard "
          "and phone stand, then complete the checkout and pay for them now.")


async def go() -> None:
    async with main.app.router.lifespan_context(main.app):
        orch = main.orch()
        print("orchestrator :", type(orch).__name__)
        try:
            print("run signature:", str(inspect.signature(orch.run)))
        except (TypeError, ValueError):
            print("run signature: unavailable")
        print("\ndispatching directly…\n", flush=True)

        try:
            out = await asyncio.wait_for(
                orch.run("diag-direct-02", PROMPT, "staff"), timeout=210
            )
            print("RETURNED:", type(out).__name__)
            print(str(out)[:5000])
        except asyncio.TimeoutError:
            print("TIMED OUT after 210 s — the pipeline hangs rather than raising")
        except Exception:
            print("RAISED:")
            traceback.print_exc()


asyncio.run(go())
