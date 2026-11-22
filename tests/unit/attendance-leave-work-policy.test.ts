import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { prisma } from '../../src/server/db/client.js';
import { AttendanceService } from '../../src/server/services/attendance.service.js';
import { AttendanceController } from '../../src/server/controllers/attendance.controller.js';
import { PermissionService } from '../../src/server/services/permission.service.js';
import { LeaveService } from '../../src/server/services/leave.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { AuthUser } from '../../src/shared/types.js';

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Step 2 Stage 4: AttendanceService & LeaveService Work-Policy Integration Tests', () => {
  const companyId = 'comp-stage4-1';
  const employeeId = 'emp-stage4-1';

  const adminActor: AuthUser = {
    id: 'user-admin-s4',
    userId: 'user-admin-s4',
    companyId,
    email: 'admin@stage4.local',
    fullName: 'Stage 4 Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const empActor: AuthUser = {
    id: 'user-emp-s4',
    userId: 'user-emp-s4',
    companyId,
    email: 'emp@stage4.local',
    fullName: 'Stage 4 Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
  });

  it('recognizes employee dailyWorkingHours with shiftId: null in getWorkingHoursSummary & getAdminNotifications', async () => {
    const todayStr = new Date().toISOString().split('T')[0];

    vi.spyOn(prisma.employee, 'findFirst').mockResolvedValue({ id: employeeId } as any);
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      employeeCode: 'EMP-CUSTOM',
      fullName: 'Custom Hours Worker',
      shiftId: null,
      shift: null,
      dailyWorkingHours: 6,
      monthlyLeaveAllowance: 4,
      company: { id: companyId, timezone: 'UTC' },
    } as any);

    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue([
      {
        id: 'rev-1',
        companyId,
        employeeId,
        shiftId: null,
        shift: null,
        dailyWorkingHours: 6,
        monthlyLeaveAllowance: 4,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // Multi-pair attendance totaling 5 hours (300m) against 6h required -> 60m short
    vi.spyOn(prisma.attendance, 'findFirst').mockResolvedValue({
      id: 'att-custom-1',
      companyId,
      employeeId,
      workDate: new Date(`${todayStr}T00:00:00Z`),
      checkIn: new Date(`${todayStr}T09:00:00Z`),
      checkOut: new Date(`${todayStr}T16:00:00Z`),
      actualWorkedMinutes: 300,
      punchPairsCount: 2,
      hasIncompletePunch: false,
      shift: null,
      updatedAt: new Date(),
    } as any);

    const summary = await AttendanceService.getWorkingHoursSummary(empActor);
    expect(summary.status).toBe('SHORT_HOURS');
    expect(summary.expectedDurationHours).toBe(6);
    expect(summary.workedDurationHours).toBe(5);
    expect(summary.actualWorkedMinutes).toBe(300);
    expect(summary.punchPairsCount).toBe(2);
    expect(summary.shortDurationMinutes).toBe(60);
    expect(summary.overtimeDurationMinutes).toBe(0);

    // Admin notifications: must NOT emit NO_SHIFT_ASSIGNED for custom-hours worker, and SHOULD emit SHORT_HOURS
    vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([
      {
        id: employeeId,
        companyId,
        employeeCode: 'EMP-CUSTOM',
        fullName: 'Custom Hours Worker',
        shiftId: null,
        shift: null,
        dailyWorkingHours: 6,
        monthlyLeaveAllowance: 4,
        status: 'ACTIVE',
      },
    ] as any);
    vi.spyOn(prisma.attendance, 'findMany').mockResolvedValue([
      {
        id: 'att-custom-1',
        companyId,
        employeeId,
        workDate: new Date(`${todayStr}T00:00:00Z`),
        checkIn: new Date(`${todayStr}T09:00:00Z`),
        checkOut: new Date(`${todayStr}T16:00:00Z`),
        actualWorkedMinutes: 300,
        punchPairsCount: 2,
        hasIncompletePunch: false,
        shift: null,
        employee: {
          id: employeeId,
          fullName: 'Custom Hours Worker',
          employeeCode: 'EMP-CUSTOM',
          shiftId: null,
          shift: null,
          dailyWorkingHours: 6,
          monthlyLeaveAllowance: 4,
        },
        updatedAt: new Date(),
      },
    ] as any);

    const notif = await AttendanceService.getAdminNotifications(adminActor);
    expect(notif.items.some((i) => i.type === 'NO_SHIFT_ASSIGNED')).toBe(false);
    const shortAlert = notif.items.find((i) => i.type === 'SHORT_HOURS');
    expect(shortAlert).toBeDefined();
    expect(shortAlert?.message).toContain('1h 0m');
  });

  it('maintains actualWorkedMinutes/punchPairsCount on manual create & update and exposes short/extra time on listAttendance', async () => {
    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(prisma));
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      shiftId: null,
      shift: null,
    } as any);
    vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null);

    const createdRow = {
      id: 'att-manual-1',
      companyId,
      employeeId,
      shiftId: null,
      workDate: new Date('2026-11-10T00:00:00Z'),
      checkIn: new Date('2026-11-10T09:00:00Z'),
      checkOut: new Date('2026-11-10T18:30:00Z'),
      status: 'PRESENT',
      lateMinutes: 0,
      overtimeMinutes: 0,
      actualWorkedMinutes: 570,
      hasIncompletePunch: false,
      punchPairsCount: 1,
      source: 'MANUAL',
      notes: 'Manual entry',
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: { employeeCode: 'EMP-CUSTOM', fullName: 'Custom Hours Worker' },
      shift: null,
    };
    const createSpy = vi.spyOn(prisma.attendance, 'create').mockResolvedValueOnce(createdRow as any);

    const created = await AttendanceService.createAttendance(adminActor, {
      employeeId,
      workDate: '2026-11-10',
      checkIn: '2026-11-10T09:00:00.000Z',
      checkOut: '2026-11-10T18:30:00.000Z',
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actualWorkedMinutes: 570,
          hasIncompletePunch: false,
          punchPairsCount: 1,
        }),
      })
    );
    expect(created.actualWorkedMinutes).toBe(570);
    expect(created.punchPairsCount).toBe(1);
    expect(created.hasIncompletePunch).toBe(false);

    // listAttendance exposes multi-pair & independent short/extra time
    vi.spyOn(prisma.attendance, 'count').mockResolvedValueOnce(1);
    vi.spyOn(prisma.attendance, 'findMany').mockResolvedValueOnce([
      {
        ...createdRow,
        employee: {
          employeeCode: 'EMP-CUSTOM',
          fullName: 'Custom Hours Worker',
          shiftId: null,
          shift: null,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 4,
        },
      },
    ] as any);
    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValueOnce([]);

    const listed = await AttendanceService.listAttendance(adminActor, { employeeId });
    expect(listed.items[0].requiredMinutes).toBe(480);
    expect(listed.items[0].shortTimeMinutes).toBe(0);
    expect(listed.items[0].extraTimeMinutes).toBe(90);
  });

  it('LeaveService sums Short Time and Extra Time independently without offsetting and uses effective-dated hourly rates and next-month leave allowance', async () => {
    // Employee has Salary Revision + Work Policy Revision changing mid-month Nov 16, 2026
    // Days 1..15: Salary 3000 ($100/day), Required 8h ($12.50/hr), Monthly Allowance 4
    // Days 16..30: Salary 4500 ($150/day), Required 6h ($25.00/hr), Monthly Allowance still 4 for Nov (becomes 2 on Dec 1!)
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      fullName: 'Policy Employee',
      employeeCode: 'EMP-POL',
      shiftId: null,
      shift: null,
      dailyWorkingHours: 6,
      monthlyLeaveAllowance: 4,
      salaryRevisions: [
        {
          fixedSalary: '4500.00',
          effectiveFrom: new Date('2026-11-16T00:00:00Z'),
          effectiveTo: null,
        },
        {
          fixedSalary: '3000.00',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveTo: new Date('2026-11-15T00:00:00Z'),
        },
      ],
    } as any);

    const revisions = [
      {
        id: 'pol-1',
        companyId,
        employeeId,
        shiftId: null,
        shift: null,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: new Date('2026-11-15T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pol-2',
        companyId,
        employeeId,
        shiftId: null,
        shift: null,
        dailyWorkingHours: 6,
        monthlyLeaveAllowance: 4,
        effectiveFrom: new Date('2026-11-16T00:00:00Z'),
        effectiveTo: new Date('2026-11-30T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pol-3',
        companyId,
        employeeId,
        shiftId: null,
        shift: null,
        dailyWorkingHours: 6,
        monthlyLeaveAllowance: 2,
        effectiveFrom: new Date('2026-12-01T00:00:00Z'),
        effectiveTo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue(revisions as any);
    vi.spyOn(prisma.leaveType, 'findMany').mockResolvedValue([
      { id: 'lt-1', code: 'AL', name: 'Annual', isPaid: true, defaultAllowance: 15, isActive: true },
    ] as any);

    // 3 approved leave days in Nov -> within Nov's preserved allowance of 4 (0 excess!), would exceed Dec's 2!
    vi.spyOn(prisma.leaveRequest, 'findMany').mockResolvedValue([
      {
        id: 'lr-1',
        companyId,
        employeeId,
        leaveTypeId: 'lt-1',
        startDate: new Date('2026-11-02T00:00:00Z'),
        endDate: new Date('2026-11-04T00:00:00Z'),
        totalDays: 3,
        status: 'APPROVED',
      },
    ] as any);

    vi.spyOn(prisma.attendance, 'findMany').mockResolvedValue([
      // Nov 5: 10h worked (2 pairs = 600m) vs 8h required -> 120m (2h) EXTRA time
      {
        id: 'att-nov-5',
        workDate: new Date('2026-11-05T00:00:00Z'),
        checkIn: new Date('2026-11-05T08:00:00Z'),
        checkOut: new Date('2026-11-05T19:00:00Z'),
        actualWorkedMinutes: 600,
        hasIncompletePunch: false,
        punchPairsCount: 2,
        status: 'PRESENT',
        shift: null,
      },
      // Nov 10: 6h worked (360m) vs 8h required -> 120m (2h) SHORT time @ $12.50/hr = $25.00 deduction
      {
        id: 'att-nov-10',
        workDate: new Date('2026-11-10T00:00:00Z'),
        checkIn: new Date('2026-11-10T09:00:00Z'),
        checkOut: new Date('2026-11-10T15:00:00Z'),
        actualWorkedMinutes: 360,
        hasIncompletePunch: false,
        punchPairsCount: 1,
        status: 'PRESENT',
        shift: null,
      },
      // Nov 20: 5h worked (300m) vs 6h required -> 60m (1h) SHORT time @ $25.00/hr = $25.00 deduction
      {
        id: 'att-nov-20',
        workDate: new Date('2026-11-20T00:00:00Z'),
        checkIn: new Date('2026-11-20T09:00:00Z'),
        checkOut: new Date('2026-11-20T14:00:00Z'),
        actualWorkedMinutes: 300,
        hasIncompletePunch: false,
        punchPairsCount: 1,
        status: 'PRESENT',
        shift: null,
      },
      // Nov 21: has 1 completed pair (3h) + open orphan punch -> incomplete! Must withhold deduction
      {
        id: 'att-nov-21',
        workDate: new Date('2026-11-21T00:00:00Z'),
        checkIn: new Date('2026-11-21T09:00:00Z'),
        checkOut: new Date('2026-11-21T12:00:00Z'),
        actualWorkedMinutes: 180,
        hasIncompletePunch: true,
        punchPairsCount: 1,
        status: 'PRESENT',
        shift: null,
      },
    ] as any);

    const novSummary = await LeaveService.getMonthlyLeaveSummary(adminActor, {
      employeeId,
      year: 2026,
      month: 11,
    });

    // Monthly allowance stayed 4 for November
    expect(novSummary.monthlyLeaveAllowance).toBe(4);
    expect(novSummary.monthApprovedDays).toBe(3);
    expect(novSummary.monthlyExcessLeaveDays).toBe(0);
    expect(novSummary.excessLeaveDeduction).toBe('0.00');

    // Non-offsetting Short Time & Extra Time:
    // Short = 120m (Nov 10) + 60m (Nov 20) = 180m (3h); Extra = 120m (Nov 5) = 2h
    expect(novSummary.shortTimeMinutes).toBe(180);
    expect(novSummary.extraTimeMinutes).toBe(120);
    expect(novSummary.shortTimeHours).toBe(3);
    expect(novSummary.extraTimeHours).toBe(2);
    expect(novSummary.deductibleShortHours).toBe(3);
    // $25.00 (Nov 10: 2h * $12.50) + $25.00 (Nov 20: 1h * $25.00) = $50.00
    expect(novSummary.shortHoursDeduction).toBe('50.00');
    expect(novSummary.totalSalaryDeductions).toBe('50.00');
    expect(novSummary.incompleteAttendanceCount).toBe(1);
    expect(novSummary.warnings?.some((w) => w.includes('No assigned working schedule'))).toBe(false);

    // Verify December picks up new monthlyLeaveAllowance = 2!
    vi.spyOn(prisma.leaveRequest, 'findMany').mockResolvedValueOnce([
      {
        id: 'lr-dec',
        companyId,
        employeeId,
        leaveTypeId: 'lt-1',
        startDate: new Date('2026-12-02T00:00:00Z'),
        endDate: new Date('2026-12-04T00:00:00Z'),
        totalDays: 3,
        status: 'APPROVED',
      },
    ] as any);
    vi.spyOn(prisma.attendance, 'findMany').mockResolvedValueOnce([]);

    const decSummary = await LeaveService.getMonthlyLeaveSummary(adminActor, {
      employeeId,
      year: 2026,
      month: 12,
    });

    expect(decSummary.monthlyLeaveAllowance).toBe(2);
    expect(decSummary.monthApprovedDays).toBe(3);
    expect(decSummary.monthlyExcessLeaveDays).toBe(1);
    expect(decSummary.excessLeaveDeduction).toBe('150.00'); // $4500 / 30 * 1
  });

  it('protects biometric AttendancePunchEvent/AttendanceInterval data during manual updateAttendance while preserving ordinary manual updates', async () => {
    const biometricAttendance = {
      id: 'att-bio-1',
      companyId,
      employeeId,
      shiftId: null,
      workDate: new Date('2026-11-18T00:00:00.000Z'),
      checkIn: new Date('2026-11-18T09:00:00.000Z'),
      checkOut: new Date('2026-11-18T17:00:00.000Z'),
      status: 'PRESENT',
      lateMinutes: 0,
      overtimeMinutes: 0,
      actualWorkedMinutes: 420,
      hasIncompletePunch: false,
      punchPairsCount: 1,
      source: 'BIOMETRIC',
      notes: 'Biometric intervals synced',
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: { employeeCode: 'EMP-1', fullName: 'Worker 1' },
      shift: null,
    };

    vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValue(biometricAttendance as any);
    vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
    vi.spyOn((prisma as any).attendancePunchEvent, 'count').mockResolvedValue(2);
    vi.spyOn((prisma as any).attendanceInterval, 'count').mockResolvedValue(1);
    const updateSpy = vi.spyOn(prisma.attendance, 'update');

    await expect(
      AttendanceService.updateAttendance(adminActor, biometricAttendance.id, {
        checkOut: '2026-11-18T18:00:00.000Z',
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      AttendanceService.updateAttendance(adminActor, biometricAttendance.id, {
        checkIn: '2026-11-18T08:30:00.000Z',
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      AttendanceService.updateAttendance(adminActor, biometricAttendance.id, {
        status: 'ABSENT',
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      AttendanceService.updateAttendance(adminActor, biometricAttendance.id, {
        status: 'ON_LEAVE',
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(updateSpy).not.toHaveBeenCalled();

    // Non-timestamp metadata edit (e.g. notes + LATE status) succeeds and leaves biometric summary fields untouched
    updateSpy.mockResolvedValueOnce({
      ...biometricAttendance,
      status: 'LATE',
      notes: 'Approved late arrival',
    } as any);

    const updatedBio = await AttendanceService.updateAttendance(
      adminActor,
      biometricAttendance.id,
      {
        status: 'LATE',
        notes: 'Approved late arrival',
      }
    );
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const bioUpdatePayload = updateSpy.mock.calls[0][0].data as Record<string, unknown>;
    expect(bioUpdatePayload.actualWorkedMinutes).toBeUndefined();
    expect(bioUpdatePayload.punchPairsCount).toBeUndefined();
    expect(bioUpdatePayload.hasIncompletePunch).toBeUndefined();
    expect(updatedBio.actualWorkedMinutes).toBe(420);
    expect(updatedBio.punchPairsCount).toBe(1);

    // Ordinary manual attendance with 0 biometric events/intervals still recalculates summary columns
    const manualAttendance = {
      ...biometricAttendance,
      id: 'att-manual-plain',
      source: 'MANUAL',
      actualWorkedMinutes: 480,
      punchPairsCount: 1,
    };
    vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(manualAttendance as any);
    vi.spyOn((prisma as any).attendancePunchEvent, 'count').mockResolvedValueOnce(0);
    vi.spyOn((prisma as any).attendanceInterval, 'count').mockResolvedValueOnce(0);
    updateSpy.mockResolvedValueOnce({
      ...manualAttendance,
      checkOut: new Date('2026-11-18T18:00:00.000Z'),
      actualWorkedMinutes: 540,
      punchPairsCount: 1,
    } as any);

    const updatedManual = await AttendanceService.updateAttendance(adminActor, manualAttendance.id, {
      checkOut: '2026-11-18T18:00:00.000Z',
    });
    const manualUpdatePayload = updateSpy.mock.calls[1][0].data as Record<string, unknown>;
    expect(manualUpdatePayload.actualWorkedMinutes).toBe(540);
    expect(manualUpdatePayload.punchPairsCount).toBe(1);
    expect(manualUpdatePayload.hasIncompletePunch).toBe(false);
    expect(updatedManual.actualWorkedMinutes).toBe(540);
  });

  it('blocks manual createAttendance and updateAttendance for PROCESSED, ACCOUNTS_APPROVED, and POSTED payroll periods while allowing unlocked periods', async () => {
    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(prisma));
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      shiftId: null,
      shift: null,
    } as any);

    for (const status of ['PROCESSED', 'ACCOUNTS_APPROVED', 'POSTED'] as const) {
      // 1. Block createAttendance
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null);
      const findPeriodSpy = vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce({
        id: `pp-${status.toLowerCase()}`,
        name: `November 2026 (${status})`,
        status,
      } as any);

      await expect(
        AttendanceService.createAttendance(adminActor, {
          employeeId,
          workDate: '2026-11-15',
          checkIn: '2026-11-15T09:00:00.000Z',
          checkOut: '2026-11-15T17:00:00.000Z',
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(status),
      });

      expect(findPeriodSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            companyId,
            status: { in: ['PROCESSED', 'ACCOUNTS_APPROVED', 'POSTED'] },
          }),
        })
      );

      // 2. Block updateAttendance
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce({
        id: 'att-lock-1',
        companyId,
        employeeId,
        shiftId: null,
        workDate: new Date('2026-11-15T00:00:00.000Z'),
        checkIn: new Date('2026-11-15T09:00:00.000Z'),
        checkOut: new Date('2026-11-15T17:00:00.000Z'),
        status: 'PRESENT',
        lateMinutes: 0,
        overtimeMinutes: 0,
        actualWorkedMinutes: 480,
        hasIncompletePunch: false,
        punchPairsCount: 1,
        source: 'MANUAL',
        notes: null,
        employee: { employeeCode: 'EMP-1', fullName: 'Worker 1' },
        shift: null,
      } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce({
        id: `pp-${status.toLowerCase()}`,
        name: `November 2026 (${status})`,
        status,
      } as any);

      await expect(
        AttendanceService.updateAttendance(adminActor, 'att-lock-1', {
          notes: 'Should be rejected',
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(status),
      });
    }

    // 3. Unlocked period (no PROCESSED/ACCOUNTS_APPROVED/POSTED period matched -> null) allows createAttendance
    vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null);
    vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
    vi.spyOn(prisma.attendance, 'create').mockResolvedValueOnce({
      id: 'att-draft-ok',
      companyId,
      employeeId,
      shiftId: null,
      workDate: new Date('2026-12-05T00:00:00.000Z'),
      checkIn: new Date('2026-12-05T09:00:00.000Z'),
      checkOut: new Date('2026-12-05T17:00:00.000Z'),
      status: 'PRESENT',
      lateMinutes: 0,
      overtimeMinutes: 0,
      actualWorkedMinutes: 480,
      hasIncompletePunch: false,
      punchPairsCount: 1,
      source: 'MANUAL',
      notes: 'Draft month allowed',
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: { employeeCode: 'EMP-1', fullName: 'Worker 1' },
      shift: null,
    } as any);

    const allowed = await AttendanceService.createAttendance(adminActor, {
      employeeId,
      workDate: '2026-12-05',
      checkIn: '2026-12-05T09:00:00.000Z',
      checkOut: '2026-12-05T17:00:00.000Z',
      notes: 'Draft month allowed',
    });
    expect(allowed.id).toBe('att-draft-ok');
  });
});

describe('P1-1: AttendanceService Timezone-Aware calculateLateMinutes (createAttendance & updateAttendance)', () => {
  const companyId = 'comp-tz-late-1';
  const employeeId = 'emp-tz-late-1';
  const shiftId = 'shift-day-0900';

  const adminActor: AuthUser = {
    id: 'user-admin-tz',
    userId: 'user-admin-tz',
    companyId,
    email: 'admin@tz.local',
    fullName: 'Timezone Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(prisma));
    vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
    vi.spyOn((prisma as any).attendancePunchEvent, 'count').mockResolvedValue(0);
    vi.spyOn((prisma as any).attendanceInterval, 'count').mockResolvedValue(0);
  });

  it('calculateLateMinutes: Asia/Kolkata (+05:30) treats 09:00 local as on-time and 09:30 local as 30m late subject to grace', () => {
    const workDate = '2026-11-10';
    // 09:00 IST = 03:30:00Z, 09:15 IST = 03:45:00Z, 09:30 IST = 04:00:00Z
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-10T03:30:00.000Z'),
        workDate,
        { startTime: '09:00', graceMinutes: 0 },
        'Asia/Kolkata'
      )
    ).toBe(0);

    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-10T03:45:00.000Z'),
        workDate,
        { startTime: '09:00', graceMinutes: 15 },
        'Asia/Kolkata'
      )
    ).toBe(0);

    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-10T04:00:00.000Z'),
        workDate,
        { startTime: '09:00', graceMinutes: 15 },
        'Asia/Kolkata'
      )
    ).toBe(30);

    // Grace period of 30 minutes covers an exact 09:30 IST check-in
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-10T04:00:00.000Z'),
        workDate,
        { startTime: '09:00', graceMinutes: 30 },
        'Asia/Kolkata'
      )
    ).toBe(0);

    // Floor rounding preserved: 09:15:45 IST against 09:00 shift with 15m grace -> 15 late minutes
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-10T03:45:45.000Z'),
        workDate,
        { startTime: '09:00', graceMinutes: 15 },
        'Asia/Kolkata'
      )
    ).toBe(15);
  });

  it('calculateLateMinutes: America/New_York (EST & EDT) handles on-time and genuinely late check-ins across DST', () => {
    // Winter EST (-05:00): 2026-11-10 09:00 EST = 14:00:00Z; 09:35 EST = 14:35:00Z
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-10T14:00:00.000Z'),
        '2026-11-10',
        { startTime: '09:00', graceMinutes: 15 },
        'America/New_York'
      )
    ).toBe(0);

    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-10T14:35:00.000Z'),
        '2026-11-10',
        { startTime: '09:00', graceMinutes: 15 },
        'America/New_York'
      )
    ).toBe(35);

    // Summer EDT (-04:00): 2026-07-15 09:00 EDT = 13:00:00Z; 09:25 EDT = 13:25:00Z
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-07-15T13:00:00.000Z'),
        '2026-07-15',
        { startTime: '09:00', graceMinutes: 10 },
        'America/New_York'
      )
    ).toBe(0);

    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-07-15T13:25:00.000Z'),
        '2026-07-15',
        { startTime: '09:00', graceMinutes: 10 },
        'America/New_York'
      )
    ).toBe(25);
  });

  it('calculateLateMinutes: preserves UTC behavior and handles overnight shifts in non-UTC timezones', () => {
    // Existing UTC behavior unchanged (default and explicit 'UTC')
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-10-16T09:10:00.000Z'),
        '2026-10-16',
        { startTime: '09:00', graceMinutes: 15 }
      )
    ).toBe(0);
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-10-16T09:15:00.000Z'),
        '2026-10-16',
        { startTime: '09:00', graceMinutes: 15 },
        'UTC'
      )
    ).toBe(0);
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-10-16T09:30:00.000Z'),
        '2026-10-16',
        { startTime: '09:00', graceMinutes: 15 },
        'UTC'
      )
    ).toBe(30);
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-10-16T10:15:00.000Z'),
        '2026-10-16',
        { startTime: '09:00', graceMinutes: 15 },
        'UTC'
      )
    ).toBe(75);

    // Overnight shift (22:00 start) in America/New_York (EST -05:00):
    // 2026-11-10 22:00 EST = 2026-11-11T03:00:00.000Z
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-11T03:00:00.000Z'),
        '2026-11-10',
        { startTime: '22:00', graceMinutes: 10 },
        'America/New_York'
      )
    ).toBe(0);
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-11T03:25:00.000Z'),
        '2026-11-10',
        { startTime: '22:00', graceMinutes: 10 },
        'America/New_York'
      )
    ).toBe(25);

    // Overnight shift (22:00 start) in Asia/Kolkata (+05:30):
    // 2026-11-10 22:00 IST = 2026-11-10T16:30:00.000Z; 00:15 IST next day = 2026-11-10T18:45:00.000Z (135m late)
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-10T16:30:00.000Z'),
        '2026-11-10',
        { startTime: '22:00', graceMinutes: 10 },
        'Asia/Kolkata'
      )
    ).toBe(0);
    expect(
      AttendanceService.calculateLateMinutes(
        new Date('2026-11-10T18:45:00.000Z'),
        '2026-11-10',
        { startTime: '22:00', graceMinutes: 10 },
        'Asia/Kolkata'
      )
    ).toBe(135);
  });

  it('createAttendance uses company timezone consistently for Asia/Kolkata, America/New_York, and UTC', async () => {
    const dayShift = {
      id: shiftId,
      companyId,
      name: 'Day Shift',
      startTime: '09:00',
      graceMinutes: 15,
    };

    const runCreate = async (
      timezone: string,
      checkInIso: string,
      checkOutIso: string
    ) => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone } as any);
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValueOnce({
        id: employeeId,
        companyId,
      } as any);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null);
      vi.spyOn(prisma.shift, 'findUnique').mockResolvedValueOnce(dayShift as any);

      let persisted: any = null;
      vi.spyOn(prisma.attendance, 'create').mockImplementationOnce(
        (async (args: any) => {
          persisted = args.data;
          return {
            id: `att-${timezone}`,
            companyId,
            employeeId,
            shiftId: args.data.shiftId,
            workDate: args.data.workDate,
            checkIn: args.data.checkIn,
            checkOut: args.data.checkOut,
            status: args.data.status,
            lateMinutes: args.data.lateMinutes,
            overtimeMinutes: 0,
            actualWorkedMinutes: args.data.actualWorkedMinutes,
            hasIncompletePunch: args.data.hasIncompletePunch,
            punchPairsCount: args.data.punchPairsCount,
            source: args.data.source,
            notes: args.data.notes,
            createdAt: new Date(),
            updatedAt: new Date(),
            employee: { employeeCode: 'EMP-TZ', fullName: 'TZ Worker' },
            shift: { name: 'Day Shift' },
          };
        }) as any
      );

      const result = await AttendanceService.createAttendance(adminActor, {
        employeeId,
        shiftId,
        workDate: '2026-11-10',
        checkIn: checkInIso,
        checkOut: checkOutIso,
      });

      return { result, persisted };
    };

    // 1. Asia/Kolkata on-time 09:00 IST (03:30Z) -> PRESENT, 0 lateMinutes
    const istOnTime = await runCreate(
      'Asia/Kolkata',
      '2026-11-10T03:30:00.000Z',
      '2026-11-10T12:00:00.000Z'
    );
    expect(istOnTime.persisted.lateMinutes).toBe(0);
    expect(istOnTime.persisted.status).toBe('PRESENT');
    expect(istOnTime.result.lateMinutes).toBe(0);
    expect(istOnTime.result.status).toBe('PRESENT');

    // 2. Asia/Kolkata late 09:30 IST (04:00Z) -> LATE, 30 lateMinutes
    const istLate = await runCreate(
      'Asia/Kolkata',
      '2026-11-10T04:00:00.000Z',
      '2026-11-10T12:30:00.000Z'
    );
    expect(istLate.persisted.lateMinutes).toBe(30);
    expect(istLate.persisted.status).toBe('LATE');

    // 3. America/New_York on-time 09:00 EST (14:00Z) -> PRESENT, 0 lateMinutes
    const nyOnTime = await runCreate(
      'America/New_York',
      '2026-11-10T14:00:00.000Z',
      '2026-11-10T22:00:00.000Z'
    );
    expect(nyOnTime.persisted.lateMinutes).toBe(0);
    expect(nyOnTime.persisted.status).toBe('PRESENT');

    // 4. America/New_York late 09:40 EST (14:40Z) -> LATE, 40 lateMinutes
    const nyLate = await runCreate(
      'America/New_York',
      '2026-11-10T14:40:00.000Z',
      '2026-11-10T22:40:00.000Z'
    );
    expect(nyLate.persisted.lateMinutes).toBe(40);
    expect(nyLate.persisted.status).toBe('LATE');

    // 5. UTC late 09:30Z -> LATE, 30 lateMinutes (unchanged)
    const utcLate = await runCreate(
      'UTC',
      '2026-11-10T09:30:00.000Z',
      '2026-11-10T17:30:00.000Z'
    );
    expect(utcLate.persisted.lateMinutes).toBe(30);
    expect(utcLate.persisted.status).toBe('LATE');
  });

  it('updateAttendance recomputes lateMinutes consistently using company timezone on checkIn and shift changes', async () => {
    const baseRecord = {
      id: 'att-upd-tz-1',
      companyId,
      employeeId,
      shiftId,
      workDate: new Date('2026-11-10T00:00:00.000Z'),
      checkIn: new Date('2026-11-10T14:40:00.000Z'), // 09:40 EST
      checkOut: new Date('2026-11-10T22:00:00.000Z'),
      status: 'LATE',
      lateMinutes: 40,
      overtimeMinutes: 0,
      actualWorkedMinutes: 440,
      hasIncompletePunch: false,
      punchPairsCount: 1,
      source: 'MANUAL',
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: { employeeCode: 'EMP-TZ', fullName: 'TZ Worker' },
      shift: { id: shiftId, name: 'Day Shift', startTime: '09:00', graceMinutes: 15 },
    };

    const runUpdate = async (
      timezone: string,
      input: { checkIn?: string; shiftId?: string },
      nextShift?: { id: string; companyId: string; name: string; startTime: string; graceMinutes: number }
    ) => {
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(baseRecord as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone } as any);
      if (nextShift) {
        vi.spyOn(prisma.shift, 'findUnique').mockResolvedValueOnce(nextShift as any);
      }

      let persisted: any = null;
      vi.spyOn(prisma.attendance, 'update').mockImplementationOnce(
        (async (args: any) => {
          persisted = args.data;
          return {
            ...baseRecord,
            ...args.data,
            shift: nextShift ? { name: nextShift.name } : baseRecord.shift,
          };
        }) as any
      );

      const updated = await AttendanceService.updateAttendance(adminActor, baseRecord.id, input);
      return { updated, persisted };
    };

    // 1. America/New_York: update checkIn to on-time 09:00 EST (14:00Z) -> lateMinutes = 0
    const nyCorrectedOnTime = await runUpdate('America/New_York', {
      checkIn: '2026-11-10T14:00:00.000Z',
    });
    expect(nyCorrectedOnTime.persisted.lateMinutes).toBe(0);
    expect(nyCorrectedOnTime.updated.lateMinutes).toBe(0);

    // 2. Asia/Kolkata: update checkIn to 09:30 IST (04:00Z) -> lateMinutes = 30
    const istUpdatedLate = await runUpdate('Asia/Kolkata', {
      checkIn: '2026-11-10T04:00:00.000Z',
    });
    expect(istUpdatedLate.persisted.lateMinutes).toBe(30);
    expect(istUpdatedLate.updated.lateMinutes).toBe(30);

    // 3. America/New_York: change shift to 10:00 EST start while keeping 09:40 EST checkIn -> lateMinutes = 0
    const nyShiftChanged = await runUpdate(
      'America/New_York',
      { shiftId: 'shift-late-1000' },
      { id: 'shift-late-1000', companyId, name: 'Late Morning', startTime: '10:00', graceMinutes: 15 }
    );
    expect(nyShiftChanged.persisted.lateMinutes).toBe(0);
    expect(nyShiftChanged.updated.lateMinutes).toBe(0);
  });
});

