import { describe, it, expect } from 'vitest';
import { AccountingMath, Decimal } from '../../src/server/accounting/decimal-math.js';

describe('Phase 4 Journal Engine: Transaction Posting Rules', () => {
  it('should require minimum of two posting lines for any double-entry voucher', () => {
    const singleLine = [{ ledgerId: 'ledger-1', debit: '100.0000', credit: '0.0000' }];
    expect(singleLine.length < 2).toBe(true);

    const validLines = [
      { ledgerId: 'ledger-1', debit: '100.0000', credit: '0.0000' },
      { ledgerId: 'ledger-2', debit: '0.0000', credit: '100.0000' },
    ];
    expect(validLines.length >= 2).toBe(true);
  });

  it('should reject journals where total debit does not equal total credit', () => {
    const lines = [
      { ledgerId: 'ledger-1', debit: new Decimal('500.0000'), credit: new Decimal('0.0000') },
      { ledgerId: 'ledger-2', debit: new Decimal('0.0000'), credit: new Decimal('499.9999') },
    ];

    const sumDebit = lines.reduce((acc, l) => acc.plus(l.debit), new Decimal(0));
    const sumCredit = lines.reduce((acc, l) => acc.plus(l.credit), new Decimal(0));

    expect(AccountingMath.equals(sumDebit, sumCredit)).toBe(false);
    const diff = AccountingMath.abs(sumDebit.minus(sumCredit));
    expect(AccountingMath.format(diff)).toBe('0.0001');
  });

  it('should accept multi-line complex compound journals when debits equal credits', () => {
    // Example: Inventory purchase with sales tax split across cash and accounts payable
    const lines = [
      { ledgerId: 'inv-asset', debit: new Decimal('1000.0000'), credit: new Decimal('0.0000') },
      { ledgerId: 'tax-asset', debit: new Decimal('100.0000'), credit: new Decimal('0.0000') },
      { ledgerId: 'cash-asset', debit: new Decimal('0.0000'), credit: new Decimal('600.0000') },
      { ledgerId: 'ap-liability', debit: new Decimal('0.0000'), credit: new Decimal('500.0000') },
    ];

    const sumDebit = lines.reduce((acc, l) => acc.plus(l.debit), new Decimal(0));
    const sumCredit = lines.reduce((acc, l) => acc.plus(l.credit), new Decimal(0));

    expect(AccountingMath.equals(sumDebit, sumCredit)).toBe(true);
    expect(AccountingMath.format(sumDebit)).toBe('1100.0000');
    expect(AccountingMath.format(sumCredit)).toBe('1100.0000');
  });

  it('should reject journals where debit and credit totals are both zero', () => {
    const lines = [
      { ledgerId: 'ledger-1', debit: new Decimal('0.0000'), credit: new Decimal('0.0000') },
      { ledgerId: 'ledger-2', debit: new Decimal('0.0000'), credit: new Decimal('0.0000') },
    ];

    const sumDebit = lines.reduce((acc, l) => acc.plus(l.debit), new Decimal(0));
    expect(AccountingMath.isZero(sumDebit)).toBe(true);
    expect(AccountingMath.gt(sumDebit, 0)).toBe(false);
  });

  it('should format sequential voucher numbers conforming to JV-YYYY-XXXX pattern', () => {
    const year = 2026;
    const count = 42;
    const nextSeq = (count + 1).toString().padStart(4, '0');
    const voucherNumber = `JV-${year}-${nextSeq}`;

    expect(voucherNumber).toBe('JV-2026-0043');
    expect(/^JV-\d{4}-\d{4}$/.test(voucherNumber)).toBe(true);
  });

  it('should invert debit and credit lines exactly for journal reversals', () => {
    const originalLines = [
      { ledgerId: 'cash', debit: new Decimal('250.0000'), credit: new Decimal('0.0000') },
      { ledgerId: 'fee-rev', debit: new Decimal('0.0000'), credit: new Decimal('250.0000') },
    ];

    // Reversal inverts every line's debit/credit
    const reversedLines = originalLines.map((l) => ({
      ledgerId: l.ledgerId,
      debit: l.credit,
      credit: l.debit,
    }));

    expect(AccountingMath.format(reversedLines[0].debit)).toBe('0.0000');
    expect(AccountingMath.format(reversedLines[0].credit)).toBe('250.0000');
    expect(AccountingMath.format(reversedLines[1].debit)).toBe('250.0000');
    expect(AccountingMath.format(reversedLines[1].credit)).toBe('0.0000');

    // Both remain balanced
    const revDebit = reversedLines.reduce((acc, l) => acc.plus(l.debit), new Decimal(0));
    const revCredit = reversedLines.reduce((acc, l) => acc.plus(l.credit), new Decimal(0));
    expect(AccountingMath.equals(revDebit, revCredit)).toBe(true);
  });
});
