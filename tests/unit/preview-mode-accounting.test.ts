import { describe, it, expect, beforeEach } from 'vitest';
import {
  PREVIEW_ACCOUNT_GROUPS,
  PREVIEW_ACCOUNT_LEDGERS,
  PREVIEW_JOURNALS,
  PREVIEW_INVOICES,
  PREVIEW_RECEIPTS,
  PREVIEW_QUOTATIONS,
  PREVIEW_PAYROLL_PERIODS,
  PREVIEW_PAYSLIPS,
  previewStore,
} from '../../src/client/services/previewStore.ts';
import { AuthUser } from '../../src/shared/types.ts';

describe('CoreERP Preview Mode Accounting & Exploration Tests', () => {
  const previewUser: AuthUser = {
    id: 'preview-session-id',
    userId: 'preview-session-id',
    companyId: 'preview-company-id',
    email: 'preview_admin@preview.local',
    fullName: 'Temporary Preview Account — Not a Real Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
    isPreview: true,
  };

  beforeEach(() => {
    previewStore.reset();
  });

  describe('1. Read-Only Demo Chart of Accounts Data Integrity', () => {
    it('should provide all 5 standard account root groups (1000 to 5000)', () => {
      expect(PREVIEW_ACCOUNT_GROUPS).toHaveLength(5);

      const codes = PREVIEW_ACCOUNT_GROUPS.map((g) => g.code);
      expect(codes).toContain('1000'); // Assets
      expect(codes).toContain('2000'); // Liabilities
      expect(codes).toContain('3000'); // Equity
      expect(codes).toContain('4000'); // Income
      expect(codes).toContain('5000'); // Expenses

      const rootTypes = PREVIEW_ACCOUNT_GROUPS.map((g) => g.rootType);
      expect(rootTypes).toContain('ASSET');
      expect(rootTypes).toContain('LIABILITY');
      expect(rootTypes).toContain('EQUITY');
      expect(rootTypes).toContain('INCOME');
      expect(rootTypes).toContain('EXPENSE');
    });

    it('should provide sample ledgers for each of the 5 account root types', () => {
      expect(PREVIEW_ACCOUNT_LEDGERS.length).toBeGreaterThanOrEqual(5);

      const assetLedgers = PREVIEW_ACCOUNT_LEDGERS.filter((l) => l.rootType === 'ASSET');
      const liabilityLedgers = PREVIEW_ACCOUNT_LEDGERS.filter((l) => l.rootType === 'LIABILITY');
      const equityLedgers = PREVIEW_ACCOUNT_LEDGERS.filter((l) => l.rootType === 'EQUITY');
      const incomeLedgers = PREVIEW_ACCOUNT_LEDGERS.filter((l) => l.rootType === 'INCOME');
      const expenseLedgers = PREVIEW_ACCOUNT_LEDGERS.filter((l) => l.rootType === 'EXPENSE');

      expect(assetLedgers.length).toBeGreaterThanOrEqual(1);
      expect(liabilityLedgers.length).toBeGreaterThanOrEqual(1);
      expect(equityLedgers.length).toBeGreaterThanOrEqual(1);
      expect(incomeLedgers.length).toBeGreaterThanOrEqual(1);
      expect(expenseLedgers.length).toBeGreaterThanOrEqual(1);

      // Verify Debit/Credit balance nature correctness
      assetLedgers.forEach((l) => expect(l.openingBalanceType).toBe('DEBIT'));
      liabilityLedgers.forEach((l) => expect(l.openingBalanceType).toBe('CREDIT'));
      equityLedgers.forEach((l) => expect(l.openingBalanceType).toBe('CREDIT'));
      incomeLedgers.forEach((l) => expect(l.openingBalanceType).toBe('CREDIT'));
      expenseLedgers.forEach((l) => expect(l.openingBalanceType).toBe('DEBIT'));
    });
  });

  describe('2. Preview Mode Flag & Exploration Guard Verification', () => {
    it('should identify preview exploration user via currentUser.isPreview flag', () => {
      expect(previewUser.isPreview).toBe(true);
      expect(previewUser.email).toBe('preview_admin@preview.local');
    });

    it('should provide mock auth user with isPreview: true from previewStore', () => {
      const demoStaff = previewStore.createPreviewUser({
        fullName: 'Jane Doe',
        email: 'jane.demo@preview.local',
        role: 'ADMIN',
      });

      const mockAuth = previewStore.createMockAuthUser(demoStaff);
      expect(mockAuth.isPreview).toBe(true);
      expect(mockAuth.role).toBe('ADMIN');
    });
  });

  describe('3. Demo Journal, Billing & Payroll Data Verification', () => {
    it('should provide balanced demo double-entry journal vouchers', () => {
      expect(PREVIEW_JOURNALS.length).toBeGreaterThanOrEqual(1);
      PREVIEW_JOURNALS.forEach((j) => {
        expect(j.totalDebit).toBe(j.totalCredit);
        expect(j.lines.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('should provide sample commercial invoices with line items', () => {
      expect(PREVIEW_INVOICES.length).toBeGreaterThanOrEqual(1);
      const inv = PREVIEW_INVOICES[0];
      expect(inv.invoiceNumber).toMatch(/^INV-/);
      expect(inv.lines.length).toBeGreaterThanOrEqual(1);
      expect(parseFloat(inv.total)).toBeGreaterThan(0);
    });

    it('should provide sample customer receipts and quotations', () => {
      expect(PREVIEW_RECEIPTS.length).toBeGreaterThanOrEqual(1);
      expect(PREVIEW_QUOTATIONS.length).toBeGreaterThanOrEqual(1);

      const rct = PREVIEW_RECEIPTS[0];
      expect(rct.receiptNumber).toMatch(/^CR-/);
      expect(parseFloat(rct.amount)).toBeGreaterThan(0);

      const qt = PREVIEW_QUOTATIONS[0];
      expect(qt.quotationNumber).toMatch(/^QT-/);
      expect(parseFloat(qt.total)).toBeGreaterThan(0);
    });

    it('should provide sample payroll periods and computed payslips', () => {
      expect(PREVIEW_PAYROLL_PERIODS.length).toBeGreaterThanOrEqual(1);
      expect(PREVIEW_PAYSLIPS.length).toBeGreaterThanOrEqual(1);
      const slip = PREVIEW_PAYSLIPS[0];
      expect(parseFloat(slip.grossSalary)).toBeGreaterThan(0);
      expect(parseFloat(slip.netSalary)).toBeGreaterThan(0);
    });
  });

  describe('4. Mutual Consistency of In-Memory Financial Reports', () => {
    it('should maintain mutual consistency across Trial Balance, P&L, and Balance Sheet', () => {
      const tb = previewStore.getTrialBalance();
      expect(tb.isBalanced).toBe(true);
      expect(tb.reconciliationStatus).toBe('BALANCED');
      expect(parseFloat(tb.imbalanceAmount)).toBe(0);

      const pnl = previewStore.getProfitAndLoss();
      const bs = previewStore.getBalanceSheet();

      expect(bs.isBalanced).toBe(true);
      expect(parseFloat(bs.discrepancy)).toBe(0);
      expect(bs.currentPeriodProfit).toBe(pnl.netProfit);
      expect(parseFloat(bs.totalAssets)).toBeCloseTo(parseFloat(bs.totalLiabilitiesAndEquity), 4);
    });

    it('should match Cash and Bank Book closing balances with General Ledger statement closing balances', () => {
      const cashBook = previewStore.getCashBook();
      expect(cashBook.ledger).not.toBeNull();
      const cashLedgerId = cashBook.ledger!.id;
      const cashStatement = previewStore.getLedgerStatement(cashLedgerId);

      expect(cashBook.closingBalance).toBe(cashStatement.closingBalance);
      expect(cashBook.closingBalanceType).toBe(cashStatement.closingBalanceType);

      const bankBook = previewStore.getBankBook();
      expect(bankBook.ledger).not.toBeNull();
      const bankLedgerId = bankBook.ledger!.id;
      const bankStatement = previewStore.getLedgerStatement(bankLedgerId);

      expect(bankBook.closingBalance).toBe(bankStatement.closingBalance);
      expect(bankBook.closingBalanceType).toBe(bankStatement.closingBalanceType);
    });

    it('should exclude draft and reversed vouchers from effective report balances', () => {
      const initialTb = previewStore.getTrialBalance();
      const initialBank = previewStore.getBankBook();

      // Create a DRAFT voucher
      const draft = previewStore.createJournal({
        entryDate: '2026-02-10',
        narration: 'Draft unposted equipment purchase',
        lines: [
          { ledgerId: 'preview-ldr-1040', debit: '5000.0000', credit: '0.0000' },
          { ledgerId: 'preview-ldr-1020', debit: '0.0000', credit: '5000.0000' },
        ],
        autoPost: false,
      });

      expect(draft.status).toBe('DRAFT');

      // Verify that Trial Balance and Bank Book are completely unaffected by DRAFT
      const tbAfterDraft = previewStore.getTrialBalance();
      const bankAfterDraft = previewStore.getBankBook();

      expect(tbAfterDraft.totalClosingDebit).toBe(initialTb.totalClosingDebit);
      expect(bankAfterDraft.closingBalance).toBe(initialBank.closingBalance);

      // Now POST the voucher
      previewStore.postJournal(draft.id);
      const tbAfterPost = previewStore.getTrialBalance();
      const bankAfterPost = previewStore.getBankBook();

      expect(tbAfterPost.totalClosingDebit).not.toBe(initialTb.totalClosingDebit);
      expect(parseFloat(bankAfterPost.closingBalance)).toBe(
        parseFloat(initialBank.closingBalance) - 5000
      );

      // Now REVERSE the voucher
      previewStore.reverseJournal(draft.id, 'Test reversal in preview');
      const tbAfterReversal = previewStore.getTrialBalance();
      const bankAfterReversal = previewStore.getBankBook();

      // Balances should return to initial state
      expect(parseFloat(bankAfterReversal.closingBalance)).toBe(parseFloat(initialBank.closingBalance));
      expect(tbAfterReversal.isBalanced).toBe(true);
    });
  });

  describe('5. In-Memory Customer Receipts & Invoice Allocations', () => {
    it('should record customer receipt and reduce invoice balance due in memory', () => {
      const initialInvoices = previewStore.getInvoices({ customerId: 'preview-cust-1' });
      const targetInvoice = initialInvoices.find((i) => i.id === 'preview-inv-1');
      expect(targetInvoice).toBeDefined();

      const initialBalDue = parseFloat(targetInvoice!.balanceDue);
      const initialBankBook = previewStore.getBankBook();

      // Record a receipt allocated to this invoice
      const receipt = previewStore.createReceipt(
        {
          receiptDate: '2026-02-15',
          customerId: 'preview-cust-1',
          amount: '4500.0000',
          paymentMethod: 'BANK_TRANSFER',
          receivingLedgerId: 'preview-ldr-1020',
          allocations: [
            {
              invoiceId: 'preview-inv-1',
              amount: '4500.0000',
            },
          ],
        },
        previewUser
      );

      expect(receipt.status).toBe('POSTED');
      expect(receipt.journalVoucherNumber).toBeDefined();

      // Verify invoice was updated in memory
      const updatedInvoices = previewStore.getInvoices({ customerId: 'preview-cust-1' });
      const updatedInv = updatedInvoices.find((i) => i.id === 'preview-inv-1');
      expect(parseFloat(updatedInv!.balanceDue)).toBe(initialBalDue - 4500);
      expect(parseFloat(updatedInv!.amountPaid)).toBe(4500);
      expect(updatedInv!.status).toBe('PARTIALLY_PAID');

      // Verify Bank Book reflected the deposit
      const updatedBankBook = previewStore.getBankBook();
      expect(parseFloat(updatedBankBook.closingBalance)).toBe(
        parseFloat(initialBankBook.closingBalance) + 4500
      );

      // Now void the receipt
      previewStore.voidReceipt(receipt.id, 'Customer payment dishonored');
      const restoredInvoices = previewStore.getInvoices({ customerId: 'preview-cust-1' });
      const restoredInv = restoredInvoices.find((i) => i.id === 'preview-inv-1');
      expect(parseFloat(restoredInv!.balanceDue)).toBe(initialBalDue);
      expect(parseFloat(restoredInv!.amountPaid)).toBe(0);

      const restoredBankBook = previewStore.getBankBook();
      expect(parseFloat(restoredBankBook.closingBalance)).toBe(
        parseFloat(initialBankBook.closingBalance)
      );
    });
  });

  describe('6. Optional Sales Invoice Setting Independence', () => {
    it('should continue to generate all reports and allow contra transfers when Sales Invoice is disabled', () => {
      previewStore.setSalesInvoiceEnabled(false);
      expect(previewStore.getCompanySettings().salesInvoiceEnabled).toBe(false);

      // Financial Reports must remain 100% operational
      const tb = previewStore.getTrialBalance();
      expect(tb.isBalanced).toBe(true);

      const cashBook = previewStore.getCashBook();
      expect(cashBook.lines.length).toBeGreaterThanOrEqual(1);

      const bankBook = previewStore.getBankBook();
      expect(bankBook.lines.length).toBeGreaterThanOrEqual(1);

      // Contra Entries must remain 100% functional
      const newContra = previewStore.createContraEntry(
        {
          entryDate: '2026-02-18',
          sourceLedgerId: 'preview-ldr-1010',
          destinationLedgerId: 'preview-ldr-1020',
          amount: '1000.0000',
          autoPost: true,
        },
        previewUser
      );
      expect(newContra.status).toBe('POSTED');

      // Reports must still balance after contra transfer
      const tbAfterContra = previewStore.getTrialBalance();
      expect(tbAfterContra.isBalanced).toBe(true);
    });
  });

  describe('7. Tenant / Company ID Isolation', () => {
    it('should maintain companyId isolation across all in-memory created entities', () => {
      const coaGroup = previewStore.createAccountGroup({
        code: '1999',
        name: 'Demo Clearing Assets',
        rootType: 'ASSET',
      });
      expect(coaGroup.companyId).toBe('preview-company-id');

      const coaLedger = previewStore.createAccountLedger({
        groupId: coaGroup.id,
        name: 'Demo Escrow',
      });
      expect(coaLedger.companyId).toBe('preview-company-id');

      const journal = previewStore.createJournal({
        entryDate: '2026-02-20',
        narration: 'Demo journal',
        lines: [
          { ledgerId: coaLedger.id, debit: '100.0000', credit: '0.0000' },
          { ledgerId: 'preview-ldr-1010', debit: '0.0000', credit: '100.0000' },
        ],
      });
      expect(journal.companyId).toBe('preview-company-id');

      const customer = previewStore.createCustomer({
        code: 'CUST-DEMO',
        name: 'Demo Isolated Client',
      });
      expect(customer.companyId).toBe('preview-company-id');

      const quote = previewStore.createQuotation({
        customerName: 'Demo Isolated Client',
        quotationDate: '2026-02-20',
        validUntilDate: '2026-03-20',
        lines: [{ itemDescription: 'Service', quantity: 1, unitPrice: 500 }],
      });
      expect(quote.companyId).toBe('preview-company-id');

      const inv = previewStore.createInvoice({
        customerName: 'Demo Isolated Client',
        invoiceDate: '2026-02-20',
        dueDate: '2026-03-20',
        lines: [{ itemDescription: 'Service', quantity: 1, unitPrice: 500 }],
      });
      expect(inv.companyId).toBe('preview-company-id');

      const rct = previewStore.createReceipt({
        receiptDate: '2026-02-20',
        customerId: customer.id,
        amount: '500.0000',
        paymentMethod: 'CASH',
        receivingLedgerId: 'preview-ldr-1010',
        allocations: [],
      });
      expect(rct.companyId).toBe('preview-company-id');
    });
  });
});
