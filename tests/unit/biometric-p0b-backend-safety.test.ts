import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { prisma } from '../../src/server/db/client.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { BiometricController } from '../../src/server/controllers/biometric.controller.js';
import { BiometricMappingService } from '../../src/server/services/biometric-mapping.service.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { PreviewAuthService } from '../../src/server/services/preview-auth.service.js';
import * as biometricSafety from '../../src/server/services/biometric-safety.js';
import {
  computeCurrentDayUpperBoundUtc,
  computeCurrentLocalDayStartUtc,
  CURRENT_DAY_FUTURE_CLOCK_SKEW_MS,
  evaluateReconciliationWindow,
  MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE,
  MAX_NORMAL_RECONCILIATION_BATCH_SIZE,
  resolveStrictCompanyTimezone,
  TRUSTED_WINDOW_TTL_MS,
} from '../../src/server/services/biometric-safety.js';
import type { AuthUser } from '../../src/shared/types.js';

function createMockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function createMockRequest(actor: AuthUser, overrides: Partial<Request> = {}): Request {
  return {
    user: actor,
    params: {},
    query: {},
    body: {},
    correlationId: 'corr-p0b-safety-test',
    ...overrides,
  } as unknown as Request;
}

describe('CoreERP P0-B — Backend Biometric Punch Safety (DB-Free Regression Suite)', () => {
  const companyId = 'comp-p0b-ist';
  const terminalId = 'term-essl-x2008';

  // Fixed deterministic clock: 2026-11-23T04:00:00.000Z === 2026-11-23 09:30:00 Asia/Kolkata
  // Start of current Asia/Kolkata calendar day (2026-11-23 00:00:00 IST) === 2026-11-22T18:30:00.000Z
  const FIXED_NOW_UTC = new Date('2026-11-23T04:00:00.000Z');
  const EXPECTED_IST_CUTOFF_ISO = '2026-11-22T18:30:00.000Z';

  const mockTerminal = {
    id: terminalId,
    companyId,
    deviceSerialNumber: 'NFZ8252800275',
    name: 'eSSL X2008 Main Gate',
    terminalModel: 'eSSL-X2008',
    ipAddress: '192.168.1.201',
    port: 4370,
    location: 'Main Entrance',
    apiKeyPrefix: 'bio_live_test',
    status: 'ONLINE',
    lastHeartbeatAt: FIXED_NOW_UTC,
    lastSyncAt: null,
    firmwareVersion: '1.0',
    registeredByUserId: 'user-super-1',
    registeredByUser: { fullName: 'Super Admin' },
    isActive: true,
    notes: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  };

  let biometricEditAdminActor: AuthUser;
  let superAdminActor: AuthUser;

  async function mintAuthenticatedActor(overrides: {
    id: string;
    companyId: string;
    role: AuthUser['role'];
    fullName: string;
    email: string;
    tokenVersion?: number;
  }): Promise<AuthUser> {
    const tokenVersion = overrides.tokenVersion ?? 1;
    const wasAlreadyMocked = vi.isMockFunction(prisma.user.findUnique);
    const spy = vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
      id: overrides.id,
      companyId: overrides.companyId,
      role: overrides.role,
      fullName: overrides.fullName,
      email: overrides.email,
      isActive: true,
      tokenVersion,
      lastLoginAt: FIXED_NOW_UTC,
    } as any);
    try {
      const signedToken = AuthService.generateSessionToken({
        userId: overrides.id,
        companyId: overrides.companyId,
        email: overrides.email,
        role: overrides.role,
        tokenVersion,
      });
      const verifiedPayload = AuthService.verifySessionToken(signedToken);
      if (!verifiedPayload) {
        throw new Error('Failed to verify generated test session token.');
      }
      const actor = await AuthService.validateSessionUser(verifiedPayload);
      if (!actor) {
        throw new Error('Failed to mint server-provenanced test actor via AuthService.validateSessionUser.');
      }
      return actor;
    } finally {
      if (!wasAlreadyMocked) {
        spy.mockRestore();
      }
    }
  }

  const activeEmployee = {
    id: 'emp-ist-101',
    companyId,
    employeeCode: 'EMP101',
    firstName: 'Aarav',
    lastName: 'Sharma',
    status: 'ACTIVE',
    biometricDeviceId: '101',
    dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
    shiftId: 'shift-day-1',
    shift: {
      id: 'shift-day-1',
      code: 'DAY',
      name: 'Day Shift',
      startTime: '09:00',
      endTime: '18:00',
      isOvernight: false,
      graceMinutes: 15,
    },
    dailyWorkingHours: 9,
    monthlyLeaveAllowance: 4,
  };

  const otherEmployee = {
    ...activeEmployee,
    id: 'emp-ist-202',
    employeeCode: 'EMP202',
    firstName: 'Priya',
    lastName: 'Patel',
    biometricDeviceId: '202',
  };

  interface InMemoryPunch {
    id: string;
    companyId: string;
    terminalId: string;
    devicePunchId: string | null;
    userEnrollmentId: string;
    punchTime: Date;
    verifyType: 'FINGERPRINT';
    inOutMode: 'CHECK_IN' | 'CHECK_OUT';
    syncStatus: 'PENDING' | 'PROCESSED' | 'IGNORED' | 'ERROR';
    errorMessage: string | null;
    idempotencyKey: string;
    matchedEmployeeId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }

  function setupInMemoryReconciliationHarness(initialPunches: InMemoryPunch[], companyTz = 'Asia/Kolkata') {
    const punchesStore = initialPunches.map((p) => ({ ...p }));
    const attendanceStore: Array<Record<string, any>> = [];
    const auditLogs: Array<Record<string, any>> = [];
    const observedFindManyWheres: Array<Record<string, any>> = [];

    const userStore = new Map<string, Record<string, any>>([
      [
        'user-super-1',
        {
          id: 'user-super-1',
          companyId,
          role: 'SUPER_ADMIN',
          isActive: true,
          tokenVersion: 1,
        },
      ],
      [
        'user-admin-edit-1',
        {
          id: 'user-admin-edit-1',
          companyId,
          role: 'ADMIN',
          isActive: true,
          tokenVersion: 1,
        },
      ],
      [
        'user-super-other',
        {
          id: 'user-super-other',
          companyId: 'comp-other-tenant',
          role: 'SUPER_ADMIN',
          isActive: true,
          tokenVersion: 1,
        },
      ],
    ]);

    const userFindUniqueSpy = vi
      .spyOn(prisma.user, 'findUnique')
      .mockImplementation((async (args: any) => {
        const id = args?.where?.id;
        return (id && userStore.get(id)) || null;
      }) as any);

    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: companyTz } as any);
    vi.spyOn(AuditService, 'log').mockImplementation(async (entry: any) => {
      auditLogs.push(entry);
      return {} as any;
    });
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
    const telemetryUpsertSpy = vi
      .spyOn(prisma.companySetting, 'upsert')
      .mockResolvedValue({} as any);
    vi.spyOn(prisma.biometricTerminal, 'findFirst').mockImplementation((async (args: any) => {
      if (args?.where?.id === terminalId && args?.where?.companyId === companyId) {
        return mockTerminal as any;
      }
      return null;
    }) as any);

    vi.spyOn(prisma.employee, 'findFirst').mockImplementation((async (args: any) => {
      if (args?.where?.companyId === companyId) {
        if (args?.where?.id === activeEmployee.id) return activeEmployee as any;
        if (args?.where?.id === otherEmployee.id) return otherEmployee as any;
      }
      return null;
    }) as any);

    vi.spyOn(BiometricMappingService, 'listMappingsForEmployee').mockImplementation(async (_cId, empId) => {
      if (empId === activeEmployee.id) {
        return [
          {
            id: 'map-101',
            companyId,
            employeeId: activeEmployee.id,
            terminalId,
            enrollmentId: '101',
            isActive: true,
          },
        ] as any;
      }
      if (empId === otherEmployee.id) {
        return [
          {
            id: 'map-202',
            companyId,
            employeeId: otherEmployee.id,
            terminalId,
            enrollmentId: '202',
            isActive: true,
          },
        ] as any;
      }
      return [] as any;
    });

    vi.spyOn(BiometricMappingService, 'resolveEmployeeForPunch').mockImplementation(
      async (cId: string, _tId: string, enrollmentId: string) => {
        if (cId === companyId && enrollmentId === '101') {
          return { employee: activeEmployee as any, matchedVia: 'MAPPING' as const };
        }
        if (cId === companyId && enrollmentId === '202') {
          return { employee: otherEmployee as any, matchedVia: 'MAPPING' as const };
        }
        return { employee: null, matchedVia: null };
      }
    );

    const matchesWhere = (p: InMemoryPunch, where: any): boolean => {
      if (!where) return true;
      if (where.id && p.id !== where.id) return false;
      if (where.companyId && p.companyId !== where.companyId) return false;
      if (where.terminalId && p.terminalId !== where.terminalId) return false;
      if (where.userEnrollmentId && p.userEnrollmentId !== where.userEnrollmentId) return false;
      if (where.syncStatus) {
        if (typeof where.syncStatus === 'string') {
          if (p.syncStatus !== where.syncStatus) return false;
        } else if (Array.isArray(where.syncStatus.in)) {
          if (!where.syncStatus.in.includes(p.syncStatus)) return false;
        }
      }
      if (where.punchTime?.gte && p.punchTime.getTime() < new Date(where.punchTime.gte).getTime()) {
        return false;
      }
      if (where.punchTime?.lte && p.punchTime.getTime() > new Date(where.punchTime.lte).getTime()) {
        return false;
      }
      if (Array.isArray(where.OR)) {
        const matchedOr = where.OR.some((clause: any) => {
          if (clause.matchedEmployeeId !== undefined) {
            return p.matchedEmployeeId === clause.matchedEmployeeId;
          }
          if (clause.terminalId && p.terminalId !== clause.terminalId) return false;
          if (clause.userEnrollmentId && p.userEnrollmentId !== clause.userEnrollmentId) return false;
          return true;
        });
        if (!matchedOr) return false;
      }
      return true;
    };

    const rawPunchFindManySpy = vi
      .spyOn(prisma.rawPunchLog, 'findMany')
      .mockImplementation((async (args: any) => {
        observedFindManyWheres.push(args?.where || {});
        return punchesStore
          .filter((p) => matchesWhere(p, args?.where))
          .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime())
          .slice(0, args?.take ?? 100)
          .map((p) => ({ id: p.id })) as any;
      }) as any);

    const rawPunchUpdateSpy = vi
      .spyOn(prisma.rawPunchLog, 'update')
      .mockImplementation((async (args: any) => {
        const target = punchesStore.find((p) => p.id === args?.where?.id);
        if (!target) throw new Error('Punch not found');
        Object.assign(target, args.data);
        return target as any;
      }) as any);

    const attendanceCreateSpy = vi
      .spyOn(prisma.attendance, 'create')
      .mockImplementation((async (args: any) => {
        const row = { id: `att-${attendanceStore.length + 1}`, ...args.data };
        attendanceStore.push(row);
        return row as any;
      }) as any);

    const attendanceUpdateSpy = vi
      .spyOn(prisma.attendance, 'update')
      .mockImplementation((async (args: any) => {
        const row = attendanceStore.find((a) => a.id === args?.where?.id);
        if (!row) throw new Error('Attendance not found');
        Object.assign(row, args.data);
        return row as any;
      }) as any);

    vi.spyOn(prisma.attendance, 'findUnique').mockImplementation((async (args: any) => {
      const key = args?.where?.employeeId_date;
      if (!key) return null;
      return (
        attendanceStore.find(
          (a) =>
            a.employeeId === key.employeeId &&
            new Date(a.date).toISOString() === new Date(key.date).toISOString()
        ) || null
      );
    }) as any);

    vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
    vi.spyOn(prisma.leaveRequest, 'findFirst').mockResolvedValue(null);
    vi.spyOn(prisma.rawPunchLog, 'findUnique').mockImplementation((async (args: any) => {
      const p = punchesStore.find((item) => item.id === args?.where?.id);
      if (!p) return null;
      return {
        ...p,
        company: { id: p.companyId, timezone: companyTz },
        terminal: { id: p.terminalId, name: mockTerminal.name, location: mockTerminal.location },
        matchedEmployee:
          p.matchedEmployeeId === activeEmployee.id
            ? activeEmployee
            : p.matchedEmployeeId === otherEmployee.id
            ? otherEmployee
            : null,
      } as any;
    }) as any);

    vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);

    return {
      punchesStore,
      attendanceStore,
      auditLogs,
      observedFindManyWheres,
      userStore,
      userFindUniqueSpy,
      telemetryUpsertSpy,
      rawPunchFindManySpy,
      rawPunchUpdateSpy,
      attendanceCreateSpy,
      attendanceUpdateSpy,
    };
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_UTC);
    vi.restoreAllMocks();

    biometricEditAdminActor = await mintAuthenticatedActor({
      id: 'user-admin-edit-1',
      companyId,
      role: 'ADMIN', // Has BIOMETRIC:EDIT permission, NOT SUPER_ADMIN
      fullName: 'Biometric Admin',
      email: 'admin@coreerp.test',
      tokenVersion: 1,
    });

    superAdminActor = await mintAuthenticatedActor({
      id: 'user-super-1',
      companyId,
      role: 'SUPER_ADMIN',
      fullName: 'Super Admin',
      email: 'superadmin@coreerp.test',
      tokenVersion: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Asia/Kolkata Midnight UTC Conversion Determinism', () => {
    it('computes exact UTC start of current Asia/Kolkata calendar day across IST midnight boundaries', () => {
      // 2026-11-23 09:30:00 IST -> 2026-11-23 00:00:00 IST === 2026-11-22T18:30:00.000Z
      expect(
        computeCurrentLocalDayStartUtc('Asia/Kolkata', new Date('2026-11-23T04:00:00.000Z')).toISOString()
      ).toBe('2026-11-22T18:30:00.000Z');

      // 2026-11-22 23:59:59 IST (1 second before IST midnight) -> 2026-11-22 00:00:00 IST === 2026-11-21T18:30:00.000Z
      expect(
        computeCurrentLocalDayStartUtc('Asia/Kolkata', new Date('2026-11-22T18:29:59.000Z')).toISOString()
      ).toBe('2026-11-21T18:30:00.000Z');

      // Exact IST midnight 2026-11-23 00:00:00 IST === 2026-11-22T18:30:00.000Z
      expect(
        computeCurrentLocalDayStartUtc('Asia/Kolkata', new Date('2026-11-22T18:30:00.000Z')).toISOString()
      ).toBe('2026-11-22T18:30:00.000Z');
    });
  });

  describe('Punch Ingestion Cutoff & Fail-Closed Controls (Cases 1–6, 16)', () => {
    it('Case 1: accepts current-day punch (including exact Asia/Kolkata midnight 18:30:00.000Z) and stores as PENDING', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Asia/Kolkata' } as any);
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValue([]);
      vi.spyOn(BiometricMappingService, 'resolveBatchForTerminal').mockResolvedValue(
        new Map([['101', activeEmployee.id]])
      );
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.companySetting, 'upsert').mockResolvedValue({} as any);
      const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);

      const createManySpy = vi.fn().mockResolvedValue({ count: 2 });
      const terminalUpdateSpy = vi.fn().mockResolvedValue({});
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) =>
        cb({
          rawPunchLog: { createMany: createManySpy },
          biometricTerminal: { update: terminalUpdateSpy },
        })
      );

      const result = await BiometricService.ingestPunches(mockTerminal, {
        deviceSerialNumber: 'NFZ8252800275',
        punches: [
          {
            devicePunchId: 'p-midnight-exact',
            userEnrollmentId: '101',
            punchTime: '2026-11-22T18:30:00.000Z', // Exact 00:00:00 IST on 2026-11-23
            inOutMode: 'CHECK_IN',
          },
          {
            devicePunchId: 'p-morning-ist',
            userEnrollmentId: '101',
            punchTime: '2026-11-23T03:35:00.000Z', // 09:05:00 IST on 2026-11-23
            inOutMode: 'CHECK_IN',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.totalReceived).toBe(2);
      expect(result.inserted).toBe(2);
      expect(result.rejectedHistorical).toBe(0);
      expect(result.duplicates).toBe(0);
      expect(result.companyTimezone).toBe('Asia/Kolkata');
      expect(result.effectiveCutoffIso).toBe(EXPECTED_IST_CUTOFF_ISO);

      const insertedRows = createManySpy.mock.calls[0][0].data;
      expect(insertedRows).toHaveLength(2);
      expect(insertedRows.every((r: any) => r.syncStatus === 'PENDING')).toBe(true);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BIOMETRIC_PUNCH_INGEST',
          details: expect.objectContaining({
            inserted: 2,
            rejectedHistorical: 0,
            companyTimezone: 'Asia/Kolkata',
            effectiveCutoffIso: EXPECTED_IST_CUTOFF_ISO,
          }),
        })
      );
    });

    it('Case 2: rejects historical punches (including 1ms before Asia/Kolkata midnight) and never stores them as PENDING', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Asia/Kolkata' } as any);
      const rawPunchFindManySpy = vi.spyOn(prisma.rawPunchLog, 'findMany');
      const rawPunchCreateManySpy = vi.spyOn(prisma.rawPunchLog, 'createMany');
      const rawPunchDeleteManySpy = vi.spyOn(prisma.rawPunchLog, 'deleteMany');
      const attendanceCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const txSpy = vi.spyOn(prisma, '$transaction');
      vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValue({} as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.companySetting, 'upsert').mockResolvedValue({} as any);
      const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);

      const result = await BiometricService.ingestPunches(mockTerminal, {
        deviceSerialNumber: 'NFZ8252800275',
        punches: [
          {
            devicePunchId: 'p-1ms-before-ist-midnight',
            userEnrollmentId: '101',
            punchTime: '2026-11-22T18:29:59.999Z', // 23:59:59.999 IST yesterday!
            inOutMode: 'CHECK_OUT',
          },
          {
            devicePunchId: 'p-last-month',
            userEnrollmentId: '101',
            punchTime: '2026-10-15T04:00:00.000Z',
            inOutMode: 'CHECK_IN',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.totalReceived).toBe(2);
      expect(result.inserted).toBe(0);
      expect(result.duplicates).toBe(0);
      expect(result.rejectedHistorical).toBe(2);
      expect(result.effectiveCutoffIso).toBe(EXPECTED_IST_CUTOFF_ISO);
      expect(result.companyTimezone).toBe('Asia/Kolkata');

      expect(txSpy).not.toHaveBeenCalled();
      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchCreateManySpy).not.toHaveBeenCalled();
      expect(rawPunchDeleteManySpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BIOMETRIC_PUNCH_INGEST',
          details: expect.objectContaining({
            totalReceived: 2,
            inserted: 0,
            rejectedHistorical: 2,
            effectiveCutoffIso: EXPECTED_IST_CUTOFF_ISO,
          }),
        })
      );
    });

    it('Case 3: mixed batch accepts current-day punches as PENDING and rejects historical punches without mutating Attendance', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Asia/Kolkata' } as any);
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValue([]);
      vi.spyOn(BiometricMappingService, 'resolveBatchForTerminal').mockResolvedValue(
        new Map([['101', activeEmployee.id]])
      );
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.companySetting, 'upsert').mockResolvedValue({} as any);
      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);
      const attendanceCreateSpy = vi.spyOn(prisma.attendance, 'create');

      const createManySpy = vi.fn().mockResolvedValue({ count: 1 });
      const terminalUpdateSpy = vi.fn().mockResolvedValue({});
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) =>
        cb({
          rawPunchLog: { createMany: createManySpy },
          biometricTerminal: { update: terminalUpdateSpy },
        })
      );

      const result = await BiometricService.ingestPunches(mockTerminal, {
        punches: [
          {
            devicePunchId: 'hist-1',
            userEnrollmentId: '101',
            punchTime: '2026-11-22T18:29:59.000Z', // Yesterday IST
          },
          {
            devicePunchId: 'today-1',
            userEnrollmentId: '101',
            punchTime: '2026-11-23T03:30:00.000Z', // Today 09:00 IST
          },
          {
            devicePunchId: 'today-1', // Duplicate of today-1 inside same batch
            userEnrollmentId: '101',
            punchTime: '2026-11-23T03:30:00.000Z',
          },
          {
            devicePunchId: 'hist-2',
            userEnrollmentId: '101',
            punchTime: '2026-09-01T04:00:00.000Z', // Historical
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.totalReceived).toBe(4);
      expect(result.inserted).toBe(1);
      expect(result.duplicates).toBe(1);
      expect(result.rejectedHistorical).toBe(2);
      expect(createManySpy).toHaveBeenCalledTimes(1);
      const created = createManySpy.mock.calls[0][0].data;
      expect(created).toHaveLength(1);
      expect(created[0].devicePunchId).toBe('today-1');
      expect(created[0].syncStatus).toBe('PENDING');
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
    });

    it('Case 4: missing Company timezone fails closed (never falls back to UTC) for both ingestion and reconciliation', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: null } as any);
      const createManySpy = vi.spyOn(prisma.rawPunchLog, 'createMany');
      const findManySpy = vi.spyOn(prisma.rawPunchLog, 'findMany');

      await expect(resolveStrictCompanyTimezone(companyId)).rejects.toMatchObject({
        statusCode: 422,
        code: 'BIOMETRIC_TIMEZONE_MISSING',
      });

      await expect(
        BiometricService.ingestPunches(mockTerminal, {
          punches: [{ userEnrollmentId: '101', punchTime: '2026-11-23T03:30:00.000Z' }],
        })
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_MISSING' });

      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, {}, biometricEditAdminActor)
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_MISSING' });

      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { employeeId: activeEmployee.id },
          biometricEditAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_MISSING' });

      expect(createManySpy).not.toHaveBeenCalled();
      expect(findManySpy).not.toHaveBeenCalled();
    });

    it('Case 5: invalid Company timezone fails closed (never falls back to UTC) for both ingestion and reconciliation', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Mars/Olympus_Mons' } as any);
      const createManySpy = vi.spyOn(prisma.rawPunchLog, 'createMany');
      const findManySpy = vi.spyOn(prisma.rawPunchLog, 'findMany');

      await expect(
        BiometricService.ingestPunches(mockTerminal, {
          punches: [{ userEnrollmentId: '101', punchTime: '2026-11-23T03:30:00.000Z' }],
        })
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_INVALID' });

      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, {}, biometricEditAdminActor)
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_INVALID' });

      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { userEnrollmentId: '101' },
          biometricEditAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_INVALID' });

      expect(createManySpy).not.toHaveBeenCalled();
      expect(findManySpy).not.toHaveBeenCalled();
    });

    it('Case 6: Company timezone lookup/database failure fails closed with 503 and performs zero mutations', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockRejectedValue(new Error('ECONNREFUSED db unavailable'));
      const createManySpy = vi.spyOn(prisma.rawPunchLog, 'createMany');
      const findManySpy = vi.spyOn(prisma.rawPunchLog, 'findMany');
      const attendanceCreateSpy = vi.spyOn(prisma.attendance, 'create');

      await expect(
        BiometricService.ingestPunches(mockTerminal, {
          punches: [{ userEnrollmentId: '101', punchTime: '2026-11-23T03:30:00.000Z' }],
        })
      ).rejects.toMatchObject({ statusCode: 503, code: 'BIOMETRIC_TIMEZONE_LOOKUP_FAILED' });

      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, {}, biometricEditAdminActor)
      ).rejects.toMatchObject({ statusCode: 503, code: 'BIOMETRIC_TIMEZONE_LOOKUP_FAILED' });

      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { terminalId },
          biometricEditAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 503, code: 'BIOMETRIC_TIMEZONE_LOOKUP_FAILED' });

      expect(createManySpy).not.toHaveBeenCalled();
      expect(findManySpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
    });

    it('Case 16: ingestion does not automatically invoke reconciliation or mutate Attendance', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Asia/Kolkata' } as any);
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValue([]);
      vi.spyOn(BiometricMappingService, 'resolveBatchForTerminal').mockResolvedValue(
        new Map([['101', activeEmployee.id]])
      );
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.companySetting, 'upsert').mockResolvedValue({} as any);
      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);

      const reconcileBatchSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');
      const reconcileSingleSpy = vi.spyOn(PunchReconciliationService, 'reconcilePunch');
      const attendanceCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attendanceUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) =>
        cb({
          rawPunchLog: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
          biometricTerminal: { update: vi.fn().mockResolvedValue({}) },
        })
      );

      const res = await BiometricService.ingestPunches(mockTerminal, {
        punches: [
          {
            devicePunchId: 'manual-only-today',
            userEnrollmentId: '101',
            punchTime: '2026-11-23T03:30:00.000Z',
          },
        ],
      });

      expect(res.inserted).toBe(1);
      expect(reconcileBatchSpy).not.toHaveBeenCalled();
      expect(reconcileSingleSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(attendanceUpdateSpy).not.toHaveBeenCalled();
    });
  });

  describe('Reconciliation Cutoff Enforcement Across Bulk & Targeted Paths (Cases 7–10, 15)', () => {
    const buildSeedPunches = (): InMemoryPunch[] => [
      {
        id: 'punch-historical-old',
        companyId,
        terminalId,
        devicePunchId: 'dp-old-1',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-20T03:30:00.000Z'), // 3 days ago
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-old-1',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-20T03:30:00.000Z'),
        updatedAt: new Date('2026-11-20T03:30:00.000Z'),
      },
      {
        id: 'punch-yesterday-ist-2359',
        companyId,
        terminalId,
        devicePunchId: 'dp-yest-2359',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-22T18:29:59.000Z'), // 23:59:59 IST yesterday!
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-yest-2359',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-22T18:29:59.000Z'),
        updatedAt: new Date('2026-11-22T18:29:59.000Z'),
      },
      {
        id: 'punch-today-ist-0900',
        companyId,
        terminalId,
        devicePunchId: 'dp-today-0900',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-23T03:30:00.000Z'), // 09:00:00 IST today!
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-today-0900',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-23T03:30:00.000Z'),
        updatedAt: new Date('2026-11-23T03:30:00.000Z'),
      },
    ];

    it('Case 7: employee-targeted reconciliation cannot bypass current-day cutoff', async () => {
      const { punchesStore, attendanceStore, observedFindManyWheres } =
        setupInMemoryReconciliationHarness(buildSeedPunches());

      const res = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        { employeeId: activeEmployee.id },
        biometricEditAdminActor
      );

      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        EXPECTED_IST_CUTOFF_ISO
      );
      expect(res.totalEvaluated).toBe(1);
      expect(res.processed).toBe(1);
      expect(res.results[0].punchId).toBe('punch-today-ist-0900');
      expect(punchesStore.find((p) => p.id === 'punch-historical-old')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'punch-yesterday-ist-2359')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'punch-today-ist-0900')?.syncStatus).toBe('PROCESSED');
      expect(attendanceStore).toHaveLength(1);
    });

    it('Case 8: enrollment-targeted reconciliation (direct & employee-mapping path) cannot bypass current-day cutoff', async () => {
      const { punchesStore, observedFindManyWheres } = setupInMemoryReconciliationHarness(
        buildSeedPunches()
      );

      // Direct enrollment filter with attempted historical fromPunchTime without allowHistorical
      const res = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        { userEnrollmentId: '101', fromPunchTime: '2026-11-01T00:00:00.000Z' },
        biometricEditAdminActor
      );

      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        EXPECTED_IST_CUTOFF_ISO
      );
      expect(res.totalEvaluated).toBe(1);
      expect(res.results[0].punchId).toBe('punch-today-ist-0900');
      expect(punchesStore.find((p) => p.id === 'punch-historical-old')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'punch-yesterday-ist-2359')?.syncStatus).toBe('PENDING');

      // Employee mapping path cannot bypass cutoff even if historical fromPunchTime is passed
      const mapRes = await PunchReconciliationService.reconcileForEmployeeMapping(
        companyId,
        terminalId,
        '101',
        biometricEditAdminActor,
        undefined,
        { fromPunchTime: '2026-11-01T00:00:00.000Z' }
      );
      expect(new Date(observedFindManyWheres[1].punchTime.gte).toISOString()).toBe(
        EXPECTED_IST_CUTOFF_ISO
      );
      expect(mapRes.totalEvaluated).toBe(0);
      expect(punchesStore.find((p) => p.id === 'punch-historical-old')?.syncStatus).toBe('PENDING');
    });

    it('Case 9: terminal-targeted and punchId-targeted reconciliation cannot bypass current-day cutoff', async () => {
      const { punchesStore, observedFindManyWheres } = setupInMemoryReconciliationHarness(
        buildSeedPunches()
      );

      // Targeted punchId pointing directly to a historical punch must still be blocked by cutoff
      const punchIdRes = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        { punchId: 'punch-historical-old' },
        biometricEditAdminActor
      );
      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        EXPECTED_IST_CUTOFF_ISO
      );
      expect(punchIdRes.totalEvaluated).toBe(0);
      expect(punchesStore.find((p) => p.id === 'punch-historical-old')?.syncStatus).toBe('PENDING');

      // Terminal-targeted sync via BiometricService.triggerTerminalSync enforces cutoff
      const termSyncRes = await BiometricService.triggerTerminalSync(
        biometricEditAdminActor,
        terminalId,
        { fromPunchTime: '2026-11-01T00:00:00.000Z' }
      );
      expect(new Date(observedFindManyWheres[1].punchTime.gte).toISOString()).toBe(
        EXPECTED_IST_CUTOFF_ISO
      );
      expect(termSyncRes.reconciliation.totalEvaluated).toBe(1);
      expect(termSyncRes.reconciliation.results[0].punchId).toBe('punch-today-ist-0900');
      expect(punchesStore.find((p) => p.id === 'punch-historical-old')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'punch-yesterday-ist-2359')?.syncStatus).toBe('PENDING');
    });

    it('Case 10 & Case 15: default bulk reconciliation applies Asia/Kolkata cutoff and reconciles eligible current-day punches normally', async () => {
      const { punchesStore, attendanceStore, observedFindManyWheres } =
        setupInMemoryReconciliationHarness(buildSeedPunches());

      const res = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {},
        biometricEditAdminActor
      );

      expect(res.success).toBe(true);
      expect(res.historicalMode).toBe(false);
      expect(res.companyTimezone).toBe('Asia/Kolkata');
      expect(res.effectiveCutoffIso).toBe(EXPECTED_IST_CUTOFF_ISO);
      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        EXPECTED_IST_CUTOFF_ISO
      );

      expect(res.totalEvaluated).toBe(1);
      expect(res.processed).toBe(1);
      expect(res.errors).toBe(0);
      expect(res.results[0].punchId).toBe('punch-today-ist-0900');
      expect(punchesStore.find((p) => p.id === 'punch-today-ist-0900')?.syncStatus).toBe('PROCESSED');
      expect(punchesStore.find((p) => p.id === 'punch-yesterday-ist-2359')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'punch-historical-old')?.syncStatus).toBe('PENDING');

      expect(attendanceStore).toHaveLength(1);
      expect(attendanceStore[0].employeeId).toBe(activeEmployee.id);
      expect(new Date(attendanceStore[0].checkIn).toISOString()).toBe('2026-11-23T03:30:00.000Z');
    });
  });

  describe('Historical Reconciliation Authorization, Auditing & Non-Mutation Guarantees (Cases 11–14)', () => {
    const buildHistoricalSeed = (): InMemoryPunch[] => [
      {
        id: 'hist-nov-20',
        companyId,
        terminalId,
        devicePunchId: 'dp-nov-20',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-20T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-nov-20',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-20T03:30:00.000Z'),
        updatedAt: new Date('2026-11-20T03:30:00.000Z'),
      },
      {
        id: 'hist-nov-10-outside-window',
        companyId,
        terminalId,
        devicePunchId: 'dp-nov-10',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-10T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-nov-10',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-10T03:30:00.000Z'),
        updatedAt: new Date('2026-11-10T03:30:00.000Z'),
      },
      {
        id: 'today-nov-23',
        companyId,
        terminalId,
        devicePunchId: 'dp-nov-23',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-23T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-nov-23',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-23T03:30:00.000Z'),
        updatedAt: new Date('2026-11-23T03:30:00.000Z'),
      },
    ];

    it('Case 11 & Case 14: BIOMETRIC:EDIT (non-SUPER_ADMIN) cannot enable historical reconciliation and mutates nothing on failure', async () => {
      const {
        punchesStore,
        attendanceStore,
        rawPunchFindManySpy,
        rawPunchUpdateSpy,
        attendanceCreateSpy,
        attendanceUpdateSpy,
      } = setupInMemoryReconciliationHarness(buildHistoricalSeed());
      const telemetryUpsertSpy = vi.spyOn(prisma.companySetting, 'upsert');

      // 1. Direct service call
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            fromPunchTime: '2026-11-19T00:00:00.000Z',
            toPunchTime: '2026-11-21T23:59:59.000Z',
          },
          biometricEditAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // 2. Terminal sync service call
      await expect(
        BiometricService.triggerTerminalSync(biometricEditAdminActor, terminalId, {
          allowHistorical: true,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // 3. HTTP Controller POST /api/biometric/sync
      const syncReq = createMockRequest(biometricEditAdminActor, {
        body: {
          allowHistorical: true,
          fromPunchTime: '2026-11-19',
          toPunchTime: '2026-11-21',
        },
      });
      const syncRes = createMockResponse();
      await BiometricController.triggerSync(syncReq, syncRes as unknown as Response);
      expect(syncRes.statusCode).toBe(403);
      expect(syncRes.body?.error?.code).toBe('BIOMETRIC_HISTORICAL_FORBIDDEN');

      // 4. HTTP Controller POST /api/biometric/devices/:id/sync
      const termReq = createMockRequest(biometricEditAdminActor, {
        params: { id: terminalId },
        body: {
          allowHistorical: true,
          fromPunchTime: '2026-11-19',
          toPunchTime: '2026-11-21',
        },
      });
      const termRes = createMockResponse();
      await BiometricController.syncTerminal(termReq, termRes as unknown as Response);
      expect(termRes.statusCode).toBe(403);
      expect(termRes.body?.error?.code).toBe('BIOMETRIC_HISTORICAL_FORBIDDEN');

      // 5. Query-string override attempt rejected with 400
      const queryOverrideReq = createMockRequest(biometricEditAdminActor, {
        query: { allowHistorical: 'true' },
        body: {},
      });
      const queryOverrideRes = createMockResponse();
      await BiometricController.triggerSync(
        queryOverrideReq,
        queryOverrideRes as unknown as Response
      );
      expect(queryOverrideRes.statusCode).toBe(400);
      expect(queryOverrideRes.body?.error?.code).toBe('VALIDATION_ERROR');

      // Verify ZERO mutations across RawPunchLog, Attendance, and telemetry
      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(attendanceUpdateSpy).not.toHaveBeenCalled();
      expect(telemetryUpsertSpy).not.toHaveBeenCalled();
      expect(punchesStore.every((p) => p.syncStatus === 'PENDING')).toBe(true);
      expect(attendanceStore).toHaveLength(0);
    });

    it('Case 12: SUPER_ADMIN without explicit allowHistorical: true remains strictly cutoff-restricted', async () => {
      const { punchesStore, attendanceStore, observedFindManyWheres, auditLogs } =
        setupInMemoryReconciliationHarness(buildHistoricalSeed());

      const res = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {
          // Even when passing an older fromPunchTime, without allowHistorical: true the cutoff holds
          fromPunchTime: '2026-11-01T00:00:00.000Z',
        },
        superAdminActor
      );

      expect(res.historicalMode).toBe(false);
      expect(res.effectiveCutoffIso).toBe(EXPECTED_IST_CUTOFF_ISO);
      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        EXPECTED_IST_CUTOFF_ISO
      );
      expect(res.totalEvaluated).toBe(1);
      expect(res.results[0].punchId).toBe('today-nov-23');
      expect(punchesStore.find((p) => p.id === 'hist-nov-20')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'hist-nov-10-outside-window')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'today-nov-23')?.syncStatus).toBe('PROCESSED');
      expect(attendanceStore).toHaveLength(1);
      expect(auditLogs.some((l) => l.action === 'BIOMETRIC_HISTORICAL_RECONCILE')).toBe(false);
    });

    it('Case 13: SUPER_ADMIN with explicit allowHistorical: true and valid bounded range is authorized, audited, and strictly bounded', async () => {
      const { punchesStore, attendanceStore, auditLogs, observedFindManyWheres } =
        setupInMemoryReconciliationHarness(buildHistoricalSeed());

      // Reject unbounded historical request (missing toPunchTime)
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            fromPunchTime: '2026-11-19T00:00:00.000Z',
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_HISTORICAL_RANGE_REQUIRED' });

      // Reject inverted historical range (from > to)
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            fromPunchTime: '2026-11-21T00:00:00.000Z',
            toPunchTime: '2026-11-19T00:00:00.000Z',
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_INVALID_HISTORICAL_RANGE' });

      // Reject oversized historical range (> 90 days)
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            fromPunchTime: '2026-01-01T00:00:00.000Z',
            toPunchTime: '2026-11-21T00:00:00.000Z',
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_HISTORICAL_RANGE_TOO_LARGE' });

      // Valid bounded historical reconciliation via controller
      const req = createMockRequest(superAdminActor, {
        body: {
          allowHistorical: true,
          fromPunchTime: '2026-11-19',
          toPunchTime: '2026-11-21',
          terminalId,
        },
      });
      const res = createMockResponse();
      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(res.body.historicalMode).toBe(true);
      expect(res.body.totalEvaluated).toBe(1);
      expect(res.body.processed).toBe(1);
      expect(res.body.results[0].punchId).toBe('hist-nov-20');

      // Verify exact Asia/Kolkata bounded range applied:
      // 2026-11-19 00:00:00 IST -> 2026-11-18T18:30:00.000Z
      // 2026-11-21 23:59:59.999 IST -> 2026-11-21T18:29:59.999Z
      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        '2026-11-18T18:30:00.000Z'
      );
      expect(new Date(observedFindManyWheres[0].punchTime.lte).toISOString()).toBe(
        '2026-11-21T18:29:59.999Z'
      );

      // Only the in-window historical punch was processed; out-of-window punches untouched
      expect(punchesStore.find((p) => p.id === 'hist-nov-20')?.syncStatus).toBe('PROCESSED');
      expect(punchesStore.find((p) => p.id === 'hist-nov-10-outside-window')?.syncStatus).toBe(
        'PENDING'
      );
      expect(punchesStore.find((p) => p.id === 'today-nov-23')?.syncStatus).toBe('PENDING');
      expect(attendanceStore).toHaveLength(1);

      // Verify explicit historical audit log with actor, role, timestamp, scope, and range
      const histAudit = auditLogs.find((l) => l.action === 'BIOMETRIC_HISTORICAL_RECONCILE');
      expect(histAudit).toBeDefined();
      expect(histAudit?.userId).toBe(superAdminActor.userId);
      expect(histAudit?.details).toMatchObject({
        actorUserId: superAdminActor.userId,
        actorRole: 'SUPER_ADMIN',
        companyTimezone: 'Asia/Kolkata',
        requestedFromPunchTime: '2026-11-18T18:30:00.000Z',
        requestedToPunchTime: '2026-11-21T18:29:59.999Z',
        scope: expect.objectContaining({
          terminalId,
        }),
      });
      expect(typeof histAudit?.details?.authorizedAt).toBe('string');
    });
  });

  describe('P0-B Review Corrections — Independent reconcilePunch Cutoff, Unforgeable Windows, Strict Auth & Date Parsing', () => {
    const buildDirectPunchSeed = (): InMemoryPunch[] => [
      {
        id: 'direct-hist-nov-20',
        companyId,
        terminalId,
        devicePunchId: 'dp-direct-old',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-20T03:30:00.000Z'), // Historical (3 days ago)
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-direct-old',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-20T03:30:00.000Z'),
        updatedAt: new Date('2026-11-20T03:30:00.000Z'),
      },
      {
        id: 'direct-hist-ist-235959',
        companyId,
        terminalId,
        devicePunchId: 'dp-direct-ist-prev',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-22T18:29:59.999Z'), // 1ms before 2026-11-23 00:00:00 IST
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-direct-ist-prev',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-22T18:29:59.999Z'),
        updatedAt: new Date('2026-11-22T18:29:59.999Z'),
      },
      {
        id: 'direct-today-ist-0900',
        companyId,
        terminalId,
        devicePunchId: 'dp-direct-today',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-23T03:30:00.000Z'), // Today 09:00:00 IST
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-direct-today',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-23T03:30:00.000Z'),
        updatedAt: new Date('2026-11-23T03:30:00.000Z'),
      },
    ];

    it('Correction 1 & 2: direct reconcilePunch() without enforcedTimeWindow independently enforces current-company-day cutoff and leaves historical pending punches untouched', async () => {
      const {
        punchesStore,
        attendanceStore,
        rawPunchUpdateSpy,
        attendanceCreateSpy,
        attendanceUpdateSpy,
      } = setupInMemoryReconciliationHarness(buildDirectPunchSeed(), 'Asia/Kolkata');

      // Direct call with NO options on historical punch (3 days old)
      const oldRes = await PunchReconciliationService.reconcilePunch('direct-hist-nov-20');
      expect(oldRes.status).toBe('PENDING');
      expect(oldRes.message).toContain('outside the authorized reconciliation time window');

      // Direct call with NO options on punch 1ms before Asia/Kolkata midnight (18:29:59.999Z)
      const boundaryRes = await PunchReconciliationService.reconcilePunch('direct-hist-ist-235959');
      expect(boundaryRes.status).toBe('PENDING');
      expect(boundaryRes.message).toContain('outside the authorized reconciliation time window');

      // Historical pending punches and Attendance remain completely untouched
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(attendanceUpdateSpy).not.toHaveBeenCalled();
      expect(punchesStore.find((p) => p.id === 'direct-hist-nov-20')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'direct-hist-ist-235959')?.syncStatus).toBe('PENDING');
      expect(attendanceStore).toHaveLength(0);

      // Direct call on eligible current-day punch still succeeds normally
      const todayRes = await PunchReconciliationService.reconcilePunch('direct-today-ist-0900');
      expect(todayRes.status).toBe('PROCESSED');
      expect(punchesStore.find((p) => p.id === 'direct-today-ist-0900')?.syncStatus).toBe('PROCESSED');
      expect(attendanceStore).toHaveLength(1);
    });

    it('Correction 1 & 2: direct reconcilePunch() fails closed on missing/invalid Company timezone even if caller passes spoofed options.companyTimezone', async () => {
      const { rawPunchUpdateSpy, attendanceCreateSpy } = setupInMemoryReconciliationHarness(
        buildDirectPunchSeed(),
        'Asia/Kolkata'
      );

      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: null } as any);
      await expect(
        PunchReconciliationService.reconcilePunch('direct-today-ist-0900', undefined, {
          companyTimezone: 'UTC',
        })
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_MISSING' });

      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Not/A_Zone' } as any);
      await expect(
        PunchReconciliationService.reconcilePunch('direct-today-ist-0900', undefined, {
          companyTimezone: 'Asia/Kolkata',
        })
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_INVALID' });

      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
    });

    it('Correction 1 & 2: direct reconcilePunch() blocks forged enforcedTimeWindow, forged trustedTimeWindow, cross-tenant trustedTimeWindow, and mutated Date bounds', async () => {
      const {
        punchesStore,
        attendanceStore,
        rawPunchUpdateSpy,
        attendanceCreateSpy,
      } = setupInMemoryReconciliationHarness(buildDirectPunchSeed(), 'Asia/Kolkata');

      // 1. Caller attempts to weaken cutoff via enforcedTimeWindow with an old Date
      const weakenedRes = await PunchReconciliationService.reconcilePunch(
        'direct-hist-nov-20',
        undefined,
        {
          enforcedTimeWindow: {
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveTo: new Date('2026-12-31T23:59:59.000Z'),
          },
        }
      );
      expect(weakenedRes.status).toBe('PENDING');

      // 2. Caller attempts to forge a plain trustedTimeWindow object literal
      const forgedRes = await PunchReconciliationService.reconcilePunch(
        'direct-hist-nov-20',
        undefined,
        {
          trustedTimeWindow: {
            companyId,
            mode: 'HISTORICAL',
            companyTimezone: 'Asia/Kolkata',
            currentDayStartUtc: new Date(EXPECTED_IST_CUTOFF_ISO),
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveTo: new Date('2026-12-31T23:59:59.000Z'),
            emptyWindow: false,
          } as any,
        }
      );
      expect(forgedRes.status).toBe('PENDING');

      // 3. Caller attempts cross-tenant replay of a genuinely minted live trusted window for a DIFFERENT company
      const otherCompanyActor = await mintAuthenticatedActor({
        id: 'user-super-other',
        companyId: 'comp-other-tenant',
        role: 'SUPER_ADMIN',
        fullName: 'Other Company Super Admin',
        email: 'other-super@coreerp.test',
        tokenVersion: 1,
      });
      punchesStore.push({
        id: 'other-tenant-hist-punch',
        companyId: 'comp-other-tenant',
        terminalId: 'term-other-tenant',
        devicePunchId: 'dp-other-tenant',
        userEnrollmentId: '901',
        punchTime: new Date('2026-11-20T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-other-tenant-hist',
        matchedEmployeeId: null,
        createdAt: new Date('2026-11-20T03:30:00.000Z'),
        updatedAt: new Date('2026-11-20T03:30:00.000Z'),
      });
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockImplementation((async (args: any) => {
        if (args?.where?.id === terminalId && args?.where?.companyId === companyId) {
          return mockTerminal as any;
        }
        if (
          args?.where?.id === 'term-other-tenant' &&
          args?.where?.companyId === 'comp-other-tenant'
        ) {
          return { ...mockTerminal, id: 'term-other-tenant', companyId: 'comp-other-tenant' } as any;
        }
        return null;
      }) as any);

      const originalReconcilePunch = PunchReconciliationService.reconcilePunch.bind(
        PunchReconciliationService
      );
      let crossTenantInterceptionRan = false;
      let crossTenantRes: any = null;
      const crossTenantSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePunch')
        .mockImplementation(async (_pId, _corrId, opts) => {
          crossTenantInterceptionRan = true;
          crossTenantRes = await originalReconcilePunch('direct-hist-nov-20', undefined, {
            trustedTimeWindow: opts?.trustedTimeWindow,
          });
          return crossTenantRes;
        });

      await PunchReconciliationService.reconcilePendingPunches(
        'comp-other-tenant',
        {
          allowHistorical: true,
          terminalId: 'term-other-tenant',
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        },
        otherCompanyActor
      );
      crossTenantSpy.mockRestore();
      expect(crossTenantInterceptionRan).toBe(true);
      expect(crossTenantRes.status).toBe('PENDING');

      // 4. Caller mutates Date object on a genuinely minted live CURRENT_DAY window to try widening it into history
      let mutatedInterceptionRan = false;
      let mutatedRes: any = null;
      const mutatedSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePunch')
        .mockImplementation(async (_pId, _corrId, opts) => {
          mutatedInterceptionRan = true;
          opts!.trustedTimeWindow!.effectiveFrom.setUTCFullYear(2020);
          mutatedRes = await originalReconcilePunch('direct-hist-nov-20', undefined, {
            trustedTimeWindow: opts?.trustedTimeWindow,
          });
          return mutatedRes;
        });

      await PunchReconciliationService.reconcilePendingPunches(companyId, {}, superAdminActor);
      mutatedSpy.mockRestore();
      expect(mutatedInterceptionRan).toBe(true);
      expect(mutatedRes.status).toBe('PENDING');

      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(punchesStore.find((p) => p.id === 'direct-hist-nov-20')?.syncStatus).toBe('PENDING');
      expect(attendanceStore).toHaveLength(0);
    });

    it('Correction 3: rejects plain user ID strings, partial objects, cross-tenant, inactive, and preview SUPER_ADMIN actors for historical mode', async () => {
      const {
        rawPunchFindManySpy,
        rawPunchUpdateSpy,
        attendanceCreateSpy,
        auditLogs,
      } = setupInMemoryReconciliationHarness(buildDirectPunchSeed(), 'Asia/Kolkata');

      const historicalOpts = {
        allowHistorical: true,
        fromPunchTime: '2026-11-19T00:00:00.000Z',
        toPunchTime: '2026-11-21T23:59:59.000Z',
      };

      // Plain user ID string (must NEVER be treated as SUPER_ADMIN)
      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, historicalOpts, 'user-super-1')
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // String literally named 'SUPER_ADMIN'
      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, historicalOpts, 'SUPER_ADMIN')
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // Undefined actor
      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, historicalOpts, undefined)
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // Partial untrusted object missing companyId / isActive: true
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          historicalOpts,
          { userId: 'user-super-1', role: 'SUPER_ADMIN' }
        )
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // Cross-company SUPER_ADMIN
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          historicalOpts,
          { ...superAdminActor, companyId: 'comp-different-tenant' }
        )
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // Inactive SUPER_ADMIN
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          historicalOpts,
          { ...superAdminActor, isActive: false }
        )
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // Preview-mode SUPER_ADMIN
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          historicalOpts,
          { ...superAdminActor, isPreview: true }
        )
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // Employee mapping path with plain string user ID also rejects historical mode
      await expect(
        PunchReconciliationService.reconcileForEmployeeMapping(
          companyId,
          terminalId,
          '101',
          'user-super-1',
          undefined,
          historicalOpts
        )
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('Correction 4: service layer rejects ambiguous date-only strings and offset-less timestamps while accepting trusted Date objects and explicit-offset ISO-8601', async () => {
      const {
        punchesStore,
        rawPunchFindManySpy,
        rawPunchUpdateSpy,
        attendanceCreateSpy,
      } = setupInMemoryReconciliationHarness(buildDirectPunchSeed(), 'Asia/Kolkata');

      // Ambiguous date-only strings in historical mode -> 400 VALIDATION_ERROR
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            fromPunchTime: '2026-11-19',
            toPunchTime: '2026-11-21',
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

      // Offset-less naive timestamps in historical mode -> 400 VALIDATION_ERROR
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            fromPunchTime: '2026-11-19T00:00:00',
            toPunchTime: '2026-11-21T23:59:59',
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

      // Ambiguous date-only string in normal mode -> 400 VALIDATION_ERROR
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { fromPunchTime: '2026-11-23' },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

      // Invalid calendar date with explicit Z offset -> 400 VALIDATION_ERROR
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            fromPunchTime: '2026-02-30T00:00:00Z',
            toPunchTime: '2026-03-01T00:00:00Z',
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();

      // Explicit timezone offset (+05:30) and already-converted Date objects succeed when bounded <= 90d and explicitly scoped
      const offsetRes = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {
          allowHistorical: true,
          terminalId,
          fromPunchTime: '2026-11-20T00:00:00+05:30',
          toPunchTime: new Date('2026-11-20T18:29:59.999Z'),
        },
        superAdminActor
      );
      expect(offsetRes.historicalMode).toBe(true);
      expect(offsetRes.totalEvaluated).toBe(1);
      expect(offsetRes.processed).toBe(1);
      expect(offsetRes.results[0].punchId).toBe('direct-hist-nov-20');
      expect(punchesStore.find((p) => p.id === 'direct-hist-nov-20')?.syncStatus).toBe('PROCESSED');
    });

    it('Correction 5: BiometricService.triggerTerminalSync validates role and historical range BEFORE terminal lookup and never mutates telemetry on timezone failure', async () => {
      const {
        rawPunchFindManySpy,
        rawPunchUpdateSpy,
        attendanceCreateSpy,
      } = setupInMemoryReconciliationHarness(buildDirectPunchSeed(), 'Asia/Kolkata');

      const terminalFindSpy = vi
        .spyOn(prisma.biometricTerminal, 'findFirst')
        .mockResolvedValue(mockTerminal as any);
      const telemetryUpsertSpy = vi.spyOn(prisma.companySetting, 'upsert');
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');

      // 1. Non-SUPER_ADMIN historical request fails BEFORE terminal lookup
      await expect(
        BiometricService.triggerTerminalSync(biometricEditAdminActor, terminalId, {
          allowHistorical: true,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });
      expect(terminalFindSpy).not.toHaveBeenCalled();

      // 2. SUPER_ADMIN with ambiguous date-only string fails BEFORE terminal lookup
      await expect(
        BiometricService.triggerTerminalSync(superAdminActor, terminalId, {
          allowHistorical: true,
          fromPunchTime: '2026-11-19',
          toPunchTime: '2026-11-21',
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect(terminalFindSpy).not.toHaveBeenCalled();

      // 3. SUPER_ADMIN with unbounded range (missing toPunchTime) fails BEFORE terminal lookup
      await expect(
        BiometricService.triggerTerminalSync(superAdminActor, terminalId, {
          allowHistorical: true,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_HISTORICAL_RANGE_REQUIRED' });
      expect(terminalFindSpy).not.toHaveBeenCalled();

      // 4. SUPER_ADMIN with >90-day range fails BEFORE terminal lookup
      await expect(
        BiometricService.triggerTerminalSync(superAdminActor, terminalId, {
          allowHistorical: true,
          fromPunchTime: '2026-01-01T00:00:00.000Z',
          toPunchTime: '2026-11-21T00:00:00.000Z',
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_HISTORICAL_RANGE_TOO_LARGE' });
      expect(terminalFindSpy).not.toHaveBeenCalled();

      // 5. SUPER_ADMIN with valid range but missing Company timezone fails BEFORE telemetry mutation or reconciliation
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: null } as any);
      await expect(
        BiometricService.triggerTerminalSync(superAdminActor, terminalId, {
          allowHistorical: true,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        })
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_MISSING' });
      expect(terminalFindSpy).toHaveBeenCalledTimes(1);
      expect(telemetryUpsertSpy).not.toHaveBeenCalled();
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
    });
  });

  describe('F1–F6 Security Review Remediations', () => {
    const buildF1ToF6Seed = (): InMemoryPunch[] => [
      {
        id: 'f-hist-nov-20',
        companyId,
        terminalId,
        devicePunchId: 'dp-f-nov-20',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-20T03:30:00.000Z'), // Historical (in 19–21 Nov window)
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-f-nov-20',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-20T03:30:00.000Z'),
        updatedAt: new Date('2026-11-20T03:30:00.000Z'),
      },
      {
        id: 'f-hist-nov-20-second',
        companyId,
        terminalId,
        devicePunchId: 'dp-f-nov-20-2',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-20T05:00:00.000Z'), // Second historical punch
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_OUT',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-f-nov-20-2',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-20T05:00:00.000Z'),
        updatedAt: new Date('2026-11-20T05:00:00.000Z'),
      },
      {
        id: 'f-hist-nov-10-outside',
        companyId,
        terminalId,
        devicePunchId: 'dp-f-nov-10',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-10T03:30:00.000Z'), // Outside 19–21 Nov window
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-f-nov-10',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-10T03:30:00.000Z'),
        updatedAt: new Date('2026-11-10T03:30:00.000Z'),
      },
      {
        id: 'f-today-emp101',
        companyId,
        terminalId,
        devicePunchId: 'dp-f-today-101',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-23T03:30:00.000Z'), // Valid current-day 09:00 IST
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-f-today-101',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-23T03:30:00.000Z'),
        updatedAt: new Date('2026-11-23T03:30:00.000Z'),
      },
      {
        id: 'f-today-emp202-matched',
        companyId,
        terminalId,
        devicePunchId: 'dp-f-today-202-m',
        userEnrollmentId: '202',
        punchTime: new Date('2026-11-23T03:35:00.000Z'), // Pre-matched to otherEmployee
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-f-today-202-m',
        matchedEmployeeId: otherEmployee.id,
        createdAt: new Date('2026-11-23T03:35:00.000Z'),
        updatedAt: new Date('2026-11-23T03:35:00.000Z'),
      },
      {
        id: 'f-today-emp202-unmapped',
        companyId,
        terminalId,
        devicePunchId: 'dp-f-today-202-u',
        userEnrollmentId: '202',
        punchTime: new Date('2026-11-23T03:40:00.000Z'), // Unmapped; resolves to otherEmployee
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-f-today-202-u',
        matchedEmployeeId: null,
        createdAt: new Date('2026-11-23T03:40:00.000Z'),
        updatedAt: new Date('2026-11-23T03:40:00.000Z'),
      },
      {
        id: 'f-future-punch',
        companyId,
        terminalId,
        devicePunchId: 'dp-f-future',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-23T04:10:00.000Z'), // +10m beyond FIXED_NOW_UTC (skew is +5m)
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-f-future',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-23T04:10:00.000Z'),
        updatedAt: new Date('2026-11-23T04:10:00.000Z'),
      },
    ];

    it('F1: rejects caller-forged objects, shallow clones, prototype-inherited actors, and PreviewAuthService users with 403 and zero DB queries/mutations', async () => {
      const {
        userFindUniqueSpy,
        telemetryUpsertSpy,
        rawPunchFindManySpy,
        rawPunchUpdateSpy,
        attendanceCreateSpy,
        punchesStore,
      } = setupInMemoryReconciliationHarness(buildF1ToF6Seed(), 'Asia/Kolkata');

      const historicalOpts = {
        allowHistorical: true,
        fromPunchTime: '2026-11-19T00:00:00.000Z',
        toPunchTime: '2026-11-21T23:59:59.000Z',
      };

      const plainForgedSuperAdmin: AuthUser = {
        id: 'user-super-1',
        userId: 'user-super-1',
        companyId,
        role: 'SUPER_ADMIN',
        fullName: 'Forged Plain Object',
        email: 'forged@coreerp.test',
        isActive: true,
        tokenVersion: 1,
      };

      const shallowClonedSuperAdmin: AuthUser = { ...superAdminActor };

      const prototypeForgedSuperAdmin = Object.create({
        id: 'user-super-1',
        userId: 'user-super-1',
        companyId,
        role: 'SUPER_ADMIN',
        fullName: 'Proto Forged',
        email: 'proto@coreerp.test',
        isActive: true,
        tokenVersion: 1,
      }) as AuthUser;

      const previewSession = PreviewAuthService.authenticatePreview({
        id: 'preview_admin',
        password: 'PreviewOnly_2026!',
      });
      const previewSameCompany = { ...previewSession.user, companyId };

      for (const untrustedActor of [
        plainForgedSuperAdmin,
        shallowClonedSuperAdmin,
        prototypeForgedSuperAdmin,
        previewSession.user,
        previewSameCompany,
      ]) {
        expect(AuthService.getAuthenticatedActorProvenance(untrustedActor)).toBeNull();

        await expect(
          PunchReconciliationService.reconcilePendingPunches(companyId, historicalOpts, untrustedActor)
        ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

        await expect(
          BiometricService.triggerTerminalSync(untrustedActor, terminalId, historicalOpts)
        ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

        const syncRes = createMockResponse();
        await BiometricController.triggerSync(
          createMockRequest(untrustedActor, {
            body: {
              allowHistorical: true,
              fromPunchTime: '2026-11-19',
              toPunchTime: '2026-11-21',
            },
          }),
          syncRes as unknown as Response
        );
        expect(syncRes.statusCode).toBe(403);
        expect(syncRes.body?.error?.code).toBe('BIOMETRIC_HISTORICAL_FORBIDDEN');

        const termRes = createMockResponse();
        await BiometricController.syncTerminal(
          createMockRequest(untrustedActor, {
            params: { id: terminalId },
            body: {
              allowHistorical: true,
              fromPunchTime: '2026-11-19',
              toPunchTime: '2026-11-21',
            },
          }),
          termRes as unknown as Response
        );
        expect(termRes.statusCode).toBe(403);
        expect(termRes.body?.error?.code).toBe('BIOMETRIC_HISTORICAL_FORBIDDEN');
      }

      // Synchronous pre-DB provenance gate must prevent ANY database query or mutation
      expect(userFindUniqueSpy).not.toHaveBeenCalled();
      expect(telemetryUpsertSpy).not.toHaveBeenCalled();
      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(punchesStore.every((p) => p.syncStatus === 'PENDING')).toBe(true);
    });

    it('F1: live DB re-verification rejects revoked tokenVersion, demoted role, deactivated user, reassigned company, and DB failure fail-closed', async () => {
      const {
        userStore,
        userFindUniqueSpy,
        telemetryUpsertSpy,
        rawPunchFindManySpy,
        rawPunchUpdateSpy,
        attendanceCreateSpy,
      } = setupInMemoryReconciliationHarness(buildF1ToF6Seed(), 'Asia/Kolkata');

      const historicalOpts = {
        allowHistorical: true,
        terminalId,
        fromPunchTime: '2026-11-19T00:00:00.000Z',
        toPunchTime: '2026-11-21T23:59:59.000Z',
      };

      // 1. Revoked session (tokenVersion incremented on logout)
      userStore.set('user-super-1', {
        id: 'user-super-1',
        companyId,
        role: 'SUPER_ADMIN',
        isActive: true,
        tokenVersion: 2,
      });
      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, historicalOpts, superAdminActor)
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });
      await expect(
        BiometricService.triggerTerminalSync(superAdminActor, terminalId, historicalOpts)
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // 2. Role demoted from SUPER_ADMIN -> ADMIN
      userStore.set('user-super-1', {
        id: 'user-super-1',
        companyId,
        role: 'ADMIN',
        isActive: true,
        tokenVersion: 1,
      });
      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, historicalOpts, superAdminActor)
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // 3. Deactivated account
      userStore.set('user-super-1', {
        id: 'user-super-1',
        companyId,
        role: 'SUPER_ADMIN',
        isActive: false,
        tokenVersion: 1,
      });
      await expect(
        BiometricService.triggerTerminalSync(superAdminActor, terminalId, historicalOpts)
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // 4. Company reassigned
      userStore.set('user-super-1', {
        id: 'user-super-1',
        companyId: 'comp-other-tenant',
        role: 'SUPER_ADMIN',
        isActive: true,
        tokenVersion: 1,
      });
      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, historicalOpts, superAdminActor)
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // 5. Missing user row
      userStore.delete('user-super-1');
      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, historicalOpts, superAdminActor)
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // 6. Live user DB lookup failure -> fails closed with 503
      userFindUniqueSpy.mockRejectedValueOnce(new Error('ECONNRESET database dropped'));
      await expect(
        PunchReconciliationService.reconcilePendingPunches(companyId, historicalOpts, superAdminActor)
      ).rejects.toMatchObject({ statusCode: 503, code: 'BIOMETRIC_HISTORICAL_AUTH_UNAVAILABLE' });

      expect(telemetryUpsertSpy).not.toHaveBeenCalled();
      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
    });

    it('F2: removes public resolveReconciliationTimeWindow, eliminates db/referenceNow overrides, and ensures evaluateReconciliationWindow never mints a trusted window', async () => {
      const { punchesStore, rawPunchUpdateSpy, attendanceCreateSpy } =
        setupInMemoryReconciliationHarness(buildF1ToF6Seed(), 'Asia/Kolkata');

      // Legacy unguarded minter and generic callback minter must no longer exist on module exports
      expect('resolveReconciliationTimeWindow' in biometricSafety).toBe(false);
      expect('withTrustedReconciliationWindow' in biometricSafety).toBe(false);
      expect('verifyTrustedReconciliationTimeWindow' in biometricSafety).toBe(false);

      // Strict arity: evaluateReconciliationWindow does not accept db/referenceNow overrides
      expect(evaluateReconciliationWindow.length).toBe(3);

      // Extra spoofed db + backdated referenceNow arguments are ignored; real prisma & server clock govern
      const spoofedDb = { company: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) } };
      const backdatedClock = new Date('2020-01-01T00:00:00.000Z');
      const evaluatedNormal = await (evaluateReconciliationWindow as any)(
        companyId,
        {},
        superAdminActor,
        spoofedDb,
        backdatedClock
      );
      expect(spoofedDb.company.findUnique).not.toHaveBeenCalled();
      expect(evaluatedNormal.companyTimezone).toBe('Asia/Kolkata');
      expect(evaluatedNormal.effectiveFrom.toISOString()).toBe(EXPECTED_IST_CUTOFF_ISO);
      expect(evaluatedNormal.effectiveTo.toISOString()).toBe('2026-11-23T04:05:00.000Z');

      // Non-minting evaluateReconciliationWindow output (even for authorized historical SUPER_ADMIN)
      // is NOT registered in trustedWindowRegistry and cannot reconcile historical punches
      const evaluatedHistorical = await evaluateReconciliationWindow(
        companyId,
        {
          allowHistorical: true,
          terminalId,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        },
        superAdminActor
      );
      expect(evaluatedHistorical.mode).toBe('HISTORICAL');

      const rejectedRes = await PunchReconciliationService.reconcilePunch(
        'f-hist-nov-20',
        undefined,
        { trustedTimeWindow: evaluatedHistorical as any }
      );
      expect(rejectedRes.status).toBe('PENDING');
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(punchesStore.find((p) => p.id === 'f-hist-nov-20')?.syncStatus).toBe('PENDING');
    });

    it('F3: revokes trusted windows immediately after batch completion, expires them past TTL, invalidates CURRENT_DAY windows across local midnight, and enforces batch scope without mutating RawPunchLog', async () => {
      const { punchesStore, rawPunchUpdateSpy, attendanceCreateSpy } =
        setupInMemoryReconciliationHarness(buildF1ToF6Seed(), 'Asia/Kolkata');

      // 1. Post-batch revocation: capture trustedTimeWindow passed to reconcilePunch during an authorized historical batch
      let capturedTrustedWindow: any = null;
      const originalReconcilePunch = PunchReconciliationService.reconcilePunch.bind(
        PunchReconciliationService
      );
      const reconcilePunchSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePunch')
        .mockImplementation(async (punchId, corrId, opts) => {
          if (opts?.trustedTimeWindow) {
            capturedTrustedWindow = opts.trustedTimeWindow;
          }
          return originalReconcilePunch(punchId, corrId, opts);
        });

      const batchRes = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {
          allowHistorical: true,
          terminalId,
          batchSize: 1,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        },
        superAdminActor
      );
      reconcilePunchSpy.mockRestore();

      expect(batchRes.processed).toBe(1);
      expect(batchRes.results[0].punchId).toBe('f-hist-nov-20');
      expect(capturedTrustedWindow).toBeTruthy();

      // Replaying capturedTrustedWindow after batch returns must fail closed even when company,
      // terminal scope, date range, and TTL all match f-hist-nov-20-second (isolating revocation)
      rawPunchUpdateSpy.mockClear();
      attendanceCreateSpy.mockClear();
      const replayAfterBatchRes = await PunchReconciliationService.reconcilePunch(
        'f-hist-nov-20-second',
        undefined,
        { trustedTimeWindow: capturedTrustedWindow }
      );
      expect(replayAfterBatchRes.status).toBe('PENDING');
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();

      // 2. TTL expiry: advancing fake timer past TRUSTED_WINDOW_TTL_MS invalidates an active live trusted window
      let ttlRan = false;
      let ttlExpiredRes: any = null;
      const ttlSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePunch')
        .mockImplementation(async (_pId, _corrId, opts) => {
          ttlRan = true;
          vi.advanceTimersByTime(TRUSTED_WINDOW_TTL_MS + 1000);
          ttlExpiredRes = await originalReconcilePunch('f-hist-nov-20-second', undefined, {
            trustedTimeWindow: opts?.trustedTimeWindow,
          });
          return ttlExpiredRes;
        });

      await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {
          allowHistorical: true,
          terminalId,
          batchSize: 1,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        },
        superAdminActor
      );
      ttlSpy.mockRestore();
      expect(ttlRan).toBe(true);
      expect(ttlExpiredRes.status).toBe('PENDING');
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();

      // 3. Local-midnight rollover: CURRENT_DAY window minted at 23:59 IST is invalidated at 00:01 IST next day (within 5m TTL!)
      vi.setSystemTime(new Date('2026-11-23T18:29:00.000Z')); // 2026-11-23 23:59:00 IST
      const lateNightPunch: InMemoryPunch = {
        id: 'f-late-night-nov23',
        companyId,
        terminalId,
        devicePunchId: 'dp-late-night',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-23T18:25:00.000Z'), // 23:55:00 IST on Nov 23
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-late-night',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-23T18:25:00.000Z'),
        updatedAt: new Date('2026-11-23T18:25:00.000Z'),
      };
      punchesStore.push(lateNightPunch);

      let rolloverRan = false;
      let rolloverRes: any = null;
      const rolloverSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePunch')
        .mockImplementation(async (_pId, _corrId, opts) => {
          rolloverRan = true;
          // Advance only 2 minutes (still well within 5-minute TTL, but crossed Asia/Kolkata midnight!)
          vi.advanceTimersByTime(2 * 60 * 1000);
          rolloverRes = await originalReconcilePunch('f-late-night-nov23', undefined, {
            trustedTimeWindow: opts?.trustedTimeWindow,
          });
          return rolloverRes;
        });

      await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        { punchId: 'f-late-night-nov23' },
        superAdminActor
      );
      rolloverSpy.mockRestore();
      expect(rolloverRan).toBe(true);
      expect(rolloverRes.status).toBe('PENDING');
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();

      // Restore fixed test clock for scope tests
      vi.setSystemTime(FIXED_NOW_UTC);

      // Helper to intercept a live private trusted window from a real reconcilePendingPunches run
      const runWithLiveWindow = async (
        runOpts: Record<string, any>,
        fn: (liveWin: any) => Promise<any>
      ) => {
        let ran = false;
        let out: any = null;
        const spy = vi
          .spyOn(PunchReconciliationService, 'reconcilePunch')
          .mockImplementation(async (_pId, _corrId, opts) => {
            if (!ran) {
              ran = true;
              out = await fn(opts?.trustedTimeWindow);
            }
            return {
              punchId: _pId,
              userEnrollmentId: '',
              matchedEmployeeId: null,
              workDate: null,
              status: 'PENDING',
              message: 'intercepted-for-scope-check',
            };
          });
        try {
          await PunchReconciliationService.reconcilePendingPunches(
            companyId,
            runOpts,
            superAdminActor
          );
        } finally {
          spy.mockRestore();
        }
        expect(ran).toBe(true);
        return out;
      };

      // 4. Scope mismatch: punchId, terminalId, userEnrollmentId, and employeeId (pre-matched + previously unmapped)
      const wrongPunchScopeRes = await runWithLiveWindow(
        { punchId: 'f-today-emp101' },
        (win) =>
          originalReconcilePunch('f-today-emp202-matched', undefined, {
            trustedTimeWindow: win,
          })
      );
      expect(wrongPunchScopeRes.status).toBe('PENDING');

      punchesStore.push({
        id: 'f-today-other-gate',
        companyId,
        terminalId: 'term-different-gate',
        devicePunchId: 'dp-other-gate',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-23T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-other-gate',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-23T03:30:00.000Z'),
        updatedAt: new Date('2026-11-23T03:30:00.000Z'),
      });
      const wrongTerminalScopeRes = await runWithLiveWindow(
        { terminalId: 'term-different-gate' },
        (win) =>
          originalReconcilePunch('f-today-emp101', undefined, {
            trustedTimeWindow: win,
          })
      );
      expect(wrongTerminalScopeRes.status).toBe('PENDING');

      punchesStore.push({
        id: 'f-today-enroll-999',
        companyId,
        terminalId,
        devicePunchId: 'dp-enroll-999',
        userEnrollmentId: '999',
        punchTime: new Date('2026-11-23T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-enroll-999',
        matchedEmployeeId: null,
        createdAt: new Date('2026-11-23T03:30:00.000Z'),
        updatedAt: new Date('2026-11-23T03:30:00.000Z'),
      });
      const wrongEnrollmentScopeRes = await runWithLiveWindow(
        { userEnrollmentId: '999' },
        (win) =>
          originalReconcilePunch('f-today-emp101', undefined, {
            trustedTimeWindow: win,
          })
      );
      expect(wrongEnrollmentScopeRes.status).toBe('PENDING');

      // Employee scope must reject pre-matched punch belonging to another employee
      const wrongMatchedEmpRes = await runWithLiveWindow(
        { employeeId: activeEmployee.id },
        (win) =>
          originalReconcilePunch('f-today-emp202-matched', undefined, {
            trustedTimeWindow: win,
          })
      );
      expect(wrongMatchedEmpRes.status).toBe('PENDING');

      // Employee scope must reject previously unmapped punch resolving to another employee BEFORE mutating matchedEmployeeId
      const wrongUnmappedEmpRes = await runWithLiveWindow(
        { employeeId: activeEmployee.id },
        (win) =>
          originalReconcilePunch('f-today-emp202-unmapped', undefined, {
            trustedTimeWindow: win,
          })
      );
      expect(wrongUnmappedEmpRes.status).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'f-today-emp202-unmapped')?.matchedEmployeeId).toBeNull();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
    });

    it('F4: fails closed with 400 VALIDATION_ERROR on malformed, prototype-inherited, or reversed enforcedTimeWindow with zero DB mutations', async () => {
      const { rawPunchUpdateSpy, attendanceCreateSpy } = setupInMemoryReconciliationHarness(
        buildF1ToF6Seed(),
        'Asia/Kolkata'
      );
      const txSpy = vi.spyOn(prisma, '$transaction');

      const invalidWindows: unknown[] = [
        null,
        '2026-11-23T00:00:00.000Z',
        [],
        {},
        { effectiveFrom: new Date('invalid') },
        { effectiveFrom: '2026-11-23T00:00:00.000Z' },
        { effectiveFrom: new Date('2026-11-23T00:00:00.000Z'), effectiveTo: new Date('invalid') },
        { effectiveFrom: new Date('2026-11-23T00:00:00.000Z'), effectiveTo: '2026-11-23T04:00:00.000Z' },
        Object.create({ effectiveFrom: new Date('2026-11-23T00:00:00.000Z') }),
        {
          effectiveFrom: new Date('2026-11-23T04:00:00.000Z'),
          effectiveTo: new Date('2026-11-23T03:00:00.000Z'),
        },
      ];

      for (const badWindow of invalidWindows) {
        await expect(
          PunchReconciliationService.reconcilePunch('f-today-emp101', undefined, {
            enforcedTimeWindow: badWindow as any,
          })
        ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      }

      expect(txSpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
    });

    it('F5: enforces current-day upper bound during ingestion & reconciliation (with +5m skew and local-day-end cap) and intersects enforcedTimeWindow strictly with trustedTimeWindow', async () => {
      // 1. Upper-bound calculation determinism: +5m skew normally, capped at local day end near IST midnight
      expect(CURRENT_DAY_FUTURE_CLOCK_SKEW_MS).toBe(5 * 60 * 1000);
      expect(
        computeCurrentDayUpperBoundUtc('Asia/Kolkata', new Date('2026-11-23T04:00:00.000Z')).toISOString()
      ).toBe('2026-11-23T04:05:00.000Z');
      expect(
        computeCurrentDayUpperBoundUtc('Asia/Kolkata', new Date('2026-11-23T18:28:00.000Z')).toISOString()
      ).toBe('2026-11-23T18:29:59.999Z');

      // 2. Ingestion accepts +4m punch within skew, rejects +6m and next-day punches as rejectedFuture
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Asia/Kolkata' } as any);
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValue([]);
      vi.spyOn(BiometricMappingService, 'resolveBatchForTerminal').mockResolvedValue(
        new Map([['101', activeEmployee.id]])
      );
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.companySetting, 'upsert').mockResolvedValue({} as any);
      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);
      const createManySpy = vi.fn().mockResolvedValue({ count: 1 });
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) =>
        cb({
          rawPunchLog: { createMany: createManySpy },
          biometricTerminal: { update: vi.fn().mockResolvedValue({}) },
        })
      );

      const ingestRes = await BiometricService.ingestPunches(mockTerminal, {
        deviceSerialNumber: 'NFZ8252800275',
        punches: [
          {
            devicePunchId: 'p-within-skew',
            userEnrollmentId: '101',
            punchTime: '2026-11-23T04:04:00.000Z', // +4m (allowed)
          },
          {
            devicePunchId: 'p-beyond-skew',
            userEnrollmentId: '101',
            punchTime: '2026-11-23T04:06:00.000Z', // +6m (rejected future)
          },
          {
            devicePunchId: 'p-tomorrow',
            userEnrollmentId: '101',
            punchTime: '2026-11-24T03:30:00.000Z', // Tomorrow (rejected future)
          },
        ],
      });

      expect(ingestRes.inserted).toBe(1);
      expect(ingestRes.rejectedHistorical).toBe(0);
      expect(ingestRes.rejectedFuture).toBe(2);
      expect(ingestRes.effectiveUpperBoundIso).toBe('2026-11-23T04:05:00.000Z');
      expect(createManySpy.mock.calls[0][0].data).toHaveLength(1);
      expect(createManySpy.mock.calls[0][0].data[0].devicePunchId).toBe('p-within-skew');

      // 3. Direct reconcilePunch and reconcilePendingPunches both block future-dated pending punches
      const { punchesStore, observedFindManyWheres } = setupInMemoryReconciliationHarness(
        buildF1ToF6Seed(),
        'Asia/Kolkata'
      );

      const directFutureRes = await PunchReconciliationService.reconcilePunch('f-future-punch');
      expect(directFutureRes.status).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'f-future-punch')?.syncStatus).toBe('PENDING');

      const bulkRes = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        { userEnrollmentId: '101' },
        biometricEditAdminActor
      );
      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        EXPECTED_IST_CUTOFF_ISO
      );
      expect(new Date(observedFindManyWheres[0].punchTime.lte).toISOString()).toBe(
        '2026-11-23T04:05:00.000Z'
      );
      expect(bulkRes.totalEvaluated).toBe(1);
      expect(bulkRes.results[0].punchId).toBe('f-today-emp101');
      expect(punchesStore.find((p) => p.id === 'f-future-punch')?.syncStatus).toBe('PENDING');

      // 4. Intersection of trustedTimeWindow + enforcedTimeWindow: can only tighten, never broaden
      const originalReconcilePunch = PunchReconciliationService.reconcilePunch.bind(
        PunchReconciliationService
      );
      let intersectionRan = false;
      let intersectionResults: { tightened: any; broadened: any; emptyIntersection: any } | null =
        null;

      const intersectionSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePunch')
        .mockImplementation(async (pId, _corrId, opts) => {
          if (!intersectionRan) {
            intersectionRan = true;
            const histTrustedWin = opts?.trustedTimeWindow;
            // Tightened enforcedTimeWindow excludes 03:30Z punch even though it is inside trustedTimeWindow
            const tightened = await originalReconcilePunch('f-hist-nov-20', undefined, {
              trustedTimeWindow: histTrustedWin,
              enforcedTimeWindow: {
                effectiveFrom: new Date('2026-11-20T04:00:00.000Z'),
                effectiveTo: new Date('2026-11-20T06:00:00.000Z'),
              },
            });

            // Broadened enforcedTimeWindow CANNOT widen trustedTimeWindow to reconcile Nov 10 punch
            const broadened = await originalReconcilePunch('f-hist-nov-10-outside', undefined, {
              trustedTimeWindow: histTrustedWin,
              enforcedTimeWindow: {
                effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
                effectiveTo: new Date('2026-11-30T23:59:59.000Z'),
              },
            });

            // Disjoint (empty) intersection leaves punch untouched
            const emptyIntersection = await originalReconcilePunch('f-hist-nov-20', undefined, {
              trustedTimeWindow: histTrustedWin,
              enforcedTimeWindow: {
                effectiveFrom: new Date('2026-11-22T00:00:00.000Z'),
                effectiveTo: new Date('2026-11-22T23:59:59.000Z'),
              },
            });

            intersectionResults = { tightened, broadened, emptyIntersection };
          }
          return {
            punchId: pId,
            userEnrollmentId: '',
            matchedEmployeeId: null,
            workDate: null,
            status: 'PENDING',
            message: 'intercepted-for-intersection-check',
          };
        });

      await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {
          allowHistorical: true,
          terminalId,
          batchSize: 10,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        },
        superAdminActor
      );
      intersectionSpy.mockRestore();

      expect(intersectionRan).toBe(true);
      expect(intersectionResults!.tightened.status).toBe('PENDING');
      expect(intersectionResults!.broadened.status).toBe('PENDING');
      expect(intersectionResults!.emptyIntersection.status).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'f-hist-nov-20')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'f-hist-nov-10-outside')?.syncStatus).toBe('PENDING');
    });

    it('F6: BiometricService.triggerTerminalSync and BiometricController.syncTerminal reject empty/reversed clamped windows with 400 BIOMETRIC_EMPTY_RECONCILIATION_WINDOW BEFORE mutating telemetry or reconciling', async () => {
      const {
        telemetryUpsertSpy,
        rawPunchFindManySpy,
        rawPunchUpdateSpy,
        attendanceCreateSpy,
      } = setupInMemoryReconciliationHarness(buildF1ToF6Seed(), 'Asia/Kolkata');

      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');

      // 1. Normal mode with toPunchTime strictly older than today's IST cutoff -> empty after clamping
      await expect(
        BiometricService.triggerTerminalSync(biometricEditAdminActor, terminalId, {
          toPunchTime: '2026-11-21T23:59:59.000Z',
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_EMPTY_RECONCILIATION_WINDOW' });

      // 2. Normal mode with fromPunchTime strictly beyond today's upper bound -> empty after clamping
      await expect(
        BiometricService.triggerTerminalSync(biometricEditAdminActor, terminalId, {
          fromPunchTime: '2026-11-25T00:00:00.000Z',
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_EMPTY_RECONCILIATION_WINDOW' });

      // 3. HTTP Controller POST /api/biometric/devices/:id/sync preserves 400 BIOMETRIC_EMPTY_RECONCILIATION_WINDOW
      const res = createMockResponse();
      await BiometricController.syncTerminal(
        createMockRequest(biometricEditAdminActor, {
          params: { id: terminalId },
          body: {
            toPunchTime: '2026-11-21',
          },
        }),
        res as unknown as Response
      );
      expect(res.statusCode).toBe(400);
      expect(res.body?.error?.code).toBe('BIOMETRIC_EMPTY_RECONCILIATION_WINDOW');

      // Verify ZERO telemetry mutation and ZERO reconciliation calls
      expect(telemetryUpsertSpy).not.toHaveBeenCalled();
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
    });
  });

  describe('SEC-1 & SEC-2 Blocking Audit Remediation Regression Tests', () => {
    const buildSecSeed = (): InMemoryPunch[] => [
      {
        id: 'sec-hist-1',
        companyId,
        terminalId,
        devicePunchId: 'dp-sec-hist-1',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-20T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-sec-hist-1',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-20T03:30:00.000Z'),
        updatedAt: new Date('2026-11-20T03:30:00.000Z'),
      },
      {
        id: 'sec-hist-2',
        companyId,
        terminalId,
        devicePunchId: 'dp-sec-hist-2',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-20T05:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_OUT',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-sec-hist-2',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-20T05:30:00.000Z'),
        updatedAt: new Date('2026-11-20T05:30:00.000Z'),
      },
      {
        id: 'sec-today-1',
        companyId,
        terminalId,
        devicePunchId: 'dp-sec-today-1',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-23T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-sec-today-1',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-23T03:30:00.000Z'),
        updatedAt: new Date('2026-11-23T03:30:00.000Z'),
      },
      {
        id: 'sec-other-tenant-punch',
        companyId: 'comp-other-tenant',
        terminalId: 'term-other-tenant',
        devicePunchId: 'dp-sec-other-1',
        userEnrollmentId: '901',
        punchTime: new Date('2026-11-20T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-sec-other-1',
        matchedEmployeeId: null,
        createdAt: new Date('2026-11-20T03:30:00.000Z'),
        updatedAt: new Date('2026-11-20T03:30:00.000Z'),
      },
    ];

    it('SEC-1: fabricated SessionPayload cannot mint provenance to unlock historical reconciliation, while single-use verified payload cannot be replayed', async () => {
      const { userFindUniqueSpy, rawPunchFindManySpy, auditLogs } =
        setupInMemoryReconciliationHarness(buildSecSeed(), 'Asia/Kolkata');

      // 1. Fabricated SessionPayload literal fails closed at validateSessionUser() with zero DB queries
      const forgedActor = await AuthService.validateSessionUser({
        userId: 'user-super-1',
        companyId,
        email: 'super@coreerp.test',
        role: 'SUPER_ADMIN',
        tokenVersion: 1,
        exp: Math.floor(FIXED_NOW_UTC.getTime() / 1000) + 3600,
      });
      expect(forgedActor).toBeNull();
      expect(userFindUniqueSpy).not.toHaveBeenCalled();

      // 2. Real signed token -> verifySessionToken -> validateSessionUser succeeds once, then rejects replay
      const token = AuthService.generateSessionToken({
        userId: 'user-super-1',
        companyId,
        email: 'super@coreerp.test',
        role: 'SUPER_ADMIN',
        tokenVersion: 1,
      });
      const verified = AuthService.verifySessionToken(token)!;
      expect(Object.isFrozen(verified)).toBe(true);

      const firstActor = await AuthService.validateSessionUser(verified);
      expect(firstActor).not.toBeNull();
      expect(AuthService.getAuthenticatedActorProvenance(firstActor)?.role).toBe('SUPER_ADMIN');

      const replayedActor = await AuthService.validateSessionUser(verified);
      expect(replayedActor).toBeNull();

      // 3. Expired verified payload is rejected before DB lookup
      const expiringToken = AuthService.generateSessionToken({
        userId: 'user-super-1',
        companyId,
        email: 'super@coreerp.test',
        role: 'SUPER_ADMIN',
        tokenVersion: 1,
      });
      const expiringVerified = AuthService.verifySessionToken(expiringToken)!;
      vi.advanceTimersByTime((expiringVerified.exp - Math.floor(Date.now() / 1000) + 10) * 1000);
      userFindUniqueSpy.mockClear();
      expect(await AuthService.validateSessionUser(expiringVerified)).toBeNull();
      expect(userFindUniqueSpy).not.toHaveBeenCalled();

      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('SEC-2: exposes no public trusted-window minting or generic callback API on biometric-safety or PunchReconciliationService', () => {
      expect('withTrustedReconciliationWindow' in biometricSafety).toBe(false);
      expect('verifyTrustedReconciliationTimeWindow' in biometricSafety).toBe(false);
      expect('resolveReconciliationTimeWindow' in biometricSafety).toBe(false);
      expect('mintScopedTrustedWindow' in biometricSafety).toBe(false);
      expect('mintScopedTrustedWindow' in PunchReconciliationService).toBe(false);
      expect('verifyTrustedReconciliationTimeWindow' in PunchReconciliationService).toBe(false);
      expect('withTrustedReconciliationWindow' in PunchReconciliationService).toBe(false);
    });

    it('SEC-2: rejects missing or empty historical scope (company-wide historical runs disallowed) at service and HTTP controller layers with zero DB queries or audit logs', async () => {
      const { rawPunchFindManySpy, rawPunchUpdateSpy, attendanceCreateSpy, auditLogs } =
        setupInMemoryReconciliationHarness(buildSecSeed(), 'Asia/Kolkata');

      // 1. Omitted scope at service layer -> 400 BIOMETRIC_HISTORICAL_SCOPE_REQUIRED
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            fromPunchTime: '2026-11-19T00:00:00.000Z',
            toPunchTime: '2026-11-21T23:59:59.000Z',
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_HISTORICAL_SCOPE_REQUIRED' });

      // 2. Whitespace-only filter rejected before DB access
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            terminalId: '   ',
            fromPunchTime: '2026-11-19T00:00:00.000Z',
            toPunchTime: '2026-11-21T23:59:59.000Z',
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400 });

      // 3. HTTP Controller POST /api/biometric/sync without explicit scope -> 400 BIOMETRIC_HISTORICAL_SCOPE_REQUIRED
      const res = createMockResponse();
      await BiometricController.triggerSync(
        createMockRequest(superAdminActor, {
          body: {
            allowHistorical: true,
            fromPunchTime: '2026-11-19',
            toPunchTime: '2026-11-21',
          },
        }),
        res as unknown as Response
      );
      expect(res.statusCode).toBe(400);
      expect(res.body?.error?.code).toBe('BIOMETRIC_HISTORICAL_SCOPE_REQUIRED');

      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('SEC-2: rejects invalid/cross-tenant employee, terminal, punchId, and enrollment targets BEFORE writing BIOMETRIC_HISTORICAL_RECONCILE audit log', async () => {
      const { auditLogs, rawPunchUpdateSpy, attendanceCreateSpy } =
        setupInMemoryReconciliationHarness(buildSecSeed(), 'Asia/Kolkata');

      const baseRange = {
        allowHistorical: true,
        fromPunchTime: '2026-11-19T00:00:00.000Z',
        toPunchTime: '2026-11-21T23:59:59.000Z',
      };

      // 1. Invalid / cross-tenant terminalId -> 404 TERMINAL_NOT_FOUND, zero audit logs
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { ...baseRange, terminalId: 'term-nonexistent-or-other-tenant' },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 404, code: 'TERMINAL_NOT_FOUND' });

      // 2. Invalid / cross-tenant employeeId -> 404 BIOMETRIC_TARGET_NOT_FOUND, zero audit logs
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { ...baseRange, employeeId: 'emp-nonexistent-or-other-tenant' },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 404, code: 'BIOMETRIC_TARGET_NOT_FOUND' });

      // 3. Nonexistent punchId -> 404 BIOMETRIC_TARGET_NOT_FOUND, zero audit logs
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { ...baseRange, punchId: 'punch-does-not-exist' },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 404, code: 'BIOMETRIC_TARGET_NOT_FOUND' });

      // 4. Cross-tenant punchId -> 404 BIOMETRIC_TARGET_NOT_FOUND, zero audit logs
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { ...baseRange, punchId: 'sec-other-tenant-punch' },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 404, code: 'BIOMETRIC_TARGET_NOT_FOUND' });

      // 5. Nonexistent userEnrollmentId -> 404 BIOMETRIC_TARGET_NOT_FOUND, zero audit logs
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { ...baseRange, userEnrollmentId: '999999' },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 404, code: 'BIOMETRIC_TARGET_NOT_FOUND' });

      expect(auditLogs.filter((l) => l.action === 'BIOMETRIC_HISTORICAL_RECONCILE')).toHaveLength(0);
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
    });

    it('SEC-2: writes mandatory BIOMETRIC_HISTORICAL_RECONCILE audit record BEFORE punch queries/mutations and fails closed if audit write fails', async () => {
      const { punchesStore, rawPunchFindManySpy, rawPunchUpdateSpy, attendanceCreateSpy } =
        setupInMemoryReconciliationHarness(buildSecSeed(), 'Asia/Kolkata');

      // 1. Audit failure aborts BEFORE any punch fetch or mutation
      vi.spyOn(AuditService, 'log').mockRejectedValueOnce(new Error('Audit sink offline'));

      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            terminalId,
            fromPunchTime: '2026-11-19T00:00:00.000Z',
            toPunchTime: '2026-11-21T23:59:59.000Z',
          },
          superAdminActor
        )
      ).rejects.toThrow('Audit sink offline');

      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(punchesStore.find((p) => p.id === 'sec-hist-1')?.syncStatus).toBe('PENDING');

      // 2. Strict event ordering: BIOMETRIC_HISTORICAL_RECONCILE precedes rawPunchLog.findMany and attendance.create
      const timeline: string[] = [];
      let capturedAuditEntry: any = null;
      vi.spyOn(AuditService, 'log').mockImplementation(async (entry: any) => {
        timeline.push(`AUDIT:${entry.action}`);
        if (entry.action === 'BIOMETRIC_HISTORICAL_RECONCILE') {
          capturedAuditEntry = entry;
        }
        return {} as any;
      });
      const prevFindManyImpl = rawPunchFindManySpy.getMockImplementation()!;
      rawPunchFindManySpy.mockImplementation((async (args: any) => {
        timeline.push('PUNCH_FIND_MANY');
        return prevFindManyImpl(args);
      }) as any);
      const prevAttCreateImpl = attendanceCreateSpy.getMockImplementation()!;
      attendanceCreateSpy.mockImplementation((async (args: any) => {
        timeline.push('ATTENDANCE_CREATE');
        return prevAttCreateImpl(args);
      }) as any);

      const res = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {
          allowHistorical: true,
          employeeId: activeEmployee.id,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        },
        superAdminActor
      );

      expect(res.processed).toBe(2);
      const histAuditIdx = timeline.indexOf('AUDIT:BIOMETRIC_HISTORICAL_RECONCILE');
      const findManyIdx = timeline.indexOf('PUNCH_FIND_MANY');
      const attCreateIdx = timeline.indexOf('ATTENDANCE_CREATE');
      expect(histAuditIdx).toBeGreaterThanOrEqual(0);
      expect(findManyIdx).toBeGreaterThan(histAuditIdx);
      expect(attCreateIdx).toBeGreaterThan(findManyIdx);

      expect(capturedAuditEntry).toMatchObject({
        companyId,
        userId: superAdminActor.userId,
        action: 'BIOMETRIC_HISTORICAL_RECONCILE',
        details: {
          companyId,
          actorUserId: superAdminActor.userId,
          actorRole: 'SUPER_ADMIN',
          requestedFromPunchTime: '2026-11-19T00:00:00.000Z',
          requestedToPunchTime: '2026-11-21T23:59:59.000Z',
          validatedScope: {
            employeeId: activeEmployee.id,
            terminalId: null,
            userEnrollmentId: null,
            punchId: null,
          },
        },
      });
    });

    it('SEC-2: enforces server-side MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE (100) cap independent of caller batchSize and enforces per-window maxUses budget', async () => {
      expect(MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE).toBe(100);

      // Build 115 historical punches within the valid bounded window (spaced 5m apart, above 2m debounce)
      const bulkHistoricalSeed: InMemoryPunch[] = Array.from({ length: 115 }, (_, idx) => {
        const ts = new Date(Date.UTC(2026, 10, 19, 3, 0, 0) + idx * 5 * 60 * 1000);
        return {
          id: `sec-cap-punch-${idx + 1}`,
          companyId,
          terminalId,
          devicePunchId: `dp-cap-${idx + 1}`,
          userEnrollmentId: '101',
          punchTime: ts,
          verifyType: 'FINGERPRINT',
          inOutMode: idx % 2 === 0 ? 'CHECK_IN' : 'CHECK_OUT',
          syncStatus: 'PENDING',
          errorMessage: null,
          idempotencyKey: `k-cap-${idx + 1}`,
          matchedEmployeeId: activeEmployee.id,
          createdAt: ts,
          updatedAt: ts,
        };
      });

      const { punchesStore, rawPunchFindManySpy, auditLogs } = setupInMemoryReconciliationHarness(
        bulkHistoricalSeed,
        'Asia/Kolkata'
      );

      // Caller requests batchSize: 500 — server MUST cap at MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE (100)
      const cappedRes = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {
          allowHistorical: true,
          terminalId,
          batchSize: 500,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        },
        superAdminActor
      );

      expect(rawPunchFindManySpy.mock.calls[0][0].take).toBe(100);
      expect(cappedRes.totalEvaluated).toBe(100);
      expect(cappedRes.processed).toBe(100);
      expect(punchesStore.filter((p) => p.syncStatus === 'PROCESSED')).toHaveLength(100);
      expect(punchesStore.filter((p) => p.syncStatus === 'PENDING')).toHaveLength(15);

      const histAudit = auditLogs.find((l) => l.action === 'BIOMETRIC_HISTORICAL_RECONCILE');
      expect(histAudit?.details?.scope).toMatchObject({
        batchSize: 100,
        maxBatchLimit: 100,
      });

      // Verify per-window maxUses budget directly: batchSize=1 allows 1 reconcilePunch call,
      // and a 2nd invocation against the SAME live window before finally MUST fail closed!
      const originalReconcilePunch = PunchReconciliationService.reconcilePunch.bind(
        PunchReconciliationService
      );
      let overBudgetRes: any = null;
      const budgetSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePunch')
        .mockImplementation(async (pId, corrId, opts) => {
          const firstRes = await originalReconcilePunch(pId, corrId, opts);
          // Attempt to reuse the SAME live trustedTimeWindow beyond its maxUses=1 budget
          overBudgetRes = await originalReconcilePunch('sec-cap-punch-102', undefined, {
            trustedTimeWindow: opts?.trustedTimeWindow,
          });
          return firstRes;
        });

      const singleBudgetRes = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {
          allowHistorical: true,
          terminalId,
          batchSize: 1,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        },
        superAdminActor
      );
      budgetSpy.mockRestore();

      expect(singleBudgetRes.processed).toBe(1);
      expect(overBudgetRes).not.toBeNull();
      expect(overBudgetRes.status).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'sec-cap-punch-102')?.syncStatus).toBe('PENDING');
    });

    it('SEC-2: revokes trusted windows unconditionally in finally on normal completion, empty result set, and thrown error while keeping current-day reconciliation intact', async () => {
      const { punchesStore, rawPunchUpdateSpy, attendanceCreateSpy, auditLogs } =
        setupInMemoryReconciliationHarness(buildSecSeed(), 'Asia/Kolkata');

      const originalReconcilePunch = PunchReconciliationService.reconcilePunch.bind(
        PunchReconciliationService
      );

      // 1. Thrown error mid-run: capture live window, force summary audit throw, and prove window is revoked in finally
      let leakedWindowOnError: any = null;
      const errorSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePunch')
        .mockImplementation(async (pId, _corrId, opts) => {
          leakedWindowOnError = opts?.trustedTimeWindow;
          return {
            punchId: pId,
            userEnrollmentId: '101',
            matchedEmployeeId: activeEmployee.id,
            workDate: null,
            status: 'PENDING',
            message: 'captured-before-throw',
          };
        });

      let auditCallCount = 0;
      vi.spyOn(AuditService, 'log').mockImplementation(async (entry: any) => {
        auditCallCount += 1;
        if (entry.action === 'BIOMETRIC_PUNCH_RECONCILE') {
          throw new Error('Summary audit failure inside try block');
        }
        auditLogs.push(entry);
        return {} as any;
      });

      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            terminalId,
            batchSize: 1,
            fromPunchTime: '2026-11-19T00:00:00.000Z',
            toPunchTime: '2026-11-21T23:59:59.000Z',
          },
          superAdminActor
        )
      ).rejects.toThrow('Summary audit failure inside try block');
      errorSpy.mockRestore();

      expect(auditCallCount).toBe(2);
      expect(leakedWindowOnError).toBeTruthy();

      // Replaying leaked window after thrown error MUST fail closed (finally revoked it)
      const postErrorReplay = await originalReconcilePunch('sec-hist-1', undefined, {
        trustedTimeWindow: leakedWindowOnError,
      });
      expect(postErrorReplay.status).toBe('PENDING');
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();

      // 2. Empty window early return (normal mode with historical toPunchTime) returns cleanly without minting or mutating
      vi.spyOn(AuditService, 'log').mockImplementation(async (entry: any) => {
        auditLogs.push(entry);
        return {} as any;
      });
      const emptyRes = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        { toPunchTime: '2026-11-20T23:59:59.000Z' },
        biometricEditAdminActor
      );
      expect(emptyRes.totalEvaluated).toBe(0);
      expect(emptyRes.historicalMode).toBe(false);

      // 3. Normal current-day reconciliation remains completely unaffected (bulk without explicit scope still works)
      const normalRes = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {},
        biometricEditAdminActor
      );
      expect(normalRes.historicalMode).toBe(false);
      expect(normalRes.totalEvaluated).toBe(1);
      expect(normalRes.processed).toBe(1);
      expect(normalRes.results[0].punchId).toBe('sec-today-1');
      expect(punchesStore.find((p) => p.id === 'sec-today-1')?.syncStatus).toBe('PROCESSED');
      expect(punchesStore.find((p) => p.id === 'sec-hist-1')?.syncStatus).toBe('PENDING');
      expect(punchesStore.find((p) => p.id === 'sec-hist-2')?.syncStatus).toBe('PENDING');
    });
  });

  describe('Final Security Audit Remediation (AUDIT-1 through AUDIT-5)', () => {
    const buildAuditSeed = (): InMemoryPunch[] => [
      {
        id: 'audit-unmapped-punch',
        companyId,
        terminalId,
        devicePunchId: 'dp-audit-unmapped',
        userEnrollmentId: '999',
        punchTime: new Date('2026-11-20T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-audit-unmapped',
        matchedEmployeeId: null,
        createdAt: new Date('2026-11-20T03:30:00.000Z'),
        updatedAt: new Date('2026-11-20T03:30:00.000Z'),
      },
      {
        id: 'audit-other-emp-unlinked',
        companyId,
        terminalId,
        devicePunchId: 'dp-audit-other',
        userEnrollmentId: '202',
        punchTime: new Date('2026-11-20T04:00:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-audit-other',
        matchedEmployeeId: null,
        createdAt: new Date('2026-11-20T04:00:00.000Z'),
        updatedAt: new Date('2026-11-20T04:00:00.000Z'),
      },
      {
        id: 'audit-active-emp-unlinked',
        companyId,
        terminalId,
        devicePunchId: 'dp-audit-active',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-20T04:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-audit-active',
        matchedEmployeeId: null,
        createdAt: new Date('2026-11-20T04:30:00.000Z'),
        updatedAt: new Date('2026-11-20T04:30:00.000Z'),
      },
      {
        id: 'audit-today-punch',
        companyId,
        terminalId,
        devicePunchId: 'dp-audit-today',
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-23T03:30:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'k-audit-today',
        matchedEmployeeId: activeEmployee.id,
        createdAt: new Date('2026-11-23T03:30:00.000Z'),
        updatedAt: new Date('2026-11-23T03:30:00.000Z'),
      },
    ];

    it('AUDIT-1: persists intact authorizedAt ISO timestamp in real AuditService.log() JSON during historical reconciliation', async () => {
      setupInMemoryReconciliationHarness(buildAuditSeed(), 'Asia/Kolkata');

      // Restore real AuditService.log() and spy only on prisma.auditLog.create() to inspect persisted JSON
      vi.mocked(AuditService.log).mockRestore();
      const persistedAuditRows: Array<Record<string, any>> = [];
      const auditCreateSpy = vi
        .spyOn(prisma.auditLog, 'create')
        .mockImplementation((async (args: any) => {
          persistedAuditRows.push(args.data);
          return { id: `audit-row-${persistedAuditRows.length}`, ...args.data };
        }) as any);

      const res = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        {
          allowHistorical: true,
          punchId: 'audit-active-emp-unlinked',
          employeeId: activeEmployee.id,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
        },
        superAdminActor
      );

      expect(res.processed).toBe(1);
      expect(auditCreateSpy).toHaveBeenCalled();

      const histRow = persistedAuditRows.find((r) => r.action === 'BIOMETRIC_HISTORICAL_RECONCILE');
      expect(histRow).toBeDefined();
      expect(typeof histRow?.details).toBe('string');

      const parsedDetails = JSON.parse(histRow!.details);
      expect(parsedDetails.authorizedAt).toBe(FIXED_NOW_UTC.toISOString());
      expect(parsedDetails.authorizedAt).not.toBe('[REDACTED]');
    });

    it('AUDIT-2: rejects expired server-provenanced SUPER_ADMIN actor at historical authorization boundary with zero DB queries or audits', async () => {
      const { userFindUniqueSpy, rawPunchFindManySpy, auditLogs } =
        setupInMemoryReconciliationHarness(buildAuditSeed(), 'Asia/Kolkata');

      const provenanceBeforeExpiry = AuthService.getAuthenticatedActorProvenance(superAdminActor);
      expect(provenanceBeforeExpiry).not.toBeNull();

      // Advance fake clock to exact session expiry boundary after actor was minted
      vi.setSystemTime(provenanceBeforeExpiry!.sessionExpiresAtMs);
      expect(AuthService.getAuthenticatedActorProvenance(superAdminActor)).toBeNull();

      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            allowHistorical: true,
            terminalId,
            fromPunchTime: '2026-11-19T00:00:00.000Z',
            toPunchTime: '2026-11-21T23:59:59.000Z',
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      expect(userFindUniqueSpy).not.toHaveBeenCalled();
      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('AUDIT-3: rejects unmapped, cross-employee, and legacy-collision punchId+employeeId historical requests BEFORE auditing or minting a trusted window', async () => {
      const legacyTerminalId = 'term-legacy-collision';
      const legacyEmployee = {
        ...activeEmployee,
        id: 'emp-legacy-303',
        employeeCode: 'EMP303',
        firstName: 'Legacy',
        lastName: 'User',
        biometricDeviceId: '101',
      };

      const seedWithCollision: InMemoryPunch[] = [
        ...buildAuditSeed(),
        {
          id: 'audit-legacy-collision-punch',
          companyId,
          terminalId: legacyTerminalId,
          devicePunchId: 'dp-legacy-col',
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-20T05:00:00.000Z'),
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          idempotencyKey: 'k-legacy-col',
          matchedEmployeeId: null,
          createdAt: new Date('2026-11-20T05:00:00.000Z'),
          updatedAt: new Date('2026-11-20T05:00:00.000Z'),
        },
      ];

      const { auditLogs, rawPunchFindManySpy, rawPunchUpdateSpy, attendanceCreateSpy } =
        setupInMemoryReconciliationHarness(seedWithCollision, 'Asia/Kolkata');

      // Extend mocks to include legacyEmployee (no explicit mappings, legacy biometricDeviceId='101')
      // and otherEmployee explicitly mapped to (legacyTerminalId, '101').
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockImplementation((async (args: any) => {
        if (
          args?.where?.companyId === companyId &&
          (args?.where?.id === terminalId || args?.where?.id === legacyTerminalId)
        ) {
          return { ...mockTerminal, id: args.where.id } as any;
        }
        return null;
      }) as any);

      vi.spyOn(prisma.employee, 'findFirst').mockImplementation((async (args: any) => {
        if (args?.where?.companyId === companyId) {
          if (args?.where?.id === activeEmployee.id) return activeEmployee as any;
          if (args?.where?.id === otherEmployee.id) return otherEmployee as any;
          if (args?.where?.id === legacyEmployee.id) return legacyEmployee as any;
        }
        return null;
      }) as any);

      vi.spyOn(BiometricMappingService, 'readCompanyMappings').mockResolvedValue([
        {
          id: 'map-101',
          companyId,
          employeeId: activeEmployee.id,
          terminalId,
          enrollmentId: '101',
          isActive: true,
          source: 'EXPLICIT',
          createdAt: FIXED_NOW_UTC.toISOString(),
          updatedAt: FIXED_NOW_UTC.toISOString(),
        },
        {
          id: 'map-202',
          companyId,
          employeeId: otherEmployee.id,
          terminalId,
          enrollmentId: '202',
          isActive: true,
          source: 'EXPLICIT',
          createdAt: FIXED_NOW_UTC.toISOString(),
          updatedAt: FIXED_NOW_UTC.toISOString(),
        },
        {
          id: 'map-collision-other',
          companyId,
          employeeId: otherEmployee.id,
          terminalId: legacyTerminalId,
          enrollmentId: '101',
          isActive: true,
          source: 'EXPLICIT',
          createdAt: FIXED_NOW_UTC.toISOString(),
          updatedAt: FIXED_NOW_UTC.toISOString(),
        },
      ]);

      vi.spyOn(BiometricMappingService, 'resolveEmployeeForPunch').mockImplementation(
        async (cId: string, tId: string | null | undefined, enrollmentId: string) => {
          if (cId !== companyId) return { employee: null, matchedVia: null };
          if (tId === legacyTerminalId && enrollmentId === '101') {
            // Explicit mapping on legacyTerminalId overrides legacyEmployee's biometricDeviceId='101'
            return { employee: otherEmployee as any, matchedVia: 'MAPPING' as const };
          }
          if (tId === terminalId && enrollmentId === '101') {
            return { employee: activeEmployee as any, matchedVia: 'MAPPING' as const };
          }
          if (tId === terminalId && enrollmentId === '202') {
            return { employee: otherEmployee as any, matchedVia: 'MAPPING' as const };
          }
          return { employee: null, matchedVia: null };
        }
      );

      const baseRange = {
        allowHistorical: true,
        fromPunchTime: '2026-11-19T00:00:00.000Z',
        toPunchTime: '2026-11-21T23:59:59.000Z',
      };

      // 1. Unmapped punch (matchedEmployeeId: null, unknown enrollment '999') + employeeId -> 400 before audit
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { ...baseRange, punchId: 'audit-unmapped-punch', employeeId: activeEmployee.id },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_INVALID_RECONCILIATION_FILTER' });

      // 2. Unlinked punch belonging via explicit mapping to otherEmployee + activeEmployee -> 400 before audit
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { ...baseRange, punchId: 'audit-other-emp-unlinked', employeeId: activeEmployee.id },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_INVALID_RECONCILIATION_FILTER' });

      // 3. Legacy biometricDeviceId collision: punch on legacyTerminalId with '101' resolves to otherEmployee, NOT legacyEmployee
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          { ...baseRange, punchId: 'audit-legacy-collision-punch', employeeId: legacyEmployee.id },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_INVALID_RECONCILIATION_FILTER' });

      // 4. Legacy collision via terminalId + userEnrollmentId + employeeId -> 400 before audit
      await expect(
        PunchReconciliationService.reconcilePendingPunches(
          companyId,
          {
            ...baseRange,
            terminalId: legacyTerminalId,
            userEnrollmentId: '101',
            employeeId: legacyEmployee.id,
          },
          superAdminActor
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_INVALID_RECONCILIATION_FILTER' });

      expect(auditLogs.filter((l) => l.action === 'BIOMETRIC_HISTORICAL_RECONCILE')).toHaveLength(0);
      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(attendanceCreateSpy).not.toHaveBeenCalled();

      // 5. Valid unlinked punch genuinely mapped to activeEmployee succeeds cleanly
      const validRes = await PunchReconciliationService.reconcilePendingPunches(
        companyId,
        { ...baseRange, punchId: 'audit-active-emp-unlinked', employeeId: activeEmployee.id },
        superAdminActor
      );
      expect(validRes.processed).toBe(1);
      expect(auditLogs.filter((l) => l.action === 'BIOMETRIC_HISTORICAL_RECONCILE')).toHaveLength(1);
    });

    it('AUDIT-4: BiometricService.triggerTerminalSync never persists syncRequestedAt telemetry or queues bridge poll when target validation or historical audit fails, and preserves sync contract on success', async () => {
      const { telemetryUpsertSpy, rawPunchFindManySpy, auditLogs } =
        setupInMemoryReconciliationHarness(buildAuditSeed(), 'Asia/Kolkata');

      let storedBridgeTelemetryJson: string | null = null;
      const order: string[] = [];

      vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation((async (args: any) => {
        if (
          args?.where?.companyId_key?.companyId === companyId &&
          args?.where?.companyId_key?.key === 'BIOMETRIC_BRIDGE_TELEMETRY_V1' &&
          storedBridgeTelemetryJson !== null
        ) {
          return {
            companyId,
            key: 'BIOMETRIC_BRIDGE_TELEMETRY_V1',
            value: storedBridgeTelemetryJson,
          } as any;
        }
        return null;
      }) as any);

      telemetryUpsertSpy.mockImplementation((async (args: any) => {
        if (args?.where?.companyId_key?.key === 'BIOMETRIC_BRIDGE_TELEMETRY_V1') {
          storedBridgeTelemetryJson = args?.update?.value ?? args?.create?.value ?? null;
          order.push('TELEMETRY_UPSERT');
        }
        return args;
      }) as any);

      const terminalUpdateSpy = vi
        .spyOn(prisma.biometricTerminal, 'update')
        .mockResolvedValue({
          id: terminalId,
          companyId,
          name: 'Main Gate eSSL X2008',
          deviceSerialNumber: 'SN-X2008-001',
          isActive: true,
          status: 'ONLINE',
        } as any);

      const bridgeTerminalFixture = {
        id: terminalId,
        companyId,
        name: 'Main Gate eSSL X2008',
        deviceSerialNumber: 'SN-X2008-001',
        isActive: true,
        status: 'ONLINE',
        lastHeartbeatAt: FIXED_NOW_UTC,
      };

      const baseRange = {
        allowHistorical: true,
        fromPunchTime: '2026-11-19T00:00:00.000Z',
        toPunchTime: '2026-11-21T23:59:59.000Z',
      };

      // 1. Target validation failure (nonexistent employeeId) -> 404, ZERO telemetry writes & ZERO bridge polls
      await expect(
        BiometricService.triggerTerminalSync(superAdminActor, terminalId, {
          ...baseRange,
          employeeId: 'emp-nonexistent-audit4',
        })
      ).rejects.toMatchObject({ statusCode: 404, code: 'BIOMETRIC_TARGET_NOT_FOUND' });

      // 2. Target validation failure (unmapped punchId mismatched with employeeId) -> 400, ZERO telemetry writes & ZERO bridge polls
      await expect(
        BiometricService.triggerTerminalSync(superAdminActor, terminalId, {
          ...baseRange,
          punchId: 'audit-unmapped-punch',
          employeeId: activeEmployee.id,
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'BIOMETRIC_INVALID_RECONCILIATION_FILTER' });

      // 3. Mandatory audit sink failure -> rejects, ZERO telemetry writes, ZERO bridge polls, ZERO punch queries
      vi.spyOn(AuditService, 'log').mockRejectedValueOnce(new Error('Audit DB unreachable'));
      await expect(
        BiometricService.triggerTerminalSync(superAdminActor, terminalId, {
          ...baseRange,
          employeeId: activeEmployee.id,
        })
      ).rejects.toThrow('Audit DB unreachable');

      expect(telemetryUpsertSpy).not.toHaveBeenCalled();
      expect(storedBridgeTelemetryJson).toBeNull();
      expect(terminalUpdateSpy).not.toHaveBeenCalled();
      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(auditLogs.filter((l) => l.action === 'BIOMETRIC_HISTORICAL_RECONCILE')).toHaveLength(0);

      // Verify actual bridge-poll handshake observes ZERO queued sync triggers after failed calls
      const heartbeatAfterFailures = await BiometricService.recordHeartbeat(bridgeTerminalFixture, {
        bridgeConnected: true,
        deviceReachable: true,
      });
      expect(heartbeatAfterFailures.syncRequested).toBe(false);
      expect(heartbeatAfterFailures.syncRequestedAt).toBeNull();

      // 4. Valid historical terminal sync: audit -> reconciliation -> syncRequestedAt telemetry -> bridge poll queued
      order.length = 0;
      telemetryUpsertSpy.mockClear();
      vi.spyOn(AuditService, 'log').mockImplementation(async (entry: any) => {
        order.push(`AUDIT:${entry.action}`);
        auditLogs.push(entry);
        return {} as any;
      });

      const syncRes = await BiometricService.triggerTerminalSync(superAdminActor, terminalId, {
        ...baseRange,
        employeeId: activeEmployee.id,
      });

      expect(syncRes.success).toBe(true);
      expect(syncRes.bridgeSyncQueued).toBe(true);
      expect(typeof syncRes.syncRequestedAt).toBe('string');
      expect(syncRes.terminal.syncRequestedAt).toBe(syncRes.syncRequestedAt);
      expect(syncRes.reconciliation.processed).toBe(1);
      expect(telemetryUpsertSpy).toHaveBeenCalledTimes(1);
      expect(order.indexOf('AUDIT:BIOMETRIC_HISTORICAL_RECONCILE')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('TELEMETRY_UPSERT')).toBeGreaterThan(
        order.indexOf('AUDIT:BIOMETRIC_HISTORICAL_RECONCILE')
      );

      // Verify bridge-poll handshake now receives the queued trigger with exact syncRequestedAt
      const heartbeatAfterValidSync = await BiometricService.recordHeartbeat(bridgeTerminalFixture, {
        bridgeConnected: true,
        deviceReachable: true,
      });
      expect(heartbeatAfterValidSync.syncRequested).toBe(true);
      expect(heartbeatAfterValidSync.syncRequestedAt).toBe(syncRes.syncRequestedAt);
    });

    it('AUDIT-5: rejects malformed service-layer batchSize values fail-closed (400 VALIDATION_ERROR) and hardens reconcileForEmployeeMapping()', async () => {
      const { rawPunchFindManySpy, rawPunchUpdateSpy, auditLogs } =
        setupInMemoryReconciliationHarness(buildAuditSeed(), 'Asia/Kolkata');

      const malformedBatchSizes: Array<[string, unknown]> = [
        ['zero', 0],
        ['negative', -5],
        ['fractional', 1.5],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['-Infinity', Number.NEGATIVE_INFINITY],
        ['numeric string', '10'],
        ['non-numeric string', 'abc'],
        ['plain object', {}],
        ['null', null],
      ];

      for (const [_label, badBatchSize] of malformedBatchSizes) {
        // Normal mode
        await expect(
          PunchReconciliationService.reconcilePendingPunches(
            companyId,
            { batchSize: badBatchSize as any },
            biometricEditAdminActor
          )
        ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

        // Historical mode (even with punchId set)
        await expect(
          PunchReconciliationService.reconcilePendingPunches(
            companyId,
            {
              allowHistorical: true,
              terminalId,
              punchId: 'audit-active-emp-unlinked',
              batchSize: badBatchSize as any,
              fromPunchTime: '2026-11-19T00:00:00.000Z',
              toPunchTime: '2026-11-21T23:59:59.000Z',
            },
            superAdminActor
          )
        ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      }

      // reconcileForEmployeeMapping() hardening:
      // 1. Unauthorized allowHistorical: true with empty IDs MUST still throw 403 (never silent success)
      await expect(
        PunchReconciliationService.reconcileForEmployeeMapping(
          companyId,
          '',
          '',
          biometricEditAdminActor,
          undefined,
          {
            allowHistorical: true,
            fromPunchTime: '2026-11-19T00:00:00.000Z',
            toPunchTime: '2026-11-21T23:59:59.000Z',
          }
        )
      ).rejects.toMatchObject({ statusCode: 403, code: 'BIOMETRIC_HISTORICAL_FORBIDDEN' });

      // 2. Empty or whitespace terminalId / userEnrollmentId fails closed with 400
      for (const [tId, eId] of [
        ['', '101'],
        ['   ', '101'],
        [terminalId, ''],
        [terminalId, '   '],
        [null as any, '101'],
        [terminalId, undefined as any],
      ]) {
        await expect(
          PunchReconciliationService.reconcileForEmployeeMapping(
            companyId,
            tId,
            eId,
            biometricEditAdminActor
          )
        ).rejects.toMatchObject({
          statusCode: 400,
          code: 'BIOMETRIC_INVALID_RECONCILIATION_FILTER',
        });
      }

      // 3. Invalid non-object options fails closed with 400 VALIDATION_ERROR
      for (const badOpts of [null, 'invalid', [], 123]) {
        await expect(
          PunchReconciliationService.reconcileForEmployeeMapping(
            companyId,
            terminalId,
            '101',
            biometricEditAdminActor,
            undefined,
            badOpts as any
          )
        ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      }

      // 4. Explicit null and all other malformed batchSize values forwarded through
      //    reconcileForEmployeeMapping() fail closed with 400 VALIDATION_ERROR before any DB query, update, or audit
      for (const [_label, badBatchSize] of malformedBatchSizes) {
        await expect(
          PunchReconciliationService.reconcileForEmployeeMapping(
            companyId,
            terminalId,
            '101',
            biometricEditAdminActor,
            undefined,
            { batchSize: badBatchSize as any }
          )
        ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });

        await expect(
          PunchReconciliationService.reconcileForEmployeeMapping(
            companyId,
            terminalId,
            '101',
            superAdminActor,
            undefined,
            {
              allowHistorical: true,
              fromPunchTime: '2026-11-19T00:00:00.000Z',
              toPunchTime: '2026-11-21T23:59:59.000Z',
              batchSize: badBatchSize as any,
            }
          )
        ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      }

      expect(rawPunchFindManySpy).not.toHaveBeenCalled();
      expect(rawPunchUpdateSpy).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);

      // 5. Omitted batchSize (undefined) preserves default mapping batch limit (500 normal)
      const normalMapRes = await PunchReconciliationService.reconcileForEmployeeMapping(
        companyId,
        terminalId,
        '101',
        biometricEditAdminActor,
        undefined,
        {}
      );
      expect(normalMapRes.success).toBe(true);
      expect(rawPunchFindManySpy.mock.calls[0][0].take).toBe(MAX_NORMAL_RECONCILIATION_BATCH_SIZE);

      // 6. Valid padded terminalId/userEnrollmentId trims cleanly and enforces historical cap (100)
      const histMapRes = await PunchReconciliationService.reconcileForEmployeeMapping(
        companyId,
        `  ${terminalId}  `,
        '  101  ',
        superAdminActor,
        undefined,
        {
          allowHistorical: true,
          fromPunchTime: '2026-11-19T00:00:00.000Z',
          toPunchTime: '2026-11-21T23:59:59.000Z',
          batchSize: 500,
        }
      );
      expect(histMapRes.processed).toBe(1);
      expect(rawPunchFindManySpy.mock.calls[1][0].take).toBe(MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE);
    });
  });
});



