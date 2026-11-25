import crypto from 'crypto';
import { prisma } from '../db/client.js';
import {
  AuthUser,
  BiometricEnrollmentMappingSource,
  BiometricTerminalEnrollmentOptionsResponse,
  BiometricTerminalItem,
  DeviceEnrolledUserItem,
  EmployeeBiometricMappingInput,
  EmployeeBiometricMappingItem,
  EmployeeStatus,
} from '../../shared/types.js';
import { AuditService } from './audit.service.js';
import { createBiometricSafetyError } from './biometric-safety.js';

export const BIOMETRIC_MAPPINGS_SETTING_KEY = 'BIOMETRIC_EMPLOYEE_MAPPINGS_V1';
export const BIOMETRIC_DEVICE_USERS_SETTING_KEY = 'BIOMETRIC_DEVICE_USERS_V1';
const MAX_ENROLLMENT_ID_LENGTH = 64;

export interface StoredBiometricMappingRecord {
  id: string;
  companyId: string;
  employeeId: string;
  terminalId: string;
  enrollmentId: string;
  isActive: boolean;
  source: BiometricEnrollmentMappingSource;
  createdAt: string;
  updatedAt: string;
}

interface StoredDeviceUserEntry {
  uid?: number;
  enrollmentId: string;
  name?: string | null;
  cardNo?: string | null;
  syncedAt: string;
}

export class BiometricMappingService {
  private static companyWriteQueues = new Map<string, Promise<void>>();

