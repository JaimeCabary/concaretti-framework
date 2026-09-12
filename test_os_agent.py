"""
Concaretti Autonomous OS Agent — Live LLM Execution & Perception.
Fires real live LLMs (Gemini / Groq / OpenRouter) through the Rotator,
reasons through display state, emits live thoughts, and executes OS actions.
"""
import sys
from pathlib import Path

# Ensure backend modules are on sys.path
backend_dir = Path(__file__).resolve().parent / "backend"
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

import asyncio
from dotenv import load_dotenv
load_dotenv(backend_dir / ".env")

from rotator import get_rotator
from tools import (
    open_onscreen_keyboard,
    mouse_move,
    mouse_click,
    keyboard_type,
    detect_os_input_state,
    ExecContext,
)
from sse import SseBroker
from memory import MemoryStore
from security import load_policy


async def main():
    print("=" * 70)
    print("  CONCARETTI AUTONOMOUS OS AGENT - LIVE REASONING & EXECUTION  ")
    print("=" * 70)

    # 1. Rotator & LLM Health Check
    rotator = get_rotator()
    status = rotator.status()
    print(f"\n[1/5] Checking Multi-Model Rotator Status...")
    print(f"      Active Model:    {status['current']} ({status['current_provider']})")
    print(f"      Ladder Depth:    {status['active_count']} live models available")
    print(f"      Providers Ready: {', '.join(status['providers_available'])}")
    assert status["live_provider_configured"], "No live LLM provider found!"

    # 2. Execution Context
    print(f"\n[2/5] Initializing Policy Boundary & Memory Store...")
    broker = SseBroker()
    ctx = ExecContext(
        session_id="live-orchestration",
        role="staff",
        policy=load_policy(),
        store=MemoryStore(":memory:"),
        broker=broker,
    )
    print("      -> Zero-trust boundary loaded. Role: staff.")

    # 3. Detect OS Input State
    print(f"\n[3/5] Detecting Physical OS Input State (Keyboard & Mouse)...")
    input_state = await detect_os_input_state({}, ctx)
    print(f"      -> {input_state.get('summary')}")
    print(f"      -> Cursor Location: {input_state.get('cursor_pos')}")
    print(f"      -> Idle Time:       {input_state.get('idle_seconds')}s")

    # 4. Fire Real Live LLM for Strategic Planning & Reasoning
    print(f"\n[4/5] Firing Live LLM ({status['current']}) for Autonomous Reasoning...")
    prompt = (
        "You are the Concaretti Council OS Agent operating directly on the Windows desktop. "
        "The operator wants you to proactively demonstrate autonomous presence: "
        "Briefly state your observation of the system, your strategic hypothesis, and a punchy 1-sentence message to type onto the screen. "
        "Format your output as:\n"
        "THOUGHT: <your live reasoning>\n"
        "MESSAGE: <the exact sentence to type on screen>"
    )
    res = await rotator.complete(prompt)
    raw_text = res.text if hasattr(res, "text") else str(res)
    print("\n--- [LIVE LLM THOUGHT STREAM] ---")
    thought = ""
    message_to_type = "Concaretti Council Autonomous Agent Active"
    for line in raw_text.splitlines():
        if line.startswith("THOUGHT:"):
            thought = line.replace("THOUGHT:", "").strip()
            print(f"[THOUGHT] {thought}")
        elif line.startswith("MESSAGE:"):
            message_to_type = line.replace("MESSAGE:", "").strip()
            print(f"[MESSAGE TO TYPE] \"{message_to_type}\"")
        elif line.strip():
            print(f"   {line.strip()}")
    print("---------------------------------\n")

    # 5. Dynamic Window Perception, Companion Cursor Navigation & Execution
    print(f"[5/5] Executing OS Actions as Your Second Human...")
    from tools import launch_app, speak
    from cursor_companion import get_cursor_accompanier
    import uiautomation as auto

    accompanier = get_cursor_accompanier()

    print("      -> Launching Notepad as the target workspace...")
    await launch_app({"app": "notepad"}, ctx)
    await asyncio.sleep(2.0)

    print("      -> Inspecting UI Accessibility Tree to locate Notepad's true text input control...")
    notepad = auto.WindowControl(searchDepth=1, ClassName="Notepad")
    if not notepad.Exists(1):
        # Fallback for Windows 11 modern Notepad
        notepad = auto.WindowControl(searchDepth=1, ClassName="ApplicationFrameWindow", Name="Notepad")
        if not notepad.Exists(1):
            # General fallback to any window containing "Notepad" in title
            notepad = auto.WindowControl(searchDepth=1, RegexName=".*Notepad.*")
    
    cx, cy = 600, 350
    if notepad.Exists(1):
        print(f"      -> Found Notepad Window: '{notepad.Name}'")
        notepad.SetActive()
        await asyncio.sleep(0.5)
        
        # Find the actual text editing area to avoid "typing in the void"
        edit_control = notepad.DocumentControl()
        if not edit_control.Exists(1):
            edit_control = notepad.EditControl()
            
        if edit_control.Exists(1):
            rect = edit_control.BoundingRectangle
            cx = (rect.left + rect.right) // 2
            cy = (rect.top + rect.bottom) // 2
            print(f"      -> Found Text Edit Control at center ({cx}, {cy})")
        else:
            rect = notepad.BoundingRectangle
            cx = (rect.left + rect.right) // 2
            cy = (rect.top + rect.bottom) // 2
            print(f"      -> Edit control not found, defaulting to window center ({cx}, {cy})")
    else:
        print(f"      -> Notepad not found in UI tree, defaulting to screen coordinates ({cx}, {cy})")

    print(f"      -> Gliding Concaretti Companion Cursor with Bezier easing to ({cx}, {cy})...")
    await mouse_move({"x": cx, "y": cy, "duration": 0.9, "status": "Concaretti: Focusing"}, ctx)
    await asyncio.sleep(0.3)

    print("      -> Triggering high-contrast visual touch ripple & focusing window...")
    await mouse_click({"x": cx, "y": cy, "button": "left"}, ctx)
    await asyncio.sleep(0.5)

    print(f"      -> Typing live LLM-generated message: \"{message_to_type}\"")
    res_type = await keyboard_type(
        {"text": message_to_type, "sound": True, "wpm": 48},
        ctx,
    )
    print(f"      -> {res_type.get('summary')}")

    print("      -> Audibly reporting task completion through High-Fidelity Neural Voice...")
    await speak({"text": "Concaretti desktop task completed successfully."}, ctx)

    print("\n" + "=" * 70)
    print("SUCCESS: Live LLM reasoning, perception, and physical OS execution complete.")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
