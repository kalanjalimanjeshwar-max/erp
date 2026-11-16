param(
  [string]$CredentialName = "coreerp-essl-x2008-main",
  [ValidateSet("CurrentUser", "LocalMachine")]
  [string]$Scope = "LocalMachine"
)

$ErrorActionPreference = "Stop"
$BridgeRoot = Split-Path -Parent $PSScriptRoot

Write-Host "CoreERP Windows DPAPI Credential Setup" -ForegroundColor Cyan
Write-Host "Credential Key : $CredentialName"
Write-Host "DPAPI Scope    : $Scope (use LocalMachine for Windows Services running as LocalSystem)"
Write-Host ""

$secureKey = Read-Host -Prompt "Paste the one-time CoreERP Device API Key (bio_live_...)" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $plainKey = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  if ([string]::IsNullOrWhiteSpace($plainKey)) {
    throw "API key cannot be empty."
  }

  $env:SECRET_TO_PROTECT = $plainKey.Trim()
  $env:BRIDGE_WORK_DIR = $BridgeRoot
  Push-Location $BridgeRoot
  try {
    & node dist/index.js --protect-secret --name $CredentialName --scope $Scope
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to encrypt credential via DPAPI."
    }
  } finally {
    Pop-Location
  }
} finally {
  $env:SECRET_TO_PROTECT = $null
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
