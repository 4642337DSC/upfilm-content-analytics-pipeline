@echo off
rem Same as start.bat, but meant to be launched via start-silent.vbs so no
rem console window appears (for binding to a keyboard macro key). If the
rem server is already running, just reopens the browser tab instead of
rem starting a second instance.
cd /d "%~dp0"

netstat -ano | findstr ":4173" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  start "" http://localhost:4173
  exit /b
)

if exist node_modules goto skip_install
call npm install >nul 2>&1
:skip_install

call npm start
