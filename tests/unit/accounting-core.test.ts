import { describe, it, expect } from 'vitest';
import { AccountingMath, Decimal } from '../../src/server/accounting/decimal-math.js';
import { AccountingReportService } from '../../src/server/services/accounting-report.service.js';

describe('Phase 4 Accounting Core: Decimal Mathematics & Invariant Rules', () => {
  it('should eliminate JavaScript floating-point errors using exact Decimal arithmetic', () => {
    // In standard IEEE-754 JavaScript float:
    const jsFloatSum = 0.1 + 0.2;
    expect(jsFloatSum).not.toBe(0.3); // 0.30000000000000004

    // In CoreERP exact Decimal accounting engine:
    const dec1 = AccountingMath.from('0.1000');
    const dec2 = AccountingMath.from('0.2000');
    const exactSum = dec1.plus(dec2);

    expect(AccountingMath.format(exactSum)).toBe('0.3000');
    expect(AccountingMath.equals(exactSum, '0.3000')).toBe(true);
  });

  it('should accurately handle small fractional ledger cent operations without precision drift', () => {
    let balance = new Decimal('1000.0000');
    const deductions = ['123.4567', '234.5678', '345.6789'];

    for (const d of deductions) {
      balance = balance.minus(new Decimal(d));
    }

    // 1000 - 123.4567 - 234.5678 - 345.6789 = 296.2966
    expect(AccountingMath.format(balance)).toBe('296.2966');
    expect(AccountingMath.isPositive(balance)).toBe(true);
  });

  it('should validate debit/credit equality strictly with AccountingMath.equals', () => {
    const totalDebit = new Decimal('15420.7500');
    const totalCredit = new Decimal('15420.7500');
    const unbalancedCredit = new Decimal('15420.7499');

    expect(AccountingMath.equals(totalDebit, totalCredit)).toBe(true);
    expect(AccountingMath.equals(totalDebit, unbalancedCredit)).toBe(false);

    const diff = AccountingMath.abs(totalDebit.minus(unbalancedCredit));
    expect(AccountingMath.format(diff)).toBe('0.0001');
    expect(AccountingMath.isZero(diff)).toBe(false);
  });

  it('should enforce correct normal balance classifications by root type', () => {
    // ASSET & EXPENSE -> Normal Debit
    expect(AccountingReportService.isNormalDebit('ASSET')).toBe(true);
    expect(AccountingReportService.isNormalDebit('EXPENSE')).toBe(true);

    // LIABILITY, EQUITY, INCOME -> Normal Credit
    expect(AccountingReportService.isNormalDebit('LIABILITY')).toBe(false);
    expect(AccountingReportService.isNormalDebit('EQUITY')).toBe(false);
    expect(AccountingReportService.isNormalDebit('INCOME')).toBe(false);
  });

  it('should enforce double-entry trial balance equilibrium', () => {
    // Simulated trial balance rows
    const rows = [
      { name: 'Cash at Bank', rootType: 'ASSET' as const, debit: '50000.0000', credit: '0.0000' },
      { name: 'Office Equipment', rootType: 'ASSET' as const, debit: '15000.0000', credit: '0.0000' },
      { name: 'Accounts Payable', rootType: 'LIABILITY' as const, debit: '0.0000', credit: '10000.0000' },
      { name: 'Share Capital', rootType: 'EQUITY' as const, debit: '0.0000', credit: '50000.0000' },
      { name: 'Consulting Revenue', rootType: 'INCOME' as const, debit: '0.0000', credit: '12000.0000' },
      { name: 'Rent Expense', rootType: 'EXPENSE' as const, debit: '7000.0000', credit: '0.0000' },
    ];

    let sumDebit = new Decimal(0);
    let sumCredit = new Decimal(0);

    for (const r of rows) {
      sumDebit = sumDebit.plus(new Decimal(r.debit));
      sumCredit = sumCredit.plus(new Decimal(r.credit));
    }

    // Total Debit = 50000 + 15000 + 7000 = 72000
    // Total Credit = 10000 + 50000 + 12000 = 72000
    expect(AccountingMath.format(sumDebit)).toBe('72000.0000');
    expect(AccountingMath.format(sumCredit)).toBe('72000.0000');
    expect(AccountingMath.equals(sumDebit, sumCredit)).toBe(true);
  });

  it('should verify fundamental accounting equation: Assets = Liabilities + Equity + Net Profit', () => {
    const assets = new Decimal('65000.0000');
    const liabilities = new Decimal('10000.0000');
    const baseEquity = new Decimal('50000.0000');
    const income = new Decimal('12000.0000');
    const expenses = new Decimal('7000.0000');

    // Net Profit = Income - Expenses = 12000 - 7000 = 5000
    const netProfit = income.minus(expenses);
    expect(AccountingMath.format(netProfit)).toBe('5000.0000');

    // Total Equity with Retained Earnings = 50000 + 5000 = 55000
    const totalEquity = baseEquity.plus(netProfit);
    expect(AccountingMath.format(totalEquity)).toBe('55000.0000');

    // Liabilities + Equity = 10000 + 55000 = 65000 = Assets
    const liabilitiesPlusEquity = liabilities.plus(totalEquity);
    expect(AccountingMath.equals(assets, liabilitiesPlusEquity)).toBe(true);
  });
});
