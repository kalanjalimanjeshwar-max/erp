import {
  BridgeConfig,
  BridgeStatusSnapshot,
  DeviceAttendanceRecord,
  DeviceEnrolledUser,
  DeviceInfo,
  IBiometricProtocolAdapter,
  NormalizedPunchEvent,
  TerminalConfig,
  TerminalRuntimeStatus,
} from './types.js';
import { CheckpointStore } from './checkpoint-store.js';
import { CoreErpApiError, ICoreErpClient } from './coreerp-client.js';
import { BridgeLogger, redactSensitiveText } from './logger.js';
import { ZKTecoTcpAdapter } from './protocol/zkteco-tcp.adapter.js';
import { resolveTerminalApiKey, validateTransportUrl } from './security/dpapi.js';
import { deviceLocalDateTimeToUtcIso, formatLocalWallClock, isValidIanaTimezone } from './timezone.js';

export type AdapterFactory = (terminal: TerminalConfig) => IBiometricProtocolAdapter;

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

interface TerminalController {
  config: TerminalConfig;
  runtime: TerminalRuntimeStatus;
  pollTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  jobPollTimer: NodeJS.Timeout | null;
  inFlightSync: boolean;
  inFlightUserSync: boolean;
  inFlightHeartbeat: boolean;
  inFlightJobPoll: boolean;
  deferredUserSyncPending: boolean;
  deferredPunchSyncPending: boolean;
  activeTasks: Set<Promise<unknown>>;
  deviceUsers?: DeviceEnrolledUser[];
}

export class BiometricBridgeRunner {
  private readonly config: BridgeConfig;
  private readonly logger: BridgeLogger;
  private readonly checkpointStore: CheckpointStore;
  private readonly coreErpClient: ICoreErpClient;
  private readonly adapterFactory: AdapterFactory;
  private readonly controllers = new Map<string, TerminalController>();
  private readonly startedAt = new Date();
  private running = false;
  private wakeCheckTimer: NodeJS.Timeout | null = null;
  private lastWakeTickMs = Date.now();

