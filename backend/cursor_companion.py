"""
Concaretti OS Agent — Visual Mouse Accompanier ("Second Human" Companion Cursor).
Provides an always-on-top, click-through, non-activating visual cursor overlay
that visibly signals Concaretti's navigation, target focus, and clicks
independently of the user's personal hardware mouse.
"""
from __future__ import annotations

import sys
import time
import math
import ctypes
import threading
import queue
from typing import Optional

try:
    import tkinter as tk
except ImportError:
    tk = None


class CursorAccompanier:
    """
    Renders an animated glowing companion cursor with a Concaretti badge
    and click radar ripples directly over the Windows desktop.
    Uses Win32 WS_EX_TRANSPARENT so it never intercepts user clicks or steals focus.
    """

    def __init__(self):
        self._cmd_queue: queue.Queue = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._root = None
        self._canvas = None
        self._running = False
        self._x = 400
        self._y = 300
        self._target_x = 400
        self._target_y = 300
        self._status = "Initializing..."
        self._is_clicking = False
        self._is_scrolling = False
        self._is_typing = False
        self._click_step = 0

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_ui, daemon=True, name="ConcarettiCursorThread")
        self._thread.start()
        # Wait until Tkinter window is ready
        time.sleep(0.3)

    def stop(self):
        self._running = False
        self._cmd_queue.put(("STOP", None))

    def move_to(self, x: int, y: int, duration: float = 0.5, status: str = "Concaretti"):
        """Smoothly glide Concaretti's cursor to target position."""
        self._cmd_queue.put(("MOVE", (int(x), int(y), float(duration), str(status))))

    def click(self, x: int, y: int, button: str = "left", status: str = None):
        if status:
            self.set_status(status)
        self._cmd_queue.put(("CLICK", (x, y, button)))

    def type_at(self, x: int, y: int, status: str = None):
        if status:
            self.set_status(status)
        self._cmd_queue.put(("TYPE", (x, y)))

    def scroll_at(self, x: int, y: int, amount: int, status: str = None):
        if status:
            self.set_status(status)
        self._cmd_queue.put(("SCROLL", (x, y, amount)))

    def set_status(self, status: str):
        self._cmd_queue.put(("STATUS", str(status)))

    def hide(self):
        self._cmd_queue.put(("HIDE", None))

    def show(self):
        self._cmd_queue.put(("SHOW", None))

    def _run_ui(self):
        if not tk or sys.platform != "win32":
            return

        self._root = tk.Tk()
        self._root.title("ConcarettiCursorAccompanier")
        self._root.overrideredirect(True)
        self._root.attributes("-topmost", True)
        
        # Transparent background key
        TRANSPARENT_COLOR = "#000001"
        self._root.attributes("-transparentcolor", TRANSPARENT_COLOR)
        self._root.config(bg=TRANSPARENT_COLOR)

        # Set Win32 transparent and click-through attributes
        try:
            hwnd = ctypes.windll.user32.GetParent(self._root.winfo_id())
            GWL_EXSTYLE = -20
            WS_EX_LAYERED = 0x00080000
            WS_EX_TRANSPARENT = 0x00000020
            WS_EX_NOACTIVATE = 0x08000000
            WS_EX_TOOLWINDOW = 0x00000080
            style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ctypes.windll.user32.SetWindowLongW(
                hwnd,
                GWL_EXSTYLE,
                style | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            )
        except Exception:
            pass

        width, height = 240, 140
        self._width, self._height = width, height
        self._root.geometry(f"{width}x{height}+{self._x}+{self._y}")

        self._canvas = tk.Canvas(
            self._root,
            width=width,
            height=height,
            bg=TRANSPARENT_COLOR,
            highlightthickness=0,
        )
        self._canvas.pack(fill="both", expand=True)

        self._render_loop()
        self._root.mainloop()

    def _render_loop(self):
        # 1. Process pending commands
        while not self._cmd_queue.empty():
            try:
                cmd, args = self._cmd_queue.get_nowait()
                if cmd == "STOP":
                    self._root.destroy()
                    return
                elif cmd == "MOVE":
                    tx, ty, dur, st = args
                    self._target_x = tx
                    self._target_y = ty
                    self._status = st
                    self._move_steps = max(5, int(dur * 40))
                    self._step_count = 0
                    self._start_x = self._x
                    self._start_y = self._y
                elif cmd == "CLICK":
                    cx, cy, btn = args
                    self._x = cx
                    self._y = cy
                    self._target_x = cx
                    self._target_y = cy
                    self._is_clicking = True
                    self._click_step = 0
                    self._click_button = btn
                elif cmd == "SCROLL":
                    cx, cy, amount = args
                    self._x = cx
                    self._y = cy
                    self._target_x = cx
                    self._target_y = cy
                    self._is_scrolling = True
                    self._scroll_step = 0
                    self._scroll_amount = amount
                elif cmd == "TYPE":
                    cx, cy = args
                    self._x = cx
                    self._y = cy
                    self._target_x = cx
                    self._target_y = cy
                    self._is_typing = True
                    self._type_step = 0
                elif cmd == "STATUS":
                    self._status = args
                elif cmd == "HIDE":
                    self._root.withdraw()
                elif cmd == "SHOW":
                    self._root.deiconify()
            except queue.Empty:
                break

        # 2. Smooth interpolation towards target
        if hasattr(self, "_move_steps") and self._step_count < self._move_steps:
            self._step_count += 1
            t = self._step_count / float(self._move_steps)
            # Ease out cubic
            ease = 1.0 - math.pow(1.0 - t, 3)
            self._x = int(self._start_x + (self._target_x - self._start_x) * ease)
            self._y = int(self._start_y + (self._target_y - self._start_y) * ease)
        else:
            self._x = self._target_x
            self._y = self._target_y

        # Update window position (offset so pointer tip is at cursor hot point)
        # Hot point is at (25, 25) inside the 240x140 canvas
        wx = self._x - 25
        wy = self._y - 25
        self._root.geometry(f"+{wx}+{wy}")

        # 3. Draw cursor and accompanier badge
        self._draw_overlay()
        
        # Reinforce TopMost to prevent being buried
        if self._step_count % 10 == 0:
            self._root.attributes("-topmost", True)

        if self._running:
            self._root.after(20, self._render_loop)

    def _draw_overlay(self):
        c = self._canvas
        c.delete("all")

        tip_x, tip_y = 25, 25

        # 1. Action animation if active
        if self._is_clicking:
            self._click_step += 1
            max_steps = 14
            progress = self._click_step / float(max_steps)
            r = int(6 + progress * 40)
            color = "#FF0055" if getattr(self, "_click_button", "left") == "right" else "#00F0FF"
            width = max(1, int(3 * (1.0 - progress)))
            c.create_oval(
                tip_x - r, tip_y - r, tip_x + r, tip_y + r,
                outline=color, width=width,
            )
            # Inner pulse
            if progress < 0.6:
                r_in = int(r * 0.5)
                c.create_oval(
                    tip_x - r_in, tip_y - r_in, tip_x + r_in, tip_y + r_in,
                    outline="#FFFFFF", width=2,
                )
            if self._click_step >= max_steps:
                self._is_clicking = False

        # 2. Outer glow shadow for pointer
        shadow_pts = [
            tip_x + 2, tip_y + 2,
            tip_x + 2, tip_y + 22,
            tip_x + 7, tip_y + 17,
            tip_x + 13, tip_y + 27,
            tip_x + 17, tip_y + 25,
            tip_x + 11, tip_y + 15,
            tip_x + 19, tip_y + 15,
        ]
        c.create_polygon(shadow_pts, fill="#050510", outline="#003344", width=2)

        # 3. High-visibility Electric Cyan Pointer Arrow
        pointer_pts = [
            tip_x, tip_y,
            tip_x, tip_y + 19,
            tip_x + 5, tip_y + 14,
            tip_x + 10, tip_y + 24,
            tip_x + 14, tip_y + 22,
            tip_x + 9, tip_y + 13,
            tip_x + 17, tip_y + 13,
        ]
        c.create_polygon(pointer_pts, fill="#00E5FF", outline="#FFFFFF", width=1.5)

        # 4. Floating Badge: "Concaretti" + Status
        badge_x = tip_x + 22
        badge_y = tip_y + 4
        text = self._status or "Concaretti"
        badge_w = max(88, len(text) * 7 + 22)
        badge_h = 22

        # Rounded badge background
        c.create_rectangle(
            badge_x, badge_y,
            badge_x + badge_w, badge_y + badge_h,
            fill="#090D16", outline="#00E5FF", width=1.5,
        )

        # Status pulse indicator dot
        c.create_oval(
            badge_x + 7, badge_y + 7,
            badge_x + 14, badge_y + 14,
            fill="#00FF66", outline="#FFFFFF", width=1,
        )

        # Badge text
        c.create_text(
            badge_x + 20, badge_y + 11,
            text=text, anchor="w",
            fill="#E0F7FA", font=("Segoe UI", 9, "bold"),
        )


# Global singleton accompanier
_global_accompanier: Optional[CursorAccompanier] = None


def get_cursor_accompanier() -> CursorAccompanier:
    global _global_accompanier
    if _global_accompanier is None:
        _global_accompanier = CursorAccompanier()
        _global_accompanier.start()
    return _global_accompanier


if __name__ == "__main__":
    print("Testing Concaretti Cursor Accompanier...")
    acc = get_cursor_accompanier()
    print("Gliding to (400, 200)...")
    acc.move_to(400, 200, duration=0.8, status="Concaretti: Navigating")
    time.sleep(1.0)
    print("Clicking at (400, 200)...")
    acc.click(400, 200)
    time.sleep(0.8)
    print("Gliding to (700, 450)...")
    acc.move_to(700, 450, duration=0.8, status="Concaretti: Targeting")
    time.sleep(1.0)
    print("Clicking at (700, 450)...")
    acc.click(700, 450)
    time.sleep(1.5)
    acc.stop()
    print("Test complete.")
