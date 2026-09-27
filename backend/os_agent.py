"""
Concaretti OS Agent — Intelligent Reasoning Agent for Windows Desktop.

Architecture:
  ReAct loop: perceive -> think (LLM) -> act (primitive) -> observe -> repeat

The agent is NOT a hardcoded script. It receives a plain-English task,
reasons about live desktop state using real Win32 observations,
decides which primitive to invoke, and adapts based on what it sees.
"""
from __future__ import annotations

import asyncio
import base64
import ctypes
import ctypes.wintypes as _wt
import io
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import psutil

# Ensure the backend directory is on sys.path so rotator/memory/etc. are importable
# regardless of where os_agent.py is imported from.
_BACKEND_DIR = str(Path(__file__).resolve().parent)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# ---------------------------------------------------------------------------
# 0. Desktop isolation fix — MUST run before any COM/GUI imports
# ---------------------------------------------------------------------------
if sys.platform == "win32":
    try:
        _u32 = ctypes.windll.user32
        _hdesk = _u32.OpenInputDesktop(0, False, 0x01FF)
        if _hdesk:
            _u32.SetThreadDesktop(_hdesk)
    except Exception:
        pass

try:
    import pywinauto
    from pywinauto import Application, Desktop
    from pywinauto.keyboard import send_keys as _pwa_send_keys
    _HAS_PYWINAUTO = True
except Exception:
    _HAS_PYWINAUTO = False

try:
    import uiautomation as _auto
    _HAS_UIA = True
except Exception:
    _HAS_UIA = False

try:
    from PIL import Image, ImageGrab
    _HAS_PIL = True
except Exception:
    _HAS_PIL = False


# ---------------------------------------------------------------------------
# 1. Raw OS primitives (the only things the LLM can call)
# ---------------------------------------------------------------------------

def _attach() -> None:
    if sys.platform != "win32":
        return
    try:
        u32 = ctypes.windll.user32
        hd = u32.OpenInputDesktop(0, False, 0x01FF)
        if hd:
            u32.SetThreadDesktop(hd)
    except Exception:
        pass


def _create_process_on_default_desktop(cmdline: str) -> dict[str, Any]:
    """
    CreateProcess with lpDesktop = WinSta0\\Default so the child window
    appears on the interactive session even when this process runs on a
    service/sandboxed desktop.
    """
    class _SI(ctypes.Structure):
        _fields_ = [
            ("cb", _wt.DWORD), ("lpReserved", _wt.LPWSTR),
            ("lpDesktop", _wt.LPWSTR), ("lpTitle", _wt.LPWSTR),
            ("dwX", _wt.DWORD), ("dwY", _wt.DWORD),
            ("dwXSize", _wt.DWORD), ("dwYSize", _wt.DWORD),
            ("dwXCountChars", _wt.DWORD), ("dwYCountChars", _wt.DWORD),
            ("dwFillAttribute", _wt.DWORD), ("dwFlags", _wt.DWORD),
            ("wShowWindow", _wt.WORD), ("cbReserved2", _wt.WORD),
            ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
            ("hStdInput", _wt.HANDLE), ("hStdOutput", _wt.HANDLE),
            ("hStdError", _wt.HANDLE),
        ]

    class _PI(ctypes.Structure):
        _fields_ = [
            ("hProcess", _wt.HANDLE), ("hThread", _wt.HANDLE),
            ("dwProcessId", _wt.DWORD), ("dwThreadId", _wt.DWORD),
        ]

    si, pi = _SI(), _PI()
    si.cb = ctypes.sizeof(_SI)
    si.lpDesktop = r"WinSta0\Default"
    k32 = ctypes.windll.kernel32
    ok = k32.CreateProcessW(
        None, cmdline, None, None, False, 0x00000008, None, None,
        ctypes.byref(si), ctypes.byref(pi),
    )
    if not ok:
        return {"ok": False, "error": f"CreateProcess error {k32.GetLastError()}"}
# ---------------------------------------------------------------------------
# Dynamic Windows Application Discovery & Resolution
# ---------------------------------------------------------------------------

