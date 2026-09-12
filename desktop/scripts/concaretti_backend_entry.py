"""
Concaretti Backend — PyInstaller entry-point.

When bundled by PyInstaller this file is the __main__ module. It sets up
a writable data directory at %LOCALAPPDATA%/Concaretti (falling back to the
directory next to the executable on non-Windows), seeds default config files
on first run, then starts uvicorn on 127.0.0.1:8000.

The working directory is changed to the data directory before importing
main.py so that every relative-path assumption in the backend
(e.g.  Path(".") / "concaretti.db") continues to work without modification.

Usage (when run via PyInstaller bundle):
    Invoked automatically by Tauri as a sidecar. Not intended for direct use.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


# Locate source assets inside the frozen bundle
# PyInstaller unpacks --add-data items into sys._MEIPASS when running
# as a frozen binary.

if getattr(sys, "frozen", False):
    BUNDLE_DIR = Path(sys._MEIPASS)
else:
    BUNDLE_DIR = Path(__file__).resolve().parent.parent.parent


BACKEND_SRC = BUNDLE_DIR / "backend"


# Decide where runtime data lives
# %LOCALAPPDATA%\Concaretti\ on Windows

def get_data_dir():
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "Concaretti"
    return Path.home() / ".local" / "share" / "concaretti"


DATA_DIR = get_data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)


def seed_file(src, dst):
    if not dst.exists() and src.exists():
        shutil.copy2(src, dst)
        print(f"[concaretti] seeded {dst.name} from bundle")


seed_file(BACKEND_SRC / ".conca",        DATA_DIR / ".conca")
seed_file(BACKEND_SRC / ".conca",        DATA_DIR / ".conca.example")
seed_file(BACKEND_SRC / ".env.example",  DATA_DIR / ".env")
(DATA_DIR / "data").mkdir(parents=True, exist_ok=True)


# Redirect working directory so relative paths in backend resolve into data dir
os.chdir(str(DATA_DIR))


# Add bundled backend to sys.path
if getattr(sys, "frozen", False):
    backend_in_bundle = BUNDLE_DIR
    if str(backend_in_bundle) not in sys.path:
        sys.path.insert(0, str(backend_in_bundle))
else:
    if str(BACKEND_SRC) not in sys.path:
        sys.path.insert(0, str(BACKEND_SRC))

os.environ.setdefault("ENV_FILE", str(DATA_DIR / ".env"))
os.environ.setdefault("CONCA_POLICY_PATH", str(DATA_DIR / ".conca"))


import uvicorn

print("[concaretti-backend] starting on http://127.0.0.1:8000 ...")

uvicorn.run(
    "main:app",
    host="127.0.0.1",
    port=8000,
    log_level="warning",
)
