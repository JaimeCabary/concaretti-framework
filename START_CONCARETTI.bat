@echo off
title Concaretti Desktop Launcher
echo =====================================================================
echo   CONCARETTI: MULTI-AGENT ORCHESTRATION FRAMEWORK
echo   Federal University of Technology Owerri (FUTO)
echo =====================================================================
echo.
echo [*] Launching Concaretti Native Desktop Shell...
echo.

cd /d "%~dp0"
uv run --project backend python run_desktop.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] An error occurred while launching Concaretti.
    pause
)