  constructor(options: {
    config: BridgeConfig;
    logger: BridgeLogger;
    checkpointStore: CheckpointStore;
    coreErpClient: ICoreErpClient;
    adapterFactory?: AdapterFactory;
  }) {
    this.config = options.config;
    this.logger = options.logger;
    this.checkpointStore = options.checkpointStore;
    this.coreErpClient = options.coreErpClient;
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

    for (const term of this.config.terminals) {
      if (term.enabled === false) continue;
      this.validateTerminalConfig(term);
      const cp = this.checkpointStore.getTerminal(term.id, term.serialNumber);

      this.controllers.set(term.id, {
        config: term,
        runtime: {
          id: term.id,
          name: term.name,
          serialNumber: term.serialNumber,
          ipAddress: term.ipAddress,
          port: term.port,
          deviceTimezone: term.deviceTimezone,
          bridgeConnected: false,
          deviceReachable: false,
          lastDeviceContactAt: null,
          authError: false,
          consecutiveFailures: 0,
          heartbeatConsecutiveFailures: 0,
          nextRetryAt: null,
          pendingQueueSize: cp.pendingQueue.length,
          lastSuccessfulHeartbeatAt: cp.lastSuccessfulHeartbeatAt,
          lastSuccessfulSyncAt: cp.lastSuccessfulSyncAt,
          lastSyncAttemptAt: cp.lastSyncAttemptAt,
          lastProcessedPunchCount: cp.lastProcessedPunchCount,
          lastError: cp.lastError,
          deviceInfo: cp.deviceInfo || null,
          lastSuccessfulUserSyncAt: cp.lastSuccessfulUserSyncAt ?? null,
          lastUserSyncAttemptAt: cp.lastUserSyncAttemptAt ?? null,
          lastUserSyncError: cp.lastUserSyncError ?? null,
          discoveredUserCount: cp.discoveredUserCount ?? null,
          syncedUserCount: cp.syncedUserCount ?? null,
          userSyncJobStatus: 'IDLE',
          activeUserSyncJobId: null,
        },
        pollTimer: null,
        heartbeatTimer: null,
        jobPollTimer: null,
        inFlightSync: false,
        inFlightUserSync: false,
        inFlightHeartbeat: false,
        inFlightJobPoll: false,
        deferredUserSyncPending: false,
        deferredPunchSyncPending: false,
        activeTasks: new Set<Promise<unknown>>(),
        deviceUsers: cp.pendingUserSync?.users,
      });
    }
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
    this.lastWakeTickMs = Date.now();

    this.logger.info('bridge_starting', {
      bridgeHost: this.config.bridgeHost,
      bridgeVersion: this.config.bridgeVersion,
      pid: process.pid,
      terminalCount: this.controllers.size,
      coreErpBaseUrl: this.config.coreErpBaseUrl,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      jobPollIntervalMs: this.config.jobPollIntervalMs ?? 5000,
    });

    for (const ctrl of this.controllers.values()) {
      // Launch independent poll, heartbeat, and fast user-sync job discovery loops
      void this.trackTask(ctrl, this.runTerminalPollCycle(ctrl.config.id));
      void this.trackTask(ctrl, this.runTerminalHeartbeatLoop(ctrl.config.id));
      if (typeof this.coreErpClient.claimUserSyncJob === 'function') {
        this.scheduleNextJobPoll(ctrl, ctrl.config.jobPollIntervalMs ?? this.config.jobPollIntervalMs ?? 5000);
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
      void this.trackTask(ctrl, this.runTerminalHeartbeatLoop(ctrl.config.id));
      if (typeof this.coreErpClient.claimUserSyncJob === 'function') {
        void this.trackTask(ctrl, this.pollPendingUserSyncJob(ctrl.config.id));
      }
    }
  }

  async stop(graceTimeoutMs = 5000): Promise<void> {
    this.running = false;
    if (this.wakeCheckTimer) {
      clearInterval(this.wakeCheckTimer);
      this.wakeCheckTimer = null;
    }

    const pendingTasks: Promise<unknown>[] = [];
    for (const ctrl of this.controllers.values()) {
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

    this.checkpointStore.persist();
    this.logger.info('bridge_stopped', { terminalCount: this.controllers.size });
  }

  getStatusSnapshot(): BridgeStatusSnapshot {
    return {
      bridgeVersion: this.config.bridgeVersion,
      bridgeHost: this.config.bridgeHost,
      coreErpBaseUrl: this.config.coreErpBaseUrl,
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
   * Normalizes raw hardware records using device IANA timezone and deterministic punch IDs.
   */
  normalizeDeviceRecords(term: TerminalConfig, records: DeviceAttendanceRecord[]): NormalizedPunchEvent[] {
    return records.map((rec) => {
      const localStamp = formatLocalWallClock(rec.localDateTime);
      const utcIso = deviceLocalDateTimeToUtcIso(rec.localDateTime, term.deviceTimezone);
      const devicePunchId = `${term.serialNumber}:${rec.userEnrollmentId}:${localStamp}:${rec.inOutMode}`;
      return {
        devicePunchId,
        userEnrollmentId: rec.userEnrollmentId,
        punchTime: utcIso,
        verifyType: rec.verifyType,
        inOutMode: rec.inOutMode,
      };
    });
  }

  /**
   * Executes one full poll + checkpoint + batched upload cycle for a single terminal.
   */
  async syncTerminalOnce(terminalId: string): Promise<{
    pulledCount: number;
    newlyQueuedCount: number;
    uploadedCount: number;
    duplicateCount: number;
    remainingQueueCount: number;
  }> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl) {
      throw new Error(`Unknown terminal ID '${terminalId}'.`);
    }

    const term = ctrl.config;
    const attemptIso = new Date().toISOString();
    ctrl.runtime.lastSyncAttemptAt = attemptIso;
    this.checkpointStore.updateStatus(term.id, term.serialNumber, { lastSyncAttemptAt: attemptIso });

    const adapter = this.adapterFactory(term);
    let deviceInfo: DeviceInfo | null = ctrl.runtime.deviceInfo;
    let pulledRecords: DeviceAttendanceRecord[] = [];
    let queriedUsers: DeviceEnrolledUser[] | null = null;
    let userQueryAttemptIso: string | null = null;

    // 1. Poll physical biometric device over TCP (read-only)
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
        userQueryAttemptIso = new Date().toISOString();
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
      ctrl.runtime.lastDeviceContactAt = new Date().toISOString();
      this.checkpointStore.updateStatus(term.id, term.serialNumber, { deviceInfo });
    } catch (err: unknown) {
      ctrl.runtime.deviceReachable = false;
      throw err;
    } finally {
      try {
        await adapter.disconnect();
      } catch {
        // Ignore teardown socket error
      }
    }

    // 2. Convert timestamps & filter against persistent local checkpoint
    const normalized = this.normalizeDeviceRecords(term, pulledRecords);
    const freshEvents = this.checkpointStore.filterNewEvents(term.id, term.serialNumber, normalized);
    if (freshEvents.length > 0) {
      this.checkpointStore.enqueuePending(term.id, term.serialNumber, freshEvents);
    }

    // 3. Flush persistent pendingQueue in bounded batches to CoreERP
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

      this.checkpointStore.markBatchAcknowledged(term.id, term.serialNumber, batch);
      uploadedCount += res.inserted;
      duplicateCount += res.duplicates;
    }

    const updatedCp = this.checkpointStore.getTerminal(term.id, term.serialNumber);
    ctrl.runtime.pendingQueueSize = updatedCp.pendingQueue.length;
    ctrl.runtime.lastSuccessfulSyncAt = updatedCp.lastSuccessfulSyncAt || attemptIso;
    ctrl.runtime.lastProcessedPunchCount = freshEvents.length;
    ctrl.runtime.lastError = null;
    ctrl.runtime.authError = false;
    ctrl.runtime.bridgeConnected = true;
    ctrl.runtime.consecutiveFailures = 0;
    ctrl.runtime.nextRetryAt = null;

    if (freshEvents.length === 0) {
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
        : updatedCp.pendingUserSync || null;

    if (snapshotToUpload) {
      try {
        await this.uploadTerminalUsers(ctrl, snapshotToUpload.users, snapshotToUpload.discoveredAt);
      } catch {
        // Error already logged and persisted on pendingUserSync for retry on next cycle
      }
    }

    this.logger.info('terminal_sync_completed', {
      terminalId: term.id,
      serialNumber: term.serialNumber,
      pulledCount: pulledRecords.length,
      newlyQueuedCount: freshEvents.length,
      uploadedCount,
      duplicateCount,
      remainingQueueCount: updatedCp.pendingQueue.length,
    });

    return {
      pulledCount: pulledRecords.length,
      newlyQueuedCount: freshEvents.length,
      uploadedCount,
      duplicateCount,
      remainingQueueCount: updatedCp.pendingQueue.length,
    };
  }

  /**
   * Executes a dedicated hardware user discovery + upload cycle for a single terminal
   * WITHOUT pulling attendance punches, modifying punch checkpoints, or triggering punch reconciliation.
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
    const attemptIso = new Date().toISOString();
    ctrl.runtime.lastUserSyncAttemptAt = attemptIso;
    this.checkpointStore.updateStatus(term.id, term.serialNumber, {
      lastUserSyncAttemptAt: attemptIso,
    });

    const adapter = this.adapterFactory(term);
    let users: DeviceEnrolledUser[] = [];

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
      ctrl.runtime.lastDeviceContactAt = new Date().toISOString();
      ctrl.runtime.discoveredUserCount = users.length;
      this.checkpointStore.updateStatus(term.id, term.serialNumber, {
        deviceInfo,
        discoveredUserCount: users.length,
      });
    } catch (err: unknown) {
      const safeErr = redactSensitiveText((err as Error)?.message || 'Hardware user query failed');
      ctrl.runtime.deviceReachable = false;
      ctrl.runtime.lastUserSyncError = safeErr;
      this.checkpointStore.updateStatus(term.id, term.serialNumber, {
        lastUserSyncAttemptAt: attemptIso,
        lastUserSyncError: safeErr,
      });
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
    }

    const res = await this.uploadTerminalUsers(ctrl, users, attemptIso, {
      jobId: options?.jobId,
      bridgeDaemonRunning: options?.bridgeDaemonRunning,
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
    }
  ) {
    const term = ctrl.config;
    const apiKey = this.resolveKey(term);

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

      this.checkpointStore.updateStatus(term.id, term.serialNumber, {
        lastSuccessfulUserSyncAt: res.syncedAt,
        discoveredUserCount: res.discoveredCount,
        syncedUserCount: res.syncedCount,
        lastUserSyncError: null,
        pendingUserSync: null,
      });

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
      if (err instanceof CoreErpApiError && err.isAuthError) {
        ctrl.runtime.authError = true;
        ctrl.runtime.bridgeConnected = false;
      }

      this.checkpointStore.updateStatus(term.id, term.serialNumber, {
        discoveredUserCount: users.length,
        lastUserSyncError: safeErr,
        pendingUserSync: { users, discoveredAt },
      });

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
   * Reports accurate separated bridge process health vs physical device reachability.
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
        lastConnectionError: ctrl.runtime.lastError,
        lastProcessedPunchCount: ctrl.runtime.lastProcessedPunchCount,
        lastSyncAttemptAt: ctrl.runtime.lastSyncAttemptAt || undefined,
        lastSyncAt: ctrl.runtime.lastSuccessfulSyncAt || undefined,
        lastUserSyncAt: ctrl.runtime.lastSuccessfulUserSyncAt,
        lastUserSyncAttemptAt: ctrl.runtime.lastUserSyncAttemptAt,
        lastUserSyncError: ctrl.runtime.lastUserSyncError,
        discoveredUserCount: ctrl.runtime.discoveredUserCount,
        syncedUserCount: ctrl.runtime.syncedUserCount,
      });

      const nowIso = new Date().toISOString();
      ctrl.runtime.bridgeConnected = true;
      ctrl.runtime.authError = false;
      ctrl.runtime.heartbeatConsecutiveFailures = 0;
      ctrl.runtime.lastSuccessfulHeartbeatAt = nowIso;
      this.checkpointStore.updateStatus(term.id, term.serialNumber, {
        lastSuccessfulHeartbeatAt: nowIso,
      });

      if (this.running) {
        // Prioritize user-sync jobs cleanly without dropping them if a punch poll is currently in flight
        if (hbRes.userSyncRequested || hbRes.pendingUserSyncJob) {
          this.logger.info('bridge_user_sync_requested_by_server', {
            terminalId: term.id,
            serialNumber: term.serialNumber,
            jobId: hbRes.pendingUserSyncJob?.jobId,
          });
          if (!ctrl.inFlightSync && !ctrl.inFlightUserSync) {
            void this.trackTask(
              ctrl,
              this.runTerminalUserSync(term.id, { knownJobId: hbRes.pendingUserSyncJob?.jobId })
            );
          } else {
            ctrl.deferredUserSyncPending = true;
          }
        }

        if (hbRes.syncRequested) {
          this.logger.info('bridge_sync_requested_by_server', {
            terminalId: term.id,
            serialNumber: term.serialNumber,
          });
          if (!ctrl.inFlightSync && !ctrl.inFlightUserSync) {
            void this.trackTask(ctrl, this.runTerminalPollCycle(term.id));
          } else {
            ctrl.deferredPunchSyncPending = true;
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
    }
  }

  /**
   * Diagnostic connection test against physical hardware + CoreERP heartbeat authentication.
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

        const logs = await adapter.getAttendanceLogs();
        attendanceRecordCount = logs.length;

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
    if (ctrl.inFlightJobPoll || ctrl.inFlightUserSync || ctrl.inFlightSync) {
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
    if (!ctrl || ctrl.inFlightUserSync || ctrl.inFlightSync) {
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
    if (ctrl.inFlightUserSync || ctrl.inFlightSync) {
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

      if (this.running && ctrl.deferredPunchSyncPending) {
        ctrl.deferredPunchSyncPending = false;
        void this.trackTask(ctrl, this.runTerminalPollCycle(ctrl.config.id));
      }
    }
  }

  private async runTerminalPollCycle(terminalId: string): Promise<void> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl || ctrl.inFlightSync || ctrl.inFlightUserSync) return;

    if (ctrl.pollTimer) {
      clearTimeout(ctrl.pollTimer);
      ctrl.pollTimer = null;
    }

    ctrl.inFlightSync = true;
    const baseInterval = ctrl.config.pollIntervalMs ?? this.config.pollIntervalMs;

    try {
      await this.syncTerminalOnce(terminalId);
    } catch (err: unknown) {
      const msg = redactSensitiveText((err as Error)?.message || 'Sync error');
      ctrl.runtime.consecutiveFailures += 1;
      ctrl.runtime.lastError = msg;

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
    } finally {
      ctrl.inFlightSync = false;

      if (this.running && ctrl.deferredUserSyncPending) {
        ctrl.deferredUserSyncPending = false;
        void this.trackTask(ctrl, this.runTerminalUserSync(terminalId));
      }

      if (this.running) {
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
