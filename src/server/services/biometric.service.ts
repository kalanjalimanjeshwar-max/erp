import crypto from 'crypto';
import net from 'net';
import { prisma } from '../db/client.js';
import {
  AuthUser,
  BiometricBridgeProcessStatus,
  BiometricDeviceConnectionStatus,
  BiometricTerminalItem,
  BiometricConnectionTestStatus,
  BiometricUserSyncJob,
  BiometricUserSyncJobStatus,
  ClaimUserSyncJobRequest,
  ClaimUserSyncJobResponse,
  CreateBiometricTerminalRequest,
  CreateBiometricTerminalResponse,
  BatchPunchSubmissionRequest,
  BatchPunchSubmissionResponse,
  DeviceEnrolledUserItem,
  PendingUserSyncJobSummary,
  ReportUserSyncJobFailureRequest,
  ReportUserSyncJobFailureResponse,
  SyncDeviceUsersRequest,
  SyncDeviceUsersResponse,
  TerminalHeartbeatRequest,
  TerminalHeartbeatResponse,
  TerminalUserSyncStatusResponse,
  TestBiometricConnectionResponse,
  TriggerTerminalSyncResponse,
  TriggerTerminalUserSyncResponse,
  BiometricTerminalStatus,
  BiometricVerifyType,
  PunchInOutMode,
  PunchReconciliationOptions,
  RawPunchEventInput,
} from '../../shared/types.js';
import { isValidLanHost, redactSensitiveText } from '../../shared/biometric.js';
import { AuditService } from './audit.service.js';
import { BiometricMappingService } from './biometric-mapping.service.js';
import { PunchReconciliationService } from './punch-reconciliation.service.js';
import {
  computeCurrentDayUpperBoundUtc,
  computeCurrentLocalDayStartUtc,
  createBiometricSafetyError,
  evaluateReconciliationWindow,
  resolveStrictCompanyTimezone,
  validateReconciliationRequestPreDb,
} from './biometric-safety.js';

const VALID_VERIFY_TYPES: BiometricVerifyType[] = ['FINGERPRINT', 'CARD', 'PASSWORD', 'FACE'];
const VALID_IN_OUT_MODES: PunchInOutMode[] = ['CHECK_IN', 'CHECK_OUT', 'BREAK_OUT', 'BREAK_IN'];
const MAX_BATCH_PUNCHES = 500;
const BRIDGE_TELEMETRY_SETTING_KEY = 'BIOMETRIC_BRIDGE_TELEMETRY_V1';
const HEARTBEAT_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
const USER_SYNC_QUEUE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes to be claimed/completed before timeout
const USER_SYNC_EXECUTION_LEASE_MS = 60 * 1000; // 60 seconds active execution lease once claimed
const USER_SYNC_DEFAULT_MAX_ATTEMPTS = 3;

export interface TerminalBridgeTelemetry {
  bridgeConnected?: boolean;
  bridgeHost?: string | null;
  bridgeVersion?: string | null;
  bridgePid?: number | null;
  deviceReachable?: boolean;
  lastDeviceContactAt?: string | null;
  lastBridgeHeartbeatAt?: string | null;
  lastSyncAttemptAt?: string | null;
  lastConnectionError?: string | null;
  lastProcessedPunchCount?: number;
  lastTestConnectionAt?: string | null;
  lastTestConnectionStatus?: BiometricConnectionTestStatus | null;
  lastTestConnectionMessage?: string | null;
  syncRequestedAt?: string | null;
  platform?: string | null;
  fingerprintAlgorithm?: string | null;
  lastUserSyncAt?: string | null;
  lastUserSyncAttemptAt?: string | null;
  lastUserSyncError?: string | null;
  discoveredUserCount?: number | null;
  syncedUserCount?: number | null;
  userSyncRequestedAt?: string | null;
  userSyncJob?: BiometricUserSyncJob | null;
}

const telemetryCompanyLocks = new Map<string, Promise<void>>();

