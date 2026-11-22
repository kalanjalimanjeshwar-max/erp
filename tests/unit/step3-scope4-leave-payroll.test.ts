import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Request, Response } from 'express';

// Mock Prisma before importing server controllers/services
vi.mock('../../src/server/db/client.js', () => ({
  prisma: {
    employee: {
      findFirst: vi.fn(),
    },
    payrollPeriod: {
      findUnique: vi.fn(),
    },
    payslip: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/server/db/client.js';
import { LeaveController } from '../../src/server/controllers/leave.controller.js';
import { LeaveService } from '../../src/server/services/leave.service.js';
import {
  PayrollService,
  parsePayslipReconciliationBreakdown,
} from '../../src/server/services/payroll.service.js';
import { LeaveMonthlySummaryInspectorPanel } from '../../src/client/pages/LeavePage.tsx';
import {
  PayslipDetailModalContent,
  computePayslipDeductionSummary,
} from '../../src/client/pages/PayrollPage.tsx';
import {
  EssMonthlyWorkingHoursSummaryCard,
  EssPayslipVoucherContent,
  computeEssPayslipDeductionSummary,
} from '../../src/client/pages/EmployeeSelfServicePage.tsx';
import type { AuthUser, MonthlyLeaveSummary, PayslipItem } from '../../src/shared/types.ts';

function createMockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  });
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res as Response;
  });
  return res as Response & { statusCode?: number; body?: unknown };
}

const adminActor: AuthUser = {
  id: 'usr-admin-1',
  userId: 'usr-admin-1',
  email: 'admin@acme.test',
  fullName: 'Acme Admin',
  role: 'ADMIN',
  companyId: 'comp-1',
  isActive: true,
  tokenVersion: 1,
};

const employeeActor: AuthUser = {
  id: 'usr-emp-1',
  userId: 'usr-emp-1',
  email: 'jane@acme.test',
  fullName: 'Jane Worker',
  role: 'EMPLOYEE',
  companyId: 'comp-1',
  isActive: true,
  tokenVersion: 1,
};

const sampleMonthlySummary: MonthlyLeaveSummary = {
  employeeId: 'emp-1',
  employeeName: 'Jane Worker',
  employeeCode: 'EMP-001',
  year: 2026,
  month: 5,
  totalRequestedDays: 6,
  approvedDays: 5,
  pendingDays: 1,
  rejectedDays: 0,
  approvedCount: 2,
  pendingCount: 1,
  rejectedCount: 0,
  totalAnnualEntitlement: 24,
  annualUsedDays: 5,
  annualRemainingBalance: 19,
  excessLeaveDays: 0,
  configuredDailyWorkingHours: 8,
  shiftSchedule: 'Day Shift (09:00 - 17:00)',
  monthlyLeaveAllowance: 4,
  monthApprovedDays: 5,
  monthRemainingLeave: 0,
  monthlyExcessLeaveDays: 1,
  deductibleShortHours: 2.25,
  shortTimeMinutes: 135,
  extraTimeMinutes: 90,
  shortTimeHours: 2.25,
  extraTimeHours: 1.5,
  totalRequiredMinutes: 9600,
  totalActualWorkedMinutes: 9555,
  incompleteAttendanceCount: 1,
  monthlySalary: '3000.00',
  dailySalaryRate: '100.00',
  hourlySalaryRate: '12.50',
  excessLeaveDeduction: '100.00',
  shortHoursDeduction: '28.13',
  totalSalaryDeductions: '128.13',
  warnings: [
    'Detected 1 incomplete attendance record(s) with missing check-out punches. In accordance with company policy, automatic short-hours deduction was withheld pending administrative review.',
  ],
  byType: [],
};

const sampleNotesWithWarning =
  'Reconciled: Excess Leave -USD 100.00 (Allowance 4d), Short Hours -USD 28.13 (2.25h short, 1.5h extra informational only). Detected 1 incomplete attendance record(s) with missing check-out punches. In accordance with company policy, automatic short-hours deduction was withheld pending administrative review.';

