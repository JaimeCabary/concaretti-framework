# BUILD_INSTALLER.ps1 — One-click Concaretti installer build.
#
# Run from the repo root (New Concaretti/) with:
#   powershell -ExecutionPolicy Bypass -File desktop\BUILD_INSTALLER.ps1
#
# What this does:
#   1. Compile the Python backend into a self-contained .exe (PyInstaller)
#   2. Build the React frontend with VITE_API_BASE set for desktop mode
#   3. Run 	auri build to produce an .msi + NSIS installer
#
# Requirements on the build machine:
#   - Rust + Cargo  (https://rustup.rs/)
#   - uv            (https://docs.astral.sh/uv/)
#   - pnpm          (https://pnpm.io/)
#   - WiX Toolset   (for .msi; installed by cargo tauri build if missing)
#   - NSIS          (for .exe installer; installed by cargo tauri build if missing)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path   # desktop/
$RootDir   = Split-Path -Parent $ScriptDir                      # New Concaretti/

Write-Host ""
Write-Host "##########################################################"
Write-Host "##  Concaretti — Full Installer Build"
Write-Host "##########################################################"
Write-Host ""
Write-Host "Root    : $RootDir"
Write-Host "Desktop : $ScriptDir"
Write-Host ""

# ── Step 1: Build the Python sidecar binary ───────────────────────────────────
Write-Host "=== Step 1/3: Building Python backend sidecar (PyInstaller) ==="
& powershell -ExecutionPolicy Bypass -File "$ScriptDir\scripts\build_sidecar.ps1"
if ($LASTEXITCODE -ne 0) { throw "Sidecar build failed — aborting." }

# ── Step 2: Build the frontend with desktop mode ─────────────────────────────
Write-Host ""
Write-Host "=== Step 2/3: Building React frontend (--mode desktop) ==="
Push-Location (Join-Path $RootDir "frontend")
pnpm install --frozen-lockfile
pnpm build --mode desktop
if ($LASTEXITCODE -ne 0) { 
    Pop-Location
    throw "Frontend build failed — aborting."
}
Pop-Location
Write-Host "[+] Frontend built successfully."

# ── Step 3: Run tauri build ───────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Step 3/3: Building Tauri desktop installer ==="
Push-Location $ScriptDir
pnpm install --frozen-lockfile
pnpm tauri build
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    throw "Tauri build failed — aborting."
}
Pop-Location

# ── Report output location ────────────────────────────────────────────────────
Write-Host ""
Write-Host "##########################################################"
Write-Host "##  Build complete!"
Write-Host "##########################################################"
Write-Host ""
Write-Host "Installers are in:"
Write-Host "  $ScriptDir\src-tauri\target\release\bundle\"
Write-Host ""

$BundleDir = Join-Path $ScriptDir "src-tauri\target\release\bundle"
if (Test-Path $BundleDir) {
    Get-ChildItem -Recurse $BundleDir -Include "*.msi","*.exe","*.dmg","*.deb","*.AppImage" |
        ForEach-Object { Write-Host "  $($_.FullName)  ($([math]::Round($_.Length/1MB,1)) MB)" }
}
Write-Host ""
