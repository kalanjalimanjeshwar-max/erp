export type BiometricVerifyType = 'FINGERPRINT' | 'CARD' | 'PASSWORD' | 'FACE';
export type PunchInOutMode = 'CHECK_IN' | 'CHECK_OUT' | 'BREAK_OUT' | 'BREAK_IN';

export interface TerminalConfig {
  id: string;
  name: string;
  serialNumber: string;
  ipAddress: string;
  port: number;
  commKey?: number;
  deviceTimezone: string;
  apiKey?: string;
  apiKeyEnv?: string;
  dpapiCredentialName?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  connectTimeoutMs?: number;
  skipSerialValidation?: boolean;
  enabled?: boolean;
}

export interface BridgeConfig {
  coreErpBaseUrl: string;
  allowInsecureHttp: boolean;
  bridgeHost: string;
  bridgeVersion: string;
  healthPort: number;
  healthHost: string;
  dataDir: string;
  logDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  batchSize: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  connectTimeoutMs: number;
  maxBackoffMs: number;
  dpapiStorePath: string;
  terminals: TerminalConfig[];
}

export interface ProtocolConnectOptions {
  host: string;
  port: number;
  commKey?: number;
  timeoutMs?: number;
}

export interface DeviceInfo {
  serialNumber: string | null;
  platform: string | null;
  fingerprintAlgorithm: string | null;
  firmwareVersion: string | null;
  deviceName: string | null;
  oemVendor: string | null;
}

export interface DeviceAttendanceRecord {
  uid: number;
  userEnrollmentId: string;
  localDateTime: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
  verifyCode: number;
  verifyType: BiometricVerifyType;
  inOutCode: number;
  inOutMode: PunchInOutMode;
  workCode: number;
  recordSequence: number;
}

export interface DeviceEnrolledUser {
  uid: number;
  enrollmentId: string;
  name: string | null;
  cardNo: string | null;
}

/**
 * Isolated Hardware Protocol Adapter Contract.
 * Implementations MUST strictly read logs without deleting device attendance data.
 */
export interface IBiometricProtocolAdapter {
  readonly protocolName: string;
  connect(options: ProtocolConnectOptions): Promise<void>;
  getDeviceInfo(): Promise<DeviceInfo>;
  getAttendanceLogs(): Promise<DeviceAttendanceRecord[]>;
  getUsers?(): Promise<DeviceEnrolledUser[]>;
  disconnect(): Promise<void>;
}

export interface NormalizedPunchEvent {
  devicePunchId: string;
  userEnrollmentId: string;
  punchTime: string; // ISO-8601 UTC
  verifyType: BiometricVerifyType;
  inOutMode: PunchInOutMode;
}

export interface PendingUserSyncSnapshot {
  users: DeviceEnrolledUser[];
  discoveredAt: string;
}

export interface TerminalCheckpoint {
  terminalKey: string;
  serialNumber: string;
  lastSyncedPunchTimeIso: string | null;
  lastSyncedDevicePunchId: string | null;
  recentPunchIds: string[];
  pendingQueue: NormalizedPunchEvent[];
  lastSuccessfulHeartbeatAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastSyncAttemptAt: string | null;
  lastProcessedPunchCount: number;
  lastError: string | null;
  deviceInfo?: DeviceInfo | null;
  lastSuccessfulUserSyncAt?: string | null;
  lastUserSyncAttemptAt?: string | null;
  lastUserSyncError?: string | null;
  discoveredUserCount?: number | null;
  syncedUserCount?: number | null;
  pendingUserSync?: PendingUserSyncSnapshot | null;
}

export interface BridgeCheckpointFile {
  version: 1;
  updatedAt: string;
  terminals: Record<string, TerminalCheckpoint>;
}

export interface TerminalRuntimeStatus {
  id: string;
  name: string;
  serialNumber: string;
  ipAddress: string;
  port: number;
  deviceTimezone: string;
  bridgeConnected: boolean;
  deviceReachable: boolean;
  authError: boolean;
  consecutiveFailures: number;
  nextRetryAt: string | null;
  pendingQueueSize: number;
  lastSuccessfulHeartbeatAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastSyncAttemptAt: string | null;
  lastProcessedPunchCount: number;
  lastError: string | null;
  deviceInfo: DeviceInfo | null;
  lastSuccessfulUserSyncAt: string | null;
  lastUserSyncAttemptAt: string | null;
  lastUserSyncError: string | null;
  discoveredUserCount: number | null;
  syncedUserCount: number | null;
}

export interface BridgeStatusSnapshot {
  bridgeVersion: string;
  bridgeHost: string;
  coreErpBaseUrl: string;
  startedAt: string;
  uptimeSeconds: number;
  running: boolean;
  terminals: TerminalRuntimeStatus[];
}
