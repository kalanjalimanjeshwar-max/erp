param(
  [string]$ServiceName = "CoreERPBiometricBridge",
  [string]$TaskName = "CoreERPBiometricBridge",
  [string]$NssmPath = "nssm.exe"
)

$ErrorActionPreference = "Continue"

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
  Stop-ScheduledTask -TaskName $TaskName
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Host "CoreERP Biometric Bridge uninstalled. Checkpoints and logs remain in ./data and ./logs for auditability." -ForegroundColor Green
