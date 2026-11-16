# CoreERP eSSL X2008 Biometric LAN Bridge

Permanent Windows-compatible LAN Bridge service that polls **eSSL X2008** (Platform `ZLM60_TFT`, Fingerprint Algorithm `VX10.0`) standalone biometric terminals over LAN TCP port `4370` and pushes idempotent attendance punches and heartbeats to CoreERP.

---

## 1. Hardware & Protocol Verification Notes

- **Target Hardware**: eSSL X2008 (`ZLM60_TFT` OEM ZKTeco platform, `VX10.0` fingerprint algorithm, e.g. Serial `NFZ8252800275`).
- **Transport**: ZKTeco Standalone Pull TCP Protocol on port `4370` (`START_TAG = 0x5050827D`).
- **Implementation**: Zero-dependency pure Node.js `net.Socket` protocol driver (`ZKTecoTcpAdapter`) isolated behind `IBiometricProtocolAdapter`.
  - **Licensing**: Implemented cleanly in-repo with Node.js 22 standard library (`net`, `crypto`, `http`, `fs`) — no GPL/AGPL libraries, no unmaintained `node-zklib` / `zkteco-js` runtime dependencies, and no 32-bit `zkemkeeper.dll` COM registration dependency.
  - **Official SDK Alternative**: Because protocol parsing is isolated behind `IBiometricProtocolAdapter`, if an older/custom OEM firmware locks TCP 4370 behind proprietary encryption, a Windows COM (`zkemkeeper.dll`) or ADMS push adapter can implement the same interface without altering `BiometricBridgeRunner` or CoreERP backend contracts.
- **Safety Guarantee**: The bridge is **strictly read-only** against the biometric terminal. It NEVER issues `CMD_CLEAR_ATTLOG` or modifies terminal user/attendance storage.
- **Timezone Accuracy**: ZKTeco devices store timestamps in local wall-clock time without a timezone offset. The bridge converts device timestamps using `deviceTimezone` (default `Asia/Kolkata`) into exact UTC ISO-8601 before uploading to CoreERP.

---

## 2. Architecture

```
[eSSL X2008: 192.168.1.201:4370]
       ▲  TCP 4370 (ZKTeco Pull Protocol, Read-Only)
       │
[Windows Bridge PC: 192.168.1.16]
  ├─ ZKTecoTcpAdapter (IBiometricProtocolAdapter)
  ├─ CheckpointStore (data/checkpoints.json, atomic write + pendingQueue)
  ├─ Windows DPAPI Store (data/credentials.dpapi.json)
  ├─ Local Health Endpoint (http://127.0.0.1:4379/health & /status)
  └─ CoreErpHttpClient
       │  HTTPS (X-Device-Api-Key + X-Device-Serial)
       ▼
[CoreERP Server]
  ├─ POST /api/biometric/heartbeat
  └─ POST /api/biometric/punches
```

---

## 3. Windows Deployment (PC `192.168.1.16`)

### Prerequisites
- Windows 10 / 11 or Windows Server 2019+
- **Node.js 22 LTS** installed (`node -v`)
- Network reachability from `192.168.1.16` to `192.168.1.201` TCP port `4370` (subnet `255.255.255.0`)

Verify LAN connectivity in PowerShell:
```powershell
Test-NetConnection -ComputerName 192.168.1.201 -Port 4370
```

### Step 1: Build & Configure
Copy `bridges/essl-x2008-bridge` to `C:\CoreERP\essl-x2008-bridge`, then:
```powershell
cd C:\CoreERP\essl-x2008-bridge
npm run build
Copy-Item bridge.config.example.json bridge.config.json
Copy-Item .env.example .env
```
Edit `bridge.config.json` with:
- `coreErpBaseUrl`: Your CoreERP HTTPS URL (e.g. `https://erp.company.com`)
- `serialNumber`: Exact serial printed on the terminal (`NFZ8252800275`)
- `ipAddress`: `192.168.1.201`
- `port`: `4370`
- `commKey`: `0` (default unless configured on the X2008 menu -> Comm. -> Comm Key)
- `deviceTimezone`: `Asia/Kolkata`

### Step 2: Store Device API Key Securely via Windows DPAPI
Register the terminal in CoreERP (**Biometric Devices -> Register Terminal**) and copy the one-time `bio_live_...` API key. Store it encrypted with Windows DPAPI (no plaintext key on disk):
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\protect-credentials.ps1 -CredentialName "coreerp-essl-x2008-main" -Scope LocalMachine
```
*(Use `-Scope CurrentUser` if running interactively instead of a `LocalSystem` Windows Service.)*

### Step 3: Run Connection Diagnostics
```powershell
npm run test-connection
```
This connects to `192.168.1.201:4370`, reads `~SerialNumber`, `~Platform`, `~ZKFPVersion`, verifies serial match against `NFZ8252800275`, reads attendance log count (without deleting logs), and verifies authenticated `POST /api/biometric/heartbeat`.

### Step 4: Run One-Shot Sync Check
```powershell
npm run sync-once
```

### Step 5: Install as a Permanent Background Service

#### Option A: NSSM (Recommended)
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-nssm-service.ps1
```
#### Option B: Windows Task Scheduler
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-task-scheduler.ps1
```

---

## 4. Operations, Restart & Uninstall

- **Local Status & Health**:
  - `http://127.0.0.1:4379/health` (`200 OK` or `503 degraded`)
  - `http://127.0.0.1:4379/status` (per-terminal queue size, last heartbeat/sync, redacted errors)
  - CLI: `npm run status`
- **Safe Restart**:
  ```powershell
  Restart-Service CoreERPBiometricBridge
  ```
  All unsynced batches in `data/checkpoints.json` are preserved atomically and uploaded automatically upon restart.
- **Logs**: Structured JSON logs with automatic secret redaction are written to `logs/bridge.log` (5 MB auto-rotation).
- **Uninstall**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-bridge.ps1
  ```

---

## 5. Troubleshooting

| Symptom | Cause | Resolution |
|---|---|---|
| `TCP connection timed out` to `192.168.1.201:4370` | Firewall or VLAN blocking port 4370, or terminal powered off | Run `Test-NetConnection 192.168.1.201 -Port 4370` and verify X2008 Ethernet settings (`192.168.1.201 / 255.255.255.0`). |
| `Hardware serial mismatch` | Configured `serialNumber` differs from device `~SerialNumber` | Update `bridge.config.json` and CoreERP terminal registration to match the exact device serial (`NFZ8252800275`). |
| `CMD_AUTH failed` | Non-zero Comm Key configured on the X2008 terminal | Set `commKey` in `bridge.config.json` to match `Menu -> Comm. -> Comm Key` on the device. |
| `HTTP 401 INVALID_DEVICE_CREDENTIALS` | Wrong/revoked API key or rotated key in CoreERP | Rotate key in CoreERP UI and re-run `scripts\protect-credentials.ps1`. |
| `Insecure CoreERP URL rejected` | `http://` used for non-localhost CoreERP server | Switch `coreErpBaseUrl` to `https://` (recommended). For isolated LAN HTTP dev only, set `BRIDGE_ALLOW_INSECURE_HTTP=true`. |
| Punches appear shifted by 5h 30m | Wrong `deviceTimezone` configured | Verify `"deviceTimezone": "Asia/Kolkata"` in `bridge.config.json`. |