_BUILTIN_APPS: dict[str, str] = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "calc": "calc.exe",
    "explorer": "explorer.exe",
    "files": "explorer.exe",
    "terminal": "wt.exe",
    "wt": "wt.exe",
    "cmd": "cmd.exe",
    "powershell": "powershell.exe",
    "pwsh": "powershell.exe",
    "taskmanager": "taskmgr.exe",
    "taskmgr": "taskmgr.exe",
    "chrome": "chrome.exe",
    "googlechrome": "chrome.exe",
    "edge": "msedge.exe",
    "msedge": "msedge.exe",
    "code": "code.cmd",
    "vscode": "code.cmd",
    "antigravity": "antigravity.exe",
    "paint": "mspaint.exe",
    "mspaint": "mspaint.exe",
    "wordpad": "write.exe",
    "settings": "ms-settings:",
    "spotify": "spotify.exe",
    "discord": "discord.exe",
    "slack": "slack.exe",
}

_DISCOVERED_APPS: dict[str, str] = {}
_LAST_SCAN_TIME: float = 0.0


def _normalize_app_key(name: str) -> str:
    """Normalize application name into a clean lowercase alphanumeric key."""
    s = name.lower().strip()
    if s.endswith(".exe") or s.endswith(".lnk") or s.endswith(".cmd") or s.endswith(".bat"):
        s = s.rsplit(".", 1)[0]
    return re.sub(r"[^a-z0-9]", "", s)


def scan_installed_apps(force_refresh: bool = False) -> dict[str, str]:
    """
    Scan the Windows system to dynamically discover all installed applications
    from Start Menu shortcuts, WindowsApps, Registry App Paths, Uninstall keys,
    and standard user directories.
    """
    global _DISCOVERED_APPS, _LAST_SCAN_TIME
    now = time.time()
    # Cache for 10 minutes unless forced
    if _DISCOVERED_APPS and not force_refresh and (now - _LAST_SCAN_TIME < 600):
        return _DISCOVERED_APPS

    apps: dict[str, str] = dict(_BUILTIN_APPS)

    if sys.platform != "win32":
        _DISCOVERED_APPS = apps
        _LAST_SCAN_TIME = now
        return _DISCOVERED_APPS

    # 1. Local AppData / Roaming paths for common user-installed software
    user_profile = os.environ.get("USERPROFILE", "")
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    app_data = os.environ.get("APPDATA", "")
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    program_data = os.environ.get("ProgramData", r"C:\ProgramData")

    # Specific well-known targets
    target_candidates = [
        ("spotify", os.path.join(app_data, "Spotify", "Spotify.exe")),
        ("spotify", os.path.join(local_app_data, "Microsoft", "WindowsApps", "Spotify.exe")),
        ("code", os.path.join(local_app_data, "Programs", "Microsoft VS Code", "Code.exe")),
        ("vscode", os.path.join(local_app_data, "Programs", "Microsoft VS Code", "Code.exe")),
        ("code", os.path.join(program_files, "Microsoft VS Code", "Code.exe")),
        ("vscode", os.path.join(program_files, "Microsoft VS Code", "Code.exe")),
        ("antigravity", os.path.join(local_app_data, "Programs", "antigravity", "antigravity.exe")),
        ("antigravity", os.path.join(user_profile, ".gemini", "antigravity-ide", "antigravity.exe")),
        ("discord", os.path.join(local_app_data, "Discord", "Update.exe")),
        ("slack", os.path.join(local_app_data, "slack", "slack.exe")),
    ]
    for key, path in target_candidates:
        if path and os.path.exists(path):
            apps[key] = path
            apps[_normalize_app_key(key)] = path

    # 2. WindowsApps execution aliases (Spotify, wt, python, winget, etc.)
    win_apps_dir = os.path.join(local_app_data, "Microsoft", "WindowsApps")
    if os.path.isdir(win_apps_dir):
        try:
            for item in os.listdir(win_apps_dir):
                if item.lower().endswith(".exe"):
                    p = os.path.join(win_apps_dir, item)
                    stem = item[:-4].lower()
                    apps[stem] = p
                    apps[_normalize_app_key(stem)] = p
        except Exception:
            pass

    # 3. Start Menu Shortcuts (.lnk)
    start_menu_dirs = [
        os.path.join(app_data, "Microsoft", "Windows", "Start Menu", "Programs"),
        os.path.join(program_data, "Microsoft", "Windows", "Start Menu", "Programs"),
        os.path.join(user_profile, "Desktop"),
        os.path.join(os.environ.get("PUBLIC", r"C:\Users\Public"), "Desktop"),
    ]
    for sm_dir in start_menu_dirs:
        if not os.path.isdir(sm_dir):
            continue
        try:
            for root, _, files in os.walk(sm_dir):
                for f in files:
                    if f.lower().endswith(".lnk"):
                        name = f[:-4]
                        full_lnk = os.path.join(root, f)
                        norm = _normalize_app_key(name)
                        if norm:
                            apps[norm] = full_lnk
                            apps[name.lower()] = full_lnk
        except Exception:
            pass

    # 4. Windows Registry App Paths (HKLM & HKCU)
    try:
        import winreg

        for hkey in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                sub = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"
                with winreg.OpenKey(hkey, sub) as key:
                    num_subkeys = winreg.QueryInfoKey(key)[0]
                    for i in range(num_subkeys):
                        try:
                            sname = winreg.EnumKey(key, i)
                            with winreg.OpenKey(key, sname) as app_key:
                                val, _ = winreg.QueryValueEx(app_key, "")
                                if val and os.path.exists(val):
                                    stem = sname.lower()
                                    if stem.endswith(".exe"):
                                        stem = stem[:-4]
                                    apps[stem] = val
                                    apps[_normalize_app_key(stem)] = val
                        except Exception:
                            continue
            except Exception:
                pass
    except Exception:
        pass

    _DISCOVERED_APPS = apps
    _LAST_SCAN_TIME = now
    return _DISCOVERED_APPS


