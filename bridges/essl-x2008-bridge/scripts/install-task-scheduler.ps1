param(
  [string]$TaskName = "CoreERPBiometricBridge",
  [string]$NodePath = "C:\Program Files\nodejs\node.exe"
)

$ErrorActionPreference = "Stop"
$BridgeRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$EntryScript = Join-Path $BridgeRoot "dist\index.js"

if (-not (Test-Path $EntryScript)) {
  throw "Build artifacts not found at $EntryScript. Run 'npm run build' first."
}

$action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$EntryScript`"" -WorkingDirectory $BridgeRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Scheduled Task '$TaskName' registered and started." -ForegroundColor Green
