export type BiometricVerifyType = 'FINGERPRINT' | 'CARD' | 'PASSWORD' | 'FACE';
export type PunchInOutMode = 'CHECK_IN' | 'CHECK_OUT' | 'BREAK_OUT' | 'BREAK_IN';
export type BridgeSyncMode = 'USER_SYNC_ONLY' | 'FULL';
export type CheckpointHealthState =
  | 'VALID'
  | 'MISSING'
  | 'CORRUPT'
  | 'INVALID_VERSION'
  | 'INVALID_SCHEMA';

export type CheckpointSafetyErrorCode =
  | 'CHECKPOINT_MISSING'
  | 'CHECKPOINT_CORRUPT'
  | 'CHECKPOINT_INVALID_VERSION'
  | 'CHECKPOINT_INVALID_SCHEMA'
  | 'TERMINAL_ENTRY_MISSING'
  | 'TERMINAL_ID_CHANGED'
  | 'TERMINAL_SERIAL_MISMATCH'
  | 'MISSING_WATERMARK'
  | 'INVALID_TERMINAL_ENTRY'
  | 'INVALID_CUTOFF'
  | 'SYNC_MODE_BLOCKED';

export interface TerminalConfig {
  id: string;
  name: string;
  serialNumber: string;
  ipAddress: string;
  port: number;
  commKey?: number;
  deviceTimezone: string;
  minPunchTimeIso?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  dpapiCredentialName?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  deviceHealthCheckIntervalMs?: number;
  jobPollIntervalMs?: number;
  userSyncTimeoutMs?: number;
  connectTimeoutMs?: number;
  skipSerialValidation?: boolean;
  enabled?: boolean;
}

export interface BridgeConfig {
  coreErpBaseUrl: string;
  allowInsecureHttp: boolean;
  bridgeHost: string;
  bridgeVersion: string;
  syncMode?: BridgeSyncMode;
  minPunchTimeIso?: string;
  healthPort: number;
  healthHost: string;
  dataDir: string;
  logDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  batchSize: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  deviceHealthCheckIntervalMs?: number;
  jobPollIntervalMs?: number;
  userSyncTimeoutMs?: number;
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

export type UserSyncOutcome =
  | 'SUCCESS'
  | 'EMPTY_DEVICE_USERS'
  | 'UNSUPPORTED_COMMAND'
  | 'COMMUNICATION_FAILURE'
  | 'MALFORMED_RESPONSE';

export type BridgeUserSyncJobState = 'IDLE' | 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface ProtocolDiagnosticEvent {
  operation: 'get_free_sizes' | 'get_users' | 'read_with_buffer' | 'read_chunk' | 'decode_users' | 'send_command';
  commandId?: number;
  commandName?: string;
  replyCommand?: number;
  replyCommandName?: string;
  expectedReplyId?: number;
  receivedReplyId?: number;
  payloadBytes?: number;
  expectedBytes?: number;
  chunkOffset?: number;
  chunkLength?: number;
  reportedUserCount?: number | null;
  recordSize?: number | null;
  recordCount?: number;
  outcome?: UserSyncOutcome;
  message?: string;
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
  syncMode: BridgeSyncMode;
  punchSyncBlocked: boolean;
  punchSyncBlockReason: string | null;
  effectiveCutoffIso: string | null;
  lastFilteredHistoricalCount: number;
  lastSkippedBeforeWatermarkCount: number;
  bridgeConnected: boolean;
  deviceReachable: boolean;
  lastDeviceContactAt: string | null;
  authError: boolean;
  consecutiveFailures: number;
  heartbeatConsecutiveFailures: number;
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
  userSyncJobStatus: BridgeUserSyncJobState;
  activeUserSyncJobId: string | null;
}

export interface BridgeStatusSnapshot {
  bridgeVersion: string;
  bridgeHost: string;
  coreErpBaseUrl: string;
  syncMode: BridgeSyncMode;
  pid: number;
  startedAt: string;
  uptimeSeconds: number;
  running: boolean;
  terminals: TerminalRuntimeStatus[];
}
