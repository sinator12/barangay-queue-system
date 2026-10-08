$ErrorActionPreference = 'Stop'
$taskLogDirectory = Join-Path $PSScriptRoot 'logs'
$dataDirectory = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $taskLogDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null

$taskLogPath = Join-Path $taskLogDirectory 'autostart.log'
$pidFilePath = Join-Path $dataDirectory 'autostart-server.pid'
$stdoutPath = Join-Path $taskLogDirectory 'server-current.stdout.log'
$stderrPath = Join-Path $taskLogDirectory 'server-current.stderr.log'
$nodeProcess = $null
$exitCode = 1
$awakeRequestSet = $false

function Write-TaskLog([string]$Message) {
  Add-Content -LiteralPath $taskLogPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
}

try {
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

  $routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric)
  $lanAddress = $null

  foreach ($route in $routes) {
    $address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.AddressState -eq 'Preferred' } |
      Select-Object -First 1
    if ($address) {
      $lanAddress = $address.IPAddress
      break
    }
  }

  if (-not $lanAddress) {
    throw 'No active private IPv4 address was found. Connect the server computer to its Barangay network.'
  }

  $nodeCommand = Get-Command node -ErrorAction Stop
  $serverScriptPath = Join-Path $PSScriptRoot 'server.js'
  $env:HOST = '0.0.0.0'
  $env:PORT = '3000'
  $env:APP_ORIGIN = "http://${lanAddress}:3000"
  $env:ALLOWED_ORIGINS = "$env:APP_ORIGIN,http://127.0.0.1:3000,http://localhost:3000"

  $awakeRequestSet = [BarangayQueue.NativeMethods]::SetThreadExecutionState([uint32]2147483649) -ne 0
  Write-TaskLog "Starting the LAN server at $env:APP_ORIGIN. System sleep prevention: $awakeRequestSet."

  $nodeProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @("`"$serverScriptPath`"") `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Set-Content -LiteralPath $pidFilePath -Value $nodeProcess.Id -Encoding ASCII

  $consecutiveHealthFailures = 0

  while ($true) {
    $nodeProcess.Refresh()
    if ($nodeProcess.HasExited) {
      $exitCode = if ($nodeProcess.ExitCode -eq 0) { 1 } else { $nodeProcess.ExitCode }
      Write-TaskLog "Queue server process stopped with exit code $($nodeProcess.ExitCode)."
      break
    }

    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 5
      if ($health.status -eq 'ok') {
        $consecutiveHealthFailures = 0
      } else {
        $consecutiveHealthFailures++
      }
    } catch {
      $consecutiveHealthFailures++
    }

    if ($consecutiveHealthFailures -ge 3) {
      Write-TaskLog 'Health check failed three times; stopping the unhealthy server so Task Scheduler can restart it.'
      Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
      $exitCode = 1
      break
    }

    Start-Sleep -Seconds 20
  }
} catch {
  Write-TaskLog "Autostart runner error: $($_.Exception.Message)"
  $exitCode = 1
} finally {
  if ($nodeProcess) {
    $nodeProcess.Refresh()
    if (-not $nodeProcess.HasExited) {
      Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $pidFilePath) -and ((Get-Content -LiteralPath $pidFilePath -Raw).Trim() -eq [string]$nodeProcess.Id)) {
      Remove-Item -LiteralPath $pidFilePath -Force -ErrorAction SilentlyContinue
    }
  }

  if ($awakeRequestSet) {
    [void][BarangayQueue.NativeMethods]::SetThreadExecutionState([uint32]2147483648)
  }
  Write-TaskLog "Autostart runner exited with code $exitCode."
}

exit $exitCode