def resolve_app_path(app: str) -> str:
    """
    Resolve an app name to its executable or launcher target.
    Supports exact, normalized, prefix, and fuzzy matching against all installed software.
    """
    clean = app.strip()
    if not clean:
        return app

    # URI schemes or direct existing files pass straight through
    if clean.startswith("ms-") or clean.startswith("http") or (":" in clean and ("\\" in clean or "/" in clean)) and os.path.exists(clean):
        return clean

    app_map = scan_installed_apps()
    lower = clean.lower()
    norm = _normalize_app_key(clean)

    # Direct hits
    if lower in app_map:
        return app_map[lower]
    if norm in app_map:
        return app_map[norm]

    # Substring search in discovered app map
    for k, v in app_map.items():
        if norm in k or k in norm:
            return v

    # Fallback to direct app name (e.g. system PATH executable)
    return clean


_APP_MAP = scan_installed_apps()


def p_list_windows() -> dict[str, Any]:
    """List all visible top-level windows."""
    _attach()
    results: list[dict] = []
    if sys.platform != "win32":
        return {"windows": results}
    try:
        import win32gui, win32process

        def _cb(hwnd: int, _: Any) -> None:
            if not win32gui.IsWindowVisible(hwnd):
                return
            title = win32gui.GetWindowText(hwnd).strip()
            if not title:
                return
            rect = win32gui.GetWindowRect(hwnd)
            w, h = rect[2] - rect[0], rect[3] - rect[1]
            if w < 5 or h < 5:
                return
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            pname = ""
            try:
                pname = psutil.Process(pid).name()
            except Exception:
                pass
            results.append({
                "hwnd": hwnd, "title": title,
                "process": pname, "pid": pid,
                "class": win32gui.GetClassName(hwnd),
                "w": w, "h": h,
            })

        win32gui.EnumWindows(_cb, None)
    except Exception as exc:
        return {"windows": results, "warning": str(exc)}
    return {"windows": results}


