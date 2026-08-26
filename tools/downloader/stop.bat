@echo off
rem Kills the downloader server started via start-silent.vbs (no console
rem window to close normally). Bind this to a second G-key if you want a
rem stop macro too.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4173" ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
