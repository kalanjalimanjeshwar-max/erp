import {
  BridgeConfig,
  BridgeStatusSnapshot,
  DeviceAttendanceRecord,
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
  coreErpHeartbeatOk: boolean;
  error: string | null;
}

interface TerminalController {
  config: TerminalConfig;
  runtime: TerminalRuntimeStatus;
  pollTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  inFlightSync: boolean;
  inFlightHeartbeat: boolean;
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
    this.adapterFactory = options.adapterFactory || (() => new ZKTecoTcpAdapter());

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
          authError: false,
          consecutiveFailures: 0,
          nextRetryAt: null,
          pendingQueueSize: cp.pendingQueue.length,
          lastSuccessfulHeartbeatAt: cp.lastSuccessfulHeartbeatAt,
          lastSuccessfulSyncAt: cp.lastSuccessfulSyncAt,
          lastSyncAttemptAt: cp.lastSyncAttemptAt,
          lastProcessedPunchCount: cp.lastProcessedPunchCount,
          lastError: cp.lastError,
          deviceInfo: cp.deviceInfo || null,
        },
        pollTimer: null,
        heartbeatTimer: null,
        inFlightSync: false,
        inFlightHeartbeat: false,
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

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info('bridge_starting', {
      bridgeHost: this.config.bridgeHost,
      bridgeVersion: this.config.bridgeVersion,
      terminalCount: this.controllers.size,
      coreErpBaseUrl: this.config.coreErpBaseUrl,
    });

    for (const ctrl of this.controllers.values()) {
      // Run initial heartbeat + poll immediately, then schedule independent loops
      void this.runTerminalPollCycle(ctrl.config.id);
      void this.runTerminalHeartbeat(ctrl.config.id);

      const hbInterval = ctrl.config.heartbeatIntervalMs ?? this.config.heartbeatIntervalMs;
      ctrl.heartbeatTimer = setInterval(() => {
        if (this.running) {
          void this.runTerminalHeartbeat(ctrl.config.id);
        }
      }, hbInterval);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const ctrl of this.controllers.values()) {
      if (ctrl.pollTimer) {
        clearTimeout(ctrl.pollTimer);
        ctrl.pollTimer = null;
      }
      if (ctrl.heartbeatTimer) {
        clearInterval(ctrl.heartbeatTimer);
        ctrl.heartbeatTimer = null;
      }
    }
    this.checkpointStore.persist();
    this.logger.info('bridge_stopped', { terminalCount: this.controllers.size });
  }

  getStatusSnapshot(): BridgeStatusSnapshot {
    return {
      bridgeVersion: this.config.bridgeVersion,
      bridgeHost: this.config.bridgeHost,
      coreErpBaseUrl: this.config.coreErpBaseUrl,
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
      ctrl.runtime.deviceReachable = true;
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
   * Sends a single authenticated heartbeat for a terminal and triggers immediate poll if syncRequested=true.
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
        lastConnectionError: ctrl.runtime.lastError,
        lastProcessedPunchCount: ctrl.runtime.lastProcessedPunchCount,
        lastSyncAttemptAt: ctrl.runtime.lastSyncAttemptAt || undefined,
        lastSyncAt: ctrl.runtime.lastSuccessfulSyncAt || undefined,
      });

      const nowIso = new Date().toISOString();
      ctrl.runtime.bridgeConnected = true;
      ctrl.runtime.authError = false;
      ctrl.runtime.lastSuccessfulHeartbeatAt = nowIso;
      this.checkpointStore.updateStatus(term.id, term.serialNumber, {
        lastSuccessfulHeartbeatAt: nowIso,
      });

      if (hbRes.syncRequested && this.running && !ctrl.inFlightSync) {
        this.logger.info('bridge_sync_requested_by_server', {
          terminalId: term.id,
          serialNumber: term.serialNumber,
        });
        void this.runTerminalPollCycle(term.id);
      }

      return true;
    } catch (err: unknown) {
      const msg = redactSensitiveText((err as Error)?.message || 'Heartbeat failed');
      ctrl.runtime.bridgeConnected = false;
      if (err instanceof CoreErpApiError && err.isAuthError) {
        ctrl.runtime.authError = true;
        ctrl.runtime.lastError = msg;
      }
      this.logger.warn('terminal_heartbeat_failed', {
        terminalId: term.id,
        serialNumber: term.serialNumber,
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
        coreErpHeartbeatOk,
        error,
      });
    }

    return reports;
  }

  private async runTerminalHeartbeat(terminalId: string): Promise<void> {
    await this.sendTerminalHeartbeat(terminalId);
  }

  private async runTerminalPollCycle(terminalId: string): Promise<void> {
    const ctrl = this.controllers.get(terminalId);
    if (!ctrl || ctrl.inFlightSync) return;

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

      if (this.running) {
        const delayMs = ctrl.runtime.authError
          ? this.config.maxBackoffMs
          : this.computeBackoffDelayMs(ctrl.runtime.consecutiveFailures, baseInterval);
        ctrl.runtime.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        ctrl.pollTimer = setTimeout(() => {
          if (this.running) {
            void this.runTerminalPollCycle(terminalId);
          }
        }, delayMs);
      }
    }
  }
}
