import { Decimal, AccountingMath } from '../accounting/decimal-math.js';

export interface CalculationInput {
  basicSalary: Decimal | string | number;
  calendarDays?: number;
  unpaidDays?: number;
  allowances?: Decimal | string | number;
  overtimePay?: Decimal | string | number;
  otherDeductions?: Decimal | string | number;
  lossOfPayDeduction?: Decimal | string | number;
  excessLeaveDeduction?: Decimal | string | number;
  shortHoursDeduction?: Decimal | string | number;
}

export interface CalculationResult {
  basicSalary: Decimal;
  allowances: Decimal;
  overtimePay: Decimal;
  grossSalary: Decimal;
  lossOfPayDeduction: Decimal;
  deductions: Decimal;
  netSalary: Decimal;
  formatted: {
    basicSalary: string;
    allowances: string;
    overtimePay: string;
    grossSalary: string;
    lossOfPayDeduction: string;
    deductions: string;
    netSalary: string;
  };
}

export class PayrollCalculationService {
  /**
   * Calculates calendar days between two dates inclusive
   */
  static getCalendarDays(startDate: Date, endDate: Date): number {
    const diffMs = endDate.getTime() - startDate.getTime();
    const days = Math.round(diffMs / (1000 * 60 * 60 * 24)) + 1;
    return Math.max(1, days);
  }

  /**
   * Computes individual payslip figures strictly adhering to Decimal.js precision
   *
   * Formulas:
   * 1. grossSalary = basicSalary + allowances + overtimePay
   * 2. dailySalaryRate = basicSalary / 30 (Approved corporate daily salary formula: monthly salary / 30)
   * 3. lossOfPayDeduction = reconciled (excessLeaveDeduction + shortHoursDeduction) OR round(dailySalaryRate * unpaidDays, 4)
   * 4. deductions = otherDeductions + lossOfPayDeduction
   * 5. netSalary = max(0, grossSalary - deductions)
   */
  static calculatePayslip(input: CalculationInput): CalculationResult {
    const basicSalary = AccountingMath.from(input.basicSalary);
    const allowances = AccountingMath.from(input.allowances || 0);
    const overtimePay = AccountingMath.from(input.overtimePay || 0);
    const otherDeductions = AccountingMath.from(input.otherDeductions || 0);

    // Negative values are guarded against
    if (AccountingMath.lt(basicSalary, 0)) {
      throw new Error('Basic salary cannot be negative.');
    }
    if (AccountingMath.lt(allowances, 0)) {
      throw new Error('Allowances cannot be negative.');
    }
    if (AccountingMath.lt(overtimePay, 0)) {
      throw new Error('Overtime pay cannot be negative.');
    }
    if (AccountingMath.lt(otherDeductions, 0)) {
      throw new Error('Other deductions cannot be negative.');
    }

    const unpaidDays = Math.max(0, input.unpaidDays || 0);

    // 1. Gross Salary = basicSalary + allowances + overtimePay
    const grossSalary = basicSalary.plus(allowances).plus(overtimePay);

    // 2. Loss-of-Pay Deduction:
    // Approved corporate daily salary formula: monthly salary / 30.
    // Supports reconciled excess leave + short hours deductions from LeaveService
    let lossOfPayDeduction = new Decimal(0);

    if (input.lossOfPayDeduction !== undefined && input.lossOfPayDeduction !== null) {
      lossOfPayDeduction = AccountingMath.from(input.lossOfPayDeduction).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    } else if (input.excessLeaveDeduction !== undefined || input.shortHoursDeduction !== undefined) {
      const excess = AccountingMath.from(input.excessLeaveDeduction || 0);
      const shortH = AccountingMath.from(input.shortHoursDeduction || 0);
      lossOfPayDeduction = excess.plus(shortH).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    } else if (unpaidDays > 0 && AccountingMath.gt(basicSalary, 0)) {
      // Fixed 30-day corporate divisor
      const perDaySalary = basicSalary.dividedBy(30);
      lossOfPayDeduction = perDaySalary.times(unpaidDays).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    }

    // Guard: LOP cannot exceed basic salary
    if (AccountingMath.gt(lossOfPayDeduction, basicSalary)) {
      lossOfPayDeduction = basicSalary;
    }

    // 3. Total Deductions = otherDeductions + lossOfPayDeduction
    const totalDeductions = otherDeductions.plus(lossOfPayDeduction);

    // 4. Net Salary = grossSalary - totalDeductions (floored at zero)
    let netSalary = grossSalary.minus(totalDeductions);
    if (AccountingMath.lt(netSalary, 0)) {
      netSalary = new Decimal(0);
    }

    return {
      basicSalary,
      allowances,
      overtimePay,
      grossSalary,
      lossOfPayDeduction,
      deductions: totalDeductions,
      netSalary,
      formatted: {
        basicSalary: AccountingMath.format(basicSalary, 4),
        allowances: AccountingMath.format(allowances, 4),
        overtimePay: AccountingMath.format(overtimePay, 4),
        grossSalary: AccountingMath.format(grossSalary, 4),
        lossOfPayDeduction: AccountingMath.format(lossOfPayDeduction, 4),
        deductions: AccountingMath.format(totalDeductions, 4),
        netSalary: AccountingMath.format(netSalary, 4),
      },
    };
  }
}
