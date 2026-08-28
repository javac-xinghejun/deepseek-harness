@echo off
rem DeepSeek Harness web-surface launcher: runs the composed web runtime from
rem this repository's sources. The console window owns the server lifetime;
rem closing it stops the service. The desktop-shell deferral rationale lives in
rem .agents/notes/implemented/process/2026-08-28-web-launcher-over-desktop-shell.md
setlocal
cd /d "%~dp0.."
where pnpm >nul 2>nul
if errorlevel 1 (echo pnpm was not found on PATH. Install pnpm, then run this launcher again. & pause & exit /b 1)
pnpm dsh --profile web
