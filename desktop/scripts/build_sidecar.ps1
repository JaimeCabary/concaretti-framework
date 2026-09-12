# build_sidecar.ps1 — compile the Concaretti Python backend into a self-contained
# Windows executable that Tauri can bundle as a sidecar.
#
# Usage (from the repo root OR from desktop/):
#   powershell -ExecutionPolicy Bypass -File desktop/scripts/build_sidecar.ps1
#
# Output:
#   desktop/src-tauri/binaries/concaretti-backend-x86_64-pc-windows-msvc.exe
#
# Requirements:
#   - uv  (https://docs.astral.sh/uv/)  — manages the build venv
#   - Python 3.13 on PATH (uv will fetch it if missing)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Resolve paths ─────────────────────────────────────────────────────────────
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = Split-Path -Parent $ScriptDir          # desktop/
$RootDir    = Split-Path -Parent $DesktopDir          # New Concaretti/
$BackendDir = Join-Path $RootDir "backend"
$BinDir     = Join-Path $DesktopDir "src-tauri\binaries"
$BuildEnv   = Join-Path $ScriptDir "_build_env"
$EntryPoint = Join-Path $ScriptDir "concaretti_backend_entry.py"

# Target triple Tauri expects on Windows x86-64
$TargetTriple = "x86_64-pc-windows-msvc"
$BinaryName   = "concaretti-backend-$TargetTriple"
$OutputExe    = Join-Path $BinDir "$BinaryName.exe"

Write-Host ""
Write-Host "=========================================================="
Write-Host "  Concaretti Sidecar Build"
Write-Host "=========================================================="
Write-Host "  Backend  : $BackendDir"
Write-Host "  Output   : $OutputExe"
Write-Host "  Build env: $BuildEnv"
Write-Host ""

# ── Create / refresh the build venv ──────────────────────────────────────────
Write-Host "[1/5] Creating isolated build venv with uv ..."
uv venv --python 3.13 "$BuildEnv"
if ($LASTEXITCODE -ne 0) { throw "uv venv failed" }

$PythonExe = Join-Path $BuildEnv "Scripts\python.exe"
$PipExe    = Join-Path $BuildEnv "Scripts\pip.exe"

# ── Install backend deps + PyInstaller into the build venv ───────────────────
Write-Host "[2/5] Installing backend dependencies from pyproject.toml ..."
uv pip install --python "$PythonExe" 
    --requirement "$BackendDir\pyproject.toml" 
    pyinstaller 
    pyinstaller-hooks-contrib

if ($LASTEXITCODE -ne 0) { throw "uv pip install failed" }

# ── Ensure output directory exists ───────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# ── Run PyInstaller ───────────────────────────────────────────────────────────
Write-Host "[3/5] Running PyInstaller ..."

# Work from desktop/scripts/ so PyInstaller's --workpath / --distpath are tidy.
Push-Location $ScriptDir

& "$PythonExe" -m PyInstaller 
    --noconfirm 
    --onefile 
    --noconsole 
    --name "$BinaryName" 
    --distpath "$BinDir" 
    --workpath "$ScriptDir\_pyinstaller_work" 
    --specpath "$ScriptDir" 
    --add-data "$BackendDir\.conca;backend" 
    --add-data "$BackendDir\.env.example;backend" 
    --add-data "$BackendDir\data;backend\data" 
    --collect-all "uvicorn" 
    --collect-all "fastapi" 
    --collect-all "starlette" 
    --collect-all "pydantic" 
    --collect-all "pydantic_core" 
    --collect-all "httpx" 
    --collect-all "pywebview" 
    --collect-all "sqlite_vec" 
    --hidden-import "uvicorn.logging" 
    --hidden-import "uvicorn.loops" 
    --hidden-import "uvicorn.loops.auto" 
    --hidden-import "uvicorn.protocols" 
    --hidden-import "uvicorn.protocols.http" 
    --hidden-import "uvicorn.protocols.http.auto" 
    --hidden-import "uvicorn.protocols.websockets" 
    --hidden-import "uvicorn.protocols.websockets.auto" 
    --hidden-import "uvicorn.lifespan" 
    --hidden-import "uvicorn.lifespan.on" 
    --hidden-import "multipart" 
    --hidden-import "python_multipart" 
    --hidden-import "email.mime.multipart" 
    --hidden-import "email.mime.text" 
    "$EntryPoint"

Pop-Location

if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

# ── Confirm output ────────────────────────────────────────────────────────────
Write-Host "[4/5] Verifying output ..."
if (-not (Test-Path $OutputExe)) {
    throw "Expected binary not found at: $OutputExe"
}

$SizeMB = [math]::Round((Get-Item $OutputExe).Length / 1MB, 1)
Write-Host "[5/5] Done."
Write-Host ""
Write-Host "  Binary   : $OutputExe"
Write-Host "  Size     : $SizeMB MB"
Write-Host ""
Write-Host "  Next step: run .\BUILD_INSTALLER.ps1 to assemble the Tauri installer."
Write-Host ""
