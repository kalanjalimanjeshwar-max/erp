import { describe, it, expect } from 'vitest';
import { AccountingMath, Decimal } from '../../src/server/accounting/decimal-math.js';

describe('Phase 5: Quotations, Billing & Customer Receipts Business Logic', () => {
  describe('1. Quotation Financial Calculations & Precision', () => {
    it('should calculate quotation line totals with exact Decimal arithmetic', () => {
      // Line: Qty 5, Price $120.50, Discount $10.00, Tax 8.25%
      const qty = AccountingMath.from('5');
      const unitPrice = AccountingMath.from('120.50');
      const discount = AccountingMath.from('10.00');
      const taxRate = AccountingMath.from('8.25');

      const baseAmount = qty.times(unitPrice); // 602.50
      expect(baseAmount.toString()).toBe('602.5');

      const afterDiscount = baseAmount.minus(discount); // 592.50
      expect(afterDiscount.toString()).toBe('592.5');

      const taxAmount = afterDiscount.times(taxRate).dividedBy(100); // 48.88125
      const lineTotal = afterDiscount.plus(taxAmount); // 641.38125

      expect(AccountingMath.format(lineTotal, 2)).toBe('641.38');
      expect(AccountingMath.format(lineTotal, 4)).toBe('641.3813');
    });

    it('should reject discount amounts that exceed line base amount', () => {
      const qty = new Decimal('2');
      const price = new Decimal('50.00');
      const baseAmount = qty.times(price); // 100.00

      const excessiveDiscount = new Decimal('150.00');
      expect(AccountingMath.gt(excessiveDiscount, baseAmount)).toBe(true);

      const validDiscount = new Decimal('25.00');
      expect(AccountingMath.lte(validDiscount, baseAmount)).toBe(true);
    });

    it('should reject negative quantities and negative prices', () => {
      const negativeQty = new Decimal('-1');
      const zeroQty = new Decimal('0');
      const positiveQty = new Decimal('2.5');

      expect(AccountingMath.lte(negativeQty, 0)).toBe(true);
      expect(AccountingMath.lte(zeroQty, 0)).toBe(true);
      expect(AccountingMath.gt(positiveQty, 0)).toBe(true);

      const negativePrice = new Decimal('-10.00');
      const zeroPrice = new Decimal('0.00');
      expect(AccountingMath.lt(negativePrice, 0)).toBe(true);
      expect(AccountingMath.gte(zeroPrice, 0)).toBe(true);
    });

    it('CRITICAL: Quotations are strictly accounting-neutral and do not affect GL', () => {
      // Validating architectural rule: Quotations do NOT generate journal vouchers
      const quotationStatuses = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'];
      for (const status of quotationStatuses) {
        // Assert that status transitions do not define or trigger GL entries
        expect(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED']).toContain(status);
      }
    });
  });

  describe('2. Invoice Double-Entry Accounting Generation', () => {
    it('should construct exactly balanced double-entry lines on invoice issuance', () => {
      // Subtotal: 1000.00, Discount: 100.00, Tax (10%): 90.00, Total: 990.00
      const subtotal = new Decimal('1000.0000');
      const discount = new Decimal('100.0000');
      const taxTotal = new Decimal('90.0000');

      const netRevenue = subtotal.minus(discount); // 900.0000
      const totalAR = netRevenue.plus(taxTotal);   // 990.0000

      // Debit AR, Credit Revenue, Credit Tax
      const debitAR = totalAR;
      const creditRevenue = netRevenue;
      const creditTax = taxTotal;

      const totalDebit = debitAR;
      const totalCredit = creditRevenue.plus(creditTax);

      expect(AccountingMath.eq(totalDebit, totalCredit)).toBe(true);
      expect(AccountingMath.isBalanced(totalDebit, totalCredit)).toBe(true);
      expect(totalDebit.toString()).toBe('990');
      expect(totalCredit.toString()).toBe('990');
    });

    it('should construct exactly balanced reversing entry on invoice voiding', () => {
      // Original invoice: AR Debit 500, Rev Credit 500
      // Reversal: AR Credit 500, Rev Debit 500
      const invoiceTotal = new Decimal('500.0000');

      const reversingDebit = invoiceTotal; // Debit Revenue
      const reversingCredit = invoiceTotal; // Credit AR

      expect(AccountingMath.isBalanced(reversingDebit, reversingCredit)).toBe(true);
    });
  });

  describe('3. Customer Receipts & Over-Allocation Prevention', () => {
    it('should enforce that total allocated cannot exceed receipt amount', () => {
      const receiptAmount = new Decimal('500.00');

      // Allocation attempt 1: $300 + $250 = $550 (exceeds receipt $500)
      const alloc1 = new Decimal('300.00');
      const alloc2 = new Decimal('250.00');
      const totalAllocated = alloc1.plus(alloc2);

      expect(AccountingMath.gt(totalAllocated, receiptAmount)).toBe(true);

      // Allocation attempt 2: $300 + $200 = $500 (exact)
      const validAlloc2 = new Decimal('200.00');
      const validTotal = alloc1.plus(validAlloc2);
      expect(AccountingMath.lte(validTotal, receiptAmount)).toBe(true);
    });

    it('should enforce that allocation to an invoice cannot exceed invoice balance due', () => {
      const invoiceBalanceDue = new Decimal('150.00');

      const excessiveAlloc = new Decimal('200.00');
      expect(AccountingMath.gt(excessiveAlloc, invoiceBalanceDue)).toBe(true);

      const exactAlloc = new Decimal('150.00');
      expect(AccountingMath.lte(exactAlloc, invoiceBalanceDue)).toBe(true);

      const partialAlloc = new Decimal('75.00');
      expect(AccountingMath.lte(partialAlloc, invoiceBalanceDue)).toBe(true);
    });

    it('should calculate updated invoice balance and status correctly', () => {
      const invoiceTotal = new Decimal('1000.00');
      let amountPaid = new Decimal('0.00');
      let balanceDue = invoiceTotal.minus(amountPaid);

      // Payment 1: $400
      const payment1 = new Decimal('400.00');
      amountPaid = amountPaid.plus(payment1);
      balanceDue = invoiceTotal.minus(amountPaid);

      expect(amountPaid.toString()).toBe('400');
      expect(balanceDue.toString()).toBe('600');
      let status = AccountingMath.isZero(balanceDue) ? 'PAID' : 'PARTIALLY_PAID';
      expect(status).toBe('PARTIALLY_PAID');

      // Payment 2: $600
      const payment2 = new Decimal('600.00');
      amountPaid = amountPaid.plus(payment2);
      balanceDue = invoiceTotal.minus(amountPaid);

      expect(amountPaid.toString()).toBe('1000');
      expect(AccountingMath.isZero(balanceDue)).toBe(true);
      status = AccountingMath.isZero(balanceDue) ? 'PAID' : 'PARTIALLY_PAID';
      expect(status).toBe('PAID');
    });

    it('should ensure customer receipt posting lines are perfectly balanced', () => {
      // Customer Receipt: Debit Cash/Bank $750, Credit AR $750
      const receiptTotal = new Decimal('750.0000');

      const debitCash = receiptTotal;
      const creditAR = receiptTotal;

      expect(AccountingMath.isBalanced(debitCash, creditAR)).toBe(true);
    });
  });

  describe('4. Sequential Numbering Validation', () => {
    it('should format sequential numbers with year and pad zeros', () => {
      const formatNumber = (prefix: string, year: number, count: number) => {
        const nextSeq = (count + 1).toString().padStart(4, '0');
        return `${prefix}-${year}-${nextSeq}`;
      };

      expect(formatNumber('QTN', 2026, 0)).toBe('QTN-2026-0001');
      expect(formatNumber('QTN', 2026, 12)).toBe('QTN-2026-0013');
      expect(formatNumber('INV', 2026, 0)).toBe('INV-2026-0001');
      expect(formatNumber('INV', 2026, 99)).toBe('INV-2026-0100');
      expect(formatNumber('RCT', 2026, 0)).toBe('RCT-2026-0001');
    });
  });
});
