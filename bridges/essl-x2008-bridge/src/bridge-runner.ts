import {
  BridgeConfig,
  BridgeStatusSnapshot,
  BridgeSyncMode,
  DeviceAttendanceRecord,
  DeviceEnrolledUser,
  DeviceInfo,
  IBiometricProtocolAdapter,
  NormalizedPunchEvent,
  PendingUserSyncSnapshot,
  TerminalConfig,
  TerminalRuntimeStatus,
} from './types.js';
import { CheckpointSafetyError, CheckpointStore } from './checkpoint-store.js';
import {
  DEFAULT_DEVICE_HEALTH_CHECK_INTERVAL_MS,
  parseBridgeSyncMode,
  validateStrictIsoTimestamp,
} from './config.js';
import { CoreErpApiError, ICoreErpClient } from './coreerp-client.js';
import { BridgeLogger, redactSensitiveText } from './logger.js';
import { ZKTecoTcpAdapter } from './protocol/zkteco-tcp.adapter.js';
import { resolveTerminalApiKey, validateTransportUrl } from './security/dpapi.js';
import { deviceLocalDateTimeToUtcIso, formatLocalWallClock, isValidIanaTimezone } from './timezone.js';

export type AdapterFactory = (terminal: TerminalConfig) => IBiometricProtocolAdapter;

export interface EffectivePunchCutoffResult {
  deviceTimezone: string;
  currentLocalDate: string;
  currentDayStartIso: string;
  explicitMinPunchTimeIso: string | null;
  effectiveCutoffIso: string;
}

/**
 * Computes the mandatory start-of-current-day cutoff in the terminal's configured IANA deviceTimezone
 * (e.g., Asia/Kolkata -> UTC), optionally tightened—NEVER weakened—by explicit minPunchTimeIso settings.
 */
export function computeEffectivePunchCutoff(
  deviceTimezone: string,
  options?: {
    now?: Date;
    bridgeMinPunchTimeIso?: string;
    terminalMinPunchTimeIso?: string;
  }
): EffectivePunchCutoffResult {
  if (!isValidIanaTimezone(deviceTimezone)) {
    throw new CheckpointSafetyError(
      'INVALID_CUTOFF',
      `Cannot compute current-day punch cutoff: invalid deviceTimezone '${String(deviceTimezone)}'.`,
      { filePath: '' }
    );
  }

  const tz = deviceTimezone.trim();
  const now = options?.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new CheckpointSafetyError(
      'INVALID_CUTOFF',
      'Cannot compute current-day punch cutoff: invalid reference clock timestamp.',
      { filePath: '' }
    );
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new CheckpointSafetyError(
      'INVALID_CUTOFF',
      `Failed to resolve current local calendar date in timezone '${tz}'.`,
      { filePath: '' }
    );
  }

  const currentDayStartIso = deviceLocalDateTimeToUtcIso(
    { year, month, day, hour: 0, minute: 0, second: 0 },
    tz
  );
  const currentDayStartMs = Date.parse(currentDayStartIso);
  if (Number.isNaN(currentDayStartMs)) {
    throw new CheckpointSafetyError(
      'INVALID_CUTOFF',
      `Failed to convert start-of-day in timezone '${tz}' to UTC ISO.`,
      { filePath: '' }
    );
  }

  let explicitMinMs: number | null = null;
  let explicitMinPunchTimeIso: string | null = null;

  const explicitCandidates: Array<{ raw?: string; label: string }> = [
    { raw: options?.bridgeMinPunchTimeIso, label: 'minPunchTimeIso' },
    { raw: options?.terminalMinPunchTimeIso, label: 'terminal.minPunchTimeIso' },
  ];

  for (const candidate of explicitCandidates) {
    if (candidate.raw === undefined || String(candidate.raw).trim() === '') continue;
    let normalizedIso: string;
    try {
      normalizedIso = validateStrictIsoTimestamp(String(candidate.raw), candidate.label);
    } catch (err: unknown) {
      throw new CheckpointSafetyError(
        'INVALID_CUTOFF',
        (err as Error)?.message || `Invalid ${candidate.label}`,
        { filePath: '' }
      );
    }
    const candidateMs = Date.parse(normalizedIso);
    if (explicitMinMs === null || candidateMs > explicitMinMs) {
      explicitMinMs = candidateMs;
      explicitMinPunchTimeIso = normalizedIso;
    }
  }

  // Mandatory current-day cutoff can NEVER be weakened by an earlier explicit minPunchTimeIso.
  const effectiveMs =
    explicitMinMs !== null ? Math.max(currentDayStartMs, explicitMinMs) : currentDayStartMs;

  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    deviceTimezone: tz,
    currentLocalDate: `${year}-${pad(month)}-${pad(day)}`,
    currentDayStartIso,
    explicitMinPunchTimeIso,
    effectiveCutoffIso: new Date(effectiveMs).toISOString(),
  };
}

export interface DiagnosticReport {
  terminalId: string;
  name: string;
  serialNumber: string;
  ipAddress: string;
  port: number;
  configValid: boolean;
  tcpConnected: boolean;
  serialMatched: boolean;
  deviceInfo: DeviceInfo | null;
  attendanceRecordCount: number | null;
  enrolledUserCount: number | null;
  userQueryError: string | null;
  coreErpHeartbeatOk: boolean;
  error: string | null;
}

export interface HealthProbeResult {
  terminalId: string;
  skipped: boolean;
  reachable: boolean;
  transitioned: boolean;
  heartbeatSent: boolean;
  deviceInfo: DeviceInfo | null;
  error: string | null;
}

interface TerminalController {
  config: TerminalConfig;
  runtime: TerminalRuntimeStatus;
  pollTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  jobPollTimer: NodeJS.Timeout | null;
  healthCheckTimer: NodeJS.Timeout | null;
  inFlightSync: boolean;
  inFlightUserSync: boolean;
  inFlightHeartbeat: boolean;
  inFlightJobPoll: boolean;
  inFlightHealthCheck: boolean;
  inFlightDeviceIo: boolean;
  deferredUserSyncPending: boolean;
  deferredPunchSyncPending: boolean;
  deferredHeartbeatPending: boolean;
  hasHealthSample: boolean;
  lastDeviceConnectionError: string | null;
  activeTasks: Set<Promise<unknown>>;
  deviceUsers?: DeviceEnrolledUser[];
  pendingUserSync: PendingUserSyncSnapshot | null;
}

export class BiometricBridgeRunner {
  private readonly config: BridgeConfig;
  private readonly syncMode: BridgeSyncMode;
  private readonly logger: BridgeLogger;
  private readonly checkpointStore: CheckpointStore;
  private readonly coreErpClient: ICoreErpClient;
  private readonly adapterFactory: AdapterFactory;
  private readonly nowProvider: () => Date;
  private readonly controllers = new Map<string, TerminalController>();
  private readonly startedAt = new Date();
  private running = false;
  private stopped = false;
  private wakeCheckTimer: NodeJS.Timeout | null = null;
  private lastWakeTickMs = Date.now();

