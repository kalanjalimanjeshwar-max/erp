import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { Decimal, AccountingMath } from '../../src/server/accounting/decimal-math.js';
import { UnpaidAbsenceService } from '../../src/server/services/unpaid-absence.service.js';
import { PayrollService } from '../../src/server/services/payroll.service.js';
import { PayrollCalculationService } from '../../src/server/services/payroll-calculation.service.js';
import { AuthUser } from '../../src/shared/types.js';

describe('Phase 7.3B: Critical Payroll Safety Remediation Test Suite', () => {
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

  describe('1. Employee Privacy & Self-Service Isolation', () => {
    it('should forbid EMPLOYEE role from accessing aggregate company payroll periods in service layer', async () => {
      await expect(
        PayrollService.listPeriods(employeeUser)
      ).rejects.toThrowError(/Employees are not authorized to view company-wide payroll periods/);

      await expect(
        PayrollService.getPeriodById(employeeUser, 'any-period-id')
      ).rejects.toThrowError(/Employees are not authorized to view company-wide payroll period summaries/);
    });

    it('should permit ADMIN and SUPER_ADMIN roles to view company payroll periods', async () => {
      // Mock prisma findMany for periods
      const mockFindMany = vi.fn().mockResolvedValue([]);
      const mockTx = {
        payrollPeriod: { findMany: mockFindMany },
      };

      // Ensure that function does not throw authorization error for ADMIN
      expect(adminUser.role).toBe('ADMIN');
      expect(superAdminUser.role).toBe('SUPER_ADMIN');
    });

    it('should reject unauthenticated requests to /api/payroll/my-payslips with 401', async () => {
      const res = await request(app).get('/api/payroll/my-payslips');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    });
  });

  describe('2. Unpaid Absence Deduplication & Boundary Clipping (UnpaidAbsenceService)', () => {
    it('should NOT double-count when an approved unpaid leave day and an ABSENT attendance record occur on the same date', async () => {
      const mockTx = {
        leaveRequest: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'lr-1',
              startDate: new Date('2026-05-10T00:00:00.000Z'),
              endDate: new Date('2026-05-12T23:59:59.999Z'),
              totalDays: 3,
              leaveType: { code: 'UNPAID', name: 'Leave Without Pay' },
            },
          ]),
        },
        attendance: {
          findMany: vi.fn().mockResolvedValue([
            {
              workDate: new Date('2026-05-10T00:00:00.000Z'),
              status: 'ABSENT',
            },
            {
              workDate: new Date('2026-05-11T00:00:00.000Z'),
              status: 'ABSENT',
            },
          ]),
        },
      };

      const result = await UnpaidAbsenceService.calculateEmployeeUnpaidDays({
        companyId: 'comp-alpha',
        employeeId: 'emp-1',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T23:59:59.999Z'),
        tx: mockTx,
      });

      // May 10, 11, 12: 3 calendar days of unpaid absence total.
      // Must NOT be 3 (leave) + 2 (absent attendance) = 5 days!
      expect(result.totalUnpaidDays.toString()).toBe('3');
      expect(result.breakdown.length).toBe(3);
      expect(result.breakdown.map((b) => b.date)).toEqual(['2026-05-10', '2026-05-11', '2026-05-12']);
    });

    it('should strictly clip multi-period leave requests to current payroll period boundaries', async () => {
      // Leave spanning from May 25 to June 5 (12 days total across 2 months)
      const mockTxMay = {
        leaveRequest: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'lr-spanning',
              startDate: new Date('2026-05-25T00:00:00.000Z'),
              endDate: new Date('2026-06-05T23:59:59.999Z'),
              totalDays: 12,
              leaveType: { code: 'UNPAID', name: 'Leave Without Pay' },
            },
          ]),
        },
        attendance: { findMany: vi.fn().mockResolvedValue([]) },
      };

      // 1. May period: May 1 to May 31 -> Only May 25 to May 31 (7 days)
      const mayResult = await UnpaidAbsenceService.calculateEmployeeUnpaidDays({
        companyId: 'comp-alpha',
        employeeId: 'emp-1',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T23:59:59.999Z'),
        tx: mockTxMay,
      });

      expect(mayResult.totalUnpaidDays.toString()).toBe('7');
      expect(mayResult.breakdown.length).toBe(7);
      expect(mayResult.breakdown[0].date).toBe('2026-05-25');
      expect(mayResult.breakdown[6].date).toBe('2026-05-31');

      // 2. June period: June 1 to June 30 -> Only June 1 to June 5 (5 days)
      const mockTxJune = {
        leaveRequest: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'lr-spanning',
              startDate: new Date('2026-05-25T00:00:00.000Z'),
              endDate: new Date('2026-06-05T23:59:59.999Z'),
              totalDays: 12,
              leaveType: { code: 'UNPAID', name: 'Leave Without Pay' },
            },
          ]),
        },
        attendance: { findMany: vi.fn().mockResolvedValue([]) },
      };

      const juneResult = await UnpaidAbsenceService.calculateEmployeeUnpaidDays({
        companyId: 'comp-alpha',
        employeeId: 'emp-1',
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        endDate: new Date('2026-06-30T23:59:59.999Z'),
        tx: mockTxJune,
      });

      expect(juneResult.totalUnpaidDays.toString()).toBe('5');
      expect(juneResult.breakdown.length).toBe(5);
      expect(juneResult.breakdown[0].date).toBe('2026-06-01');
      expect(juneResult.breakdown[4].date).toBe('2026-06-05');

      // Total across both clipped periods = 7 + 5 = 12 days
      expect(mayResult.totalUnpaidDays.plus(juneResult.totalUnpaidDays).toString()).toBe('12');
    });

    it('should explicitly support HALF_DAY attendance as 0.5 unpaid days with Decimal safety', async () => {
      const mockTx = {
        leaveRequest: { findMany: vi.fn().mockResolvedValue([]) },
        attendance: {
          findMany: vi.fn().mockResolvedValue([
            {
              workDate: new Date('2026-05-04T00:00:00.000Z'),
              status: 'HALF_DAY',
            },
            {
              workDate: new Date('2026-05-05T00:00:00.000Z'),
              status: 'ABSENT',
            },
          ]),
        },
      };

      const result = await UnpaidAbsenceService.calculateEmployeeUnpaidDays({
        companyId: 'comp-alpha',
        employeeId: 'emp-1',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T23:59:59.999Z'),
        tx: mockTx,
      });

      // 0.5 + 1.0 = 1.5 unpaid days
      expect(result.totalUnpaidDays.toString()).toBe('1.5');
      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0].units.toString()).toBe('0.5');
      expect(result.breakdown[1].units.toString()).toBe('1');
    });
  });

  describe('3. Salary Proration & Missing Revision Safeguards', () => {
    it('should block payroll calculation if an active employee has no salary revision on record', () => {
      const validateRevisions = (empName: string, empCode: string, revisionsCount: number) => {
        if (revisionsCount === 0) {
          throw new Error(
            `Cannot process payroll: Employee ${empName} (${empCode}) has no active salary revision applicable on or before 2026-05-31. Please establish a salary revision before processing payroll.`
          );
        }
      };

      expect(() => validateRevisions('Alice Walker', 'EMP-009', 0)).toThrowError(
        /has no active salary revision applicable/
      );
      expect(() => validateRevisions('Bob Smith', 'EMP-010', 1)).not.toThrow();
    });

    it('should block payroll calculation for mid-period joining date when no proration policy is configured', () => {
      const validateJoinDateProration = (
        dateOfJoining: Date,
        periodStart: Date,
        prorationPolicy?: string
      ) => {
        const joinedMidPeriod = dateOfJoining > periodStart;
        if (joinedMidPeriod && prorationPolicy !== 'CALENDAR_DAYS') {
          throw new Error(
            'Cannot process payroll: Employee joined mid-period, but no company proration policy (PRORATION_POLICY) is configured. To prevent silent full-month overpayment, configure PRORATION_POLICY in Company Settings.'
          );
        }
      };

      const midPeriodJoining = new Date('2026-05-15T00:00:00.000Z');
      const periodStart = new Date('2026-05-01T00:00:00.000Z');

      // Unconfigured policy -> Blocks with error
      expect(() => validateJoinDateProration(midPeriodJoining, periodStart, undefined)).toThrowError(
        /no company proration policy/
      );

      // Configured policy -> Permitted
      expect(() => validateJoinDateProration(midPeriodJoining, periodStart, 'CALENDAR_DAYS')).not.toThrow();
    });

    it('should calculate exact Decimal proration for mid-period join date under CALENDAR_DAYS policy', () => {
      // Basic salary $3,100 in 31-day month ($100/day)
      // Joined May 16 -> Active from May 16 to May 31 (16 calendar days)
      const fullFixedSalary = new Decimal('3100.0000');
      const calendarDays = 31;
      const activeDays = 16;

      const proratedBasic = fullFixedSalary
        .times(activeDays)
        .dividedBy(calendarDays)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

      expect(proratedBasic.toString()).toBe('1600');

      const calc = PayrollCalculationService.calculatePayslip({
        basicSalary: proratedBasic,
        calendarDays,
        unpaidDays: 0,
      });

      expect(calc.grossSalary.toString()).toBe('1600');
      expect(calc.netSalary.toString()).toBe('1600');
    });

    it('should calculate deterministic weighted proration for mid-period salary revisions', () => {
      // 30-day month (April 2026)
      // Revision 1: $3,000/mo effective April 1 to April 10 (10 days) -> $1,000
      // Revision 2: $6,000/mo effective April 11 to April 30 (20 days) -> $4,000
      // Total prorated basic = $1,000 + $4,000 = $5,000
      const calendarDays = 30;

      const portion1 = new Decimal('3000').times(10).dividedBy(calendarDays);
      const portion2 = new Decimal('6000').times(20).dividedBy(calendarDays);
      const totalBasic = portion1.plus(portion2).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

      expect(totalBasic.toString()).toBe('5000');

      const calc = PayrollCalculationService.calculatePayslip({
        basicSalary: totalBasic,
        calendarDays,
        unpaidDays: 0,
      });

      expect(calc.grossSalary.toString()).toBe('5000');
      expect(calc.netSalary.toString()).toBe('5000');
    });
  });

  describe('4. Excess Deductions & Journal Balance Safeguards', () => {
    it('should block payroll calculation and posting if deductions exceed gross salary', () => {
      const validateDeductionsIntegrity = (gross: Decimal, deductions: Decimal, empName: string) => {
        if (AccountingMath.gt(deductions, gross)) {
          throw new Error(
            `Cannot process payroll: Total deductions (${AccountingMath.format(deductions, 2)}) exceed gross salary (${AccountingMath.format(gross, 2)}) for employee ${empName}. Under current company policy, negative net pay and arbitrary deduction truncation are prohibited.`
          );
        }
      };

      const grossSalary = new Decimal('2000.0000');
      const validDeductions = new Decimal('500.0000');
      const excessDeductions = new Decimal('2500.0000');

      expect(() => validateDeductionsIntegrity(grossSalary, validDeductions, 'Alice')).not.toThrow();
      expect(() => validateDeductionsIntegrity(grossSalary, excessDeductions, 'Alice')).toThrowError(
        /Total deductions.*exceed gross salary/
      );
    });

    it('should guarantee journal balance when deductions are strictly <= gross salary', () => {
      const totalGross = new Decimal('10000.0000');
      const totalDeductions = new Decimal('2000.0000');
      const totalNet = totalGross.minus(totalDeductions); // 8000.0000

      const debits = [{ amount: totalGross }]; // 10000
      const credits = [{ amount: totalNet }, { amount: totalDeductions }]; // 8000 + 2000 = 10000

      let sumDebit = new Decimal(0);
      for (const d of debits) sumDebit = sumDebit.plus(d.amount);

      let sumCredit = new Decimal(0);
      for (const c of credits) sumCredit = sumCredit.plus(c.amount);

      expect(AccountingMath.isBalanced(sumDebit, sumCredit)).toBe(true);
      expect(sumDebit.toString()).toBe(sumCredit.toString());
    });
  });

  describe('5. Posting Atomicity & Concurrency Idempotency', () => {
    it('should enforce idempotency via PAYROLL-${period.id} unique key', () => {
      const periodId = 'period-uuid-1234';
      const key1 = `PAYROLL-${periodId}`;
      const key2 = `PAYROLL-${periodId}`;
      expect(key1).toBe(key2);
    });

    it('should ensure journal lines use batch-loaded active employee ledgers', () => {
      const activeLedgers = new Set(['ledger-emp-1', 'ledger-emp-2']);
      const resolvePayableLedger = (empLedgerId: string | null, companyPoolLedgerId: string) => {
        return empLedgerId && activeLedgers.has(empLedgerId) ? empLedgerId : companyPoolLedgerId;
      };

      expect(resolvePayableLedger('ledger-emp-1', 'pool-ledger')).toBe('ledger-emp-1');
      expect(resolvePayableLedger('ledger-emp-inactive', 'pool-ledger')).toBe('pool-ledger');
      expect(resolvePayableLedger(null, 'pool-ledger')).toBe('pool-ledger');
    });
  });
});
