@echo off
rem VibeNotes for Windows - launcher
rem 1) Clear ELECTRON_RUN_AS_NODE in case the app is launched from an Electron-hosted terminal
rem 2) cd into the app folder and pass "." as the app path - avoids the classic
rem    "%~dp0" trailing-backslash + quote escaping bug (\" swallows the next argument)
rem 3) --disable-gpu + --no-sandbox: maximum compatibility (GPU driver quirks,
rem    restricted hosts). The UI is lightweight; software rendering is smooth and
rem    the app loads only local files, so the Chromium sandbox adds little here.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
start "VibeNotes" "%~dp0runtime\electron.exe" . --disable-gpu --no-sandbox