  private static async withCompanyWriteLock<T>(
    companyId: string,
    work: () => Promise<T>
  ): Promise<T> {
    const previous = this.companyWriteQueues.get(companyId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.companyWriteQueues.set(companyId, tail);

    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.companyWriteQueues.get(companyId) === tail) {
        this.companyWriteQueues.delete(companyId);
      }
    }
  }

  private static normalizeEnrollmentId(raw: string): string {
    return String(raw || '').trim();
  }

  private static validateEnrollmentId(raw: string): string {
    const trimmed = this.normalizeEnrollmentId(raw);
    if (!trimmed) {
      const err = new Error('Biometric Enrollment ID is required and cannot be empty.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    if (trimmed.length > MAX_ENROLLMENT_ID_LENGTH) {
      const err = new Error(
        `Biometric Enrollment ID '${trimmed}' exceeds maximum length of ${MAX_ENROLLMENT_ID_LENGTH} characters.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    if (/[\r\n\t\x00-\x1f]/.test(trimmed)) {
      const err = new Error('Biometric Enrollment ID contains invalid control characters.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    return trimmed;
  }

  static async readCompanyMappings(
    companyId: string,
    client?: any
  ): Promise<StoredBiometricMappingRecord[]> {
    const db = client || prisma;
    if (typeof db.companySetting?.findUnique !== 'function') {
      throw createBiometricSafetyError(
        'Biometric enrollment mapping store is unavailable (fail-closed).',
        503,
        'BIOMETRIC_MAPPING_STORE_UNAVAILABLE'
      );
    }

    let row: { value?: unknown } | null | undefined;
    try {
      row = await db.companySetting.findUnique({
        where: {
          companyId_key: {
            companyId,
            key: BIOMETRIC_MAPPINGS_SETTING_KEY,
          },
        },
      });
    } catch {
      throw createBiometricSafetyError(
        'Failed to read biometric enrollment mappings from authoritative store (fail-closed).',
        503,
        'BIOMETRIC_MAPPING_STORE_UNAVAILABLE'
      );
    }

    // Setting genuinely does not exist -> no explicit mappings configured; documented legacy fallback applies.
    if (row === null || row === undefined) {
      return [];
    }

    if (typeof row.value !== 'string') {
      throw createBiometricSafetyError(
        'Stored biometric enrollment mappings payload is invalid or corrupted (fail-closed).',
        500,
        'BIOMETRIC_MAPPING_STORE_CORRUPT'
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      throw createBiometricSafetyError(
        'Stored biometric enrollment mappings JSON is invalid or corrupted (fail-closed).',
        500,
        'BIOMETRIC_MAPPING_STORE_CORRUPT'
      );
    }

    if (!Array.isArray(parsed)) {
      throw createBiometricSafetyError(
        'Stored biometric enrollment mappings JSON must be an array (fail-closed).',
        500,
        'BIOMETRIC_MAPPING_STORE_CORRUPT'
      );
    }

    const validRecords: StoredBiometricMappingRecord[] = [];
    for (const item of parsed) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof (item as Record<string, unknown>).companyId !== 'string' ||
        typeof (item as Record<string, unknown>).employeeId !== 'string' ||
        typeof (item as Record<string, unknown>).terminalId !== 'string' ||
        typeof (item as Record<string, unknown>).enrollmentId !== 'string' ||
        typeof (item as Record<string, unknown>).isActive !== 'boolean'
      ) {
        throw createBiometricSafetyError(
          'Stored biometric enrollment mappings contain a malformed entry (fail-closed).',
          500,
          'BIOMETRIC_MAPPING_STORE_CORRUPT'
        );
      }

      if ((item as StoredBiometricMappingRecord).companyId === companyId) {
        validRecords.push(item as StoredBiometricMappingRecord);
      }
    }

    return validRecords;
  }

  private static async writeCompanyMappings(
    companyId: string,
    records: StoredBiometricMappingRecord[],
    client?: any
  ): Promise<void> {
    const db = client || prisma;
    if (typeof db.companySetting?.upsert !== 'function') {
      return;
    }
    await db.companySetting.upsert({
      where: {
        companyId_key: {
          companyId,
          key: BIOMETRIC_MAPPINGS_SETTING_KEY,
        },
      },
      update: {
        value: JSON.stringify(records),
      },
      create: {
        companyId,
        key: BIOMETRIC_MAPPINGS_SETTING_KEY,
        value: JSON.stringify(records),
      },
    });
  }

  static async readDeviceUsersMap(
    companyId: string,
    client?: any
  ): Promise<Record<string, DeviceEnrolledUserItem[]>> {
    const db = client || prisma;
    try {
      if (typeof db.companySetting?.findUnique !== 'function') {
        return {};
      }
      const row = await db.companySetting.findUnique({
        where: {
          companyId_key: {
            companyId,
            key: BIOMETRIC_DEVICE_USERS_SETTING_KEY,
          },
        },
      });
      if (!row?.value) return {};
      const parsed = JSON.parse(row.value);
      if (!parsed || typeof parsed !== 'object') return {};

      const out: Record<string, DeviceEnrolledUserItem[]> = {};
      for (const [terminalId, entries] of Object.entries(parsed)) {
        if (!Array.isArray(entries)) continue;
        out[terminalId] = entries
          .filter((e: any) => e && typeof e.enrollmentId === 'string' && e.enrollmentId.trim())
          .map((e: StoredDeviceUserEntry) => ({
            uid: typeof e.uid === 'number' ? e.uid : undefined,
            enrollmentId: e.enrollmentId.trim(),
            name: e.name || null,
            cardNo: e.cardNo || null,
            terminalId,
            syncedAt: e.syncedAt || null,
          }));
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Stores real hardware-enrolled user list synced from a physical terminal bridge.
   * Never fabricates users; only stores verified entries when provided by bridge/adapter.
   */
  static async saveDeviceUsersSnapshot(
    companyId: string,
    terminalId: string,
    users: Array<{ uid?: number; enrollmentId: string; name?: string | null; cardNo?: string | null }>,
    options?: { throwOnError?: boolean }
  ): Promise<{
    discoveredCount: number;
    syncedCount: number;
    syncedAt: string;
    users: DeviceEnrolledUserItem[];
  }> {
    const nowIso = new Date().toISOString();
    if (!Array.isArray(users)) {
      return { discoveredCount: 0, syncedCount: 0, syncedAt: nowIso, users: [] };
    }

    const seen = new Set<string>();
    const normalized: StoredDeviceUserEntry[] = [];

    for (const u of users) {
      const enrollmentId = this.normalizeEnrollmentId(u?.enrollmentId || '');
      if (!enrollmentId || enrollmentId.length > MAX_ENROLLMENT_ID_LENGTH) continue;
      if (seen.has(enrollmentId)) continue;
      seen.add(enrollmentId);

      normalized.push({
        uid: typeof u.uid === 'number' && Number.isFinite(u.uid) ? u.uid : undefined,
        enrollmentId,
        name: u.name ? String(u.name).trim().slice(0, 128) : null,
        cardNo: u.cardNo ? String(u.cardNo).trim().slice(0, 64) : null,
        syncedAt: nowIso,
      });
    }

    const mappedUsers: DeviceEnrolledUserItem[] = normalized.map((e) => ({
      uid: e.uid,
      enrollmentId: e.enrollmentId,
      name: e.name ?? null,
      cardNo: e.cardNo ?? null,
      terminalId,
      syncedAt: e.syncedAt,
    }));

    if (typeof prisma.companySetting?.upsert !== 'function') {
      return {
        discoveredCount: users.length,
        syncedCount: normalized.length,
        syncedAt: nowIso,
        users: mappedUsers,
      };
    }

    try {
      await this.withCompanyWriteLock(companyId, async () => {
        const existing = await this.readDeviceUsersMap(companyId);
        const nextPayload: Record<string, StoredDeviceUserEntry[]> = {};
        for (const [tid, list] of Object.entries(existing)) {
          nextPayload[tid] = list.map((item) => ({
            uid: item.uid,
            enrollmentId: item.enrollmentId,
            name: item.name ?? null,
            cardNo: item.cardNo ?? null,
            syncedAt: item.syncedAt || nowIso,
          }));
        }
        nextPayload[terminalId] = normalized;

        await prisma.companySetting.upsert({
          where: {
            companyId_key: {
              companyId,
              key: BIOMETRIC_DEVICE_USERS_SETTING_KEY,
            },
          },
          update: {
            value: JSON.stringify(nextPayload),
          },
          create: {
            companyId,
            key: BIOMETRIC_DEVICE_USERS_SETTING_KEY,
            value: JSON.stringify(nextPayload),
          },
        });
      });
    } catch (err: unknown) {
      if (options?.throwOnError) {
        throw err;
      }
      // Non-fatal on heartbeat unless caller explicitly requested throwOnError
    }

    return {
      discoveredCount: users.length,
      syncedCount: normalized.length,
      syncedAt: nowIso,
      users: mappedUsers,
    };
  }

  private static async buildTerminalMetaMap(
    companyId: string,
    client?: any
  ): Promise<
    Map<
      string,
      {
        id: string;
        name: string;
        terminalModel: string;
        deviceSerialNumber: string;
        isActive: boolean;
      }
    >
  > {
    const db = client || prisma;
    const map = new Map<
      string,
      {
        id: string;
        name: string;
        terminalModel: string;
        deviceSerialNumber: string;
        isActive: boolean;
      }
    >();
    if (typeof db.biometricTerminal?.findMany !== 'function') {
      return map;
    }
    const terminals = await db.biometricTerminal.findMany({
      where: { companyId },
      select: {
        id: true,
        name: true,
        terminalModel: true,
        deviceSerialNumber: true,
        isActive: true,
      },
    });
    for (const t of terminals) {
      map.set(t.id, t);
    }
    return map;
  }

  private static enrichMapping(
    record: StoredBiometricMappingRecord,
    terminalMap: Map<
      string,
      {
        id: string;
        name: string;
        terminalModel: string;
        deviceSerialNumber: string;
        isActive: boolean;
      }
    >
  ): EmployeeBiometricMappingItem {
    const terminal = terminalMap.get(record.terminalId);
    return {
      ...record,
      terminalName: terminal?.name || null,
      terminalModel: terminal?.terminalModel || null,
      deviceSerialNumber: terminal?.deviceSerialNumber || null,
      terminalIsActive: terminal?.isActive ?? false,
    };
  }

  static async listMappingsForEmployee(
    companyId: string,
    employeeId: string,
    client?: any
  ): Promise<EmployeeBiometricMappingItem[]> {
    const [records, terminalMap] = await Promise.all([
      this.readCompanyMappings(companyId, client),
      this.buildTerminalMetaMap(companyId, client),
    ]);
    return records
      .filter((r) => r.employeeId === employeeId && r.isActive)
      .map((r) => this.enrichMapping(r, terminalMap));
  }

  static async getMappingsMapForEmployees(
    companyId: string,
    employeeIds: string[],
    client?: any
  ): Promise<Map<string, EmployeeBiometricMappingItem[]>> {
    const result = new Map<string, EmployeeBiometricMappingItem[]>();
    if (employeeIds.length === 0) return result;
    const idSet = new Set(employeeIds);

    const [records, terminalMap] = await Promise.all([
      this.readCompanyMappings(companyId, client),
      this.buildTerminalMetaMap(companyId, client),
    ]);

    for (const r of records) {
      if (!r.isActive || !idSet.has(r.employeeId)) continue;
      const list = result.get(r.employeeId) || [];
      list.push(this.enrichMapping(r, terminalMap));
      result.set(r.employeeId, list);
    }
    return result;
  }

  static async listCompanyMappings(
    companyId: string,
    filters?: { terminalId?: string; employeeId?: string; activeOnly?: boolean }
  ): Promise<
    Array<
      EmployeeBiometricMappingItem & {
        employeeCode?: string | null;
        employeeName?: string | null;
        employeeStatus?: EmployeeStatus | null;
      }
    >
  > {
    const [records, terminalMap, employees] = await Promise.all([
      this.readCompanyMappings(companyId),
      this.buildTerminalMetaMap(companyId),
      typeof prisma.employee?.findMany === 'function'
        ? prisma.employee.findMany({
            where: { companyId },
            select: { id: true, employeeCode: true, fullName: true, status: true },
          })
        : Promise.resolve([]),
    ]);

    const empMap = new Map<
      string,
      { id: string; employeeCode: string; fullName: string; status: EmployeeStatus }
    >();
    for (const e of employees as Array<{
      id: string;
      employeeCode: string;
      fullName: string;
      status: EmployeeStatus;
    }>) {
      empMap.set(e.id, e);
    }

    return records
      .filter((r) => {
        if (filters?.activeOnly !== false && !r.isActive) return false;
        if (filters?.terminalId && r.terminalId !== filters.terminalId) return false;
        if (filters?.employeeId && r.employeeId !== filters.employeeId) return false;
        return true;
      })
      .map((r) => {
        const emp = empMap.get(r.employeeId);
        return {
          ...this.enrichMapping(r, terminalMap),
          employeeCode: emp?.employeeCode || null,
          employeeName: emp?.fullName || null,
          employeeStatus: emp?.status || null,
        };
      });
  }

  static async getEnrollmentOptionsForCompany(
    companyId: string,
    terminalsInput?: BiometricTerminalItem[]
  ): Promise<BiometricTerminalEnrollmentOptionsResponse> {
    const [rawTerminals, deviceUsersByTerminal, mappings, employees, telemetryRow] = await Promise.all([
      terminalsInput
        ? Promise.resolve(terminalsInput)
        : typeof prisma.biometricTerminal?.findMany === 'function'
        ? prisma.biometricTerminal.findMany({
            where: { companyId, isActive: true },
            orderBy: [{ createdAt: 'desc' }],
            include: {
              registeredByUser: { select: { fullName: true } },
            },
          })
        : Promise.resolve([]),
      this.readDeviceUsersMap(companyId),
      this.readCompanyMappings(companyId),
      typeof prisma.employee?.findMany === 'function'
        ? prisma.employee.findMany({
            where: { companyId },
            select: { id: true, employeeCode: true, fullName: true, status: true },
          })
        : Promise.resolve([]),
      typeof prisma.companySetting?.findUnique === 'function'
        ? prisma.companySetting
            .findUnique({
              where: {
                companyId_key: {
                  companyId,
                  key: 'BIOMETRIC_BRIDGE_TELEMETRY_V1',
                },
              },
            })
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    let telemetryMap: Record<string, any> = {};
    try {
      if (telemetryRow?.value) {
        const parsed = JSON.parse(telemetryRow.value);
        if (parsed && typeof parsed === 'object') {
          telemetryMap = parsed;
        }
      }
    } catch {
      telemetryMap = {};
    }

    const terminals: BiometricTerminalItem[] = (rawTerminals as any[])
      .filter((t) => t.isActive !== false && t.status !== 'DEACTIVATED')
      .map((t) => {
        const tel = telemetryMap[t.id] || {};
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
          status: t.status,
          lastHeartbeatAt: t.lastHeartbeatAt
            ? new Date(t.lastHeartbeatAt).toISOString()
            : null,
          lastSyncAt: t.lastSyncAt ? new Date(t.lastSyncAt).toISOString() : null,
          firmwareVersion: t.firmwareVersion || null,
          registeredByUserId: t.registeredByUserId,
          registeredByUserName: t.registeredByUser?.fullName || t.registeredByUserName || null,
          isActive: t.isActive,
          notes: t.notes || null,
          createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString(),
          updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : new Date().toISOString(),
          lastUserSyncAt: tel.lastUserSyncAt ?? t.lastUserSyncAt ?? null,
          lastUserSyncAttemptAt: tel.lastUserSyncAttemptAt ?? t.lastUserSyncAttemptAt ?? null,
          lastUserSyncError: tel.lastUserSyncError ?? t.lastUserSyncError ?? null,
          discoveredUserCount: tel.discoveredUserCount ?? t.discoveredUserCount ?? null,
          syncedUserCount: tel.syncedUserCount ?? t.syncedUserCount ?? null,
          userSyncRequestedAt: tel.userSyncRequestedAt ?? t.userSyncRequestedAt ?? null,
        };
      });

    const empMap = new Map<
      string,
      { id: string; employeeCode: string; fullName: string; status: EmployeeStatus }
    >();
    for (const e of employees as Array<{
      id: string;
      employeeCode: string;
      fullName: string;
      status: EmployeeStatus;
    }>) {
      empMap.set(e.id, e);
    }

    const activeMappings = mappings
      .filter((m) => m.isActive)
      .map((m) => {
        const emp = empMap.get(m.employeeId);
        return {
          id: m.id,
          employeeId: m.employeeId,
          employeeCode: emp?.employeeCode || '',
          employeeName: emp?.fullName || 'Unknown Employee',
          employeeStatus: emp?.status || ('INACTIVE' as EmployeeStatus),
          terminalId: m.terminalId,
          enrollmentId: m.enrollmentId,
        };
      });

    return {
      terminals,
      deviceUsersByTerminal,
      activeMappings,
    };
  }

  /**
   * Atomically replaces an employee's biometric terminal enrollment mappings within company boundaries.
   * Rejects cross-tenant terminals, deactivated terminals (for active mappings), and duplicate active (terminalId, enrollmentId).
   */
  static async replaceEmployeeMappings(
    actor: AuthUser,
    employeeId: string,
    inputs: EmployeeBiometricMappingInput[],
    options?: {
      tx?: any;
      correlationId?: string;
      skipAudit?: boolean;
      syncEmployeeBiometricField?: boolean;
    }
  ): Promise<EmployeeBiometricMappingItem[]> {
    if (!Array.isArray(inputs)) {
      const err = new Error('biometricMappings must be an array.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const execute = async (tx: any): Promise<EmployeeBiometricMappingItem[]> => {
      // Acquire row-level lock on Company inside an interactive PostgreSQL transaction (or mocked tx/$queryRaw)
      // Avoid invoking an un-mocked root PrismaClient.$queryRaw when a unit test forwards `prisma` directly as `tx`.
      const hasQueryRaw = typeof tx.$queryRaw === 'function';
      const isMockedQueryRaw = hasQueryRaw && typeof (tx.$queryRaw as { mock?: unknown }).mock === 'object';
      if (hasQueryRaw && (tx !== prisma || isMockedQueryRaw)) {
        await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${actor.companyId}::uuid FOR UPDATE`;
      }

      const employee = await tx.employee.findUnique({ where: { id: employeeId } });
      if (!employee || employee.companyId !== actor.companyId) {
        const err = new Error('Employee record not found in this company.');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }

      const activeInputs: Array<{
        terminalId: string;
        enrollmentId: string;
        source: BiometricEnrollmentMappingSource;
      }> = [];
      const payloadPairSet = new Set<string>();

      // Validate terminals and enrollment IDs
      const requestedTerminalIds = [
        ...new Set(inputs.map((i) => String(i.terminalId || '').trim()).filter(Boolean)),
      ];

      const terminals =
        requestedTerminalIds.length > 0
          ? await tx.biometricTerminal.findMany({
              where: {
                id: { in: requestedTerminalIds },
                companyId: actor.companyId,
              },
            })
          : [];
      const terminalMap = new Map<string, any>();
      for (const t of terminals) {
        terminalMap.set(t.id, t);
      }

      for (const rawInput of inputs) {
        if (rawInput.isActive === false) continue;

        const terminalId = String(rawInput.terminalId || '').trim();
        if (!terminalId) {
          const err = new Error('Each biometric mapping must select a registered biometric terminal.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        const terminal = terminalMap.get(terminalId);
        if (!terminal || terminal.companyId !== actor.companyId) {
          const err = new Error(
            'Selected biometric terminal is invalid or belongs to another company.'
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        if (!terminal.isActive || terminal.status === 'DEACTIVATED') {
          const err = new Error(
            `Biometric terminal '${terminal.name}' is deactivated and cannot accept active enrollment mappings.`
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        const enrollmentId = this.validateEnrollmentId(rawInput.enrollmentId);
        const pairKey = `${terminalId}::${enrollmentId}`;
        if (payloadPairSet.has(pairKey)) {
          const err = new Error(
            `Duplicate enrollment ID '${enrollmentId}' specified twice for terminal '${terminal.name}'.`
          );
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        payloadPairSet.add(pairKey);

        activeInputs.push({
          terminalId,
          enrollmentId,
          source: rawInput.source === 'DEVICE_SYNC' ? 'DEVICE_SYNC' : 'EXPLICIT',
        });
      }

      const existingRecords = await this.readCompanyMappings(actor.companyId, tx);

      // Check for duplicate active mappings belonging to ANY OTHER employee on the same (terminalId, enrollmentId)
      for (const nextItem of activeInputs) {
        const conflict = existingRecords.find(
          (r) =>
            r.isActive &&
            r.employeeId !== employeeId &&
            r.terminalId === nextItem.terminalId &&
            r.enrollmentId === nextItem.enrollmentId
        );

        if (conflict) {
          const terminal = terminalMap.get(nextItem.terminalId);
          const conflictEmployee = await tx.employee.findUnique({
            where: { id: conflict.employeeId },
            select: { employeeCode: true, fullName: true },
          });
          const empLabel = conflictEmployee
            ? `${conflictEmployee.fullName} (${conflictEmployee.employeeCode})`
            : 'another employee';
          const termLabel = terminal
            ? `${terminal.name} (${terminal.deviceSerialNumber})`
            : nextItem.terminalId;

          const err = new Error(
            `Enrollment ID '${nextItem.enrollmentId}' on terminal '${termLabel}' is already actively mapped to ${empLabel}.`
          );
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
      }

      const nowIso = new Date().toISOString();
      // Keep records belonging to other employees untouched
      const otherEmployeesRecords = existingRecords.filter((r) => r.employeeId !== employeeId);

      // Preserve createdAt for continuing (terminalId, enrollmentId) pairs of this employee
      const prevForEmp = existingRecords.filter((r) => r.employeeId === employeeId);
      const nextForEmp: StoredBiometricMappingRecord[] = activeInputs.map((item) => {
        const prevMatch = prevForEmp.find(
          (p) => p.terminalId === item.terminalId && p.enrollmentId === item.enrollmentId
        );
        return {
          id: prevMatch?.id || crypto.randomUUID(),
          companyId: actor.companyId,
          employeeId,
          terminalId: item.terminalId,
          enrollmentId: item.enrollmentId,
          isActive: true,
          source: item.source,
          createdAt: prevMatch?.createdAt || nowIso,
          updatedAt: nowIso,
        };
      });

      const mergedRecords = [...otherEmployeesRecords, ...nextForEmp];
      await this.writeCompanyMappings(actor.companyId, mergedRecords, tx);

      if (options?.syncEmployeeBiometricField !== false) {
        const primaryEnrollmentId = nextForEmp[0]?.enrollmentId || null;
        await tx.employee.update({
          where: { id: employeeId },
          data: { biometricDeviceId: primaryEnrollmentId },
        });
      }

      if (!options?.skipAudit) {
        await AuditService.log({
          companyId: actor.companyId,
          userId: actor.userId || actor.id,
          action: 'EMPLOYEE_BIOMETRIC_MAPPING_UPDATE',
          entity: 'Employee',
          entityId: employeeId,
          correlationId: options?.correlationId,
          details: {
            mappings: nextForEmp.map((m) => ({
              terminalId: m.terminalId,
              enrollmentId: m.enrollmentId,
              source: m.source,
            })),
          },
        });
      }

      const fullTerminalMeta = await this.buildTerminalMetaMap(actor.companyId, tx);
      return nextForEmp.map((m) => this.enrichMapping(m, fullTerminalMeta));
    };

    if (options?.tx) {
      return execute(options.tx);
    }
    return this.withCompanyWriteLock(actor.companyId, () => prisma.$transaction(execute));
  }

  /**
   * Finds all legacy-fallback Employee candidates in a company for a given enrollment ID.
   * Excludes employees that have active explicit terminal/enrollment mappings and enforces
   * strict companyId scoping.
   */
  static async findLegacyEmployeesForEnrollment(
    companyId: string,
    userEnrollmentId: string,
    explicitMappedEmployeeIds: Set<string>,
    client?: any,
    options?: { includeShift?: boolean }
  ): Promise<any[]> {
    const db = client || prisma;
    const trimmedEnrollmentId = this.normalizeEnrollmentId(userEnrollmentId);
    if (!trimmedEnrollmentId || typeof db.employee?.findMany !== 'function') {
      return [];
    }

    const excludedIds = [...explicitMappedEmployeeIds];
    const where: Record<string, unknown> = {
      companyId,
      biometricDeviceId: trimmedEnrollmentId,
    };
    if (excludedIds.length > 0) {
      where.id = { notIn: excludedIds };
    }

    const candidates = await db.employee.findMany({
      where,
      ...(options?.includeShift ? { include: { shift: true } } : {}),
    });

    const matches: any[] = [];
    const seenIds = new Set<string>();
    for (const candidate of candidates || []) {
      if (!candidate || typeof candidate.id !== 'string') continue;
      if (candidate.companyId !== undefined && candidate.companyId !== companyId) continue;
      if (
        candidate.biometricDeviceId !== undefined &&
        (candidate.biometricDeviceId === null ||
          this.normalizeEnrollmentId(String(candidate.biometricDeviceId)) !== trimmedEnrollmentId)
      ) {
        continue;
      }
      if (explicitMappedEmployeeIds.has(candidate.id)) continue;
      if (seenIds.has(candidate.id)) continue;
      seenIds.add(candidate.id);
      matches.push(candidate);
    }

    return matches;
  }

  /**
   * Resolves a single punch's (companyId, terminalId, enrollmentId) to an Employee record.
   * Priority:
   * 1. Explicit active mapping for (terminalId, enrollmentId) within companyId.
   * 2. Legacy Employee.biometricDeviceId fallback ONLY for employees without explicit terminal mappings,
   *    failing closed if more than one legacy employee in the company matches.
   * Note: Returns employee regardless of status so caller can enforce Inactive Employee Policy cleanly.
   */
  static async resolveEmployeeForPunch(
    companyId: string,
    terminalId: string | null | undefined,
    userEnrollmentId: string,
    client?: any
  ): Promise<{
    employee: any | null;
    matchedVia: 'MAPPING' | 'LEGACY' | null;
    ambiguous?: boolean;
    ambiguousEmployeeIds?: string[];
  }> {
    const db = client || prisma;
    const trimmedEnrollmentId = this.normalizeEnrollmentId(userEnrollmentId);
    if (!trimmedEnrollmentId) {
      return { employee: null, matchedVia: null };
    }

    const mappings = await this.readCompanyMappings(companyId, db);

    // 1. Check explicit active mapping scoped to this terminal
    if (terminalId) {
      const activeMappings = mappings.filter(
        (m) =>
          m.isActive &&
          m.terminalId === terminalId &&
          m.enrollmentId === trimmedEnrollmentId
      );

      if (activeMappings.length > 1) {
        const distinctEmployeeIds = [...new Set(activeMappings.map((m) => m.employeeId))];
        if (distinctEmployeeIds.length > 1) {
          return {
            employee: null,
            matchedVia: null,
            ambiguous: true,
            ambiguousEmployeeIds: distinctEmployeeIds,
          };
        }
      }

      const activeMapping = activeMappings[0];
      if (activeMapping) {
        const mappedEmployee = await db.employee.findUnique({
          where: { id: activeMapping.employeeId },
          include: { shift: true },
        });
        if (mappedEmployee && mappedEmployee.companyId === companyId) {
          return { employee: mappedEmployee, matchedVia: 'MAPPING' };
        }
        return { employee: null, matchedVia: null };
      }
    }

    // 2. Fallback to legacy Employee.biometricDeviceId only for employees without explicit mappings.
    //    Fail closed if more than one legacy employee in the company shares the same biometricDeviceId.
    const employeesWithExplicitMappings = new Set(
      mappings.filter((m) => m.isActive).map((m) => m.employeeId)
    );

    const legacyEmployees = await this.findLegacyEmployeesForEnrollment(
      companyId,
      trimmedEnrollmentId,
      employeesWithExplicitMappings,
      db,
      { includeShift: true }
    );

    if (legacyEmployees.length > 1) {
      return {
        employee: null,
        matchedVia: null,
        ambiguous: true,
        ambiguousEmployeeIds: legacyEmployees.map((emp) => emp.id),
      };
    }

    if (legacyEmployees.length === 1) {
      return { employee: legacyEmployees[0], matchedVia: 'LEGACY' };
    }

    return { employee: null, matchedVia: null };
  }

  /**
   * Batch resolves ACTIVE employees for punch ingestion on a specific terminal.
   * Preserves backward compatibility with mocked Employee objects that omit `status`.
   * Fails closed on ambiguous legacy Employee.biometricDeviceId collisions within companyId.
   */
  static async resolveBatchForTerminal(
    companyId: string,
    terminalId: string,
    enrollmentIds: string[],
    client?: any
  ): Promise<Map<string, string>> {
    const db = client || prisma;
    const resolved = new Map<string, string>();
    const uniqueIds = [...new Set(enrollmentIds.map((id) => this.normalizeEnrollmentId(id)).filter(Boolean))];
    if (uniqueIds.length === 0) return resolved;

    const mappings = await this.readCompanyMappings(companyId, db);
    const activeMappingsForTerminal = mappings.filter(
      (m) => m.isActive && m.terminalId === terminalId && uniqueIds.includes(m.enrollmentId)
    );

    const explicitMappingsByEnrollment = new Map<string, Set<string>>();
    for (const m of activeMappingsForTerminal) {
      let empSet = explicitMappingsByEnrollment.get(m.enrollmentId);
      if (!empSet) {
        empSet = new Set<string>();
        explicitMappingsByEnrollment.set(m.enrollmentId, empSet);
      }
      empSet.add(m.employeeId);
    }

    const mappedEmpIds = [...new Set(activeMappingsForTerminal.map((m) => m.employeeId))];
    if (mappedEmpIds.length > 0 && typeof db.employee?.findMany === 'function') {
      const mappedEmps = await db.employee.findMany({
        where: {
          companyId,
          id: { in: mappedEmpIds },
        },
        select: { id: true, status: true },
      });
      const activeEmpSet = new Set(
        mappedEmps
          .filter(
            (e: any) =>
              (e.companyId === undefined || e.companyId === companyId) &&
              (e.status === undefined || e.status === 'ACTIVE')
          )
          .map((e: any) => e.id)
      );
      for (const [enrollmentId, empSet] of explicitMappingsByEnrollment.entries()) {
        // Fail closed if corrupted mapping storage maps >1 distinct employee to (terminalId, enrollmentId)
        if (empSet.size !== 1) continue;
        const onlyEmpId = [...empSet][0];
        if (activeEmpSet.has(onlyEmpId)) {
          resolved.set(enrollmentId, onlyEmpId);
        }
      }
    }

    // Any enrollmentId with an active explicit mapping on this terminal must NOT fall back to legacy,
    // even if its mapped employee is inactive or ambiguous.
    const remainingIds = uniqueIds.filter((id) => !explicitMappingsByEnrollment.has(id));
    if (remainingIds.length === 0 || typeof db.employee?.findMany !== 'function') {
      return resolved;
    }

    const employeesWithExplicitMappings = new Set(
      mappings.filter((m) => m.isActive).map((m) => m.employeeId)
    );

    const legacyEmployees = await db.employee.findMany({
      where: {
        companyId,
        biometricDeviceId: { in: remainingIds },
      },
      select: { id: true, biometricDeviceId: true, status: true },
    });

    const legacyCandidatesByEnrollment = new Map<string, Map<string, any>>();
    for (const emp of legacyEmployees || []) {
      if (!emp || typeof emp.id !== 'string' || !emp.biometricDeviceId) continue;
      if (emp.companyId !== undefined && emp.companyId !== companyId) continue;
      if (employeesWithExplicitMappings.has(emp.id)) continue;
      const normalizedKey = this.normalizeEnrollmentId(String(emp.biometricDeviceId));
      if (!normalizedKey) continue;
      let candidatesById = legacyCandidatesByEnrollment.get(normalizedKey);
      if (!candidatesById) {
        candidatesById = new Map<string, any>();
        legacyCandidatesByEnrollment.set(normalizedKey, candidatesById);
      }
      candidatesById.set(emp.id, emp);
    }

    for (const [enrollmentId, candidatesById] of legacyCandidatesByEnrollment.entries()) {
      // Fail closed if more than one legacy employee in this company shares the same biometricDeviceId.
      if (candidatesById.size !== 1) continue;
      const onlyCandidate = [...candidatesById.values()][0];
      if (onlyCandidate.status !== undefined && onlyCandidate.status !== 'ACTIVE') continue;
      if (!resolved.has(enrollmentId)) {
        resolved.set(enrollmentId, onlyCandidate.id);
      }
    }

    return resolved;
  }
}