export class BiometricService {
  /**
   * Serializes read-modify-write mutations to CompanySetting telemetry JSON per company
   * so concurrent heartbeats, UI sync requests, and job claims never clobber each other.
   */
  private static async withTelemetryLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const prev = telemetryCompanyLocks.get(companyId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextChain = prev.then(() => gate, () => gate);
    telemetryCompanyLocks.set(companyId, nextChain);

    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (telemetryCompanyLocks.get(companyId) === nextChain) {
        telemetryCompanyLocks.delete(companyId);
      }
    }
  }
  /**
   * Non-destructively reads per-terminal bridge telemetry stored in CompanySetting
   */
  private static async readBridgeTelemetryMap(companyId: string): Promise<Record<string, TerminalBridgeTelemetry>> {
    try {
      if (typeof prisma.companySetting?.findUnique !== 'function') {
        return {};
      }
      const row = await prisma.companySetting.findUnique({
        where: {
          companyId_key: {
            companyId,
            key: BRIDGE_TELEMETRY_SETTING_KEY,
          },
        },
      });
      if (!row?.value) return {};
      const parsed = JSON.parse(row.value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, TerminalBridgeTelemetry>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Non-destructively updates bridge telemetry for a single terminal inside CompanySetting
   */
  private static async upsertTerminalTelemetry(
    companyId: string,
    terminalId: string,
    patch: Partial<TerminalBridgeTelemetry>
  ): Promise<TerminalBridgeTelemetry> {
    return this.withTelemetryLock(companyId, async () => {
      const existingMap = await this.readBridgeTelemetryMap(companyId);
      const prev = existingMap[terminalId] || {};
      const nextEntry: TerminalBridgeTelemetry = {
        ...prev,
        ...patch,
      };

      if (typeof nextEntry.lastConnectionError === 'string') {
        nextEntry.lastConnectionError = redactSensitiveText(nextEntry.lastConnectionError).slice(0, 500);
      }
      if (typeof nextEntry.lastTestConnectionMessage === 'string') {
        nextEntry.lastTestConnectionMessage = redactSensitiveText(nextEntry.lastTestConnectionMessage).slice(0, 500);
      }
      if (typeof nextEntry.lastUserSyncError === 'string') {
        nextEntry.lastUserSyncError = redactSensitiveText(nextEntry.lastUserSyncError).slice(0, 500);
      }
      if (nextEntry.userSyncJob && typeof nextEntry.userSyncJob.error === 'string') {
        nextEntry.userSyncJob = {
          ...nextEntry.userSyncJob,
          error: redactSensitiveText(nextEntry.userSyncJob.error).slice(0, 500),
        };
      }

      existingMap[terminalId] = nextEntry;

      try {
        if (typeof prisma.companySetting?.upsert === 'function') {
          await prisma.companySetting.upsert({
            where: {
              companyId_key: {
                companyId,
                key: BRIDGE_TELEMETRY_SETTING_KEY,
              },
            },
            update: {
              value: JSON.stringify(existingMap),
            },
            create: {
              companyId,
              key: BRIDGE_TELEMETRY_SETTING_KEY,
              value: JSON.stringify(existingMap),
            },
          });
        }
      } catch {
        // Non-fatal: mocked tests or transient telemetry write failure must not abort punch ingestion
      }

      return nextEntry;
    });
  }

  /**
   * Atomically mutates telemetry for a single terminal using a transform callback.
   */
  private static async mutateTerminalTelemetry<T>(
    companyId: string,
    terminalId: string,
    mutator: (prev: TerminalBridgeTelemetry) => { next: TerminalBridgeTelemetry; result: T; persist?: boolean }
  ): Promise<{ telemetry: TerminalBridgeTelemetry; result: T }> {
    return this.withTelemetryLock(companyId, async () => {
      const existingMap = await this.readBridgeTelemetryMap(companyId);
      const prev = existingMap[terminalId] || {};
      const { next, result, persist = true } = mutator(prev);

      if (typeof next.lastConnectionError === 'string') {
        next.lastConnectionError = redactSensitiveText(next.lastConnectionError).slice(0, 500);
      }
      if (typeof next.lastUserSyncError === 'string') {
        next.lastUserSyncError = redactSensitiveText(next.lastUserSyncError).slice(0, 500);
      }
      if (next.userSyncJob && typeof next.userSyncJob.error === 'string') {
        next.userSyncJob = {
          ...next.userSyncJob,
          error: redactSensitiveText(next.userSyncJob.error).slice(0, 500),
        };
      }

      if (persist) {
        existingMap[terminalId] = next;
        try {
          if (typeof prisma.companySetting?.upsert === 'function') {
            await prisma.companySetting.upsert({
              where: {
                companyId_key: {
                  companyId,
                  key: BRIDGE_TELEMETRY_SETTING_KEY,
                },
              },
              update: {
                value: JSON.stringify(existingMap),
              },
              create: {
                companyId,
                key: BRIDGE_TELEMETRY_SETTING_KEY,
                value: JSON.stringify(existingMap),
              },
            });
          }
        } catch {
          // Non-fatal in mocked unit tests
        }
      }

      return { telemetry: next, result };
    });
  }

  /**
   * Evaluates a persisted user-sync job against its deadline without losing history.
   * Expired QUEUED/RUNNING jobs transition to FAILED with a clear diagnostic message
   * when no bridge claimed/completed them in time.
   */
  static evaluateUserSyncJob(
    job: BiometricUserSyncJob | null | undefined,
    nowMs: number = Date.now()
  ): BiometricUserSyncJob | null {
    if (!job) return null;
    if (job.status === 'QUEUED' || job.status === 'RUNNING') {
      const timeoutMs = new Date(job.timeoutAt).getTime();
      if (!Number.isNaN(timeoutMs) && nowMs > timeoutMs) {
        if (job.status === 'RUNNING' && job.attempts < job.maxAttempts) {
          return {
            ...job,
            status: 'FAILED',
            completedAt: new Date(nowMs).toISOString(),
            error:
              job.error ||
              'User sync job timed out while waiting for the Windows LAN Bridge to finish reading the device.',
          };
        }
        return {
          ...job,
          status: 'FAILED',
          completedAt: new Date(nowMs).toISOString(),
          error:
            job.error ||
            (job.status === 'QUEUED'
              ? 'User sync job timed out before the Windows LAN Bridge claimed it. Verify the bridge daemon is running and sending heartbeats.'
              : 'User sync job timed out while reading enrolled users from the biometric device.'),
        };
      }
    }
    return job;
  }

  /**
   * Determines whether a terminal has a claimable user-sync job.
   */
  private static getClaimableJobSummary(
    telemetry: TerminalBridgeTelemetry,
    nowMs: number = Date.now()
  ): PendingUserSyncJobSummary | null {
    const job = telemetry.userSyncJob;
    if (!job) return null;
    const timeoutMs = new Date(job.timeoutAt).getTime();

    if (job.status === 'QUEUED') {
      if (!Number.isNaN(timeoutMs) && nowMs > timeoutMs) {
        return null;
      }
      return {
        jobId: job.jobId,
        requestedAt: job.requestedAt,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        timeoutAt: job.timeoutAt,
      };
    }

    // Re-claimable if an earlier bridge execution lease expired and retry budget remains
    if (job.status === 'RUNNING' && !Number.isNaN(timeoutMs) && nowMs > timeoutMs && job.attempts < job.maxAttempts) {
      return {
        jobId: job.jobId,
        requestedAt: job.requestedAt,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        timeoutAt: job.timeoutAt,
      };
    }

    return null;
  }

  /**
   * Lists registered biometric terminals scoped strictly to actor company
   */
  static async listTerminals(
    companyId: string,
    options?: { status?: BiometricTerminalStatus; includeInactive?: boolean }
  ): Promise<BiometricTerminalItem[]> {
    const where: {
      companyId: string;
      status?: BiometricTerminalStatus;
      isActive?: boolean;
    } = { companyId };

    if (options?.status) {
      where.status = options.status;
    }

    if (!options?.includeInactive) {
      where.isActive = true;
    }

    const [terminals, telemetryMap] = await Promise.all([
      prisma.biometricTerminal.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        include: {
          registeredByUser: {
            select: { fullName: true },
          },
        },
      }),
      this.readBridgeTelemetryMap(companyId),
    ]);

    return terminals.map((t) => this.mapToTerminalItem(t, telemetryMap[t.id]));
  }

  /**
   * Derives effective terminal ONLINE/OFFLINE/ERROR/DEACTIVATED status using heartbeat freshness.
   * Documented fixed freshness window of 5 minutes (300,000 ms).
   */
  static getEffectiveStatus(terminal: {
    status: string;
    isActive: boolean;
    lastHeartbeatAt: Date | null;
  }): BiometricTerminalStatus {
    const now = Date.now();

    if (!terminal.isActive || terminal.status === 'DEACTIVATED') {
      return 'DEACTIVATED';
    }
    if (terminal.status === 'ERROR') {
      return 'ERROR';
    }
    if (!terminal.lastHeartbeatAt || now - terminal.lastHeartbeatAt.getTime() > HEARTBEAT_FRESHNESS_WINDOW_MS) {
      return 'OFFLINE';
    }
    return 'ONLINE';
  }

  /**
   * Derives whether the Windows LAN Bridge daemon itself has sent a fresh heartbeat.
   */
  private static isBridgeFresh(
    terminal: { isActive: boolean; status: string; lastHeartbeatAt: Date | null },
    telemetry?: TerminalBridgeTelemetry
  ): boolean {
    if (!terminal.isActive || terminal.status === 'DEACTIVATED') {
      return false;
    }
    const bridgeBeatIso =
      telemetry?.lastBridgeHeartbeatAt ||
      (terminal.lastHeartbeatAt ? new Date(terminal.lastHeartbeatAt).toISOString() : null);
    if (!bridgeBeatIso) return false;
    const bridgeBeatMs = new Date(bridgeBeatIso).getTime();
    if (Number.isNaN(bridgeBeatMs)) return false;
    const isFresh = Date.now() - bridgeBeatMs <= HEARTBEAT_FRESHNESS_WINDOW_MS;
    if (!isFresh) return false;
    return telemetry?.bridgeConnected !== false;
  }

  /**
   * Derives explicit Bridge Process status (ONLINE / OFFLINE) based strictly on fresh authenticated heartbeat.
   */
  static deriveBridgeStatus(
    terminal: { isActive: boolean; status: string; lastHeartbeatAt: Date | null },
    telemetry?: TerminalBridgeTelemetry
  ): BiometricBridgeProcessStatus {
    return this.isBridgeFresh(terminal, telemetry) ? 'ONLINE' : 'OFFLINE';
  }

  /**
   * Derives explicit Physical Device connection status (CONNECTED / DISCONNECTED / DEACTIVATED).
   * Never reports CONNECTED solely because the terminal is registered or because the bridge process is alive.
   */
  static deriveDeviceConnectionStatus(
    terminal: { isActive: boolean; status: string; lastHeartbeatAt: Date | null },
    telemetry?: TerminalBridgeTelemetry
  ): BiometricDeviceConnectionStatus {
    if (!terminal.isActive || terminal.status === 'DEACTIVATED') {
      return 'DEACTIVATED';
    }
    const bridgeOnline = this.isBridgeFresh(terminal, telemetry);
    if (!bridgeOnline) {
      return 'DISCONNECTED';
    }
    if (telemetry?.deviceReachable === false) {
      return 'DISCONNECTED';
    }
    if (telemetry?.lastConnectionError) {
      return 'DISCONNECTED';
    }
    if (telemetry?.deviceReachable === true) {
      if (telemetry.lastDeviceContactAt) {
        const contactMs = new Date(telemetry.lastDeviceContactAt).getTime();
        if (!Number.isNaN(contactMs) && Date.now() - contactMs > HEARTBEAT_FRESHNESS_WINDOW_MS) {
          return 'DISCONNECTED';
        }
      }
      return 'CONNECTED';
    }
    // Legacy heartbeats without explicit deviceReachable field fall back to effective terminal status
    return this.getEffectiveStatus(terminal) === 'ONLINE' ? 'CONNECTED' : 'DISCONNECTED';
  }

  /**
   * Maps a Prisma biometric terminal record + bridge telemetry to a client-safe BiometricTerminalItem
   */
  static mapToTerminalItem(t: any, telemetry?: TerminalBridgeTelemetry): BiometricTerminalItem {
    const bridgeConnected = this.isBridgeFresh(t, telemetry);
    const bridgeStatus: BiometricBridgeProcessStatus = bridgeConnected ? 'ONLINE' : 'OFFLINE';
    const deviceConnectionStatus = this.deriveDeviceConnectionStatus(t, telemetry);
    const evaluatedJob = this.evaluateUserSyncJob(telemetry?.userSyncJob);
    const userSyncStatus: BiometricUserSyncJobStatus = evaluatedJob ? evaluatedJob.status : 'IDLE';

    return {
      id: t.id,
      companyId: t.companyId,
      deviceSerialNumber: t.deviceSerialNumber,
      name: t.name,
      terminalModel: t.terminalModel,
      ipAddress: t.ipAddress,
      port: t.port,
      location: t.location,
      apiKeyPrefix: t.apiKeyPrefix,
      status: this.getEffectiveStatus(t),
      lastHeartbeatAt: t.lastHeartbeatAt
        ? (t.lastHeartbeatAt instanceof Date ? t.lastHeartbeatAt.toISOString() : new Date(t.lastHeartbeatAt).toISOString())
        : null,
      lastSyncAt: t.lastSyncAt
        ? (t.lastSyncAt instanceof Date ? t.lastSyncAt.toISOString() : new Date(t.lastSyncAt).toISOString())
        : null,
      firmwareVersion: t.firmwareVersion,
      registeredByUserId: t.registeredByUserId,
      registeredByUserName: t.registeredByUser?.fullName || null,
      isActive: t.isActive,
      notes: t.notes,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : new Date(t.createdAt).toISOString(),
      updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : new Date(t.updatedAt).toISOString(),
      bridgeStatus,
      deviceConnectionStatus,
      deviceReachable: deviceConnectionStatus === 'CONNECTED',
      lastDeviceContactAt: telemetry?.lastDeviceContactAt ?? null,
      userSyncStatus,
      userSyncJob: evaluatedJob,
      bridgeConnected,
      bridgeHost: telemetry?.bridgeHost ?? null,
      bridgeVersion: telemetry?.bridgeVersion ?? null,
      lastBridgeHeartbeatAt: telemetry?.lastBridgeHeartbeatAt ?? null,
      lastSyncAttemptAt: telemetry?.lastSyncAttemptAt ?? null,
      lastConnectionError: telemetry?.lastConnectionError ?? null,
      lastProcessedPunchCount: telemetry?.lastProcessedPunchCount ?? 0,
      lastTestConnectionAt: telemetry?.lastTestConnectionAt ?? null,
      lastTestConnectionStatus: telemetry?.lastTestConnectionStatus ?? null,
      lastTestConnectionMessage: telemetry?.lastTestConnectionMessage ?? null,
      syncRequestedAt: telemetry?.syncRequestedAt ?? null,
      platform: telemetry?.platform ?? null,
      fingerprintAlgorithm: telemetry?.fingerprintAlgorithm ?? null,
      lastUserSyncAt: telemetry?.lastUserSyncAt ?? null,
      lastUserSyncAttemptAt: telemetry?.lastUserSyncAttemptAt ?? null,
      lastUserSyncError: evaluatedJob?.status === 'FAILED' && evaluatedJob.error
        ? evaluatedJob.error
        : telemetry?.lastUserSyncError ?? null,
      discoveredUserCount: telemetry?.discoveredUserCount ?? null,
      syncedUserCount: telemetry?.syncedUserCount ?? null,
      userSyncRequestedAt: telemetry?.userSyncRequestedAt ?? null,
    };
  }

  /**
   * Registers a new physical biometric terminal and generates a high-entropy API key.
   * Note: The plaintext API key is returned exactly once in the creation response.
   */
  static async registerTerminal(
    actor: AuthUser,
    input: CreateBiometricTerminalRequest,
    correlationId?: string
  ): Promise<CreateBiometricTerminalResponse> {
    const deviceSerialNumber = (input.deviceSerialNumber || '').trim();
    if (!deviceSerialNumber) {
      const err = new Error('Device serial number is mandatory.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const name = (input.name || '').trim();
    if (!name) {
      const err = new Error('Terminal name is mandatory.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const rawIp = input.ipAddress?.trim() || null;
    if (rawIp && !isValidLanHost(rawIp)) {
      const err = new Error('Invalid LAN IP address or hostname format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const resolvedPort = input.port === undefined ? 4370 : Number(input.port);
    if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
      const err = new Error('Hardware TCP port must be an integer between 1 and 65535.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check duplicate serial number within tenant
    const duplicate = await prisma.biometricTerminal.findUnique({
      where: {
        companyId_deviceSerialNumber: {
          companyId: actor.companyId,
          deviceSerialNumber,
        },
      },
    });

    if (duplicate) {
      const err = new Error(
        `Biometric terminal with serial number '${deviceSerialNumber}' is already registered in this company.`
      );
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    // Generate 256-bit cryptographically secure random API key
    const rawSecret = crypto.randomBytes(32).toString('hex');
    const plainApiKey = `bio_live_${rawSecret}`;
    const apiKeyHash = crypto.createHash('sha256').update(plainApiKey).digest('hex');
    const apiKeyPrefix = plainApiKey.slice(0, 12);

    const terminal = await prisma.biometricTerminal.create({
      data: {
        companyId: actor.companyId,
        deviceSerialNumber,
        name,
        terminalModel: (input.terminalModel || 'ZKTeco-F22').trim(),
        ipAddress: rawIp,
        port: resolvedPort,
        location: input.location?.trim() || null,
        apiKeyHash,
        apiKeyPrefix,
        status: 'OFFLINE',
        registeredByUserId: actor.userId || actor.id,
        isActive: true,
        notes: input.notes?.trim() || null,
      },
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'BIOMETRIC_TERMINAL_REGISTER',
      entity: 'BiometricTerminal',
      entityId: terminal.id,
      correlationId,
      details: {
        deviceSerialNumber: terminal.deviceSerialNumber,
        name: terminal.name,
        terminalModel: terminal.terminalModel,
        ipAddress: terminal.ipAddress,
        apiKeyPrefix: terminal.apiKeyPrefix,
      },
    });

    return {
      terminal: this.mapToTerminalItem(terminal),
      apiKey: plainApiKey,
    };
  }

  /**
   * Processes a keepalive heartbeat from an authenticated physical terminal or LAN bridge daemon
   */
  static async recordHeartbeat(
    terminal: any,
    payload: TerminalHeartbeatRequest,
    correlationId?: string
  ): Promise<TerminalHeartbeatResponse> {
    if (
      payload.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() &&
      terminal.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() !== terminal.deviceSerialNumber
    ) {
      const mismatchMsg = `Serial number mismatch reported by bridge: expected '${terminal.deviceSerialNumber}', received '${payload.deviceSerialNumber.trim()}'.`;
      await this.upsertTerminalTelemetry(terminal.companyId, terminal.id, {
        bridgeConnected: false,
        lastBridgeHeartbeatAt: new Date().toISOString(),
        lastConnectionError: mismatchMsg,
      });
      const err = new Error(mismatchMsg);
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const now = new Date();
    const hasConnectionError =
      typeof payload.lastConnectionError === 'string' && payload.lastConnectionError.trim().length > 0;
    const bridgeAlive = payload.bridgeConnected !== false;
    // Physical device is only considered online when bridge is alive, has no connection error,
    // and did NOT explicitly report deviceReachable === false.
    const isDeviceOnline = bridgeAlive && !hasConnectionError && payload.deviceReachable !== false;
    const derivedStatus: BiometricTerminalStatus = hasConnectionError
      ? 'ERROR'
      : isDeviceOnline
      ? 'ONLINE'
      : 'OFFLINE';

    const dataToUpdate: {
      lastHeartbeatAt: Date;
      status: BiometricTerminalStatus;
      firmwareVersion?: string;
      lastSyncAt?: Date;
    } = {
      lastHeartbeatAt: now,
      status: derivedStatus,
    };

    if (payload.firmwareVersion && payload.firmwareVersion.trim()) {
      dataToUpdate.firmwareVersion = payload.firmwareVersion.trim();
    }

    if (payload.lastSyncAt) {
      const parsedLastSync = new Date(payload.lastSyncAt);
      if (!Number.isNaN(parsedLastSync.getTime())) {
        dataToUpdate.lastSyncAt = parsedLastSync;
      }
    }

    await prisma.biometricTerminal.update({
      where: { id: terminal.id },
      data: dataToUpdate,
    });

    const telemetryPatch: Partial<TerminalBridgeTelemetry> = {
      bridgeConnected: bridgeAlive,
      lastBridgeHeartbeatAt: now.toISOString(),
      lastConnectionError: hasConnectionError ? redactSensitiveText(payload.lastConnectionError!.trim()) : null,
    };

    if (typeof payload.deviceReachable === 'boolean') {
      telemetryPatch.deviceReachable = payload.deviceReachable;
    } else if (hasConnectionError) {
      telemetryPatch.deviceReachable = false;
    }
    if (payload.lastDeviceContactAt !== undefined) {
      telemetryPatch.lastDeviceContactAt = payload.lastDeviceContactAt;
    }
    if (typeof payload.bridgePid === 'number' && Number.isInteger(payload.bridgePid) && payload.bridgePid > 0) {
      telemetryPatch.bridgePid = payload.bridgePid;
    }
    if (payload.bridgeHost) telemetryPatch.bridgeHost = payload.bridgeHost.trim().slice(0, 128);
    if (payload.bridgeVersion) telemetryPatch.bridgeVersion = payload.bridgeVersion.trim().slice(0, 64);
    if (payload.platform) telemetryPatch.platform = payload.platform.trim().slice(0, 64);
    if (payload.fingerprintAlgorithm) {
      telemetryPatch.fingerprintAlgorithm = payload.fingerprintAlgorithm.trim().slice(0, 64);
    }
    if (typeof payload.lastProcessedPunchCount === 'number' && payload.lastProcessedPunchCount >= 0) {
      telemetryPatch.lastProcessedPunchCount = payload.lastProcessedPunchCount;
    }
    if (payload.lastSyncAttemptAt) {
      telemetryPatch.lastSyncAttemptAt = payload.lastSyncAttemptAt;
    }
    if (payload.lastUserSyncAt !== undefined) {
      telemetryPatch.lastUserSyncAt = payload.lastUserSyncAt;
    }
    if (payload.lastUserSyncAttemptAt !== undefined) {
      telemetryPatch.lastUserSyncAttemptAt = payload.lastUserSyncAttemptAt;
    }
    if (payload.lastUserSyncError !== undefined) {
      telemetryPatch.lastUserSyncError = payload.lastUserSyncError
        ? redactSensitiveText(payload.lastUserSyncError.trim())
        : null;
    }
    if (typeof payload.discoveredUserCount === 'number' && payload.discoveredUserCount >= 0) {
      telemetryPatch.discoveredUserCount = payload.discoveredUserCount;
    }
    if (typeof payload.syncedUserCount === 'number' && payload.syncedUserCount >= 0) {
      telemetryPatch.syncedUserCount = payload.syncedUserCount;
    }

    if (Array.isArray(payload.deviceUsers)) {
      const snap = await BiometricMappingService.saveDeviceUsersSnapshot(
        terminal.companyId,
        terminal.id,
        payload.deviceUsers
      );
      telemetryPatch.lastUserSyncAt = snap.syncedAt;
      telemetryPatch.lastUserSyncAttemptAt = snap.syncedAt;
      telemetryPatch.lastUserSyncError = null;
      telemetryPatch.discoveredUserCount = snap.discoveredCount;
      telemetryPatch.syncedUserCount = snap.syncedCount;
    }

    const updatedTelemetry = await this.upsertTerminalTelemetry(terminal.companyId, terminal.id, telemetryPatch);

    // Check if an admin requested an out-of-band bridge punch sync after the last sync attempt
    let syncRequested = false;
    if (updatedTelemetry.syncRequestedAt) {
      const reqMs = new Date(updatedTelemetry.syncRequestedAt).getTime();
      const attemptMs = updatedTelemetry.lastSyncAttemptAt
        ? new Date(updatedTelemetry.lastSyncAttemptAt).getTime()
        : 0;
      syncRequested = !Number.isNaN(reqMs) && reqMs > attemptMs;
    }

    const pendingUserSyncJob = this.getClaimableJobSummary(updatedTelemetry, now.getTime());
    let userSyncRequested = pendingUserSyncJob !== null;
    if (!userSyncRequested && !updatedTelemetry.userSyncJob && updatedTelemetry.userSyncRequestedAt) {
      const reqMs = new Date(updatedTelemetry.userSyncRequestedAt).getTime();
      const attemptMs = updatedTelemetry.lastUserSyncAttemptAt
        ? new Date(updatedTelemetry.lastUserSyncAttemptAt).getTime()
        : 0;
      userSyncRequested = !Number.isNaN(reqMs) && reqMs > attemptMs;
    }

    const bridgeStatus: BiometricBridgeProcessStatus = bridgeAlive ? 'ONLINE' : 'OFFLINE';
    const deviceConnectionStatus: BiometricDeviceConnectionStatus = isDeviceOnline
      ? 'CONNECTED'
      : 'DISCONNECTED';

    return {
      success: true,
      serverTime: now.toISOString(),
      terminalId: terminal.id,
      terminalName: terminal.name,
      status: derivedStatus,
      bridgeStatus,
      deviceConnectionStatus,
      syncRequested,
      syncRequestedAt: syncRequested ? updatedTelemetry.syncRequestedAt || null : null,
      userSyncRequested,
      userSyncRequestedAt: userSyncRequested
        ? pendingUserSyncJob?.requestedAt || updatedTelemetry.userSyncRequestedAt || null
        : null,
      pendingUserSyncJob,
    };
  }

  /**
   * Atomically claims a pending or retryable user-sync job for an authenticated terminal (POST /api/biometric/users/jobs/claim).
   * Enforces serial verification, single-claim lease semantics, and strict tenant/terminal isolation.
   */
  static async claimPendingUserSyncJob(
    terminal: any,
    payload: ClaimUserSyncJobRequest = {},
    correlationId?: string
  ): Promise<ClaimUserSyncJobResponse> {
    if (
      payload.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() &&
      terminal.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() !== terminal.deviceSerialNumber
    ) {
      const mismatchMsg = `Serial number mismatch during user-sync job claim: expected '${terminal.deviceSerialNumber}', received '${payload.deviceSerialNumber.trim()}'.`;
      const err = new Error(mismatchMsg);
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const { result } = await this.mutateTerminalTelemetry<{ claimed: boolean; job: BiometricUserSyncJob | null }>(
      terminal.companyId,
      terminal.id,
      (prev) => {
        const existingJob = prev.userSyncJob;
        if (!existingJob) {
          // Support legacy timestamp-only requests by materializing a tracked job
          if (prev.userSyncRequestedAt) {
            const reqMs = new Date(prev.userSyncRequestedAt).getTime();
            const attemptMs = prev.lastUserSyncAttemptAt ? new Date(prev.lastUserSyncAttemptAt).getTime() : 0;
            if (!Number.isNaN(reqMs) && reqMs > attemptMs) {
              const materialized: BiometricUserSyncJob = {
                jobId: crypto.randomUUID(),
                status: 'RUNNING',
                requestedAt: prev.userSyncRequestedAt,
                claimedAt: nowIso,
                startedAt: nowIso,
                completedAt: null,
                timeoutAt: new Date(nowMs + USER_SYNC_EXECUTION_LEASE_MS).toISOString(),
                attempts: 1,
                maxAttempts: USER_SYNC_DEFAULT_MAX_ATTEMPTS,
                error: null,
                bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || prev.bridgeHost || null,
              };
              return {
                next: {
                  ...prev,
                  bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || prev.bridgeHost,
                  bridgeVersion: payload.bridgeVersion?.trim().slice(0, 64) || prev.bridgeVersion,
                  lastUserSyncAttemptAt: nowIso,
                  userSyncJob: materialized,
                },
                result: { claimed: true, job: materialized },
              };
            }
          }
          return { next: prev, result: { claimed: false, job: null }, persist: false };
        }

        const timeoutMs = new Date(existingJob.timeoutAt).getTime();
        const isExpired = !Number.isNaN(timeoutMs) && nowMs > timeoutMs;

        if (existingJob.status === 'QUEUED') {
          if (isExpired) {
            const timedOutJob: BiometricUserSyncJob = {
              ...existingJob,
              status: 'FAILED',
              completedAt: nowIso,
              error: 'User sync job timed out before the Windows LAN Bridge claimed it.',
            };
            return {
              next: {
                ...prev,
                userSyncRequestedAt: null,
                lastUserSyncError: timedOutJob.error,
                userSyncJob: timedOutJob,
              },
              result: { claimed: false, job: null },
            };
          }

          const claimedJob: BiometricUserSyncJob = {
            ...existingJob,
            status: 'RUNNING',
            claimedAt: nowIso,
            startedAt: nowIso,
            completedAt: null,
            timeoutAt: new Date(nowMs + USER_SYNC_EXECUTION_LEASE_MS).toISOString(),
            attempts: existingJob.attempts + 1,
            error: null,
            bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || prev.bridgeHost || null,
          };

          return {
            next: {
              ...prev,
              bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || prev.bridgeHost,
              bridgeVersion: payload.bridgeVersion?.trim().slice(0, 64) || prev.bridgeVersion,
              lastUserSyncAttemptAt: nowIso,
              lastUserSyncError: null,
              userSyncJob: claimedJob,
            },
            result: { claimed: true, job: claimedJob },
          };
        }

        // Allow lease takeover only if a RUNNING job expired and still has retry attempts
        if (existingJob.status === 'RUNNING' && isExpired) {
          if (existingJob.attempts < existingJob.maxAttempts) {
            const retriedJob: BiometricUserSyncJob = {
              ...existingJob,
              status: 'RUNNING',
              claimedAt: nowIso,
              startedAt: nowIso,
              completedAt: null,
              timeoutAt: new Date(nowMs + USER_SYNC_EXECUTION_LEASE_MS).toISOString(),
              attempts: existingJob.attempts + 1,
              error: null,
              bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || prev.bridgeHost || null,
            };
            return {
              next: {
                ...prev,
                lastUserSyncAttemptAt: nowIso,
                userSyncJob: retriedJob,
              },
              result: { claimed: true, job: retriedJob },
            };
          }

          const timedOutJob: BiometricUserSyncJob = {
            ...existingJob,
            status: 'FAILED',
            completedAt: nowIso,
            error: 'User sync job exceeded maximum retry attempts after execution timeout.',
          };
          return {
            next: {
              ...prev,
              userSyncRequestedAt: null,
              lastUserSyncError: timedOutJob.error,
              userSyncJob: timedOutJob,
            },
            result: { claimed: false, job: null },
          };
        }

        // Already RUNNING (not expired) or terminal (SUCCESS/FAILED)
        return { next: prev, result: { claimed: false, job: null }, persist: false };
      }
    );

    if (result.claimed && result.job) {
      await AuditService.log({
        companyId: terminal.companyId,
        userId: terminal.registeredByUserId,
        action: 'BIOMETRIC_DEVICE_USER_SYNC_STARTED',
        entity: 'BiometricTerminal',
        entityId: terminal.id,
        correlationId,
        details: {
          jobId: result.job.jobId,
          attempt: result.job.attempts,
          maxAttempts: result.job.maxAttempts,
          deviceSerialNumber: terminal.deviceSerialNumber,
          bridgeHost: result.job.bridgeHost,
        },
      });
    }

    return {
      success: true,
      claimed: result.claimed,
      terminalId: terminal.id,
      job: result.job,
    };
  }

  /**
   * Records a user-sync job failure reported by an authenticated bridge (POST /api/biometric/users/jobs/fail).
   * Supports bounded retry (returning to QUEUED when retryable and attempts < maxAttempts) or terminal FAILED state.
   */
  static async reportUserSyncJobFailure(
    terminal: any,
    payload: ReportUserSyncJobFailureRequest,
    correlationId?: string
  ): Promise<ReportUserSyncJobFailureResponse> {
    if (!payload || typeof payload.error !== 'string' || !payload.error.trim()) {
      const err = new Error('Failure report must include a non-empty "error" message.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (
      payload.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() &&
      terminal.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() !== terminal.deviceSerialNumber
    ) {
      const mismatchMsg = `Serial number mismatch during user-sync failure report: expected '${terminal.deviceSerialNumber}', received '${payload.deviceSerialNumber.trim()}'.`;
      const err = new Error(mismatchMsg);
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const sanitizedError = redactSensitiveText(payload.error.trim()).slice(0, 500);
    const now = new Date();
    const nowIso = now.toISOString();

    const { result: updatedJob } = await this.mutateTerminalTelemetry<BiometricUserSyncJob | null>(
      terminal.companyId,
      terminal.id,
      (prev) => {
        const existingJob = prev.userSyncJob;
        if (payload.jobId && existingJob && existingJob.jobId !== payload.jobId) {
          // Ignore stale failure reports for an older superseded job
          return { next: prev, result: existingJob, persist: false };
        }

        const shouldRequeue =
          payload.retryable === true &&
          existingJob !== null &&
          existingJob !== undefined &&
          existingJob.attempts < existingJob.maxAttempts;

        const nextJob: BiometricUserSyncJob = existingJob
          ? {
              ...existingJob,
              status: shouldRequeue ? 'QUEUED' : 'FAILED',
              completedAt: shouldRequeue ? null : nowIso,
              timeoutAt: shouldRequeue
                ? new Date(now.getTime() + USER_SYNC_QUEUE_TIMEOUT_MS).toISOString()
                : existingJob.timeoutAt,
              error: sanitizedError,
              bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || existingJob.bridgeHost || null,
            }
          : {
              jobId: payload.jobId || crypto.randomUUID(),
              status: 'FAILED',
              requestedAt: prev.userSyncRequestedAt || nowIso,
              claimedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              timeoutAt: nowIso,
              attempts: 1,
              maxAttempts: USER_SYNC_DEFAULT_MAX_ATTEMPTS,
              error: sanitizedError,
              bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || prev.bridgeHost || null,
            };

        return {
          next: {
            ...prev,
            bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || prev.bridgeHost,
            bridgeVersion: payload.bridgeVersion?.trim().slice(0, 64) || prev.bridgeVersion,
            deviceReachable:
              typeof payload.deviceReachable === 'boolean' ? payload.deviceReachable : prev.deviceReachable,
            lastConnectionError:
              payload.deviceReachable === false ? sanitizedError : prev.lastConnectionError,
            lastUserSyncAttemptAt: nowIso,
            lastUserSyncError: sanitizedError,
            userSyncRequestedAt: shouldRequeue ? prev.userSyncRequestedAt || nowIso : null,
            userSyncJob: nextJob,
          },
          result: nextJob,
        };
      }
    );

    if (payload.deviceReachable === false && typeof prisma.biometricTerminal?.update === 'function') {
      await prisma.biometricTerminal.update({
        where: { id: terminal.id },
        data: { status: 'ERROR' },
      });
    }

    await AuditService.log({
      companyId: terminal.companyId,
      userId: terminal.registeredByUserId,
      action: 'BIOMETRIC_DEVICE_USER_SYNC_FAILED',
      entity: 'BiometricTerminal',
      entityId: terminal.id,
      correlationId,
      details: {
        jobId: updatedJob?.jobId || payload.jobId || null,
        status: updatedJob?.status || 'FAILED',
        attempts: updatedJob?.attempts || 1,
        maxAttempts: updatedJob?.maxAttempts || USER_SYNC_DEFAULT_MAX_ATTEMPTS,
        deviceSerialNumber: terminal.deviceSerialNumber,
        deviceReachable: payload.deviceReachable ?? null,
        error: sanitizedError,
      },
    });

    return {
      success: true,
      terminalId: terminal.id,
      job: updatedJob,
    };
  }

  /**
   * Dedicated authenticated hardware user synchronization ingestion endpoint (POST /api/biometric/users).
   * Persists verified hardware users idempotently, enforces serial & company ownership, and updates job + telemetry.
   * NEVER triggers punch ingestion or PunchReconciliationService.
   */
  static async syncDeviceUsers(
    terminal: any,
    payload: SyncDeviceUsersRequest,
    correlationId?: string
  ): Promise<SyncDeviceUsersResponse> {
    if (!payload || !Array.isArray(payload.deviceUsers)) {
      const err = new Error('Payload must contain a "deviceUsers" array of enrolled hardware users.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (
      payload.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() &&
      terminal.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() !== terminal.deviceSerialNumber
    ) {
      const mismatchMsg = `Device serial number mismatch during hardware user sync: expected '${terminal.deviceSerialNumber}', received '${payload.deviceSerialNumber.trim()}'.`;
      await this.upsertTerminalTelemetry(terminal.companyId, terminal.id, {
        lastUserSyncAttemptAt: new Date().toISOString(),
        lastUserSyncError: mismatchMsg,
      });
      const err = new Error(mismatchMsg);
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const attemptIso = payload.discoveredAt || new Date().toISOString();
    const discoveredCount =
      typeof payload.discoveredCount === 'number' && payload.discoveredCount >= 0
        ? payload.discoveredCount
        : payload.deviceUsers.length;

    const snap = await BiometricMappingService.saveDeviceUsersSnapshot(
      terminal.companyId,
      terminal.id,
      payload.deviceUsers,
      { throwOnError: true }
    );

    const now = new Date();
    const nowIso = now.toISOString();
    // Only mark continuous bridge daemon heartbeat fresh if this upload came from a running daemon
    // (one-shot CLI --sync-users-once sends bridgeDaemonRunning: false so it does not mask an offline daemon).
    const isContinuousDaemon = payload.bridgeDaemonRunning !== false;

    if (isContinuousDaemon && typeof prisma.biometricTerminal?.update === 'function') {
      await prisma.biometricTerminal.update({
        where: { id: terminal.id },
        data: {
          lastHeartbeatAt: now,
          status: 'ONLINE',
        },
      });
    }

    const { result: completedJob } = await this.mutateTerminalTelemetry<BiometricUserSyncJob>(
      terminal.companyId,
      terminal.id,
      (prev) => {
        const existingJob = prev.userSyncJob;
        const jobMatches = !payload.jobId || !existingJob || existingJob.jobId === payload.jobId;
        const completed: BiometricUserSyncJob =
          existingJob && jobMatches
            ? {
                ...existingJob,
                status: 'SUCCESS',
                completedAt: snap.syncedAt,
                discoveredCount,
                syncedCount: snap.syncedCount,
                error: null,
                bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || existingJob.bridgeHost || null,
              }
            : {
                jobId: payload.jobId || crypto.randomUUID(),
                status: 'SUCCESS',
                requestedAt: prev.userSyncRequestedAt || attemptIso,
                claimedAt: attemptIso,
                startedAt: attemptIso,
                completedAt: snap.syncedAt,
                timeoutAt: snap.syncedAt,
                attempts: 1,
                maxAttempts: USER_SYNC_DEFAULT_MAX_ATTEMPTS,
                discoveredCount,
                syncedCount: snap.syncedCount,
                error: null,
                bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || prev.bridgeHost || null,
              };

        return {
          next: {
            ...prev,
            bridgeConnected: isContinuousDaemon ? true : prev.bridgeConnected ?? false,
            bridgeHost: payload.bridgeHost?.trim().slice(0, 128) || prev.bridgeHost,
            bridgeVersion: payload.bridgeVersion?.trim().slice(0, 64) || prev.bridgeVersion,
            lastBridgeHeartbeatAt: isContinuousDaemon ? nowIso : prev.lastBridgeHeartbeatAt ?? null,
            deviceReachable: true,
            lastDeviceContactAt: nowIso,
            lastConnectionError: null,
            lastUserSyncAt: snap.syncedAt,
            lastUserSyncAttemptAt: attemptIso,
            lastUserSyncError: null,
            discoveredUserCount: discoveredCount,
            syncedUserCount: snap.syncedCount,
            userSyncRequestedAt: null,
            userSyncJob: completed,
          },
          result: completed,
        };
      }
    );

    await AuditService.log({
      companyId: terminal.companyId,
      userId: terminal.registeredByUserId,
      action: 'BIOMETRIC_DEVICE_USERS_SYNC',
      entity: 'BiometricTerminal',
      entityId: terminal.id,
      correlationId,
      details: {
        jobId: completedJob.jobId,
        deviceSerialNumber: terminal.deviceSerialNumber,
        discoveredCount,
        syncedCount: snap.syncedCount,
        bridgeDaemonRunning: isContinuousDaemon,
      },
    });

    return {
      success: true,
      terminalId: terminal.id,
      terminalName: terminal.name,
      discoveredCount,
      syncedCount: snap.syncedCount,
      syncedAt: snap.syncedAt,
      job: completedJob,
    };
  }

  /**
   * Deactivates a registered terminal, revoking its credentials and taking it offline immediately.
   * Enforces strict tenant isolation.
   */
  static async deactivateTerminal(
    actor: AuthUser,
    terminalId: string,
    correlationId?: string
  ): Promise<BiometricTerminalItem> {
    const terminal = await prisma.biometricTerminal.findFirst({
      where: {
        id: terminalId,
        companyId: actor.companyId,
      },
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    if (!terminal) {
      const err = new Error('Biometric terminal not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!terminal.isActive && terminal.status === 'DEACTIVATED') {
      return this.mapToTerminalItem(terminal);
    }

    // Invalidate key immediately: set isActive = false, status = DEACTIVATED, and scramble apiKeyHash
    const scrambledHash = crypto
      .createHash('sha256')
      .update(`revoked_${terminal.id}_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`)
      .digest('hex');

    const updated = await prisma.biometricTerminal.update({
      where: { id: terminal.id },
      data: {
        isActive: false,
        status: 'DEACTIVATED',
        apiKeyHash: scrambledHash,
      },
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    await this.upsertTerminalTelemetry(actor.companyId, terminal.id, {
      bridgeConnected: false,
      syncRequestedAt: null,
      userSyncRequestedAt: null,
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'BIOMETRIC_TERMINAL_DEACTIVATE',
      entity: 'BiometricTerminal',
      entityId: terminal.id,
      correlationId,
      details: {
        deviceSerialNumber: terminal.deviceSerialNumber,
        name: terminal.name,
        previousStatus: terminal.status,
      },
    });

    return this.mapToTerminalItem(updated);
  }

  /**
   * Rotates the high-entropy API key for an active terminal.
   * Immediately invalidates the old key and returns the new plaintext key exactly once.
   * Never logs or persists plaintext credentials. Enforces tenant isolation.
   */
  static async rotateTerminalKey(
    actor: AuthUser,
    terminalId: string,
    correlationId?: string
  ): Promise<CreateBiometricTerminalResponse> {
    const terminal = await prisma.biometricTerminal.findFirst({
      where: {
        id: terminalId,
        companyId: actor.companyId,
      },
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    if (!terminal) {
      const err = new Error('Biometric terminal not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!terminal.isActive || terminal.status === 'DEACTIVATED') {
      const err = new Error('Cannot rotate API key for an inactive or deactivated terminal.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Generate new 256-bit cryptographically secure random API key
    const rawSecret = crypto.randomBytes(32).toString('hex');
    const plainApiKey = `bio_live_${rawSecret}`;
    const apiKeyHash = crypto.createHash('sha256').update(plainApiKey).digest('hex');
    const apiKeyPrefix = plainApiKey.slice(0, 12);

    const updated = await prisma.biometricTerminal.update({
      where: { id: terminal.id },
      data: {
        apiKeyHash,
        apiKeyPrefix,
      },
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    // Never log plainApiKey
    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'BIOMETRIC_KEY_ROTATE',
      entity: 'BiometricTerminal',
      entityId: terminal.id,
      correlationId,
      details: {
        deviceSerialNumber: terminal.deviceSerialNumber,
        name: terminal.name,
        newApiKeyPrefix: apiKeyPrefix,
      },
    });

    return {
      terminal: this.mapToTerminalItem(updated),
      apiKey: plainApiKey,
    };
  }

  /**
   * Probes direct TCP reachability from the CoreERP server and cross-checks LAN Bridge telemetry.
   * Never fakes hardware connectivity when the terminal sits behind a private customer LAN.
   */
  static async testTerminalConnection(
    actor: AuthUser,
    terminalId: string,
    correlationId?: string
  ): Promise<TestBiometricConnectionResponse> {
    const terminal = await prisma.biometricTerminal.findFirst({
      where: {
        id: terminalId,
        companyId: actor.companyId,
      },
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    if (!terminal) {
      const err = new Error('Biometric terminal not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const checkedAt = new Date().toISOString();
    const telemetryMap = await this.readBridgeTelemetryMap(actor.companyId);
    const prevTelemetry = telemetryMap[terminal.id];

    if (!terminal.isActive || terminal.status === 'DEACTIVATED') {
      const message = 'Terminal is deactivated. Re-register or activate a device before testing.';
      const updatedTel = await this.upsertTerminalTelemetry(actor.companyId, terminal.id, {
        lastTestConnectionAt: checkedAt,
        lastTestConnectionStatus: 'DEACTIVATED',
        lastTestConnectionMessage: message,
      });
      return {
        success: false,
        status: 'DEACTIVATED',
        checkedAt,
        latencyMs: null,
        message,
        terminal: this.mapToTerminalItem(terminal, updatedTel),
      };
    }

    if (!terminal.ipAddress || !isValidLanHost(terminal.ipAddress)) {
      const message = 'Terminal LAN IP address is not configured. Set a valid LAN IP (e.g. 192.168.1.201) and port 4370.';
      const updatedTel = await this.upsertTerminalTelemetry(actor.companyId, terminal.id, {
        lastTestConnectionAt: checkedAt,
        lastTestConnectionStatus: 'INVALID_CONFIG',
        lastTestConnectionMessage: message,
      });
      return {
        success: false,
        status: 'INVALID_CONFIG',
        checkedAt,
        latencyMs: null,
        message,
        terminal: this.mapToTerminalItem(terminal, updatedTel),
      };
    }

    // Attempt short TCP connect probe from CoreERP backend host
    const tcpProbe = await this.probeTcpPort(terminal.ipAddress, terminal.port || 4370, 2000);
    const bridgeFresh = this.isBridgeFresh(terminal, prevTelemetry);

    let status: BiometricConnectionTestStatus;
    let success: boolean;
    let message: string;

    if (tcpProbe.reachable) {
      status = 'TCP_REACHABLE';
      success = true;
      message = `Direct TCP port ${terminal.port} on ${terminal.ipAddress} is reachable (${tcpProbe.latencyMs}ms). Ensure Windows LAN Bridge is running for ZK protocol handshake & punch polling.`;
    } else if (bridgeFresh) {
      status = 'BRIDGE_MANAGED';
      success = true;
      message = `Windows LAN Bridge (${prevTelemetry?.bridgeHost || 'LAN host'}) is connected and reporting fresh heartbeats; CoreERP server cannot reach private LAN ${terminal.ipAddress}:${terminal.port} directly (${tcpProbe.errorCode || 'LAN isolated'}).`;
    } else {
      status = 'UNREACHABLE';
      success = false;
      message = `Cannot reach ${terminal.ipAddress}:${terminal.port} directly (${tcpProbe.errorCode || 'timeout'}) and no active Windows LAN Bridge heartbeat was received in the last 5 minutes.`;
    }

    const updatedTel = await this.upsertTerminalTelemetry(actor.companyId, terminal.id, {
      lastTestConnectionAt: checkedAt,
      lastTestConnectionStatus: status,
      lastTestConnectionMessage: message,
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'BIOMETRIC_TEST_CONNECTION',
      entity: 'BiometricTerminal',
      entityId: terminal.id,
      correlationId,
      details: {
        deviceSerialNumber: terminal.deviceSerialNumber,
        ipAddress: terminal.ipAddress,
        port: terminal.port,
        status,
        latencyMs: tcpProbe.latencyMs,
      },
    });

    return {
      success,
      status,
      checkedAt,
      latencyMs: tcpProbe.latencyMs,
      message,
      terminal: this.mapToTerminalItem(terminal, updatedTel),
    };
  }

  /**
   * Queues an immediate bridge poll request for this terminal AND runs server-side reconciliation
   * for any already ingested raw punches on this terminal.
   */
  static async triggerTerminalSync(
    actor: AuthUser,
    terminalId: string,
    options?: Omit<PunchReconciliationOptions, 'terminalId'>,
    correlationId?: string
  ): Promise<TriggerTerminalSyncResponse> {
    // Perform role, allowHistorical, strict date parsing, bounded historical range, and explicit scope
    // validation BEFORE terminal lookup, telemetry mutation, or any database access.
    validateReconciliationRequestPreDb(
      actor.companyId,
      {
        ...options,
        terminalId,
      },
      actor
    );

    const terminal = await prisma.biometricTerminal.findFirst({
      where: {
        id: terminalId,
        companyId: actor.companyId,
      },
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    if (!terminal) {
      const err = new Error('Biometric terminal not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!terminal.isActive || terminal.status === 'DEACTIVATED') {
      const err = new Error('Cannot sync a deactivated biometric terminal.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Fail-closed live historical actor re-verification, timezone resolution, current-day clamping,
    // and clamped-window consistency check BEFORE mutating terminal telemetry or executing reconciliation.
    // Does NOT mint a trusted window token (F2/F6).
    const evaluatedWindow = await evaluateReconciliationWindow(
      actor.companyId,
      {
        ...options,
        terminalId: terminal.id,
      },
      actor
    );

    if (evaluatedWindow.emptyWindow) {
      throw createBiometricSafetyError(
        'Requested reconciliation time window is empty or reversed after enforcing the mandatory current-company-day bounds. No terminal telemetry or attendance state was modified.',
        400,
        'BIOMETRIC_EMPTY_RECONCILIATION_WINDOW'
      );
    }

    // Run target validation, mandatory historical audit authorization, and reconciliation
    // strictly BEFORE persisting syncRequestedAt telemetry or queuing a bridge poll (AUDIT-4).
    const reconciliation = await PunchReconciliationService.reconcilePendingPunches(
      actor.companyId,
      {
        terminalId: terminal.id,
        batchSize: options?.batchSize,
        retryErrors: options?.retryErrors,
        keepUnmappedPending: options?.keepUnmappedPending,
        userEnrollmentId: options?.userEnrollmentId,
        employeeId: options?.employeeId,
        punchId: options?.punchId,
        fromPunchTime: evaluatedWindow.effectiveFrom,
        toPunchTime: evaluatedWindow.effectiveTo,
        allowHistorical: options?.allowHistorical,
      },
      actor,
      correlationId
    );

    const syncRequestedAt = new Date().toISOString();
    const updatedTel = await this.upsertTerminalTelemetry(actor.companyId, terminal.id, {
      syncRequestedAt,
    });

    const bridgeFresh = this.isBridgeFresh(terminal, updatedTel);
    const message = bridgeFresh
      ? `Queued immediate LAN poll for Windows Bridge and reconciled ${reconciliation.totalEvaluated} pending raw punches.`
      : `Reconciled ${reconciliation.totalEvaluated} pending raw punches. Bridge pull is queued for when the Windows LAN Bridge reconnects.`;

    return {
      success: true,
      bridgeSyncQueued: true,
      syncRequestedAt,
      message,
      terminal: this.mapToTerminalItem(terminal, updatedTel),
      reconciliation,
    };
  }

  /**
   * Queues an explicit hardware user synchronization request for the LAN Bridge ONLY.
   * Never triggers attendance punch reconciliation.
   */
  static async triggerTerminalUserSync(
    actor: AuthUser,
    terminalId: string,
    correlationId?: string
  ): Promise<TriggerTerminalUserSyncResponse> {
    const terminal = await prisma.biometricTerminal.findFirst({
      where: {
        id: terminalId,
        companyId: actor.companyId,
      },
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    if (!terminal) {
      const err = new Error('Biometric terminal not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!terminal.isActive || terminal.status === 'DEACTIVATED') {
      const err = new Error('Cannot sync hardware users for a deactivated biometric terminal.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const now = new Date();
    const nowMs = now.getTime();
    const userSyncRequestedAt = now.toISOString();

    const [{ telemetry: updatedTel, result: jobOutcome }, deviceUsersMap] = await Promise.all([
      this.mutateTerminalTelemetry<{ job: BiometricUserSyncJob; deduplicated: boolean }>(
        actor.companyId,
        terminal.id,
        (prev) => {
          const evaluatedExisting = this.evaluateUserSyncJob(prev.userSyncJob, nowMs);
          if (
            evaluatedExisting &&
            (evaluatedExisting.status === 'QUEUED' || evaluatedExisting.status === 'RUNNING')
          ) {
            // Idempotent duplicate prevention: return the active job instead of creating a duplicate
            return {
              next: prev,
              result: { job: evaluatedExisting, deduplicated: true },
              persist: false,
            };
          }

          const newJob: BiometricUserSyncJob = {
            jobId: crypto.randomUUID(),
            status: 'QUEUED',
            requestedAt: userSyncRequestedAt,
            requestedByUserId: actor.userId || actor.id,
            claimedAt: null,
            startedAt: null,
            completedAt: null,
            timeoutAt: new Date(nowMs + USER_SYNC_QUEUE_TIMEOUT_MS).toISOString(),
            attempts: 0,
            maxAttempts: USER_SYNC_DEFAULT_MAX_ATTEMPTS,
            discoveredCount: null,
            syncedCount: null,
            error: null,
            bridgeHost: prev.bridgeHost || null,
          };

          return {
            next: {
              ...prev,
              userSyncRequestedAt,
              lastUserSyncError: null,
              userSyncJob: newJob,
            },
            result: { job: newJob, deduplicated: false },
          };
        }
      ),
      BiometricMappingService.readDeviceUsersMap(actor.companyId),
    ]);

    const deviceUsers: DeviceEnrolledUserItem[] = deviceUsersMap[terminal.id] || [];
    const bridgeFresh = this.isBridgeFresh(terminal, updatedTel);
    const { job, deduplicated } = jobOutcome;

    if (!deduplicated) {
      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.userId || actor.id,
        action: 'BIOMETRIC_DEVICE_USER_SYNC_QUEUED',
        entity: 'BiometricTerminal',
        entityId: terminal.id,
        correlationId,
        details: {
          jobId: job.jobId,
          deviceSerialNumber: terminal.deviceSerialNumber,
          name: terminal.name,
          userSyncRequestedAt: job.requestedAt,
        },
      });
    }

    const message = deduplicated
      ? `A hardware user sync job (${job.status}) is already active for "${terminal.name}". Waiting for the Windows LAN Bridge to complete it.`
      : bridgeFresh
      ? `Queued hardware user sync job for "${terminal.name}". The Windows LAN Bridge will automatically read enrolled users within seconds without running punch reconciliation.`
      : `Queued hardware user sync job for "${terminal.name}". The Windows LAN Bridge is currently offline — start or restore the bridge daemon to process this job automatically.`;

    return {
      success: true,
      bridgeUserSyncQueued: true,
      deduplicated,
      userSyncRequestedAt: job.requestedAt,
      message,
      job,
      terminal: this.mapToTerminalItem(terminal, updatedTel),
      deviceUsers,
    };
  }

  /**
   * Returns real-time user-sync job status, bridge status, physical device status, and synced users for a terminal.
   */
  static async getTerminalUserSyncStatus(
    companyId: string,
    terminalId: string
  ): Promise<TerminalUserSyncStatusResponse> {
    const terminal = await prisma.biometricTerminal.findFirst({
      where: {
        id: terminalId,
        companyId,
      },
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    if (!terminal) {
      const err = new Error('Biometric terminal not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const [telemetryMap, deviceUsersMap] = await Promise.all([
      this.readBridgeTelemetryMap(companyId),
      BiometricMappingService.readDeviceUsersMap(companyId),
    ]);

    const mapped = this.mapToTerminalItem(terminal, telemetryMap[terminal.id]);
    return {
      terminalId: terminal.id,
      bridgeStatus: mapped.bridgeStatus || 'OFFLINE',
      deviceConnectionStatus: mapped.deviceConnectionStatus || 'DISCONNECTED',
      userSyncStatus: mapped.userSyncStatus || 'IDLE',
      job: mapped.userSyncJob || null,
      terminal: mapped,
      deviceUsers: deviceUsersMap[terminal.id] || [],
    };
  }

  /**
   * Lists the persisted hardware user snapshot for a single company-owned terminal.
   */
  static async getTerminalDeviceUsers(
    companyId: string,
    terminalId: string
  ): Promise<DeviceEnrolledUserItem[]> {
    const terminal = await prisma.biometricTerminal.findFirst({
      where: {
        id: terminalId,
        companyId,
      },
      select: { id: true },
    });

    if (!terminal) {
      const err = new Error('Biometric terminal not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const deviceUsersMap = await BiometricMappingService.readDeviceUsersMap(companyId);
    return deviceUsersMap[terminal.id] || [];
  }

  private static probeTcpPort(
    host: string,
    port: number,
    timeoutMs: number
  ): Promise<{ reachable: boolean; latencyMs: number | null; errorCode?: string }> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      let hardTimer: ReturnType<typeof setTimeout> | null = null;
      const socket = net.createConnection({ host, port });

      const finish = (reachable: boolean, errorCode?: string) => {
        if (settled) return;
        settled = true;
        if (hardTimer) {
          clearTimeout(hardTimer);
          hardTimer = null;
        }
        socket.setTimeout(0);
        socket.destroy();
        resolve({
          reachable,
          latencyMs: reachable ? Date.now() - startedAt : null,
          errorCode,
        });
      };

      hardTimer = setTimeout(() => finish(false, 'ETIMEDOUT'), timeoutMs + 50);
      if (typeof hardTimer.unref === 'function') {
        hardTimer.unref();
      }

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false, 'ETIMEDOUT'));
      socket.on('error', (err: NodeJS.ErrnoException) => finish(false, err.code || err.message));
    });
  }

  /**
   * Ingests a batch of raw punch logs from an authenticated biometric terminal.
   * Guarantees strict idempotency and auditability without modifying finalized attendance.
   */
  static async ingestPunches(
    terminal: any,
    payload: BatchPunchSubmissionRequest,
    correlationId?: string
  ): Promise<BatchPunchSubmissionResponse> {
    if (!payload || !Array.isArray(payload.punches)) {
      const err = new Error('Payload must contain a "punches" array of biometric events.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (
      payload.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() &&
      terminal.deviceSerialNumber &&
      payload.deviceSerialNumber.trim() !== terminal.deviceSerialNumber
    ) {
      const mismatchMsg = `Device serial number mismatch during punch ingestion: expected '${terminal.deviceSerialNumber}', received '${payload.deviceSerialNumber.trim()}'.`;
      await this.upsertTerminalTelemetry(terminal.companyId, terminal.id, {
        lastConnectionError: mismatchMsg,
      });
      const err = new Error(mismatchMsg);
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const { punches } = payload;
    if (punches.length > MAX_BATCH_PUNCHES) {
      const err = new Error(
        `Punch batch size (${punches.length}) exceeds the maximum allowed limit of ${MAX_BATCH_PUNCHES} events.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 1. Pre-validate all punch items in batch (schema/timestamp validation)
    const validatedPunches: Array<{
      input: RawPunchEventInput;
      punchTime: Date;
      verifyType: BiometricVerifyType;
      inOutMode: PunchInOutMode;
      idempotencyKey: string;
    }> = [];

    for (let i = 0; i < punches.length; i++) {
      const p = punches[i];
      const enrollmentId = (p.userEnrollmentId || '').toString().trim();
      if (!enrollmentId) {
        const err = new Error(`Punch event at index ${i} is missing required 'userEnrollmentId'.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      if (!p.punchTime) {
        const err = new Error(`Punch event at index ${i} is missing required 'punchTime'.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      const parsedPunchTime = new Date(p.punchTime);
      if (isNaN(parsedPunchTime.getTime())) {
        const err = new Error(
          `Punch event at index ${i} contains an invalid ISO-8601 timestamp ('${p.punchTime}').`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      const verifyType: BiometricVerifyType = p.verifyType && VALID_VERIFY_TYPES.includes(p.verifyType)
        ? p.verifyType
        : 'FINGERPRINT';

      const inOutMode: PunchInOutMode = p.inOutMode && VALID_IN_OUT_MODES.includes(p.inOutMode)
        ? p.inOutMode
        : 'CHECK_IN';

      // Deterministic idempotency key calculation:
      // If terminal provided stable devicePunchId: terminalId:devicePunchId
      // Otherwise: SHA-256 hash of companyId:terminalId:enrollmentId:isoTime:inOutMode
      let idempotencyKey: string;
      if (p.devicePunchId && p.devicePunchId.toString().trim()) {
        idempotencyKey = `${terminal.id}:${p.devicePunchId.toString().trim()}`;
      } else {
        const rawKeySource = `${terminal.companyId}:${terminal.id}:${enrollmentId}:${parsedPunchTime.toISOString()}:${inOutMode}`;
        idempotencyKey = crypto.createHash('sha256').update(rawKeySource).digest('hex').slice(0, 64);
      }

      validatedPunches.push({
        input: { ...p, userEnrollmentId: enrollmentId },
        punchTime: parsedPunchTime,
        verifyType,
        inOutMode,
        idempotencyKey,
      });
    }

    // 2. P0-B Fail-Closed Company Timezone & Mandatory Current-Day Bounds (Lower Cutoff + Upper Bound)
    // Resolves authoritative Company.timezone and NEVER falls back to UTC.
    const companyTimezone = await resolveStrictCompanyTimezone(terminal.companyId, prisma);
    const ingestionNow = new Date();
    const ingestionCutoffUtc = computeCurrentLocalDayStartUtc(companyTimezone, ingestionNow);
    const ingestionUpperBoundUtc = computeCurrentDayUpperBoundUtc(companyTimezone, ingestionNow);
    const effectiveCutoffIso = ingestionCutoffUtc.toISOString();
    const effectiveUpperBoundIso = ingestionUpperBoundUtc.toISOString();

    if (punches.length === 0) {
      return {
        success: true,
        totalReceived: 0,
        inserted: 0,
        duplicates: 0,
        rejectedHistorical: 0,
        rejectedFuture: 0,
        unmappedEmployees: 0,
        effectiveCutoffIso,
        effectiveUpperBoundIso,
        companyTimezone,
        terminalId: terminal.id,
        terminalName: terminal.name,
      };
    }

    // 3. Enforce BOTH current-day lower cutoff AND current-day upper bound BEFORE queue persistence:
    // - Punches strictly older than current company-local day start are rejected as historical.
    // - Punches strictly later than min(local day end, serverNow + clockSkew) are rejected as future-dated.
    const eligiblePunches: typeof validatedPunches = [];
    let rejectedHistoricalCount = 0;
    let rejectedFutureCount = 0;

    for (const vp of validatedPunches) {
      const punchMs = vp.punchTime.getTime();
      if (punchMs < ingestionCutoffUtc.getTime()) {
        rejectedHistoricalCount++;
      } else if (punchMs > ingestionUpperBoundUtc.getTime()) {
        rejectedFutureCount++;
      } else {
        eligiblePunches.push(vp);
      }
    }

    let insertedCount = 0;
    let duplicateCount = 0;
    let unmappedCount = 0;
    const punchesToCreate: any[] = [];

    if (eligiblePunches.length > 0) {
      // 4. Batch query existing idempotency keys to detect duplicates for eligible current-day punches
      const incomingKeys = eligiblePunches.map((vp) => vp.idempotencyKey);
      const existingLogs = await prisma.rawPunchLog.findMany({
        where: {
          companyId: terminal.companyId,
          idempotencyKey: { in: incomingKeys },
        },
        select: { idempotencyKey: true },
      });
      const existingKeySet = new Set(existingLogs.map((l) => l.idempotencyKey));

      // 5. Batch resolve active employees via terminal-scoped biometric mappings (+ legacy fallback)
      const enrollmentIds = [...new Set(eligiblePunches.map((vp) => vp.input.userEnrollmentId))];
      const employeeMap = await BiometricMappingService.resolveBatchForTerminal(
        terminal.companyId,
        terminal.id,
        enrollmentIds
      );

      // 6. Prepare eligible current-day PENDING rows (never automatically reconciling or mutating Attendance)
      for (const vp of eligiblePunches) {
        if (existingKeySet.has(vp.idempotencyKey)) {
          duplicateCount++;
          continue;
        }

        const matchedEmpId = employeeMap.get(vp.input.userEnrollmentId) || null;
        if (!matchedEmpId) {
          unmappedCount++;
        }

        punchesToCreate.push({
          companyId: terminal.companyId,
          terminalId: terminal.id,
          devicePunchId: vp.input.devicePunchId ? vp.input.devicePunchId.toString().trim() : null,
          userEnrollmentId: vp.input.userEnrollmentId,
          punchTime: vp.punchTime,
          verifyType: vp.verifyType,
          inOutMode: vp.inOutMode,
          syncStatus: 'PENDING',
          rawPayload: JSON.stringify(vp.input),
          idempotencyKey: vp.idempotencyKey,
          matchedEmployeeId: matchedEmpId,
        });

        // Mark key in set to handle duplicate items within the SAME batch
        existingKeySet.add(vp.idempotencyKey);
        insertedCount++;
      }
    }

    if (punchesToCreate.length > 0) {
      // Execute batch insert and terminal update in an atomic transaction
      // skipDuplicates handles concurrent insert races safely under PostgreSQL
      let actualInserted = punchesToCreate.length;

      const txResult = await prisma.$transaction(async (tx) => {
        const createResult = await tx.rawPunchLog.createMany({
          data: punchesToCreate,
          skipDuplicates: true,
        });

        await tx.biometricTerminal.update({
          where: { id: terminal.id },
          data: {
            lastSyncAt: new Date(),
            lastHeartbeatAt: new Date(),
            status: 'ONLINE',
          },
        });

        return createResult;
      });

      if (txResult && typeof (txResult as any).count === 'number') {
        actualInserted = (txResult as any).count;
        const concurrentConflictDuplicates = punchesToCreate.length - actualInserted;
        insertedCount = actualInserted;
        duplicateCount += concurrentConflictDuplicates;
      }
    } else {
      // Refresh terminal heartbeat status without persisting historical punches
      await prisma.biometricTerminal.update({
        where: { id: terminal.id },
        data: {
          lastHeartbeatAt: new Date(),
          status: 'ONLINE',
        },
      });
    }

    const nowIso = new Date().toISOString();
    await this.upsertTerminalTelemetry(terminal.companyId, terminal.id, {
      bridgeConnected: true,
      bridgeHost: payload.bridgeHost?.trim() || undefined,
      bridgeVersion: payload.bridgeVersion?.trim() || undefined,
      lastBridgeHeartbeatAt: nowIso,
      lastSyncAttemptAt: nowIso,
      lastProcessedPunchCount: insertedCount,
      lastConnectionError: null,
      syncRequestedAt: null,
    });

    await AuditService.log({
      companyId: terminal.companyId,
      userId: terminal.registeredByUserId,
      action: 'BIOMETRIC_PUNCH_INGEST',
      entity: 'BiometricTerminal',
      entityId: terminal.id,
      correlationId,
      details: {
        totalReceived: punches.length,
        inserted: insertedCount,
        duplicates: duplicateCount,
        rejectedHistorical: rejectedHistoricalCount,
        rejectedFuture: rejectedFutureCount,
        unmappedEmployees: unmappedCount,
        companyTimezone,
        effectiveCutoffIso,
        effectiveUpperBoundIso,
      },
    });

    return {
      success: true,
      totalReceived: punches.length,
      inserted: insertedCount,
      duplicates: duplicateCount,
      rejectedHistorical: rejectedHistoricalCount,
      rejectedFuture: rejectedFutureCount,
      unmappedEmployees: unmappedCount,
      effectiveCutoffIso,
      effectiveUpperBoundIso,
      companyTimezone,
      terminalId: terminal.id,
      terminalName: terminal.name,
    };
  }
}
