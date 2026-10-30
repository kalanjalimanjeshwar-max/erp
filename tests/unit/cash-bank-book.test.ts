import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../src/server/db/client.js';
import { AccountingReportService } from '../../src/server/services/accounting-report.service.js';
import { previewStore } from '../../src/client/services/previewStore.js';
import { Decimal } from '../../src/server/accounting/decimal-math.js';

// Mock prisma client for unit tests
vi.mock('../../src/server/db/client.js', () => {
  return {
    prisma: {
      accountLedger: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      journalLine: {
        findMany: vi.fn(),
      },
      journalEntry: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
    },
  };
});

describe('Stage 2: Cash Book and Bank Book Reports', () => {
  const companyAId = 'company-test-alpha';
  const companyBId = 'company-test-beta';

  const cashGroup = {
    id: 'grp-cash',
    name: 'Cash & Cash Equivalents',
    rootType: 'ASSET' as const,
  };

  const bankGroup = {
    id: 'grp-bank',
    name: 'Bank Accounts',
    rootType: 'ASSET' as const,
  };

  const vaultCashLedger = {
    id: 'ldr-vault-cash',
    companyId: companyAId,
    groupId: cashGroup.id,
    group: cashGroup,
    code: '1010',
    name: 'Cash on Hand (Vault)',
    description: 'Vault cash reserve',
    currency: 'USD',
    isActive: true,
    openingBalance: new Decimal('10000.0000'),
    openingBalanceType: 'DEBIT' as const,
    createdAt: new Date('2026-01-01'),
  };

  const pettyCashLedger = {
    id: 'ldr-petty-cash',
    companyId: companyAId,
    groupId: cashGroup.id,
    group: cashGroup,
    code: '1015',
    name: 'Petty Cash Register',
    description: 'Front till petty cash',
    currency: 'USD',
    isActive: true,
    openingBalance: new Decimal('1500.0000'),
    openingBalanceType: 'DEBIT' as const,
    createdAt: new Date('2026-01-01'),
  };

  const jpmorganBankLedger = {
    id: 'ldr-jpmorgan',
    companyId: companyAId,
    groupId: bankGroup.id,
    group: bankGroup,
    code: '1020',
    name: 'Operating Bank Account (JPMorgan)',
    description: 'Main checking account',
    currency: 'USD',
    isActive: true,
    openingBalance: new Decimal('50000.0000'),
    openingBalanceType: 'DEBIT' as const,
    createdAt: new Date('2026-01-01'),
  };

  const svbBankLedger = {
    id: 'ldr-svb',
    companyId: companyAId,
    groupId: bankGroup.id,
    group: bankGroup,
    code: '1025',
    name: 'Payroll Operating Bank (Silicon Valley Bank)',
    description: 'Payroll disbursement account',
    currency: 'USD',
    isActive: true,
    openingBalance: new Decimal('25000.0000'),
    openingBalanceType: 'DEBIT' as const,
    createdAt: new Date('2026-01-01'),
  };

  const receivablesLedger = {
    id: 'ldr-ar',
    companyId: companyAId,
    groupId: 'grp-ar',
    group: { id: 'grp-ar', name: 'Trade Debtors', rootType: 'ASSET' as const },
    code: '1030',
    name: 'Accounts Receivable',
    description: 'Trade debtors',
    currency: 'USD',
    isActive: true,
    openingBalance: new Decimal('0.0000'),
    openingBalanceType: 'DEBIT' as const,
    createdAt: new Date('2026-01-01'),
  };

  const revenueLedger = {
    id: 'ldr-rev',
    companyId: companyAId,
    groupId: 'grp-rev',
    group: { id: 'grp-rev', name: 'Operating Revenue', rootType: 'INCOME' as const },
    code: '4010',
    name: 'Consulting Services Revenue',
    description: 'Service fees',
    currency: 'USD',
    isActive: true,
    openingBalance: new Decimal('0.0000'),
    openingBalanceType: 'CREDIT' as const,
    createdAt: new Date('2026-01-01'),
  };

  const rentExpenseLedger = {
    id: 'ldr-rent',
    companyId: companyAId,
    groupId: 'grp-exp',
    group: { id: 'grp-exp', name: 'Administrative Expenses', rootType: 'EXPENSE' as const },
    code: '5020',
    name: 'Office Rent Expense',
    description: 'Monthly office rent',
    currency: 'USD',
    isActive: true,
    openingBalance: new Decimal('0.0000'),
    openingBalanceType: 'DEBIT' as const,
    createdAt: new Date('2026-01-01'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    previewStore.reset();
  });

  // ========================================================
  // 1. Account Classification & Eligibility
  // ========================================================
  describe('1. Account Classification & Eligibility', () => {
    it('should correctly classify liquid Cash and Bank ledgers', () => {
      expect(AccountingReportService.classifyCashOrBankLedger('Cash on Hand (Vault)', 'Current Assets')).toBe('CASH');
      expect(AccountingReportService.classifyCashOrBankLedger('Petty Cash Till', 'Liquid Cash')).toBe('CASH');
      expect(AccountingReportService.classifyCashOrBankLedger('Operating Bank Account (JPMorgan)', 'Bank Accounts')).toBe('BANK');
      expect(AccountingReportService.classifyCashOrBankLedger('Silicon Valley Bank (SVB)', 'Checking')).toBe('BANK');
    });

    it('should reject non-liquid assets from cash/bank classification', () => {
      expect(AccountingReportService.classifyCashOrBankLedger('Accounts Receivable (Debtors)', 'Assets')).toBe('OTHER');
      expect(AccountingReportService.classifyCashOrBankLedger('Inventory Stock Asset', 'Current Assets')).toBe('OTHER');
      expect(AccountingReportService.classifyCashOrBankLedger('Office Furniture & Equipment', 'Fixed Assets')).toBe('OTHER');
      expect(AccountingReportService.classifyCashOrBankLedger('Trade Accounts Payable', 'Liabilities')).toBe('OTHER');
    });
  });

  // ========================================================
  // 2. Opening Balance Calculations & Date Filtering
  // ========================================================
  describe('2. Opening Balance Calculations & Date Filtering', () => {
    it('should fold pre-period transactions before fromDate into opening balance', async () => {
      vi.mocked(prisma.accountLedger.findMany).mockResolvedValue([vaultCashLedger as any]);
      vi.mocked(prisma.accountLedger.findUnique).mockResolvedValue(vaultCashLedger as any);

      // Pre-period lines (prior to 2026-02-01)
      // Original configured OB: $10,000.00 DR
      // Pre-period receipt: $3,000.00 DR
      // Pre-period payment: $1,000.00 CR
      // Expected opening balance on 2026-02-01: $10,000 + $3,000 - $1,000 = $12,000.00 DR
      vi.mocked(prisma.journalLine.findMany)
        .mockResolvedValueOnce([
          { debit: new Decimal('3000.0000'), credit: new Decimal('0.0000') },
          { debit: new Decimal('0.0000'), credit: new Decimal('1000.0000') },
        ] as any) // preLines call
        .mockResolvedValueOnce([]); // periodLines call

      const report = await AccountingReportService.getCashBook(companyAId, {
        ledgerId: vaultCashLedger.id,
        fromDate: '2026-02-01',
        toDate: '2026-02-28',
      });

      expect(report.openingBalance).toBe('12000.0000');
      expect(report.openingBalanceType).toBe('DEBIT');
      expect(report.closingBalance).toBe('12000.0000');
      expect(report.lines.length).toBe(0);

      // Verify Prisma query filtered by entryDate < fromDate with status: POSTED
      expect(prisma.journalLine.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            ledgerId: vaultCashLedger.id,
            companyId: companyAId,
            journal: expect.objectContaining({
              status: 'POSTED',
              entryDate: { lt: new Date('2026-02-01') },
            }),
          }),
        })
      );
    });
  });

  // ========================================================
  // 3. Cash Book: Receipts, Payments & Running Balances
  // ========================================================
  describe('3. Cash Book: Receipts, Payments & Running Balances', () => {
    it('should correctly record receipts (Dr), payments (Cr), and compute running balances', async () => {
      vi.mocked(prisma.accountLedger.findMany).mockResolvedValue([vaultCashLedger as any]);
      vi.mocked(prisma.accountLedger.findUnique).mockResolvedValue(vaultCashLedger as any);

      // Pre-lines: none (so opening balance is configured $10,000.00)
      vi.mocked(prisma.journalLine.findMany)
        .mockResolvedValueOnce([]) // preLines
        .mockResolvedValueOnce([
          // Period transaction 1: Receipt from Customer $2,500.00
          {
            id: 'line-cash-1',
            ledgerId: vaultCashLedger.id,
            lineNumber: 1,
            debit: new Decimal('2500.0000'),
            credit: new Decimal('0.0000'),
            description: 'Cash payment from client',
            journal: {
              id: 'j-1',
              voucherNumber: 'JV-2026-0010',
              entryDate: new Date('2026-02-05'),
              reference: 'INV-1001-PMT',
              narration: 'Cash settlement of invoice',
              lines: [
                { ledgerId: vaultCashLedger.id, debit: '2500.0000', credit: '0.0000', ledger: vaultCashLedger },
                { ledgerId: receivablesLedger.id, debit: '0.0000', credit: '2500.0000', ledger: receivablesLedger },
              ],
            },
          },
          // Period transaction 2: Payment for office rent $1,200.00
          {
            id: 'line-cash-2',
            ledgerId: vaultCashLedger.id,
            lineNumber: 2,
            debit: new Decimal('0.0000'),
            credit: new Decimal('1200.0000'),
            description: 'Office rent cash payment',
            journal: {
              id: 'j-2',
              voucherNumber: 'JV-2026-0012',
              entryDate: new Date('2026-02-10'),
              reference: 'RENT-FEB',
              narration: 'Rent expense settlement',
              lines: [
                { ledgerId: rentExpenseLedger.id, debit: '1200.0000', credit: '0.0000', ledger: rentExpenseLedger },
                { ledgerId: vaultCashLedger.id, debit: '0.0000', credit: '1200.0000', ledger: vaultCashLedger },
              ],
            },
          },
        ] as any);

      const report = await AccountingReportService.getCashBook(companyAId, {
        ledgerId: vaultCashLedger.id,
        fromDate: '2026-02-01',
        toDate: '2026-02-28',
      });

      expect(report.openingBalance).toBe('10000.0000');
      expect(report.openingBalanceType).toBe('DEBIT');
      expect(report.lines.length).toBe(2);

      // Line 1: Receipt +$2,500. Running balance: 10,000 + 2,500 = 12,500
      expect(report.lines[0].voucherNumber).toBe('JV-2026-0010');
      expect(report.lines[0].debit).toBe('2500.0000');
      expect(report.lines[0].credit).toBe('0.0000');
      expect(report.lines[0].counterpartyAccount).toBe('Accounts Receivable');
      expect(report.lines[0].runningBalance).toBe('12500.0000');
      expect(report.lines[0].runningBalanceType).toBe('DEBIT');

      // Line 2: Payment -$1,200. Running balance: 12,500 - 1,200 = 11,300
      expect(report.lines[1].voucherNumber).toBe('JV-2026-0012');
      expect(report.lines[1].debit).toBe('0.0000');
      expect(report.lines[1].credit).toBe('1200.0000');
      expect(report.lines[1].counterpartyAccount).toBe('Office Rent Expense');
      expect(report.lines[1].runningBalance).toBe('11300.0000');
      expect(report.lines[1].runningBalanceType).toBe('DEBIT');

      // Period totals & Closing balance
      expect(report.totalDebit).toBe('2500.0000');
      expect(report.totalCredit).toBe('1200.0000');
      expect(report.closingBalance).toBe('11300.0000');
      expect(report.closingBalanceType).toBe('DEBIT');
    });
  });

  // ========================================================
  // 4. Bank Book: Deposits, Withdrawals & Contra Transfer Integration
  // ========================================================
  describe('4. Bank Book: Deposits, Withdrawals & Contra Transfers', () => {
    it('should reflect posted Contra Entry transfers in Bank Book with opposing cash counterparty', async () => {
      vi.mocked(prisma.accountLedger.findMany).mockResolvedValue([jpmorganBankLedger as any]);
      vi.mocked(prisma.accountLedger.findUnique).mockResolvedValue(jpmorganBankLedger as any);

      // JPMorgan bank: OB = $50,000.00 DR
      // Contra 1: Cash to Bank $5,000.00 (Deposit into JPMorgan, credit Vault Cash)
      // Contra 2: Bank to Cash $750.00 (Withdrawal from JPMorgan, debit Petty Cash)
      // Contra 3: Bank to Bank $15,000.00 (Transfer to SVB Bank, credit JPMorgan)
      vi.mocked(prisma.journalLine.findMany)
        .mockResolvedValueOnce([]) // preLines
        .mockResolvedValueOnce([
          {
            id: 'b-line-1',
            ledgerId: jpmorganBankLedger.id,
            lineNumber: 1,
            debit: new Decimal('5000.0000'),
            credit: new Decimal('0.0000'),
            description: 'Contra Transfer To: Operating Bank Account (JPMorgan)',
            journal: {
              id: 'cv-1',
              voucherNumber: 'CV-2026-0001',
              entryDate: new Date('2026-02-15'),
              reference: 'DEP-001',
              narration: 'Deposit excess vault cash into operating account',
              lines: [
                { ledgerId: jpmorganBankLedger.id, debit: '5000.0000', credit: '0.0000', ledger: jpmorganBankLedger },
                { ledgerId: vaultCashLedger.id, debit: '0.0000', credit: '5000.0000', ledger: vaultCashLedger },
              ],
            },
          },
          {
            id: 'b-line-2',
            ledgerId: jpmorganBankLedger.id,
            lineNumber: 2,
            debit: new Decimal('0.0000'),
            credit: new Decimal('750.0000'),
            description: 'Contra Transfer From: Operating Bank Account (JPMorgan)',
            journal: {
              id: 'cv-2',
              voucherNumber: 'CV-2026-0002',
              entryDate: new Date('2026-02-18'),
              reference: 'CHK-88021',
              narration: 'Cash withdrawal to replenish petty cash',
              lines: [
                { ledgerId: pettyCashLedger.id, debit: '750.0000', credit: '0.0000', ledger: pettyCashLedger },
                { ledgerId: jpmorganBankLedger.id, debit: '0.0000', credit: '750.0000', ledger: jpmorganBankLedger },
              ],
            },
          },
          {
            id: 'b-line-3',
            ledgerId: jpmorganBankLedger.id,
            lineNumber: 2,
            debit: new Decimal('0.0000'),
            credit: new Decimal('15000.0000'),
            description: 'Contra Transfer From: Operating Bank Account (JPMorgan)',
            journal: {
              id: 'cv-3',
              voucherNumber: 'CV-2026-0003',
              entryDate: new Date('2026-02-20'),
              reference: 'WIRE-9921',
              narration: 'Fund payroll disbursement account',
              lines: [
                { ledgerId: svbBankLedger.id, debit: '15000.0000', credit: '0.0000', ledger: svbBankLedger },
                { ledgerId: jpmorganBankLedger.id, debit: '0.0000', credit: '15000.0000', ledger: jpmorganBankLedger },
              ],
            },
          },
        ] as any);

      const report = await AccountingReportService.getBankBook(companyAId, {
        ledgerId: jpmorganBankLedger.id,
        fromDate: '2026-02-01',
        toDate: '2026-02-28',
      });

      expect(report.openingBalance).toBe('50000.0000');
      expect(report.lines.length).toBe(3);

      // Line 1: Deposit $5,000 -> Running: $55,000
      expect(report.lines[0].voucherNumber).toBe('CV-2026-0001');
      expect(report.lines[0].counterpartyAccount).toBe('Cash on Hand (Vault)');
      expect(report.lines[0].debit).toBe('5000.0000');
      expect(report.lines[0].runningBalance).toBe('55000.0000');

      // Line 2: Withdrawal $750 -> Running: $54,250
      expect(report.lines[1].voucherNumber).toBe('CV-2026-0002');
      expect(report.lines[1].counterpartyAccount).toBe('Petty Cash Register');
      expect(report.lines[1].credit).toBe('750.0000');
      expect(report.lines[1].runningBalance).toBe('54250.0000');

      // Line 3: Wire to SVB $15,000 -> Running: $39,250
      expect(report.lines[2].voucherNumber).toBe('CV-2026-0003');
      expect(report.lines[2].counterpartyAccount).toBe('Payroll Operating Bank (Silicon Valley Bank)');
      expect(report.lines[2].credit).toBe('15000.0000');
      expect(report.lines[2].runningBalance).toBe('39250.0000');

      expect(report.totalDebit).toBe('5000.0000');
      expect(report.totalCredit).toBe('15750.0000');
      expect(report.closingBalance).toBe('39250.0000');
      expect(report.closingBalanceType).toBe('DEBIT');
    });
  });

  // ========================================================
  // 5. Draft & Reversed Entries Exclusion
  // ========================================================
  describe('5. Draft & Reversed Entries Exclusion', () => {
    it('should strictly query only status: POSTED, excluding DRAFT and REVERSED journals', async () => {
      vi.mocked(prisma.accountLedger.findMany).mockResolvedValue([vaultCashLedger as any]);
      vi.mocked(prisma.accountLedger.findUnique).mockResolvedValue(vaultCashLedger as any);
      vi.mocked(prisma.journalLine.findMany).mockResolvedValue([]);

      await AccountingReportService.getCashBook(companyAId, {
        ledgerId: vaultCashLedger.id,
        fromDate: '2026-02-01',
        toDate: '2026-02-28',
      });

      // Confirm both preLines and periodLines queries require status: 'POSTED'
      for (const callArgs of vi.mocked(prisma.journalLine.findMany).mock.calls) {
        expect(callArgs[0]?.where?.journal?.status).toBe('POSTED');
      }
    });
  });

  // ========================================================
  // 6. Multi-Tenant Isolation
  // ========================================================
  describe('6. Multi-Tenant Isolation', () => {
    it('should reject requests for ledgers belonging to another company', async () => {
      // Ledger belongs to companyBId, actor belongs to companyAId
      vi.mocked(prisma.accountLedger.findMany).mockResolvedValue([]);
      vi.mocked(prisma.accountLedger.findUnique).mockResolvedValue({
        ...vaultCashLedger,
        companyId: companyBId,
      } as any);

      await expect(
        AccountingReportService.getCashBook(companyAId, {
          ledgerId: vaultCashLedger.id,
        })
      ).rejects.toThrow('Ledger not found in this company.');
    });

    it('should reject non-asset ledgers requested for cash book', async () => {
      vi.mocked(prisma.accountLedger.findMany).mockResolvedValue([]);
      vi.mocked(prisma.accountLedger.findUnique).mockResolvedValue(revenueLedger as any);

      await expect(
        AccountingReportService.getCashBook(companyAId, {
          ledgerId: revenueLedger.id,
        })
      ).rejects.toThrow('Selected ledger must be an asset account.');
    });
  });

  // ========================================================
  // 7. Preview Mode: Deterministic Offline Execution
  // ========================================================
  describe('7. Preview Mode: Deterministic Offline Execution', () => {
    it('should generate Cash Book in preview mode without any network calls or database queries', () => {
      const cashReport = previewStore.getCashBook();

      expect(cashReport).toBeDefined();
      expect(cashReport.bookType).toBe('CASH');
      expect(cashReport.companyId).toBe('preview-company-id');
      expect(cashReport.eligibleLedgers.length).toBeGreaterThan(0);
      expect(cashReport.openingBalance).toBe('15000.0000'); // Vault cash initial preview opening balance
      expect(cashReport.openingBalanceType).toBe('DEBIT');

      // The initial preview contra entry CV-2026-0001 transfers $5000 from Vault Cash to JPMorgan
      const cv1 = cashReport.lines.find((l) => l.voucherNumber === 'CV-2026-0001');
      expect(cv1).toBeDefined();
      expect(cv1?.credit).toBe('5000.0000'); // Cash payment (outflow)
      expect(cv1?.counterpartyAccount).toContain('Operating Bank Account (JPMorgan)');

      // Prisma should not have been called at all
      expect(prisma.accountLedger.findMany).not.toHaveBeenCalled();
      expect(prisma.journalLine.findMany).not.toHaveBeenCalled();
    });

    it('should generate Bank Book in preview mode without any network calls', () => {
      const bankReport = previewStore.getBankBook();

      expect(bankReport).toBeDefined();
      expect(bankReport.bookType).toBe('BANK');
      expect(bankReport.companyId).toBe('preview-company-id');
      expect(bankReport.eligibleLedgers.length).toBeGreaterThan(0);

      // JPMorgan Bank default opening balance is $125,000.00
      expect(bankReport.openingBalance).toBe('125000.0000');
      expect(bankReport.openingBalanceType).toBe('DEBIT');

      // In initial preview contra entries:
      // CV-2026-0001: Cash to Bank $5,000 (Deposit into JPMorgan)
      // CV-2026-0002: Bank to Cash $750 (Withdrawal from JPMorgan)
      // CV-2026-0003 is DRAFT, so it must be EXCLUDED!
      const cv1 = bankReport.lines.find((l) => l.voucherNumber === 'CV-2026-0001');
      expect(cv1).toBeDefined();
      expect(cv1?.debit).toBe('5000.0000'); // Deposit
      expect(cv1?.counterpartyAccount).toContain('Cash on Hand (Vault)');

      const cv2 = bankReport.lines.find((l) => l.voucherNumber === 'CV-2026-0002');
      expect(cv2).toBeDefined();
      expect(cv2?.credit).toBe('750.0000'); // Withdrawal
      expect(cv2?.counterpartyAccount).toContain('Petty Cash Register');

      // Draft CV-2026-0003 must be excluded from preview bank book
      const cv3 = bankReport.lines.find((l) => l.voucherNumber === 'CV-2026-0003');
      expect(cv3).toBeUndefined();

      // No network or DB calls
      expect(prisma.accountLedger.findMany).not.toHaveBeenCalled();
    });

    it('should maintain mathematical running balance consistency in preview mode', () => {
      const bankReport = previewStore.getBankBook();
      let prevBal = parseFloat(bankReport.openingBalance);

      for (const line of bankReport.lines) {
        const d = parseFloat(line.debit);
        const c = parseFloat(line.credit);
        const expected = prevBal + d - c;
        expect(parseFloat(line.runningBalance)).toBeCloseTo(expected, 2);
        prevBal = expected;
      }

      expect(parseFloat(bankReport.closingBalance)).toBeCloseTo(prevBal, 2);
    });
  });

  // ========================================================
  // 8. Sales Invoice Feature Independence
  // ========================================================
  describe('8. Sales Invoice Feature Independence', () => {
    it('should compute Cash Book and Bank Book regardless of whether Sales Invoice is enabled or disabled', async () => {
      vi.mocked(prisma.accountLedger.findMany).mockResolvedValue([vaultCashLedger as any]);
      vi.mocked(prisma.accountLedger.findUnique).mockResolvedValue(vaultCashLedger as any);
      vi.mocked(prisma.journalLine.findMany).mockResolvedValue([]);

      // Test with Sales Invoice enabled
      previewStore.setCompanySettings({ salesInvoiceEnabled: true });
      const enabledReport = previewStore.getCashBook();
      expect(enabledReport).toBeDefined();
      expect(enabledReport.lines.length).toBeGreaterThanOrEqual(1);

      // Test with Sales Invoice disabled
      previewStore.setCompanySettings({ salesInvoiceEnabled: false });
      const disabledReport = previewStore.getCashBook();
      expect(disabledReport).toBeDefined();
      expect(disabledReport.lines.length).toBe(enabledReport.lines.length);
      expect(disabledReport.closingBalance).toBe(enabledReport.closingBalance);
    });
  });
});