describe('P2-6: AttendanceService.updateAttendance EMPLOYEE Self-Ownership Defense-in-Depth', () => {
  const companyA = 'comp-p26-a';
  const companyB = 'comp-p26-b';
  const selfEmpId = 'emp-p26-self';
  const otherEmpId = 'emp-p26-other';

  const empActor: AuthUser = {
    id: 'user-emp-p26',
    userId: 'user-emp-p26',
    companyId: companyA,
    email: 'emp@p26.local',
    fullName: 'Employee Self',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const adminActor: AuthUser = {
    id: 'user-admin-p26',
    userId: 'user-admin-p26',
    companyId: companyA,
    email: 'admin@p26.local',
    fullName: 'Company Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const superAdminActor: AuthUser = {
    id: 'user-sa-p26',
    userId: 'user-sa-p26',
    companyId: companyA,
    email: 'superadmin@p26.local',
    fullName: 'Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const makeAttendanceRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'att-p26-1',
    companyId: companyA,
    employeeId: selfEmpId,
    shiftId: 'shift-p26-1',
    workDate: new Date('2026-11-12T00:00:00.000Z'),
    checkIn: new Date('2026-11-12T09:00:00.000Z'),
    checkOut: new Date('2026-11-12T17:00:00.000Z'),
    status: 'PRESENT',
    lateMinutes: 0,
    overtimeMinutes: 0,
    actualWorkedMinutes: 480,
    hasIncompletePunch: false,
    punchPairsCount: 1,
    source: 'MANUAL',
    notes: 'Original note',
    createdAt: new Date('2026-11-12T09:00:00.000Z'),
    updatedAt: new Date('2026-11-12T17:00:00.000Z'),
    employee: { employeeCode: 'EMP-SELF', fullName: 'Employee Self' },
    shift: { id: 'shift-p26-1', name: 'Day Shift', startTime: '09:00', graceMinutes: 15 },
    ...overrides,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
    vi.spyOn((prisma as any).attendancePunchEvent, 'count').mockResolvedValue(0);
    vi.spyOn((prisma as any).attendanceInterval, 'count').mockResolvedValue(0);
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
  });

  it('allows EMPLOYEE to update their own attendance record when route permission allows it', async () => {
    const ownRecord = makeAttendanceRecord({ id: 'att-p26-own', employeeId: selfEmpId });
    vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(ownRecord as any);
    const empLookupSpy = vi
      .spyOn(prisma.employee, 'findFirst')
      .mockResolvedValueOnce({ id: selfEmpId } as any);
    const updateSpy = vi.spyOn(prisma.attendance, 'update').mockResolvedValueOnce({
      ...ownRecord,
      notes: 'Updated own note',
    } as any);

    const updated = await AttendanceService.updateAttendance(empActor, ownRecord.id, {
      notes: 'Updated own note',
    });

    expect(empLookupSpy).toHaveBeenCalledWith({
      where: { companyId: companyA, userId: empActor.userId },
      select: { id: true },
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(AuditService.log).toHaveBeenCalledTimes(1);
    expect(updated.notes).toBe('Updated own note');
  });

  it('rejects EMPLOYEE updating another employee attendance with HTTP 403 FORBIDDEN even when ATTENDANCE:EDIT RolePermission override is enabled, with zero mutation or side effects', async () => {
    // Simulate a company RolePermission override enabling ATTENDANCE:EDIT for EMPLOYEE
    vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValueOnce({
      isGranted: true,
    } as any);
    expect(await PermissionService.hasPermission(companyA, 'EMPLOYEE', 'ATTENDANCE', 'EDIT')).toBe(true);

    const otherRecord = makeAttendanceRecord({
      id: 'att-p26-other',
      employeeId: otherEmpId,
      employee: { employeeCode: 'EMP-OTHER', fullName: 'Other Worker' },
    });
    vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValue(otherRecord as any);
    vi.spyOn(prisma.employee, 'findFirst').mockResolvedValue({ id: selfEmpId } as any);

    const payrollSpy = vi.spyOn(prisma.payrollPeriod, 'findFirst');
    const shiftSpy = vi.spyOn(prisma.shift, 'findUnique');
    const updateSpy = vi.spyOn(prisma.attendance, 'update');

    // Direct service call rejects with statusCode 403
    await expect(
      AttendanceService.updateAttendance(empActor, otherRecord.id, {
        notes: 'Unauthorized edit',
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/only permitted to update their own attendance records/i),
    });

    // Controller maps the 403 error cleanly to HTTP 403 FORBIDDEN
    const req = {
      user: empActor,
      params: { id: otherRecord.id },
      body: { notes: 'Unauthorized edit' },
      correlationId: 'corr-p26-forbid',
    } as unknown as Request;
    let statusCode = 0;
    let body: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Response;

    await AttendanceController.update(req, res);

    expect(statusCode).toBe(403);
    expect(body).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Employees are only permitted to update their own attendance records.',
      },
    });

    // Zero mutations or downstream side effects occurred
    expect(payrollSpy).not.toHaveBeenCalled();
    expect(shiftSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(AuditService.log).not.toHaveBeenCalled();
  });

  it('continues returning 404 for cross-company attendance records without mutating or leaking ownership', async () => {
    const crossCompanyRecord = makeAttendanceRecord({
      id: 'att-p26-company-b',
      companyId: companyB,
      employeeId: 'emp-b-1',
    });
    vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValue(crossCompanyRecord as any);
    const empLookupSpy = vi.spyOn(prisma.employee, 'findFirst');
    const updateSpy = vi.spyOn(prisma.attendance, 'update');

    await expect(
      AttendanceService.updateAttendance(empActor, crossCompanyRecord.id, { notes: 'Cross-tenant' })
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Attendance record not found in this company.',
    });

    await expect(
      AttendanceService.updateAttendance(adminActor, crossCompanyRecord.id, { notes: 'Cross-tenant' })
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Attendance record not found in this company.',
    });

    expect(empLookupSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(AuditService.log).not.toHaveBeenCalled();
  });

  it('preserves existing updateAttendance behavior for ADMIN and SUPER_ADMIN roles', async () => {
    const otherRecord = makeAttendanceRecord({
      id: 'att-p26-admin-edit',
      employeeId: otherEmpId,
    });
    const empLookupSpy = vi.spyOn(prisma.employee, 'findFirst');
    const updateSpy = vi.spyOn(prisma.attendance, 'update');

    for (const privilegedActor of [adminActor, superAdminActor]) {
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(otherRecord as any);
      updateSpy.mockResolvedValueOnce({
        ...otherRecord,
        notes: `Updated by ${privilegedActor.role}`,
      } as any);

      const updated = await AttendanceService.updateAttendance(privilegedActor, otherRecord.id, {
        notes: `Updated by ${privilegedActor.role}`,
      });

      expect(updated.notes).toBe(`Updated by ${privilegedActor.role}`);
    }

    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(empLookupSpy).not.toHaveBeenCalled();
    expect(AuditService.log).toHaveBeenCalledTimes(2);
  });
});