def p_get_foreground_window() -> dict[str, Any]:
    """Return the currently focused window."""
    _attach()
    if sys.platform != "win32":
        return {"hwnd": None}
    try:
        import win32gui, win32process
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return {"hwnd": None}
        title = win32gui.GetWindowText(hwnd)
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        pname = ""
        try:
            pname = psutil.Process(pid).name()
        except Exception:
            pass
        return {"hwnd": hwnd, "title": title, "process": pname, "pid": pid}
    except Exception as exc:
        return {"hwnd": None, "error": str(exc)}


def p_launch_process(app: str, args: str = "") -> dict[str, Any]:
    """
    Launch an application on the interactive desktop.
    app: friendly name ('spotify', 'code', 'notepad') or full executable path.
    args: optional extra command-line arguments.
    """
    _attach()
    target = resolve_app_path(app)

    # Shell URI protocols (e.g. ms-settings:, spotify:) or .lnk shortcuts
    if target.startswith("ms-") or target.startswith("http") or (":" in target and "\\" not in target and "/" not in target):
        try:
            os.startfile(target)
            return {"status": "launched", "via": "protocol", "target": target}
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    if target.lower().endswith(".lnk"):
        try:
            os.startfile(target)
            return {"status": "launched", "via": "shortcut", "target": target}
        except Exception as exc:
            pass

    # Ensure executable paths with spaces are properly quoted
    cmd_base = f'"{target}"' if (" " in target and not target.startswith('"')) else target
    cmdline = f"{cmd_base} {args}".strip() if args else cmd_base

    if sys.platform == "win32":
        res = _create_process_on_default_desktop(cmdline)
        if not res.get("ok"):
            # Fallback to start command via shell if CreateProcess fails on special alias
            try:
                subprocess.Popen(f'start "" {cmdline}', shell=True)
                return {"status": "launched", "via": "shell_fallback", "target": cmdline}
            except Exception as e2:
                return {"status": "error", "error": f"{res.get('error')} | fallback: {e2}"}

        pid = res["pid"]
        matched_hwnd = None
        matched_title = ""
        for _ in range(20):
            time.sleep(0.25)
            for w in p_list_windows().get("windows", []):
                if w["pid"] == pid:
                    matched_hwnd = w["hwnd"]
                    matched_title = w["title"]
                    break
            if matched_hwnd:
                break
        out: dict[str, Any] = {"status": "launched", "pid": pid, "cmdline": cmdline}
        if matched_hwnd:
            out["hwnd"] = matched_hwnd
            out["title"] = matched_title
        else:
            out["note"] = "Window appeared or is starting in background."
        return out

    try:
        proc = subprocess.Popen(cmdline, shell=True)
        return {"status": "launched", "pid": proc.pid}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}



