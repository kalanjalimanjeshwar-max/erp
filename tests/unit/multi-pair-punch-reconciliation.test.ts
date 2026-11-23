import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../src/server/db/client.js';
import {
  PunchReconciliationService,
  pairAttendanceEventsChronologically,
} from '../../src/server/services/punch-reconciliation.service.js';
import { PunchInOutMode, PunchSyncStatus } from '../../src/shared/types.js';

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Step 2 Stage 3: Multi-Pair Chronological Punch Reconciliation Tests', () => {
  const companyId = 'comp-multi-pair-1';
  const terminalId = 'term-multi-pair-1';
  const employeeId = 'emp-multi-pair-1';

  const shift8h = {
    id: 'shift-8h',
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

  const activeEmployee = {
    id: employeeId,
    companyId,
    employeeCode: 'EMP-200',
    fullName: 'Sara Multi',
    biometricDeviceId: '200',
    status: 'ACTIVE',
    shiftId: shift8h.id,
    shift: shift8h,
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
  let policyRevisions: any[];
  let payrollPeriods: any[];

  function setupMockStore() {
    rawPunches = [];
    attendances = [];
    events = [];
    intervals = [];
    policyRevisions = [];
    payrollPeriods = [];

    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(prisma));
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
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

    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockImplementation((async () =>
      policyRevisions.slice()
    ) as any);

    vi.spyOn(prisma.employee, 'findFirst').mockImplementation((async (args: any) => {
      if (args?.where?.biometricDeviceId === '200' && args?.where?.companyId === companyId) {
        return activeEmployee as any;
      }
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
        company: { id: p.companyId, timezone: 'UTC' },
        terminal: { id: terminalId, name: 'Main Gate', location: 'HQ' },
        matchedEmployee: p.matchedEmployeeId === employeeId ? activeEmployee : null,
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
      const row: EventRow = {
        id: `ev-${events.length + 1}`,
        companyId: args.data.companyId,
        attendanceId: args.data.attendanceId,
        rawPunchLogId: args.data.rawPunchLogId ?? null,
        punchTime: new Date(args.data.punchTime),
        inOutMode: args.data.inOutMode,
        source: args.data.source,
        createdAt: new Date(Date.now() + events.length),
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
    vi.clearAllMocks();
    setupMockStore();
  });

  describe('Pure chronological pairing state machine', () => {
    it('pairs multiple IN/OUT sessions cleanly and sums duration minutes', () => {
      const res = pairAttendanceEventsChronologically([
        { id: 'e1', punchTime: new Date('2026-11-10T09:00:00Z'), inOutMode: 'CHECK_IN' },
        { id: 'e2', punchTime: new Date('2026-11-10T12:30:00Z'), inOutMode: 'CHECK_OUT' }, // 210m
        { id: 'e3', punchTime: new Date('2026-11-10T13:30:00Z'), inOutMode: 'CHECK_IN' },
        { id: 'e4', punchTime: new Date('2026-11-10T18:00:00Z'), inOutMode: 'CHECK_OUT' }, // 270m
      ]);

      expect(res.punchPairsCount).toBe(2);
      expect(res.actualWorkedMinutes).toBe(480);
      expect(res.hasIncompletePunch).toBe(false);
      expect(res.earliestCheckIn?.toISOString()).toBe('2026-11-10T09:00:00.000Z');
      expect(res.latestCheckOut?.toISOString()).toBe('2026-11-10T18:00:00.000Z');
      expect(res.intervals.map((i) => i.durationMinutes)).toEqual([210, 270]);
    });

    it('marks orphan or consecutive unmatched events as incomplete and re-pairs out-of-order inputs', () => {
      const res = pairAttendanceEventsChronologically([
        { id: 'out-early', punchTime: new Date('2026-11-10T12:00:00Z'), inOutMode: 'CHECK_OUT' },
        { id: 'in-late', punchTime: new Date('2026-11-10T13:00:00Z'), inOutMode: 'CHECK_IN' },
        { id: 'in-early', punchTime: new Date('2026-11-10T09:00:00Z'), inOutMode: 'CHECK_IN' }, // arrives out of order!
        { id: 'out-late', punchTime: new Date('2026-11-10T17:30:00Z'), inOutMode: 'CHECK_OUT' },
      ]);

      expect(res.punchPairsCount).toBe(2);
      expect(res.hasIncompletePunch).toBe(false);
      expect(res.actualWorkedMinutes).toBe(180 + 270);
      expect(res.intervals[0].inEventId).toBe('in-early');
      expect(res.intervals[0].outEventId).toBe('out-early');
      expect(res.intervals[1].inEventId).toBe('in-late');
      expect(res.intervals[1].outEventId).toBe('out-late');
    });
  });

  describe('Multi-pair reconciliation pipeline with DB store mocks', () => {
    it('reconciles 2 IN/OUT pairs across lunch break and computes actualWorkedMinutes & intervals accurately', async () => {
      rawPunches.push(
        {
          id: 'p1',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-10T09:00:00Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        },
        {
          id: 'p2',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-10T13:00:00Z'),
          inOutMode: 'CHECK_OUT',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        },
        {
          id: 'p3',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-10T14:00:00Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        },
        {
          id: 'p4',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-10T19:00:00Z'),
          inOutMode: 'CHECK_OUT',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        }
      );

      for (const id of ['p1', 'p2', 'p3', 'p4']) {
        const r = await PunchReconciliationService.reconcilePunch(id);
        expect(r.status).toBe('PROCESSED');
      }

      expect(attendances).toHaveLength(1);
      const att = attendances[0];
      expect(att.punchPairsCount).toBe(2);
      expect(att.hasIncompletePunch).toBe(false);
      // 4h (240m) + 5h (300m) = 540m (9h worked vs 8h required -> 60m overtime)
      expect(att.actualWorkedMinutes).toBe(540);
      expect(att.overtimeMinutes).toBe(60);
      expect(att.checkIn?.toISOString()).toBe('2026-11-10T09:00:00.000Z');
      expect(att.checkOut?.toISOString()).toBe('2026-11-10T19:00:00.000Z');
      expect(intervals).toHaveLength(2);
      expect(intervals.map((iv) => iv.durationMinutes)).toEqual([240, 300]);
    });

    it('marks earlier/orphan CHECK_OUT as PROCESSED incomplete and automatically re-pairs when earlier CHECK_IN arrives later', async () => {
      rawPunches.push(
        {
          id: 'p-late-in',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-11T13:00:00Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        },
        {
          id: 'p-late-out',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-11T17:30:00Z'),
          inOutMode: 'CHECK_OUT',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        },
        {
          id: 'p-orphan-earlier-out',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-11T12:00:00Z'), // earlier than 13:00!
          inOutMode: 'CHECK_OUT',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        },
        {
          id: 'p-delayed-earlier-in',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-11T09:00:00Z'), // arrives last from second terminal!
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        }
      );

      await PunchReconciliationService.reconcilePunch('p-late-in');
      await PunchReconciliationService.reconcilePunch('p-late-out');
      const orphanRes = await PunchReconciliationService.reconcilePunch('p-orphan-earlier-out');

      expect(orphanRes.status).toBe('PROCESSED');
      expect(orphanRes.message).toContain('paired chronologically (1 pair) with open trailing check-in');
      expect(rawPunches.find((p) => p.id === 'p-orphan-earlier-out')?.syncStatus).toBe('PROCESSED');
      // 3 punches sorted chronologically (12:00, 13:00, 17:30) -> 12:00->13:00 (60m) + 17:30 open IN
      expect(attendances[0].hasIncompletePunch).toBe(true);
      expect(attendances[0].punchPairsCount).toBe(1);
      expect(attendances[0].actualWorkedMinutes).toBe(60);

      // Now delayed earlier punch (09:00) arrives -> deterministically re-sequences ALL 4 events:
      // 09:00 (IN) -> 12:00 (OUT) [180m] AND 13:00 (IN) -> 17:30 (OUT) [270m]
      const repairRes = await PunchReconciliationService.reconcilePunch('p-delayed-earlier-in');
      expect(repairRes.status).toBe('PROCESSED');
      expect(repairRes.message).toContain('2 pairs');
      expect(attendances[0].hasIncompletePunch).toBe(false);
      expect(attendances[0].punchPairsCount).toBe(2);
      expect(attendances[0].actualWorkedMinutes).toBe(180 + 270); // 450m
      expect(attendances[0].checkIn?.toISOString()).toBe('2026-11-11T09:00:00.000Z');
      expect(attendances[0].checkOut?.toISOString()).toBe('2026-11-11T17:30:00.000Z');
      expect(intervals).toHaveLength(2);
      expect(intervals[0].isComplete).toBe(true);
      expect(intervals[1].isComplete).toBe(true);

      // Verify normalized AttendancePunchEvent modes alternate cleanly while RawPunchLog modes remain preserved
      const sortedEvents = events
        .slice()
        .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
      expect(sortedEvents.map((e) => e.inOutMode)).toEqual([
        'CHECK_IN',
        'CHECK_OUT',
        'CHECK_IN',
        'CHECK_OUT',
      ]);
      expect(rawPunches.find((p) => p.id === 'p-orphan-earlier-out')?.inOutMode).toBe('CHECK_OUT');
    });

    it('debounces rapid duplicate taps against ALL workday events of the same mode and seeds legacy Attendance rows', async () => {
      // Seed pre-migration Attendance row with 0 AttendancePunchEvent rows
      attendances.push({
        id: 'att-legacy-1',
        companyId,
        employeeId,
        shiftId: shift8h.id,
        workDate: new Date('2026-11-12T00:00:00Z'),
        checkIn: new Date('2026-11-12T09:00:00Z'),
        checkOut: new Date('2026-11-12T12:00:00Z'),
        status: 'PRESENT',
        lateMinutes: 0,
        overtimeMinutes: 0,
        actualWorkedMinutes: 180,
        hasIncompletePunch: false,
        punchPairsCount: 1,
        source: 'MANUAL',
        notes: 'Legacy morning session',
      });

      rawPunches.push(
        {
          id: 'p-dup-morning',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-12T09:01:15Z'), // within 2 min of seeded 09:00 CHECK_IN!
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        },
        {
          id: 'p-afternoon-in',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-12T14:00:00Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        }
      );

      const dupRes = await PunchReconciliationService.reconcilePunch('p-dup-morning');
      expect(dupRes.status).toBe('IGNORED');
      expect(dupRes.message).toContain('debounced');
      expect(events).toHaveLength(2); // legacy pair seeded

      const afternoonRes = await PunchReconciliationService.reconcilePunch('p-afternoon-in');
      expect(afternoonRes.status).toBe('PROCESSED');
      expect(events).toHaveLength(3);
      expect(attendances[0].hasIncompletePunch).toBe(true);
      expect(attendances[0].punchPairsCount).toBe(1);
      expect(attendances[0].actualWorkedMinutes).toBe(180);
    });

    it('blocks reconciliation during ACCOUNTS_APPROVED payroll lock and respects fromPunchTime cutoff', async () => {
      payrollPeriods.push({
        id: 'pp-nov',
        companyId,
        name: 'November 2026',
        startDate: new Date('2026-11-01T00:00:00Z'),
        endDate: new Date('2026-11-30T23:59:59Z'),
        status: 'ACCOUNTS_APPROVED',
      });

      rawPunches.push(
        {
          id: 'p-historical',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-05T09:00:00Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        },
        {
          id: 'p-new',
          companyId,
          terminalId,
          userEnrollmentId: '200',
          punchTime: new Date('2026-11-19T09:00:00Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          errorMessage: null,
          matchedEmployeeId: employeeId,
        }
      );

      // Reconcile only from Nov 18 onward -> p-historical remains untouched PENDING!
      const res = await PunchReconciliationService.reconcilePendingPunches(companyId, {
        fromPunchTime: '2026-11-18T00:00:00.000Z',
      });

      expect(res.totalEvaluated).toBe(1);
      expect(res.errors).toBe(1);
      expect(res.results[0].punchId).toBe('p-new');
      expect(res.results[0].message).toContain('ACCOUNTS_APPROVED');
      expect(rawPunches.find((p) => p.id === 'p-historical')?.syncStatus).toBe('PENDING');
      expect(rawPunches.find((p) => p.id === 'p-new')?.syncStatus).toBe('ERROR');
    });

    it('reconcilePendingPunches without options skips historical PENDING punches and uses company-local start of day', async () => {
      vi.useFakeTimers();
      try {
        // 2026-11-20 01:00 UTC == 2026-11-20 06:30 IST (Asia/Kolkata local day started 2026-11-19T18:30:00Z)
        vi.setSystemTime(new Date('2026-11-20T01:00:00.000Z'));

        vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({
          timezone: 'Asia/Kolkata',
        } as any);
        vi.spyOn(prisma.rawPunchLog, 'findUnique').mockImplementation((async (args: any) => {
          const p = rawPunches.find((item) => item.id === args?.where?.id);
          if (!p) return null;
          return {
            ...p,
            company: { id: p.companyId, timezone: 'Asia/Kolkata' },
            terminal: { id: terminalId, name: 'Main Gate', location: 'HQ' },
            matchedEmployee: p.matchedEmployeeId === employeeId ? activeEmployee : null,
          } as any;
        }) as any);

        rawPunches.push(
          {
            id: 'p-old-week',
            companyId,
            terminalId,
            userEnrollmentId: '200',
            punchTime: new Date('2026-11-10T04:00:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
            errorMessage: null,
            matchedEmployeeId: employeeId,
          },
          {
            id: 'p-yesterday-ist',
            companyId,
            terminalId,
            userEnrollmentId: '200',
            punchTime: new Date('2026-11-19T18:00:00.000Z'), // 23:30 IST on Nov 19 (yesterday!)
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
            errorMessage: null,
            matchedEmployeeId: employeeId,
          },
          {
            id: 'p-today-early-ist',
            companyId,
            terminalId,
            userEnrollmentId: '200',
            punchTime: new Date('2026-11-19T19:00:00.000Z'), // 00:30 IST on Nov 20 (today!)
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
            errorMessage: null,
            matchedEmployeeId: employeeId,
          }
        );

        const res = await PunchReconciliationService.reconcilePendingPunches(companyId);

        expect(res.totalEvaluated).toBe(1);
        expect(res.processed).toBe(1);
        expect(res.results[0].punchId).toBe('p-today-early-ist');
        expect(rawPunches.find((p) => p.id === 'p-old-week')?.syncStatus).toBe('PENDING');
        expect(rawPunches.find((p) => p.id === 'p-yesterday-ist')?.syncStatus).toBe('PENDING');
        expect(rawPunches.find((p) => p.id === 'p-today-early-ist')?.syncStatus).toBe('PROCESSED');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
