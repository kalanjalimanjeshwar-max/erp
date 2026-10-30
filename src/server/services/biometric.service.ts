import crypto from 'crypto';
import { prisma } from '../db/client.js';
import {
  AuthUser,
  BiometricTerminalItem,
  CreateBiometricTerminalRequest,
  CreateBiometricTerminalResponse,
  BatchPunchSubmissionRequest,
  BatchPunchSubmissionResponse,
  TerminalHeartbeatRequest,
  TerminalHeartbeatResponse,
  BiometricTerminalStatus,
  BiometricVerifyType,
  PunchInOutMode,
  RawPunchEventInput,
} from '../../shared/types.js';
import { AuditService } from './audit.service.js';

const VALID_VERIFY_TYPES: BiometricVerifyType[] = ['FINGERPRINT', 'CARD', 'PASSWORD', 'FACE'];
const VALID_IN_OUT_MODES: PunchInOutMode[] = ['CHECK_IN', 'CHECK_OUT', 'BREAK_OUT', 'BREAK_IN'];
const MAX_BATCH_PUNCHES = 500;

export class BiometricService {
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

    const terminals = await prisma.biometricTerminal.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      include: {
        registeredByUser: {
          select: { fullName: true },
        },
      },
    });

    return terminals.map((t) => this.mapToTerminalItem(t));
  }

  /**
   * Derives effective terminal ONLINE/OFFLINE status using heartbeat freshness.
   * Documented fixed freshness window of 5 minutes (300,000 ms).
   */
  static getEffectiveStatus(terminal: {
    status: string;
    isActive: boolean;
    lastHeartbeatAt: Date | null;
  }): BiometricTerminalStatus {
    const HEARTBEAT_FRESHNESS_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
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
   * Maps a Prisma biometric terminal record to a client-safe BiometricTerminalItem
   */
  static mapToTerminalItem(t: any): BiometricTerminalItem {
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
        ipAddress: input.ipAddress?.trim() || null,
        port: input.port && input.port > 0 ? input.port : 4370,
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

    const terminalItem: BiometricTerminalItem = {
      id: terminal.id,
      companyId: terminal.companyId,
      deviceSerialNumber: terminal.deviceSerialNumber,
      name: terminal.name,
      terminalModel: terminal.terminalModel,
      ipAddress: terminal.ipAddress,
      port: terminal.port,
      location: terminal.location,
      apiKeyPrefix: terminal.apiKeyPrefix,
      status: terminal.status as BiometricTerminalStatus,
      lastHeartbeatAt: terminal.lastHeartbeatAt ? terminal.lastHeartbeatAt.toISOString() : null,
      lastSyncAt: terminal.lastSyncAt ? terminal.lastSyncAt.toISOString() : null,
      firmwareVersion: terminal.firmwareVersion,
      registeredByUserId: terminal.registeredByUserId,
      registeredByUserName: terminal.registeredByUser?.fullName || null,
      isActive: terminal.isActive,
      notes: terminal.notes,
      createdAt: terminal.createdAt.toISOString(),
      updatedAt: terminal.updatedAt.toISOString(),
    };

    return {
      terminal: terminalItem,
      apiKey: plainApiKey,
    };
  }

  /**
   * Processes a keepalive heartbeat from an authenticated physical terminal or edge daemon
   */
  static async recordHeartbeat(
    terminal: any,
    payload: TerminalHeartbeatRequest,
    correlationId?: string
  ): Promise<TerminalHeartbeatResponse> {
    const dataToUpdate: {
      lastHeartbeatAt: Date;
      status: BiometricTerminalStatus;
      firmwareVersion?: string;
    } = {
      lastHeartbeatAt: new Date(),
      status: 'ONLINE',
    };

    if (payload.firmwareVersion && payload.firmwareVersion.trim()) {
      dataToUpdate.firmwareVersion = payload.firmwareVersion.trim();
    }

    await prisma.biometricTerminal.update({
      where: { id: terminal.id },
      data: dataToUpdate,
    });

    return {
      success: true,
      serverTime: new Date().toISOString(),
      terminalId: terminal.id,
      terminalName: terminal.name,
      status: 'ONLINE',
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

    // 3. Batch resolve active employees by biometricDeviceId
    const enrollmentIds = [...new Set(validatedPunches.map((vp) => vp.input.userEnrollmentId))];
    const employees = await prisma.employee.findMany({
      where: {
        companyId: terminal.companyId,
        biometricDeviceId: { in: enrollmentIds },
      },
      select: { id: true, biometricDeviceId: true },
    });
    const employeeMap = new Map<string, string>();
    for (const emp of employees) {
      if (emp.biometricDeviceId) {
        employeeMap.set(emp.biometricDeviceId, emp.id);
      }
    }

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
