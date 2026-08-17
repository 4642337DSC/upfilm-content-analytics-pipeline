@echo off
rem Double-click this file on Windows to install dependencies on first run
rem and start the downloader. It opens your browser automatically.
cd /d "%~dp0"

if exist node_modules goto skip_install
echo Installing dependencies, first run only...
call npm install
:skip_install

call npm start
pause
