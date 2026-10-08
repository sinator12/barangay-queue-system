$ErrorActionPreference = 'Stop'
$healthUrl = 'http://127.0.0.1:3000/api/health'

try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
  if ($health.status -ne 'ok') {
    throw 'The health endpoint returned an unexpected status.'
  }
  Write-Host "Queue server is healthy at $healthUrl" -ForegroundColor Green
} catch {
  Write-Error "Queue server is not healthy at $healthUrl. Start or restart it, then check logs/server.log. $($_.Exception.Message)"
  exit 1
}
