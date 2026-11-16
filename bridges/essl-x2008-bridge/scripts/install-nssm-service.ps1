param(
  [string]$ServiceName = "CoreERPBiometricBridge",
  [string]$NssmPath = "nssm.exe",
  [string]$NodePath = "C:\Program Files\nodejs\node.exe"
)

$ErrorActionPreference = "Stop"
$BridgeRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$EntryScript = Join-Path $BridgeRoot "dist\index.js"

if (-not (Test-Path $EntryScript)) {
  throw "Build artifacts not found at $EntryScript. Run 'npm run build' first."
}

if (-not (Get-Command $NssmPath -ErrorAction SilentlyContinue)) {
  throw "NSSM executable '$NssmPath' not found. Install NSSM (https://nssm.cc) or pass -NssmPath."
}

Write-Host "Installing Windows Service '$ServiceName' via NSSM..." -ForegroundColor Cyan
& $NssmPath install $ServiceName $NodePath $EntryScript
& $NssmPath set $ServiceName AppDirectory $BridgeRoot
& $NssmPath set $ServiceName DisplayName "CoreERP eSSL X2008 Biometric LAN Bridge"
& $NssmPath set $ServiceName Description "Polls eSSL X2008 biometric terminal over LAN TCP 4370 and syncs attendance punches securely to CoreERP."
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath set $ServiceName AppExit Default Restart
& $NssmPath set $ServiceName AppRestartDelay 5000
& $NssmPath set $ServiceName AppStdout (Join-Path $BridgeRoot "logs\service-stdout.log")
& $NssmPath set $ServiceName AppStderr (Join-Path $BridgeRoot "logs\service-stderr.log")
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateBytes 5242880

Write-Host "Starting service '$ServiceName'..." -ForegroundColor Green
& $NssmPath start $ServiceName
Write-Host "Done. Check health at http://127.0.0.1:4379/health"
