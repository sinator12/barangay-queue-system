@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
if errorlevel 1 (
  echo.
  echo Autostart could not be installed. Review the message above.
)
pause
