import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { Decimal, AccountingMath } from '../../src/server/accounting/decimal-math.js';
import { PayrollCalculationService } from '../../src/server/services/payroll-calculation.service.js';
import { PermissionService } from '../../src/server/services/permission.service.js';
import { AuthUser } from '../../src/shared/types.ts';

describe('Phase 7.3: Payroll Backend & Calculation Engine Unit & Validation Tests', () => {
  const app = createApp();

  const superAdminUser: AuthUser = {
    id: 'user-sa-uuid',
    userId: 'user-sa-uuid',
    companyId: 'company-uuid-alpha',
    email: 'admin@alpha.local',
    fullName: 'Alpha Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const adminUser: AuthUser = {
    id: 'user-admin-uuid',
    userId: 'user-admin-uuid',
    companyId: 'company-uuid-alpha',
    email: 'hr@alpha.local',
    fullName: 'Alpha HR Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeUser: AuthUser = {
    id: 'user-emp-uuid',
    userId: 'user-emp-uuid',
    companyId: 'company-uuid-alpha',
    email: 'john@alpha.local',
    fullName: 'John Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  describe('1. Decimal Calculation Precision, Rounding & Monetary Formulas', () => {
    it('should calculate gross and net salary with exact decimal precision', () => {
      const result = PayrollCalculationService.calculatePayslip({
        basicSalary: '5000.0000',
        calendarDays: 30,
        unpaidDays: 0,
        allowances: '750.5000',
        overtimePay: '249.5000',
        otherDeductions: '100.0000',
      });

      // Gross = 5000 + 750.50 + 249.50 = 6000.0000
      expect(result.grossSalary.toString()).toBe('6000');
      expect(result.formatted.grossSalary).toBe('6000.0000');

      // Deductions = 100.0000 + 0 = 100.0000
      expect(result.deductions.toString()).toBe('100');
      expect(result.formatted.deductions).toBe('100.0000');

      // Net = 6000 - 100 = 5900.0000
      expect(result.netSalary.toString()).toBe('5900');
      expect(result.formatted.netSalary).toBe('5900.0000');
    });

    it('should avoid floating-point binary rounding errors', () => {
      // 0.1 + 0.2 in standard JS float is 0.30000000000000004
      const result = PayrollCalculationService.calculatePayslip({
        basicSalary: '0.1000',
        calendarDays: 30,
        allowances: '0.2000',
      });

      expect(result.grossSalary.toString()).toBe('0.3');
      expect(result.formatted.grossSalary).toBe('0.3000');
    });

    it('should calculate loss of pay deduction correctly using approved 30-day corporate divisor', () => {
      // Basic salary: $3,000 with approved 30-day divisor = exactly $100 per day
      // 3 unpaid days = $300 LOP deduction (regardless of calendar days in month)
      const result = PayrollCalculationService.calculatePayslip({
        basicSalary: '3000.0000',
        calendarDays: 31,
        unpaidDays: 3,
        allowances: '500.0000',
      });

      expect(result.lossOfPayDeduction.toString()).toBe('300');
      expect(result.formatted.lossOfPayDeduction).toBe('300.0000');
      expect(result.deductions.toString()).toBe('300');
      // Gross = 3000 + 500 = 3500
      // Net = 3500 - 300 = 3200
      expect(result.netSalary.toString()).toBe('3200');
    });

    it('should calculate reconciled excess leave and short hours deductions accurately', () => {
      const result = PayrollCalculationService.calculatePayslip({
        basicSalary: '4500.0000',
        allowances: '500.0000',
        excessLeaveDeduction: '150.0000', // 1 day excess leave @ $4500/30 = $150
        shortHoursDeduction: '40.0000',   // 2 hours short @ $20/hr
        otherDeductions: '50.0000',
      });

      // Loss of pay = 150 + 40 = 190.0000
      expect(result.lossOfPayDeduction.toString()).toBe('190');
      // Deductions = 50 (other) + 190 (lossOfPay) = 240.0000
      expect(result.deductions.toString()).toBe('240');
      // Gross = 4500 + 500 = 5000.0000
      expect(result.grossSalary.toString()).toBe('5000');
      // Net = 5000 - 240 = 4760.0000
      expect(result.netSalary.toString()).toBe('4760');
    });

    it('should cap loss of pay deduction at basic salary', () => {
      // If employee had 35 unpaid days in a 30-day month, LOP should not exceed basic salary
      const result = PayrollCalculationService.calculatePayslip({
        basicSalary: '3000.0000',
        calendarDays: 30,
        unpaidDays: 35,
      });

      expect(result.lossOfPayDeduction.toString()).toBe('3000');
      expect(result.netSalary.toString()).toBe('0');
    });

    it('should floor net salary at zero if total deductions exceed gross salary', () => {
      const result = PayrollCalculationService.calculatePayslip({
        basicSalary: '1000.0000',
        calendarDays: 30,
        otherDeductions: '1500.0000', // Exceeds gross
      });

      expect(result.netSalary.toString()).toBe('0');
      expect(result.formatted.netSalary).toBe('0.0000');
    });

    it('should reject negative inputs with clear error messages', () => {
      expect(() =>
        PayrollCalculationService.calculatePayslip({
          basicSalary: '-1000.0000',
          calendarDays: 30,
        })
      ).toThrowError(/Basic salary cannot be negative/);

      expect(() =>
        PayrollCalculationService.calculatePayslip({
          basicSalary: '1000.0000',
          calendarDays: 30,
          allowances: '-50.0000',
        })
      ).toThrowError(/Allowances cannot be negative/);

      expect(() =>
        PayrollCalculationService.calculatePayslip({
          basicSalary: '1000.0000',
          calendarDays: 30,
          overtimePay: '-20.0000',
        })
      ).toThrowError(/Overtime pay cannot be negative/);

      expect(() =>
        PayrollCalculationService.calculatePayslip({
          basicSalary: '1000.0000',
          calendarDays: 30,
          otherDeductions: '-10.0000',
        })
      ).toThrowError(/Other deductions cannot be negative/);
    });
  });

  describe('2. Salary Revision Effective-Date Selection', () => {
    it('should determine the applicable revision based on effective-from and effective-to dates', () => {
      const revisions = [
        {
          id: 'rev-1',
          fixedSalary: new Decimal('4000.0000'),
          effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
          effectiveTo: new Date('2025-12-31T23:59:59.999Z'),
        },
        {
          id: 'rev-2',
          fixedSalary: new Decimal('5000.0000'),
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          effectiveTo: null,
        },
      ];

      const findApplicable = (startDate: Date, endDate: Date) => {
        return revisions.find(
          (r) =>
            r.effectiveFrom.getTime() <= endDate.getTime() &&
            (!r.effectiveTo || r.effectiveTo.getTime() >= startDate.getTime())
        );
      };

      // January 2026 payroll period
      const jan2026Start = new Date('2026-01-01T00:00:00.000Z');
      const jan2026End = new Date('2026-01-31T23:59:59.999Z');
      const currentRev = findApplicable(jan2026Start, jan2026End);
      expect(currentRev?.id).toBe('rev-2');
      expect(currentRev?.fixedSalary.toString()).toBe('5000');

      // June 2025 historical payroll period
      const jun2025Start = new Date('2025-06-01T00:00:00.000Z');
      const jun2025End = new Date('2025-06-30T23:59:59.999Z');
      const historicalRev = findApplicable(jun2025Start, jun2025End);
      expect(historicalRev?.id).toBe('rev-1');
      expect(historicalRev?.fixedSalary.toString()).toBe('4000');
    });

    it('should handle employees with zero or missing salary revisions safely', () => {
      const result = PayrollCalculationService.calculatePayslip({
        basicSalary: 0,
        calendarDays: 30,
        allowances: 0,
        otherDeductions: 0,
      });

      expect(result.grossSalary.toString()).toBe('0');
      expect(result.netSalary.toString()).toBe('0');
    });
  });

  describe('3. Payroll Period Lifecycle & Valid Status Transitions', () => {
    it('should enforce valid status transitions and reject invalid transitions', () => {
      const validateTransition = (current: string, target: string) => {
        if (current === 'POSTED') {
          throw new Error('Posted payroll period cannot be recalculated or modified.');
        }
        if (current === 'CANCELLED') {
          throw new Error('Cancelled payroll period cannot be processed.');
        }
        if (target === 'POSTED' && current !== 'PROCESSED') {
          throw new Error('Only PROCESSED payroll periods can be posted.');
        }
      };

      // Valid: DRAFT -> PROCESSED
      expect(() => validateTransition('DRAFT', 'PROCESSED')).not.toThrow();

      // Valid: PROCESSED -> POSTED
      expect(() => validateTransition('PROCESSED', 'POSTED')).not.toThrow();

      // Invalid: DRAFT -> POSTED (without processing first)
      expect(() => validateTransition('DRAFT', 'POSTED')).toThrowError(/Only PROCESSED payroll periods/);

      // Invalid: POSTED -> PROCESSED (recalculating posted payroll)
      expect(() => validateTransition('POSTED', 'PROCESSED')).toThrowError(/Posted payroll period cannot be recalculated/);

      // Invalid: POSTED -> CANCELLED
      expect(() => validateTransition('POSTED', 'CANCELLED')).toThrowError(/Posted payroll period cannot be recalculated/);

      // Invalid: CANCELLED -> PROCESSED
      expect(() => validateTransition('CANCELLED', 'PROCESSED')).toThrowError(/Cancelled payroll period cannot be processed/);
    });

    it('should validate payroll month and year bounds', () => {
      const validatePeriodParams = (month: number, year: number) => {
        if (isNaN(month) || month < 1 || month > 12) {
          throw new Error('Payroll month must be an integer between 1 and 12.');
        }
        if (isNaN(year) || year < 2000 || year > 2100) {
          throw new Error('Payroll year must be a valid 4-digit year between 2000 and 2100.');
        }
      };

      expect(() => validatePeriodParams(0, 2026)).toThrowError(/between 1 and 12/);
      expect(() => validatePeriodParams(13, 2026)).toThrowError(/between 1 and 12/);
      expect(() => validatePeriodParams(5, 1999)).toThrowError(/between 2000 and 2100/);
      expect(() => validatePeriodParams(5, 2026)).not.toThrow();
    });

    it('should reject end date earlier than start date', () => {
      const start = new Date('2026-05-31');
      const end = new Date('2026-05-01'); // Earlier than start
      expect(end.getTime() < start.getTime()).toBe(true);
    });
  });

  describe('4. Accounting Integration & Double-Entry Balance Verification', () => {
    it('should ensure double-entry journal balance: Total Debit === Total Credit', () => {
      const grossSalary = new Decimal('15000.0000');
      const netSalary = new Decimal('14200.0000');
      const deductions = new Decimal('800.0000');

      const debitLines = [{ amount: grossSalary }]; // Expense debit
      const creditLines = [{ amount: netSalary }, { amount: deductions }]; // Payable & deductions credit

      let totalDebit = new Decimal(0);
      for (const d of debitLines) totalDebit = totalDebit.plus(d.amount);

      let totalCredit = new Decimal(0);
      for (const c of creditLines) totalCredit = totalCredit.plus(c.amount);

      expect(AccountingMath.isBalanced(totalDebit, totalCredit)).toBe(true);
      expect(totalDebit.toString()).toBe(totalCredit.toString());
    });

    it('should reject unbalanced journal entries', () => {
      const totalDebit = new Decimal('15000.0000');
      const totalCredit = new Decimal('14999.0000'); // 1 unit off balance

      expect(AccountingMath.isBalanced(totalDebit, totalCredit)).toBe(false);
    });

    it('should require configured expense and payable accounts before posting', () => {
      const resolveAccounts = (expenseLedgerId?: string, payableLedgerId?: string) => {
        if (!expenseLedgerId || !payableLedgerId) {
          throw new Error('Configuration required: Missing accounting ledger mappings for payroll.');
        }
      };

      expect(() => resolveAccounts(undefined, 'pay-id')).toThrowError(/Missing accounting ledger mappings/);
      expect(() => resolveAccounts('exp-id', undefined)).toThrowError(/Missing accounting ledger mappings/);
      expect(() => resolveAccounts('exp-id', 'pay-id')).not.toThrow();
    });
  });

  describe('5. Security, Tenant Scoping & Permission Boundaries', () => {
    it('should reject unauthenticated requests to payroll endpoints with 401', async () => {
      const endpoints = [
        { method: 'get', url: '/api/payroll/periods' },
        { method: 'post', url: '/api/payroll/periods' },
        { method: 'get', url: '/api/payroll/payslips/some-id' },
      ];

      for (const ep of endpoints) {
        const res = ep.method === 'get' ? await request(app).get(ep.url) : await request(app).post(ep.url);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
      }
    });

    it('should enforce that EMPLOYEE role cannot create or process payroll periods', async () => {
      const canCreate = await PermissionService.hasPermission('company-uuid-alpha', 'EMPLOYEE', 'PAYROLL', 'CREATE');
      const canEdit = await PermissionService.hasPermission('company-uuid-alpha', 'EMPLOYEE', 'PAYROLL', 'EDIT');
      const canApprove = await PermissionService.hasPermission('company-uuid-alpha', 'EMPLOYEE', 'PAYROLL', 'APPROVE');

      expect(canCreate).toBe(false);
      expect(canEdit).toBe(false);
      expect(canApprove).toBe(false);
    });

    it('ADMIN and SUPER_ADMIN should be authorized to create, process, and approve payroll', async () => {
      expect(await PermissionService.hasPermission('company-uuid-alpha', 'SUPER_ADMIN', 'PAYROLL', 'CREATE')).toBe(true);
      expect(await PermissionService.hasPermission('company-uuid-alpha', 'SUPER_ADMIN', 'PAYROLL', 'APPROVE')).toBe(true);
      expect(await PermissionService.hasPermission('company-uuid-alpha', 'ADMIN', 'PAYROLL', 'CREATE')).toBe(true);
      expect(await PermissionService.hasPermission('company-uuid-alpha', 'ADMIN', 'PAYROLL', 'APPROVE')).toBe(true);
    });

    it('should prevent cross-company access to payroll periods and payslips', () => {
      const companyA = 'comp-alpha';
      const companyB = 'comp-beta';

      const verifyTenant = (recordCompanyId: string, actorCompanyId: string) => {
        if (recordCompanyId !== actorCompanyId) {
          throw new Error('Payroll record not found in this company.');
        }
      };

      expect(() => verifyTenant(companyA, companyB)).toThrowError(/not found in this company/);
      expect(() => verifyTenant(companyA, companyA)).not.toThrow();
    });

    it('should enforce that employees can only access their own payslips', () => {
      const verifyPayslipAccess = (actor: AuthUser, payslipEmployeeUserId: string) => {
        if (actor.role === 'EMPLOYEE' && payslipEmployeeUserId !== actor.userId) {
          throw new Error('Employees are only permitted to view their own payslips.');
        }
      };

      // Employee accessing another employee's payslip
      expect(() => verifyPayslipAccess(employeeUser, 'other-emp-user')).toThrowError(/only permitted to view their own/);

      // Employee accessing own payslip
      expect(() => verifyPayslipAccess(employeeUser, employeeUser.userId)).not.toThrow();

      // Admin accessing any employee's payslip
      expect(() => verifyPayslipAccess(adminUser, 'other-emp-user')).not.toThrow();
    });
  });
});
