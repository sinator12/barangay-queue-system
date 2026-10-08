# Starts the queue system for devices on the same private Wi-Fi or Ethernet network.
# Keep this window open while staff or residents are using the system.

$ipv4Match = ipconfig | Select-String -Pattern 'IPv4 Address[^:]*:\s*(\d{1,3}(?:\.\d{1,3}){3})' | Select-Object -First 1

if (-not $ipv4Match) {
  Write-Error 'No private IPv4 network address was found. Connect this computer to Wi-Fi or Ethernet, then run this again.'
  exit 1
}

$lanAddress = $ipv4Match.Matches[0].Groups[1].Value
$env:HOST = '0.0.0.0'
$env:APP_ORIGIN = "http://${lanAddress}:3000"
$env:ALLOWED_ORIGINS = "$env:APP_ORIGIN,http://127.0.0.1:3000,http://localhost:3000"

if (-not ('BarangayQueue.NativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace BarangayQueue {
  public static class NativeMethods {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
  }
}
'@
}

$logDirectory = Join-Path $PSScriptRoot 'logs'
$logPath = Join-Path $logDirectory 'server.log'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$awakeRequestSet = [BarangayQueue.NativeMethods]::SetThreadExecutionState([uint32]2147483649) -ne 0

Write-Host ''
Write-Host 'Barangay Queue System is starting for your local network.' -ForegroundColor Green
Write-Host "Open this address on phones and other devices: $env:APP_ORIGIN" -ForegroundColor Cyan
Write-Host 'Keep this window open while the system is in use. The computer will be kept awake.' -ForegroundColor Yellow
Write-Host "Server log: $logPath" -ForegroundColor DarkGray
Write-Host ''

try {
  node "$PSScriptRoot\server.js" 2>&1 | Tee-Object -FilePath $logPath -Append
  $serverExitCode = $LASTEXITCODE
} finally {
  if ($awakeRequestSet) {
    [void][BarangayQueue.NativeMethods]::SetThreadExecutionState([uint32]2147483648)
  }
}

Write-Host ''
Write-Host "The queue server stopped with exit code $serverExitCode." -ForegroundColor Yellow
