# CoreERP eSSL X2008 Biometric LAN Bridge

Permanent Windows-compatible LAN Bridge daemon that runs continuously in the background to:
1. Maintain authenticated keepalive heartbeats with CoreERP (`POST /api/biometric/heartbeat`).
2. Automatically discover, claim, and execute UI-triggered **User Sync** jobs (`POST /api/biometric/users/jobs/claim`, `POST /api/biometric/users`, `POST /api/biometric/users/jobs/fail`) strictly isolated from punch sync.
3. Poll **eSSL X2008** (`ZLM60_TFT` / `VX10.0`) standalone biometric terminals over LAN TCP port `4370` (strictly read-only) and push idempotent attendance punches to CoreERP (`POST /api/biometric/punches`).

---

## 1. Hardware & Safety Guarantees

- **Target Hardware**: eSSL X2008 (`ZLM60_TFT` OEM ZKTeco platform, `VX10.0` fingerprint algorithm, e.g. Serial `NFZ8252800275`, LAN IP `192.168.1.201:4370`).
- **Read-Only Against Hardware**: The bridge NEVER clears attendance logs (`CMD_CLEAR_ATTLOG`), never modifies device settings, and never mutates enrolled users on the device.
- **Strict User-Sync Isolation**: UI-triggered User Sync jobs execute `syncTerminalUsersOnce()` only (connect -> validate serial -> read enrolled users -> upload user list -> update job status). User Sync NEVER reads attendance logs, uploads punches, triggers punch reconciliation, or modifies punch checkpoints.
- **Checkpoint Preservation**: `data/checkpoints.json` is written atomically and is NEVER deleted or reset on crash, restart, network outage, or uninstall.
- **DPAPI `CurrentUser` Preservation**: Windows Task Scheduler auto-start runs under your authorized Windows user account (`LogonType Interactive`), NOT `SYSTEM`, so existing Windows DPAPI `CurrentUser` credentials in `data/credentials.dpapi.json` continue to decrypt without migration.

---

## 2. Architecture

```
[CoreERP UI: "Sync Users from Device"]
       │  POST /api/biometric/devices/:id/sync-users -> Creates QUEUED Job
       ▼
[CoreERP REST API: http://127.0.0.1:3000 or HTTPS]
       ▲  Authenticated Device API Key (X-Device-Api-Key + X-Device-Serial)
       │  ├─ POST /api/biometric/heartbeat         (every 30s, reports Bridge ONLINE & Device CONNECTED/DISCONNECTED)
       │  ├─ POST /api/biometric/users/jobs/claim  (every 5s, fast UI job discovery)
       │  ├─ POST /api/biometric/users             (uploads enrolled users, marks job SUCCESS)
       │  ├─ POST /api/biometric/users/jobs/fail   (reports failure/retry state immediately)
       │  └─ POST /api/biometric/punches           (periodic punch pull only; never invoked by User Sync)
[Windows Bridge Host]
  ├─ Windows Task Scheduler (AtLogOn, authorized user account, MultipleInstances=IgnoreNew)
  ├─ scripts/run-bridge-supervised.ps1 (Named Mutex + crash-loop exponential backoff)
  ├─ node dist/index.js (BridgeInstanceLock data/bridge.lock.json + sleep/wake detector)
  ├─ ZKTecoTcpAdapter (TCP 4370 read-only)
  ├─ CheckpointStore (data/checkpoints.json)
  ├─ DPAPI Credential Store (data/credentials.dpapi.json, Scope=CurrentUser)
  └─ Local Health Server (http://127.0.0.1:4379/health & /status)
       │  LAN TCP 4370
       ▼
[eSSL X2008: 192.168.1.201:4370]
```

---

## 3. Build & Configure on Windows

### Step 1: Build & Configure
```powershell
cd <PathToRepo>\bridges\essl-x2008-bridge
npm run build
Copy-Item bridge.config.example.json bridge.config.json
Copy-Item .env.example .env
```
Edit `bridge.config.json` with your exact `coreErpBaseUrl` (e.g., `http://127.0.0.1:3000` for local Windows development or `https://erp.company.com` in production), `serialNumber` (`NFZ8252800275`), `ipAddress` (`192.168.1.201`), `port` (`4370`), `deviceTimezone` (`Asia/Kolkata`), and `dpapiCredentialName`.

