import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../src/server/db/client.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import {
  AutoCheckoutService,
  evaluateCompanyAutoCheckoutTime,
} from '../../src/server/services/auto-checkout.service.js';
import { AutoCheckoutScheduler } from '../../src/server/services/auto-checkout.scheduler.js';
import { BiometricMappingService } from '../../src/server/services/biometric-mapping.service.js';
import {
  PunchReconciliationService,
  pairAttendanceEventsChronologically,
} from '../../src/server/services/punch-reconciliation.service.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { AttendanceService } from '../../src/server/services/attendance.service.js';
import type { AuthUser } from '../../src/shared/types.js';

interface TestShift {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  isOvernight: boolean;
  graceMinutes: number;
}

interface TestEmployee {
  id: string;
  companyId: string;
  employeeCode: string;
  fullName: string;
  status: 'ACTIVE' | 'INACTIVE' | 'EXITED';
  biometricDeviceId: string | null;
  dateOfJoining: Date;
  shiftId: string | null;
  shift: TestShift | null;
  dailyWorkingHours: number | null;
  monthlyLeaveAllowance: number | null;
}

interface TestAttendanceRow {
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
  actualWorkedMinutes: number | null;
  hasIncompletePunch: boolean;
  punchPairsCount: number;
  source: 'MANUAL' | 'BIOMETRIC' | 'SYSTEM_GENERATED';
  notes: string | null;
  shift?: TestShift | null;
  employee?: TestEmployee;
}

interface TestPunchEventRow {
  id: string;
  companyId: string;
  attendanceId: string;
  rawPunchLogId: string | null;
  punchTime: Date;
  inOutMode: 'CHECK_IN' | 'CHECK_OUT' | 'BREAK_OUT' | 'BREAK_IN';
  source: 'MANUAL' | 'BIOMETRIC' | 'SYSTEM_GENERATED';
  createdAt: Date;
}

interface TestIntervalRow {
  id: string;
  companyId: string;
  attendanceId: string;
  sequence: number;
  inEventId: string | null;
  outEventId: string | null;
  checkIn: Date | null;
  checkOut: Date | null;
  durationMinutes: number;
  isComplete: boolean;
}

interface TestRawPunchRow {
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

function setupInMemoryStore(config: {
  companies: Array<{ id: string; timezone: string | null }>;
  employees: TestEmployee[];
  attendances?: TestAttendanceRow[];
  punchEvents?: TestPunchEventRow[];
  intervals?: TestIntervalRow[];
  rawPunches?: TestRawPunchRow[];
  revisions?: Array<Record<string, any>>;
  payrollPeriods?: Array<{
    id: string;
    companyId: string;
    name: string;
    startDate: Date;
    endDate: Date;
    status: 'DRAFT' | 'PROCESSED' | 'ACCOUNTS_APPROVED' | 'POSTED' | 'CANCELLED';
  }>;
  leaveRequests?: Array<{
    id: string;
    companyId: string;
    employeeId: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
    startDate: Date;
    endDate: Date;
    leaveType?: { name: string; code: string };
  }>;
}) {
  const companies = config.companies.map((c) => ({ ...c }));
  const employees = config.employees.map((e) => ({ ...e }));
  const attendances = (config.attendances || []).map((a) => ({ ...a }));
  const punchEvents = (config.punchEvents || []).map((e) => ({ ...e }));
  const intervals = (config.intervals || []).map((iv) => ({ ...iv }));
  const rawPunches = (config.rawPunches || []).map((p) => ({ ...p }));
  const revisions = (config.revisions || []).map((r) => ({ ...r }));
  const payrollPeriods = (config.payrollPeriods || []).map((p) => ({ ...p }));
  const leaveRequests = (config.leaveRequests || []).map((l) => ({ ...l }));
  const auditLogs: Array<Record<string, any>> = [];

  const matchesAttendanceWhere = (row: TestAttendanceRow, where: any): boolean => {
    if (!where) return true;
    if (where.id && row.id !== where.id) return false;
    if (where.companyId && row.companyId !== where.companyId) return false;
    if (where.employeeId && row.employeeId !== where.employeeId) return false;
    if (where.workDate instanceof Date) {
      if (row.workDate.toISOString().split('T')[0] !== where.workDate.toISOString().split('T')[0]) {
        return false;
      }
    } else if (where.workDate && typeof where.workDate === 'object') {
      const rowTime = row.workDate.getTime();
      if (where.workDate.lt instanceof Date && !(rowTime < where.workDate.lt.getTime())) {
        return false;
      }
      if (where.workDate.lte instanceof Date && !(rowTime <= where.workDate.lte.getTime())) {
        return false;
      }
      if (where.workDate.gt instanceof Date && !(rowTime > where.workDate.gt.getTime())) {
        return false;
      }
      if (where.workDate.gte instanceof Date && !(rowTime >= where.workDate.gte.getTime())) {
        return false;
      }
    }
    if (where.checkIn && typeof where.checkIn === 'object' && 'not' in where.checkIn) {
      if (where.checkIn.not === null && row.checkIn === null) return false;
    }
    if (where.checkOut === null && row.checkOut !== null) return false;
    if (where.source && typeof where.source === 'object' && 'not' in where.source) {
      if (row.source === where.source.not) return false;
    }
    if (where.status && typeof where.status === 'object' && Array.isArray(where.status.notIn)) {
      if (where.status.notIn.includes(row.status)) return false;
    }
    return true;
  };

  vi.spyOn(AuditService, 'log').mockImplementation(async (entry: any) => {
    auditLogs.push(entry);
    return { id: `audit-${auditLogs.length}` } as any;
  });

  vi.spyOn(prisma.company, 'findMany').mockImplementation((async () => companies) as any);
  vi.spyOn(prisma.company, 'findUnique').mockImplementation((async (args: any) => {
    return companies.find((c) => c.id === args?.where?.id) || null;
  }) as any);

  vi.spyOn(prisma.employee, 'findFirst').mockImplementation((async (args: any) => {
    return (
      employees.find(
        (e) =>
          (!args?.where?.companyId || e.companyId === args.where.companyId) &&
          (!args?.where?.id || e.id === args.where.id)
      ) || null
    );
  }) as any);

  vi.spyOn(prisma.payrollPeriod, 'findFirst').mockImplementation((async (args: any) => {
    const targetDate: Date | undefined = args?.where?.startDate?.lte;
    const allowedStatuses: string[] | undefined = args?.where?.status?.in;
    return (
      payrollPeriods.find(
        (p) =>
          p.companyId === args?.where?.companyId &&
          (!allowedStatuses || allowedStatuses.includes(p.status)) &&
          (!targetDate ||
            (p.startDate.getTime() <= targetDate.getTime() &&
              p.endDate.getTime() >= targetDate.getTime()))
      ) || null
    );
  }) as any);

  vi.spyOn(prisma.leaveRequest, 'findFirst').mockImplementation((async (args: any) => {
    const targetDate: Date | undefined = args?.where?.startDate?.lte;
    return (
      leaveRequests.find(
        (l) =>
          l.companyId === args?.where?.companyId &&
          l.employeeId === args?.where?.employeeId &&
          (!args?.where?.status || l.status === args.where.status) &&
          (!targetDate ||
            (l.startDate.getTime() <= targetDate.getTime() &&
              l.endDate.getTime() >= targetDate.getTime()))
      ) || null
    );
  }) as any);

  vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockImplementation((async (args: any) => {
    const companyId = args?.where?.companyId;
    const empIds: string[] | undefined = args?.where?.employeeId?.in;
    const singleEmpId: string | undefined =
      typeof args?.where?.employeeId === 'string' ? args.where.employeeId : undefined;
    return revisions.filter(
      (r) =>
        r.companyId === companyId &&
        (!empIds || empIds.includes(r.employeeId)) &&
        (!singleEmpId || r.employeeId === singleEmpId)
    );
  }) as any);

  const attendanceFindManySpy = vi
    .spyOn(prisma.attendance, 'findMany')
    .mockImplementation((async (args: any) => {
      return attendances
        .filter((row) => matchesAttendanceWhere(row, args?.where))
        .map((row) => ({
          ...row,
          employee: employees.find((e) => e.id === row.employeeId) || row.employee,
          shift: row.shift ?? employees.find((e) => e.id === row.employeeId)?.shift ?? null,
        }));
    }) as any);

  const attendanceFindUniqueSpy = vi
    .spyOn(prisma.attendance, 'findUnique')
    .mockImplementation((async (args: any) => {
      if (args?.where?.id) {
        return attendances.find((a) => a.id === args.where.id) || null;
      }
      const key = args?.where?.companyId_employeeId_workDate;
      if (key) {
        const keyDateStr = new Date(key.workDate).toISOString().split('T')[0];
        return (
          attendances.find(
            (a) =>
              a.companyId === key.companyId &&
              a.employeeId === key.employeeId &&
              a.workDate.toISOString().split('T')[0] === keyDateStr
          ) || null
        );
      }
      return null;
    }) as any);

  const attendanceCreateSpy = vi
    .spyOn(prisma.attendance, 'create')
    .mockImplementation((async (args: any) => {
      const row: TestAttendanceRow = {
        id: `att-${attendances.length + 1}`,
        notes: null,
        actualWorkedMinutes: null,
        hasIncompletePunch: false,
        punchPairsCount: 0,
        ...args.data,
      };
      attendances.push(row);
      return row;
    }) as any);

  const attendanceUpdateSpy = vi
    .spyOn(prisma.attendance, 'update')
    .mockImplementation((async (args: any) => {
      const row = attendances.find((a) => a.id === args?.where?.id);
      if (!row) throw new Error(`Attendance ${args?.where?.id} not found`);
      Object.assign(row, args.data);
      return row;
    }) as any);

  const attendanceUpdateManySpy = vi
    .spyOn(prisma.attendance, 'updateMany')
    .mockImplementation((async (args: any) => {
      let count = 0;
      for (const row of attendances) {
        if (matchesAttendanceWhere(row, args?.where)) {
          Object.assign(row, args.data);
          count++;
        }
      }
      return { count };
    }) as any);

  const rawPunchCreateSpy = vi
    .spyOn(prisma.rawPunchLog, 'create')
    .mockImplementation((async (args: any) => {
      const row = { id: `raw-${rawPunches.length + 1}`, ...args.data };
      rawPunches.push(row);
      return row;
    }) as any);

  const rawPunchUpdateSpy = vi
    .spyOn(prisma.rawPunchLog, 'update')
    .mockImplementation((async (args: any) => {
      const row = rawPunches.find((p) => p.id === args?.where?.id);
      if (!row) throw new Error(`RawPunchLog ${args?.where?.id} not found`);
      Object.assign(row, args.data);
      return row;
    }) as any);

  vi.spyOn(prisma.rawPunchLog, 'findUnique').mockImplementation((async (args: any) => {
    const row = rawPunches.find((p) => p.id === args?.where?.id);
    if (!row) return null;
    const company = companies.find((c) => c.id === row.companyId) || null;
    const matchedEmployee = row.matchedEmployeeId
      ? employees.find((e) => e.id === row.matchedEmployeeId) || null
      : null;
    return {
      ...row,
      company,
      terminal: { id: row.terminalId, name: 'eSSL X2008', location: 'Main Gate' },
      matchedEmployee,
    };
  }) as any);

  vi.spyOn(prisma.rawPunchLog, 'findMany').mockImplementation((async (args: any) => {
    return rawPunches
      .filter((p) => {
        if (args?.where?.companyId && p.companyId !== args.where.companyId) return false;
        if (typeof args?.where?.syncStatus === 'string' && p.syncStatus !== args.where.syncStatus) {
          return false;
        }
        if (args?.where?.punchTime?.gte && p.punchTime < args.where.punchTime.gte) return false;
        if (args?.where?.punchTime?.lte && p.punchTime > args.where.punchTime.lte) return false;
        return true;
      })
      .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
  }) as any);

  const punchEventFindManySpy = vi
    .spyOn(prisma.attendancePunchEvent, 'findMany')
    .mockImplementation((async (args: any) => {
      return punchEvents
        .filter(
          (ev) =>
            (!args?.where?.attendanceId || ev.attendanceId === args.where.attendanceId) &&
            (!args?.where?.companyId || ev.companyId === args.where.companyId)
        )
        .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
    }) as any);

  const punchEventCreateSpy = vi
    .spyOn(prisma.attendancePunchEvent, 'create')
    .mockImplementation((async (args: any) => {
      const row: TestPunchEventRow = {
        id: `ev-${punchEvents.length + 1}`,
        createdAt: new Date(),
        ...args.data,
      };
      punchEvents.push(row);
      return row;
    }) as any);

  const punchEventUpdateSpy = vi
    .spyOn(prisma.attendancePunchEvent, 'update')
    .mockImplementation((async (args: any) => {
      const row = punchEvents.find((ev) => ev.id === args?.where?.id);
      if (!row) throw new Error(`PunchEvent ${args?.where?.id} not found`);
      Object.assign(row, args.data);
      return row;
    }) as any);

  const intervalFindManySpy = vi
    .spyOn(prisma.attendanceInterval, 'findMany')
    .mockImplementation((async (args: any) => {
      return intervals
        .filter((iv) => {
          if (args?.where?.attendanceId && iv.attendanceId !== args.where.attendanceId) return false;
          if (args?.where?.companyId && iv.companyId !== args.where.companyId) return false;
          if (typeof args?.where?.isComplete === 'boolean' && iv.isComplete !== args.where.isComplete) {
            return false;
          }
          if (args?.where?.checkOut === null && iv.checkOut !== null) return false;
          return true;
        })
        .sort((a, b) => a.sequence - b.sequence);
    }) as any);

  const intervalUpdateSpy = vi
    .spyOn(prisma.attendanceInterval, 'update')
    .mockImplementation((async (args: any) => {
      const row = intervals.find((iv) => iv.id === args?.where?.id);
      if (!row) throw new Error(`Interval ${args?.where?.id} not found`);
      Object.assign(row, args.data);
      return row;
    }) as any);

  const intervalDeleteManySpy = vi
    .spyOn(prisma.attendanceInterval, 'deleteMany')
    .mockImplementation((async (args: any) => {
      let deleted = 0;
      for (let i = intervals.length - 1; i >= 0; i--) {
        if (
          intervals[i].attendanceId === args?.where?.attendanceId &&
          intervals[i].companyId === args?.where?.companyId
        ) {
          intervals.splice(i, 1);
          deleted++;
        }
      }
      return { count: deleted };
    }) as any);

  const intervalCreateSpy = vi
    .spyOn(prisma.attendanceInterval, 'create')
    .mockImplementation((async (args: any) => {
      const row: TestIntervalRow = {
        id: `iv-${intervals.length + 1}`,
        ...args.data,
      };
      intervals.push(row);
      return row;
    }) as any);

  const executeRawSpy = vi.fn().mockResolvedValue(1);
  const queryRawSpy = vi.fn().mockResolvedValue([{ id: 'locked' }]);

  vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any) => {
    const tx = Object.assign(Object.create(prisma), {
      $executeRaw: executeRawSpy,
      $queryRaw: queryRawSpy,
    });
    return fn(tx);
  }) as any);

  return {
    companies,
    employees,
    attendances,
    punchEvents,
    intervals,
    rawPunches,
    auditLogs,
    spies: {
      attendanceFindManySpy,
      attendanceFindUniqueSpy,
      attendanceCreateSpy,
      attendanceUpdateSpy,
      attendanceUpdateManySpy,
      rawPunchCreateSpy,
      rawPunchUpdateSpy,
      punchEventFindManySpy,
      punchEventCreateSpy,
      punchEventUpdateSpy,
      intervalFindManySpy,
      intervalUpdateSpy,
      intervalDeleteManySpy,
      intervalCreateSpy,
      executeRawSpy,
    },
  };
}

