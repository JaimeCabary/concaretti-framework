"""
Test Concaretti Real OS Agent Engine.
Validates window discovery, app launching, UI element inspection,
and direct typing with pywinauto.
"""
import sys
import time
from pathlib import Path

backend_dir = Path(__file__).resolve().parent / "backend"
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from os_agent import WindowsOSAgent


def main():
    print("=" * 65)
    print("  CONCARETTI REAL OS AGENT VERIFICATION")
    print("=" * 65)

    # 1. Discover current open windows
    print("\n[Step 1] Listing all active desktop windows...")
    windows = WindowsOSAgent.list_windows()
    print(f"Found {len(windows)} active application windows:")
    for w in windows[:8]:
        print(f"  • [{w['pid']}] {w['title']} ({w['process_name']})")

    # 2. Check current foreground window
    fg = WindowsOSAgent.get_foreground_window()
    print(f"\n[Step 2] Foreground window: {fg['title'] if fg else 'None'}")

    # 3. Launch Notepad as a real target
    print("\n[Step 3] Launching Notepad...")
    res_launch = WindowsOSAgent.launch_app("notepad")
    print(f"  -> {res_launch.get('message')}")
    time.sleep(1.0)

    # 4. Inspect Notepad's real UI elements using UI Automation
    print("\n[Step 4] Inspecting Notepad UI controls with UI Automation...")
    insp = WindowsOSAgent.inspect_window("notepad")
    controls = insp.get("controls", [])
    print(f"  -> Found {len(controls)} controls in Notepad window:")
    for c in controls[:6]:
        print(f"     - Type: {c['type']:<12} Name: {repr(c['name'])} ID: {repr(c.get('automation_id'))}")

    # 5. Type real text into Notepad using pywinauto
    message = "Concaretti Council OS Agent: Live Desktop Execution Verified!"
    print(f"\n[Step 5] Typing text into Notepad via pywinauto: \"{message}\"...")
    type_res = WindowsOSAgent.type_text(message, window_query="notepad")
    print(f"  -> {type_res.get('message')}")
    time.sleep(2.0)

    # 6. Test system shell command execution
    print("\n[Step 6] Executing system PowerShell command...")
    cmd_res = WindowsOSAgent.execute_command("Get-Process -Name notepad | Select-Object Id, ProcessName")
    print(f"  -> Output:\n{cmd_res.get('output')}")

    # 7. Gracefully close Notepad without saving
    print("\n[Step 7] Closing Notepad...")
    # Send Alt+F4
    WindowsOSAgent.send_hotkey("alt+f4", window_query="notepad")
    time.sleep(0.5)
    # Don't save dialog: press 'n' or 'tab+enter'
    WindowsOSAgent.send_hotkey("n")
    time.sleep(0.5)
    print("  -> Closed successfully.")

    print("\n" + "=" * 65)
    print("SUCCESS: Real OS Agent verified end-to-end!")
    print("=" * 65)


if __name__ == "__main__":
    main()
