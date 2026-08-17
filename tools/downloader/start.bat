@echo off
rem Double-click this file (Windows) to install dependencies (first run
rem only) and start the downloader. It opens your browser automatically.
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies (first run only)...
  call npm install
)

call npm start
pause
