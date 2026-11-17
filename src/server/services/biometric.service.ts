import crypto from 'crypto';
import net from 'net';
import { prisma } from '../db/client.js';
import {
  AuthUser,
  BiometricTerminalItem,
  BiometricConnectionTestStatus,
  CreateBiometricTerminalRequest,
  CreateBiometricTerminalResponse,
  BatchPunchSubmissionRequest,
  BatchPunchSubmissionResponse,
  DeviceEnrolledUserItem,
  SyncDeviceUsersRequest,
  SyncDeviceUsersResponse,
  TerminalHeartbeatRequest,
  TerminalHeartbeatResponse,
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

const VALID_VERIFY_TYPES: BiometricVerifyType[] = ['FINGERPRINT', 'CARD', 'PASSWORD', 'FACE'];
const VALID_IN_OUT_MODES: PunchInOutMode[] = ['CHECK_IN', 'CHECK_OUT', 'BREAK_OUT', 'BREAK_IN'];
const MAX_BATCH_PUNCHES = 500;
const BRIDGE_TELEMETRY_SETTING_KEY = 'BIOMETRIC_BRIDGE_TELEMETRY_V1';
const HEARTBEAT_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

export interface TerminalBridgeTelemetry {
  bridgeConnected?: boolean;
  bridgeHost?: string | null;
  bridgeVersion?: string | null;
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
}

export class BiometricService {
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
   * Maps a Prisma biometric terminal record + bridge telemetry to a client-safe BiometricTerminalItem
   */
  static mapToTerminalItem(t: any, telemetry?: TerminalBridgeTelemetry): BiometricTerminalItem {
    const bridgeConnected = this.isBridgeFresh(t, telemetry);

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
      lastUserSyncError: telemetry?.lastUserSyncError ?? null,
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
    const isDeviceOnline = payload.bridgeConnected !== false && !hasConnectionError;
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
      bridgeConnected: payload.bridgeConnected !== false,
      lastBridgeHeartbeatAt: now.toISOString(),
      lastConnectionError: hasConnectionError ? redactSensitiveText(payload.lastConnectionError!.trim()) : null,
    };

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

    // Check if an admin requested an out-of-band bridge sync after the last sync attempt
    let syncRequested = false;
    if (updatedTelemetry.syncRequestedAt) {
      const reqMs = new Date(updatedTelemetry.syncRequestedAt).getTime();
      const attemptMs = updatedTelemetry.lastSyncAttemptAt
        ? new Date(updatedTelemetry.lastSyncAttemptAt).getTime()
        : 0;
      syncRequested = !Number.isNaN(reqMs) && reqMs > attemptMs;
    }

    let userSyncRequested = false;
    if (updatedTelemetry.userSyncRequestedAt) {
      const reqMs = new Date(updatedTelemetry.userSyncRequestedAt).getTime();
      const attemptMs = updatedTelemetry.lastUserSyncAttemptAt
        ? new Date(updatedTelemetry.lastUserSyncAttemptAt).getTime()
        : 0;
      userSyncRequested = !Number.isNaN(reqMs) && reqMs > attemptMs;
    }

    return {
      success: true,
      serverTime: now.toISOString(),
      terminalId: terminal.id,
      terminalName: terminal.name,
      status: derivedStatus,
      syncRequested,
      syncRequestedAt: syncRequested ? updatedTelemetry.syncRequestedAt || null : null,
      userSyncRequested,
      userSyncRequestedAt: userSyncRequested ? updatedTelemetry.userSyncRequestedAt || null : null,
    };
  }

  /**
   * Dedicated authenticated hardware user synchronization ingestion endpoint (POST /api/biometric/users).
   * Persists verified hardware users idempotently, enforces serial & company ownership, and updates telemetry.
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
    if (typeof prisma.biometricTerminal?.update === 'function') {
      await prisma.biometricTerminal.update({
        where: { id: terminal.id },
        data: {
          lastHeartbeatAt: now,
          status: 'ONLINE',
        },
      });
    }

    await this.upsertTerminalTelemetry(terminal.companyId, terminal.id, {
      bridgeConnected: true,
      bridgeHost: payload.bridgeHost?.trim() || undefined,
      bridgeVersion: payload.bridgeVersion?.trim() || undefined,
      lastBridgeHeartbeatAt: now.toISOString(),
      lastUserSyncAt: snap.syncedAt,
      lastUserSyncAttemptAt: attemptIso,
      lastUserSyncError: null,
      discoveredUserCount: discoveredCount,
      syncedUserCount: snap.syncedCount,
      userSyncRequestedAt: null,
    });

    await AuditService.log({
      companyId: terminal.companyId,
      userId: terminal.registeredByUserId,
      action: 'BIOMETRIC_DEVICE_USERS_SYNC',
      entity: 'BiometricTerminal',
      entityId: terminal.id,
      correlationId,
      details: {
        deviceSerialNumber: terminal.deviceSerialNumber,
        discoveredCount,
        syncedCount: snap.syncedCount,
      },
    });

    return {
      success: true,
      terminalId: terminal.id,
      terminalName: terminal.name,
      discoveredCount,
      syncedCount: snap.syncedCount,
      syncedAt: snap.syncedAt,
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

    const syncRequestedAt = new Date().toISOString();
    const updatedTel = await this.upsertTerminalTelemetry(actor.companyId, terminal.id, {
      syncRequestedAt,
    });

    const reconciliation = await PunchReconciliationService.reconcilePendingPunches(
      actor.companyId,
      {
        terminalId: terminal.id,
        batchSize: options?.batchSize,
        retryErrors: options?.retryErrors,
        userEnrollmentId: options?.userEnrollmentId,
        employeeId: options?.employeeId,
        punchId: options?.punchId,
      },
      actor.userId || actor.id,
      correlationId
    );

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

    const userSyncRequestedAt = new Date().toISOString();
    const [updatedTel, deviceUsersMap] = await Promise.all([
      this.upsertTerminalTelemetry(actor.companyId, terminal.id, {
        userSyncRequestedAt,
      }),
      BiometricMappingService.readDeviceUsersMap(actor.companyId),
    ]);

    const deviceUsers: DeviceEnrolledUserItem[] = deviceUsersMap[terminal.id] || [];
    const bridgeFresh = this.isBridgeFresh(terminal, updatedTel);

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'BIOMETRIC_DEVICE_USER_SYNC_QUEUED',
      entity: 'BiometricTerminal',
      entityId: terminal.id,
      correlationId,
      details: {
        deviceSerialNumber: terminal.deviceSerialNumber,
        name: terminal.name,
        userSyncRequestedAt,
      },
    });

    const message = bridgeFresh
      ? `Queued hardware user sync for "${terminal.name}". The LAN Bridge will read enrolled users on its next heartbeat without running punch reconciliation.`
      : `Queued hardware user sync for "${terminal.name}". Enrolled users will be read when the Windows LAN Bridge reconnects or completes its next cycle.`;

    return {
      success: true,
      bridgeUserSyncQueued: true,
      userSyncRequestedAt,
      message,
      terminal: this.mapToTerminalItem(terminal, updatedTel),
      deviceUsers,
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

    if (punches.length === 0) {
      return {
        success: true,
        totalReceived: 0,
        inserted: 0,
        duplicates: 0,
        unmappedEmployees: 0,
        terminalId: terminal.id,
        terminalName: terminal.name,
      };
    }

    // 1. Pre-validate all punch items in batch
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

    // 2. Batch query existing idempotency keys to detect duplicates
    const incomingKeys = validatedPunches.map((vp) => vp.idempotencyKey);
    const existingLogs = await prisma.rawPunchLog.findMany({
      where: {
        companyId: terminal.companyId,
        idempotencyKey: { in: incomingKeys },
      },
      select: { idempotencyKey: true },
    });
    const existingKeySet = new Set(existingLogs.map((l) => l.idempotencyKey));

    // 3. Batch resolve active employees via terminal-scoped biometric mappings (+ legacy fallback)
    const enrollmentIds = [...new Set(validatedPunches.map((vp) => vp.input.userEnrollmentId))];
    const employeeMap = await BiometricMappingService.resolveBatchForTerminal(
      terminal.companyId,
      terminal.id,
      enrollmentIds
    );

    // 4. Ingest new punches
    let insertedCount = 0;
    let duplicateCount = 0;
    let unmappedCount = 0;

    const punchesToCreate: any[] = [];

    for (const vp of validatedPunches) {
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
      // Still refresh terminal status
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
      lastProcessedPunchCount: punches.length,
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
        unmappedEmployees: unmappedCount,
      },
    });

    return {
      success: true,
      totalReceived: punches.length,
      inserted: insertedCount,
      duplicates: duplicateCount,
      unmappedEmployees: unmappedCount,
      terminalId: terminal.id,
      terminalName: terminal.name,
    };
  }
}
