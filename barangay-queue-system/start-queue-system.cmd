@echo off
setlocal
cd /d "%~dp0"

where.exe node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 or newer, then try again.
  pause
  exit /b 1
)

rem If the local server is already running, reuse it instead of starting a duplicate.
powershell.exe -NoProfile -Command "try { $client = New-Object System.Net.Sockets.TcpClient; $client.Connect('127.0.0.1', 3000); $client.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Starting Barangay Queue System...
  start "Barangay Queue System Server" cmd /k "cd /d ""%~dp0"" && set HOST=127.0.0.1 && set APP_ORIGIN=http://127.0.0.1:3000 && set ALLOWED_ORIGINS=http://127.0.0.1:3000 && node server.js"
)

rem Wait up to 30 seconds for the server, then open the staff sign-in page.
for /l %%I in (1,1,30) do (
  powershell.exe -NoProfile -Command "try { $client = New-Object System.Net.Sockets.TcpClient; $client.Connect('127.0.0.1', 3000); $client.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 goto openPage
  timeout /t 1 /nobreak >nul
)

echo The queue server did not start. Check its server window for an error.
pause
exit /b 1

:openPage
start "" "http://127.0.0.1:3000/login.html"
echo The staff sign-in page is open. Keep the Barangay Queue System Server window open.
exit /b 0