describe('P2-7: AttendanceService.getWorkingHoursSummary Timezone Formatting & Effective-Policy Overnight Fallback', () => {
  const companyId = 'comp-p27-1';
  const employeeId = 'emp-p27-1';

  const empActor: AuthUser = {
    id: 'user-emp-p27',
    userId: 'user-emp-p27',
    companyId,
    email: 'emp.p27@coreerp.local',
    fullName: 'P27 Worker',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const dayShift = {
    id: 'shift-p27-day',
    name: 'Day Shift',
    startTime: '09:00',
    endTime: '17:00',
    isOvernight: false,
  };

  const nightShift = {
    id: 'shift-p27-night',
    name: 'Night Shift',
    startTime: '22:00',
    endTime: '06:00',
    isOvernight: true,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 2026-11-12 04:00:00 UTC -> 09:30 IST (2026-11-12) and 23:00 EST (2026-11-11)
    vi.setSystemTime(new Date('2026-11-12T04:00:00.000Z'));
    vi.spyOn(prisma.employee, 'findFirst').mockResolvedValue({ id: employeeId } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats incomplete check-in status message in Asia/Kolkata company-local time while preserving UTC checkIn timestamp', async () => {
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      employeeCode: 'EMP-IST',
      fullName: 'IST Worker',
      shiftId: dayShift.id,
      shift: dayShift,
      dailyWorkingHours: null,
      monthlyLeaveAllowance: 4,
      company: { timezone: 'Asia/Kolkata' },
    } as any);

    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.attendance, 'findFirst').mockResolvedValueOnce({
      id: 'att-p27-ist',
      companyId,
      employeeId,
      workDate: new Date('2026-11-12T00:00:00.000Z'),
      // 03:30 UTC == 09:00 IST
      checkIn: new Date('2026-11-12T03:30:00.000Z'),
      checkOut: null,
      punchPairsCount: 0,
      hasIncompletePunch: true,
      actualWorkedMinutes: null,
      shift: dayShift,
    } as any);

    const summary = await AttendanceService.getWorkingHoursSummary(empActor);

    expect(summary.status).toBe('INCOMPLETE_ATTENDANCE');
    expect(summary.timezone).toBe('Asia/Kolkata');
    expect(summary.workDate).toBe('2026-11-12');
    expect(summary.checkIn).toBe('2026-11-12T03:30:00.000Z');
    expect(summary.statusMessage).toContain('09:00 IST');
    expect(summary.statusMessage).not.toContain('03:30 UTC');
    expect(summary.requiresAttendanceAction).toBe(true);
  });

  it('formats incomplete check-in status message in America/New_York company-local time while preserving UTC checkIn timestamp', async () => {
    // 2026-11-12 16:00:00 UTC -> 2026-11-12 11:00 EST
    vi.setSystemTime(new Date('2026-11-12T16:00:00.000Z'));

    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      employeeCode: 'EMP-NY',
      fullName: 'NY Worker',
      shiftId: dayShift.id,
      shift: dayShift,
      dailyWorkingHours: null,
      monthlyLeaveAllowance: 4,
      company: { timezone: 'America/New_York' },
    } as any);

    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.attendance, 'findFirst').mockResolvedValueOnce({
      id: 'att-p27-ny',
      companyId,
      employeeId,
      workDate: new Date('2026-11-12T00:00:00.000Z'),
      // 14:00 UTC == 09:00 EST (UTC-5 in November)
      checkIn: new Date('2026-11-12T14:00:00.000Z'),
      checkOut: null,
      punchPairsCount: 0,
      hasIncompletePunch: true,
      actualWorkedMinutes: null,
      shift: dayShift,
    } as any);

    const summary = await AttendanceService.getWorkingHoursSummary(empActor);

    expect(summary.status).toBe('INCOMPLETE_ATTENDANCE');
    expect(summary.timezone).toBe('America/New_York');
    expect(summary.workDate).toBe('2026-11-12');
    expect(summary.checkIn).toBe('2026-11-12T14:00:00.000Z');
    expect(summary.statusMessage).toContain('09:00 EST');
    expect(summary.statusMessage).not.toContain('14:00 UTC');
    expect(summary.requiresAttendanceAction).toBe(true);
  });

  it('applies overnight fallback when current shift is non-overnight but previous-day effective policy revision was overnight', async () => {
    // 2026-11-12 04:00:00 UTC (today = 2026-11-12, yesterday = 2026-11-11 in UTC)
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      employeeCode: 'EMP-SHIFT-TO-DAY',
      fullName: 'Switched To Day Shift Worker',
      // Current employee snapshot is already updated to Day Shift (non-overnight)
      shiftId: dayShift.id,
      shift: dayShift,
      dailyWorkingHours: null,
      monthlyLeaveAllowance: 4,
      company: { timezone: 'UTC' },
    } as any);

    // Effective-dated policy timeline: Night Shift through 2026-11-11, Day Shift starting 2026-11-12
    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue([
      {
        id: 'rev-night',
        companyId,
        employeeId,
        effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
        shiftId: nightShift.id,
        shift: nightShift,
        dailyWorkingHours: null,
        monthlyLeaveAllowance: 4,
      },
      {
        id: 'rev-day',
        companyId,
        employeeId,
        effectiveFrom: new Date('2026-11-12T00:00:00.000Z'),
        shiftId: dayShift.id,
        shift: dayShift,
        dailyWorkingHours: null,
        monthlyLeaveAllowance: 4,
      },
    ]);

    const attFindFirstSpy = vi
      .spyOn(prisma.attendance, 'findFirst')
      // Today (2026-11-12) has no attendance yet
      .mockResolvedValueOnce(null)
      // Yesterday (2026-11-11) has an active overnight check-in at 22:00 UTC
      .mockResolvedValueOnce({
        id: 'att-p27-yesterday-night',
        companyId,
        employeeId,
        workDate: new Date('2026-11-11T00:00:00.000Z'),
        checkIn: new Date('2026-11-11T22:00:00.000Z'),
        checkOut: null,
        punchPairsCount: 0,
        hasIncompletePunch: true,
        actualWorkedMinutes: null,
        shift: nightShift,
      } as any);

    const summary = await AttendanceService.getWorkingHoursSummary(empActor);

    expect(attFindFirstSpy).toHaveBeenCalledTimes(2);
    expect(attFindFirstSpy.mock.calls[1][0]?.where).toMatchObject({
      companyId,
      employeeId,
      workDate: new Date('2026-11-11T00:00:00.000Z'),
      checkIn: { not: null },
    });
    expect(summary.status).toBe('INCOMPLETE_ATTENDANCE');
    expect(summary.shiftId).toBe(nightShift.id);
    expect(summary.shiftName).toBe('Night Shift');
    expect(summary.expectedDurationHours).toBe(8);
    expect(summary.checkIn).toBe('2026-11-11T22:00:00.000Z');
    expect(summary.statusMessage).toContain('22:00 UTC');
  });

  it('does NOT apply overnight fallback when current shift is overnight but previous-day effective policy revision was non-overnight', async () => {
    // Current employee snapshot was switched to Night Shift (overnight) effective 2026-11-12
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      employeeCode: 'EMP-SHIFT-TO-NIGHT',
      fullName: 'Switched To Night Shift Worker',
      shiftId: nightShift.id,
      shift: nightShift,
      dailyWorkingHours: null,
      monthlyLeaveAllowance: 4,
      company: { timezone: 'UTC' },
    } as any);

    // Effective-dated policy timeline: Day Shift on 2026-11-11, Night Shift starting 2026-11-12
    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue([
      {
        id: 'rev-day-prev',
        companyId,
        employeeId,
        effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
        shiftId: dayShift.id,
        shift: dayShift,
        dailyWorkingHours: null,
        monthlyLeaveAllowance: 4,
      },
      {
        id: 'rev-night-today',
        companyId,
        employeeId,
        effectiveFrom: new Date('2026-11-12T00:00:00.000Z'),
        shiftId: nightShift.id,
        shift: nightShift,
        dailyWorkingHours: null,
        monthlyLeaveAllowance: 4,
      },
    ]);

    const attFindFirstSpy = vi
      .spyOn(prisma.attendance, 'findFirst')
      // Today (2026-11-12) has no attendance yet
      .mockResolvedValueOnce(null);

    const summary = await AttendanceService.getWorkingHoursSummary(empActor);

    // Must NOT query yesterday's attendance because yesterday's effective shift was non-overnight
    expect(attFindFirstSpy).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe('MISSING_CHECK_IN');
    expect(summary.shiftId).toBe(nightShift.id);
    expect(summary.shiftName).toBe('Night Shift');
    expect(summary.checkIn).toBeNull();
    expect(summary.requiresAttendanceAction).toBe(true);
  });

  it('retains legacy overnight fallback behavior for employees without any policy revisions', async () => {
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      employeeCode: 'EMP-LEGACY-NIGHT',
      fullName: 'Legacy Night Worker',
      shiftId: nightShift.id,
      shift: nightShift,
      dailyWorkingHours: null,
      monthlyLeaveAllowance: 4,
      company: { timezone: 'Asia/Kolkata' },
    } as any);

    // No revisions stored -> EMPLOYEE_FALLBACK uses employee.shift
    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue([]);

    const attFindFirstSpy = vi
      .spyOn(prisma.attendance, 'findFirst')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'att-p27-legacy-night',
        companyId,
        employeeId,
        workDate: new Date('2026-11-11T00:00:00.000Z'),
        // 16:30 UTC == 22:00 IST
        checkIn: new Date('2026-11-11T16:30:00.000Z'),
        checkOut: null,
        punchPairsCount: 0,
        hasIncompletePunch: true,
        actualWorkedMinutes: null,
        shift: nightShift,
      } as any);

    const summary = await AttendanceService.getWorkingHoursSummary(empActor);

    expect(attFindFirstSpy).toHaveBeenCalledTimes(2);
    expect(summary.status).toBe('INCOMPLETE_ATTENDANCE');
    expect(summary.shiftId).toBe(nightShift.id);
    expect(summary.statusMessage).toContain('22:00 IST');
  });

  it('preserves existing UTC incomplete check-in formatting and multi-pair summary behavior', async () => {
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: employeeId,
      companyId,
      employeeCode: 'EMP-UTC-MULTI',
      fullName: 'UTC Worker',
      shiftId: dayShift.id,
      shift: dayShift,
      dailyWorkingHours: null,
      monthlyLeaveAllowance: 4,
      company: { timezone: 'UTC' },
    } as any);

    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue([]);

    // 1. Single incomplete check-in in UTC preserves exact "HH:mm UTC" output
    vi.spyOn(prisma.attendance, 'findFirst').mockResolvedValueOnce({
      id: 'att-p27-utc-single',
      companyId,
      employeeId,
      workDate: new Date('2026-11-12T00:00:00.000Z'),
      checkIn: new Date('2026-11-12T09:15:00.000Z'),
      checkOut: null,
      punchPairsCount: 0,
      hasIncompletePunch: true,
      actualWorkedMinutes: null,
      shift: dayShift,
    } as any);

    const utcSingleSummary = await AttendanceService.getWorkingHoursSummary(empActor);
    expect(utcSingleSummary.status).toBe('INCOMPLETE_ATTENDANCE');
    expect(utcSingleSummary.statusMessage).toContain('09:15 UTC');
    expect(utcSingleSummary.checkIn).toBe('2026-11-12T09:15:00.000Z');

    // 2. Multi-pair record with an open trailing punch preserves paired session summary
    vi.spyOn(prisma.attendance, 'findFirst').mockResolvedValueOnce({
      id: 'att-p27-utc-multi',
      companyId,
      employeeId,
      workDate: new Date('2026-11-12T00:00:00.000Z'),
      checkIn: new Date('2026-11-12T09:00:00.000Z'),
      checkOut: new Date('2026-11-12T17:00:00.000Z'),
      punchPairsCount: 2,
      hasIncompletePunch: true,
      actualWorkedMinutes: 420,
      shift: dayShift,
    } as any);

    const multiPairSummary = await AttendanceService.getWorkingHoursSummary(empActor);
    expect(multiPairSummary.status).toBe('INCOMPLETE_ATTENDANCE');
    expect(multiPairSummary.punchPairsCount).toBe(2);
    expect(multiPairSummary.actualWorkedMinutes).toBe(420);
    expect(multiPairSummary.workedDurationHours).toBe(7);
    expect(multiPairSummary.hasIncompletePunch).toBe(true);
    expect(multiPairSummary.statusMessage).toContain('incomplete punch sequence');
    expect(multiPairSummary.statusMessage).toContain('7h completed in paired sessions');
  });
});