### Step 2: Store Device API Key via Windows DPAPI (`CurrentUser`)
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\protect-credentials.ps1 -CredentialName "coreerp-essl-x2008-main" -Scope CurrentUser
```
*(No plaintext API key is stored on disk or passed in Task Scheduler or CLI arguments.)*

### Step 3: Verify Connectivity (Optional Diagnostic)
```powershell
npm run test-connection
```
*(One-time manual user-only sync remains available as `npm run sync-users-once`, but normal operation should use the continuous daemon below.)*

---

## 4. Windows Auto-Start Installation (Task Scheduler — Recommended)

Runs under your current Windows user identity (`$env:USERDOMAIN\$env:USERNAME`, `LogonType=Interactive`) so **DPAPI `CurrentUser` credentials remain intact**.

```powershell
# Register Scheduled Task and start immediately
powershell -ExecutionPolicy Bypass -File .\scripts\install-task-scheduler.ps1

# Or register without starting immediately
powershell -ExecutionPolicy Bypass -File .\scripts\install-task-scheduler.ps1 -NoStart
```

What `install-task-scheduler.ps1` configures:
- **Identity**: Current authorized Windows user (refuses `SYSTEM` to protect DPAPI `CurrentUser`).
- **Trigger**: At user logon (`AtLogOn`), plus immediate start unless `-NoStart` is passed.
- **Working Directory & Paths**: Absolute paths for `powershell.exe`, `run-bridge-supervised.ps1`, `node.exe`, and working directory.
- **Duplicate Prevention**: Three layers — Task Scheduler `-MultipleInstances IgnoreNew`, supervisor named Windows Mutex, and Node PID lockfile (`data\bridge.lock.json`).
- **Crash-Loop Recovery**: `run-bridge-supervised.ps1` restarts unexpected crashes with bounded exponential backoff (`10s -> 20s -> 40s -> 80s -> 160s -> max 300s`), resetting after 120s of healthy runtime; Task Scheduler also restarts the supervisor up to 5 times with a 2-minute interval.
- **Zero Secrets in Args**: No API keys, tokens, or comm keys appear in Task Scheduler arguments or plaintext logs.

---

## 5. Manual Start, Stop, Verification & Uninstall

### Manual Start (Foreground or Background)
```powershell
# Foreground (Ctrl+C shuts down cleanly)
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge.ps1

# Background hidden process + health verification
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge.ps1 -Background
```

### Manual Stop
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-bridge.ps1
```

### Startup & Runtime Verification
```powershell
# 1. Verify Scheduled Task registration & state
Get-ScheduledTask -TaskName CoreERPBiometricBridge | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName CoreERPBiometricBridge

# 2. Verify local bridge health & per-terminal status
Invoke-RestMethod http://127.0.0.1:4379/health
Invoke-RestMethod http://127.0.0.1:4379/status

# 3. Inspect structured redacted logs
Get-Content .\logs\bridge.log -Tail 30
Get-Content .\logs\supervisor.log -Tail 20
```

### Safe Uninstall
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-bridge.ps1
```
Safely stops and removes the Scheduled Task (and legacy NSSM service if installed) while **preserving `data\checkpoints.json`, `data\credentials.dpapi.json`, and `logs\`**.

---

## 6. Crash, Network & Sleep/Wake Self-Recovery

- **Device Network Outage (`192.168.1.201:4370`)**: Bridge stays alive, marks `deviceReachable: false` (`Device: DISCONNECTED`, `Bridge: ONLINE`), retries with bounded exponential backoff, and automatically restores `Device: CONNECTED` once TCP `4370` responds.
- **CoreERP API Outage (`127.0.0.1:3000`)**: Heartbeat and job-poll loops back off exponentially without exiting, retain queued punches locally in `data\checkpoints.json`, and resume heartbeats and job execution automatically when CoreERP restarts.
- **Windows Sleep / Hibernation Wake**: Bridge detects wall-clock jumps (`> 25s`), resets failure backoff, and immediately sends a fresh heartbeat and checks for pending user-sync jobs without modifying checkpoints.

---

## 7. Troubleshooting

| Symptom | Cause | Resolution |
|---|---|---|
| CoreERP shows `Bridge: OFFLINE` | Continuous bridge daemon is not running or CoreERP API unreachable | Run `Invoke-RestMethod http://127.0.0.1:4379/health` or `Start-ScheduledTask -TaskName CoreERPBiometricBridge`. |
| CoreERP shows `Bridge: ONLINE` and `Device: DISCONNECTED` | Bridge is running, but physical eSSL X2008 (`192.168.1.201:4370`) is unreachable or serial mismatched | Run `Test-NetConnection 192.168.1.201 -Port 4370` and check `logs\bridge.log`. |
| `DPAPI decryption failed` | Task running under a different Windows user or `SYSTEM` | Re-register with `scripts\install-task-scheduler.ps1` under the same Windows account that ran `protect-credentials.ps1`. |
| `HTTP 401 INVALID_DEVICE_CREDENTIALS` | Key rotated or revoked in CoreERP | Rotate key in CoreERP UI and re-run `scripts\protect-credentials.ps1 -Scope CurrentUser`. |