def p_focus_window_by_hwnd(hwnd: int) -> dict[str, Any]:
    """Bring window to the foreground."""
    _attach()
    if sys.platform != "win32":
        return {"status": "error", "error": "Windows only"}
    try:
        import win32gui, win32process
        k32, u32 = ctypes.windll.kernel32, ctypes.windll.user32
        win32gui.ShowWindow(hwnd, 9)
        curr = k32.GetCurrentThreadId()
        tgt, _ = win32process.GetWindowThreadProcessId(hwnd)
        attached = bool(u32.AttachThreadInput(curr, tgt, True)) if curr != tgt else False
        u32.BringWindowToTop(hwnd)
        u32.SetForegroundWindow(hwnd)
        if attached:
            u32.AttachThreadInput(curr, tgt, False)
        time.sleep(0.15)
        return {"status": "ok", "hwnd": hwnd, "title": win32gui.GetWindowText(hwnd)}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def p_close_window_by_hwnd(hwnd: int, force: bool = False) -> dict[str, Any]:
    """Close or force-kill a window."""
    _attach()
    if sys.platform != "win32":
        return {"status": "error", "error": "Windows only"}
    try:
        import win32gui, win32process, win32con
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        if force and pid:
            psutil.Process(pid).terminate()
            return {"status": "ok", "action": "terminated", "pid": pid}
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
        return {"status": "ok", "action": "wm_close_sent"}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def p_type_text(text: str) -> dict[str, Any]:
    """Type text into the currently focused window."""
    _attach()
    try:
        if _HAS_PYWINAUTO:
            _pwa_send_keys(text, with_spaces=True, with_tabs=True, with_newlines=True)
        else:
            import pyautogui
            pyautogui.FAILSAFE = False
            pyautogui.write(text)
        return {"status": "ok", "chars": len(text)}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def p_send_keys(keys: str) -> dict[str, Any]:
    """
    Send a key combination. Examples: 'ctrl+s', 'alt+f4', '{ENTER}'.
    Notation: ^ Ctrl, % Alt, + Shift, # Win. Special: {ENTER} {TAB} {ESC}.
    """
    _attach()
    try:
        if _HAS_PYWINAUTO:
            normalised = keys
            if "+" in keys and not keys.startswith("{"):
                parts = [p.strip().lower() for p in keys.split("+")]
                mods = {"ctrl": "^", "alt": "%", "shift": "+", "win": "#"}
                seq = ""
                for part in parts:
                    if part in mods:
                        seq += mods[part]
                    else:
                        seq += part if len(part) == 1 else f"{{{part.upper()}}}"
                normalised = seq
            _pwa_send_keys(normalised)
        else:
            import pyautogui
            pyautogui.FAILSAFE = False
            pyautogui.hotkey(*[p.strip() for p in keys.split("+")])
        return {"status": "ok", "keys": keys}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def p_click_at(x: int, y: int, button: str = "left", clicks: int = 1) -> dict[str, Any]:
    """Click at desktop coordinates."""
    _attach()
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        pyautogui.click(x=x, y=y, clicks=clicks, button=button)
        return {"status": "ok", "x": x, "y": y}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def p_inspect_window(hwnd: int, max_controls: int = 50) -> dict[str, Any]:
    """Walk the UIA tree and return interactive controls with coordinates."""
    _attach()
    controls: list[dict] = []
    title = ""

    if _HAS_UIA:
        try:
            win_ctrl = _auto.ControlFromHandle(hwnd)
            if win_ctrl:
                title = win_ctrl.Name
                _CTYPES = {
                    _auto.ControlType.ButtonControl: "Button",
                    _auto.ControlType.EditControl: "Edit",
                    _auto.ControlType.DocumentControl: "Document",
                    _auto.ControlType.CheckBoxControl: "CheckBox",
                    _auto.ControlType.RadioButtonControl: "RadioButton",
                    _auto.ControlType.ComboBoxControl: "ComboBox",
                    _auto.ControlType.TabItemControl: "Tab",
                    _auto.ControlType.MenuItemControl: "MenuItem",
                    _auto.ControlType.HyperlinkControl: "Link",
                    _auto.ControlType.ListItemControl: "ListItem",
                }
                for c, _ in _auto.WalkControl(win_ctrl, maxDepth=4):
                    if c.ControlType in _CTYPES:
                        r = c.BoundingRectangle
                        val = ""
                        try:
                            if hasattr(c, "ValuePattern") and c.ValuePattern:
                                val = c.ValuePattern.Value
                        except Exception:
                            pass
                        controls.append({
                            "name": c.Name.strip(), "type": _CTYPES[c.ControlType],
                            "id": c.AutomationId,
                            "cx": (r.left + r.right) // 2,
                            "cy": (r.top + r.bottom) // 2,
                            "value": val,
                        })
                        if len(controls) >= max_controls:
                            break
        except Exception:
            pass

    if not controls and _HAS_PYWINAUTO:
        try:
            app = Application(backend="uia").connect(handle=hwnd)
            dlg = app.window(handle=hwnd)
            title = dlg.window_text()
            for c in dlg.descendants():
                try:
                    r = c.rectangle()
                    controls.append({
                        "name": c.window_text().strip(),
                        "type": c.friendly_class_name(),
                        "id": getattr(c.element_info, "automation_id", ""),
                        "cx": (r.left + r.right) // 2,
                        "cy": (r.top + r.bottom) // 2,
                        "value": "",
                    })
                    if len(controls) >= max_controls:
                        break
                except Exception:
                    continue
        except Exception:
            pass

    return {"hwnd": hwnd, "title": title, "controls": controls}


