$ErrorActionPreference = 'Stop'
$taskName = 'Barangay Queue System'
$taskDescription = 'Starts and health-checks the Barangay Queue System on this computer.'
$pidFilePath = Join-Path $PSScriptRoot 'data\autostart-server.pid'

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and $task.Description -ne $taskDescription) {
  throw "The Windows task '$taskName' is not this app's autostart task, so it was left untouched."
}
$taskWasRunning = $task -and $task.State -eq 'Running'
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

if ($taskWasRunning -and (Test-Path -LiteralPath $pidFilePath)) {
  $serverProcessId = 0
  if ([int]::TryParse((Get-Content -LiteralPath $pidFilePath -Raw).Trim(), [ref]$serverProcessId)) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId" -ErrorAction SilentlyContinue
    $expectedServerPath = Join-Path $PSScriptRoot 'server.js'

    if ($processInfo -and $processInfo.Name -match '^node(\.exe)?$' -and $processInfo.CommandLine -and $processInfo.CommandLine.Contains($expectedServerPath)) {
      Stop-Process -Id $serverProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $pidFilePath -Force -ErrorAction SilentlyContinue
}

Write-Host 'Barangay Queue System autostart has been removed. Existing queue data and backups were kept.' -ForegroundColor Green
