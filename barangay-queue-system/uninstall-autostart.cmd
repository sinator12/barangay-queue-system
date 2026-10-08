@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-autostart.ps1"
if errorlevel 1 (
  echo.
  echo Autostart could not be removed. Review the message above.
)
pause
