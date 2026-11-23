import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../src/server/db/client.js';
import {
  PunchReconciliationService,
  pairAttendanceEventsChronologically,
  deriveAttendanceAdvisoryLockKeys,
} from '../../src/server/services/punch-reconciliation.service.js';
import { AttendanceService } from '../../src/server/services/attendance.service.js';
import { PunchInOutMode, PunchSyncStatus } from '../../src/shared/types.js';

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Biometric Chronological IN/OUT Alternation & Reconciliation Regression Suite', () => {
  const companyId = '11111111-1111-4111-8111-111111111111';
  const terminalId = '22222222-2222-4222-8222-222222222222';
  const employeeDayId = '33333333-3333-4333-8333-333333333331';
  const employeeNightId = '33333333-3333-4333-8333-333333333332';

  const dayShift = {
    id: '44444444-4444-4444-8444-444444444441',
    companyId,
    code: 'DAY8',
    name: 'Day 8h Shift',
    startTime: '09:00',
    endTime: '17:00',
    isOvernight: false,
    graceMinutes: 15,
    halfDayMinutes: 240,
    isActive: true,
  };

  const nightShift = {
    id: '44444444-4444-4444-8444-444444444442',
    companyId,
    code: 'NIGHT8',
    name: 'Overnight Shift',
    startTime: '22:00',
    endTime: '06:00',
    isOvernight: true,
    graceMinutes: 15,
    halfDayMinutes: 240,
    isActive: true,
  };

  const dayEmployee = {
    id: employeeDayId,
    companyId,
    employeeCode: 'EMP-DAY-1',
    fullName: 'Aarav Day',
    biometricDeviceId: '101',
    status: 'ACTIVE',
    shiftId: dayShift.id,
    shift: dayShift,
    dailyWorkingHours: 8,
    monthlyLeaveAllowance: 4,
  };

  const nightEmployee = {
    id: employeeNightId,
    companyId,
    employeeCode: 'EMP-NIGHT-1',
    fullName: 'Meera Night',
    biometricDeviceId: '102',
    status: 'ACTIVE',
    shiftId: nightShift.id,
    shift: nightShift,
    dailyWorkingHours: 8,
    monthlyLeaveAllowance: 4,
  };

  type RawPunchRow = {
    id: string;
    companyId: string;
    terminalId: string;
    userEnrollmentId: string;
    punchTime: Date;
    inOutMode: PunchInOutMode;
    rawPayload?: Record<string, unknown>;
    syncStatus: PunchSyncStatus;
    errorMessage: string | null;
    matchedEmployeeId: string | null;
  };

  type AttRow = {
    id: string;
    companyId: string;
    employeeId: string;
    shiftId: string | null;
    workDate: Date;
    checkIn: Date | null;
    checkOut: Date | null;
    status: string;
    lateMinutes: number;
    overtimeMinutes: number;
    actualWorkedMinutes: number | null;
    hasIncompletePunch: boolean;
    punchPairsCount: number;
    source: string;
    notes: string | null;
  };

  type EventRow = {
    id: string;
    companyId: string;
    attendanceId: string;
    rawPunchLogId: string | null;
    punchTime: Date;
    inOutMode: PunchInOutMode;
    source: string;
    createdAt: Date;
  };

  type IntervalRow = {
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
  };

  let rawPunches: RawPunchRow[];
  let attendances: AttRow[];
  let events: EventRow[];
  let intervals: IntervalRow[];
  let payrollPeriods: any[];
  let companyTimezone: string;
  let advisoryLockCalls: Array<[number, number]>;
  let eventSeq: number;

  function findEmployeeById(id: string | null) {
    if (id === employeeDayId) return dayEmployee;
    if (id === employeeNightId) return nightEmployee;
    return null;
  }

  function setupMockStore(tz = 'UTC') {
    rawPunches = [];
    attendances = [];
    events = [];
    intervals = [];
    payrollPeriods = [];
    companyTimezone = tz;
    advisoryLockCalls = [];
    eventSeq = 0;

    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(prisma));
    vi.spyOn(prisma, '$queryRaw').mockImplementation((async () => [{ id: 'locked' }]) as any);
    vi.spyOn(prisma, '$executeRaw').mockImplementation((async (_strings: any, k1: number, k2: number) => {
      if (typeof k1 === 'number' && typeof k2 === 'number') {
        advisoryLockCalls.push([k1, k2]);
      }
      return 1;
    }) as any);

    vi.spyOn(prisma.company, 'findUnique').mockImplementation((async () => ({
      timezone: companyTimezone,
    })) as any);
    vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.leaveRequest, 'findFirst').mockResolvedValue(null);

    vi.spyOn(prisma.payrollPeriod, 'findFirst').mockImplementation((async (args: any) => {
      const w = args?.where || {};
      return (
        payrollPeriods.find((p) => {
          if (w.companyId && p.companyId !== w.companyId) return false;
          if (w.status?.in && !w.status.in.includes(p.status)) return false;
          if (w.startDate?.lte && p.startDate > w.startDate.lte) return false;
          if (w.endDate?.gte && p.endDate < w.endDate.gte) return false;
          return true;
        }) || null
      ) as any;
    }) as any);

    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue([]);

    vi.spyOn(prisma.employee, 'findFirst').mockImplementation((async (args: any) => {
      const w = args?.where || {};
      if (w.companyId !== companyId) return null;
      if (w.biometricDeviceId === '101' || w.id === employeeDayId) return dayEmployee as any;
      if (w.biometricDeviceId === '102' || w.id === employeeNightId) return nightEmployee as any;
      return null;
    }) as any);

    vi.spyOn(prisma.rawPunchLog, 'findMany').mockImplementation((async (args: any) => {
      const w = args?.where || {};
      const filtered = rawPunches
        .filter((p) => {
          if (w.companyId && p.companyId !== w.companyId) return false;
          if (w.syncStatus) {
            if (typeof w.syncStatus === 'string' && p.syncStatus !== w.syncStatus) return false;
            if (w.syncStatus.in && !w.syncStatus.in.includes(p.syncStatus)) return false;
          }
          if (w.punchTime?.gte && p.punchTime < w.punchTime.gte) return false;
          if (w.id && p.id !== w.id) return false;
          return true;
        })
        .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
      return filtered.map((p) => ({ id: p.id })) as any;
    }) as any);

    vi.spyOn(prisma.rawPunchLog, 'findUnique').mockImplementation((async (args: any) => {
      const p = rawPunches.find((item) => item.id === args?.where?.id);
      if (!p) return null;
      return {
        ...p,
        company: { id: p.companyId, timezone: companyTimezone },
        terminal: { id: terminalId, name: 'eSSL X2008 Main', location: 'Lobby' },
        matchedEmployee: findEmployeeById(p.matchedEmployeeId),
      } as any;
    }) as any);

    vi.spyOn(prisma.rawPunchLog, 'update').mockImplementation((async (args: any) => {
      const p = rawPunches.find((item) => item.id === args?.where?.id);
      if (!p) throw new Error('Punch not found');
      Object.assign(p, args.data);
      return p as any;
    }) as any);

    vi.spyOn(prisma.attendance, 'findUnique').mockImplementation((async (args: any) => {
      const key = args?.where?.companyId_employeeId_workDate;
      if (!key) return null;
      return (
        attendances.find(
          (a) =>
            a.companyId === key.companyId &&
            a.employeeId === key.employeeId &&
            a.workDate.toISOString() === new Date(key.workDate).toISOString()
        ) || null
      ) as any;
    }) as any);

    vi.spyOn(prisma.attendance, 'create').mockImplementation((async (args: any) => {
      const existing = attendances.find(
        (a) =>
          a.companyId === args.data.companyId &&
          a.employeeId === args.data.employeeId &&
          a.workDate.toISOString() === new Date(args.data.workDate).toISOString()
      );
      if (existing) {
        const err = new Error('Unique constraint failed on Attendance');
        (err as any).code = 'P2002';
        throw err;
      }
      const row: AttRow = {
        id: `att-${attendances.length + 1}`,
        companyId: args.data.companyId,
        employeeId: args.data.employeeId,
        shiftId: args.data.shiftId ?? null,
        workDate: new Date(args.data.workDate),
        checkIn: args.data.checkIn ?? null,
        checkOut: args.data.checkOut ?? null,
        status: args.data.status,
        lateMinutes: args.data.lateMinutes ?? 0,
        overtimeMinutes: args.data.overtimeMinutes ?? 0,
        actualWorkedMinutes: args.data.actualWorkedMinutes ?? null,
        hasIncompletePunch: Boolean(args.data.hasIncompletePunch),
        punchPairsCount: args.data.punchPairsCount ?? 0,
        source: args.data.source,
        notes: args.data.notes ?? null,
      };
      attendances.push(row);
      return row as any;
    }) as any);

    vi.spyOn(prisma.attendance, 'update').mockImplementation((async (args: any) => {
      const row = attendances.find((a) => a.id === args.where.id);
      if (!row) throw new Error('Attendance not found');
      Object.assign(row, args.data);
      return row as any;
    }) as any);

    vi.spyOn((prisma as any).attendancePunchEvent, 'findMany').mockImplementation((async (args: any) => {
      const w = args?.where || {};
      return events
        .filter((e) => e.attendanceId === w.attendanceId && e.companyId === w.companyId)
        .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime()) as any;
    }) as any);

    vi.spyOn((prisma as any).attendancePunchEvent, 'create').mockImplementation((async (args: any) => {
      eventSeq += 1;
      const row: EventRow = {
        id: `ev-${eventSeq}`,
        companyId: args.data.companyId,
        attendanceId: args.data.attendanceId,
        rawPunchLogId: args.data.rawPunchLogId ?? null,
        punchTime: new Date(args.data.punchTime),
        inOutMode: args.data.inOutMode,
        source: args.data.source,
        createdAt: new Date(Date.now() + eventSeq),
      };
      events.push(row);
      return row as any;
    }) as any);

    vi.spyOn((prisma as any).attendancePunchEvent, 'update').mockImplementation((async (args: any) => {
      const row = events.find((e) => e.id === args.where.id);
      if (!row) throw new Error('Punch event not found');
      Object.assign(row, args.data);
      return row as any;
    }) as any);

    vi.spyOn((prisma as any).attendanceInterval, 'deleteMany').mockImplementation((async (args: any) => {
      const w = args?.where || {};
      const before = intervals.length;
      intervals = intervals.filter(
        (iv) => !(iv.attendanceId === w.attendanceId && iv.companyId === w.companyId)
      );
      return { count: before - intervals.length } as any;
    }) as any);

    vi.spyOn((prisma as any).attendanceInterval, 'create').mockImplementation((async (args: any) => {
      const duplicateSeq = intervals.find(
        (iv) =>
          iv.attendanceId === args.data.attendanceId && iv.sequence === args.data.sequence
      );
      if (duplicateSeq) {
        const err = new Error('Unique constraint failed on AttendanceInterval(attendanceId, sequence)');
        (err as any).code = 'P2002';
        throw err;
      }
      const row: IntervalRow = {
        id: `iv-${intervals.length + 1}`,
        companyId: args.data.companyId,
        attendanceId: args.data.attendanceId,
        sequence: args.data.sequence,
        inEventId: args.data.inEventId ?? null,
        outEventId: args.data.outEventId ?? null,
        checkIn: args.data.checkIn ? new Date(args.data.checkIn) : null,
        checkOut: args.data.checkOut ? new Date(args.data.checkOut) : null,
        durationMinutes: args.data.durationMinutes,
        isComplete: args.data.isComplete,
      };
      intervals.push(row);
      return row as any;
    }) as any);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    setupMockStore('UTC');
  });

  describe('1. Repeated eSSL CHECK_IN alternation (IN -> OUT -> IN -> OUT)', () => {
    it('alternates 4 consecutive raw CHECK_IN punches into 2 complete IN->OUT intervals while preserving RawPunchLog audit data', async () => {
      const rawPayload0 = { deviceSerial: 'NFZ8252800275', inOutCode: 0, verifyCode: 1 };
      rawPunches.push(
        {
          id: 'p-essl-1',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-20T09:00:00.000Z'),
          inOutMode: 'CHECK_IN',
          rawPayload: { ...rawPayload0, seq: 1 },
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-essl-2',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-20T13:00:00.000Z'), // 2nd tap (device still reports CHECK_IN)
          inOutMode: 'CHECK_IN',
          rawPayload: { ...rawPayload0, seq: 2 },
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-essl-3',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-20T14:00:00.000Z'), // 3rd tap
          inOutMode: 'CHECK_IN',
          rawPayload: { ...rawPayload0, seq: 3 },
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-essl-4',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-20T18:30:00.000Z'), // 4th tap
          inOutMode: 'CHECK_IN',
          rawPayload: { ...rawPayload0, seq: 4 },
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        }
      );

      for (const id of ['p-essl-1', 'p-essl-2', 'p-essl-3', 'p-essl-4']) {
        const res = await PunchReconciliationService.reconcilePunch(id);
        expect(res.status).toBe('PROCESSED');
      }

      expect(attendances).toHaveLength(1);
      const att = attendances[0];
      expect(att.checkIn?.toISOString()).toBe('2026-11-20T09:00:00.000Z');
      expect(att.checkOut?.toISOString()).toBe('2026-11-20T18:30:00.000Z');
      expect(att.punchPairsCount).toBe(2);
      expect(att.hasIncompletePunch).toBe(false);
      // 240m (09:00->13:00) + 270m (14:00->18:30) = 510m worked vs 480m required -> 30m overtime
      expect(att.actualWorkedMinutes).toBe(510);
      expect(att.overtimeMinutes).toBe(30);
      expect(att.status).toBe('PRESENT');

      // Reconciled AttendancePunchEvent records alternate deterministically IN -> OUT -> IN -> OUT
      const sortedEvents = events
        .slice()
        .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
      expect(sortedEvents.map((e) => e.inOutMode)).toEqual([
        'CHECK_IN',
        'CHECK_OUT',
        'CHECK_IN',
        'CHECK_OUT',
      ]);

      // Intervals match exact pairs
      expect(intervals).toHaveLength(2);
      expect(intervals[0]).toMatchObject({
        sequence: 1,
        durationMinutes: 240,
        isComplete: true,
      });
      expect(intervals[1]).toMatchObject({
        sequence: 2,
        durationMinutes: 270,
        isComplete: true,
      });

      // Raw device audit data is NEVER mutated
      for (const raw of rawPunches) {
        expect(raw.inOutMode).toBe('CHECK_IN');
        expect(raw.rawPayload?.inOutCode).toBe(0);
        expect(raw.syncStatus).toBe('PROCESSED');
      }
    });

    it('handles odd punch counts (1 and 3 raw CHECK_IN punches) with trailing open CHECK_IN', () => {
      const one = pairAttendanceEventsChronologically([
        { id: 'e1', punchTime: new Date('2026-11-20T09:00:00Z'), inOutMode: 'CHECK_IN' },
      ]);
      expect(one.punchPairsCount).toBe(0);
      expect(one.hasIncompletePunch).toBe(true);
      expect(one.actualWorkedMinutes).toBe(0);
      expect(one.earliestCheckIn?.toISOString()).toBe('2026-11-20T09:00:00.000Z');
      expect(one.latestCheckOut).toBeNull();
      expect(one.normalizedEvents.map((e) => e.effectiveMode)).toEqual(['CHECK_IN']);

      const three = pairAttendanceEventsChronologically([
        { id: 'e1', punchTime: new Date('2026-11-20T09:00:00Z'), inOutMode: 'CHECK_IN' },
        { id: 'e2', punchTime: new Date('2026-11-20T13:00:00Z'), inOutMode: 'CHECK_IN' },
        { id: 'e3', punchTime: new Date('2026-11-20T14:00:00Z'), inOutMode: 'CHECK_IN' },
      ]);
      expect(three.punchPairsCount).toBe(1);
      expect(three.hasIncompletePunch).toBe(true);
      expect(three.actualWorkedMinutes).toBe(240);
      expect(three.earliestCheckIn?.toISOString()).toBe('2026-11-20T09:00:00.000Z');
      expect(three.latestCheckOut?.toISOString()).toBe('2026-11-20T13:00:00.000Z');
      expect(three.normalizedEvents.map((e) => e.effectiveMode)).toEqual([
        'CHECK_IN',
        'CHECK_OUT',
        'CHECK_IN',
      ]);
    });
  });

  describe('2. Duplicate punch idempotency & mode-agnostic 2-minute debounce', () => {
    it('debounces rapid double-taps within 2 minutes regardless of raw device inOutMode and keeps re-runs idempotent', async () => {
      rawPunches.push(
        {
          id: 'p-in-1',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-21T09:00:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-in-doubletap',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-21T09:00:50.000Z'), // 50s later, even with CHECK_OUT raw mode
          inOutMode: 'CHECK_OUT',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-out-1',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-21T17:30:00.000Z'),
          inOutMode: 'CHECK_IN', // raw CHECK_IN -> becomes 2nd punch (CHECK_OUT)
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-out-doubletap',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-21T17:31:15.000Z'), // 75s after effective CHECK_OUT
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        }
      );

      const r1 = await PunchReconciliationService.reconcilePunch('p-in-1');
      expect(r1.status).toBe('PROCESSED');

      // Rapid double-tap on arrival must be debounced, NOT paired as a 1-minute OUT
      const r2 = await PunchReconciliationService.reconcilePunch('p-in-doubletap');
      expect(r2.status).toBe('IGNORED');
      expect(r2.message).toContain('debounced within 2 minutes');
      expect(events).toHaveLength(1);
      expect(attendances[0].hasIncompletePunch).toBe(true);

      // Evening tap becomes CHECK_OUT
      const r3 = await PunchReconciliationService.reconcilePunch('p-out-1');
      expect(r3.status).toBe('PROCESSED');
      expect(attendances[0].hasIncompletePunch).toBe(false);
      expect(attendances[0].actualWorkedMinutes).toBe(510);

      // Rapid double-tap on departure must be debounced, NOT open a bogus 3rd CHECK_IN
      const r4 = await PunchReconciliationService.reconcilePunch('p-out-doubletap');
      expect(r4.status).toBe('IGNORED');
      expect(r4.message).toContain('Duplicate check-out punch debounced within 2 minutes');
      expect(events).toHaveLength(2);
      expect(attendances[0].hasIncompletePunch).toBe(false);
      expect(attendances[0].punchPairsCount).toBe(1);

      // Re-reconciling an already PROCESSED punch is a strict idempotent no-op
      const r1Replay = await PunchReconciliationService.reconcilePunch('p-in-1');
      expect(r1Replay.status).toBe('PROCESSED');
      expect(r1Replay.message).toContain('already successfully processed');
      expect(events).toHaveLength(2);
    });
  });

  describe('3. Out-of-order punch arrival & deterministic re-sequencing', () => {
    it('flips previously recorded AttendancePunchEvent.inOutMode when earlier punches arrive out of order while keeping RawPunchLog untouched', async () => {
      // Shuffled arrival order: 14:00, 18:30, 09:00, 12:30 (all raw CHECK_IN from eSSL)
      rawPunches.push(
        {
          id: 'p-oof-3',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-22T14:00:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-oof-4',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-22T18:30:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-oof-1',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-22T09:00:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-oof-2',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-22T12:30:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        }
      );

      for (const id of ['p-oof-3', 'p-oof-4', 'p-oof-1', 'p-oof-2']) {
        const res = await PunchReconciliationService.reconcilePunch(id);
        expect(res.status).toBe('PROCESSED');
      }

      expect(attendances).toHaveLength(1);
      const att = attendances[0];
      expect(att.checkIn?.toISOString()).toBe('2026-11-22T09:00:00.000Z');
      expect(att.checkOut?.toISOString()).toBe('2026-11-22T18:30:00.000Z');
      expect(att.punchPairsCount).toBe(2);
      expect(att.hasIncompletePunch).toBe(false);
      // 09:00->12:30 (210m) + 14:00->18:30 (270m) = 480m
      expect(att.actualWorkedMinutes).toBe(480);

      const sortedEvents = events
        .slice()
        .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
      expect(
        sortedEvents.map((e) => ({
          rawId: e.rawPunchLogId,
          mode: e.inOutMode,
        }))
      ).toEqual([
        { rawId: 'p-oof-1', mode: 'CHECK_IN' },
        { rawId: 'p-oof-2', mode: 'CHECK_OUT' },
        { rawId: 'p-oof-3', mode: 'CHECK_IN' },
        { rawId: 'p-oof-4', mode: 'CHECK_OUT' },
      ]);

      // All RawPunchLog records still preserve original raw device mode
      expect(rawPunches.every((p) => p.inOutMode === 'CHECK_IN')).toBe(true);
    });
  });

  describe('4. Concurrency safety with deterministic advisory lock serialization', () => {
    it('serializes two concurrent distinct raw CHECK_IN punches on the same workday without duplicate sequence or attendance collisions', async () => {
      const p1Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
      const p2Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
      rawPunches.push(
        {
          id: p1Id,
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-23T09:00:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: p2Id,
          companyId,
          terminalId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-11-23T17:30:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        }
      );

      // Barrier ensures both transactions enter simultaneously before pg_advisory_xact_lock
      let entered = 0;
      let releaseBarrier!: () => void;
      const bothEntered = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      // Simulate PostgreSQL per-(lockKey1, lockKey2) transaction-scoped advisory lock
      const lockQueues = new Map<string, Promise<void>>();
      const acquireAdvisoryLock = async (lockKey: string): Promise<() => void> => {
        let release!: () => void;
        const next = new Promise<void>((resolve) => {
          release = resolve;
        });
        const prev = lockQueues.get(lockKey) ?? Promise.resolve();
        lockQueues.set(lockKey, prev.then(() => next));
        await prev;
        return release;
      };

      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => {
        let releaseLock: (() => void) | null = null;
        const txProxy = {
          rawPunchLog: prisma.rawPunchLog,
          company: prisma.company,
          payrollPeriod: prisma.payrollPeriod,
          attendance: prisma.attendance,
          leaveRequest: prisma.leaveRequest,
          employee: prisma.employee,
          companySetting: prisma.companySetting,
          biometricTerminal: prisma.biometricTerminal,
          employeeWorkPolicyRevision: (prisma as any).employeeWorkPolicyRevision,
          attendancePunchEvent: (prisma as any).attendancePunchEvent,
          attendanceInterval: (prisma as any).attendanceInterval,
          $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
          $executeRaw: vi.fn(async (_strings: any, k1: number, k2: number) => {
            advisoryLockCalls.push([k1, k2]);
            entered += 1;
            if (entered >= 2) releaseBarrier();
            await bothEntered;
            releaseLock = await acquireAdvisoryLock(`${k1}:${k2}`);
            return 1;
          }),
        };
        try {
          return await cb(txProxy);
        } finally {
          releaseLock?.();
        }
      }) as any);

      const [res1, res2] = await Promise.all([
        PunchReconciliationService.reconcilePunch(p1Id, undefined, { expectedCompanyId: companyId }),
        PunchReconciliationService.reconcilePunch(p2Id, undefined, { expectedCompanyId: companyId }),
      ]);

      expect(res1.status).toBe('PROCESSED');
      expect(res2.status).toBe('PROCESSED');

      const expectedLockKeys = deriveAttendanceAdvisoryLockKeys(
        companyId,
        employeeDayId,
        '2026-11-23'
      );
      expect(advisoryLockCalls).toEqual([expectedLockKeys, expectedLockKeys]);

      expect(attendances).toHaveLength(1);
      expect(attendances[0].checkIn?.toISOString()).toBe('2026-11-23T09:00:00.000Z');
      expect(attendances[0].checkOut?.toISOString()).toBe('2026-11-23T17:30:00.000Z');
      expect(attendances[0].actualWorkedMinutes).toBe(510);
      expect(attendances[0].punchPairsCount).toBe(1);
      expect(attendances[0].hasIncompletePunch).toBe(false);

      const sortedEvents = events
        .slice()
        .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
      expect(sortedEvents.map((e) => e.inOutMode)).toEqual(['CHECK_IN', 'CHECK_OUT']);
      expect(intervals).toHaveLength(1);
      expect(intervals[0].sequence).toBe(1);
      expect(intervals[0].isComplete).toBe(true);
    });
  });

  describe('5. Timezone boundaries & overnight shifts', () => {
    it('separates day-shift punches across company-local midnight in Asia/Kolkata (UTC+05:30)', async () => {
      setupMockStore('Asia/Kolkata');

      rawPunches.push(
        {
          id: 'p-ist-day1',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          // 2026-11-20 23:45 IST -> local date 2026-11-20
          punchTime: new Date('2026-11-20T18:15:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        },
        {
          id: 'p-ist-day2',
          companyId,
          terminalId,
          userEnrollmentId: '101',
          // 2026-11-21 00:15 IST -> local date 2026-11-21 (same UTC date 2026-11-20!)
          punchTime: new Date('2026-11-20T18:45:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeDayId,
        }
      );

      const r1 = await PunchReconciliationService.reconcilePunch('p-ist-day1');
      const r2 = await PunchReconciliationService.reconcilePunch('p-ist-day2');

      expect(r1.workDate).toBe('2026-11-20');
      expect(r2.workDate).toBe('2026-11-21');
      expect(attendances).toHaveLength(2);
      // Each local date starts its own alternating sequence at CHECK_IN
      expect(events.map((e) => e.inOutMode)).toEqual(['CHECK_IN', 'CHECK_IN']);
    });

    it('groups 4 overnight shift raw CHECK_IN punches across midnight in Asia/Kolkata onto shift commencement date and calculates post-midnight lateMinutes accurately', async () => {
      setupMockStore('Asia/Kolkata');

      // Overnight shift 22:00 -> 06:00 IST on 2026-11-20:
      // 22:00 IST Nov 20 = 16:30 UTC Nov 20
      // 02:00 IST Nov 21 = 20:30 UTC Nov 20 (240m)
      // 02:30 IST Nov 21 = 21:00 UTC Nov 20
      // 06:15 IST Nov 21 = 00:45 UTC Nov 21 (225m)
      rawPunches.push(
        {
          id: 'p-night-1',
          companyId,
          terminalId,
          userEnrollmentId: '102',
          punchTime: new Date('2026-11-20T16:30:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeNightId,
        },
        {
          id: 'p-night-2',
          companyId,
          terminalId,
          userEnrollmentId: '102',
          punchTime: new Date('2026-11-20T20:30:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeNightId,
        },
        {
          id: 'p-night-3',
          companyId,
          terminalId,
          userEnrollmentId: '102',
          punchTime: new Date('2026-11-20T21:00:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeNightId,
        },
        {
          id: 'p-night-4',
          companyId,
          terminalId,
          userEnrollmentId: '102',
          punchTime: new Date('2026-11-21T00:45:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeNightId,
        }
      );

      for (const id of ['p-night-1', 'p-night-2', 'p-night-3', 'p-night-4']) {
        const res = await PunchReconciliationService.reconcilePunch(id);
        expect(res.status).toBe('PROCESSED');
        expect(res.workDate).toBe('2026-11-20');
      }

      expect(attendances).toHaveLength(1);
      const att = attendances[0];
      expect(att.workDate.toISOString()).toBe('2026-11-20T00:00:00.000Z');
      expect(att.punchPairsCount).toBe(2);
      expect(att.hasIncompletePunch).toBe(false);
      expect(att.actualWorkedMinutes).toBe(465); // 240 + 225
      expect(att.lateMinutes).toBe(0);
      expect(
        events
          .slice()
          .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime())
          .map((e) => e.inOutMode)
      ).toEqual(['CHECK_IN', 'CHECK_OUT', 'CHECK_IN', 'CHECK_OUT']);

      // Verify post-midnight arrival lateMinutes on overnight shift (00:15 IST next day vs 22:00 IST start = 135m late)
      const lateMinAfterMidnight = PunchReconciliationService.calculateLateMinutes(
        new Date('2026-11-20T18:45:00.000Z'), // 2026-11-21 00:15 IST
        '2026-11-20',
        { startTime: '22:00', graceMinutes: 15 },
        'Asia/Kolkata'
      );
      expect(lateMinAfterMidnight).toBe(135);

      // Verify DST spring-forward overnight workDate subtraction in America/New_York (2026-03-08 03:30 EDT -> 2026-03-07)
      const dstOvernightWorkDate = PunchReconciliationService.determineWorkDate(
        new Date('2026-03-08T07:30:00.000Z'), // 03:30 EDT on spring-forward day (23-hour day)
        'America/New_York',
        nightShift
      );
      expect(dstOvernightWorkDate).toBe('2026-03-07');
    });
  });

  describe('6. Historical & payroll protection + manual attendance compatibility', () => {
    it('does not auto-reconcile historical pending punches and blocks locked payroll dates (PROCESSED/ACCOUNTS_APPROVED/POSTED)', async () => {
      payrollPeriods.push({
        id: 'pp-locked-1',
        companyId,
        name: 'November 2026',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        endDate: new Date('2026-11-30T23:59:59.000Z'),
        status: 'POSTED',
      });

      rawPunches.push({
        id: 'p-locked-day',
        companyId,
        terminalId,
        userEnrollmentId: '101',
        punchTime: new Date('2026-11-15T09:00:00.000Z'),
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        errorMessage: null,
        matchedEmployeeId: employeeDayId,
      });

      const lockedRes = await PunchReconciliationService.reconcilePunch('p-locked-day');
      expect(lockedRes.status).toBe('ERROR');
      expect(lockedRes.message).toContain('Protected payroll period');
      expect(attendances).toHaveLength(0);
    });

    it('preserves manual attendance creation compatibility via AttendanceService', async () => {
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(dayEmployee as any);
      vi.spyOn(prisma.shift, 'findUnique').mockResolvedValue(dayShift as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValue(null);
      const createSpy = vi.spyOn(prisma.attendance, 'create').mockResolvedValueOnce({
        id: 'att-manual-1',
        companyId,
        employeeId: employeeDayId,
        shiftId: dayShift.id,
        workDate: new Date('2026-11-24T00:00:00.000Z'),
        checkIn: new Date('2026-11-24T09:00:00.000Z'),
        checkOut: new Date('2026-11-24T17:00:00.000Z'),
        status: 'PRESENT',
        lateMinutes: 0,
        overtimeMinutes: 0,
        actualWorkedMinutes: 480,
        hasIncompletePunch: false,
        punchPairsCount: 1,
        source: 'MANUAL',
        notes: 'Manual HR entry',
        createdAt: new Date('2026-11-24T17:05:00.000Z'),
        updatedAt: new Date('2026-11-24T17:05:00.000Z'),
        employee: dayEmployee,
        shift: dayShift,
        intervals: [],
        punchEvents: [],
      } as any);

      const actor = {
        id: 'admin-user-1',
        userId: 'admin-user-1',
        companyId,
        email: 'admin@coreerp.local',
        fullName: 'HR Admin',
        role: 'SUPER_ADMIN' as const,
        isActive: true,
        tokenVersion: 1,
      };

      const created = await AttendanceService.createAttendance(actor, {
        employeeId: employeeDayId,
        workDate: '2026-11-24',
        checkIn: '2026-11-24T09:00:00.000Z',
        checkOut: '2026-11-24T17:00:00.000Z',
        status: 'PRESENT',
        notes: 'Manual HR entry',
      });

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(created.source).toBe('MANUAL');
      expect(created.status).toBe('PRESENT');
    });
  });
});
