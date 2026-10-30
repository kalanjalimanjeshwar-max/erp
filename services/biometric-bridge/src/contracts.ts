/**
 * Biometric Bridge API Data Contracts
 * Defined in Phase 1 for architectural readiness
 */

export interface BiometricDeviceConfig {
  deviceId: string;
  deviceIp: string;
  port: number;
  terminalModel: string; // e.g., 'ZKTeco-F22'
  location: string;
  companyCode: string;
}

export interface AttendancePunchEvent {
  deviceId: string;
  userEnrollmentId: string;
  punchTime: string; // ISO 8601 UTC timestamp
  verifyType: 'FINGERPRINT' | 'CARD' | 'PASSWORD' | 'FACE';
  inOutMode: 'CHECK_IN' | 'CHECK_OUT' | 'BREAK_OUT' | 'BREAK_IN';
}

export interface BridgeHeartbeatPayload {
  bridgeId: string;
  version: string;
  timestamp: string;
  monitoredDevicesCount: number;
  onlineDevicesCount: number;
}
