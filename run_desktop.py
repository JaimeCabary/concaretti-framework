"""
Concaretti — Native Desktop Launcher (PyView / PyWebView)

Runs the FastAPI backend and presents Concaretti in a native Windows WebView2 window.
Zero Rust compilation required — runs directly with Python + uv.

Usage:
    cd "New Concaretti"
    uv run --project backend python run_desktop.py
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

# Set up paths
ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"

# Add backend directory to sys.path so modules import seamlessly
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

try:
    import httpx
    import uvicorn
    import webview
except ImportError:
    print("[!] Missing dependencies. Please run with: uv run --project backend python run_desktop.py")
    sys.exit(1)


def is_backend_live(port: int = 8000) -> bool:
    """Check if the backend is already answering on port 8000."""
    try:
        r = httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=1.0)
        return r.status_code == 200
    except Exception:
        return False


def start_backend():
    """Start uvicorn server in daemon thread."""
    os.chdir(str(BACKEND_DIR))
    from main import app
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")

def main():
    # Read operator profile if present
    profile_file = ROOT_DIR / "user_profile.json"
    user_name = ""
    if profile_file.exists():
        try:
            import json
            p_data = json.loads(profile_file.read_text(encoding="utf-8"))
            user_name = p_data.get("name", "")
        except Exception:
            pass

    print("=" * 60)
    print("  Concaretti — Native Desktop Shell (PyView)")
    if user_name:
        print(f"  Welcome back, {user_name}!")
    print("=" * 60)

    # 1. Start backend if not already running
    if not is_backend_live(8000):
        print("[*] Starting Concaretti FastAPI backend on http://127.0.0.1:8000 ...")
        t = threading.Thread(target=start_backend, daemon=True)
        t.start()
        
        # Wait for backend to answer
        for _ in range(30):
            time.sleep(0.3)
            if is_backend_live(8000):
                break
        print("[+] Backend online.")
    else:
        print("[+] Existing backend detected on port 8000.")

    # 2. Always connect desktop shell to the FastAPI server (serving frontend/dist)
    target_url = "http://127.0.0.1:8000"

    # 3. Create native desktop window
    storage_dir = ROOT_DIR / ".webview_data"
    storage_dir.mkdir(parents=True, exist_ok=True)

    print(f"[*] Opening native window pointing to {target_url} ...")
    window = webview.create_window(
        title="Concaretti",
        url=target_url,
        width=1320,
        height=880,
        min_size=(900, 620),
        background_color="#FFFBF0",
        easy_drag=False,
    )
    
    # 4. Start native GUI loop with persistent storage
    webview.start(debug=True, private_mode=False, storage_path=str(storage_dir))


if __name__ == "__main__":
    main()
