import { prisma } from '../db/client.js';
import {
  AuthUser,
  PayrollPeriodItem,
  PayslipItem,
  CreatePayrollPeriodRequest,
  PostPayrollRequest,
  PayrollStatus,
  PayslipStatus,
} from '../../shared/types.js';
import { Decimal, AccountingMath } from '../accounting/decimal-math.js';
import { PayrollCalculationService } from './payroll-calculation.service.js';
import { UnpaidAbsenceService } from './unpaid-absence.service.js';
import { LeaveService } from './leave.service.js';
import { JournalService } from './journal.service.js';
import { AuditService } from './audit.service.js';
import { PermissionService } from './permission.service.js';

export class PayrollService {
  /**
   * Helper: Resolves employee ID for self-service employee queries
   */
  private static async getEmployeeIdForUser(companyId: string, userId: string): Promise<string> {
    const employee = await prisma.employee.findFirst({
      where: { companyId, userId },
      select: { id: true },
    });

    if (!employee) {
      const err = new Error('No employee record found for your user account.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return employee.id;
  }

  /**
   * Lists payroll periods scoped to company.
   * Enforces privacy: EMPLOYEE role is blocked from aggregate company payroll periods.
   */
  static async listPeriods(
    actor: AuthUser,
    filters?: { year?: number; status?: PayrollStatus }
  ): Promise<PayrollPeriodItem[]> {
    if (actor.role === 'EMPLOYEE') {
      const err = new Error('Employees are not authorized to view company-wide payroll periods. Use the /api/payroll/my-payslips endpoint.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const where: {
      companyId: string;
      year?: number;
      status?: PayrollStatus;
    } = { companyId: actor.companyId };

    if (filters?.year) where.year = filters.year;
    if (filters?.status) where.status = filters.status;

    const periods = await prisma.payrollPeriod.findMany({
      where,
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      include: {
        createdByUser: { select: { fullName: true } },
        accountsApprovedByUser: { select: { fullName: true } },
        adminApprovedByUser: { select: { fullName: true } },
        payslips: {
          select: { grossSalary: true, deductions: true, netSalary: true },
        },
      },
    });

    return periods.map((p) => {
      let sumGross = new Decimal(0);
      let sumDeductions = new Decimal(0);
      let sumNet = new Decimal(0);

      for (const ps of p.payslips) {
        sumGross = sumGross.plus(ps.grossSalary);
        sumDeductions = sumDeductions.plus(ps.deductions);
        sumNet = sumNet.plus(ps.netSalary);
      }

      return {
        id: p.id,
        companyId: p.companyId,
        month: p.month,
        year: p.year,
        name: p.name || `${p.year}-${String(p.month).padStart(2, '0')}`,
        startDate: p.startDate.toISOString().split('T')[0],
        endDate: p.endDate.toISOString().split('T')[0],
        status: p.status as PayrollStatus,
        processedAt: p.processedAt ? p.processedAt.toISOString() : null,
        accountsApprovedAt: (p as any).accountsApprovedAt ? (p as any).accountsApprovedAt.toISOString() : null,
        accountsApprovedByUserId: (p as any).accountsApprovedByUserId || null,
        accountsApprovedByUserName: (p as any).accountsApprovedByUser?.fullName || null,
        accountsApprovalNotes: (p as any).accountsApprovalNotes || null,
        adminApprovedAt: (p as any).adminApprovedAt ? (p as any).adminApprovedAt.toISOString() : null,
        adminApprovedByUserId: (p as any).adminApprovedByUserId || null,
        adminApprovedByUserName: (p as any).adminApprovedByUser?.fullName || null,
        postedAt: p.postedAt ? p.postedAt.toISOString() : null,
        createdByUserId: p.createdByUserId,
        createdByUserName: p.createdByUser?.fullName || null,
        totalGross: AccountingMath.format(sumGross, 2),
        totalDeductions: AccountingMath.format(sumDeductions, 2),
        totalNet: AccountingMath.format(sumNet, 2),
        payslipsCount: p.payslips.length,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Retrieves single payroll period by ID with aggregated summary.
   * Enforces privacy: EMPLOYEE role is blocked from aggregate company payroll totals.
   */
  static async getPeriodById(actor: AuthUser, id: string): Promise<PayrollPeriodItem> {
    if (actor.role === 'EMPLOYEE') {
      const err = new Error('Employees are not authorized to view company-wide payroll period summaries.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const p = await prisma.payrollPeriod.findUnique({
      where: { id },
      include: {
        createdByUser: { select: { fullName: true } },
        accountsApprovedByUser: { select: { fullName: true } },
        adminApprovedByUser: { select: { fullName: true } },
        payslips: {
          select: { grossSalary: true, deductions: true, netSalary: true },
        },
      },
    });

    if (!p || p.companyId !== actor.companyId) {
      const err = new Error('Payroll period not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    let sumGross = new Decimal(0);
    let sumDeductions = new Decimal(0);
    let sumNet = new Decimal(0);

    for (const ps of p.payslips) {
      sumGross = sumGross.plus(ps.grossSalary);
      sumDeductions = sumDeductions.plus(ps.deductions);
      sumNet = sumNet.plus(ps.netSalary);
    }

    return {
      id: p.id,
      companyId: p.companyId,
      month: p.month,
      year: p.year,
      name: p.name || `${p.year}-${String(p.month).padStart(2, '0')}`,
      startDate: p.startDate.toISOString().split('T')[0],
      endDate: p.endDate.toISOString().split('T')[0],
      status: p.status as PayrollStatus,
      processedAt: p.processedAt ? p.processedAt.toISOString() : null,
      accountsApprovedAt: (p as any).accountsApprovedAt ? (p as any).accountsApprovedAt.toISOString() : null,
      accountsApprovedByUserId: (p as any).accountsApprovedByUserId || null,
      accountsApprovedByUserName: (p as any).accountsApprovedByUser?.fullName || null,
      accountsApprovalNotes: (p as any).accountsApprovalNotes || null,
      adminApprovedAt: (p as any).adminApprovedAt ? (p as any).adminApprovedAt.toISOString() : null,
      adminApprovedByUserId: (p as any).adminApprovedByUserId || null,
      adminApprovedByUserName: (p as any).adminApprovedByUser?.fullName || null,
      postedAt: p.postedAt ? p.postedAt.toISOString() : null,
      createdByUserId: p.createdByUserId,
      createdByUserName: p.createdByUser?.fullName || null,
      totalGross: AccountingMath.format(sumGross, 2),
      totalDeductions: AccountingMath.format(sumDeductions, 2),
      totalNet: AccountingMath.format(sumNet, 2),
      payslipsCount: p.payslips.length,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  /**
   * Secure self-service endpoint: lists all payslips for the authenticated employee exclusively
   */
  static async listMyPayslips(
    actor: AuthUser,
    filters?: { year?: number }
  ): Promise<PayslipItem[]> {
    const selfEmployeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);

    const where: {
      companyId: string;
      employeeId: string;
      payrollPeriod?: { year: number };
    } = {
      companyId: actor.companyId,
      employeeId: selfEmployeeId,
    };

    if (filters?.year) {
      where.payrollPeriod = { year: filters.year };
    }

    const payslips = await prisma.payslip.findMany({
      where,
      orderBy: [
        { payrollPeriod: { year: 'desc' } },
        { payrollPeriod: { month: 'desc' } },
      ],
      include: {
        employee: { select: { employeeCode: true, fullName: true } },
        payrollPeriod: { select: { name: true, month: true, year: true } },
        ledger: { select: { name: true } },
        journalEntry: { select: { voucherNumber: true } },
      },
    });

    return payslips.map((ps) => ({
      id: ps.id,
      companyId: ps.companyId,
      payrollPeriodId: ps.payrollPeriodId,
      payrollPeriodName: ps.payrollPeriod.name,
      payrollPeriodMonth: ps.payrollPeriod.month,
      payrollPeriodYear: ps.payrollPeriod.year,
      employeeId: ps.employeeId,
      employeeCode: ps.employee.employeeCode,
      employeeName: ps.employee.fullName,
      basicSalary: AccountingMath.format(ps.basicSalary, 2),
      allowances: AccountingMath.format(ps.allowances, 2),
      overtimePay: AccountingMath.format(ps.overtimePay, 2),
      grossSalary: AccountingMath.format(ps.grossSalary, 2),
      deductions: AccountingMath.format(ps.deductions, 2),
      lossOfPayDeduction: AccountingMath.format(ps.lossOfPayDeduction, 2),
      netSalary: AccountingMath.format(ps.netSalary, 2),
      status: ps.status as PayslipStatus,
      paymentMethod: ps.paymentMethod,
      paymentDate: ps.paymentDate ? ps.paymentDate.toISOString().split('T')[0] : null,
      ledgerId: ps.ledgerId,
      ledgerName: ps.ledger?.name || null,
      journalEntryId: ps.journalEntryId,
      journalVoucherNumber: ps.journalEntry?.voucherNumber || null,
      notes: ps.notes,
      createdAt: ps.createdAt.toISOString(),
      updatedAt: ps.updatedAt.toISOString(),
    }));
  }

  /**
   * Creates a new company-scoped payroll period in DRAFT status
   */
  static async createPeriod(
    actor: AuthUser,
    input: CreatePayrollPeriodRequest,
    correlationId?: string
  ): Promise<PayrollPeriodItem> {
    const month = Number(input.month);
    const year = Number(input.year);

    if (isNaN(month) || month < 1 || month > 12) {
      const err = new Error('Payroll month must be an integer between 1 and 12.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (isNaN(year) || year < 2000 || year > 2100) {
      const err = new Error('Payroll year must be a valid 4-digit year between 2000 and 2100.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const startStr = (input.startDate || '').trim();
    const endStr = (input.endDate || '').trim();

    if (!startStr || !/^\d{4}-\d{2}-\d{2}$/.test(startStr)) {
      const err = new Error('Start date is required and must be in YYYY-MM-DD format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!endStr || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
      const err = new Error('End date is required and must be in YYYY-MM-DD format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const startDate = new Date(`${startStr}T00:00:00.000Z`);
    const endDate = new Date(`${endStr}T23:59:59.999Z`);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      const err = new Error('Invalid start or end date format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (endDate.getTime() < startDate.getTime()) {
      const err = new Error('End date cannot be earlier than start date.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check unique constraint for companyId, year, month
    const existing = await prisma.payrollPeriod.findUnique({
      where: {
        companyId_year_month: {
          companyId: actor.companyId,
          year,
          month,
        },
      },
    });

    if (existing) {
      const err = new Error(`Payroll period for ${year}-${String(month).padStart(2, '0')} already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const name = input.name?.trim() || `${year}-${String(month).padStart(2, '0')} Payroll`;

    const created = await prisma.payrollPeriod.create({
      data: {
        companyId: actor.companyId,
        month,
        year,
        name,
        startDate,
        endDate,
        status: 'DRAFT',
        createdByUserId: actor.userId || actor.id,
      },
      include: {
        createdByUser: { select: { fullName: true } },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'PAYROLL_PERIOD_CREATE',
      entity: 'PayrollPeriod',
      entityId: created.id,
      correlationId,
      details: { year, month, name, startDate: startStr, endDate: endStr },
    });

    return {
      id: created.id,
      companyId: created.companyId,
      month: created.month,
      year: created.year,
      name: created.name,
      startDate: created.startDate.toISOString().split('T')[0],
      endDate: created.endDate.toISOString().split('T')[0],
      status: created.status as PayrollStatus,
      processedAt: null,
      postedAt: null,
      createdByUserId: created.createdByUserId,
      createdByUserName: created.createdByUser?.fullName || null,
      totalGross: '0.00',
      totalDeductions: '0.00',
      totalNet: '0.00',
      payslipsCount: 0,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  /**
   * Processes or recalculates payslips for a DRAFT or PROCESSED payroll period
   * Completely deterministic: replaces draft payslips inside an atomic transaction
   */
  static async processPeriod(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<PayrollPeriodItem> {
    const period = await prisma.payrollPeriod.findUnique({
      where: { id },
    });

    if (!period || period.companyId !== actor.companyId) {
      const err = new Error('Payroll period not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Check valid status transition: only DRAFT or PROCESSED can be processed/recalculated
    if (period.status === 'POSTED') {
      const err = new Error('Posted payroll period cannot be recalculated or modified.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (period.status === 'CANCELLED') {
      const err = new Error('Cancelled payroll period cannot be processed.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Fetch active employees belonging to this company
    const employees = await prisma.employee.findMany({
      where: {
        companyId: actor.companyId,
        status: 'ACTIVE',
        dateOfJoining: { lte: period.endDate },
      },
      include: {
        ledger: { select: { id: true, code: true, name: true } },
      },
      orderBy: { employeeCode: 'asc' },
    });

    const calendarDays = PayrollCalculationService.getCalendarDays(period.startDate, period.endDate);

    // Atomically recalculate and replace payslips
    await prisma.$transaction(async (tx) => {
      // Concurrency lock & atomic state revalidation inside the interactive transaction
      if (typeof (tx as any).$queryRaw === 'function') {
        await (tx as any).$queryRaw`SELECT id FROM "PayrollPeriod" WHERE id = ${period.id}::uuid FOR UPDATE`;
      }

      const currentInTx = typeof tx.payrollPeriod?.findUnique === 'function'
        ? await tx.payrollPeriod.findUnique({ where: { id: period.id } })
        : period;

      if (!currentInTx || currentInTx.companyId !== actor.companyId) {
        const err = new Error('Payroll period not found in this company.');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }

      // Explicit fail-safe: Once POSTED, a period is strictly immutable
      if (currentInTx.status === 'POSTED') {
        const err = new Error('Posted payroll period cannot be recalculated or modified.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      if (currentInTx.status === 'CANCELLED') {
        const err = new Error('Cancelled payroll period cannot be processed.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      // Valid recalculation states: DRAFT, PROCESSED, or ACCOUNTS_APPROVED (which resets approval atomically)
      if (
        currentInTx.status !== 'DRAFT' &&
        currentInTx.status !== 'PROCESSED' &&
        currentInTx.status !== 'ACCOUNTS_APPROVED'
      ) {
        const err = new Error(
          `Cannot recalculate payroll period: Current status is '${currentInTx.status}'.`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      // 1. Delete existing draft payslips for this period to prevent duplication
      await tx.payslip.deleteMany({
        where: { payrollPeriodId: period.id },
      });

      // 2. Fetch company proration policy if configured
      const prorationSetting = await tx.companySetting.findUnique({
        where: { companyId_key: { companyId: actor.companyId, key: 'PRORATION_POLICY' } },
      });
      const prorationPolicy = prorationSetting?.value?.trim().toUpperCase();

      // 3. Calculate payslip for each active employee
      for (const emp of employees) {
        // Validation: Joining-date proration check
        const joinedMidPeriod = emp.dateOfJoining > period.startDate;
        if (joinedMidPeriod && prorationPolicy !== 'CALENDAR_DAYS') {
          const err = new Error(
            `Cannot process payroll: Employee ${emp.fullName} (${emp.employeeCode}) joined mid-period on ${emp.dateOfJoining.toISOString().split('T')[0]}, but no company proration policy (PRORATION_POLICY) is configured. To prevent silent full-month overpayment, configure PRORATION_POLICY ('CALENDAR_DAYS') in Company Settings before processing.`
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        // Query all revisions applicable to this period
        const revisions = await tx.salaryRevision.findMany({
          where: {
            companyId: actor.companyId,
            employeeId: emp.id,
            effectiveFrom: { lte: period.endDate },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.startDate } }],
          },
          orderBy: [
            { effectiveFrom: 'asc' },
            { createdAt: 'asc' },
            { id: 'asc' },
          ],
        });

        // Validation: Missing salary revision
        if (revisions.length === 0) {
          const err = new Error(
            `Cannot process payroll: Employee ${emp.fullName} (${emp.employeeCode}) has no active salary revision applicable on or before ${period.endDate.toISOString().split('T')[0]}. Please establish a salary revision before processing payroll.`
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        // Validation: Mid-period revision check
        const hasMidPeriodRevision = revisions.some((r) => r.effectiveFrom > period.startDate);
        if ((hasMidPeriodRevision || revisions.length > 1) && prorationPolicy !== 'CALENDAR_DAYS') {
          const latestRev = revisions[revisions.length - 1];
          const err = new Error(
            `Cannot process payroll: Employee ${emp.fullName} (${emp.employeeCode}) has a salary revision effective mid-period (${latestRev.effectiveFrom.toISOString().split('T')[0]}), but no company proration policy (PRORATION_POLICY) is configured. Please configure PRORATION_POLICY ('CALENDAR_DAYS') in Company Settings or align revision dates to period boundaries.`
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        // Calculate basic salary with proration if applicable
        let calculatedBasicSalary: Decimal;

        if (prorationPolicy === 'CALENDAR_DAYS' && (joinedMidPeriod || hasMidPeriodRevision || revisions.length > 1)) {
          const empActiveStart = emp.dateOfJoining > period.startDate ? emp.dateOfJoining : period.startDate;
          let weightedSalary = new Decimal(0);

          for (const rev of revisions) {
            const revStart = rev.effectiveFrom > empActiveStart ? rev.effectiveFrom : empActiveStart;
            const revEnd = rev.effectiveTo && rev.effectiveTo < period.endDate ? rev.effectiveTo : period.endDate;

            if (revStart <= revEnd) {
              const intervalDays = PayrollCalculationService.getCalendarDays(revStart, revEnd);
              const portion = AccountingMath.from(rev.fixedSalary)
                .times(intervalDays)
                .dividedBy(calendarDays);
              weightedSalary = weightedSalary.plus(portion);
            }
          }

          calculatedBasicSalary = weightedSalary.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
        } else {
          const activeRevision = revisions[revisions.length - 1];
          calculatedBasicSalary = AccountingMath.from(activeRevision.fixedSalary);
        }

        // Reconcile monthly excess-leave and short-hours deductions with authoritative LeaveService
        const leaveSummary = await LeaveService.getMonthlyLeaveSummary(
          actor,
          {
            employeeId: emp.id,
            year: period.year,
            month: period.month,
          },
          tx
        );

        const excessLeaveDeduction = AccountingMath.from(leaveSummary.excessLeaveDeduction || 0);
        const shortHoursDeduction = AccountingMath.from(leaveSummary.shortHoursDeduction || 0);
        const totalReconciledLossOfPay = excessLeaveDeduction.plus(shortHoursDeduction);

        const calc = PayrollCalculationService.calculatePayslip({
          basicSalary: calculatedBasicSalary,
          lossOfPayDeduction: totalReconciledLossOfPay,
          excessLeaveDeduction,
          shortHoursDeduction,
        });

        // Guard: deductions cannot exceed gross salary
        if (AccountingMath.gt(calc.deductions, calc.grossSalary)) {
          const err = new Error(
            `Cannot process payroll: Total deductions (${AccountingMath.format(calc.deductions, 2)}) exceed gross salary (${AccountingMath.format(calc.grossSalary, 2)}) for employee ${emp.fullName} (${emp.employeeCode}). Under current company policy, negative net pay and arbitrary deduction truncation are prohibited. Please review deductions or attendance before processing.`
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        const payslipNotes = leaveSummary.warnings && leaveSummary.warnings.length > 0
          ? `Reconciled: Excess Leave -$${leaveSummary.excessLeaveDeduction}, Short Hours -$${leaveSummary.shortHoursDeduction}. ${leaveSummary.warnings.join(' ')}`
          : `Reconciled: Excess Leave -$${leaveSummary.excessLeaveDeduction}, Short Hours -$${leaveSummary.shortHoursDeduction}.`;

        await tx.payslip.create({
          data: {
            companyId: actor.companyId,
            payrollPeriodId: period.id,
            employeeId: emp.id,
            basicSalary: calc.basicSalary,
            allowances: calc.allowances,
            overtimePay: calc.overtimePay,
            grossSalary: calc.grossSalary,
            deductions: calc.deductions,
            lossOfPayDeduction: calc.lossOfPayDeduction,
            netSalary: calc.netSalary,
            status: 'DRAFT',
            ledgerId: emp.ledgerId || null,
            notes: payslipNotes,
          },
        });
      }

      // 4. Transition period status to PROCESSED and atomically invalidate previous approvals
      await tx.payrollPeriod.update({
        where: { id: period.id },
        data: {
          status: 'PROCESSED',
          processedAt: new Date(),
          accountsApprovedAt: null,
          accountsApprovedByUserId: null,
          accountsApprovalNotes: null,
          adminApprovedAt: null,
          adminApprovedByUserId: null,
        },
      });
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'PAYROLL_PERIOD_PROCESS',
      entity: 'PayrollPeriod',
      entityId: period.id,
      correlationId,
      details: { employeesCount: employees.length },
    });

    return this.getPeriodById(actor, period.id);
  }

  /**
   * Lists payslips for a given period with employee and status filters
   */
  static async listPayslips(
    actor: AuthUser,
    periodId: string,
    filters?: { employeeId?: string; status?: PayslipStatus }
  ): Promise<PayslipItem[]> {
    const period = await prisma.payrollPeriod.findUnique({
      where: { id: periodId },
    });

    if (!period || period.companyId !== actor.companyId) {
      const err = new Error('Payroll period not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const where: {
      payrollPeriodId: string;
      companyId: string;
      employeeId?: string;
      status?: PayslipStatus;
    } = { payrollPeriodId: periodId, companyId: actor.companyId };

    // If EMPLOYEE role, restrict strictly to their own employee ID
    if (actor.role === 'EMPLOYEE') {
      const selfEmployeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
      where.employeeId = selfEmployeeId;
    } else if (filters?.employeeId) {
      where.employeeId = filters.employeeId;
    }

    if (filters?.status) {
      where.status = filters.status;
    }

    const payslips = await prisma.payslip.findMany({
      where,
      orderBy: [{ employee: { employeeCode: 'asc' } }],
      include: {
        employee: { select: { employeeCode: true, fullName: true } },
        payrollPeriod: { select: { name: true, month: true, year: true } },
        ledger: { select: { name: true } },
        journalEntry: { select: { voucherNumber: true } },
      },
    });

    return payslips.map((ps) => ({
      id: ps.id,
      companyId: ps.companyId,
      payrollPeriodId: ps.payrollPeriodId,
      payrollPeriodName: ps.payrollPeriod.name,
      payrollPeriodMonth: ps.payrollPeriod.month,
      payrollPeriodYear: ps.payrollPeriod.year,
      employeeId: ps.employeeId,
      employeeCode: ps.employee.employeeCode,
      employeeName: ps.employee.fullName,
      basicSalary: AccountingMath.format(ps.basicSalary, 2),
      allowances: AccountingMath.format(ps.allowances, 2),
      overtimePay: AccountingMath.format(ps.overtimePay, 2),
      grossSalary: AccountingMath.format(ps.grossSalary, 2),
      deductions: AccountingMath.format(ps.deductions, 2),
      lossOfPayDeduction: AccountingMath.format(ps.lossOfPayDeduction, 2),
      netSalary: AccountingMath.format(ps.netSalary, 2),
      status: ps.status as PayslipStatus,
      paymentMethod: ps.paymentMethod,
      paymentDate: ps.paymentDate ? ps.paymentDate.toISOString().split('T')[0] : null,
      ledgerId: ps.ledgerId,
      ledgerName: ps.ledger?.name || null,
      journalEntryId: ps.journalEntryId,
      journalVoucherNumber: ps.journalEntry?.voucherNumber || null,
      notes: ps.notes,
      createdAt: ps.createdAt.toISOString(),
      updatedAt: ps.updatedAt.toISOString(),
    }));
  }

  /**
   * Retrieves individual payslip by ID with employee scoping
   */
  static async getPayslipById(actor: AuthUser, id: string): Promise<PayslipItem> {
    const ps = await prisma.payslip.findUnique({
      where: { id },
      include: {
        employee: { select: { employeeCode: true, fullName: true, userId: true } },
        payrollPeriod: { select: { name: true, month: true, year: true } },
        ledger: { select: { name: true } },
        journalEntry: { select: { voucherNumber: true } },
      },
    });

    if (!ps || ps.companyId !== actor.companyId) {
      const err = new Error('Payslip not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // If EMPLOYEE role, ensure payslip belongs to them
    if (actor.role === 'EMPLOYEE') {
      const selfEmployeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
      if (ps.employeeId !== selfEmployeeId) {
        const err = new Error('Employees are only permitted to view their own payslips.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }
    }

    return {
      id: ps.id,
      companyId: ps.companyId,
      payrollPeriodId: ps.payrollPeriodId,
      payrollPeriodName: ps.payrollPeriod.name,
      payrollPeriodMonth: ps.payrollPeriod.month,
      payrollPeriodYear: ps.payrollPeriod.year,
      employeeId: ps.employeeId,
      employeeCode: ps.employee.employeeCode,
      employeeName: ps.employee.fullName,
      basicSalary: AccountingMath.format(ps.basicSalary, 2),
      allowances: AccountingMath.format(ps.allowances, 2),
      overtimePay: AccountingMath.format(ps.overtimePay, 2),
      grossSalary: AccountingMath.format(ps.grossSalary, 2),
      deductions: AccountingMath.format(ps.deductions, 2),
      lossOfPayDeduction: AccountingMath.format(ps.lossOfPayDeduction, 2),
      netSalary: AccountingMath.format(ps.netSalary, 2),
      status: ps.status as PayslipStatus,
      paymentMethod: ps.paymentMethod,
      paymentDate: ps.paymentDate ? ps.paymentDate.toISOString().split('T')[0] : null,
      ledgerId: ps.ledgerId,
      ledgerName: ps.ledger?.name || null,
      journalEntryId: ps.journalEntryId,
      journalVoucherNumber: ps.journalEntry?.voucherNumber || null,
      notes: ps.notes,
      createdAt: ps.createdAt.toISOString(),
      updatedAt: ps.updatedAt.toISOString(),
    };
  }

  /**
   * Resolves payroll accounting accounts or throws descriptive configuration error
   */
  private static async resolveAccountMappings(
    companyId: string,
    overrides?: PostPayrollRequest
  ): Promise<{
    expenseLedgerId: string;
    payableLedgerId: string;
    deductionsLedgerId?: string;
  }> {
    // 1. Resolve Payroll Expense Ledger (EXPENSE root type)
    let expenseLedgerId = overrides?.payrollExpenseLedgerId;

    if (!expenseLedgerId) {
      const setting = await prisma.companySetting.findUnique({
        where: { companyId_key: { companyId, key: 'PAYROLL_EXPENSE_LEDGER_ID' } },
      });
      if (setting && setting.value) expenseLedgerId = setting.value;
    }

    if (!expenseLedgerId) {
      const autoExpense = await prisma.accountLedger.findFirst({
        where: {
          companyId,
          isActive: true,
          group: { rootType: 'EXPENSE' },
          OR: [
            { name: { contains: 'Salaries', mode: 'insensitive' } },
            { name: { contains: 'Payroll', mode: 'insensitive' } },
            { name: { contains: 'Wages', mode: 'insensitive' } },
          ],
        },
      });
      if (autoExpense) expenseLedgerId = autoExpense.id;
    }

    // 2. Resolve Payroll Payable Ledger (LIABILITY root type)
    let payableLedgerId = overrides?.payrollPayableLedgerId;

    if (!payableLedgerId) {
      const setting = await prisma.companySetting.findUnique({
        where: { companyId_key: { companyId, key: 'PAYROLL_PAYABLE_LEDGER_ID' } },
      });
      if (setting && setting.value) payableLedgerId = setting.value;
    }

    if (!payableLedgerId) {
      const autoPayable = await prisma.accountLedger.findFirst({
        where: {
          companyId,
          isActive: true,
          group: { rootType: 'LIABILITY' },
          OR: [
            { name: { contains: 'Salaries Payable', mode: 'insensitive' } },
            { name: { contains: 'Payroll Payable', mode: 'insensitive' } },
            { name: { contains: 'Employees', mode: 'insensitive' } },
          ],
        },
      });
      if (autoPayable) payableLedgerId = autoPayable.id;
    }

    if (!expenseLedgerId || !payableLedgerId) {
      const missing: string[] = [];
      if (!expenseLedgerId) missing.push('Payroll Expense ledger (EXPENSE)');
      if (!payableLedgerId) missing.push('Payroll Payable ledger (LIABILITY)');

      const err = new Error(
        `Configuration required: Missing accounting ledger mappings for payroll [${missing.join(', ')}]. Please configure PAYROLL_EXPENSE_LEDGER_ID and PAYROLL_PAYABLE_LEDGER_ID in Company Settings or create appropriate accounts under Expense and Liability groups before posting.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Validate both ledgers belong to company and are active
    const [expLedger, payLedger] = await Promise.all([
      prisma.accountLedger.findUnique({ where: { id: expenseLedgerId } }),
      prisma.accountLedger.findUnique({ where: { id: payableLedgerId } }),
    ]);

    if (!expLedger || expLedger.companyId !== companyId || !expLedger.isActive) {
      const err = new Error('Configured Payroll Expense ledger is invalid, inactive, or belongs to another company.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!payLedger || payLedger.companyId !== companyId || !payLedger.isActive) {
      const err = new Error('Configured Payroll Payable ledger is invalid, inactive, or belongs to another company.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    return {
      expenseLedgerId,
      payableLedgerId,
      deductionsLedgerId: overrides?.deductionsLedgerId,
    };
  }

  /**
   * Stage 1 of Four-Eyes Dual Approval:
   * Explicit Accounts Approval for a PROCESSED payroll period
   * Requires ACCOUNTING:APPROVE permission.
   */
  static async approveAccounts(
    actor: AuthUser,
    id: string,
    notes?: string | null,
    correlationId?: string
  ): Promise<PayrollPeriodItem> {
    // Verify permission
    const hasPerm = await PermissionService.hasPermission(
      actor.companyId,
      actor.role,
      'ACCOUNTING',
      'APPROVE'
    );
    if (!hasPerm) {
      const err = new Error(
        'Forbidden: Accounts approval requires ACCOUNTING:APPROVE permission.'
      );
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const period = await prisma.payrollPeriod.findUnique({
      where: { id },
      include: {
        payslips: { select: { id: true } },
      },
    });

    if (!period || period.companyId !== actor.companyId) {
      const err = new Error('Payroll period not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (period.status === 'POSTED') {
      const err = new Error('Posted payroll period is finalized and cannot be modified.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (period.status === 'CANCELLED') {
      const err = new Error('Cancelled payroll period cannot be approved.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (period.status === 'ACCOUNTS_APPROVED') {
      const err = new Error(
        'Payroll period has already received Accounts approval. Duplicate approval is not permitted.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (period.status !== 'PROCESSED') {
      const err = new Error(
        `Payroll period must be processed before Accounts approval. Current status is '${period.status}'.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!period.payslips || period.payslips.length === 0) {
      const err = new Error('Cannot approve an empty payroll period with zero payslips.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const approverId = actor.userId || actor.id;
    const trimmedNotes = notes ? notes.trim().slice(0, 500) : null;

    // Concurrency & state safety: update atomically inside transaction
    await prisma.$transaction(async (tx) => {
      // Row lock on PayrollPeriod (ordered lock acquisition)
      if (typeof (tx as any).$queryRaw === 'function') {
        await (tx as any).$queryRaw`SELECT id FROM "PayrollPeriod" WHERE id = ${period.id}::uuid FOR UPDATE`;
      }

      const current = typeof tx.payrollPeriod?.findUnique === 'function'
        ? await tx.payrollPeriod.findUnique({
            where: { id: period.id },
            select: { status: true },
          })
        : period;

      if (!current || current.status !== 'PROCESSED') {
        const err = new Error(
          `Concurrent conflict: Payroll period is no longer in PROCESSED status (current: '${current?.status}').`
        );
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      await tx.payrollPeriod.update({
        where: { id: period.id },
        data: {
          status: 'ACCOUNTS_APPROVED',
          accountsApprovedAt: new Date(),
          accountsApprovedByUserId: approverId,
          accountsApprovalNotes: trimmedNotes,
        },
      });

      // Atomic audit log inside transaction: commits or rolls back together with approval
      await AuditService.log({
        companyId: actor.companyId,
        userId: approverId,
        action: 'PAYROLL_ACCOUNTS_APPROVED',
        entity: 'PayrollPeriod',
        entityId: period.id,
        correlationId,
        details: {
          year: period.year,
          month: period.month,
          name: period.name,
          accountsApprovedByUserId: approverId,
          notes: trimmedNotes,
        },
      }, tx);
    });

    return this.getPeriodById(actor, period.id);
  }

  /**
   * Posts a processed payroll period into the double-entry accounting journal
   * Ensures idempotency and strict debit === credit balance
   */
  static async postPeriod(
    actor: AuthUser,
    id: string,
    accountOverrides?: PostPayrollRequest,
    correlationId?: string
  ): Promise<PayrollPeriodItem> {
    const period = await prisma.payrollPeriod.findUnique({
      where: { id },
      include: {
        payslips: {
          include: {
            employee: { select: { id: true, fullName: true, employeeCode: true, ledgerId: true } },
          },
        },
      },
    });

    if (!period || period.companyId !== actor.companyId) {
      const err = new Error('Payroll period not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Idempotency: If already POSTED, return existing
    if (period.status === 'POSTED') {
      return this.getPeriodById(actor, period.id);
    }

    if (period.status === 'CANCELLED') {
      const err = new Error('Cancelled payroll period cannot be posted.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (period.status === 'DRAFT') {
      const err = new Error('Cannot post payroll: Period must be processed and receive Accounts approval first.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (period.status === 'PROCESSED') {
      const err = new Error(
        'Cannot post payroll: Period must receive Accounts approval (ACCOUNTING:APPROVE) prior to final Admin posting.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (period.status !== 'ACCOUNTS_APPROVED') {
      const err = new Error(
        `Cannot post payroll: Period must be in ACCOUNTS_APPROVED status. Current status is '${period.status}'.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!period.accountsApprovedByUserId) {
      const err = new Error(
        'Cannot post payroll: Missing Accounts approver record. Accounts approval must be completed before posting.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Four-Eyes Invariant: The same individual cannot provide both Accounts and Admin approvals
    const currentUserId = actor.userId || actor.id;
    if (period.accountsApprovedByUserId === currentUserId) {
      const err = new Error(
        'Four-Eyes Security Violation: The same individual cannot provide both Accounts and Admin approvals. A distinct administrator must authorize final posting.'
      );
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    if (!period.payslips || period.payslips.length === 0) {
      const err = new Error('Cannot post an empty payroll period with zero payslips.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Safety Guard: Check that no payslip has deductions exceeding gross salary
    for (const ps of period.payslips) {
      if (AccountingMath.gt(ps.deductions, ps.grossSalary)) {
        const err = new Error(
          `Cannot post payroll: Total deductions (${AccountingMath.format(ps.deductions, 2)}) exceed gross salary (${AccountingMath.format(ps.grossSalary, 2)}) for employee ${ps.employee.fullName} (${ps.employee.employeeCode}). Under current company policy, negative net pay and arbitrary deduction truncation are prohibited. Please resolve before posting.`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    // Resolve required account mappings
    const mappings = await this.resolveAccountMappings(actor.companyId, accountOverrides);

    // Sum totals using Decimal arithmetic
    let totalGross = new Decimal(0);
    let totalNet = new Decimal(0);
    let totalDeductions = new Decimal(0);

    for (const ps of period.payslips) {
      totalGross = totalGross.plus(ps.grossSalary);
      totalNet = totalNet.plus(ps.netSalary);
      totalDeductions = totalDeductions.plus(ps.deductions);
    }

    // Batch query active employee ledgers to eliminate N+1 queries during posting
    const empLedgerIds = period.payslips
      .map((ps) => ps.employee.ledgerId)
      .filter((id): id is string => Boolean(id));

    const activeEmpLedgers = empLedgerIds.length > 0
      ? await prisma.accountLedger.findMany({
          where: {
            id: { in: empLedgerIds },
            companyId: actor.companyId,
            isActive: true,
          },
          select: { id: true },
        })
      : [];
    const activeLedgerSet = new Set(activeEmpLedgers.map((l) => l.id));

    // Build balanced double-entry lines
    // Line 1: Debit Gross Salary Expense
    const lines: Array<{
      ledgerId: string;
      debit: Decimal;
      credit: Decimal;
      description?: string;
    }> = [
      {
        ledgerId: mappings.expenseLedgerId,
        debit: totalGross,
        credit: new Decimal(0),
        description: `Gross Salaries & Wages Expense for ${period.name || period.year + '-' + period.month}`,
      },
    ];

    // Lines 2..N: Credit Net Salaries to Employee Ledgers or General Payroll Payable
    for (const ps of period.payslips) {
      if (AccountingMath.gt(ps.netSalary, 0)) {
        const creditLedgerId =
          ps.employee.ledgerId && activeLedgerSet.has(ps.employee.ledgerId)
            ? ps.employee.ledgerId
            : mappings.payableLedgerId;

        lines.push({
          ledgerId: creditLedgerId,
          debit: new Decimal(0),
          credit: ps.netSalary,
          description: `Salary payable: ${ps.employee.fullName} (${ps.employee.employeeCode})`,
        });
      }
    }

    // Line N+1: Credit Deductions if any, to keep debits === credits
    if (AccountingMath.gt(totalDeductions, 0)) {
      lines.push({
        ledgerId: mappings.deductionsLedgerId || mappings.expenseLedgerId, // Contra-expense or separate deduction ledger
        debit: new Decimal(0),
        credit: totalDeductions,
        description: `Loss-of-pay and payroll deductions for ${period.name}`,
      });
    }

    // Verify double-entry balance: total debits must equal total credits
    let sumDebit = new Decimal(0);
    let sumCredit = new Decimal(0);
    for (const l of lines) {
      sumDebit = sumDebit.plus(l.debit);
      sumCredit = sumCredit.plus(l.credit);
    }

    if (!AccountingMath.isBalanced(sumDebit, sumCredit)) {
      const err = new Error(
        `Payroll journal entry is unbalanced. Total Debit (${sumDebit}) does not equal Total Credit (${sumCredit}).`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const entryDate = period.endDate.toISOString().split('T')[0];
    let createdJournalId = '';
    let createdVoucherNumber = '';

    // ATOMIC DATABASE TRANSACTION:
    // Row lock, journal creation, period status transition, and audit log execute in a SINGLE database transaction
    await prisma.$transaction(async (tx) => {
      // Concurrency lock: acquire exclusive row lock on PayrollPeriod first (ordered lock acquisition)
      if (typeof (tx as any).$queryRaw === 'function') {
        await (tx as any).$queryRaw`SELECT id FROM "PayrollPeriod" WHERE id = ${period.id}::uuid FOR UPDATE`;
      }

      // Concurrency check inside transaction: re-verify status and approvers under lock
      const currentInTx = typeof tx.payrollPeriod?.findUnique === 'function'
        ? await tx.payrollPeriod.findUnique({
            where: { id: period.id },
          })
        : period;

      if (!currentInTx || currentInTx.companyId !== actor.companyId) {
        const err = new Error('Payroll period not found in this company.');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }

      // Idempotency check under lock:
      // If another concurrent request posted this period while waiting for the lock,
      // exit gracefully without duplicate GL entries or status updates.
      if (currentInTx.status === 'POSTED') {
        return;
      }

      if (currentInTx.status !== 'ACCOUNTS_APPROVED') {
        const err = new Error(
          `Cannot post payroll: Period must be in ACCOUNTS_APPROVED status. Current status is '${currentInTx.status}'.`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (!currentInTx.accountsApprovedByUserId) {
        const err = new Error(
          'Cannot post payroll: Missing Accounts approver record. Accounts approval must be completed before posting.'
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (currentInTx.accountsApprovedByUserId === currentUserId) {
        const err = new Error(
          'Four-Eyes Security Violation: The same individual cannot provide both Accounts and Admin approvals. A distinct administrator must authorize final posting.'
        );
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }

      // 1. Create and post journal passing the active transaction client
      const journal = await JournalService.createJournal(
        actor,
        {
          entryDate,
          narration: `Payroll disbursement posting for ${period.name || period.year + '-' + period.month}`,
          reference: `PAYROLL-${period.year}-${period.month}`,
          idempotencyKey: `PAYROLL-${period.id}`,
          autoPost: true,
          lines: lines.map((l) => ({
            ledgerId: l.ledgerId,
            debit: l.debit.toString(),
            credit: l.credit.toString(),
            description: l.description,
          })),
        },
        correlationId,
        tx
      );

      createdJournalId = journal.id;
      createdVoucherNumber = journal.voucherNumber;

      // 2. Transition period and payslips to POSTED and APPROVED
      await tx.payrollPeriod.update({
        where: { id: period.id },
        data: {
          status: 'POSTED',
          postedAt: new Date(),
          adminApprovedAt: new Date(),
          adminApprovedByUserId: currentUserId,
        },
      });

      await tx.payslip.updateMany({
        where: { payrollPeriodId: period.id },
        data: {
          status: 'APPROVED',
          journalEntryId: journal.id,
          paymentDate: period.endDate,
        },
      });

      // 3. In-transaction atomic audit logging: commits or rolls back together with posting
      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.userId || actor.id,
        action: 'PAYROLL_PERIOD_POST',
        entity: 'PayrollPeriod',
        entityId: period.id,
        correlationId,
        details: {
          journalEntryId: createdJournalId,
          voucherNumber: createdVoucherNumber,
          totalGross: AccountingMath.format(totalGross, 2),
          totalNet: AccountingMath.format(totalNet, 2),
          accountsApprovedByUserId: currentInTx.accountsApprovedByUserId,
          adminApprovedByUserId: currentUserId,
        },
      }, tx);
    });

    return this.getPeriodById(actor, period.id);
  }

  /**
   * Cancels a DRAFT or PROCESSED payroll period
   */
  static async cancelPeriod(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<PayrollPeriodItem> {
    const period = await prisma.payrollPeriod.findUnique({
      where: { id },
    });

    if (!period || period.companyId !== actor.companyId) {
      const err = new Error('Payroll period not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (period.status === 'POSTED') {
      const err = new Error('Posted payroll period cannot be cancelled.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const updated = await prisma.payrollPeriod.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'PAYROLL_PERIOD_CANCEL',
      entity: 'PayrollPeriod',
      entityId: updated.id,
      correlationId,
      details: { previousStatus: period.status },
    });

    return this.getPeriodById(actor, updated.id);
  }
}