const samplePayslipItem: PayslipItem = {
  id: 'ps-1',
  companyId: 'comp-1',
  payrollPeriodId: 'pp-1',
  payrollPeriodName: 'May 2026 Regular Cycle',
  payrollPeriodMonth: 5,
  payrollPeriodYear: 2026,
  employeeId: 'emp-1',
  employeeCode: 'EMP-001',
  employeeName: 'Jane Worker',
  basicSalary: '3000.00',
  allowances: '200.00',
  overtimePay: '0.00',
  grossSalary: '3200.00',
  deductions: '178.13', // Includes 128.13 LOP + 50.00 Other Deductions
  lossOfPayDeduction: '128.13',
  netSalary: '3021.87',
  status: 'PAID',
  paymentMethod: 'BANK_TRANSFER',
  paymentDate: '2026-05-31',
  ledgerId: 'led-1',
  ledgerName: 'Salaries Payable - Jane',
  journalEntryId: 'je-1',
  journalVoucherNumber: 'JV-2026-0055',
  notes: sampleNotesWithWarning,
  reconciliationBreakdown: parsePayslipReconciliationBreakdown(sampleNotesWithWarning),
  createdAt: '2026-05-31T00:00:00.000Z',
  updatedAt: '2026-05-31T00:00:00.000Z',
};

