@echo off
title Can I Run It?
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required to run from source: https://nodejs.org
  echo Or download the standalone can-i-run-it-windows-x64.zip from the GitHub Releases page.
  pause
  exit /b 1
)
node server.js --open
pause
