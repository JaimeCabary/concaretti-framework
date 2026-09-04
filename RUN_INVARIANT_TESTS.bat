@echo off
title Concaretti Invariant Verification Suite (159 Tests)
echo =====================================================================
echo   CONCARETTI: 159 INVARIANT VERIFICATION SUITE
echo   Testing 11 Control Surfaces (T-01 to T-11)
echo   Federal University of Technology Owerri (FUTO)
echo =====================================================================
echo.

cd /d "%~dp0"
uv run --project backend pytest -v

echo.
echo =====================================================================
echo   Verification completed. Press any key to exit.
echo =====================================================================
pause