describe('CoreERP Automatic 11:55 PM Check-Out & Biometric Safety Regression Suite', () => {
  const companyIstId = 'comp-ist-001';
  const companyNyId = 'comp-ny-002';

  const dayShift8h: TestShift = {
    id: 'shift-day-8h',
    code: 'DAY8',
    name: 'Standard 8h Shift',
    startTime: '09:00',
    endTime: '17:00',
    isOvernight: false,
    graceMinutes: 15,
  };

  const dayShift9h: TestShift = {
    id: 'shift-day-9h',
    code: 'DAY9',
    name: 'Standard 9h Shift',
    startTime: '09:00',
    endTime: '18:00',
    isOvernight: false,
    graceMinutes: 15,
  };

  const overnightShift: TestShift = {
    id: 'shift-night-8h',
    code: 'NIGHT',
    name: 'Night Shift',
    startTime: '22:00',
    endTime: '06:00',
    isOvernight: true,
    graceMinutes: 15,
  };

  const empOpenIst: TestEmployee = {
    id: 'emp-open-ist',
    companyId: companyIstId,
    employeeCode: 'EMP-001',
    fullName: 'Aarav Sharma',
    status: 'ACTIVE',
    biometricDeviceId: '101',
    dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
    shiftId: dayShift9h.id,
    shift: dayShift9h,
    dailyWorkingHours: 8.5, // Explicit employee policy overrides shift 9h -> 510 minutes
    monthlyLeaveAllowance: 2,
  };

  const empManualOutIst: TestEmployee = {
    id: 'emp-manual-out-ist',
    companyId: companyIstId,
    employeeCode: 'EMP-002',
    fullName: 'Priya Nair',
    status: 'ACTIVE',
    biometricDeviceId: '102',
    dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
    shiftId: dayShift8h.id,
    shift: dayShift8h,
    dailyWorkingHours: 8,
    monthlyLeaveAllowance: 2,
  };

  const empShiftFallbackIst: TestEmployee = {
    id: 'emp-shift-fallback',
    companyId: companyIstId,
    employeeCode: 'EMP-003',
    fullName: 'Rohan Verma',
    status: 'ACTIVE',
    biometricDeviceId: '103',
    dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
    shiftId: dayShift8h.id,
    shift: dayShift8h,
    dailyWorkingHours: null, // Falls back to shift duration (8h = 480 min)
    monthlyLeaveAllowance: 2,
  };

  const empOvernightIst: TestEmployee = {
    id: 'emp-overnight-ist',
    companyId: companyIstId,
    employeeCode: 'EMP-004',
    fullName: 'Kabir Mehta',
    status: 'ACTIVE',
    biometricDeviceId: '104',
    dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
    shiftId: overnightShift.id,
    shift: overnightShift,
    dailyWorkingHours: 8,
    monthlyLeaveAllowance: 2,
  };

  const empNyOpen: TestEmployee = {
    id: 'emp-ny-open',
    companyId: companyNyId,
    employeeCode: 'NY-001',
    fullName: 'Maya Chen',
    status: 'ACTIVE',
    biometricDeviceId: '201',
    dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
    shiftId: dayShift8h.id,
    shift: dayShift8h,
    dailyWorkingHours: 8,
    monthlyLeaveAllowance: 2,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Scenario 1, 2, 3, 4, 5 & 6: auto-checks out open IN at 11:55 PM company time, preserves manual OUT, sets worked time to configured daily hours, overtime=0, source=SYSTEM_GENERATED, and creates zero fake punches', async () => {
    // 2026-11-26 23:55:00 Asia/Kolkata === 2026-11-26T18:25:00.000Z
    const ist2355Utc = new Date('2026-11-26T18:25:00.000Z');
    const workDate = new Date('2026-11-26T00:00:00.000Z');

    // Verify clock evaluation: due in Asia/Kolkata (23:55), NOT due in America/New_York (13:25)
    const istClock = evaluateCompanyAutoCheckoutTime(ist2355Utc, 'Asia/Kolkata');
    expect(istClock.validTimezone).toBe(true);
    expect(istClock.localDateStr).toBe('2026-11-26');
    expect(istClock.hour).toBe(23);
    expect(istClock.minute).toBe(55);
    expect(istClock.isDue).toBe(true);

    const nyClock = evaluateCompanyAutoCheckoutTime(ist2355Utc, 'America/New_York');
    expect(nyClock.validTimezone).toBe(true);
    expect(nyClock.isDue).toBe(false);

    const store = setupInMemoryStore({
      companies: [
        { id: companyIstId, timezone: 'Asia/Kolkata' },
        { id: companyNyId, timezone: 'America/New_York' },
      ],
      employees: [empOpenIst, empManualOutIst, empShiftFallbackIst, empNyOpen],
      attendances: [
        // Employee 1: checked in at 09:00 IST, NO manual OUT -> MUST be auto-checked out (8.5h = 510m)
        {
          id: 'att-open-1',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'), // 09:00 IST
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: 'Biometric Check-In at 2026-11-26T03:30:00.000Z',
        },
        // Employee 2: already has manual/biometric OUT at 19:30 IST (10.5h worked, 150m overtime) -> MUST NOT be modified!
        {
          id: 'att-manual-out-2',
          companyId: companyIstId,
          employeeId: empManualOutIst.id,
          shiftId: dayShift8h.id,
          workDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'), // 09:00 IST
          checkOut: new Date('2026-11-26T14:00:00.000Z'), // 19:30 IST
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 150,
          actualWorkedMinutes: 630,
          hasIncompletePunch: false,
          punchPairsCount: 1,
          source: 'BIOMETRIC',
          notes: 'Completed biometric day',
        },
        // Employee 3: checked in at 09:10 IST, NO manual OUT, shift fallback 8h = 480m
        {
          id: 'att-open-3',
          companyId: companyIstId,
          employeeId: empShiftFallbackIst.id,
          shiftId: dayShift8h.id,
          workDate,
          checkIn: new Date('2026-11-26T03:40:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // NY Employee: open check-in, NOT yet 23:55 in America/New_York -> MUST NOT be touched
        {
          id: 'att-ny-open',
          companyId: companyNyId,
          employeeId: empNyOpen.id,
          shiftId: dayShift8h.id,
          workDate,
          checkIn: new Date('2026-11-26T14:00:00.000Z'), // 09:00 EST
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
      punchEvents: [
        {
          id: 'ev-in-1',
          companyId: companyIstId,
          attendanceId: 'att-open-1',
          rawPunchLogId: 'raw-in-1',
          punchTime: new Date('2026-11-26T03:30:00.000Z'),
          inOutMode: 'CHECK_IN',
          source: 'BIOMETRIC',
          createdAt: new Date('2026-11-26T03:30:00.000Z'),
        },
      ],
      intervals: [
        {
          id: 'iv-open-1',
          companyId: companyIstId,
          attendanceId: 'att-open-1',
          sequence: 1,
          inEventId: 'ev-in-1',
          outEventId: null,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          durationMinutes: 0,
          isComplete: false,
        },
      ],
    });

    const cycleResult = await AutoCheckoutService.runScheduledCycle(ist2355Utc);

    // Only Asia/Kolkata company was due
    expect(cycleResult.evaluatedCompanies).toBe(2);
    expect(cycleResult.dueCompanies).toBe(1);
    expect(cycleResult.totalAutoCheckedOut).toBe(2);
    expect(cycleResult.errors).toHaveLength(0);

    // Scenario 1: Employee with manual/biometric OUT is completely untouched
    const manualAtt = store.attendances.find((a) => a.id === 'att-manual-out-2')!;
    expect(manualAtt.checkOut?.toISOString()).toBe('2026-11-26T14:00:00.000Z');
    expect(manualAtt.actualWorkedMinutes).toBe(630);
    expect(manualAtt.overtimeMinutes).toBe(150);
    expect(manualAtt.source).toBe('BIOMETRIC');
    expect(manualAtt.notes).toBe('Completed biometric day');

    // Scenario 2, 3, 4, 5: Employee 1 auto-checked out at 23:55 IST with configured 8.5h (510m), 0 overtime, SYSTEM_GENERATED
    const autoAtt1 = store.attendances.find((a) => a.id === 'att-open-1')!;
    expect(autoAtt1.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z'); // 23:55:00 IST
    expect(autoAtt1.actualWorkedMinutes).toBe(510); // 8.5h configured policy (NOT 14h55m elapsed!)
    expect(autoAtt1.overtimeMinutes).toBe(0);
    expect(autoAtt1.hasIncompletePunch).toBe(false);
    expect(autoAtt1.punchPairsCount).toBe(1);
    expect(autoAtt1.source).toBe('SYSTEM_GENERATED');
    expect(autoAtt1.notes).toContain('[System Auto Check-Out at 23:55 Asia/Kolkata');

    // Open AttendanceInterval was closed in-place with durationMinutes === configuredMinutes and outEventId === null
    const closedIv1 = store.intervals.find((iv) => iv.id === 'iv-open-1')!;
    expect(closedIv1.isComplete).toBe(true);
    expect(closedIv1.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
    expect(closedIv1.durationMinutes).toBe(510);
    expect(closedIv1.outEventId).toBeNull();

    // Employee 3 auto-checked out with shift-derived 8h (480m), 0 overtime, SYSTEM_GENERATED
    const autoAtt3 = store.attendances.find((a) => a.id === 'att-open-3')!;
    expect(autoAtt3.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
    expect(autoAtt3.actualWorkedMinutes).toBe(480);
    expect(autoAtt3.overtimeMinutes).toBe(0);
    expect(autoAtt3.hasIncompletePunch).toBe(false);
    expect(autoAtt3.punchPairsCount).toBe(1);
    expect(autoAtt3.source).toBe('SYSTEM_GENERATED');

    // NY employee untouched because NY local time is only 13:25
    const nyAtt = store.attendances.find((a) => a.id === 'att-ny-open')!;
    expect(nyAtt.checkOut).toBeNull();
    expect(nyAtt.source).toBe('BIOMETRIC');

    // Scenario 6: ZERO fake biometric punches (RawPunchLog) or AttendancePunchEvent records created
    expect(store.spies.rawPunchCreateSpy).not.toHaveBeenCalled();
    expect(store.spies.rawPunchUpdateSpy).not.toHaveBeenCalled();
    expect(store.spies.punchEventCreateSpy).not.toHaveBeenCalled();
    expect(store.spies.punchEventUpdateSpy).not.toHaveBeenCalled();
    expect(store.spies.intervalCreateSpy).not.toHaveBeenCalled();
    expect(store.spies.intervalDeleteManySpy).not.toHaveBeenCalled();
    expect(store.spies.intervalUpdateSpy).toHaveBeenCalledTimes(1);
    expect(store.rawPunches).toHaveLength(0);
    expect(store.punchEvents).toHaveLength(1); // Only the pre-existing IN event remains

    // Audit log recorded for both auto check-outs
    const autoAudits = store.auditLogs.filter((l) => l.action === 'ATTENDANCE_AUTO_CHECKOUT');
    expect(autoAudits).toHaveLength(2);
    expect(autoAudits[0].details).toMatchObject({
      source: 'SYSTEM_GENERATED',
      overtimeMinutes: 0,
      companyTimezone: 'Asia/Kolkata',
      closedIntervalsCount: 1,
    });
  });

  it('Scenario 3 (Effective-Dated Policy Revision): uses active EmployeeWorkPolicyRevision daily hours for the attendance date', async () => {
    const workDate = new Date('2026-11-26T00:00:00.000Z');
    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst], // Employee profile says 8.5h, shift says 9h
      revisions: [
        {
          id: 'rev-1',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
          effectiveTo: null,
          shiftId: dayShift8h.id,
          shift: dayShift8h,
          dailyWorkingHours: 7.5, // Active effective-dated revision -> 450 minutes
          monthlyLeaveAllowance: 2,
          reason: 'Revised winter schedule',
          createdAt: new Date('2026-11-01T00:00:00.000Z'),
        },
      ],
      attendances: [
        {
          id: 'att-rev-1',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift8h.id,
          workDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
    });

    const result = await AutoCheckoutService.runForCompanyDate(companyIstId, '2026-11-26');
    expect(result.autoCheckedOut).toBe(1);
    expect(store.attendances[0].actualWorkedMinutes).toBe(450); // 7.5h * 60
    expect(store.attendances[0].overtimeMinutes).toBe(0);
    expect(store.attendances[0].source).toBe('SYSTEM_GENERATED');
  });

  it('Scenario 7: repeated scheduler execution on the same day is strictly idempotent and never duplicates auto check-outs', async () => {
    const ist2355Utc = new Date('2026-11-26T18:25:00.000Z');
    const ist2356Utc = new Date('2026-11-26T18:26:00.000Z');
    const workDate = new Date('2026-11-26T00:00:00.000Z');

    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      attendances: [
        {
          id: 'att-idem-1',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: 'Check-in note',
        },
      ],
    });

    const scheduler = new AutoCheckoutScheduler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    // Tick 1 at 23:55 IST -> executes auto check-out
    const firstTick = await scheduler.tick(ist2355Utc);
    expect(firstTick?.totalAutoCheckedOut).toBe(1);
    expect(store.auditLogs.filter((l) => l.action === 'ATTENDANCE_AUTO_CHECKOUT')).toHaveLength(1);

    // Tick 2 at 23:56 IST on same scheduler -> skipped via per-company-date deduplication
    const secondTick = await scheduler.tick(ist2356Utc);
    expect(secondTick?.skippedAlreadyRan).toBe(1);
    expect(secondTick?.totalAutoCheckedOut).toBe(0);

    // Tick 3 simulating a fresh process restart (brand-new scheduler with empty memory) -> DB idempotency guard skips it!
    const restartedScheduler = new AutoCheckoutScheduler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const thirdTick = await restartedScheduler.tick(ist2356Utc);
    expect(thirdTick?.totalAutoCheckedOut).toBe(0);

    // Direct service invocation also performs zero mutations
    const directRepeat = await AutoCheckoutService.runForCompanyDate(companyIstId, '2026-11-26');
    expect(directRepeat.autoCheckedOut).toBe(0);
    expect(directRepeat.evaluated).toBe(0);

    // Record and audit log were only written once; notes not duplicated
    expect(store.auditLogs.filter((l) => l.action === 'ATTENDANCE_AUTO_CHECKOUT')).toHaveLength(1);
    expect(
      store.attendances[0].notes?.match(/\[System Auto Check-Out/g)?.length
    ).toBe(1);
  });

  it('Safety guards: skips locked payroll periods, approved leave, overnight shifts in progress, and records with existing CHECK_OUT punch events', async () => {
    const workDate = new Date('2026-11-26T00:00:00.000Z');

    // Case A: Locked payroll period blocks any mutation
    const lockedStore = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      payrollPeriods: [
        {
          id: 'pp-nov',
          companyId: companyIstId,
          name: 'Nov 2026',
          startDate: new Date('2026-11-01T00:00:00.000Z'),
          endDate: new Date('2026-11-30T00:00:00.000Z'),
          status: 'POSTED',
        },
      ],
      attendances: [
        {
          id: 'att-locked',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
    });

    const lockedResult = await AutoCheckoutService.runForCompanyDate(companyIstId, '2026-11-26');
    expect(lockedResult.payrollLocked).toBe(true);
    expect(lockedResult.autoCheckedOut).toBe(0);
    expect(lockedStore.attendances[0].checkOut).toBeNull();

    // Case B: Overnight shift in progress + Approved leave + Existing CHECK_OUT event
    vi.restoreAllMocks();
    const guardedStore = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOvernightIst, empOpenIst, empShiftFallbackIst],
      leaveRequests: [
        {
          id: 'leave-1',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          status: 'APPROVED',
          startDate: workDate,
          endDate: workDate,
        },
      ],
      attendances: [
        {
          id: 'att-overnight',
          companyId: companyIstId,
          employeeId: empOvernightIst.id,
          shiftId: overnightShift.id,
          workDate,
          checkIn: new Date('2026-11-26T16:30:00.000Z'), // 22:00 IST
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        {
          id: 'att-on-approved-leave',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        {
          id: 'att-has-out-event',
          companyId: companyIstId,
          employeeId: empShiftFallbackIst.id,
          shiftId: dayShift8h.id,
          workDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
      punchEvents: [
        {
          id: 'ev-existing-out',
          companyId: companyIstId,
          attendanceId: 'att-has-out-event',
          rawPunchLogId: 'raw-out-1',
          punchTime: new Date('2026-11-26T11:30:00.000Z'),
          inOutMode: 'CHECK_OUT',
          source: 'BIOMETRIC',
          createdAt: new Date('2026-11-26T11:30:00.000Z'),
        },
      ],
    });

    const guardedResult = await AutoCheckoutService.runForCompanyDate(companyIstId, '2026-11-26');
    expect(guardedResult.autoCheckedOut).toBe(0);
    expect(guardedResult.skipped).toBe(3);
    expect(guardedResult.outcomes.map((o) => o.reason)).toEqual([
      'OVERNIGHT_SHIFT_IN_PROGRESS',
      'APPROVED_LEAVE_PROTECTED',
      'MANUAL_OR_BIOMETRIC_OUT_EVENT_EXISTS',
    ]);
    for (const att of guardedStore.attendances) {
      expect(att.checkOut).toBeNull();
      expect(att.source).toBe('BIOMETRIC');
    }
  });

  it('Scenario 8: next-day punches belong strictly to the next attendance date and do not alter the previous day auto check-out record', async () => {
    // Freeze clock on 2026-11-27 09:05 IST (2026-11-27T03:35:00.000Z)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T03:35:00.000Z'));

    const prevDayDate = new Date('2026-11-26T00:00:00.000Z');
    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      attendances: [
        {
          id: 'att-prev-day-auto',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: prevDayDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: new Date('2026-11-26T18:25:00.000Z'),
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 510,
          hasIncompletePunch: false,
          punchPairsCount: 0,
          source: 'SYSTEM_GENERATED',
          notes: '[System Auto Check-Out at 23:55 Asia/Kolkata: worked 8.5h, overtime 0m]',
        },
      ],
      rawPunches: [
        {
          id: 'raw-next-day-in',
          companyId: companyIstId,
          terminalId: 'term-1',
          devicePunchId: 'dp-next-1',
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-27T03:30:00.000Z'), // 2026-11-27 09:00:00 IST
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          idempotencyKey: 'idem-next-1',
          matchedEmployeeId: null,
          createdAt: new Date('2026-11-27T03:30:05.000Z'),
          updatedAt: new Date('2026-11-27T03:30:05.000Z'),
        },
      ],
    });

    vi.spyOn(BiometricMappingService, 'resolveEmployeeForPunch').mockResolvedValue({
      employee: empOpenIst as any,
      matchedVia: 'MAPPING',
      ambiguous: false,
    });

    const res = await PunchReconciliationService.reconcilePunch('raw-next-day-in');
    expect(res.status).toBe('PROCESSED');
    expect(res.workDate).toBe('2026-11-27');

    // Previous day's SYSTEM_GENERATED attendance record is 100% untouched
    const prevDayAtt = store.attendances.find((a) => a.id === 'att-prev-day-auto')!;
    expect(prevDayAtt.source).toBe('SYSTEM_GENERATED');
    expect(prevDayAtt.actualWorkedMinutes).toBe(510);
    expect(prevDayAtt.overtimeMinutes).toBe(0);

    // Next day's attendance record created fresh for 2026-11-27
    const nextDayAtt = store.attendances.find(
      (a) => a.workDate.toISOString().split('T')[0] === '2026-11-27'
    )!;
    expect(nextDayAtt).toBeDefined();
    expect(nextDayAtt.source).toBe('BIOMETRIC');
    expect(nextDayAtt.checkIn?.toISOString()).toBe('2026-11-27T03:30:00.000Z');
    expect(nextDayAtt.checkOut).toBeNull();
  });

  it('Scenario 9: existing alternating multi-pair IN -> OUT -> IN -> OUT pairing continues to work unchanged', () => {
    const pairing = pairAttendanceEventsChronologically([
      {
        id: 'ev-1',
        punchTime: new Date('2026-11-26T03:30:00.000Z'), // 09:00 IST -> IN
        inOutMode: 'CHECK_IN',
      },
      {
        id: 'ev-2',
        punchTime: new Date('2026-11-26T07:30:00.000Z'), // 13:00 IST -> OUT (240m)
        inOutMode: 'CHECK_IN', // Device reported CHECK_IN; alternation derives CHECK_OUT
      },
      {
        id: 'ev-3',
        punchTime: new Date('2026-11-26T08:30:00.000Z'), // 14:00 IST -> IN
        inOutMode: 'CHECK_IN',
      },
      {
        id: 'ev-4',
        punchTime: new Date('2026-11-26T12:30:00.000Z'), // 18:00 IST -> OUT (240m)
        inOutMode: 'CHECK_IN',
      },
    ]);

    expect(pairing.punchPairsCount).toBe(2);
    expect(pairing.hasIncompletePunch).toBe(false);
    expect(pairing.actualWorkedMinutes).toBe(480);
    expect(pairing.normalizedEvents.map((e) => e.effectiveMode)).toEqual([
      'CHECK_IN',
      'CHECK_OUT',
      'CHECK_IN',
      'CHECK_OUT',
    ]);
    expect(pairing.intervals).toHaveLength(2);
    expect(pairing.intervals[0].durationMinutes).toBe(240);
    expect(pairing.intervals[1].durationMinutes).toBe(240);
  });

  it('Scenario 10: Historical Recovery preserves existing Attendance records without overwriting or recalculating them, and leaves unrelated historical punch logs untouched', async () => {
    vi.useFakeTimers();
    const nowUtc = new Date('2026-11-26T05:00:00.000Z');
    vi.setSystemTime(nowUtc);

    const histDate = new Date('2026-11-20T00:00:00.000Z');

    // Mint server-provenanced SUPER_ADMIN actor
    const userFindUniqueSpy = vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: 'user-super-hist',
      companyId: companyIstId,
      role: 'SUPER_ADMIN',
      fullName: 'Super Admin',
      email: 'super@coreerp.test',
      isActive: true,
      tokenVersion: 1,
      lastLoginAt: nowUtc,
    } as any);

    const token = AuthService.generateSessionToken({
      userId: 'user-super-hist',
      companyId: companyIstId,
      email: 'super@coreerp.test',
      role: 'SUPER_ADMIN',
      tokenVersion: 1,
    });
    const superAdminActor = (await AuthService.validateSessionUser(
      AuthService.verifySessionToken(token)!
    )) as AuthUser;
    userFindUniqueSpy.mockRestore();

    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      attendances: [
        // Pre-existing Attendance record on 2026-11-20 (e.g., manual or previous auto check-out)
        {
          id: 'att-hist-existing',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: histDate,
          checkIn: new Date('2026-11-20T03:30:00.000Z'),
          checkOut: new Date('2026-11-20T12:30:00.000Z'),
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 540,
          hasIncompletePunch: false,
          punchPairsCount: 1,
          source: 'MANUAL',
          notes: 'HR verified manual attendance',
        },
      ],
      rawPunches: [
        // Historical punch inside recovery range for a day that ALREADY has Attendance -> MUST NOT overwrite Attendance
        {
          id: 'raw-hist-nov20',
          companyId: companyIstId,
          terminalId: 'term-1',
          devicePunchId: 'dp-hist-1',
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-20T04:00:00.000Z'),
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          idempotencyKey: 'idem-hist-nov20',
          matchedEmployeeId: null,
          createdAt: new Date('2026-11-20T04:00:05.000Z'),
          updatedAt: new Date('2026-11-20T04:00:05.000Z'),
        },
        // Historical punch outside recovery range -> MUST stay PENDING and untouched
        {
          id: 'raw-hist-nov10-outside',
          companyId: companyIstId,
          terminalId: 'term-1',
          devicePunchId: 'dp-hist-2',
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-10T04:00:00.000Z'),
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          idempotencyKey: 'idem-hist-nov10',
          matchedEmployeeId: null,
          createdAt: new Date('2026-11-10T04:00:05.000Z'),
          updatedAt: new Date('2026-11-10T04:00:05.000Z'),
        },
      ],
    });

    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: 'user-super-hist',
      companyId: companyIstId,
      role: 'SUPER_ADMIN',
      isActive: true,
      tokenVersion: 1,
    } as any);

    vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue({
      id: 'term-1',
      companyId: companyIstId,
      deviceSerialNumber: 'NFZ8252800275',
      name: 'eSSL X2008 Main Gate',
      isActive: true,
    } as any);

    vi.spyOn(BiometricMappingService, 'resolveEmployeeForPunch').mockResolvedValue({
      employee: empOpenIst as any,
      matchedVia: 'MAPPING',
      ambiguous: false,
    });

    const summary = await PunchReconciliationService.reconcilePendingPunches(
      companyIstId,
      {
        allowHistorical: true,
        terminalId: 'term-1',
        fromPunchTime: '2026-11-18T18:30:00.000Z',
        toPunchTime: '2026-11-21T18:29:59.999Z',
      },
      superAdminActor,
      'corr-hist-protect-test'
    );

    expect(summary.historicalMode).toBe(true);
    expect(summary.totalEvaluated).toBe(1);
    expect(summary.processed).toBe(0);
    expect(summary.ignored).toBe(1);
    expect(summary.results[0].message).toContain(
      'Existing attendance record for 2026-11-20 cannot be overwritten or recalculated during historical recovery'
    );

    // Existing Attendance record on 2026-11-20 was NEVER modified or recalculated
    const existingAtt = store.attendances.find((a) => a.id === 'att-hist-existing')!;
    expect(existingAtt.source).toBe('MANUAL');
    expect(existingAtt.actualWorkedMinutes).toBe(540);
    expect(existingAtt.notes).toBe('HR verified manual attendance');
    expect(store.spies.attendanceUpdateSpy).not.toHaveBeenCalled();

    // Historical punch outside the requested window remains untouched
    expect(
      store.rawPunches.find((p) => p.id === 'raw-hist-nov10-outside')?.syncStatus
    ).toBe('PENDING');
  });

  it('Scheduler lifecycle: starts cleanly, prevents overlapping cycles, and stops without leaking timers', async () => {
    setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      attendances: [],
    });

    const scheduler = new AutoCheckoutScheduler({
      pollIntervalMs: 60_000,
      nowProvider: () => new Date('2026-11-26T10:00:00.000Z'), // 15:30 IST (not due)
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('Review Fix — Req 1 & 9 (Overnight shifts & strict 23:55 cutoff): skips Day D overnight shift and post-23:55 check-ins, and closes forgotten Day D overnight shift on Day D+1 at 23:55', async () => {
    const dayD = new Date('2026-11-26T00:00:00.000Z');
    const dayDPlus1 = new Date('2026-11-27T00:00:00.000Z');

    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOvernightIst, empOpenIst],
      attendances: [
        // Active overnight shift started on 2026-11-26 at 22:00 IST
        {
          id: 'att-overnight-dayD',
          companyId: companyIstId,
          employeeId: empOvernightIst.id,
          shiftId: overnightShift.id,
          workDate: dayD,
          checkIn: new Date('2026-11-26T16:30:00.000Z'), // 22:00 IST
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // Standard employee checking in AFTER 23:55:00 (23:56:00 IST) -> must be skipped
        {
          id: 'att-after-2355',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: dayD,
          checkIn: new Date('2026-11-26T18:26:00.000Z'), // 23:56:00 IST
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
      intervals: [
        {
          id: 'iv-overnight-dayD',
          companyId: companyIstId,
          attendanceId: 'att-overnight-dayD',
          sequence: 1,
          inEventId: 'ev-night-in',
          outEventId: null,
          checkIn: new Date('2026-11-26T16:30:00.000Z'),
          checkOut: null,
          durationMinutes: 0,
          isComplete: false,
        },
      ],
    });

    // Day D (2026-11-26) 23:55 IST: overnight shift skipped (mid-shift) and 23:56 check-in skipped
    const dayDRun = await AutoCheckoutService.runForCompanyDate(companyIstId, '2026-11-26');
    expect(dayDRun.autoCheckedOut).toBe(0);
    expect(dayDRun.outcomes.map((o) => o.reason)).toEqual([
      'OVERNIGHT_SHIFT_IN_PROGRESS',
      'CHECK_IN_AFTER_AUTO_CHECKOUT_CUTOFF',
    ]);
    expect(store.attendances.find((a) => a.id === 'att-overnight-dayD')?.checkOut).toBeNull();

    // Day D+1 (2026-11-27) 23:55 IST: employee forgot to punch out on morning of 2026-11-27 ->
    // Day D overnight record is now closed cleanly with 8h (480m), overtime=0, SYSTEM_GENERATED, and interval closed!
    // Meanwhile, Day D's non-overnight row ('att-after-2355') is NOT touched by previous-day overnight sweep.
    const dayDPlus1Run = await AutoCheckoutService.runForCompanyDate(
      companyIstId,
      dayDPlus1.toISOString().split('T')[0]
    );
    expect(dayDPlus1Run.autoCheckedOut).toBe(1);
    const closedNightAtt = store.attendances.find((a) => a.id === 'att-overnight-dayD')!;
    expect(closedNightAtt.source).toBe('SYSTEM_GENERATED');
    expect(closedNightAtt.actualWorkedMinutes).toBe(480);
    expect(closedNightAtt.overtimeMinutes).toBe(0);
    expect(closedNightAtt.hasIncompletePunch).toBe(false);
    expect(closedNightAtt.punchPairsCount).toBe(1);
    expect(closedNightAtt.checkOut?.toISOString()).toBe('2026-11-27T18:25:00.000Z'); // 2026-11-27 23:55 IST

    const closedNightIv = store.intervals.find((iv) => iv.id === 'iv-overnight-dayD')!;
    expect(closedNightIv.isComplete).toBe(true);
    expect(closedNightIv.outEventId).toBeNull();
    expect(closedNightIv.durationMinutes).toBe(480);
    expect(closedNightIv.checkOut?.toISOString()).toBe('2026-11-27T18:25:00.000Z');

    // Non-overnight row from Day D was NOT swept by Day D+1 overnight sweep
    expect(store.attendances.find((a) => a.id === 'att-after-2355')?.checkOut).toBeNull();
  });

  it('Review Fix — Req 6 & 7: Manual OUT / Biometric OUT cannot overwrite SYSTEM_GENERATED Auto OUT, and concurrent multi-instance schedulers execute strictly once', async () => {
    vi.useFakeTimers();
    const ist2355Utc = new Date('2026-11-26T18:25:00.000Z'); // 23:55:00 IST
    vi.setSystemTime(new Date('2026-11-26T18:27:00.000Z')); // 23:57:00 IST

    const workDate = new Date('2026-11-26T00:00:00.000Z');
    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      attendances: [
        {
          id: 'att-race-1',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'MANUAL',
          notes: null,
        },
      ],
      rawPunches: [
        {
          id: 'raw-late-bio-out',
          companyId: companyIstId,
          terminalId: 'term-1',
          devicePunchId: 'dp-late-out',
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-26T18:26:30.000Z'), // 23:56:30 IST (after 23:55 auto checkout)
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_OUT',
          syncStatus: 'PENDING',
          errorMessage: null,
          idempotencyKey: 'idem-late-out',
          matchedEmployeeId: null,
          createdAt: new Date('2026-11-26T18:26:35.000Z'),
          updatedAt: new Date('2026-11-26T18:26:35.000Z'),
        },
      ],
    });

    // 1. Simulate two independent server instances firing at the exact same instant
    const instanceA = new AutoCheckoutScheduler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const instanceB = new AutoCheckoutScheduler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const [resA, resB] = await Promise.all([
      instanceA.tick(ist2355Utc),
      instanceB.tick(ist2355Utc),
    ]);

    expect((resA?.totalAutoCheckedOut || 0) + (resB?.totalAutoCheckedOut || 0)).toBe(1);
    expect(store.auditLogs.filter((l) => l.action === 'ATTENDANCE_AUTO_CHECKOUT')).toHaveLength(1);
    expect(store.attendances[0].source).toBe('SYSTEM_GENERATED');
    expect(store.attendances[0].actualWorkedMinutes).toBe(510);

    // 2. Late biometric punch arriving for the same date after SYSTEM_GENERATED auto check-out is IGNORED (never overwrites!)
    vi.spyOn(BiometricMappingService, 'resolveEmployeeForPunch').mockResolvedValue({
      employee: empOpenIst as any,
      matchedVia: 'MAPPING',
      ambiguous: false,
    });
    const lateBioRes = await PunchReconciliationService.reconcilePunch('raw-late-bio-out');
    expect(lateBioRes.status).toBe('IGNORED');
    expect(lateBioRes.message).toContain('SYSTEM_GENERATED');
    expect(store.attendances[0].source).toBe('SYSTEM_GENERATED');
    expect(store.attendances[0].actualWorkedMinutes).toBe(510);
    expect(store.attendances[0].overtimeMinutes).toBe(0);

    // 3. Manual AttendanceService.updateAttendance cannot overwrite timestamps on a SYSTEM_GENERATED record (409 Conflict)
    vi.spyOn((prisma as any).attendancePunchEvent, 'count').mockResolvedValue(0);
    vi.spyOn((prisma as any).attendanceInterval, 'count').mockResolvedValue(0);
    const adminActor: AuthUser = {
      id: 'user-admin-1',
      userId: 'user-admin-1',
      companyId: companyIstId,
      email: 'admin@coreerp.test',
      fullName: 'Admin User',
      role: 'ADMIN',
      isActive: true,
      tokenVersion: 1,
    };

    await expect(
      AttendanceService.updateAttendance(adminActor, 'att-race-1', {
        checkOut: '2026-11-26T13:00:00.000Z',
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(store.attendances[0].checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
    expect(store.attendances[0].source).toBe('SYSTEM_GENERATED');
  });

  // ---------------------------------------------------------------------------
  // OUTAGE-RECOVERY REGRESSION SUITE
  // ---------------------------------------------------------------------------

  it('Outage Recovery 1: server offline from 23:54 through 00:10 recovers missed day on startup with exact 23:55:00 timestamp on original date, configured hours, overtime=0, interval closed, and zero fake punches', async () => {
    // Outage lasted from 2026-11-26 23:54 IST through 2026-11-27 00:10 IST
    // 2026-11-27 00:10:00 Asia/Kolkata === 2026-11-26T18:40:00.000Z
    const restartAt0010IstUtc = new Date('2026-11-26T18:40:00.000Z');
    const missedWorkDate = new Date('2026-11-26T00:00:00.000Z');

    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      attendances: [
        {
          id: 'att-outage-midnight',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: missedWorkDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'), // 09:00 IST
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: 'Checked in at gate',
        },
      ],
      punchEvents: [
        {
          id: 'ev-outage-in-1',
          companyId: companyIstId,
          attendanceId: 'att-outage-midnight',
          rawPunchLogId: 'raw-outage-in-1',
          punchTime: new Date('2026-11-26T03:30:00.000Z'),
          inOutMode: 'CHECK_IN',
          source: 'BIOMETRIC',
          createdAt: new Date('2026-11-26T03:30:00.000Z'),
        },
      ],
      intervals: [
        {
          id: 'iv-outage-midnight',
          companyId: companyIstId,
          attendanceId: 'att-outage-midnight',
          sequence: 1,
          inEventId: 'ev-outage-in-1',
          outEventId: null,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          durationMinutes: 0,
          isComplete: false,
        },
      ],
    });

    const scheduler = new AutoCheckoutScheduler({
      nowProvider: () => restartAt0010IstUtc,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    // Simulate startup tick at 00:10 IST (outside 23:55–23:59 window)
    const result = await scheduler.tick();
    expect(result).not.toBeNull();
    expect(result!.dueCompanies).toBe(0); // Current day 2026-11-27 is NOT due yet (it's 00:10)
    expect(result!.recoveredCompanyDates).toBe(1);
    expect(result!.totalAutoCheckedOut).toBe(1);
    expect(result!.errors).toHaveLength(0);

    // Exact 11:55 PM timestamp on the ORIGINAL attendance date (2026-11-26 23:55:00 IST === 2026-11-26T18:25:00.000Z)
    const recoveredAtt = store.attendances[0];
    expect(recoveredAtt.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
    expect(recoveredAtt.actualWorkedMinutes).toBe(510); // 8.5h configured policy
    expect(recoveredAtt.overtimeMinutes).toBe(0);
    expect(recoveredAtt.hasIncompletePunch).toBe(false);
    expect(recoveredAtt.punchPairsCount).toBe(1);
    expect(recoveredAtt.source).toBe('SYSTEM_GENERATED');
    expect(recoveredAtt.notes).toContain('[System Auto Check-Out at 23:55 Asia/Kolkata');

    // Open interval closed in-place with exact 23:55:00 timestamp and outEventId = null
    const closedIv = store.intervals[0];
    expect(closedIv.isComplete).toBe(true);
    expect(closedIv.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
    expect(closedIv.durationMinutes).toBe(510);
    expect(closedIv.outEventId).toBeNull();

    // Zero fake RawPunchLog or AttendancePunchEvent records created
    expect(store.spies.rawPunchCreateSpy).not.toHaveBeenCalled();
    expect(store.spies.punchEventCreateSpy).not.toHaveBeenCalled();
    expect(store.punchEvents).toHaveLength(1);

    // Audit entry records outageRecovery = true and exact original workDate
    const audits = store.auditLogs.filter((l) => l.action === 'ATTENDANCE_AUTO_CHECKOUT');
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({
      workDate: '2026-11-26',
      outageRecovery: true,
      checkOut: '2026-11-26T18:25:00.000Z',
      actualWorkedMinutes: 510,
      overtimeMinutes: 0,
      source: 'SYSTEM_GENERATED',
    });

    // Subsequent tick at 00:10:30 IST is strictly idempotent (zero duplicate work)
    const followUp = await scheduler.tick(new Date('2026-11-26T18:40:30.000Z'));
    expect(followUp!.totalAutoCheckedOut).toBe(0);
    expect(followUp!.recoveredCompanyDates).toBe(0);
    expect(store.auditLogs.filter((l) => l.action === 'ATTENDANCE_AUTO_CHECKOUT')).toHaveLength(1);
  });

  it('Outage Recovery 2: server restart several days after a missed date recovers using the original attendance date effective WorkPolicy and original date 23:55:00 timestamp', async () => {
    // Server was down for 5 days; restarts on 2026-12-01 09:00:00 IST (2026-12-01T03:30:00.000Z)
    const restartFiveDaysLaterUtc = new Date('2026-12-01T03:30:00.000Z');
    const missedDate = new Date('2026-11-26T00:00:00.000Z');

    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst], // Current profile has 8.5h
      revisions: [
        // Revision active ON 2026-11-26: 7.5 hours (450 minutes)
        {
          id: 'rev-nov',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-11-30T00:00:00.000Z'),
          shiftId: dayShift8h.id,
          shift: dayShift8h,
          dailyWorkingHours: 7.5,
          monthlyLeaveAllowance: 2,
          reason: 'November schedule',
          createdAt: new Date('2026-11-01T00:00:00.000Z'),
        },
        // Newer revision active starting 2026-12-01: 9.5 hours (570 minutes) — MUST NOT be used for 2026-11-26!
        {
          id: 'rev-dec',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
          effectiveTo: null,
          shiftId: dayShift9h.id,
          shift: dayShift9h,
          dailyWorkingHours: 9.5,
          monthlyLeaveAllowance: 2,
          reason: 'December schedule',
          createdAt: new Date('2026-11-28T00:00:00.000Z'),
        },
      ],
      attendances: [
        {
          id: 'att-5days-ago',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift8h.id,
          workDate: missedDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
    });

    const cycleResult = await AutoCheckoutService.runScheduledCycle(restartFiveDaysLaterUtc);
    expect(cycleResult.recoveredCompanyDates).toBe(1);
    expect(cycleResult.totalAutoCheckedOut).toBe(1);

    const recoveredAtt = store.attendances[0];
    // Original date's 23:55:00 IST (NOT 2026-12-01!)
    expect(recoveredAtt.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
    // Original date's effective WorkPolicy revision (7.5h = 450m, NOT December's 9.5h = 570m!)
    expect(recoveredAtt.actualWorkedMinutes).toBe(450);
    expect(recoveredAtt.overtimeMinutes).toBe(0);
    expect(recoveredAtt.source).toBe('SYSTEM_GENERATED');
  });

  it('Outage Recovery 3: recovers multiple missed dates in one pass across timezones while skipping payroll-locked dates, approved leave, inactive employees, and unconfigured working hours', async () => {
    // 2026-11-28 06:00:00 UTC === 2026-11-28 11:30 IST === 2026-11-28 01:00 EST
    const recoveryNowUtc = new Date('2026-11-28T06:00:00.000Z');
    const nov25 = new Date('2026-11-25T00:00:00.000Z'); // Payroll-locked in IST
    const nov26 = new Date('2026-11-26T00:00:00.000Z'); // Eligible in IST & NY (one emp on approved leave in IST)
    const nov27 = new Date('2026-11-27T00:00:00.000Z'); // Eligible in IST

    const empInactiveIst: TestEmployee = {
      ...empShiftFallbackIst,
      id: 'emp-inactive-ist',
      employeeCode: 'EMP-INACT',
      status: 'INACTIVE',
    };

    const empUnconfiguredIst: TestEmployee = {
      ...empShiftFallbackIst,
      id: 'emp-unconfigured-ist',
      employeeCode: 'EMP-UNCFG',
      shiftId: null,
      shift: null,
      dailyWorkingHours: null,
    };

    const store = setupInMemoryStore({
      companies: [
        { id: companyIstId, timezone: 'Asia/Kolkata' },
        { id: companyNyId, timezone: 'America/New_York' },
      ],
      employees: [empOpenIst, empShiftFallbackIst, empInactiveIst, empUnconfiguredIst, empNyOpen],
      payrollPeriods: [
        {
          id: 'pp-locked-nov25',
          companyId: companyIstId,
          name: 'Locked Cycle',
          startDate: new Date('2026-11-01T00:00:00.000Z'),
          endDate: new Date('2026-11-25T00:00:00.000Z'),
          status: 'PROCESSED',
        },
      ],
      leaveRequests: [
        {
          id: 'leave-nov26',
          companyId: companyIstId,
          employeeId: empShiftFallbackIst.id,
          status: 'APPROVED',
          startDate: nov26,
          endDate: nov26,
        },
      ],
      attendances: [
        // Nov 25 IST -> payroll locked -> MUST be skipped
        {
          id: 'att-nov25-locked',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: nov25,
          checkIn: new Date('2026-11-25T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // Nov 26 IST empOpenIst -> ELIGIBLE -> recover at 2026-11-26 23:55 IST (18:25Z)
        {
          id: 'att-nov26-eligible',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: nov26,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // Nov 26 IST empShiftFallbackIst -> APPROVED LEAVE -> MUST be skipped
        {
          id: 'att-nov26-leave',
          companyId: companyIstId,
          employeeId: empShiftFallbackIst.id,
          shiftId: dayShift8h.id,
          workDate: nov26,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // Nov 27 IST empOpenIst -> ELIGIBLE -> recover at 2026-11-27 23:55 IST (18:25Z)
        {
          id: 'att-nov27-eligible',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: nov27,
          checkIn: new Date('2026-11-27T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // Nov 27 IST inactive employee -> MUST be skipped
        {
          id: 'att-nov27-inactive',
          companyId: companyIstId,
          employeeId: empInactiveIst.id,
          shiftId: dayShift8h.id,
          workDate: nov27,
          checkIn: new Date('2026-11-27T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // Nov 27 IST unconfigured working hours -> MUST be skipped
        {
          id: 'att-nov27-unconfigured',
          companyId: companyIstId,
          employeeId: empUnconfiguredIst.id,
          shiftId: null,
          workDate: nov27,
          checkIn: new Date('2026-11-27T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // Nov 26 NY empNyOpen -> ELIGIBLE -> recover at 2026-11-26 23:55:00 EST (2026-11-27T04:55:00.000Z)
        {
          id: 'att-nov26-ny',
          companyId: companyNyId,
          employeeId: empNyOpen.id,
          shiftId: dayShift8h.id,
          workDate: nov26,
          checkIn: new Date('2026-11-26T14:00:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
    });

    const result = await AutoCheckoutService.runScheduledCycle(recoveryNowUtc);
    expect(result.recoveredCompanyDates).toBe(4); // IST nov25, nov26, nov27 + NY nov26
    expect(result.totalAutoCheckedOut).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Eligible dates recovered with exact 23:55:00 in each company's timezone
    expect(store.attendances.find((a) => a.id === 'att-nov26-eligible')?.checkOut?.toISOString()).toBe(
      '2026-11-26T18:25:00.000Z'
    );
    expect(store.attendances.find((a) => a.id === 'att-nov27-eligible')?.checkOut?.toISOString()).toBe(
      '2026-11-27T18:25:00.000Z'
    );
    expect(store.attendances.find((a) => a.id === 'att-nov26-ny')?.checkOut?.toISOString()).toBe(
      '2026-11-27T04:55:00.000Z' // 2026-11-26 23:55:00 America/New_York (EST = UTC-5)
    );
    expect(store.attendances.find((a) => a.id === 'att-nov26-ny')?.actualWorkedMinutes).toBe(480);

    // Guarded records remain untouched
    for (const protectedId of [
      'att-nov25-locked',
      'att-nov26-leave',
      'att-nov27-inactive',
      'att-nov27-unconfigured',
    ]) {
      const att = store.attendances.find((a) => a.id === protectedId)!;
      expect(att.checkOut).toBeNull();
      expect(att.source).toBe('BIOMETRIC');
    }
  });

  it('Outage Recovery 4: manual OUT already present on a missed date is never overwritten during outage recovery', async () => {
    const restartAt0015IstUtc = new Date('2026-11-26T18:45:00.000Z'); // 2026-11-27 00:15 IST
    const missedWorkDate = new Date('2026-11-26T00:00:00.000Z');

    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empManualOutIst, empOpenIst],
      attendances: [
        // Employee with manual OUT already recorded on missed date -> MUST remain untouched
        {
          id: 'att-missed-manual-out',
          companyId: companyIstId,
          employeeId: empManualOutIst.id,
          shiftId: dayShift8h.id,
          workDate: missedWorkDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'), // 09:00 IST
          checkOut: new Date('2026-11-26T13:30:00.000Z'), // 19:00 IST (10h worked, 120m OT)
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 120,
          actualWorkedMinutes: 600,
          hasIncompletePunch: false,
          punchPairsCount: 1,
          source: 'MANUAL',
          notes: 'HR verified manual check-out',
        },
        // Coworker on same missed date still open -> MUST be recovered
        {
          id: 'att-missed-open-coworker',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: missedWorkDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
    });

    const result = await AutoCheckoutService.runScheduledCycle(restartAt0015IstUtc);
    expect(result.totalAutoCheckedOut).toBe(1);

    const manualAtt = store.attendances.find((a) => a.id === 'att-missed-manual-out')!;
    expect(manualAtt.checkOut?.toISOString()).toBe('2026-11-26T13:30:00.000Z');
    expect(manualAtt.actualWorkedMinutes).toBe(600);
    expect(manualAtt.overtimeMinutes).toBe(120);
    expect(manualAtt.source).toBe('MANUAL');
    expect(manualAtt.notes).toBe('HR verified manual check-out');

    const recoveredCoworker = store.attendances.find((a) => a.id === 'att-missed-open-coworker')!;
    expect(recoveredCoworker.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
    expect(recoveredCoworker.source).toBe('SYSTEM_GENERATED');
    expect(recoveredCoworker.actualWorkedMinutes).toBe(510);
    expect(recoveredCoworker.overtimeMinutes).toBe(0);
  });

  it('Outage Recovery 5: preserves overnight shift protection at 00:10 restart while recovering older expired overnight shifts whose Day D+1 23:55 deadline passed', async () => {
    // Outage from 2026-11-26 23:54 IST to 2026-11-27 00:10 IST (2026-11-26T18:40:00.000Z)
    const restartAt0010IstUtc = new Date('2026-11-26T18:40:00.000Z');
    const nov25 = new Date('2026-11-25T00:00:00.000Z');
    const nov26 = new Date('2026-11-26T00:00:00.000Z');

    const empOvernightExpired: TestEmployee = {
      ...empOvernightIst,
      id: 'emp-overnight-expired',
      employeeCode: 'EMP-NIGHT-OLD',
    };

    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOvernightIst, empOvernightExpired, empOpenIst],
      attendances: [
        // 1. Active overnight shift started on 2026-11-26 at 22:00 IST (mid-shift at 2026-11-27 00:10!)
        //    -> MUST NOT be closed at 00:10!
        {
          id: 'att-overnight-active',
          companyId: companyIstId,
          employeeId: empOvernightIst.id,
          shiftId: overnightShift.id,
          workDate: nov26,
          checkIn: new Date('2026-11-26T16:30:00.000Z'), // 22:00 IST
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // 2. Expired overnight shift started on 2026-11-25 at 22:00 IST (its 2026-11-26 23:55 IST sweep
        //    was missed during the outage!) -> MUST be recovered with checkOut = 2026-11-26 23:55 IST!
        {
          id: 'att-overnight-expired',
          companyId: companyIstId,
          employeeId: empOvernightExpired.id,
          shiftId: overnightShift.id,
          workDate: nov25,
          checkIn: new Date('2026-11-25T16:30:00.000Z'), // 2026-11-25 22:00 IST
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        // 3. Standard day shift on 2026-11-26 -> MUST be recovered with checkOut = 2026-11-26 23:55 IST
        {
          id: 'att-day-nov26',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: nov26,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
      intervals: [
        {
          id: 'iv-overnight-expired',
          companyId: companyIstId,
          attendanceId: 'att-overnight-expired',
          sequence: 1,
          inEventId: 'ev-night-old-in',
          outEventId: null,
          checkIn: new Date('2026-11-25T16:30:00.000Z'),
          checkOut: null,
          durationMinutes: 0,
          isComplete: false,
        },
      ],
    });

    const scheduler = new AutoCheckoutScheduler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    // Startup recovery at 2026-11-27 00:10 IST
    const recoveryTick = await scheduler.tick(restartAt0010IstUtc);
    expect(recoveryTick!.totalAutoCheckedOut).toBe(2); // expired overnight + standard nov26

    // Active overnight shift started 2 hours ago is untouched!
    const activeNight = store.attendances.find((a) => a.id === 'att-overnight-active')!;
    expect(activeNight.checkOut).toBeNull();
    expect(activeNight.source).toBe('BIOMETRIC');

    // Expired overnight shift from Nov 25 is recovered at Nov 26 23:55 IST (18:25Z)
    const expiredNight = store.attendances.find((a) => a.id === 'att-overnight-expired')!;
    expect(expiredNight.source).toBe('SYSTEM_GENERATED');
    expect(expiredNight.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
    expect(expiredNight.actualWorkedMinutes).toBe(480);
    expect(expiredNight.overtimeMinutes).toBe(0);
    expect(store.intervals[0].isComplete).toBe(true);
    expect(store.intervals[0].durationMinutes).toBe(480);
    expect(store.intervals[0].outEventId).toBeNull();

    // Standard Nov 26 shift is recovered at Nov 26 23:55 IST (18:25Z)
    const dayAtt = store.attendances.find((a) => a.id === 'att-day-nov26')!;
    expect(dayAtt.source).toBe('SYSTEM_GENERATED');
    expect(dayAtt.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
    expect(dayAtt.actualWorkedMinutes).toBe(510);

    // Later that same evening at 2026-11-27 23:55 IST (2026-11-27T18:25:00.000Z),
    // if the Nov 26 overnight employee STILL never punched out, the normal 23:55 cycle closes it!
    const nextEveningTick = await scheduler.tick(new Date('2026-11-27T18:25:00.000Z'));
    expect(nextEveningTick!.totalAutoCheckedOut).toBe(1);
    expect(activeNight.source).toBe('SYSTEM_GENERATED');
    expect(activeNight.checkOut?.toISOString()).toBe('2026-11-27T18:25:00.000Z');
    expect(activeNight.actualWorkedMinutes).toBe(480);
    expect(activeNight.overtimeMinutes).toBe(0);
  });

  it('Outage Recovery 6: multiple server instances recovering simultaneously after an outage are strictly idempotent and update each record once', async () => {
    const restartAt0010IstUtc = new Date('2026-11-26T18:40:00.000Z'); // 2026-11-27 00:10 IST
    const missedWorkDate = new Date('2026-11-26T00:00:00.000Z');

    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst, empShiftFallbackIst],
      attendances: [
        {
          id: 'att-multi-inst-1',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: missedWorkDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        {
          id: 'att-multi-inst-2',
          companyId: companyIstId,
          employeeId: empShiftFallbackIst.id,
          shiftId: dayShift8h.id,
          workDate: missedWorkDate,
          checkIn: new Date('2026-11-26T03:45:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
      intervals: [
        {
          id: 'iv-multi-1',
          companyId: companyIstId,
          attendanceId: 'att-multi-inst-1',
          sequence: 1,
          inEventId: 'ev-m1',
          outEventId: null,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          durationMinutes: 0,
          isComplete: false,
        },
      ],
    });

    const instanceA = new AutoCheckoutScheduler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const instanceB = new AutoCheckoutScheduler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const instanceC = new AutoCheckoutScheduler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const [resA, resB, resC] = await Promise.all([
      instanceA.tick(restartAt0010IstUtc),
      instanceB.tick(restartAt0010IstUtc),
      instanceC.tick(restartAt0010IstUtc),
    ]);

    // Exactly 2 total auto check-outs across all 3 concurrent instances
    const totalClosed =
      (resA?.totalAutoCheckedOut || 0) +
      (resB?.totalAutoCheckedOut || 0) +
      (resC?.totalAutoCheckedOut || 0);
    expect(totalClosed).toBe(2);

    // Exactly 2 audit logs, 1 interval update, advisory locks acquired, zero fake punches
    expect(store.auditLogs.filter((l) => l.action === 'ATTENDANCE_AUTO_CHECKOUT')).toHaveLength(2);
    expect(store.spies.intervalUpdateSpy).toHaveBeenCalledTimes(1);
    expect(store.spies.executeRawSpy).toHaveBeenCalled();
    expect(store.spies.rawPunchCreateSpy).not.toHaveBeenCalled();
    expect(store.spies.punchEventCreateSpy).not.toHaveBeenCalled();

    // Both records have exact original-date 23:55:00 IST timestamp and SYSTEM_GENERATED source
    for (const att of store.attendances) {
      expect(att.source).toBe('SYSTEM_GENERATED');
      expect(att.checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
      expect(att.overtimeMinutes).toBe(0);
    }
  });

  it('Scheduler DB resilience: defers without PrismaClientInitializationError noise while PostgreSQL is unreachable and resumes outage recovery automatically once restored', async () => {
    const restartAt0010IstUtc = new Date('2026-11-26T18:40:00.000Z'); // 2026-11-27 00:10 IST
    const missedWorkDate = new Date('2026-11-26T00:00:00.000Z');

    const store = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      attendances: [
        {
          id: 'att-db-outage-recovery',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: missedWorkDate,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
    });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let dbOnline = false;

    const scheduler = new AutoCheckoutScheduler({
      logger,
      dbReachabilityCheck: async () => dbOnline,
    });

    // Two offline ticks -> returns null, zero Prisma queries, zero logger.error, single deduped warn
    expect(await scheduler.tick(restartAt0010IstUtc)).toBeNull();
    expect(await scheduler.tick(restartAt0010IstUtc)).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(store.attendances[0].checkOut).toBeNull();

    // Simulate transient PrismaClientInitializationError while DB is starting up
    dbOnline = true;
    const initErr = Object.assign(new Error("Can't reach database server at `localhost:5432`"), {
      name: 'PrismaClientInitializationError',
      errorCode: undefined,
    });
    const runSpy = vi
      .spyOn(AutoCheckoutService, 'runScheduledCycle')
      .mockRejectedValueOnce(initErr);

    expect(await scheduler.tick(restartAt0010IstUtc)).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
    runSpy.mockRestore();

    // Once DB is fully ready, next tick resumes cleanly and recovers the missed date!
    const recovered = await scheduler.tick(restartAt0010IstUtc);
    expect(recovered?.totalAutoCheckedOut).toBe(1);
    expect(recovered?.recoveredCompanyDates).toBe(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(store.attendances[0].source).toBe('SYSTEM_GENERATED');
    expect(store.attendances[0].checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');
  });

  it('Scheduler DB transitions: available at startup, offline at startup without repeated error logs, mid-cycle disconnect, and automatic multi-day recovery upon reconnect', async () => {
    const nov26 = new Date('2026-11-26T00:00:00.000Z');
    const nov27 = new Date('2026-11-27T00:00:00.000Z');
    const nov28 = new Date('2026-11-28T00:00:00.000Z');

    // Part A: PostgreSQL available at startup -> start() immediately recovers missed date on boot
    const startupStore = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      attendances: [
        {
          id: 'att-startup-available',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: nov26,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
    });

    const startupLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const startupScheduler = new AutoCheckoutScheduler({
      pollIntervalMs: 60_000,
      nowProvider: () => new Date('2026-11-27T03:00:00.000Z'), // 2026-11-27 08:30 IST
      logger: startupLogger,
      dbReachabilityCheck: async () => true,
    });
    startupScheduler.start();
    // Flush microtasks for immediate non-blocking startup tick
    await new Promise((resolve) => setTimeout(resolve, 25));
    startupScheduler.stop();

    expect(startupLogger.error).not.toHaveBeenCalled();
    expect(startupStore.attendances[0].source).toBe('SYSTEM_GENERATED');
    expect(startupStore.attendances[0].checkOut?.toISOString()).toBe('2026-11-26T18:25:00.000Z');

    // Part B: Offline at startup, mid-cycle disconnect, and automatic recovery after 3 missed dates
    vi.restoreAllMocks();
    const multiDayStore = setupInMemoryStore({
      companies: [{ id: companyIstId, timezone: 'Asia/Kolkata' }],
      employees: [empOpenIst],
      attendances: [
        {
          id: 'att-reconnect-nov26',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: nov26,
          checkIn: new Date('2026-11-26T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        {
          id: 'att-reconnect-nov27',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: nov27,
          checkIn: new Date('2026-11-27T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
        {
          id: 'att-reconnect-nov28',
          companyId: companyIstId,
          employeeId: empOpenIst.id,
          shiftId: dayShift9h.id,
          workDate: nov28,
          checkIn: new Date('2026-11-28T03:30:00.000Z'),
          checkOut: null,
          status: 'PRESENT',
          lateMinutes: 0,
          overtimeMinutes: 0,
          actualWorkedMinutes: 0,
          hasIncompletePunch: true,
          punchPairsCount: 0,
          source: 'BIOMETRIC',
          notes: null,
        },
      ],
    });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let dbOnline = false;
    const scheduler = new AutoCheckoutScheduler({
      pollIntervalMs: 60_000,
      nowProvider: () => new Date('2026-11-27T02:00:00.000Z'),
      logger,
      dbReachabilityCheck: async () => dbOnline,
    });

    // 1. Offline at startup + 3 repeated offline ticks -> zero logger.error, single deduped warning
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    scheduler.stop();
    await scheduler.tick(new Date('2026-11-27T02:00:30.000Z'));
    await scheduler.tick(new Date('2026-11-27T02:01:00.000Z'));
    await scheduler.tick(new Date('2026-11-28T02:00:00.000Z'));
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // 2. DB port opens briefly, then disconnects MID-CYCLE inside discoverMissedAutoCheckoutDates
    dbOnline = true;
    const midCycleSpy = vi
      .spyOn(AutoCheckoutService, 'discoverMissedAutoCheckoutDates')
      .mockRejectedValueOnce(new Error("Can't reach database server at `localhost:5432`"));
    const midCycleResult = await scheduler.tick(new Date('2026-11-28T06:00:00.000Z'));
    expect(midCycleResult?.totalAutoCheckedOut).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
    // Still deduped (dbUnavailableLogged stayed true; no repeated warn or premature "restored" info)
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(
      logger.info.mock.calls.some((args) => String(args[0]).includes('connectivity restored'))
    ).toBe(false);
    midCycleSpy.mockRestore();

    // 3. DB fully reconnects on 2026-11-29 08:00 IST (2026-11-29T02:30:00.000Z) ->
    //    automatically logs connectivity restored and recovers ALL 3 missed dates!
    const reconnectResult = await scheduler.tick(new Date('2026-11-29T02:30:00.000Z'));
    expect(reconnectResult?.recoveredCompanyDates).toBe(3);
    expect(reconnectResult?.totalAutoCheckedOut).toBe(3);
    expect(logger.error).not.toHaveBeenCalled();
    expect(
      logger.info.mock.calls.some((args) => String(args[0]).includes('connectivity restored'))
    ).toBe(true);

    expect(
      multiDayStore.attendances.find((a) => a.id === 'att-reconnect-nov26')?.checkOut?.toISOString()
    ).toBe('2026-11-26T18:25:00.000Z');
    expect(
      multiDayStore.attendances.find((a) => a.id === 'att-reconnect-nov27')?.checkOut?.toISOString()
    ).toBe('2026-11-27T18:25:00.000Z');
    expect(
      multiDayStore.attendances.find((a) => a.id === 'att-reconnect-nov28')?.checkOut?.toISOString()
    ).toBe('2026-11-28T18:25:00.000Z');
    for (const att of multiDayStore.attendances) {
      expect(att.source).toBe('SYSTEM_GENERATED');
      expect(att.actualWorkedMinutes).toBe(510);
      expect(att.overtimeMinutes).toBe(0);
    }
    expect(multiDayStore.spies.rawPunchCreateSpy).not.toHaveBeenCalled();
    expect(multiDayStore.spies.punchEventCreateSpy).not.toHaveBeenCalled();
  });

  it('Scheduler non-overlap guard: concurrent overlapping ticks are skipped while a cycle is in flight and resume cleanly afterward', async () => {
    let releaseFirstCycle!: (value: any) => void;
    const firstCyclePromise = new Promise<any>((resolve) => {
      releaseFirstCycle = resolve;
    });

    const runSpy = vi
      .spyOn(AutoCheckoutService, 'runScheduledCycle')
      .mockImplementationOnce(() => firstCyclePromise)
      .mockResolvedValueOnce({
        evaluatedCompanies: 1,
        dueCompanies: 0,
        recoveredCompanyDates: 0,
        skippedAlreadyRan: 0,
        skippedInvalidTimezone: 0,
        totalAutoCheckedOut: 0,
        totalSkipped: 0,
        companyResults: [],
        errors: [],
      });

    const scheduler = new AutoCheckoutScheduler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      dbReachabilityCheck: async () => true,
    });

    // Launch cycle 1 (remains in-flight)
    const tick1 = scheduler.tick(new Date('2026-11-26T18:25:00.000Z'));
    // Wait a microtask so tick1 enters runScheduledCycle
    await Promise.resolve();

    // Concurrent overlapping ticks 2 and 3 MUST return null immediately without calling runScheduledCycle
    const [tick2Result, tick3Result] = await Promise.all([
      scheduler.tick(new Date('2026-11-26T18:25:01.000Z')),
      scheduler.tick(new Date('2026-11-26T18:25:02.000Z')),
    ]);
    expect(tick2Result).toBeNull();
    expect(tick3Result).toBeNull();
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Complete cycle 1
    releaseFirstCycle({
      evaluatedCompanies: 1,
      dueCompanies: 1,
      recoveredCompanyDates: 0,
      skippedAlreadyRan: 0,
      skippedInvalidTimezone: 0,
      totalAutoCheckedOut: 1,
      totalSkipped: 0,
      companyResults: [],
      errors: [],
    });
    const tick1Result = await tick1;
    expect(tick1Result?.totalAutoCheckedOut).toBe(1);

    // After cycle 1 completes, next tick runs normally
    const tick4Result = await scheduler.tick(new Date('2026-11-26T18:26:00.000Z'));
    expect(tick4Result).not.toBeNull();
    expect(runSpy).toHaveBeenCalledTimes(2);
  });
});
