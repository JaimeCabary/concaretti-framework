import psutil
import win32gui
import win32process
import ctypes

u32 = ctypes.windll.user32
hdesk = u32.OpenInputDesktop(0, False, 0x01FF)
if hdesk:
    u32.SetThreadDesktop(hdesk)

pids = [p.pid for p in psutil.process_iter() if "notepad" in p.name().lower()]
print("Notepad PIDs:", pids)

for pid in pids:
    def _chk(h, _):
        tid, p = win32process.GetWindowThreadProcessId(h)
        if p == pid:
            print(f"HWND {h} for PID {pid}: '{win32gui.GetWindowText(h)}' class='{win32gui.GetClassName(h)}'")
    win32gui.EnumWindows(_chk, None)
