import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaveService } from '../../src/server/services/leave.service.js';
import { EmployeeService, calculateShiftDurationHours } from '../../src/server/services/employee.service.js';
import { PayrollCalculationService } from '../../src/server/services/payroll-calculation.service.js';
import { prisma } from '../../src/server/db/client.js';
import { AuthUser } from '../../src/shared/types.ts';

vi.mock('../../src/server/db/client.js', () => {
  return {
    prisma: {
      employee: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      leaveType: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      leaveRequest: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      attendance: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      shift: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
    },
  };
});

describe('Employee Self-Service (ESS) & Monthly Leave Aggregation Tests', () => {
  const companyId = 'company-test-uuid';

  const employeeUser: AuthUser = {
    id: 'user-emp-01',
    userId: 'user-emp-01',
    companyId,
    email: 'employee@test.local',
    fullName: 'Jane Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const adminUser: AuthUser = {
    id: 'user-admin-01',
    userId: 'user-admin-01',
    companyId,
    email: 'admin@test.local',
    fullName: 'Admin User',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.attendance.findMany).mockResolvedValue([]);
  });

  it('Monthly summary correctly clips date ranges spanning calendar month boundaries without double counting', async () => {
    // Mock employee resolution
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
    } as any);

    // Mock leave types: Annual (14 days), Sick (7 days)
    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([
      {
        id: 'lt-annual',
        companyId,
        code: 'AL',
        name: 'Annual Leave',
        isPaid: true,
        defaultAllowance: 14,
        isActive: true,
      },
      {
        id: 'lt-sick',
        companyId,
        code: 'SL',
        name: 'Sick Leave',
        isPaid: true,
        defaultAllowance: 7,
        isActive: true,
      },
    ] as any);

    // Leave request spanning from Jan 30 to Feb 02 (4 days total)
    // In Jan 2026: Jan 30, Jan 31 = 2 days
    // In Feb 2026: Feb 01, Feb 02 = 2 days
    const crossMonthRequest = {
      id: 'req-cross',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-annual',
      startDate: new Date('2026-01-30T00:00:00.000Z'),
      endDate: new Date('2026-02-02T23:59:59.999Z'),
      totalDays: 4,
      reason: 'Long weekend vacation',
      status: 'APPROVED',
    };

    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([crossMonthRequest] as any);

    // 1. Check January calculation
    const janSummary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 1,
    });

    expect(janSummary.year).toBe(2026);
    expect(janSummary.month).toBe(1);
    expect(janSummary.approvedDays).toBe(2); // Only Jan 30 & Jan 31
    expect(janSummary.approvedCount).toBe(1);
    expect(janSummary.totalAnnualEntitlement).toBe(21); // 14 + 7
    expect(janSummary.annualUsedDays).toBe(4); // 4 days in 2026 total
    expect(janSummary.annualRemainingBalance).toBe(17); // 21 - 4
    expect(janSummary.excessLeaveDays).toBe(0);

    // Verify type breakdown
    const annualType = janSummary.byType.find((t) => t.leaveTypeCode === 'AL');
    expect(annualType).toBeDefined();
    expect(annualType?.monthApprovedDays).toBe(2);
    expect(annualType?.annualUsedDays).toBe(4);
    expect(annualType?.annualRemainingDays).toBe(10); // 14 - 4

    // 2. Check February calculation
    const febSummary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 2,
    });

    expect(febSummary.month).toBe(2);
    expect(febSummary.approvedDays).toBe(2); // Only Feb 01 & Feb 02
  });

  it('Pending and rejected leave requests do not affect used entitlement or remaining balance', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([
      {
        id: 'lt-casual',
        companyId,
        code: 'CL',
        name: 'Casual Leave',
        isPaid: true,
        defaultAllowance: 5,
        isActive: true,
      },
    ] as any);

    const pendingRequest = {
      id: 'req-pending',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-casual',
      startDate: new Date('2026-03-10T00:00:00.000Z'),
      endDate: new Date('2026-03-12T23:59:59.999Z'),
      totalDays: 3,
      reason: 'Personal errand',
      status: 'PENDING',
    };

    const rejectedRequest = {
      id: 'req-rejected',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-casual',
      startDate: new Date('2026-03-20T00:00:00.000Z'),
      endDate: new Date('2026-03-21T23:59:59.999Z'),
      totalDays: 2,
      reason: 'Unplanned absence',
      status: 'REJECTED',
    };

    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([pendingRequest, rejectedRequest] as any);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 3,
    });

    expect(summary.totalRequestedDays).toBe(5); // 3 + 2
    expect(summary.approvedDays).toBe(0);
    expect(summary.pendingDays).toBe(3);
    expect(summary.pendingCount).toBe(1);
    expect(summary.rejectedDays).toBe(2);
    expect(summary.rejectedCount).toBe(1);

    // CRITICAL: Annual used days MUST BE ZERO because none are approved
    expect(summary.annualUsedDays).toBe(0);
    expect(summary.annualRemainingBalance).toBe(5); // full 5 days remain
    expect(summary.excessLeaveDays).toBe(0);
  });

  it('Calculates excess leave days when approved leave exceeds annual entitlement', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([
      {
        id: 'lt-sick',
        companyId,
        code: 'SL',
        name: 'Sick Leave',
        isPaid: true,
        defaultAllowance: 5,
        isActive: true,
      },
    ] as any);

    // Approved request of 8 days (exceeds 5 days allowance by 3 days)
    const heavySickLeave = {
      id: 'req-heavy',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-sick',
      startDate: new Date('2026-04-01T00:00:00.000Z'),
      endDate: new Date('2026-04-08T23:59:59.999Z'),
      totalDays: 8,
      reason: 'Hospital surgery recovery',
      status: 'APPROVED',
    };

    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([heavySickLeave] as any);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 4,
    });

    expect(summary.totalAnnualEntitlement).toBe(5);
    expect(summary.annualUsedDays).toBe(8);
    expect(summary.annualRemainingBalance).toBe(0);
    expect(summary.excessLeaveDays).toBe(3); // 8 - 5 = 3 excess days (subject to LOP)
  });

  it('Enforces employee self-service isolation: employees cannot query another employee summary', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01-self',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01-self',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([]);
    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([]);

    // Employee passes malicious employeeId 'emp-999-other'
    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      employeeId: 'emp-999-other',
      year: 2026,
      month: 1,
    });

    // Must be bound to emp-01-self, ignoring the requested foreign ID
    expect(summary.employeeId).toBe('emp-01-self');
    expect(prisma.employee.findUnique).toHaveBeenCalledWith({
      where: { id: 'emp-01-self' },
      select: expect.any(Object),
    });
  });

  it('Prevents employee role from approving or rejecting leave requests', async () => {
    await expect(
      LeaveService.reviewLeaveRequest(employeeUser, 'req-any', 'APPROVE')
    ).rejects.toThrow('Employees are not authorized to review leave requests.');

    await expect(
      LeaveService.reviewLeaveRequest(employeeUser, 'req-any', 'REJECT', 'Reason')
    ).rejects.toThrow('Employees are not authorized to review leave requests.');
  });

  it('Approved half-day (0.5 day) leave correctly counts as 0.5 days in monthly summary and annual used days', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([
      {
        id: 'lt-casual',
        companyId,
        code: 'CL',
        name: 'Casual Leave',
        isPaid: true,
        defaultAllowance: 10,
        isActive: true,
      },
    ] as any);

    const halfDayRequest = {
      id: 'req-half-day',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-casual',
      startDate: new Date('2026-05-15T00:00:00.000Z'),
      endDate: new Date('2026-05-15T23:59:59.999Z'),
      totalDays: 0.5,
      reason: 'Doctor appointment morning half-day',
      status: 'APPROVED',
    };

    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([halfDayRequest] as any);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 5,
    });

    expect(summary.totalRequestedDays).toBe(0.5);
    expect(summary.approvedDays).toBe(0.5); // Must be 0.5, NOT 1.0
    expect(summary.approvedCount).toBe(1);
    expect(summary.annualUsedDays).toBe(0.5);
    expect(summary.annualRemainingBalance).toBe(9.5); // 10 - 0.5
    expect(summary.excessLeaveDays).toBe(0);
    expect(summary.overlappingApprovedDays).toBe(0);

    const casualType = summary.byType.find((t) => t.leaveTypeCode === 'CL');
    expect(casualType?.monthApprovedDays).toBe(0.5);
    expect(casualType?.annualUsedDays).toBe(0.5);
    expect(casualType?.annualRemainingDays).toBe(9.5);
  });

  it('Overlapping approved leave requests are de-duplicated and do not double-count in summary or annual used days', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([
      {
        id: 'lt-annual',
        companyId,
        code: 'AL',
        name: 'Annual Leave',
        isPaid: true,
        defaultAllowance: 15,
        isActive: true,
      },
      {
        id: 'lt-sick',
        companyId,
        code: 'SL',
        name: 'Sick Leave',
        isPaid: true,
        defaultAllowance: 10,
        isActive: true,
      },
    ] as any);

    // Request 1: Oct 10 to Oct 12 (3 days: Oct 10, Oct 11, Oct 12)
    const request1 = {
      id: 'req-oct-1',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-annual',
      startDate: new Date('2026-10-10T00:00:00.000Z'),
      endDate: new Date('2026-10-12T23:59:59.999Z'),
      totalDays: 3,
      reason: 'Scheduled vacation',
      status: 'APPROVED',
    };

    // Request 2: Oct 11 to Oct 13 (3 days: Oct 11, Oct 12, Oct 13)
    // Overlaps on Oct 11 and Oct 12 (2 overlapping days)
    const request2 = {
      id: 'req-oct-2',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-sick',
      startDate: new Date('2026-10-11T00:00:00.000Z'),
      endDate: new Date('2026-10-13T23:59:59.999Z'),
      totalDays: 3,
      reason: 'Emergency hospital visit',
      status: 'APPROVED',
    };

    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([request1, request2] as any);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 10,
    });

    // Oct 10 (1 day), Oct 11 (1 day), Oct 12 (1 day), Oct 13 (1 day) = exactly 4 unique days
    // Without de-duplication it would have incorrectly computed 3 + 3 = 6 days.
    expect(summary.approvedDays).toBe(4);
    expect(summary.annualUsedDays).toBe(4);
    expect(summary.totalAnnualEntitlement).toBe(25); // 15 + 10
    expect(summary.annualRemainingBalance).toBe(21); // 25 - 4
    expect(summary.overlappingApprovedDays).toBe(2); // 2 days overlap identified
    expect(summary.warnings).toBeDefined();
    expect(summary.warnings?.length).toBeGreaterThan(0);
    expect(summary.warnings?.some((w) => w.includes('overlapping approved leave day(s)'))).toBe(true);

    // Sum across byType must equal the deduplicated approved total
    const sumByTypeApproved = summary.byType.reduce((acc, t) => acc + t.monthApprovedDays, 0);
    expect(sumByTypeApproved).toBe(4);
  });

  it('Two approved half-day requests on the same day cleanly combine into 1.0 day without triggering false overlap', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([
      {
        id: 'lt-casual',
        companyId,
        code: 'CL',
        name: 'Casual Leave',
        isPaid: true,
        defaultAllowance: 10,
        isActive: true,
      },
    ] as any);

    const morningHalf = {
      id: 'req-morning',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-casual',
      startDate: new Date('2026-06-01T00:00:00.000Z'),
      endDate: new Date('2026-06-01T23:59:59.999Z'),
      totalDays: 0.5,
      reason: 'Morning personal errand',
      status: 'APPROVED',
    };

    const afternoonHalf = {
      id: 'req-afternoon',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-casual',
      startDate: new Date('2026-06-01T00:00:00.000Z'),
      endDate: new Date('2026-06-01T23:59:59.999Z'),
      totalDays: 0.5,
      reason: 'Afternoon family matter',
      status: 'APPROVED',
    };

    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([morningHalf, afternoonHalf] as any);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 6,
    });

    expect(summary.approvedDays).toBe(1);
    expect(summary.annualUsedDays).toBe(1);
    expect(summary.overlappingApprovedDays).toBe(0); // Valid combination of two 0.5-day leaves on 1 day
    expect(summary.annualRemainingBalance).toBe(9);
  });

  it('Calculates rates and excess leave deduction for 7.5-hour shift and 4-day monthly allowance', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
      shiftId: 'shift-7-5',
      shift: {
        id: 'shift-7-5',
        name: 'Flexible Shift',
        code: 'FLEX-7.5',
        startTime: '09:00',
        endTime: '16:30', // 7.5 hours
        isOvernight: false,
      },
      salaryRevisions: [
        { fixedSalary: '6000.00' }, // Monthly salary $6000
      ],
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([
      {
        id: 'lt-annual',
        companyId,
        code: 'AL',
        name: 'Annual Leave',
        isPaid: true,
        defaultAllowance: 15,
        isActive: true,
      },
    ] as any);

    // 4.5 days approved leave in July 2026 (exceeds 4-day monthly allowance by 0.5 days)
    const approvedLeave = {
      id: 'req-july',
      companyId,
      employeeId: 'emp-01',
      leaveTypeId: 'lt-annual',
      startDate: new Date('2026-07-01T00:00:00.000Z'),
      endDate: new Date('2026-07-05T23:59:59.999Z'),
      totalDays: 4.5,
      status: 'APPROVED',
    };

    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([approvedLeave] as any);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 7,
    });

    expect(summary.configuredDailyWorkingHours).toBe(7.5);
    expect(summary.shiftSchedule).toContain('Flexible Shift (09:00 – 16:30)');
    expect(summary.monthlyLeaveAllowance).toBe(4);
    expect(summary.monthApprovedDays).toBe(4.5);
    expect(summary.monthRemainingLeave).toBe(0);
    expect(summary.monthlyExcessLeaveDays).toBe(0.5); // 4.5 - 4.0 = 0.5 days

    // Daily salary rate = 6000 / 30 = 200.00
    expect(summary.dailySalaryRate).toBe('200.00');

    // Hourly salary rate = 200 / 7.5 = 26.6667 -> 26.67
    expect(summary.hourlySalaryRate).toBe('26.67');

    // Excess leave deduction = 0.5 * 200.00 = 100.00
    expect(summary.excessLeaveDeduction).toBe('100.00');
    expect(summary.totalSalaryDeductions).toBe('100.00');
  });

  it('Supports fractional working hours (6h, 7.5h, 8h, 9h) and overnight shifts', () => {
    // 6.0 hours: 10:00 to 16:00
    expect(calculateShiftDurationHours({ startTime: '10:00', endTime: '16:00', isOvernight: false })).toBe(6);

    // 7.5 hours: 09:00 to 16:30
    expect(calculateShiftDurationHours({ startTime: '09:00', endTime: '16:30', isOvernight: false })).toBe(7.5);

    // 8.0 hours: 09:00 to 17:00
    expect(calculateShiftDurationHours({ startTime: '09:00', endTime: '17:00', isOvernight: false })).toBe(8);

    // 9.0 hours: 09:00 to 18:00
    expect(calculateShiftDurationHours({ startTime: '09:00', endTime: '18:00', isOvernight: false })).toBe(9);

    // Overnight 8.0 hours: 22:00 to 06:00
    expect(calculateShiftDurationHours({ startTime: '22:00', endTime: '06:00', isOvernight: true })).toBe(8);

    // Overnight 7.5 hours: 22:00 to 05:30
    expect(calculateShiftDurationHours({ startTime: '22:00', endTime: '05:30', isOvernight: true })).toBe(7.5);
  });

  it('Calculates short hours deduction accurately against assigned shift', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
      shiftId: 'shift-8h',
      shift: {
        id: 'shift-8h',
        name: 'Standard 8h Shift',
        code: 'STD-8',
        startTime: '09:00',
        endTime: '17:00', // 8.0 hours
        isOvernight: false,
      },
      salaryRevisions: [{ fixedSalary: '4800.00' }], // Daily rate = 4800 / 30 = 160.00; Hourly rate = 160 / 8 = 20.00
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([]);
    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([]);

    // Attendance record: Worked 6.0 hours (09:00 to 15:00) instead of 8.0 hours -> 2.0 short hours
    vi.mocked(prisma.attendance.findMany).mockResolvedValue([
      {
        id: 'att-1',
        workDate: new Date('2026-08-10T00:00:00.000Z'),
        checkIn: new Date('2026-08-10T09:00:00.000Z'),
        checkOut: new Date('2026-08-10T15:00:00.000Z'), // 6 hours worked
        status: 'PRESENT',
      },
    ] as any);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 8,
    });

    expect(summary.configuredDailyWorkingHours).toBe(8);
    expect(summary.dailySalaryRate).toBe('160.00');
    expect(summary.hourlySalaryRate).toBe('20.00');
    expect(summary.deductibleShortHours).toBe(2);
    expect(summary.shortHoursDeduction).toBe('40.00'); // 2 hrs * $20.00/hr = $40.00
    expect(summary.totalSalaryDeductions).toBe('40.00');
  });

  it('Withholds automatic deduction for missing check-out records and flags for review', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
      shiftId: 'shift-8h',
      shift: {
        id: 'shift-8h',
        name: 'Standard 8h Shift',
        code: 'STD-8',
        startTime: '09:00',
        endTime: '17:00',
        isOvernight: false,
      },
      salaryRevisions: [{ fixedSalary: '4800.00' }],
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([]);
    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([]);

    // Incomplete attendance record (checked in at 09:00, checkOut is null)
    vi.mocked(prisma.attendance.findMany).mockResolvedValue([
      {
        id: 'att-missing-out',
        workDate: new Date('2026-08-12T00:00:00.000Z'),
        checkIn: new Date('2026-08-12T09:00:00.000Z'),
        checkOut: null,
        status: 'PRESENT',
      },
    ] as any);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 8,
    });

    expect(summary.incompleteAttendanceCount).toBe(1);
    expect(summary.deductibleShortHours).toBe(0);
    expect(summary.shortHoursDeduction).toBe('0.00'); // ZERO automatic deduction
    expect(summary.warnings).toBeDefined();
    expect(summary.warnings?.some((w) => w.includes('incomplete attendance record(s)'))).toBe(true);
  });

  it('Prevents duplicate deductions on days marked ABSENT, HALF_DAY, or on excess leave', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
      shiftId: 'shift-8h',
      shift: {
        id: 'shift-8h',
        name: 'Standard 8h Shift',
        code: 'STD-8',
        startTime: '09:00',
        endTime: '17:00',
        isOvernight: false,
      },
      salaryRevisions: [{ fixedSalary: '4800.00' }],
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([]);
    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([]);

    // Attendance records with ABSENT and HALF_DAY status
    vi.mocked(prisma.attendance.findMany).mockResolvedValue([
      {
        id: 'att-absent',
        workDate: new Date('2026-08-15T00:00:00.000Z'),
        checkIn: null,
        checkOut: null,
        status: 'ABSENT', // Already full-day loss of pay
      },
      {
        id: 'att-half',
        workDate: new Date('2026-08-16T00:00:00.000Z'),
        checkIn: new Date('2026-08-16T09:00:00.000Z'),
        checkOut: new Date('2026-08-16T13:00:00.000Z'),
        status: 'HALF_DAY', // Already 0.5 day loss of pay
      },
    ] as any);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 8,
    });

    // Both dates must NOT produce short-hours deductions (preventing double-dipping)
    expect(summary.deductibleShortHours).toBe(0);
    expect(summary.shortHoursDeduction).toBe('0.00');
  });

  it('Sets configuredDailyWorkingHours to unavailable and skips deductions if no shift is assigned', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
      fullName: 'Jane Employee',
      employeeCode: 'EMP-001',
      shiftId: null, // NO SHIFT
      shift: null,
      salaryRevisions: [{ fixedSalary: '4800.00' }],
    } as any);

    vi.mocked(prisma.leaveType.findMany).mockResolvedValue([]);
    vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([]);

    const summary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
      year: 2026,
      month: 8,
    });

    expect(summary.configuredDailyWorkingHours).toBeNull();
    expect(summary.hourlySalaryRate).toBeNull();
    expect(summary.shortHoursDeduction).toBe('0.00');
    expect(summary.warnings).toBeDefined();
    expect(summary.warnings?.some((w) => w.includes('No assigned working schedule/shift found'))).toBe(true);
  });

  it('Prevents employee role from updating official working schedule or employee settings', async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      id: 'emp-01',
      companyId,
    } as any);

    await expect(
      EmployeeService.updateEmployee(employeeUser, 'emp-01', { shiftId: 'shift-new' })
    ).rejects.toThrow('Employees are not authorized to update official employee records or working schedules.');
  });

  describe('Stage 1.3: Authoritative Payroll Reconciliation & 30-Day Divisor Tests', () => {
    it('Enforces approved corporate 30-day divisor regardless of calendar days in month (31d, 28d, 30d)', () => {
      const basicSalary = '3000.0000'; // $3,000 / 30 = $100.00/day

      // Test across October (31 days), February (28 days), and April (30 days)
      const octResult = PayrollCalculationService.calculatePayslip({
        basicSalary,
        calendarDays: 31,
        unpaidDays: 2,
      });
      expect(octResult.lossOfPayDeduction.toString()).toBe('200'); // 2 days * $100 = $200 (not 2 * 3000/31)

      const febResult = PayrollCalculationService.calculatePayslip({
        basicSalary,
        calendarDays: 28,
        unpaidDays: 2,
      });
      expect(febResult.lossOfPayDeduction.toString()).toBe('200'); // 2 days * $100 = $200 (not 2 * 3000/28)

      const aprResult = PayrollCalculationService.calculatePayslip({
        basicSalary,
        calendarDays: 30,
        unpaidDays: 2,
      });
      expect(aprResult.lossOfPayDeduction.toString()).toBe('200');
    });

    it('ESS breakdown and authoritative payslip calculation agree exactly for the same period', async () => {
      // Setup employee with 8-hour shift and $4,800 monthly salary
      // Daily rate: $4,800 / 30 = $160.00
      // Hourly rate: $160 / 8h = $20.00/hr
      const shift8h = {
        id: 'shift-01',
        name: 'Standard Shift',
        startTime: '09:00',
        endTime: '17:00',
        isOvernight: false,
      };

      vi.mocked(prisma.employee.findFirst).mockResolvedValue({
        id: 'emp-01',
        companyId,
      } as any);

      vi.mocked(prisma.employee.findUnique).mockResolvedValue({
        id: 'emp-01',
        companyId,
        fullName: 'Jane Employee',
        employeeCode: 'EMP-001',
        shiftId: 'shift-01',
        shift: shift8h,
        salaryRevisions: [{ fixedSalary: '4800.00' }],
      } as any);

      vi.mocked(prisma.leaveType.findMany).mockResolvedValue([
        { id: 'lt-paid', companyId, code: 'AL', name: 'Annual Leave', isPaid: true, defaultAllowance: 12, isActive: true },
      ] as any);

      // Approved 6 days of leave in October (4 days allowance -> 2 excess leave days)
      // Excess leave deduction: 2 days * $160 = $320.00
      vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([
        {
          id: 'req-01',
          companyId,
          employeeId: 'emp-01',
          leaveTypeId: 'lt-paid',
          startDate: new Date('2026-10-01T00:00:00.000Z'),
          endDate: new Date('2026-10-06T23:59:59.999Z'),
          totalDays: 6,
          status: 'APPROVED',
        },
      ] as any);

      // 1 day with 2 hours short (09:00 - 15:00 instead of 17:00)
      // Short hours deduction: 2h * $20/hr = $40.00
      const attendanceShort = {
        id: 'att-short-01',
        companyId,
        employeeId: 'emp-01',
        workDate: new Date('2026-10-15T00:00:00.000Z'),
        checkIn: new Date('2026-10-15T09:00:00.000Z'),
        checkOut: new Date('2026-10-15T15:00:00.000Z'), // 6h worked vs 8h shift
        status: 'PRESENT',
        shift: shift8h,
      };

      vi.mocked(prisma.attendance.findMany).mockResolvedValue([attendanceShort] as any);

      // 1. Calculate ESS breakdown
      const essSummary = await LeaveService.getMonthlyLeaveSummary(employeeUser, {
        year: 2026,
        month: 10,
      });

      expect(essSummary.monthlySalary).toBe('4800.00');
      expect(essSummary.dailySalaryRate).toBe('160.00');
      expect(essSummary.hourlySalaryRate).toBe('20.00');
      expect(essSummary.monthlyLeaveAllowance).toBe(4);
      expect(essSummary.monthApprovedDays).toBe(6);
      expect(essSummary.monthlyExcessLeaveDays).toBe(2);
      expect(essSummary.excessLeaveDeduction).toBe('320.00');
      expect(essSummary.deductibleShortHours).toBe(2);
      expect(essSummary.shortHoursDeduction).toBe('40.00');
      expect(essSummary.totalSalaryDeductions).toBe('360.00'); // $320 + $40 = $360

      // 2. Calculate Authoritative Payslip using the reconciled figures
      const payslipCalc = PayrollCalculationService.calculatePayslip({
        basicSalary: '4800.0000',
        allowances: '200.0000',
        overtimePay: '0.0000',
        lossOfPayDeduction: essSummary.totalSalaryDeductions,
        excessLeaveDeduction: essSummary.excessLeaveDeduction,
        shortHoursDeduction: essSummary.shortHoursDeduction,
      });

      // 3. Verify exact agreement
      expect(payslipCalc.formatted.basicSalary).toBe('4800.0000');
      expect(payslipCalc.formatted.grossSalary).toBe('5000.0000'); // 4800 + 200
      expect(payslipCalc.formatted.lossOfPayDeduction).toBe('360.0000');
      expect(payslipCalc.formatted.deductions).toBe('360.0000');
      expect(payslipCalc.formatted.netSalary).toBe('4640.0000'); // 5000 - 360

      // Reconciled ESS totalSalaryDeductions matches Payslip lossOfPayDeduction
      expect(parseFloat(essSummary.totalSalaryDeductions)).toBe(payslipCalc.lossOfPayDeduction.toNumber());
      expect(parseFloat(essSummary.excessLeaveDeduction) + parseFloat(essSummary.shortHoursDeduction))
        .toBe(payslipCalc.lossOfPayDeduction.toNumber());
    });
  });
});
