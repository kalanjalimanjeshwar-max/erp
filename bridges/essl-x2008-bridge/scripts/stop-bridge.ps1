param(
  [string]$TaskName = "CoreERPBiometricBridge"
)

$ErrorActionPreference = "Continue"

$BridgeRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$LockFilePath = Join-Path $BridgeRoot "data\bridge.lock.json"

# 1. Stop Scheduled Task if running
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq "Running") {
  Write-Host "Stopping Scheduled Task '$TaskName'..." -ForegroundColor Yellow
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# 2. Stop live bridge daemon recorded in bridge.lock.json (without deleting checkpoints)
if (Test-Path $LockFilePath) {
  try {
    $lockData = Get-Content -Path $LockFilePath -Raw | ConvertFrom-Json
    if ($lockData.pid) {
      $proc = Get-Process -Id $lockData.pid -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "Stopping CoreERP Biometric Bridge process (PID $($lockData.pid))..." -ForegroundColor Yellow
        Stop-Process -Id $lockData.pid -Force -ErrorAction SilentlyContinue
      }
    }
    Remove-Item -Path $LockFilePath -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Warning "Could not cleanly parse '$LockFilePath'."
  }
}

Write-Host "CoreERP Biometric Bridge stopped. Checkpoints (./data/checkpoints.json), DPAPI store, and logs (./logs) were preserved." -ForegroundColor Green