  constructor(options: {
    config: BridgeConfig;
    logger: BridgeLogger;
    checkpointStore: CheckpointStore;
    coreErpClient: ICoreErpClient;
    adapterFactory?: AdapterFactory;
    nowProvider?: () => Date;
  }) {
    this.config = options.config;
    this.syncMode = parseBridgeSyncMode(this.config.syncMode);
    this.logger = options.logger;
    this.checkpointStore = options.checkpointStore;
    this.coreErpClient = options.coreErpClient;
    this.nowProvider = options.nowProvider || (() => new Date());
    this.adapterFactory =
      options.adapterFactory ||
      ((term) =>
        new ZKTecoTcpAdapter({
          onDiagnostic: (diag) => {
            const meta = {
              terminalId: term.id,
              serialNumber: term.serialNumber,
              ...diag,
            };
            if (
              diag.outcome === 'MALFORMED_RESPONSE' ||
              diag.outcome === 'UNSUPPORTED_COMMAND' ||
              diag.outcome === 'COMMUNICATION_FAILURE'
            ) {
              this.logger.warn('terminal_protocol_diagnostic', meta);
            } else if (diag.operation === 'decode_users') {
              this.logger.info('terminal_protocol_diagnostic', meta);
            } else {
              this.logger.debug('terminal_protocol_diagnostic', meta);
            }
          },
        }));

    validateTransportUrl(this.config.coreErpBaseUrl, this.config.allowInsecureHttp);

    if (this.config.minPunchTimeIso !== undefined && String(this.config.minPunchTimeIso).trim() !== '') {
      validateStrictIsoTimestamp(String(this.config.minPunchTimeIso), 'minPunchTimeIso');
    }

    if (this.config.deviceHealthCheckIntervalMs !== undefined) {
      this.validateHealthCheckIntervalMs(
        this.config.deviceHealthCheckIntervalMs,
        'deviceHealthCheckIntervalMs'
      );
    }

    for (const term of this.config.terminals) {
      if (term.enabled === false) continue;
      this.validateTerminalConfig(term);

      // Non-mutating read-only lookup: constructor must NEVER create or reset checkpoints.json
      const cp = this.checkpointStore.peekTerminal(term.id);

      let initialCutoffIso: string | null = null;
      let punchSyncBlocked = this.syncMode === 'USER_SYNC_ONLY';
      let punchSyncBlockReason: string | null =
        this.syncMode === 'USER_SYNC_ONLY'
          ? 'Bridge syncMode is USER_SYNC_ONLY; punch polling is disabled.'
          : null;
      let initialError: string | null = cp?.lastError ?? null;

      try {
        initialCutoffIso = this.computeTerminalCutoff(term).effectiveCutoffIso;
      } catch (cutoffErr: unknown) {
        punchSyncBlocked = true;
        punchSyncBlockReason = redactSensitiveText(
          (cutoffErr as Error)?.message || 'Invalid effective punch cutoff configuration.'
        );
        if (this.syncMode === 'FULL') {
          initialError = punchSyncBlockReason;
        }
      }

      if (this.syncMode === 'FULL' && !punchSyncBlocked) {
        try {
          this.checkpointStore.validateTerminalForPunchSync(term.id, term.serialNumber);
        } catch (safetyErr: unknown) {
          punchSyncBlocked = true;
          punchSyncBlockReason = redactSensitiveText(
            (safetyErr as Error)?.message || 'Checkpoint failed safety validation.'
          );
          initialError = punchSyncBlockReason;
        }
      }

      this.controllers.set(term.id, {
        config: term,
        runtime: {
          id: term.id,
          name: term.name,
          serialNumber: term.serialNumber,
          ipAddress: term.ipAddress,
          port: term.port,
          deviceTimezone: term.deviceTimezone,
          syncMode: this.syncMode,
          punchSyncBlocked,
          punchSyncBlockReason,
          effectiveCutoffIso: initialCutoffIso,
          lastFilteredHistoricalCount: 0,
          lastSkippedBeforeWatermarkCount: 0,
          bridgeConnected: false,
          deviceReachable: false,
          lastDeviceContactAt: null,
          authError: false,
          consecutiveFailures: 0,
          heartbeatConsecutiveFailures: 0,
          nextRetryAt: null,
          pendingQueueSize: cp?.pendingQueue.length ?? 0,
          lastSuccessfulHeartbeatAt: cp?.lastSuccessfulHeartbeatAt ?? null,
          lastSuccessfulSyncAt: cp?.lastSuccessfulSyncAt ?? null,
          lastSyncAttemptAt: cp?.lastSyncAttemptAt ?? null,
          lastProcessedPunchCount: cp?.lastProcessedPunchCount ?? 0,
          lastError: initialError,
          deviceInfo: cp?.deviceInfo || null,
          lastSuccessfulUserSyncAt: cp?.lastSuccessfulUserSyncAt ?? null,
          lastUserSyncAttemptAt: cp?.lastUserSyncAttemptAt ?? null,
          lastUserSyncError: cp?.lastUserSyncError ?? null,
          discoveredUserCount: cp?.discoveredUserCount ?? null,
          syncedUserCount: cp?.syncedUserCount ?? null,
          userSyncJobStatus: 'IDLE',
          activeUserSyncJobId: null,
        },
        pollTimer: null,
        heartbeatTimer: null,
        jobPollTimer: null,
        healthCheckTimer: null,
        inFlightSync: false,
        inFlightUserSync: false,
        inFlightHeartbeat: false,
        inFlightJobPoll: false,
        inFlightHealthCheck: false,
        inFlightDeviceIo: false,
        deferredUserSyncPending: false,
        deferredPunchSyncPending: false,
        deferredHeartbeatPending: false,
        hasHealthSample: false,
        lastDeviceConnectionError: null,
        activeTasks: new Set<Promise<unknown>>(),
        deviceUsers: cp?.pendingUserSync?.users,
        pendingUserSync: cp?.pendingUserSync ?? null,
      });
    }
  }

  getSyncMode(): BridgeSyncMode {
    return this.syncMode;
  }

  validateTerminalConfig(term: TerminalConfig): void {
    if (!term.id?.trim()) throw new Error('Terminal configuration missing required id.');
    if (!term.serialNumber?.trim()) {
      throw new Error(`Terminal '${term.id}' missing required serialNumber.`);
    }
    if (!term.ipAddress?.trim() || /[\s/\\]/.test(term.ipAddress.trim())) {
      throw new Error(`Terminal '${term.id}' has invalid ipAddress '${term.ipAddress}'.`);
    }
    if (!Number.isInteger(term.port) || term.port < 1 || term.port > 65535) {
      throw new Error(`Terminal '${term.id}' has invalid TCP port '${term.port}'.`);
    }
    if (!isValidIanaTimezone(term.deviceTimezone)) {
      throw new Error(`Terminal '${term.id}' has invalid deviceTimezone '${term.deviceTimezone}'.`);
    }
    if (term.minPunchTimeIso !== undefined && String(term.minPunchTimeIso).trim() !== '') {
      validateStrictIsoTimestamp(
        String(term.minPunchTimeIso),
        `terminals['${term.id}'].minPunchTimeIso`
      );
    }
    if (term.deviceHealthCheckIntervalMs !== undefined) {
      this.validateHealthCheckIntervalMs(
        term.deviceHealthCheckIntervalMs,
        `terminals['${term.id}'].deviceHealthCheckIntervalMs`
      );
    }
  }

