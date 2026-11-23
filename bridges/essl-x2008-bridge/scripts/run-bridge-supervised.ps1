param(
  [string]$BridgeRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path,
  [string]$NodePath = "",
  [int]$InitialRestartDelaySeconds = 10,
  [int]$MaxRestartDelaySeconds = 300,
  [int]$HealthyUptimeResetSeconds = 120
)

$ErrorActionPreference = "Stop"

$ResolvedRoot = (Resolve-Path $BridgeRoot).Path
$EntryScript = Join-Path $ResolvedRoot "dist\index.js"
$LogDir = Join-Path $ResolvedRoot "logs"
$SupervisorLog = Join-Path $LogDir "supervisor.log"

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd -and $nodeCmd.Source) {
    $NodePath = $nodeCmd.Source
  } else {
    $NodePath = "C:\Program Files\nodejs\node.exe"
  }
}

if (-not (Test-Path $NodePath)) {
  throw "Node.js executable not found at '$NodePath'."
}
if (-not (Test-Path $EntryScript)) {
  throw "Bridge build artifact not found at '$EntryScript'. Run 'npm run build' first."
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-SupervisorLog {
  param(
    [string]$Level,
    [string]$Event,
    [string]$Message
  )
  $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $safeMsg = $Message -replace 'bio_live_[A-Za-z0-9_-]{12,}', 'bio_live_***REDACTED***'
  $line = (@{
    ts = $ts
    level = $Level
    event = $Event
    pid = $PID
    message = $safeMsg
  } | ConvertTo-Json -Compress)

  try {
    if ((Test-Path $SupervisorLog) -and ((Get-Item $SupervisorLog).Length -ge 5242880)) {
      $rotated = "$SupervisorLog.1"
      if (Test-Path $rotated) { Remove-Item $rotated -Force -ErrorAction SilentlyContinue }
      Move-Item $SupervisorLog $rotated -Force -ErrorAction SilentlyContinue
    }
    Add-Content -Path $SupervisorLog -Value $line -Encoding UTF8
  } catch {
    # Do not crash supervisor on transient log lock
  }
}

# Single-instance named Windows Mutex scoped to current user session + install path
$sha = [System.Security.Cryptography.SHA256]::Create()
$pathBytes = [System.Text.Encoding]::UTF8.GetBytes($ResolvedRoot.ToLowerInvariant())
$hashHex = ([System.BitConverter]::ToString($sha.ComputeHash($pathBytes)) -replace '-', '').Substring(0, 12)
$mutexName = "Local\CoreERPBiometricBridge_$hashHex"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)

if (-not $createdNew) {
  Write-SupervisorLog -Level "warn" -Event "supervisor_duplicate_blocked" -Message "Another supervised CoreERP Biometric Bridge instance is already running for '$ResolvedRoot'."
  exit 0
}

try {
  Set-Location $ResolvedRoot
  $env:BRIDGE_WORK_DIR = $ResolvedRoot

  $restartDelay = [Math]::Max(5, $InitialRestartDelaySeconds)
  $consecutiveCrashes = 0

  Write-SupervisorLog -Level "info" -Event "supervisor_started" -Message "Starting continuous CoreERP Biometric Bridge under user '$env:USERDOMAIN\$env:USERNAME' in '$ResolvedRoot'."

  while ($true) {
    $startedAt = Get-Date
    $proc = Start-Process -FilePath $NodePath `
      -ArgumentList @("`"$EntryScript`"") `
      -WorkingDirectory $ResolvedRoot `
      -NoNewWindow `
      -PassThru

    Write-SupervisorLog -Level "info" -Event "bridge_child_started" -Message "Bridge daemon started (PID $($proc.Id))."
    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
    $uptimeSec = [int]((Get-Date) - $startedAt).TotalSeconds

    if ($exitCode -eq 0) {
      Write-SupervisorLog -Level "info" -Event "bridge_child_exited_cleanly" -Message "Bridge daemon exited cleanly with code 0 after ${uptimeSec}s. Supervisor stopping."
      break
    }

    if ($uptimeSec -ge $HealthyUptimeResetSeconds) {
      $consecutiveCrashes = 1
      $restartDelay = [Math]::Max(5, $InitialRestartDelaySeconds)
    } else {
      $consecutiveCrashes += 1
      $restartDelay = [Math]::Min($MaxRestartDelaySeconds, [int]($InitialRestartDelaySeconds * [Math]::Pow(2, [Math]::Min($consecutiveCrashes - 1, 6))))
    }

    Write-SupervisorLog -Level "error" -Event "bridge_child_crashed" -Message "Bridge daemon exited unexpectedly with code $exitCode after ${uptimeSec}s (crash #$consecutiveCrashes). Restarting in ${restartDelay}s without modifying checkpoints."
    Start-Sleep -Seconds $restartDelay
  }
} finally {
  try {
    $mutex.ReleaseMutex() | Out-Null
  } catch {
    # Ignore mutex release errors on shutdown
  }
  $mutex.Dispose()
}