describe('Step 3 Scope 4: LeaveController.getSummary validation & RBAC', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('rejects invalid year query parameters with HTTP 400', async () => {
    const spy = vi.spyOn(LeaveService, 'getMonthlyLeaveSummary');
    for (const badYear of ['1999', '2101', '2026abc', '2026.5', '']) {
      const req = { user: adminActor, query: { year: badYear, month: '5' } } as unknown as Request;
      const res = createMockRes();
      await LeaveController.getSummary(req, res);
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects invalid month query parameters with HTTP 400', async () => {
    const spy = vi.spyOn(LeaveService, 'getMonthlyLeaveSummary');
    for (const badMonth of ['0', '13', 'abc', '5.5', '']) {
      const req = { user: adminActor, query: { year: '2026', month: badMonth } } as unknown as Request;
      const res = createMockRes();
      await LeaveController.getSummary(req, res);
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects blank employeeId query parameter with HTTP 400', async () => {
    const spy = vi.spyOn(LeaveService, 'getMonthlyLeaveSummary');
    const req = { user: adminActor, query: { year: '2026', month: '5', employeeId: '   ' } } as unknown as Request;
    const res = createMockRes();
    await LeaveController.getSummary(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks EMPLOYEE from inspecting another employee leave summary with HTTP 403', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({ id: 'emp-1' } as any);
    const spy = vi.spyOn(LeaveService, 'getMonthlyLeaveSummary');

    const req = {
      user: employeeActor,
      query: { year: '2026', month: '5', employeeId: 'emp-other-999' },
    } as unknown as Request;
    const res = createMockRes();

    await LeaveController.getSummary(req, res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows EMPLOYEE to inspect their own leave summary (without employeeId or with own employeeId)', async () => {
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({ id: 'emp-1' } as any);
    const spy = vi.spyOn(LeaveService, 'getMonthlyLeaveSummary').mockResolvedValue(sampleMonthlySummary);

    // 1. Omitted employeeId
    const reqSelf = { user: employeeActor, query: { year: '2026', month: '5' } } as unknown as Request;
    const resSelf = createMockRes();
    await LeaveController.getSummary(reqSelf, resSelf);
    expect(resSelf.body).toEqual(sampleMonthlySummary);
    expect(spy).toHaveBeenCalledWith(employeeActor, { employeeId: undefined, year: 2026, month: 5 });

    // 2. Own employeeId explicitly passed
    const reqOwn = {
      user: employeeActor,
      query: { year: '2026', month: '5', employeeId: 'emp-1' },
    } as unknown as Request;
    const resOwn = createMockRes();
    await LeaveController.getSummary(reqOwn, resOwn);
    expect(resOwn.body).toEqual(sampleMonthlySummary);
  });

  it('allows ADMIN/MANAGER to inspect a selected employee summary with validated params', async () => {
    const spy = vi.spyOn(LeaveService, 'getMonthlyLeaveSummary').mockResolvedValue(sampleMonthlySummary);

    const req = {
      user: adminActor,
      query: { year: '2026', month: '5', employeeId: 'emp-1' },
    } as unknown as Request;
    const res = createMockRes();

    await LeaveController.getSummary(req, res);

    expect(spy).toHaveBeenCalledWith(adminActor, {
      employeeId: 'emp-1',
      year: 2026,
      month: 5,
    });
    expect(res.body).toEqual(sampleMonthlySummary);
  });
});

describe('Step 3 Scope 4: Payslip reconciliationBreakdown parsing & PayrollService mappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses reconciled payslip.notes with allowance, short/extra hours, deductions, and warnings', () => {
    const parsed = parsePayslipReconciliationBreakdown(sampleNotesWithWarning);
    expect(parsed).toEqual({
      currency: 'USD',
      monthlyLeaveAllowance: 4,
      excessLeaveDeduction: '100.00',
      shortHoursDeduction: '28.13',
      shortTimeHours: 2.25,
      extraTimeHours: 1.5,
      extraTimeInformationalOnly: true,
      warnings: [
        'Detected 1 incomplete attendance record(s) with missing check-out punches. In accordance with company policy, automatic short-hours deduction was withheld pending administrative review.',
      ],
    });
  });

  it('parses reconciled notes without warnings and legacy reconciled format cleanly', () => {
    const clean = parsePayslipReconciliationBreakdown(
      'Reconciled: Excess Leave -INR 0.00 (Allowance 6d), Short Hours -INR 120.50 (3h short, 0h extra informational only).'
    );
    expect(clean).toEqual({
      currency: 'INR',
      monthlyLeaveAllowance: 6,
      excessLeaveDeduction: '0.00',
      shortHoursDeduction: '120.50',
      shortTimeHours: 3,
      extraTimeHours: 0,
      extraTimeInformationalOnly: true,
      warnings: [],
    });

    const legacy = parsePayslipReconciliationBreakdown(
      'Reconciled: Excess Leave -USD 50.00, Short Hours -USD 15.00.'
    );
    expect(legacy).toEqual({
      currency: 'USD',
      monthlyLeaveAllowance: null,
      excessLeaveDeduction: '50.00',
      shortHoursDeduction: '15.00',
      shortTimeHours: null,
      extraTimeHours: null,
      extraTimeInformationalOnly: true,
      warnings: [],
    });
  });

  it('safely returns null without throwing for null, empty, or malformed notes', () => {
    expect(parsePayslipReconciliationBreakdown(null)).toBeNull();
    expect(parsePayslipReconciliationBreakdown(undefined)).toBeNull();
    expect(parsePayslipReconciliationBreakdown('')).toBeNull();
    expect(parsePayslipReconciliationBreakdown('   ')).toBeNull();
    expect(parsePayslipReconciliationBreakdown('Manual payroll override note.')).toBeNull();
    expect(parsePayslipReconciliationBreakdown('Reconciled: Excess Leave -USD NaN, Short Hours -USD ???')).toBeNull();
  });

  it('attaches read-only reconciliationBreakdown and preserves raw notes & 0.00 overtimePay across listPayslips, listMyPayslips, and getPayslipById', async () => {
    const dbPayslip = {
      id: 'ps-1',
      companyId: 'comp-1',
      payrollPeriodId: 'pp-1',
      payrollPeriod: { name: 'May 2026 Regular Cycle', month: 5, year: 2026 },
      employeeId: 'emp-1',
      employee: { employeeCode: 'EMP-001', fullName: 'Jane Worker', userId: 'usr-emp-1' },
      basicSalary: '3000.0000',
      allowances: '200.0000',
      overtimePay: '0.0000',
      grossSalary: '3200.0000',
      deductions: '178.1300',
      lossOfPayDeduction: '128.1300',
      netSalary: '3021.8700',
      status: 'PAID',
      paymentMethod: 'BANK_TRANSFER',
      paymentDate: new Date('2026-05-31T00:00:00.000Z'),
      ledgerId: 'led-1',
      ledger: { name: 'Salaries Payable - Jane' },
      journalEntryId: 'je-1',
      journalEntry: { voucherNumber: 'JV-2026-0055' },
      notes: sampleNotesWithWarning,
      createdAt: new Date('2026-05-31T00:00:00.000Z'),
      updatedAt: new Date('2026-05-31T00:00:00.000Z'),
    };

    vi.mocked(prisma.payrollPeriod.findUnique).mockResolvedValue({ id: 'pp-1', companyId: 'comp-1' } as any);
    vi.mocked(prisma.employee.findFirst).mockResolvedValue({ id: 'emp-1' } as any);
    vi.mocked(prisma.payslip.findMany).mockResolvedValue([dbPayslip] as any);
    vi.mocked(prisma.payslip.findUnique).mockResolvedValue(dbPayslip as any);

    const [listed] = await PayrollService.listPayslips(adminActor, 'pp-1');
    const [myListed] = await PayrollService.listMyPayslips(employeeActor, { year: 2026 });
    const single = await PayrollService.getPayslipById(employeeActor, 'ps-1');

    for (const dto of [listed, myListed, single]) {
      expect(dto.notes).toBe(sampleNotesWithWarning);
      expect(dto.overtimePay).toBe('0.00');
      expect(dto.reconciliationBreakdown).toEqual({
        currency: 'USD',
        monthlyLeaveAllowance: 4,
        excessLeaveDeduction: '100.00',
        shortHoursDeduction: '28.13',
        shortTimeHours: 2.25,
        extraTimeHours: 1.5,
        extraTimeInformationalOnly: true,
        warnings: [
          'Detected 1 incomplete attendance record(s) with missing check-out punches. In accordance with company policy, automatic short-hours deduction was withheld pending administrative review.',
        ],
      });
    }
  });
});

describe('Step 3 Scope 4: Frontend UI rendering & deduction consistency', () => {
  it('LeaveMonthlySummaryInspectorPanel renders all policy, leave, Short Time, informational Extra Time, deductions, and warnings', () => {
    const html = renderToStaticMarkup(
      React.createElement(LeaveMonthlySummaryInspectorPanel, {
        summary: sampleMonthlySummary,
        baseCurrency: 'USD',
        roundingPrecision: 2,
      })
    );

    expect(html).toContain('Jane Worker');
    expect(html).toContain('EMP-001');
    expect(html).toContain('Monthly Leave Allowance');
    expect(html).toContain('4 days');
    expect(html).toContain('Approved Leave Days');
    expect(html).toContain('5 days');
    expect(html).toContain('Remaining Leave');
    expect(html).toContain('Excess Leave Days');
    expect(html).toContain('1 days');
    expect(html).toContain('Short Time Hours');
    expect(html).toContain('2.25 hrs');
    expect(html).toContain('Extra Time Hours (Informational Only)');
    expect(html).toContain('1.5 hrs');
    expect(html).toContain('Extra Time is informational only and never offsets Short Time');
    expect(html).toContain('Excess Leave Deduction');
    expect(html).toContain('Short-Hours Deduction');
    expect(html).toContain('Total Salary Deductions');
    expect(html).toContain('128.13');
    expect(html).toContain('Incomplete Attendance Warning (1 record)');
    expect(html).toContain('missing check-out punches');
  });

  it('PayrollPage & ESS deduction helpers match identically and never double-count LOP', () => {
    const payrollCalc = computePayslipDeductionSummary(samplePayslipItem);
    const essCalc = computeEssPayslipDeductionSummary(samplePayslipItem);

    expect(payrollCalc).toEqual({
      lopDeduction: 128.13,
      otherDeductions: 50,
      totalDeductions: 178.13,
    });
    expect(essCalc).toEqual(payrollCalc);

    // When deductions === lossOfPayDeduction, otherDeductions must be 0 (not duplicated)
    const pureLop = computeEssPayslipDeductionSummary({
      deductions: '128.13',
      lossOfPayDeduction: '128.13',
    });
    expect(pureLop).toEqual({
      lopDeduction: 128.13,
      otherDeductions: 0,
      totalDeductions: 128.13,
    });
  });

  it('PayrollPage PayslipDetailModalContent renders reconciliation breakdown, 0.00 overtime, warnings, notes, and non-duplicated deductions', () => {
    const html = renderToStaticMarkup(
      React.createElement(PayslipDetailModalContent, {
        payslip: samplePayslipItem,
        baseCurrency: 'USD',
        roundingPrecision: 2,
      })
    );

    expect(html).toContain('Monthly Leave Allowance');
    expect(html).toContain('4 days');
    expect(html).toContain('Excess Leave Deduction (incl. in LOP)');
    expect(html).toContain('Short-Hours Deduction (incl. in LOP)');
    expect(html).toContain('2.25 hrs');
    expect(html).toContain('1.5 hrs');
    expect(html).toContain('Informational only — never offsets Short Time');
    expect(html).toContain('0.00 (Extra Time is not paid as OT)');
    expect(html).toContain('50.00'); // Other Deductions = 178.13 - 128.13
    expect(html).toContain('178.13'); // Total Deductions
    expect(html).not.toContain('306.26'); // Would be double-counted (178.13 + 128.13)
    expect(html).toContain('missing check-out punches');
    expect(html).toContain(sampleNotesWithWarning);
  });

  it('ESS Monthly Working Hours Summary displays Short Time & Extra Time separately, actual vs required minutes, and incomplete warnings', () => {
    const html = renderToStaticMarkup(
      React.createElement(EssMonthlyWorkingHoursSummaryCard, {
        leaveSummary: sampleMonthlySummary,
        selectedYear: 2026,
        selectedMonth: 5,
        baseCurrency: 'USD',
        roundingPrecision: 2,
      })
    );

    expect(html).toContain('Actual Worked vs Required');
    expect(html).toContain('159h 15m'); // 9555 mins
    expect(html).toContain('160h 00m'); // 9600 mins
    expect(html).toContain('9555 min worked');
    expect(html).toContain('9600 min required');
    expect(html).toContain('Short Time');
    expect(html).toContain('2.25 hrs');
    expect(html).toContain('135 min');
    expect(html).toContain('Extra Time (Informational Only)');
    expect(html).toContain('1.5 hrs');
    expect(html).toContain('90 min');
    expect(html).toContain('Informational only — never offsets Short Time');
    expect(html).toContain('1 incomplete attendance record detected');
  });

  it('ESS Payslip Voucher renders structured reconciliationBreakdown, preserved notes, and fixes LOP double-counting', () => {
    const html = renderToStaticMarkup(
      React.createElement(EssPayslipVoucherContent, {
        payslip: samplePayslipItem,
        baseCurrency: 'USD',
        roundingPrecision: 2,
      })
    );

    // Other Deductions = 50.00, Total Deductions = 178.13 (NOT 178.13 + 128.13 = 306.26)
    expect(html).toContain('50.00');
    expect(html).toContain('178.13');
    expect(html).not.toContain('306.26');
    expect(html).toContain('Monthly Leave Allowance');
    expect(html).toContain('4 days');
    expect(html).toContain('2.25 hrs');
    expect(html).toContain('1.5 hrs');
    expect(html).toContain('Informational only — never offsets Short Time');
    expect(html).toContain('Official Reconciliation Notes');
    expect(html).toContain(sampleNotesWithWarning);
    expect(html).toContain('missing check-out punches');
  });
});

describe('P2-5: Payslip reconciliation warning splitting & UI rendering', () => {
  const baseSummaryNote =
    'Reconciled: Excess Leave -USD 100.00 (Allowance 4d), Short Hours -USD 0.00 (0h short, 1.5h extra informational only).';
  const noScheduleWarning =
    'No assigned working schedule/shift found for this employee. Configured daily working hours are unavailable; hourly-rate and short-hours deductions were skipped. Please assign an official shift.';
  const incompleteAttendanceWarning =
    'Detected 2 incomplete attendance record(s) with missing check-out punches. In accordance with company policy, automatic short-hours deduction was withheld pending administrative review.';
  const overlappingLeaveWarning =
    'Detected 3 overlapping approved leave day(s) in this month. Overlapping days were de-duplicated to prevent double-counting.';
  const fractionalOverlappingLeaveWarning =
    'Detected 1.5 overlapping approved leave day(s) in this month. Overlapping days were de-duplicated to prevent double-counting.';

  it('recognizes "No assigned working schedule/shift found..." as a separate warning', () => {
    const standalone = parsePayslipReconciliationBreakdown(`${baseSummaryNote} ${noScheduleWarning}`);
    expect(standalone?.warnings).toEqual([noScheduleWarning]);

    const afterIncomplete = parsePayslipReconciliationBreakdown(
      `${baseSummaryNote} ${incompleteAttendanceWarning} ${noScheduleWarning}`
    );
    expect(afterIncomplete?.warnings).toEqual([incompleteAttendanceWarning, noScheduleWarning]);
  });

  it('recognizes "Detected N overlapping approved leave day(s)..." as a separate warning (integer and fractional)', () => {
    const standalone = parsePayslipReconciliationBreakdown(
      `${baseSummaryNote} ${overlappingLeaveWarning}`
    );
    expect(standalone?.warnings).toEqual([overlappingLeaveWarning]);

    const afterIncomplete = parsePayslipReconciliationBreakdown(
      `${baseSummaryNote} ${incompleteAttendanceWarning} ${fractionalOverlappingLeaveWarning}`
    );
    expect(afterIncomplete?.warnings).toEqual([
      incompleteAttendanceWarning,
      fractionalOverlappingLeaveWarning,
    ]);
  });

  it('splits both "No assigned working schedule/shift found..." and "Detected N overlapping approved leave day(s)..." into two distinct entries when appearing together', () => {
    const both = parsePayslipReconciliationBreakdown(
      `${baseSummaryNote} ${noScheduleWarning} ${overlappingLeaveWarning}`
    );
    expect(both?.warnings).toHaveLength(2);
    expect(both?.warnings).toEqual([noScheduleWarning, overlappingLeaveWarning]);

    const allThree = parsePayslipReconciliationBreakdown(
      `${baseSummaryNote} ${noScheduleWarning} ${incompleteAttendanceWarning} ${overlappingLeaveWarning}`
    );
    expect(allThree?.warnings).toHaveLength(3);
    expect(allThree?.warnings).toEqual([
      noScheduleWarning,
      incompleteAttendanceWarning,
      overlappingLeaveWarning,
    ]);
  });

  it('preserves backward compatibility with existing and legacy warning formats', () => {
    const legacyNoShift = 'No active shift assigned for this payroll period.';
    const legacyMissingHours = 'Missing configured daily working hours for employee.';
    const legacyNoSalary = 'No active salary revision found.';
    const legacyAllowance = 'Monthly leave allowance defaulted to 4 days.';

    const parsed = parsePayslipReconciliationBreakdown(
      `${baseSummaryNote} ${legacyNoShift} ${legacyMissingHours} ${legacyNoSalary} ${legacyAllowance}`
    );
    expect(parsed?.warnings).toEqual([
      legacyNoShift,
      legacyMissingHours,
      legacyNoSalary,
      legacyAllowance,
    ]);
  });

  it('retains safe parser behavior for invalid, empty, or malformed notes', () => {
    expect(parsePayslipReconciliationBreakdown(null)).toBeNull();
    expect(parsePayslipReconciliationBreakdown(undefined)).toBeNull();
    expect(parsePayslipReconciliationBreakdown('')).toBeNull();
    expect(parsePayslipReconciliationBreakdown('Not a reconciled note. No assigned working schedule/shift found.')).toBeNull();
    expect(parsePayslipReconciliationBreakdown('Reconciled: Excess Leave -USD invalid, Short Hours -USD 0.00.')).toBeNull();
  });

  it('renders both split warnings distinctly in PayrollPage and EmployeeSelfServicePage without altering payroll totals', () => {
    const combinedNotes = `${baseSummaryNote} ${noScheduleWarning} ${overlappingLeaveWarning}`;
    const parsedBreakdown = parsePayslipReconciliationBreakdown(combinedNotes);
    expect(parsedBreakdown?.warnings).toEqual([noScheduleWarning, overlappingLeaveWarning]);

    const multiWarningPayslip: PayslipItem = {
      ...samplePayslipItem,
      notes: combinedNotes,
      reconciliationBreakdown: parsedBreakdown,
    };

    const payrollHtml = renderToStaticMarkup(
      React.createElement(PayslipDetailModalContent, {
        payslip: multiWarningPayslip,
        baseCurrency: 'USD',
        roundingPrecision: 2,
      })
    );

    expect(payrollHtml).toContain(`<span>${noScheduleWarning}</span>`);
    expect(payrollHtml).toContain(`<span>${overlappingLeaveWarning}</span>`);
    expect(payrollHtml).toContain('3,200.00'); // Gross Pay unchanged
    expect(payrollHtml).toContain('178.13'); // Total Deductions unchanged
    expect(payrollHtml).toContain('3,021.87'); // Net Salary unchanged

    const essHtml = renderToStaticMarkup(
      React.createElement(EssPayslipVoucherContent, {
        payslip: multiWarningPayslip,
        baseCurrency: 'USD',
        roundingPrecision: 2,
      })
    );

    expect(essHtml).toContain(`<span>${noScheduleWarning}</span>`);
    expect(essHtml).toContain(`<span>${overlappingLeaveWarning}</span>`);
    expect(essHtml).toContain('3,200.00'); // Gross Earnings unchanged
    expect(essHtml).toContain('178.13'); // Total Deductions unchanged
    expect(essHtml).toContain('3,021.87'); // Net Disbursed Compensation unchanged
  });
});

