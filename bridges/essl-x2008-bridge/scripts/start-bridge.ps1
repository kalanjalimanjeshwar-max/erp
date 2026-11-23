param(
  [string]$NodePath = "",
  [switch]$Background,
  [string]$HealthUrl = "http://127.0.0.1:4379/health"
)

$ErrorActionPreference = "Stop"

$BridgeRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$EntryScript = Join-Path $BridgeRoot "dist\index.js"
$LockFilePath = Join-Path $BridgeRoot "data\bridge.lock.json"

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd -and $nodeCmd.Source) {
    $NodePath = $nodeCmd.Source
  } else {
    $NodePath = "C:\Program Files\nodejs\node.exe"
  }
}

if (-not (Test-Path $EntryScript)) {
  throw "Build artifacts not found at '$EntryScript'. Run 'npm run build' first."
}

# Check for an already-running bridge instance before launching
if (Test-Path $LockFilePath) {
  try {
    $lockData = Get-Content -Path $LockFilePath -Raw | ConvertFrom-Json
    if ($lockData.pid -and (Get-Process -Id $lockData.pid -ErrorAction SilentlyContinue)) {
      Write-Host "CoreERP Biometric Bridge is already running (PID $($lockData.pid)). Refusing to start duplicate process." -ForegroundColor Yellow
      exit 0
    }
  } catch {
    # Stale or unreadable lockfile will be cleaned by the bridge on startup
  }
}

$env:BRIDGE_WORK_DIR = $BridgeRoot

if ($Background) {
  $proc = Start-Process -FilePath $NodePath `
    -ArgumentList @("`"$EntryScript`"") `
    -WorkingDirectory $BridgeRoot `
    -WindowStyle Hidden `
    -PassThru

  Write-Host "Started CoreERP Biometric Bridge in background (PID $($proc.Id)). Waiting for health check..." -ForegroundColor Cyan
  Start-Sleep -Seconds 2
  try {
    $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
    Write-Host "Bridge health check OK: status=$($resp.status), pid=$($resp.pid), terminals=$($resp.terminalCount)" -ForegroundColor Green
  } catch {
    Write-Warning "Bridge process started (PID $($proc.Id)), but '$HealthUrl' did not respond yet. Inspect logs\bridge.log."
  }
} else {
  Write-Host "Starting CoreERP Biometric Bridge in foreground (Ctrl+C to stop cleanly)..." -ForegroundColor Cyan
  Push-Location $BridgeRoot
  try {
    & $NodePath $EntryScript
  } finally {
    Pop-Location
  }
}
