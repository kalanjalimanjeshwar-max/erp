param(
  [string]$ServiceName = "CoreERPBiometricBridge",
  [string]$TaskName = "CoreERPBiometricBridge",
  [string]$NssmPath = "nssm.exe"
)

$ErrorActionPreference = "Continue"
$BridgeRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$LockFilePath = Join-Path $BridgeRoot "data\bridge.lock.json"

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Stopping and removing Windows Service '$ServiceName'..." -ForegroundColor Yellow
  Stop-Service -Name $ServiceName -Force
  if (Get-Command $NssmPath -ErrorAction SilentlyContinue) {
    & $NssmPath remove $ServiceName confirm
  } else {
    sc.exe delete $ServiceName
  }
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Stopping and removing Scheduled Task '$TaskName'..." -ForegroundColor Yellow
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

if (Test-Path $LockFilePath) {
  try {
    $lockData = Get-Content -Path $LockFilePath -Raw | ConvertFrom-Json
    if ($lockData.pid) {
      $proc = Get-Process -Id $lockData.pid -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "Stopping running bridge daemon (PID $($lockData.pid))..." -ForegroundColor Yellow
        Stop-Process -Id $lockData.pid -Force -ErrorAction SilentlyContinue
      }
    }
    Remove-Item -Path $LockFilePath -Force -ErrorAction SilentlyContinue
  } catch {
    # Ignore malformed lockfile
  }
}

Write-Host "CoreERP Biometric Bridge auto-start uninstalled. Checkpoints (./data/checkpoints.json), DPAPI credentials (./data/credentials.dpapi.json), and logs (./logs) were preserved." -ForegroundColor Green