  private validateHealthCheckIntervalMs(value: number, fieldName: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Invalid ${fieldName} '${String(value)}'. Expected a positive finite number in milliseconds.`
      );
    }
  }

  private getDeviceHealthCheckIntervalMs(ctrl: TerminalController): number {
    return (
      ctrl.config.deviceHealthCheckIntervalMs ??
      this.config.deviceHealthCheckIntervalMs ??
      DEFAULT_DEVICE_HEALTH_CHECK_INTERVAL_MS
    );
  }

  private computeTerminalCutoff(term: TerminalConfig): EffectivePunchCutoffResult {
    return computeEffectivePunchCutoff(term.deviceTimezone, {
      now: this.nowProvider(),
      bridgeMinPunchTimeIso: this.config.minPunchTimeIso,
      terminalMinPunchTimeIso: term.minPunchTimeIso,
    });
  }

  private assertPunchSyncReady(ctrl: TerminalController): EffectivePunchCutoffResult {
    const term = ctrl.config;

    if (this.syncMode === 'USER_SYNC_ONLY') {
      const reason =
        `Refusing normal punch sync for terminal '${term.id}': bridge syncMode is 'USER_SYNC_ONLY'.`;
      ctrl.runtime.punchSyncBlocked = true;
      ctrl.runtime.punchSyncBlockReason = reason;
      throw new CheckpointSafetyError('SYNC_MODE_BLOCKED', reason, {
        terminalKey: term.id,
        filePath: this.checkpointStore.getFilePath(),
      });
    }

    try {
      this.checkpointStore.validateTerminalForPunchSync(term.id, term.serialNumber);
      const cutoff = this.computeTerminalCutoff(term);
      ctrl.runtime.punchSyncBlocked = false;
      ctrl.runtime.punchSyncBlockReason = null;
      ctrl.runtime.effectiveCutoffIso = cutoff.effectiveCutoffIso;
      return cutoff;
    } catch (err: unknown) {
      const safeMsg = redactSensitiveText(
        (err as Error)?.message || 'Checkpoint or cutoff validation failed.'
      );
      ctrl.runtime.punchSyncBlocked = true;
      ctrl.runtime.punchSyncBlockReason = safeMsg;
      ctrl.runtime.lastError = safeMsg;

      const safetyCode = err instanceof CheckpointSafetyError ? err.code : 'INVALID_CUTOFF';
      const corruptBackupPath =
        err instanceof CheckpointSafetyError ? err.corruptBackupPath : null;

      this.logger.error('terminal_punch_sync_blocked_fail_closed', {
        terminalId: term.id,
        serialNumber: term.serialNumber,
        syncMode: this.syncMode,
        code: safetyCode,
        checkpointFile: this.checkpointStore.getFilePath(),
        corruptBackupPath,
        error: safeMsg,
      });

      if (err instanceof CheckpointSafetyError) {
        throw err;
      }
      throw new CheckpointSafetyError('INVALID_CUTOFF', safeMsg, {
        terminalKey: term.id,
        filePath: this.checkpointStore.getFilePath(),
      });
    }
  }

  private trackTask(ctrl: TerminalController, task: Promise<unknown>): Promise<unknown> {
    ctrl.activeTasks.add(task);
    void task.finally(() => {
      ctrl.activeTasks.delete(task);
    });
    return task;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.lastWakeTickMs = Date.now();

    this.logger.info('bridge_starting', {
      bridgeHost: this.config.bridgeHost,
      bridgeVersion: this.config.bridgeVersion,
      syncMode: this.syncMode,
      pid: process.pid,
      terminalCount: this.controllers.size,
      coreErpBaseUrl: this.config.coreErpBaseUrl,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      deviceHealthCheckIntervalMs:
        this.config.deviceHealthCheckIntervalMs ?? DEFAULT_DEVICE_HEALTH_CHECK_INTERVAL_MS,
      jobPollIntervalMs: this.config.jobPollIntervalMs ?? 5000,
    });

    for (const ctrl of this.controllers.values()) {
      if (this.syncMode === 'USER_SYNC_ONLY') {
        ctrl.runtime.punchSyncBlocked = true;
        ctrl.runtime.punchSyncBlockReason =
          'Bridge syncMode is USER_SYNC_ONLY; punch polling is disabled.';
        this.logger.info('bridge_punch_sync_disabled_user_sync_only', {
          terminalId: ctrl.config.id,
          serialNumber: ctrl.config.serialNumber,
          syncMode: this.syncMode,
        });
      } else {
        // Fail-closed startup gate: never start punch polling unless checkpoint & cutoff pass validation
        try {
          this.assertPunchSyncReady(ctrl);
          void this.trackTask(ctrl, this.runTerminalPollCycle(ctrl.config.id));
        } catch {
          // Critical error already logged and runtime marked punchSyncBlocked=true
        }
      }

      // Independent hardware reachability probe runs in both USER_SYNC_ONLY and FULL modes
      // (strictly calls getDeviceInfo() only; never touches attendance logs or checkpoints).
      void this.trackTask(ctrl, this.runTerminalHealthCheckLoop(ctrl.config.id));

      // Heartbeat and user-sync job discovery loops remain operational for UI User Sync jobs
      void this.trackTask(ctrl, this.runTerminalHeartbeatLoop(ctrl.config.id));
      if (typeof this.coreErpClient.claimUserSyncJob === 'function') {
        this.scheduleNextJobPoll(
          ctrl,
          ctrl.config.jobPollIntervalMs ?? this.config.jobPollIntervalMs ?? 5000
        );
      }
    }

    // Sleep/wake wall-clock drift detector: recovers immediately after Windows sleep/hibernation
    const wakeCheckIntervalMs = 10000;
    this.wakeCheckTimer = setInterval(() => {
      const nowMs = Date.now();
      const elapsed = nowMs - this.lastWakeTickMs;
      this.lastWakeTickMs = nowMs;
      if (this.running && elapsed > wakeCheckIntervalMs + 15000) {
        this.logger.warn('bridge_sleep_wake_detected', {
          elapsedMs: elapsed,
          terminalCount: this.controllers.size,
        });
        this.triggerImmediateRecoveryAll();
      }
    }, wakeCheckIntervalMs);
    if (typeof this.wakeCheckTimer.unref === 'function') {
      this.wakeCheckTimer.unref();
    }
  }

  /**
   * Triggers immediate heartbeat + job check recovery across all terminals (e.g., after sleep/wake)
   * without touching or resetting any checkpoint data.
   */
  triggerImmediateRecoveryAll(): void {
    if (!this.running) return;
    for (const ctrl of this.controllers.values()) {
      ctrl.runtime.heartbeatConsecutiveFailures = 0;
      ctrl.runtime.consecutiveFailures = 0;
      if (ctrl.heartbeatTimer) {
        clearTimeout(ctrl.heartbeatTimer);
        ctrl.heartbeatTimer = null;
      }
      if (ctrl.healthCheckTimer) {
        clearTimeout(ctrl.healthCheckTimer);
        ctrl.healthCheckTimer = null;
      }
      void this.trackTask(ctrl, this.runTerminalHealthCheckLoop(ctrl.config.id));
      void this.trackTask(ctrl, this.runTerminalHeartbeatLoop(ctrl.config.id));
      if (typeof this.coreErpClient.claimUserSyncJob === 'function') {
        void this.trackTask(ctrl, this.pollPendingUserSyncJob(ctrl.config.id));
      }
    }
  }

  async stop(graceTimeoutMs = 5000): Promise<void> {
    this.running = false;
    this.stopped = true;
    if (this.wakeCheckTimer) {
      clearInterval(this.wakeCheckTimer);
      this.wakeCheckTimer = null;
    }

    const pendingTasks: Promise<unknown>[] = [];
    for (const ctrl of this.controllers.values()) {
      ctrl.deferredHeartbeatPending = false;
      ctrl.deferredUserSyncPending = false;
      ctrl.deferredPunchSyncPending = false;
      if (ctrl.pollTimer) {
        clearTimeout(ctrl.pollTimer);
        ctrl.pollTimer = null;
      }
      if (ctrl.heartbeatTimer) {
        clearTimeout(ctrl.heartbeatTimer);
        ctrl.heartbeatTimer = null;
      }
      if (ctrl.jobPollTimer) {
        clearTimeout(ctrl.jobPollTimer);
        ctrl.jobPollTimer = null;
      }
      if (ctrl.healthCheckTimer) {
        clearTimeout(ctrl.healthCheckTimer);
        ctrl.healthCheckTimer = null;
      }
      for (const task of ctrl.activeTasks) {
        pendingTasks.push(task);
      }
    }

    if (pendingTasks.length > 0 && graceTimeoutMs > 0) {
      await Promise.race([
        Promise.allSettled(pendingTasks),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, graceTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    }

    // Never touch checkpoints.json in USER_SYNC_ONLY mode or when checkpoint file is invalid/missing
    if (this.syncMode === 'FULL' && this.checkpointStore.getHealth().status === 'VALID') {
      this.checkpointStore.persist();
    }
    this.logger.info('bridge_stopped', {
      syncMode: this.syncMode,
      terminalCount: this.controllers.size,
    });
  }

  getStatusSnapshot(): BridgeStatusSnapshot {
    return {
      bridgeVersion: this.config.bridgeVersion,
      bridgeHost: this.config.bridgeHost,
      coreErpBaseUrl: this.config.coreErpBaseUrl,
      syncMode: this.syncMode,
      pid: process.pid,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      running: this.running,
      terminals: Array.from(this.controllers.values()).map((c) => ({ ...c.runtime })),
    };
  }

  /**
   * Computes exponential backoff with +/-15% deterministic/bounded jitter.
   */
  computeBackoffDelayMs(consecutiveFailures: number, baseIntervalMs: number): number {
    if (consecutiveFailures <= 0) return baseIntervalMs;
    const exp = Math.min(this.config.maxBackoffMs, baseIntervalMs * Math.pow(2, Math.min(consecutiveFailures, 6)));
    const jitterFactor = 0.85 + Math.random() * 0.3;
    return Math.min(this.config.maxBackoffMs, Math.round(exp * jitterFactor));
  }

  private resolveKey(term: TerminalConfig): string {
    return resolveTerminalApiKey({
      dpapiStorePath: this.config.dpapiStorePath,
      dpapiCredentialName: term.dpapiCredentialName,
      apiKeyEnv: term.apiKeyEnv,
      inlineApiKey: term.apiKey,
    });
  }

  /**
   * Normalizes raw hardware records using device IANA timezone and deterministic punch IDs,
   * sorted strictly ascending by punchTime with deterministic tie-breakers preserving unique device identity.
   */
  normalizeDeviceRecords(term: TerminalConfig, records: DeviceAttendanceRecord[]): NormalizedPunchEvent[] {
    const decorated = records.map((rec) => {
      const localStamp = formatLocalWallClock(rec.localDateTime);
      const utcIso = deviceLocalDateTimeToUtcIso(rec.localDateTime, term.deviceTimezone);
      const devicePunchId = `${term.serialNumber}:${rec.userEnrollmentId}:${localStamp}:${rec.inOutMode}`;
      return {
        event: {
          devicePunchId,
          userEnrollmentId: rec.userEnrollmentId,
          punchTime: utcIso,
          verifyType: rec.verifyType,
          inOutMode: rec.inOutMode,
        } satisfies NormalizedPunchEvent,
        punchTimeMs: Date.parse(utcIso),
        recordSequence: rec.recordSequence,
        uid: rec.uid,
        inOutCode: rec.inOutCode,
        verifyCode: rec.verifyCode,
      };
    });

    decorated.sort((a, b) => {
      if (a.punchTimeMs !== b.punchTimeMs) return a.punchTimeMs - b.punchTimeMs;
      if (a.recordSequence !== b.recordSequence) return a.recordSequence - b.recordSequence;
      if (a.uid !== b.uid) return a.uid - b.uid;
      if (a.event.devicePunchId !== b.event.devicePunchId) {
        return a.event.devicePunchId < b.event.devicePunchId ? -1 : 1;
      }
      if (a.inOutCode !== b.inOutCode) return a.inOutCode - b.inOutCode;
      return a.verifyCode - b.verifyCode;
    });

    return decorated.map((item) => item.event);
  }

  /**
   * Executes one full poll + cutoff/checkpoint filter + ordered batched upload cycle for a single terminal.
   * Fails closed BEFORE connecting to hardware if syncMode is USER_SYNC_ONLY or checkpoint/cutoff is invalid.
   */
  async syncTerminalOnce(terminalId: string): Promise<{
    pulledCount: number;
    newlyQueuedCount: number;
    uploadedCount: number;
    duplicateCount: number;
    remainingQueueCount: number;
    filteredHistoricalCount: number;
    skippedBeforeWatermarkCount: number;
    effectiveCutoffIso: string;
  }> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl) {
      throw new Error(`Unknown terminal ID '${terminalId}'.`);
    }

    // Fail-closed pre-flight gate: validate syncMode, checkpoint integrity, serial identity, watermark, and cutoff
    // BEFORE contacting hardware or mutating any checkpoint metadata.
    const cutoff = this.assertPunchSyncReady(ctrl);

    const term = ctrl.config;
    const attemptIso = this.nowProvider().toISOString();
    ctrl.runtime.lastSyncAttemptAt = attemptIso;
    this.checkpointStore.updateStatus(term.id, term.serialNumber, { lastSyncAttemptAt: attemptIso });

    const adapter = this.adapterFactory(term);
    let deviceInfo: DeviceInfo | null = ctrl.runtime.deviceInfo;
    let pulledRecords: DeviceAttendanceRecord[] = [];
    let queriedUsers: DeviceEnrolledUser[] | null = null;
    let userQueryAttemptIso: string | null = null;

    // 1. Poll physical biometric device over TCP (strictly read-only; never clears device logs)
    ctrl.inFlightDeviceIo = true;
    try {
      await adapter.connect({
        host: term.ipAddress,
        port: term.port,
        commKey: term.commKey ?? 0,
        timeoutMs: term.connectTimeoutMs ?? this.config.connectTimeoutMs,
      });

      deviceInfo = await adapter.getDeviceInfo();
      ctrl.runtime.deviceInfo = deviceInfo;

      if (!term.skipSerialValidation) {
        if (!deviceInfo.serialNumber) {
          throw new Error(
            `Device at ${term.ipAddress}:${term.port} did not return a serial number (~SerialNumber); refusing unverified punch ingestion.`
          );
        }
        if (deviceInfo.serialNumber.trim() !== term.serialNumber.trim()) {
          throw new Error(
            `Hardware serial mismatch at ${term.ipAddress}:${term.port}: expected '${term.serialNumber}', got '${deviceInfo.serialNumber}'.`
          );
        }
      }

      pulledRecords = await adapter.getAttendanceLogs();

      if (typeof adapter.getUsers === 'function') {
        userQueryAttemptIso = this.nowProvider().toISOString();
        ctrl.runtime.lastUserSyncAttemptAt = userQueryAttemptIso;
        try {
          const users = await adapter.getUsers();
          if (!Array.isArray(users)) {
            throw new Error('Hardware adapter returned an invalid enrolled user list.');
          }
          queriedUsers = users;
          ctrl.deviceUsers = users;
          ctrl.runtime.discoveredUserCount = users.length;
          this.checkpointStore.updateStatus(term.id, term.serialNumber, {
            lastUserSyncAttemptAt: userQueryAttemptIso,
            discoveredUserCount: users.length,
          });
        } catch (userErr: unknown) {
          const safeUserErr = redactSensitiveText(
            (userErr as Error)?.message || 'Hardware user query failed'
          );
          ctrl.runtime.lastUserSyncError = safeUserErr;
          this.checkpointStore.updateStatus(term.id, term.serialNumber, {
            lastUserSyncAttemptAt: userQueryAttemptIso,
            lastUserSyncError: safeUserErr,
          });
          this.logger.warn('terminal_user_query_failed', {
            terminalId: term.id,
            serialNumber: term.serialNumber,
            error: safeUserErr,
          });
        }
      }

      ctrl.runtime.deviceReachable = true;
      ctrl.runtime.lastDeviceContactAt = this.nowProvider().toISOString();
      ctrl.hasHealthSample = true;
      if (
        ctrl.lastDeviceConnectionError !== null &&
        ctrl.runtime.lastError === ctrl.lastDeviceConnectionError
      ) {
        ctrl.runtime.lastError = null;
      }
      ctrl.lastDeviceConnectionError = null;
      this.checkpointStore.updateStatus(term.id, term.serialNumber, { deviceInfo });
    } catch (err: unknown) {
      const safeErr = redactSensitiveText((err as Error)?.message || 'Sync error');
      ctrl.runtime.deviceReachable = false;
      ctrl.hasHealthSample = true;
      ctrl.lastDeviceConnectionError = safeErr;
      throw err;
    } finally {
      try {
        await adapter.disconnect();
      } catch {
        // Ignore teardown socket error
      }
      ctrl.inFlightDeviceIo = false;
    }

    // 2. Convert timestamps, sort ascending deterministically, and apply mandatory current-day cutoff + watermark
    const normalized = this.normalizeDeviceRecords(term, pulledRecords);
    const filterResult = this.checkpointStore.filterEligibleEvents(
      term.id,
      term.serialNumber,
      normalized,
      { effectiveCutoffIso: cutoff.effectiveCutoffIso }
    );

    let totalFilteredHistorical = filterResult.filteredHistoricalCount;
    ctrl.runtime.effectiveCutoffIso = cutoff.effectiveCutoffIso;
    ctrl.runtime.lastFilteredHistoricalCount = totalFilteredHistorical;
    ctrl.runtime.lastSkippedBeforeWatermarkCount = filterResult.skippedBeforeWatermarkCount;

    if (filterResult.filteredHistoricalCount > 0) {
      this.logger.info('terminal_historical_punches_filtered', {
        terminalId: term.id,
        serialNumber: term.serialNumber,
        deviceTimezone: cutoff.deviceTimezone,
        currentLocalDate: cutoff.currentLocalDate,
        effectiveCutoffIso: cutoff.effectiveCutoffIso,
        filteredHistoricalCount: filterResult.filteredHistoricalCount,
        eligibleCount: filterResult.eligible.length,
      });
    }

    if (filterResult.skippedBeforeWatermarkCount > 0) {
      this.logger.warn('terminal_late_records_before_watermark', {
        terminalId: term.id,
        serialNumber: term.serialNumber,
        effectiveCutoffIso: cutoff.effectiveCutoffIso,
        skippedBeforeWatermarkCount: filterResult.skippedBeforeWatermarkCount,
        samples: filterResult.lateBeforeWatermarkSamples,
      });
    }

    if (filterResult.eligible.length > 0) {
      this.checkpointStore.enqueuePending(term.id, term.serialNumber, filterResult.eligible);
    }

    // Defensive pre-upload cutoff gate: never upload stale pendingQueue entries older than effectiveCutoffIso
    const pruned = this.checkpointStore.prunePendingQueueBeforeCutoff(
      term.id,
      term.serialNumber,
      cutoff.effectiveCutoffIso
    );
    if (pruned.removedCount > 0) {
      totalFilteredHistorical += pruned.removedCount;
      ctrl.runtime.lastFilteredHistoricalCount = totalFilteredHistorical;
      this.logger.warn('terminal_stale_pending_queue_pruned', {
        terminalId: term.id,
        serialNumber: term.serialNumber,
        effectiveCutoffIso: cutoff.effectiveCutoffIso,
        prunedCount: pruned.removedCount,
        samples: pruned.removedSamples,
      });
    }

    // 3. Flush persistent pendingQueue strictly in ascending order, advancing checkpoint ONLY after CoreERP ack
    const apiKey = this.resolveKey(term);
    const batchLimit = Math.min(250, Math.max(1, this.config.batchSize || 100));
    let uploadedCount = 0;
    let duplicateCount = 0;

    while (true) {
      const cp = this.checkpointStore.getTerminal(term.id, term.serialNumber);
      ctrl.runtime.pendingQueueSize = cp.pendingQueue.length;
      if (cp.pendingQueue.length === 0) break;

      const batch = cp.pendingQueue.slice(0, batchLimit);
      const res = await this.coreErpClient.submitPunches(apiKey, term.serialNumber, batch, {
        bridgeHost: this.config.bridgeHost,
        bridgeVersion: this.config.bridgeVersion,
      });

      if (!res || res.success !== true) {
        throw new Error(
          `CoreERP did not acknowledge punch batch persistence for terminal '${term.id}'; preserving pendingQueue and checkpoint watermark.`
        );
      }

      this.checkpointStore.markBatchAcknowledged(term.id, term.serialNumber, batch);
      uploadedCount += res.inserted;
      duplicateCount += res.duplicates;
    }

    const updatedCp = this.checkpointStore.getTerminal(term.id, term.serialNumber);
    ctrl.runtime.pendingQueueSize = updatedCp.pendingQueue.length;
    ctrl.runtime.lastSuccessfulSyncAt = updatedCp.lastSuccessfulSyncAt || attemptIso;
    ctrl.runtime.lastProcessedPunchCount = filterResult.eligible.length;
    ctrl.runtime.lastError = null;
    ctrl.runtime.authError = false;
    ctrl.runtime.bridgeConnected = true;
    ctrl.runtime.consecutiveFailures = 0;
    ctrl.runtime.nextRetryAt = null;

    if (filterResult.eligible.length === 0) {
      this.checkpointStore.updateStatus(term.id, term.serialNumber, {
        lastSuccessfulSyncAt: ctrl.runtime.lastSuccessfulSyncAt,
        lastProcessedPunchCount: 0,
        lastError: null,
      });
    }

    // 4. Upload freshly discovered hardware users OR retry previously failed user upload
    // Never blocks punch synchronization if hardware user upload fails.
    const snapshotToUpload =
      queriedUsers !== null
        ? { users: queriedUsers, discoveredAt: userQueryAttemptIso || attemptIso }
        : ctrl.pendingUserSync || updatedCp.pendingUserSync || null;

    if (snapshotToUpload) {
      try {
        await this.uploadTerminalUsers(ctrl, snapshotToUpload.users, snapshotToUpload.discoveredAt, {
          persistCheckpointStatus: true,
        });
      } catch {
        // Error already logged and stored for retry on next cycle
      }
    }

    this.logger.info('terminal_sync_completed', {
      terminalId: term.id,
      serialNumber: term.serialNumber,
      effectiveCutoffIso: cutoff.effectiveCutoffIso,
      pulledCount: pulledRecords.length,
      filteredHistoricalCount: totalFilteredHistorical,
      skippedBeforeWatermarkCount: filterResult.skippedBeforeWatermarkCount,
      newlyQueuedCount: filterResult.eligible.length,
      uploadedCount,
      duplicateCount,
      remainingQueueCount: updatedCp.pendingQueue.length,
    });

    return {
      pulledCount: pulledRecords.length,
      newlyQueuedCount: filterResult.eligible.length,
      uploadedCount,
      duplicateCount,
      remainingQueueCount: updatedCp.pendingQueue.length,
      filteredHistoricalCount: totalFilteredHistorical,
      skippedBeforeWatermarkCount: filterResult.skippedBeforeWatermarkCount,
      effectiveCutoffIso: cutoff.effectiveCutoffIso,
    };
  }

  /**
   * Executes a dedicated hardware user discovery + upload cycle for a single terminal.
   * STRICTLY NEVER calls getAttendanceLogs(), NEVER alters or writes checkpoints.json,
   * and NEVER enqueues punch records.
   */
  async syncTerminalUsersOnce(
    terminalId: string,
    options?: {
      jobId?: string;
      bridgeDaemonRunning?: boolean;
    }
  ): Promise<{
    discoveredCount: number;
    syncedCount: number;
    syncedAt: string;
    users: DeviceEnrolledUser[];
  }> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl) {
      throw new Error(`Unknown terminal ID '${terminalId}'.`);
    }

    const term = ctrl.config;
    const attemptIso = this.nowProvider().toISOString();
    ctrl.runtime.lastUserSyncAttemptAt = attemptIso;

    const adapter = this.adapterFactory(term);
    let users: DeviceEnrolledUser[] = [];

    ctrl.inFlightDeviceIo = true;
    try {
      await adapter.connect({
        host: term.ipAddress,
        port: term.port,
        commKey: term.commKey ?? 0,
        timeoutMs: term.connectTimeoutMs ?? this.config.connectTimeoutMs,
      });

      const deviceInfo = await adapter.getDeviceInfo();
      ctrl.runtime.deviceInfo = deviceInfo;

      if (!term.skipSerialValidation) {
        if (!deviceInfo.serialNumber) {
          throw new Error(
            `Device at ${term.ipAddress}:${term.port} did not return a serial number (~SerialNumber); refusing unverified user sync.`
          );
        }
        if (deviceInfo.serialNumber.trim() !== term.serialNumber.trim()) {
          throw new Error(
            `Hardware serial mismatch at ${term.ipAddress}:${term.port}: expected '${term.serialNumber}', got '${deviceInfo.serialNumber}'.`
          );
        }
      }

      if (typeof adapter.getUsers !== 'function') {
        throw new Error(
          `Protocol adapter '${adapter.protocolName}' does not support enrolled hardware user queries.`
        );
      }

      const rawUsers = await adapter.getUsers();
      if (!Array.isArray(rawUsers)) {
        throw new Error('Hardware adapter returned an invalid enrolled user list.');
      }

      users = rawUsers;
      ctrl.deviceUsers = users;
      ctrl.runtime.deviceReachable = true;
      ctrl.runtime.lastDeviceContactAt = this.nowProvider().toISOString();
      ctrl.hasHealthSample = true;
      if (
        ctrl.lastDeviceConnectionError !== null &&
        ctrl.runtime.lastError === ctrl.lastDeviceConnectionError
      ) {
        ctrl.runtime.lastError = null;
      }
      ctrl.lastDeviceConnectionError = null;
      ctrl.runtime.discoveredUserCount = users.length;
    } catch (err: unknown) {
      const safeErr = redactSensitiveText((err as Error)?.message || 'Hardware user query failed');
      const prevDeviceErr = ctrl.lastDeviceConnectionError;
      ctrl.runtime.deviceReachable = false;
      ctrl.hasHealthSample = true;
      ctrl.lastDeviceConnectionError = safeErr;
      if (
        !ctrl.runtime.authError &&
        (ctrl.runtime.lastError === null || ctrl.runtime.lastError === prevDeviceErr)
      ) {
        ctrl.runtime.lastError = safeErr;
      }
      ctrl.runtime.lastUserSyncError = safeErr;
      this.logger.warn('terminal_user_query_failed', {
        terminalId: term.id,
        serialNumber: term.serialNumber,
        jobId: options?.jobId,
        error: safeErr,
      });
      const wrapped = new Error(safeErr) as Error & { isDeviceFailure?: boolean };
      wrapped.isDeviceFailure = true;
      throw wrapped;
    } finally {
      try {
        await adapter.disconnect();
      } catch {
        // Ignore teardown socket error
      }
      ctrl.inFlightDeviceIo = false;
    }

    // Strict P0-A isolation: user-only sync must NEVER alter checkpoints.json
    const res = await this.uploadTerminalUsers(ctrl, users, attemptIso, {
      jobId: options?.jobId,
      bridgeDaemonRunning: options?.bridgeDaemonRunning,
      persistCheckpointStatus: false,
    });
    return {
      discoveredCount: res.discoveredCount,
      syncedCount: res.syncedCount,
      syncedAt: res.syncedAt,
      users,
    };
  }

  private async uploadTerminalUsers(
    ctrl: TerminalController,
    users: DeviceEnrolledUser[],
    discoveredAt: string,
    options?: {
      jobId?: string;
      bridgeDaemonRunning?: boolean;
      persistCheckpointStatus?: boolean;
    }
  ) {
    const term = ctrl.config;
    const apiKey = this.resolveKey(term);
    const shouldPersistCheckpoint =
      options?.persistCheckpointStatus === true && this.syncMode === 'FULL';

    try {
      const res = await this.coreErpClient.syncUsers(apiKey, term.serialNumber, {
        jobId: options?.jobId,
        bridgeDaemonRunning: options?.bridgeDaemonRunning,
        deviceUsers: users,
        discoveredCount: users.length,
        discoveredAt,
        bridgeHost: this.config.bridgeHost,
        bridgeVersion: this.config.bridgeVersion,
      });

      if (options?.bridgeDaemonRunning !== false) {
        ctrl.runtime.bridgeConnected = true;
      }
      ctrl.runtime.authError = false;
      ctrl.runtime.lastSuccessfulUserSyncAt = res.syncedAt;
      ctrl.runtime.discoveredUserCount = res.discoveredCount;
      ctrl.runtime.syncedUserCount = res.syncedCount;
      ctrl.runtime.lastUserSyncError = null;
      ctrl.pendingUserSync = null;

      if (shouldPersistCheckpoint) {
        this.checkpointStore.updateStatus(term.id, term.serialNumber, {
          lastSuccessfulUserSyncAt: res.syncedAt,
          discoveredUserCount: res.discoveredCount,
          syncedUserCount: res.syncedCount,
          lastUserSyncError: null,
          pendingUserSync: null,
        });
      }

      this.logger.info('terminal_user_sync_completed', {
        terminalId: term.id,
        serialNumber: term.serialNumber,
        jobId: options?.jobId,
        discoveredUserCount: res.discoveredCount,
        syncedUserCount: res.syncedCount,
      });

      return res;
    } catch (err: unknown) {
      const safeErr = redactSensitiveText((err as Error)?.message || 'Failed to upload hardware users to CoreERP');
      ctrl.runtime.lastUserSyncError = safeErr;
      ctrl.runtime.discoveredUserCount = users.length;
      ctrl.pendingUserSync = { users, discoveredAt };
      if (err instanceof CoreErpApiError && err.isAuthError) {
        ctrl.runtime.authError = true;
        ctrl.runtime.bridgeConnected = false;
      }

      if (shouldPersistCheckpoint) {
        this.checkpointStore.updateStatus(term.id, term.serialNumber, {
          discoveredUserCount: users.length,
          lastUserSyncError: safeErr,
          pendingUserSync: { users, discoveredAt },
        });
      }

      this.logger.warn('terminal_user_upload_failed', {
        terminalId: term.id,
        serialNumber: term.serialNumber,
        jobId: options?.jobId,
        discoveredUserCount: users.length,
        statusCode: err instanceof CoreErpApiError ? err.statusCode : undefined,
        error: safeErr,
      });

      throw err;
    }
  }

  /**
   * Sends a single authenticated heartbeat for a terminal and triggers immediate poll/user-sync if requested.
   * In USER_SYNC_ONLY mode (or when punch sync is blocked), server punch-sync requests are safely ignored.
   */
  async sendTerminalHeartbeat(terminalId: string): Promise<boolean> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl) return false;
    if (ctrl.inFlightHeartbeat) return false;

    ctrl.inFlightHeartbeat = true;
    const term = ctrl.config;

    try {
      const apiKey = this.resolveKey(term);
      const hbRes = await this.coreErpClient.sendHeartbeat(apiKey, term.serialNumber, {
        firmwareVersion: ctrl.runtime.deviceInfo?.firmwareVersion || undefined,
        platform: ctrl.runtime.deviceInfo?.platform || undefined,
        fingerprintAlgorithm: ctrl.runtime.deviceInfo?.fingerprintAlgorithm || undefined,
        deviceSerialNumber: term.serialNumber,
        bridgeConnected: true,
        bridgeHost: this.config.bridgeHost,
        bridgeVersion: this.config.bridgeVersion,
        bridgePid: process.pid,
        deviceReachable: ctrl.runtime.deviceReachable,
        lastDeviceContactAt: ctrl.runtime.lastDeviceContactAt,
        lastConnectionError: !ctrl.runtime.deviceReachable
          ? (ctrl.lastDeviceConnectionError ?? ctrl.runtime.lastError)
          : ctrl.runtime.lastError,
        lastProcessedPunchCount: ctrl.runtime.lastProcessedPunchCount,
        lastSyncAttemptAt: ctrl.runtime.lastSyncAttemptAt || undefined,
        lastSyncAt: ctrl.runtime.lastSuccessfulSyncAt || undefined,
        lastUserSyncAt: ctrl.runtime.lastSuccessfulUserSyncAt,
        lastUserSyncAttemptAt: ctrl.runtime.lastUserSyncAttemptAt,
        lastUserSyncError: ctrl.runtime.lastUserSyncError,
        discoveredUserCount: ctrl.runtime.discoveredUserCount,
        syncedUserCount: ctrl.runtime.syncedUserCount,
      });

      const nowIso = this.nowProvider().toISOString();
      ctrl.runtime.bridgeConnected = true;
      ctrl.runtime.authError = false;
      ctrl.runtime.heartbeatConsecutiveFailures = 0;
      ctrl.runtime.lastSuccessfulHeartbeatAt = nowIso;

      // Never mutate checkpoints.json during USER_SYNC_ONLY mode or while punch sync is blocked
      if (this.syncMode === 'FULL' && !ctrl.runtime.punchSyncBlocked) {
        this.checkpointStore.updateStatus(term.id, term.serialNumber, {
          lastSuccessfulHeartbeatAt: nowIso,
        });
      }

      if (this.running) {
        // Prioritize user-sync jobs cleanly without dropping them if a punch poll is currently in flight
        if (hbRes.userSyncRequested || hbRes.pendingUserSyncJob) {
          this.logger.info('bridge_user_sync_requested_by_server', {
            terminalId: term.id,
            serialNumber: term.serialNumber,
            jobId: hbRes.pendingUserSyncJob?.jobId,
          });
          if (!ctrl.inFlightSync && !ctrl.inFlightUserSync && !ctrl.inFlightHealthCheck) {
            void this.trackTask(
              ctrl,
              this.runTerminalUserSync(term.id, { knownJobId: hbRes.pendingUserSyncJob?.jobId })
            );
          } else {
            ctrl.deferredUserSyncPending = true;
          }
        }

        if (hbRes.syncRequested) {
          if (this.syncMode === 'USER_SYNC_ONLY' || ctrl.runtime.punchSyncBlocked) {
            this.logger.warn('bridge_punch_sync_request_ignored', {
              terminalId: term.id,
              serialNumber: term.serialNumber,
              syncMode: this.syncMode,
              reason: ctrl.runtime.punchSyncBlockReason,
            });
          } else {
            this.logger.info('bridge_sync_requested_by_server', {
              terminalId: term.id,
              serialNumber: term.serialNumber,
            });
            if (!ctrl.inFlightSync && !ctrl.inFlightUserSync && !ctrl.inFlightHealthCheck) {
              void this.trackTask(ctrl, this.runTerminalPollCycle(term.id));
            } else {
              ctrl.deferredPunchSyncPending = true;
            }
          }
        }
      }

      return true;
    } catch (err: unknown) {
      const msg = redactSensitiveText((err as Error)?.message || 'Heartbeat failed');
      ctrl.runtime.bridgeConnected = false;
      ctrl.runtime.heartbeatConsecutiveFailures += 1;
      if (err instanceof CoreErpApiError && err.isAuthError) {
        ctrl.runtime.authError = true;
        ctrl.runtime.lastError = msg;
      }
      this.logger.warn('terminal_heartbeat_failed', {
        terminalId: term.id,
        serialNumber: term.serialNumber,
        heartbeatConsecutiveFailures: ctrl.runtime.heartbeatConsecutiveFailures,
        error: msg,
        statusCode: err instanceof CoreErpApiError ? err.statusCode : undefined,
      });
      return false;
    } finally {
      ctrl.inFlightHeartbeat = false;
      if (ctrl.deferredHeartbeatPending && !this.stopped) {
        ctrl.deferredHeartbeatPending = false;
        void this.trackTask(ctrl, this.sendTerminalHeartbeat(terminalId));
      }
    }
  }

  /**
   * Independent, read-only hardware reachability probe.
   * Connects to the configured device, calls ONLY getDeviceInfo(), validates serial number,
   * always disconnects in finally, updates reachability/device error state, and triggers an
   * immediate heartbeat whenever connection state transitions.
   *
   * STRICTLY NEVER calls getAttendanceLogs(), getUsers(), submitPunches(), or CheckpointStore.
   */
  async probeTerminalHealth(terminalId: string): Promise<HealthProbeResult> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl) {
      throw new Error(`Unknown terminal ID '${terminalId}'.`);
    }

    if (
      ctrl.inFlightHealthCheck ||
      ctrl.inFlightSync ||
      ctrl.inFlightUserSync ||
      ctrl.inFlightDeviceIo
    ) {
      return {
        terminalId,
        skipped: true,
        reachable: ctrl.runtime.deviceReachable,
        transitioned: false,
        heartbeatSent: false,
        deviceInfo: ctrl.runtime.deviceInfo,
        error: ctrl.lastDeviceConnectionError,
      };
    }

    ctrl.inFlightHealthCheck = true;
    const term = ctrl.config;
    const prevReachable = ctrl.runtime.deviceReachable;
    const hadPreviousSample = ctrl.hasHealthSample;
    const adapter = this.adapterFactory(term);

    let reachable = false;
    let deviceInfo: DeviceInfo | null = ctrl.runtime.deviceInfo;
    let probeError: string | null = null;

    try {
      await adapter.connect({
        host: term.ipAddress,
        port: term.port,
        commKey: term.commKey ?? 0,
        timeoutMs: term.connectTimeoutMs ?? this.config.connectTimeoutMs,
      });

      const info = await adapter.getDeviceInfo();

      if (!term.skipSerialValidation) {
        if (!info.serialNumber) {
          throw new Error(
            `Device at ${term.ipAddress}:${term.port} did not return a serial number (~SerialNumber); unable to verify hardware identity.`
          );
        }
        if (info.serialNumber.trim() !== term.serialNumber.trim()) {
          throw new Error(
            `Hardware serial mismatch at ${term.ipAddress}:${term.port}: expected '${term.serialNumber}', got '${info.serialNumber}'.`
          );
        }
      }

      reachable = true;
      deviceInfo = info;
      const nowIso = this.nowProvider().toISOString();
      ctrl.runtime.deviceReachable = true;
      ctrl.runtime.lastDeviceContactAt = nowIso;
      ctrl.runtime.deviceInfo = info;
      ctrl.hasHealthSample = true;

      // Clear only the previous device connection error; preserve unrelated CoreERP auth/heartbeat errors
      if (
        ctrl.lastDeviceConnectionError !== null &&
        ctrl.runtime.lastError === ctrl.lastDeviceConnectionError
      ) {
        ctrl.runtime.lastError = null;
      }
      ctrl.lastDeviceConnectionError = null;
    } catch (err: unknown) {
      reachable = false;
      const safeErr = redactSensitiveText(
        (err as Error)?.message || `Device health probe failed for ${term.ipAddress}:${term.port}`
      );
      probeError = safeErr;
      const prevDeviceErr = ctrl.lastDeviceConnectionError;
      ctrl.runtime.deviceReachable = false;
      ctrl.hasHealthSample = true;
      ctrl.lastDeviceConnectionError = safeErr;

      if (
        !ctrl.runtime.authError &&
        (ctrl.runtime.lastError === null || ctrl.runtime.lastError === prevDeviceErr)
      ) {
        ctrl.runtime.lastError = safeErr;
      }
    } finally {
      try {
        await adapter.disconnect();
      } catch {
        // Ignore teardown socket error
      }
      ctrl.inFlightHealthCheck = false;
    }

    const transitioned = hadPreviousSample ? prevReachable !== reachable : true;

    if (transitioned) {
      if (reachable) {
        this.logger.info('terminal_device_connected', {
          terminalId: term.id,
          serialNumber: term.serialNumber,
          ipAddress: term.ipAddress,
          port: term.port,
          reconnected: hadPreviousSample && !prevReachable,
          lastDeviceContactAt: ctrl.runtime.lastDeviceContactAt,
        });
      } else {
        this.logger.warn('terminal_device_disconnected', {
          terminalId: term.id,
          serialNumber: term.serialNumber,
          ipAddress: term.ipAddress,
          port: term.port,
          error: probeError,
        });
      }
    }

    let heartbeatSent = false;
    if (transitioned && !this.stopped) {
      if (ctrl.inFlightHeartbeat) {
        ctrl.deferredHeartbeatPending = true;
      } else {
        heartbeatSent = await this.sendTerminalHeartbeat(terminalId);
      }
    }

    if (this.running && ctrl.deferredUserSyncPending && !ctrl.inFlightUserSync && !ctrl.inFlightSync) {
      ctrl.deferredUserSyncPending = false;
      void this.trackTask(ctrl, this.runTerminalUserSync(terminalId));
    } else if (
      this.running &&
      ctrl.deferredPunchSyncPending &&
      this.syncMode === 'FULL' &&
      !ctrl.runtime.punchSyncBlocked &&
      !ctrl.inFlightSync &&
      !ctrl.inFlightUserSync
    ) {
      ctrl.deferredPunchSyncPending = false;
      void this.trackTask(ctrl, this.runTerminalPollCycle(terminalId));
    }

    return {
      terminalId,
      skipped: false,
      reachable,
      transitioned,
      heartbeatSent,
      deviceInfo,
      error: probeError,
    };
  }

  private async runTerminalHealthCheckLoop(terminalId: string): Promise<void> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl || !this.running) return;

    if (ctrl.healthCheckTimer) {
      clearTimeout(ctrl.healthCheckTimer);
      ctrl.healthCheckTimer = null;
    }

    await this.probeTerminalHealth(terminalId);

    if (!this.running) return;
    const intervalMs = this.getDeviceHealthCheckIntervalMs(ctrl);
    ctrl.healthCheckTimer = setTimeout(() => {
      if (this.running) {
        void this.trackTask(ctrl, this.runTerminalHealthCheckLoop(terminalId));
      }
    }, intervalMs);
  }

  /**
   * Diagnostic connection test against physical hardware + CoreERP heartbeat authentication.
   * Respects USER_SYNC_ONLY mode by skipping getAttendanceLogs() when punch polling is disabled.
   */
  async testAllConnections(): Promise<DiagnosticReport[]> {
    const reports: DiagnosticReport[] = [];

    for (const ctrl of this.controllers.values()) {
      const term = ctrl.config;
      const adapter = this.adapterFactory(term);
      let tcpConnected = false;
      let serialMatched = false;
      let deviceInfo: DeviceInfo | null = null;
      let attendanceRecordCount: number | null = null;
      let enrolledUserCount: number | null = null;
      let userQueryError: string | null = null;
      let coreErpHeartbeatOk = false;
      let error: string | null = null;

      try {
        await adapter.connect({
          host: term.ipAddress,
          port: term.port,
          commKey: term.commKey ?? 0,
          timeoutMs: term.connectTimeoutMs ?? this.config.connectTimeoutMs,
        });
        tcpConnected = true;

        deviceInfo = await adapter.getDeviceInfo();
        serialMatched =
          Boolean(deviceInfo.serialNumber) &&
          deviceInfo.serialNumber!.trim() === term.serialNumber.trim();

        if (this.syncMode === 'FULL') {
          const logs = await adapter.getAttendanceLogs();
          attendanceRecordCount = logs.length;
        }

        if (typeof adapter.getUsers === 'function') {
          try {
            const users = await adapter.getUsers();
            enrolledUserCount = users.length;
          } catch (uErr: unknown) {
            userQueryError = redactSensitiveText((uErr as Error)?.message || 'Hardware user query failed');
          }
        }
      } catch (err: unknown) {
        error = redactSensitiveText((err as Error)?.message || 'Hardware connection test failed');
      } finally {
        try {
          await adapter.disconnect();
        } catch {
          // Ignore close error
        }
      }

      try {
        coreErpHeartbeatOk = await this.sendTerminalHeartbeat(term.id);
      } catch (err: unknown) {
        const hbErr = redactSensitiveText((err as Error)?.message || 'Heartbeat check failed');
        error = error ? `${error}; ${hbErr}` : hbErr;
      }

      reports.push({
        terminalId: term.id,
        name: term.name,
        serialNumber: term.serialNumber,
        ipAddress: term.ipAddress,
        port: term.port,
        configValid: true,
        tcpConnected,
        serialMatched,
        deviceInfo,
        attendanceRecordCount,
        enrolledUserCount,
        userQueryError,
        coreErpHeartbeatOk,
        error,
      });
    }

    return reports;
  }

  /**
   * Self-scheduling heartbeat loop with bounded exponential backoff on CoreERP outages.
   * Never stops permanently on transient network/API errors; recovers automatically when CoreERP returns.
   */
  private async runTerminalHeartbeatLoop(terminalId: string): Promise<void> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl || !this.running) return;

    if (ctrl.heartbeatTimer) {
      clearTimeout(ctrl.heartbeatTimer);
      ctrl.heartbeatTimer = null;
    }

    await this.sendTerminalHeartbeat(terminalId);

    if (!this.running) return;
    const baseInterval = ctrl.config.heartbeatIntervalMs ?? this.config.heartbeatIntervalMs;
    const delayMs = ctrl.runtime.authError
      ? this.config.maxBackoffMs
      : ctrl.runtime.heartbeatConsecutiveFailures > 0
      ? this.computeBackoffDelayMs(ctrl.runtime.heartbeatConsecutiveFailures, Math.min(baseInterval, 10000))
      : baseInterval;

    ctrl.heartbeatTimer = setTimeout(() => {
      if (this.running) {
        void this.trackTask(ctrl, this.runTerminalHeartbeatLoop(terminalId));
      }
    }, delayMs);
  }

  private scheduleNextJobPoll(ctrl: TerminalController, delayMs: number): void {
    if (!this.running) return;
    if (ctrl.jobPollTimer) {
      clearTimeout(ctrl.jobPollTimer);
      ctrl.jobPollTimer = null;
    }
    ctrl.jobPollTimer = setTimeout(() => {
      if (this.running) {
        void this.trackTask(ctrl, this.pollPendingUserSyncJob(ctrl.config.id));
      }
    }, delayMs);
  }

  /**
   * Fast per-terminal job discovery loop (default 5s):
   * Claims and executes pending UI-triggered User Sync jobs without waiting for full heartbeat intervals
   * and without ever running punch sync or punch reconciliation.
   */
  async pollPendingUserSyncJob(terminalId: string): Promise<boolean> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl) return false;
    if (typeof this.coreErpClient.claimUserSyncJob !== 'function') return false;
    if (ctrl.inFlightJobPoll || ctrl.inFlightUserSync || ctrl.inFlightSync || ctrl.inFlightHealthCheck) {
      if (this.running) {
        const baseJobPoll = ctrl.config.jobPollIntervalMs ?? this.config.jobPollIntervalMs ?? 5000;
        this.scheduleNextJobPoll(ctrl, baseJobPoll);
      }
      return false;
    }

    ctrl.inFlightJobPoll = true;
    let claimed = false;
    const baseJobPoll = ctrl.config.jobPollIntervalMs ?? this.config.jobPollIntervalMs ?? 5000;

    try {
      const apiKey = this.resolveKey(ctrl.config);
      const claimRes = await this.coreErpClient.claimUserSyncJob(apiKey, ctrl.config.serialNumber, {
        bridgeHost: this.config.bridgeHost,
        bridgeVersion: this.config.bridgeVersion,
      });

      if (claimRes.claimed && claimRes.job) {
        claimed = true;
        await this.executeClaimedUserSyncJob(ctrl, claimRes.job.jobId);
      }
    } catch (err: unknown) {
      const msg = redactSensitiveText((err as Error)?.message || 'User sync job poll failed');
      if (err instanceof CoreErpApiError && err.isAuthError) {
        ctrl.runtime.authError = true;
        ctrl.runtime.bridgeConnected = false;
      }
      this.logger.debug('terminal_user_sync_job_poll_error', {
        terminalId: ctrl.config.id,
        serialNumber: ctrl.config.serialNumber,
        error: msg,
      });
    } finally {
      ctrl.inFlightJobPoll = false;
      if (this.running) {
        const nextDelay = ctrl.runtime.authError
          ? this.config.maxBackoffMs
          : ctrl.runtime.heartbeatConsecutiveFailures > 0
          ? this.computeBackoffDelayMs(ctrl.runtime.heartbeatConsecutiveFailures, baseJobPoll)
          : baseJobPoll;
        this.scheduleNextJobPoll(ctrl, nextDelay);
      }
    }

    return claimed;
  }

  /**
   * Executes a claimed or server-signaled User Sync job strictly via syncTerminalUsersOnce().
   * NEVER calls syncTerminalOnce(), getAttendanceLogs(), or submitPunches().
   */
  private async runTerminalUserSync(
    terminalId: string,
    options?: { knownJobId?: string }
  ): Promise<void> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl || ctrl.inFlightUserSync || ctrl.inFlightSync || ctrl.inFlightHealthCheck) {
      if (ctrl) ctrl.deferredUserSyncPending = true;
      return;
    }

    let jobId = options?.knownJobId;
    if (typeof this.coreErpClient.claimUserSyncJob === 'function') {
      try {
        const apiKey = this.resolveKey(ctrl.config);
        const claimRes = await this.coreErpClient.claimUserSyncJob(apiKey, ctrl.config.serialNumber, {
          bridgeHost: this.config.bridgeHost,
          bridgeVersion: this.config.bridgeVersion,
        });
        if (!claimRes.claimed || !claimRes.job) {
          // Another worker/poll already claimed or completed this job
          return;
        }
        jobId = claimRes.job.jobId;
      } catch (err: unknown) {
        this.logger.warn('terminal_user_sync_claim_failed', {
          terminalId: ctrl.config.id,
          serialNumber: ctrl.config.serialNumber,
          error: redactSensitiveText((err as Error)?.message || 'Claim failed'),
        });
        return;
      }
    }

    await this.executeClaimedUserSyncJob(ctrl, jobId);
  }

  private async executeClaimedUserSyncJob(ctrl: TerminalController, jobId?: string): Promise<void> {
    if (ctrl.inFlightUserSync || ctrl.inFlightSync || ctrl.inFlightHealthCheck) {
      ctrl.deferredUserSyncPending = true;
      return;
    }

    ctrl.inFlightUserSync = true;
    ctrl.deferredUserSyncPending = false;
    ctrl.runtime.userSyncJobStatus = 'RUNNING';
    ctrl.runtime.activeUserSyncJobId = jobId || null;

    const timeoutMs = ctrl.config.userSyncTimeoutMs ?? this.config.userSyncTimeoutMs ?? 45000;
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      const syncPromise = this.syncTerminalUsersOnce(ctrl.config.id, {
        jobId,
        bridgeDaemonRunning: true,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const timeoutErr = new Error(
            `Hardware user sync timed out after ${timeoutMs}ms while communicating with ${ctrl.config.ipAddress}:${ctrl.config.port}.`
          ) as Error & { isDeviceFailure?: boolean };
          timeoutErr.isDeviceFailure = true;
          reject(timeoutErr);
        }, timeoutMs);
        if (typeof timeoutHandle.unref === 'function') {
          timeoutHandle.unref();
        }
      });

      await Promise.race([syncPromise, timeoutPromise]);
      ctrl.runtime.userSyncJobStatus = 'SUCCESS';
      ctrl.runtime.activeUserSyncJobId = null;
    } catch (err: unknown) {
      const safeErr = redactSensitiveText((err as Error)?.message || 'Hardware user sync failed');
      const isDeviceFailure = Boolean((err as { isDeviceFailure?: boolean })?.isDeviceFailure);
      const isSerialMismatch = /serial mismatch/i.test(safeErr);
      const isAuthErr = err instanceof CoreErpApiError && err.isAuthError;
      const retryable = !isSerialMismatch && !isAuthErr;

      ctrl.runtime.userSyncJobStatus = 'FAILED';
      ctrl.runtime.activeUserSyncJobId = null;
      ctrl.runtime.lastUserSyncError = safeErr;

      if (typeof this.coreErpClient.reportUserSyncJobFailure === 'function') {
        try {
          const apiKey = this.resolveKey(ctrl.config);
          await this.coreErpClient.reportUserSyncJobFailure(apiKey, ctrl.config.serialNumber, {
            jobId,
            bridgeHost: this.config.bridgeHost,
            bridgeVersion: this.config.bridgeVersion,
            error: safeErr,
            retryable,
            deviceReachable: isDeviceFailure ? false : ctrl.runtime.deviceReachable,
          });
        } catch (reportErr: unknown) {
          this.logger.warn('terminal_user_sync_failure_report_failed', {
            terminalId: ctrl.config.id,
            serialNumber: ctrl.config.serialNumber,
            jobId,
            error: redactSensitiveText((reportErr as Error)?.message || 'Failed to report failure'),
          });
        }
      }
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      ctrl.inFlightUserSync = false;

      // Refresh CoreERP heartbeat immediately so UI sees fresh device & job state
      if (this.running) {
        void this.trackTask(ctrl, this.sendTerminalHeartbeat(ctrl.config.id));
      }

      if (
        this.running &&
        ctrl.deferredPunchSyncPending &&
        this.syncMode === 'FULL' &&
        !ctrl.runtime.punchSyncBlocked
      ) {
        ctrl.deferredPunchSyncPending = false;
        void this.trackTask(ctrl, this.runTerminalPollCycle(ctrl.config.id));
      } else {
        ctrl.deferredPunchSyncPending = false;
      }
    }
  }

  private async runTerminalPollCycle(terminalId: string): Promise<void> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl || ctrl.inFlightSync || ctrl.inFlightUserSync) return;
    if (ctrl.inFlightHealthCheck) {
      ctrl.deferredPunchSyncPending = true;
      return;
    }

    if (this.syncMode === 'USER_SYNC_ONLY') {
      ctrl.runtime.punchSyncBlocked = true;
      return;
    }

    if (ctrl.pollTimer) {
      clearTimeout(ctrl.pollTimer);
      ctrl.pollTimer = null;
    }

    ctrl.inFlightSync = true;
    const baseInterval = ctrl.config.pollIntervalMs ?? this.config.pollIntervalMs;
    let blockedFailClosed = false;

    try {
      await this.syncTerminalOnce(terminalId);
    } catch (err: unknown) {
      const msg = redactSensitiveText((err as Error)?.message || 'Sync error');
      ctrl.runtime.consecutiveFailures += 1;
      ctrl.runtime.lastError = msg;

      if (err instanceof CheckpointSafetyError) {
        blockedFailClosed = true;
        ctrl.runtime.punchSyncBlocked = true;
        ctrl.runtime.punchSyncBlockReason = msg;
        ctrl.runtime.nextRetryAt = null;
      } else {
        if (err instanceof CoreErpApiError && err.isAuthError) {
          ctrl.runtime.authError = true;
          ctrl.runtime.bridgeConnected = false;
        }

        this.checkpointStore.updateStatus(ctrl.config.id, ctrl.config.serialNumber, {
          lastError: msg,
        });

        this.logger.error('terminal_sync_failed', {
          terminalId: ctrl.config.id,
          serialNumber: ctrl.config.serialNumber,
          consecutiveFailures: ctrl.runtime.consecutiveFailures,
          authError: ctrl.runtime.authError,
          error: msg,
        });
      }
    } finally {
      ctrl.inFlightSync = false;

      if (this.running && ctrl.deferredUserSyncPending) {
        ctrl.deferredUserSyncPending = false;
        void this.trackTask(ctrl, this.runTerminalUserSync(terminalId));
      }

      if (this.running && !blockedFailClosed && !ctrl.runtime.punchSyncBlocked) {
        const delayMs = ctrl.runtime.authError
          ? this.config.maxBackoffMs
          : this.computeBackoffDelayMs(ctrl.runtime.consecutiveFailures, baseInterval);
        ctrl.runtime.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        ctrl.pollTimer = setTimeout(() => {
          if (this.running) {
            void this.trackTask(ctrl, this.runTerminalPollCycle(terminalId));
          }
        }, delayMs);
      }
    }
  }
}
