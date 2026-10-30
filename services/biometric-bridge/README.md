# CoreERP Biometric LAN Bridge Service (Phase Architecture Specification)

## Architectural Purpose
Biometric devices (e.g. ZKTeco F22 / standalone LAN time-attendance terminals) reside inside local corporate physical subnets behind firewalls and NATs. They cannot and should not be directly exposed to the public internet or external cloud ERP endpoints.

This service is designed as an edge daemon deployed on a small LAN device (e.g. Raspberry Pi, Windows service, or on-premise Linux server) situated on the same subnet as the biometric hardware.

## Implementation Status & Limitations (Phase 8.6)
> **IMPORTANT NOTICE:**
> The current bridge source code in `services/biometric-bridge/src/` (`contracts.ts` and `index.ts`) is an **architectural specification and data contract stub**.
> **It is NOT YET a working physical ZKTeco socket driver.**
> - The live UDP/TCP device socket listener and binary ZK protocol handlers have not yet been implemented.
> - **Zero physical device or live hardware verification has been performed.** Do not assume physical hardware compatibility or live terminal synchronization until dedicated hardware driver development is completed.
> - The cloud ERP backend endpoints (`POST /api/biometric/punches`, `POST /api/biometric/heartbeat`, deactivation, and key rotation) are fully implemented, authenticated, and tested via simulated unit suites.

## Communication Pattern
```
+------------------------+          Local Subnet           +---------------------------------+
| Physical F22 Biometric |  <--- UDP/TCP Device Port --->  | CoreERP Biometric Bridge Daemon |
| Terminal (Unverified)  |         (Driver Pending)        | (Node.js/TypeScript LAN Edge)   |
+------------------------+                                 +---------------------------------+
                                                                            |
                                                       Outbound HTTPS Push  | Header: X-Device-Api-Key
                                                                            v
                                                           +---------------------------------+
                                                           | CoreERP Platform Cloud / VPS    |
                                                           | POST /api/biometric/punches     |
                                                           | POST /api/biometric/heartbeat   |
                                                           +---------------------------------+
```

## API Contracts & Authentication
The CoreERP backend expects requests authenticated with the per-terminal device API key issued upon terminal registration:

- **Punch Batch Ingestion**: `POST /api/biometric/punches`
  - Header: `X-Device-Api-Key: <terminal-api-key>`
  - Body: `{ punches: [ { deviceId, userEnrollmentId, punchTime, verifyType, inOutMode } ] }`
  - Responses: `201 Created` with accepted/duplicate counts, or `401 Unauthorized` / `429 Rate Limited`.
- **Terminal Heartbeat**: `POST /api/biometric/heartbeat`
  - Header: `X-Device-Api-Key: <terminal-api-key>`
  - Updates terminal heartbeat freshness (5-minute operational online window).

---

## Required Hardware Model & Protocol Information Before Physical Driver Implementation

Before implementing the physical ZKTeco device socket driver in a subsequent development phase, the following exact hardware specifications and configuration details must be collected and confirmed from the client's physical environment:

### 1. Terminal Hardware Model & Operating Architecture
- **Exact Model Numbers**: Verify specific device models in use (e.g. ZKTeco F22, iClock 880, K40, SilkBio-101TC, uFace800, or G3).
- **Firmware Platform**:
  - **Standalone Pull SDK Architecture** (Linux-based ZMM220 / ZEM560 / ZEM800 core boards): Edge daemon initiates binary socket connection on port 4370.
  - **Push SDK / ADMS Architecture** (BioTime / Cloud firmware): Terminal initiates HTTP/HTTPS POST requests directly to an ADMS/iClock web receiver endpoint.
- **Biometric Algorithm Version**: ZKFinger 10.0 vs. ZKFinger 12.0 or ZKFace 7.0 (determines fingerprint/face template encoding format).

### 2. Transport & Socket Protocol Specifications
- **Transport Layer**: UDP (default ZKTeco standalone port 4370) or TCP (newer firmware supporting reliable streams).
- **Packet Framing Structure**: 8-byte fixed binary header:
  - `command_code` (uint16, 2 bytes, little-endian): e.g. `CMD_CONNECT (1000)`, `CMD_AUTH (1102)`, `CMD_ATTLOG_RRQ (501)`, `CMD_PREPARE_DATA (1500)`, `CMD_DATA (1501)`, `CMD_ACKOK (2000)`, `CMD_FREE_DATA (1502)`, `CMD_EXIT (1001)`.
  - `checksum` (uint16, 2 bytes): 16-bit 1's complement sum calculation.
  - `session_id` (uint16, 2 bytes): Session identifier assigned by terminal during handshake.
  - `reply_number` (uint16, 2 bytes): Incremental sequence counter.
- **Communication Password / Comm Key**: Numerical key configured in terminal security settings (`Comm Key`, default `0`).

### 3. Binary Payload Structure & Punch Field Mappings
- **User Enrollment ID Format**: Numeric integer PIN (uint16/uint32) vs. 24-byte ASCII null-terminated alphanumeric employee badge ID.
- **Timestamp Encoding**:
  - 32-bit packed integer: `((year % 100) * 12 * 31 + ((month - 1) * 31) + day - 1) * 86400 + (hour * 3600) + (minute * 60) + second`.
  - Local timezone offset relative to UTC (e.g. Asia/Kolkata +05:30 vs. UTC storage).
- **Verification Modes**:
  - `1`: Fingerprint
  - `2`: PIN / Password
  - `3`: RFID / Proximity Card
  - `4`: Facial Recognition
  - `15`: Palm Recognition
- **State / In-Out Codes**:
  - `0`: Check-In
  - `1`: Check-Out
  - `2`: Break-Out
  - `3`: Break-In
  - `4`: Overtime-In
  - `5`: Overtime-Out

### 4. Physical Subnet Topology & Deployment Requirements
- **Local Network Assignment**: Static IP address or permanent DHCP MAC reservation for each biometric terminal on the corporate subnet.
- **Edge Bridge Host Requirements**: A dedicated lightweight LAN device (e.g. Raspberry Pi 4/5, on-premise Linux VM, or Windows service) with:
  - Unfiltered local UDP/TCP port 4370 access to terminal IPs.
  - Outbound HTTPS (TLS 1.3) access to the CoreERP cloud or VPS endpoint (`POST /api/biometric/punches`).
  - Persistent storage for local punch spooling in case of WAN internet outage.

