param(
  [string]$TaskName = "CoreERPBiometricBridge",
  [string]$NodePath = "",
  [string]$UserId = "$env:USERDOMAIN\$env:USERNAME",
  [ValidateSet("Limited", "Highest")]
  [string]$RunLevel = "Limited",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$BridgeRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$EntryScript = Join-Path $BridgeRoot "dist\index.js"
$SupervisorScript = Join-Path $BridgeRoot "scripts\run-bridge-supervised.ps1"
$ConfigPath = Join-Path $BridgeRoot "bridge.config.json"
$DpapiStorePath = Join-Path $BridgeRoot "data\credentials.dpapi.json"

# Protect existing DPAPI CurrentUser credentials: refuse SYSTEM account registration
if ($UserId -match '^(NT AUTHORITY\\)?SYSTEM$' -or $UserId -match '^LocalSystem$') {
  throw "Refusing to register Scheduled Task as '$UserId'. Running as SYSTEM breaks Windows DPAPI CurrentUser credential decryption. Use your authorized Windows user account (default: '$env:USERDOMAIN\$env:USERNAME')."
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd -and $nodeCmd.Source) {
    $NodePath = $nodeCmd.Source
  } else {
    $NodePath = "C:\Program Files\nodejs\node.exe"
  }
}

$ResolvedNodePath = (Resolve-Path $NodePath -ErrorAction Stop).Path

if (-not (Test-Path $EntryScript)) {
  throw "Build artifacts not found at '$EntryScript'. Run 'npm run build' in '$BridgeRoot' first."
}
if (-not (Test-Path $SupervisorScript)) {
  throw "Supervisor script not found at '$SupervisorScript'."
}
if (-not (Test-Path $ConfigPath)) {
  Write-Warning "Configuration file '$ConfigPath' not found yet. Ensure bridge.config.json (or .env) is configured before starting."
}

# Check DPAPI credential store metadata (scope only; never reads or displays secrets)
if (Test-Path $DpapiStorePath) {
  try {
    $storeMeta = Get-Content -Path $DpapiStorePath -Raw | ConvertFrom-Json
    foreach ($prop in $storeMeta.PSObject.Properties) {
      $entryScope = $prop.Value.scope
      if ($entryScope -and $entryScope -eq "CurrentUser") {
        Write-Host "DPAPI store entry '$($prop.Name)' uses scope 'CurrentUser' - compatible with user '$UserId'." -ForegroundColor Cyan
      } elseif ($entryScope) {
        Write-Host "DPAPI store entry '$($prop.Name)' uses scope '$entryScope'." -ForegroundColor Cyan
      }
    }
  } catch {
    Write-Warning "Could not inspect DPAPI store metadata at '$DpapiStorePath'."
  }
}

$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path $PowerShellExe)) {
  $PowerShellExe = "powershell.exe"
}

# Zero credentials or secrets in Task Scheduler arguments; all paths are absolute
$taskArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$SupervisorScript`" -BridgeRoot `"$BridgeRoot`" -NodePath `"$ResolvedNodePath`""

$action = New-ScheduledTaskAction `
  -Execute $PowerShellExe `
  -Argument $taskArguments `
  -WorkingDirectory $BridgeRoot

# AtLogOn for the authorized Windows user loads the user profile & DPAPI CurrentUser master key cleanly
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId

# Prevent duplicate instances, run on AC or battery, allow Task Scheduler restart on supervisor crash
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 2) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

# Interactive logon under the user's Windows account preserves DPAPI CurrentUser credentials
$principal = New-ScheduledTaskPrincipal `
  -UserId $UserId `
  -LogonType Interactive `
  -RunLevel $RunLevel

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Runs the CoreERP eSSL X2008 Biometric LAN Bridge continuously with self-recovery and DPAPI CurrentUser credential protection." `
  -Force | Out-Null

Write-Host "Scheduled Task '$TaskName' registered successfully." -ForegroundColor Green
Write-Host "  User Identity     : $UserId (LogonType=Interactive, DPAPI CurrentUser preserved)"
Write-Host "  Working Directory : $BridgeRoot"
Write-Host "  Node Executable   : $ResolvedNodePath"
Write-Host "  Duplicate Guard   : MultipleInstances=IgnoreNew + Mutex + PID lockfile"
Write-Host "  Log Files         : $(Join-Path $BridgeRoot 'logs\bridge.log') & $(Join-Path $BridgeRoot 'logs\supervisor.log')"

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Scheduled Task '$TaskName' started. Verify health at http://127.0.0.1:4379/health" -ForegroundColor Green
} else {
  Write-Host "Task registered with -NoStart. Start manually via: Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Yellow
}
