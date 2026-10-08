$ErrorActionPreference = 'Stop'
$taskName = 'Barangay Queue System'
$taskDescription = 'Starts and health-checks the Barangay Queue System on this computer.'
$userId = "$env:USERDOMAIN\$env:USERNAME"
$runnerPath = Join-Path $PSScriptRoot 'run-server-background.ps1'
$powerShellCommand = Get-Command powershell.exe -ErrorAction SilentlyContinue
if (-not $powerShellCommand) {
  $powerShellCommand = Get-Command pwsh.exe -ErrorAction Stop
}
$powerShellPath = $powerShellCommand.Source
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerPath`""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 24 or newer is required. Install Node.js, then run this installer again.'
}

$nodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion -split '\.')[0] -lt 24) {
  throw "Node.js 24 or newer is required. Found: $nodeVersion"
}

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.Description -ne $taskDescription) {
  throw "A different Windows task named '$taskName' already exists. Rename it before installing this app's autostart task."
}

$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description $taskDescription -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host 'Barangay Queue System autostart is installed for this Windows account.' -ForegroundColor Green
Write-Host 'It starts after you sign in, restarts after failures, and keeps this computer awake while running.'
Write-Host 'The server log is in the project logs folder. Check the current Barangay network address there or run start-phone-server.cmd for a visible address.'
Write-Host 'To remove the task and stop its server process, run uninstall-autostart.ps1.' -ForegroundColor Yellow
