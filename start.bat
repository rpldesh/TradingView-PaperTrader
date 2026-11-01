@echo off
rem Double-click launcher: runs start.ps1 without needing a PowerShell execution policy change.
rem   start.bat          build + run
rem   start.bat -Dev     backend with reload + Vite dev server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
