"""
High-Visibility OS-Level Click & Pointer Visualizer ("HeyClicky" Style).
Renders high-visibility animated touch ripples, fingerprints, and pointer
markers directly over the Windows desktop at exact physical coordinates (x, y).
"""
import sys
import ctypes
import math

def render_click(x: int, y: int, button: str = "left", duration_ms: int = 750):
    try:
        import tkinter as tk
    except ImportError:
        return

    root = tk.Tk()
    root.title("ConcarettiPointerOverlay")
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.attributes("-transparentcolor", "#010101")
    root.config(bg="#010101")

    # Set Win32 transparent and click-through attributes
    try:
        hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
        GWL_EXSTYLE = -20
        WS_EX_LAYERED = 0x00080000
        WS_EX_TRANSPARENT = 0x00000020
        WS_EX_NOACTIVATE = 0x08000000
        WS_EX_TOOLWINDOW = 0x00000080
        style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        ctypes.windll.user32.SetWindowLongW(
            hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
        )
    except Exception:
        pass

    size = 180
    cx, cy = size // 2, size // 2
    root.geometry(f"{size}x{size}+{x - cx}+{y - cy}")

    canvas = tk.Canvas(root, width=size, height=size, bg="#010101", highlightthickness=0)
    canvas.pack()

    # Color palette
    is_right = button.lower() == "right"
    primary_color = "#FF0055" if is_right else "#00E5FF"     # Electric Pink or Cyan
    secondary_color = "#FF9900" if is_right else "#FFE600"   # Amber or Neon Yellow

    steps = 18
    step = 0
    interval = max(15, duration_ms // steps)

    def animate():
        nonlocal step
        canvas.delete("all")
        if step >= steps:
            root.destroy()
            return

        progress = step / float(steps)

        # 1. Outer expanding radar ring
        r_outer = int(25 + progress * 55)
        w_outer = max(1, int(4 * (1.0 - progress)))
        canvas.create_oval(cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer, outline=primary_color, width=w_outer)

        # 2. Secondary ripple wave
        if progress > 0.2:
            p2 = (progress - 0.2) / 0.8
            r_mid = int(15 + p2 * 45)
            w_mid = max(1, int(3 * (1.0 - p2)))
            canvas.create_oval(cx - r_mid, cy - r_mid, cx + r_mid, cy + r_mid, outline=secondary_color, width=w_mid)

        # 3. Concentric "fingerprint" grooves (biometric tactile lines)
        for r_fp in [6, 12, 18]:
            canvas.create_oval(cx - r_fp, cy - r_fp, cx + r_fp, cy + r_fp, outline=primary_color, width=2)

        # 4. Central high-contrast touch point (bright white/cyan core)
        canvas.create_oval(cx - 5, cy - 5, cx + 5, cy + 5, fill="#FFFFFF", outline=primary_color, width=2)

        # 5. Pointer Tag Badge
        btn_label = "RIGHT CLICK" if is_right else "CLICK"
        canvas.create_rectangle(cx - 45, cy + 30, cx + 45, cy + 46, fill="#0A0A0A", outline=primary_color, width=1.5)
        canvas.create_text(cx, cy + 38, text=f"🎯 {btn_label}", fill=primary_color, font=("Consolas", 8, "bold"))

        step += 1
        root.after(interval, animate)

    animate()
    root.mainloop()


if __name__ == "__main__":
    target_x = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    target_y = int(sys.argv[2]) if len(sys.argv) > 2 else 400
    target_btn = sys.argv[3] if len(sys.argv) > 3 else "left"
    render_click(target_x, target_y, target_btn)
