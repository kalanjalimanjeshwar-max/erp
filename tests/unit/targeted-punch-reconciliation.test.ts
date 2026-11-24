import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import {
  BIOMETRIC_MAPPINGS_SETTING_KEY,
  StoredBiometricMappingRecord,
} from '../../src/server/services/biometric-mapping.service.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { AuthUser } from '../../src/shared/types.js';

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Targeted Biometric Punch Reconciliation (Single-Punch, Enrollment ID & Employee Filtering)', () => {
  const app = createApp();
  const companyAlphaId = '11111111-1111-4111-8111-111111111111';
  const companyBetaId = '22222222-2222-4222-8222-222222222222';

  const adminActor: AuthUser = {
    id: 'user-admin-alpha',
    userId: 'user-admin-alpha',
    companyId: companyAlphaId,
    email: 'admin@alpha.local',
    fullName: 'Alpha Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const shiftAlpha = {
    id: 'shift-alpha-std',
    companyId: companyAlphaId,
    code: 'DAY',
    name: 'Day Shift',
    startTime: '09:00',
    endTime: '18:00',
    isOvernight: false,
    graceMinutes: 15,
    halfDayMinutes: 240,
    isActive: true,
  };

  const terminalAlpha = {
    id: 'term-essl-alpha',
    companyId: companyAlphaId,
    deviceSerialNumber: 'NFZ8252800275',
    name: 'eSSL X2008 Main Gate',
    terminalModel: 'eSSL X2008',
    ipAddress: '192.168.1.201',
    port: 4370,
    isActive: true,
    status: 'ONLINE' as const,
  };

  const terminalBeta = {
    id: 'term-beta-gate',
    companyId: companyBetaId,
    deviceSerialNumber: 'BETA-SN-001',
    name: 'Beta Terminal',
    terminalModel: 'eSSL X2008',
    ipAddress: '10.0.0.50',
    port: 4370,
    isActive: true,
    status: 'ONLINE' as const,
  };

  type PunchRow = {
    id: string;
    companyId: string;
    terminalId: string;
    devicePunchId: string | null;
    userEnrollmentId: string;
    punchTime: Date;
    verifyType: 'FINGERPRINT' | 'CARD' | 'PASSWORD' | 'FACE';
    inOutMode: 'CHECK_IN' | 'CHECK_OUT' | 'BREAK_OUT' | 'BREAK_IN';
    syncStatus: 'PENDING' | 'PROCESSED' | 'IGNORED' | 'ERROR';
    errorMessage: string | null;
    idempotencyKey: string;
    matchedEmployeeId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };

  type EmployeeRow = {
    id: string;
    companyId: string;
    employeeCode: string;
    fullName: string;
    biometricDeviceId: string | null;
    status: 'ACTIVE' | 'INACTIVE' | 'EXITED';
    shiftId: string | null;
    shift: typeof shiftAlpha | null;
  };

  type AttendanceRow = {
    id: string;
    companyId: string;
    employeeId: string;
    shiftId: string | null;
    workDate: Date;
    checkIn: Date | null;
    checkOut: Date | null;
    status: 'PRESENT' | 'ABSENT' | 'HALF_DAY' | 'LATE' | 'ON_LEAVE';
    lateMinutes: number;
    overtimeMinutes: number;
    source: 'MANUAL' | 'BIOMETRIC';
    notes: string | null;
  };

  let employeesStore: EmployeeRow[];
  let punchesStore: PunchRow[];
  let attendanceStore: AttendanceRow[];
  let settingsStore: Map<string, string>;
  let payrollPeriodsStore: Array<{
    id: string;
    companyId: string;
    name: string;
    startDate: Date;
    endDate: Date;
    status: 'DRAFT' | 'PROCESSED' | 'ACCOUNTS_APPROVED' | 'POSTED' | 'CANCELLED';
  }>;
  let leaveRequestsStore: Array<{
    id: string;
    companyId: string;
    employeeId: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
    startDate: Date;
    endDate: Date;
    leaveType: { name: string };
  }>;

  function matchesWhereCondition(punch: PunchRow, cond: any): boolean {
    if (!cond || typeof cond !== 'object') return true;
    for (const [key, val] of Object.entries(cond)) {
      if (key === 'OR' && Array.isArray(val)) {
        if (!val.some((sub) => matchesWhereCondition(punch, sub))) {
          return false;
        }
        continue;
      }
      if (key === 'AND' && Array.isArray(val)) {
        if (!val.every((sub) => matchesWhereCondition(punch, sub))) {
          return false;
        }
        continue;
      }
      if (val && typeof val === 'object' && 'in' in val && Array.isArray((val as any).in)) {
        if (!(val as any).in.includes((punch as any)[key])) {
          return false;
        }
        continue;
      }
      if (
        val &&
        typeof val === 'object' &&
        ('gte' in val || 'lte' in val) &&
        !(val instanceof Date)
      ) {
        const punchVal = (punch as any)[key];
        const punchTime = punchVal instanceof Date ? punchVal.getTime() : new Date(punchVal).getTime();
        if ((val as any).gte !== undefined && punchTime < new Date((val as any).gte).getTime()) {
          return false;
        }
        if ((val as any).lte !== undefined && punchTime > new Date((val as any).lte).getTime()) {
          return false;
        }
        continue;
      }
      if ((punch as any)[key] !== val) {
        return false;
      }
    }
    return true;
  }

  function setupStatefulStore() {
    employeesStore = [
      {
        id: 'emp-101',
        companyId: companyAlphaId,
        employeeCode: 'EMP-101',
        fullName: 'Employee 101',
        biometricDeviceId: '101',
        status: 'ACTIVE',
        shiftId: shiftAlpha.id,
        shift: shiftAlpha,
      },
      {
        id: 'emp-103',
        companyId: companyAlphaId,
        employeeCode: 'EMP-103',
        fullName: 'Employee 103',
        biometricDeviceId: '103',
        status: 'ACTIVE',
        shiftId: shiftAlpha.id,
        shift: shiftAlpha,
      },
      {
        id: 'emp-105',
        companyId: companyAlphaId,
        employeeCode: 'EMP-105',
        fullName: 'Employee 105',
        biometricDeviceId: '105',
        status: 'ACTIVE',
        shiftId: shiftAlpha.id,
        shift: shiftAlpha,
      },
      {
        id: 'emp-106-inactive',
        companyId: companyAlphaId,
        employeeCode: 'EMP-106',
        fullName: 'Inactive Employee 106',
        biometricDeviceId: '106',
        status: 'INACTIVE',
        shiftId: shiftAlpha.id,
        shift: shiftAlpha,
      },
      {
        id: 'emp-107-unmapped',
        companyId: companyAlphaId,
        employeeCode: 'EMP-107',
        fullName: 'Unmapped Employee 107',
        biometricDeviceId: null,
        status: 'ACTIVE',
        shiftId: shiftAlpha.id,
        shift: shiftAlpha,
      },
      {
        id: 'emp-beta-101',
        companyId: companyBetaId,
        employeeCode: 'BETA-101',
        fullName: 'Beta Employee 101',
        biometricDeviceId: '101',
        status: 'ACTIVE',
        shiftId: shiftAlpha.id,
        shift: shiftAlpha,
      },
    ];

    const mappings: StoredBiometricMappingRecord[] = [
      {
        id: 'map-101',
        companyId: companyAlphaId,
        employeeId: 'emp-101',
        terminalId: terminalAlpha.id,
        enrollmentId: '101',
        isActive: true,
        source: 'EXPLICIT',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'map-103',
        companyId: companyAlphaId,
        employeeId: 'emp-103',
        terminalId: terminalAlpha.id,
        enrollmentId: '103',
        isActive: true,
        source: 'EXPLICIT',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'map-105',
        companyId: companyAlphaId,
        employeeId: 'emp-105',
        terminalId: terminalAlpha.id,
        enrollmentId: '105',
        isActive: true,
        source: 'EXPLICIT',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'map-106',
        companyId: companyAlphaId,
        employeeId: 'emp-106-inactive',
        terminalId: terminalAlpha.id,
        enrollmentId: '106',
        isActive: true,
        source: 'EXPLICIT',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ];

    const betaMappings: StoredBiometricMappingRecord[] = [
      {
        id: 'map-beta-101',
        companyId: companyBetaId,
        employeeId: 'emp-beta-101',
        terminalId: terminalBeta.id,
        enrollmentId: '101',
        isActive: true,
        source: 'EXPLICIT',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ];

    settingsStore = new Map<string, string>();
    settingsStore.set(
      `${companyAlphaId}::${BIOMETRIC_MAPPINGS_SETTING_KEY}`,
      JSON.stringify(mappings)
    );
    settingsStore.set(
      `${companyBetaId}::${BIOMETRIC_MAPPINGS_SETTING_KEY}`,
      JSON.stringify(betaMappings)
    );

    const baseTime = new Date('2026-10-20T09:05:00.000Z');
    punchesStore = [
      {
        id: 'punch-101-first',
        companyId: companyAlphaId,
        terminalId: terminalAlpha.id,
        devicePunchId: 'dp-101-1',
        userEnrollmentId: '101',
        punchTime: new Date('2026-10-20T09:05:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'key-101-1',
        matchedEmployeeId: null,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        id: 'punch-101-checkout',
        companyId: companyAlphaId,
        terminalId: terminalAlpha.id,
        devicePunchId: 'dp-101-2',
        userEnrollmentId: '101',
        punchTime: new Date('2026-10-20T18:10:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_OUT',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'key-101-2',
        matchedEmployeeId: null,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        id: 'punch-103-pending',
        companyId: companyAlphaId,
        terminalId: terminalAlpha.id,
        devicePunchId: 'dp-103-1',
        userEnrollmentId: '103',
        punchTime: new Date('2026-10-20T09:12:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'key-103-1',
        matchedEmployeeId: null,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        id: 'punch-105-pending',
        companyId: companyAlphaId,
        terminalId: terminalAlpha.id,
        devicePunchId: 'dp-105-1',
        userEnrollmentId: '105',
        punchTime: new Date('2026-10-20T09:20:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'key-105-1',
        matchedEmployeeId: null,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        id: 'punch-beta-101',
        companyId: companyBetaId,
        terminalId: terminalBeta.id,
        devicePunchId: 'dp-beta-101',
        userEnrollmentId: '101',
        punchTime: new Date('2026-10-20T09:02:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'key-beta-101',
        matchedEmployeeId: null,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
    ];

    attendanceStore = [];
    payrollPeriodsStore = [];
    leaveRequestsStore = [];

    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(prisma));

    vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation((async (args: any) => {
      const k = `${args.where.companyId_key.companyId}::${args.where.companyId_key.key}`;
      const val = settingsStore.get(k);
      if (val === undefined) return null;
      return {
        id: k,
        companyId: args.where.companyId_key.companyId,
        key: args.where.companyId_key.key,
        value: val,
      } as any;
    }) as any);

    vi.spyOn(prisma.biometricTerminal, 'findMany').mockImplementation((async (args: any) => {
      const all = [terminalAlpha, terminalBeta];
      return all.filter((t) => !args?.where?.companyId || t.companyId === args.where.companyId) as any;
    }) as any);

    vi.spyOn(prisma.biometricTerminal, 'findFirst').mockImplementation((async (args: any) => {
      const all = [terminalAlpha, terminalBeta];
      const w = args?.where || {};
      return (
        all.find((t) => {
          if (w.id && t.id !== w.id) return false;
          if (w.companyId && t.companyId !== w.companyId) return false;
          return true;
        }) || null
      ) as any;
    }) as any);

    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);

    vi.spyOn(prisma.employee, 'findFirst').mockImplementation((async (args: any) => {
      const w = args?.where || {};
      return (
        employeesStore.find((e) => {
          if (w.id && e.id !== w.id) return false;
          if (w.companyId && e.companyId !== w.companyId) return false;
          if (w.biometricDeviceId && e.biometricDeviceId !== w.biometricDeviceId) return false;
          return true;
        }) || null
      ) as any;
    }) as any);

    vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
      return (employeesStore.find((e) => e.id === args?.where?.id) || null) as any;
    }) as any);

    vi.spyOn(prisma.payrollPeriod, 'findFirst').mockImplementation((async (args: any) => {
      const w = args?.where || {};
      return (
        payrollPeriodsStore.find((p) => {
          if (w.companyId && p.companyId !== w.companyId) return false;
          if (w.status?.in && !w.status.in.includes(p.status)) return false;
          if (w.startDate?.lte && p.startDate > w.startDate.lte) return false;
          if (w.endDate?.gte && p.endDate < w.endDate.gte) return false;
          return true;
        }) || null
      ) as any;
    }) as any);

    vi.spyOn(prisma.leaveRequest, 'findFirst').mockImplementation((async (args: any) => {
      const w = args?.where || {};
      return (
        leaveRequestsStore.find((lr) => {
          if (w.companyId && lr.companyId !== w.companyId) return false;
          if (w.employeeId && lr.employeeId !== w.employeeId) return false;
          if (w.status && lr.status !== w.status) return false;
          if (w.startDate?.lte && lr.startDate > w.startDate.lte) return false;
          if (w.endDate?.gte && lr.endDate < w.endDate.gte) return false;
          return true;
        }) || null
      ) as any;
    }) as any);

    vi.spyOn(prisma.attendance, 'findUnique').mockImplementation((async (args: any) => {
      const key = args?.where?.companyId_employeeId_workDate;
      if (!key) return null;
      return (
        attendanceStore.find(
          (a) =>
            a.companyId === key.companyId &&
            a.employeeId === key.employeeId &&
            a.workDate.toISOString() === new Date(key.workDate).toISOString()
        ) || null
      ) as any;
    }) as any);

    vi.spyOn(prisma.attendance, 'create').mockImplementation((async (args: any) => {
      const row: AttendanceRow = {
        id: `att-${attendanceStore.length + 1}`,
        companyId: args.data.companyId,
        employeeId: args.data.employeeId,
        shiftId: args.data.shiftId ?? null,
        workDate: new Date(args.data.workDate),
        checkIn: args.data.checkIn ? new Date(args.data.checkIn) : null,
        checkOut: args.data.checkOut ? new Date(args.data.checkOut) : null,
        status: args.data.status,
        lateMinutes: args.data.lateMinutes ?? 0,
        overtimeMinutes: args.data.overtimeMinutes ?? 0,
        source: args.data.source,
        notes: args.data.notes ?? null,
      };
      attendanceStore.push(row);
      return row as any;
    }) as any);

    vi.spyOn(prisma.attendance, 'update').mockImplementation((async (args: any) => {
      const row = attendanceStore.find((a) => a.id === args.where.id);
      if (!row) throw new Error('Attendance not found');
      Object.assign(row, args.data);
      return row as any;
    }) as any);

    vi.spyOn(prisma.rawPunchLog, 'findMany').mockImplementation((async (args: any) => {
      const filtered = punchesStore
        .filter((p) => matchesWhereCondition(p, args?.where))
        .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
      const sliced = typeof args?.take === 'number' ? filtered.slice(0, args.take) : filtered;
      return sliced.map((p) => ({
        ...p,
        terminal: p.terminalId === terminalBeta.id ? terminalBeta : terminalAlpha,
        matchedEmployee: employeesStore.find((e) => e.id === p.matchedEmployeeId) || null,
      })) as any;
    }) as any);

    vi.spyOn(prisma.rawPunchLog, 'count').mockImplementation((async (args: any) => {
      return punchesStore.filter((p) => matchesWhereCondition(p, args?.where)).length;
    }) as any);

    vi.spyOn(prisma.rawPunchLog, 'findUnique').mockImplementation((async (args: any) => {
      const p = punchesStore.find((item) => item.id === args?.where?.id);
      if (!p) return null;
      return {
        ...p,
        company: { id: p.companyId, timezone: 'UTC' },
        terminal: p.terminalId === terminalBeta.id ? terminalBeta : terminalAlpha,
        matchedEmployee: employeesStore.find((e) => e.id === p.matchedEmployeeId) || null,
      } as any;
    }) as any);

    vi.spyOn(prisma.rawPunchLog, 'update').mockImplementation((async (args: any) => {
      const p = punchesStore.find((item) => item.id === args?.where?.id);
      if (!p) throw new Error('Punch not found');
      Object.assign(p, args.data);
      return p as any;
    }) as any);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T18:30:00.000Z'));
    vi.clearAllMocks();
    setupStatefulStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciling Enrollment ID 101 processes ONLY Enrollment ID 101 punches and leaves 103, 105 & other tenant punches PENDING', async () => {
    const result = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { userEnrollmentId: '101' },
      adminActor.userId
    );

    expect(result.success).toBe(true);
    expect(result.totalEvaluated).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.results.map((r) => r.punchId)).toEqual(['punch-101-first', 'punch-101-checkout']);

    // Verify 101 punches processed and attendance recorded for emp-101 ONLY
    expect(punchesStore.find((p) => p.id === 'punch-101-first')?.syncStatus).toBe('PROCESSED');
    expect(punchesStore.find((p) => p.id === 'punch-101-checkout')?.syncStatus).toBe('PROCESSED');
    expect(attendanceStore).toHaveLength(1);
    expect(attendanceStore[0].employeeId).toBe('emp-101');
    expect(attendanceStore[0].checkIn?.toISOString()).toBe('2026-10-20T09:05:00.000Z');
    expect(attendanceStore[0].checkOut?.toISOString()).toBe('2026-10-20T18:10:00.000Z');

    // Verify Enrollment IDs 103, 105, and Beta tenant 101 remain untouched PENDING
    expect(punchesStore.find((p) => p.id === 'punch-103-pending')?.syncStatus).toBe('PENDING');
    expect(punchesStore.find((p) => p.id === 'punch-105-pending')?.syncStatus).toBe('PENDING');
    expect(punchesStore.find((p) => p.id === 'punch-beta-101')?.syncStatus).toBe('PENDING');
  });

  it('selecting one specific pending RawPunchLog by punchId processes ONLY that single record even when another pending punch exists for Enrollment ID 101', async () => {
    const result = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { punchId: 'punch-101-first' },
      adminActor.userId
    );

    expect(result.success).toBe(true);
    expect(result.totalEvaluated).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].punchId).toBe('punch-101-first');

    // Only the selected punch-101-first is PROCESSED; punch-101-checkout, 103, 105 remain PENDING
    expect(punchesStore.find((p) => p.id === 'punch-101-first')?.syncStatus).toBe('PROCESSED');
    expect(punchesStore.find((p) => p.id === 'punch-101-checkout')?.syncStatus).toBe('PENDING');
    expect(punchesStore.find((p) => p.id === 'punch-103-pending')?.syncStatus).toBe('PENDING');
    expect(punchesStore.find((p) => p.id === 'punch-105-pending')?.syncStatus).toBe('PENDING');

    // Re-running targeted single-punch reconciliation is idempotent (PROCESSED no longer matches PENDING query -> 0 evaluated, no duplicate attendance)
    const rerun = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { punchId: 'punch-101-first' },
      adminActor.userId
    );
    expect(rerun.totalEvaluated).toBe(0);
    expect(attendanceStore).toHaveLength(1);
  });

  it('selecting an Employee filter reconciles ONLY punches mapped to that employee and never touches 103 or 105', async () => {
    const result = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { employeeId: 'emp-101' },
      adminActor.userId
    );

    expect(result.success).toBe(true);
    expect(result.totalEvaluated).toBe(2);
    expect(result.processed).toBe(2);
    expect(attendanceStore).toHaveLength(1);
    expect(attendanceStore[0].employeeId).toBe('emp-101');
    expect(punchesStore.find((p) => p.id === 'punch-103-pending')?.syncStatus).toBe('PENDING');
    expect(punchesStore.find((p) => p.id === 'punch-105-pending')?.syncStatus).toBe('PENDING');
  });

  it('never silently falls back to processing all pending records when targeted filters match nothing, are cross-tenant, or are blank', async () => {
    // 1. Employee with no biometric mappings & no matched punches -> evaluates 0, leaves all pending untouched
    const noMatchEmpRes = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { employeeId: 'emp-107-unmapped' },
      adminActor.userId
    );
    expect(noMatchEmpRes.totalEvaluated).toBe(0);
    expect(noMatchEmpRes.processed).toBe(0);

    // 2. Nonexistent enrollment ID -> evaluates 0
    const unknownEnrollRes = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { userEnrollmentId: '999' },
      adminActor.userId
    );
    expect(unknownEnrollRes.totalEvaluated).toBe(0);

    // 3. Cross-tenant punchId -> evaluates 0, Beta punch untouched
    const crossTenantPunchRes = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { punchId: 'punch-beta-101' },
      adminActor.userId
    );
    expect(crossTenantPunchRes.totalEvaluated).toBe(0);
    expect(punchesStore.find((p) => p.id === 'punch-beta-101')?.syncStatus).toBe('PENDING');

    // 4. Cross-tenant employeeId -> throws 404 and leaves all punches untouched
    await expect(
      PunchReconciliationService.reconcilePendingPunches(
        companyAlphaId,
        { employeeId: 'emp-beta-101' },
        adminActor.userId
      )
    ).rejects.toThrow(/not found in this company/i);

    // 5. Blank/whitespace targeted filter -> throws 400 rather than falling back to bulk sync
    await expect(
      PunchReconciliationService.reconcilePendingPunches(
        companyAlphaId,
        { userEnrollmentId: '   ' },
        adminActor.userId
      )
    ).rejects.toThrow(/cannot be empty/i);
    await expect(
      PunchReconciliationService.reconcilePendingPunches(
        companyAlphaId,
        { punchId: '' },
        adminActor.userId
      )
    ).rejects.toThrow(/cannot be empty/i);

    // All pending punches remain completely untouched
    expect(punchesStore.every((p) => p.syncStatus === 'PENDING')).toBe(true);
    expect(attendanceStore).toHaveLength(0);
  });

  it('preserves inactive employee policy, payroll lock protection, approved leave preservation, and debouncing under targeted reconciliation', async () => {
    // Add punches for inactive emp 106, debounce tap for 101, locked payroll date, and approved leave date
    punchesStore.push(
      {
        id: 'punch-106-inactive',
        companyId: companyAlphaId,
        terminalId: terminalAlpha.id,
        devicePunchId: 'dp-106-1',
        userEnrollmentId: '106',
        punchTime: new Date('2026-10-20T09:00:00.000Z'),
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'key-106-1',
        matchedEmployeeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'punch-101-debounce',
        companyId: companyAlphaId,
        terminalId: terminalAlpha.id,
        devicePunchId: 'dp-101-deb',
        userEnrollmentId: '101',
        punchTime: new Date('2026-10-20T09:06:00.000Z'), // 60s after punch-101-first
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        idempotencyKey: 'key-101-deb',
        matchedEmployeeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    );

    // 1. Inactive employee 106 -> IGNORED, no attendance created
    const inactiveRes = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { punchId: 'punch-106-inactive' },
      adminActor.userId
    );
    expect(inactiveRes.ignored).toBe(1);
    expect(attendanceStore.some((a) => a.employeeId === 'emp-106-inactive')).toBe(false);

    // 2. Targeted punch-101-first -> PROCESSED, then punch-101-debounce -> IGNORED (debounced)
    await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { punchId: 'punch-101-first' },
      adminActor.userId
    );
    const debounceRes = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { punchId: 'punch-101-debounce' },
      adminActor.userId
    );
    expect(debounceRes.ignored).toBe(1);
    expect(punchesStore.find((p) => p.id === 'punch-101-debounce')?.syncStatus).toBe('IGNORED');

    // 3. Locked payroll period blocks targeted punch for 103
    payrollPeriodsStore.push({
      id: 'pay-oct-2026',
      companyId: companyAlphaId,
      name: 'October 2026 Payroll',
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      endDate: new Date('2026-10-31T23:59:59.000Z'),
      status: 'POSTED',
    });
    const lockedRes = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { punchId: 'punch-103-pending' },
      adminActor.userId
    );
    expect(lockedRes.errors).toBe(1);
    expect(punchesStore.find((p) => p.id === 'punch-103-pending')?.syncStatus).toBe('ERROR');
    expect(punchesStore.find((p) => p.id === 'punch-105-pending')?.syncStatus).toBe('PENDING');

    // 4. Approved leave preserves leave for 105 when payroll unlocked
    payrollPeriodsStore = [];
    leaveRequestsStore.push({
      id: 'leave-105',
      companyId: companyAlphaId,
      employeeId: 'emp-105',
      status: 'APPROVED',
      startDate: new Date('2026-10-20T00:00:00.000Z'),
      endDate: new Date('2026-10-20T00:00:00.000Z'),
      leaveType: { name: 'Casual Leave' },
    });
    const leaveRes = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { punchId: 'punch-105-pending' },
      adminActor.userId
    );
    expect(leaveRes.ignored).toBe(1);
    expect(punchesStore.find((p) => p.id === 'punch-105-pending')?.syncStatus).toBe('IGNORED');
  });

  it('protects historical PENDING punches when fromPunchTime is omitted and processes SUPER_ADMIN authorized bounded historical runs', async () => {
    // Advance clock to next day so 2026-10-20 punches are strictly historical
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'));

    const protectedRes = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      { batchSize: 100 },
      adminActor
    );
    expect(protectedRes.totalEvaluated).toBe(0);
    expect(punchesStore.every((p) => p.syncStatus === 'PENDING')).toBe(true);

    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: 'user-super-alpha',
      companyId: companyAlphaId,
      email: 'super@alpha.local',
      fullName: 'Alpha Super Admin',
      role: 'SUPER_ADMIN',
      isActive: true,
      lastLoginAt: null,
      tokenVersion: 1,
    } as any);
    const superAdminToken = AuthService.generateSessionToken({
      userId: 'user-super-alpha',
      companyId: companyAlphaId,
      email: 'super@alpha.local',
      role: 'SUPER_ADMIN',
      tokenVersion: 1,
    });
    const verifiedSuperPayload = AuthService.verifySessionToken(superAdminToken)!;
    const superAdminActor = (await AuthService.validateSessionUser(verifiedSuperPayload))!;

    const result = await PunchReconciliationService.reconcilePendingPunches(
      companyAlphaId,
      {
        batchSize: 100,
        allowHistorical: true,
        terminalId: terminalAlpha.id,
        fromPunchTime: '2026-10-20T00:00:00.000Z',
        toPunchTime: '2026-10-20T23:59:59.000Z',
      },
      superAdminActor
    );

    // Alpha has 4 pending punches (101x2, 103, 105); Beta punch stays isolated
    expect(result.totalEvaluated).toBe(4);
    expect(result.processed).toBe(4);
    expect(attendanceStore.map((a) => a.employeeId).sort()).toEqual(['emp-101', 'emp-103', 'emp-105']);
    expect(punchesStore.find((p) => p.id === 'punch-beta-101')?.syncStatus).toBe('PENDING');
  });

  it('HTTP POST /api/biometric/sync & GET /api/biometric/punches enforce targeted filters and reject empty filters with 400', async () => {
    const token = AuthService.generateSessionToken({
      userId: adminActor.userId,
      companyId: adminActor.companyId,
      email: adminActor.email,
      role: adminActor.role,
      tokenVersion: adminActor.tokenVersion,
    });
    vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValue(adminActor);

    // 1. Blank filter rejected with 400 (no silent fallback)
    const badRes = await request(app)
      .post('/api/biometric/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({ userEnrollmentId: '   ' });
    expect(badRes.status).toBe(400);
    expect(badRes.body.error.code).toBe('BIOMETRIC_INVALID_RECONCILIATION_FILTER');
    expect(punchesStore.every((p) => p.syncStatus === 'PENDING')).toBe(true);

    // 2. Targeted Enrollment ID 101 via API
    const syncRes = await request(app)
      .post('/api/biometric/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({ userEnrollmentId: '101' });
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.totalEvaluated).toBe(2);
    expect(syncRes.body.processed).toBe(2);
    expect(punchesStore.find((p) => p.id === 'punch-103-pending')?.syncStatus).toBe('PENDING');
    expect(punchesStore.find((p) => p.id === 'punch-105-pending')?.syncStatus).toBe('PENDING');

    // 3. List punches filtered by userEnrollmentId=103
    const listRes = await request(app)
      .get('/api/biometric/punches?userEnrollmentId=103')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.total).toBe(1);
    expect(listRes.body.items[0].id).toBe('punch-103-pending');
  });

  it('BiometricDevicesPage UI exposes Enrollment ID, Employee, and Specific RawPunchLog reconciliation controls', () => {
    const uiSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/client/pages/BiometricDevicesPage.tsx'),
      'utf8'
    );
    expect(uiSource).toContain('Specific Pending Raw Punch (Optional)');
    expect(uiSource).toContain('Enrollment ID Filter (Optional)');
    expect(uiSource).toContain('Employee Filter (Optional)');
    expect(uiSource).toContain('handleOpenTargetedPunchReconcile');
    expect(uiSource).toContain('Targeted Reconciliation Mode Active');
  });
});