def p_run_shell(command: str, shell: str = "powershell", timeout: int = 30) -> dict[str, Any]:
    """Run a PowerShell or CMD command."""
    if not command.strip():
        return {"status": "error", "error": "Empty command"}
    if shell.lower() in ("powershell", "pwsh"):
        args = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
    else:
        args = ["cmd.exe", "/c", command]
    try:
        r = subprocess.run(args, capture_output=True, text=True,
                           timeout=timeout, cwd=str(Path.home()))
        return {
            "status": "ok", "exit_code": r.returncode,
            "stdout": r.stdout.strip()[:4000],
            "stderr": r.stderr.strip()[:1000],
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": f"Timed out after {timeout}s"}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def p_capture_screen(hwnd: int | None = None) -> dict[str, Any]:
    """Capture the desktop (or a window) as base64 PNG."""
    _attach()
    img = None

    if hwnd and _HAS_PIL:
        try:
            import win32gui
            rect = win32gui.GetWindowRect(hwnd)
            w, h = rect[2] - rect[0], rect[3] - rect[1]
            if w > 0 and h > 0:
                img = ImageGrab.grab(bbox=(rect[0], rect[1], rect[2], rect[3]))
        except Exception:
            pass

    if not img:
        try:
            import mss, mss.tools
            with mss.mss() as sct:
                mon = sct.monitors[1]
                raw = sct.grab(mon)
                png = mss.tools.to_png(raw.rgb, raw.size)
                return {
                    "image_b64": base64.b64encode(png).decode(),
                    "w": raw.size.width, "h": raw.size.height,
                }
        except Exception:
            pass

    if not img and _HAS_PIL:
        try:
            img = ImageGrab.grab()
        except Exception:
            pass

    if img:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return {
            "image_b64": base64.b64encode(buf.getvalue()).decode(),
            "w": img.width, "h": img.height,
        }

    return {"error": "screen capture unavailable"}


async def p_read_screen(hwnd: int | None = None) -> dict[str, Any]:
    """Capture the screen and describe it with the vision LLM."""
    snap = p_capture_screen(hwnd)
    if "error" in snap:
        return snap
    from rotator import get_rotator
    rotator = get_rotator()
    result = await rotator.complete_vision(
        "Describe every window, dialog, and UI element visible. "
        "Note any text fields, buttons, errors, and their positions.",
        snap["image_b64"],
        system="You are a precise desktop automation assistant. Be concise.",
        temperature=0.1,
    )
    return {"description": result.text}


def p_write_file(path: str, content: str) -> dict[str, Any]:
    """Write text or code content directly to a file on disk."""
    try:
        p = Path(path).expanduser().resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return {"status": "ok", "path": str(p), "bytes": len(content)}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def p_read_file(path: str) -> dict[str, Any]:
    """Read contents of a file from disk."""
    try:
        p = Path(path).expanduser().resolve()
        if not p.exists():
            return {"status": "error", "error": f"File not found: {path}"}
        content = p.read_text(encoding="utf-8", errors="replace")
        return {"status": "ok", "path": str(p), "content": content[:10000], "total_len": len(content)}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


# ---------------------------------------------------------------------------
# 2. Tool registry
# ---------------------------------------------------------------------------

_TOOLS: dict[str, dict[str, Any]] = {
    "list_windows": {
        "fn": p_list_windows, "async": False, "params": {},
        "desc": "List all visible top-level windows. Returns [{hwnd, title, process, pid, w, h}].",
    },
    "get_foreground_window": {
        "fn": p_get_foreground_window, "async": False, "params": {},
        "desc": "Return hwnd/title/process of the currently focused window.",
    },
    "launch_process": {
        "fn": p_launch_process, "async": False,
        "params": {"app": "str", "args": "str (optional)"},
        "desc": "Launch an app by friendly name (spotify, code, antigravity, notepad, chrome) or full exe path. Returns hwnd when window appears.",
    },
    "focus_window_by_hwnd": {
        "fn": p_focus_window_by_hwnd, "async": False,
        "params": {"hwnd": "int"},
        "desc": "Bring a window to the foreground by its hwnd.",
    },
    "close_window_by_hwnd": {
        "fn": p_close_window_by_hwnd, "async": False,
        "params": {"hwnd": "int", "force": "bool (default false)"},
        "desc": "Close a window gracefully or force-kill its process.",
    },
    "type_text": {
        "fn": p_type_text, "async": False,
        "params": {"text": "str"},
        "desc": "Type text into the currently focused window.",
    },
    "send_keys": {
        "fn": p_send_keys, "async": False,
        "params": {"keys": "str"},
        "desc": "Send key combo. Examples: 'ctrl+s', 'alt+f4', '{ENTER}', '{ESC}'. ^ Ctrl, % Alt, + Shift.",
    },
    "click_at": {
        "fn": p_click_at, "async": False,
        "params": {"x": "int", "y": "int", "button": "str (left/right)", "clicks": "int"},
        "desc": "Move mouse and click at screen coordinates.",
    },
    "inspect_window": {
        "fn": p_inspect_window, "async": False,
        "params": {"hwnd": "int", "max_controls": "int (default 50)"},
        "desc": "Read UIA accessibility tree: buttons, inputs, menus with (cx, cy) coordinates.",
    },
    "write_file": {
        "fn": p_write_file, "async": False,
        "params": {"path": "str", "content": "str"},
        "desc": "Write code or text content directly to a file on disk (creates parent directories if needed).",
    },
    "read_file": {
        "fn": p_read_file, "async": False,
        "params": {"path": "str"},
        "desc": "Read file text from disk.",
    },
    "run_shell": {
        "fn": p_run_shell, "async": False,
        "params": {"command": "str", "shell": "str (powershell/cmd)", "timeout": "int"},
        "desc": "Execute a shell command. Returns stdout, stderr, exit_code.",
    },
    "capture_screen": {
        "fn": p_capture_screen, "async": False,
        "params": {"hwnd": "int (optional — omit for full desktop)"},
        "desc": "Take a screenshot. Returns base64 PNG. Use read_screen for LLM interpretation.",
    },
    "read_screen": {
        "fn": p_read_screen, "async": True,
        "params": {"hwnd": "int (optional)"},
        "desc": "Capture the screen and have the vision model describe everything visible.",
    },
    "done": {
        "fn": None, "async": False,
        "params": {"result": "str — summary of what was accomplished"},
        "desc": "Declare the task complete. ALWAYS call this when finished.",
    },
    "fail": {
        "fn": None, "async": False,
        "params": {"reason": "str — why the task cannot be completed"},
        "desc": "Declare the task impossible and explain why.",
    },
}


def _tool_catalogue() -> str:
    lines = []
    for name, meta in _TOOLS.items():
        param_str = json.dumps(meta["params"]) if meta["params"] else "{}"
        lines.append(f'  {name}: {meta["desc"]}\n    params: {param_str}')
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 3. Reasoning agent (ReAct loop)
# ---------------------------------------------------------------------------

_SYSTEM = """\
You are an intelligent Windows desktop automation agent.

Rules:
1. THINK before every action — state your reasoning in "thought".
2. Call exactly ONE tool per response.
3. Use real hwnds from list_windows or launch_process output — never guess.
4. If a step fails, reason about why and try a different approach.
5. Do not follow a hardcoded script. React to what you actually observe.
6. When the task is done, call done(). If impossible, call fail().

Respond with ONLY valid JSON, no prose outside it:
{
  "thought": "your reasoning",
  "tool": "<tool_name>",
  "args": { ... }
}
"""


class OSAgent:
    """
    Intelligent OS agent. Receives a task in plain English and executes it
    by reasoning in a ReAct loop backed by the project LLM rotator.
    """

    def __init__(self, max_steps: int = 20, verbose: bool = True) -> None:
        self.max_steps = max_steps
        self.verbose = verbose

    def _log(self, *a: Any) -> None:
        if self.verbose:
            msg = " ".join(str(x) for x in a)
            safe = msg.encode(sys.stdout.encoding or "utf-8", errors="replace").decode(sys.stdout.encoding or "utf-8", errors="replace")
            print("[OSAgent]", safe, flush=True)

    async def run(self, task: str) -> dict[str, Any]:
        from rotator import get_rotator, extract_json
        rotator = get_rotator()
        history: list[dict[str, Any]] = []
        self._log(f"Task: {task!r}")

        for step in range(1, self.max_steps + 1):
            prompt = _build_prompt(task, history)
            call = await rotator.complete(prompt, system=_SYSTEM, json_mode=True, temperature=0.2)
            raw = call.text
            self._log(f"Step {step} [{call.model_id}]: {raw[:300]}")

            parsed = extract_json(raw)
            if not parsed:
                history.append({
                    "thought": "(parse error)", "tool": "(none)", "args": {},
                    "observation": f"Invalid JSON from model. Raw: {raw[:200]}",
                })
                continue

            thought = parsed.get("thought", "")
            tool_name = parsed.get("tool", "").strip()
            args = parsed.get("args") or {}

            if tool_name not in _TOOLS:
                history.append({
                    "thought": thought, "tool": tool_name, "args": args,
                    "observation": f"Unknown tool '{tool_name}'. Available: {list(_TOOLS)}",
                })
                continue

            if tool_name == "done":
                result = args.get("result", "Task completed.")
                self._log(f"DONE: {result}")
                return {"status": "done", "result": result, "steps": history, "model": call.model_id}

            if tool_name == "fail":
                reason = args.get("reason", "Unknown failure.")
                self._log(f"FAIL: {reason}")
                return {"status": "fail", "result": reason, "steps": history, "model": call.model_id}

            observation = await _invoke(tool_name, args)
            self._log(f"  obs: {str(observation)[:300]}")
            history.append({"thought": thought, "tool": tool_name, "args": args, "observation": observation})

        return {
            "status": "max_steps",
            "result": f"Stopped after {self.max_steps} steps without completing the task.",
            "steps": history,
            "model": "",
        }


async def _invoke(tool_name: str, args: dict[str, Any]) -> Any:
    meta = _TOOLS[tool_name]
    fn = meta["fn"]
    try:
        if meta["async"]:
            return await fn(**args)
        return fn(**args)
    except TypeError as te:
        return {"error": f"Bad args for {tool_name}: {te}"}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def _build_prompt(task: str, history: list[dict[str, Any]]) -> str:
    lines = [f"TASK: {task}\n"]
    if not history:
        lines.append("Step 1 — no actions taken yet.")
        lines.append("Start by observing the desktop (list_windows or get_foreground_window).")
    else:
        lines.append(f"History ({len(history)} steps):")
        for i, h in enumerate(history, 1):
            obs = h["observation"]
            obs_str = json.dumps(obs) if not isinstance(obs, str) else obs
            if len(obs_str) > 2000:
                obs_str = obs_str[:2000] + " ...[truncated]"
            lines.append(
                f"\n[Step {i}]\nThought: {h['thought']}\n"
                f"Tool: {h['tool']}  Args: {json.dumps(h['args'])}\n"
                f"Observation: {obs_str}"
            )
    lines.append(f"\nAvailable tools:\n{_tool_catalogue()}")
    lines.append("\nRespond with valid JSON only.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 4. Sync wrapper
# ---------------------------------------------------------------------------

def run_task(task: str, max_steps: int = 20, verbose: bool = True) -> dict[str, Any]:
    """
    Synchronous entry point. Works from both sync and async callers.

    Usage:
        from os_agent import run_task
        result = run_task("Open Notepad and type hello world")
        print(result["result"])
    """
    agent = OSAgent(max_steps=max_steps, verbose=verbose)
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                return pool.submit(asyncio.run, agent.run(task)).result()
        return loop.run_until_complete(agent.run(task))
    except RuntimeError:
        return asyncio.run(agent.run(task))


# ---------------------------------------------------------------------------
# 5. CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    _task = " ".join(sys.argv[1:]) or "List all open windows."
    _r = run_task(_task)
    print("\n" + "=" * 60)
    print(f"Status : {_r['status']}")
    print(f"Result : {_r['result']}")
    print(f"Steps  : {len(_r.get('steps', []))}")
