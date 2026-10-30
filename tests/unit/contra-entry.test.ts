import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContraService } from '../../src/server/services/contra.service.js';
import { CompanyService } from '../../src/server/services/company.service.js';
import {
  AuthUser,
  CreateContraEntryRequest,
  AccountLedgerItem,
} from '../../src/shared/types.js';
import { prisma } from '../../src/server/db/client.js';
import { previewStore } from '../../src/client/services/previewStore.js';
import { AccountingMath, Decimal } from '../../src/server/accounting/decimal-math.js';

vi.mock('../../src/server/db/client.js', () => ({
  prisma: {
    journalEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    accountLedger: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    fiscalPeriod: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    companySetting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => {
      if (typeof cb === 'function') {
        return cb(prisma);
      }
      return cb;
    }),
  },
}));

describe('Contra Entry Implementation - Stage 1 Unit & Accounting Tests', () => {
  const companyAId = 'comp-tenant-a';
  const companyBId = 'comp-tenant-b';

  const userA: AuthUser = {
    id: 'user-a-1',
    userId: 'user-a-1',
    companyId: companyAId,
    email: 'accountant@comp-a.com',
    fullName: 'Accountant Tenant A',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const cashLedgerA: any = {
    id: 'cash-a-1010',
    companyId: companyAId,
    code: '1010',
    name: 'Cash on Hand (Vault)',
    isActive: true,
    group: { id: 'grp-a-1', name: 'Current Assets', rootType: 'ASSET' },
  };

  const bankLedgerA1: any = {
    id: 'bank-a-1020',
    companyId: companyAId,
    code: '1020',
    name: 'Operating Bank Account (JPMorgan)',
    isActive: true,
    group: { id: 'grp-a-1', name: 'Current Assets', rootType: 'ASSET' },
  };

  const bankLedgerA2: any = {
    id: 'bank-a-1025',
    companyId: companyAId,
    code: '1025',
    name: 'Payroll Operating Bank (Silicon Valley Bank)',
    isActive: true,
    group: { id: 'grp-a-1', name: 'Current Assets', rootType: 'ASSET' },
  };

  const pettyCashLedgerA: any = {
    id: 'cash-a-1015',
    companyId: companyAId,
    code: '1015',
    name: 'Petty Cash Register (Front Desk Till)',
    isActive: true,
    group: { id: 'grp-a-1', name: 'Current Assets', rootType: 'ASSET' },
  };

  const inactiveLedgerA: any = {
    id: 'cash-a-inactive',
    companyId: companyAId,
    code: '1019',
    name: 'Closed Branch Petty Cash',
    isActive: false,
    group: { id: 'grp-a-1', name: 'Current Assets', rootType: 'ASSET' },
  };

  const receivableLedgerA: any = {
    id: 'ar-a-1030',
    companyId: companyAId,
    code: '1030',
    name: 'Accounts Receivable (Trade Debtors)',
    isActive: true,
    group: { id: 'grp-a-1', name: 'Current Assets', rootType: 'ASSET' },
  };

  const expenseLedgerA: any = {
    id: 'exp-a-5010',
    companyId: companyAId,
    code: '5010',
    name: 'Bank Fee Expense',
    isActive: true,
    group: { id: 'grp-a-5', name: 'Operating Expenses', rootType: 'EXPENSE' },
  };

  const cashLedgerB: any = {
    id: 'cash-b-1010',
    companyId: companyBId,
    code: '1010',
    name: 'Cash on Hand (Tenant B)',
    isActive: true,
    group: { id: 'grp-b-1', name: 'Current Assets', rootType: 'ASSET' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================
  // 1. Valid Transfers: All 4 Modalities
  // ========================================================
  describe('1. Valid Internal Transfers Across 4 Modalities', () => {
    it('should successfully record a Cash to Bank transfer (Cash Deposit)', async () => {
      vi.mocked(prisma.journalEntry.findUnique).mockResolvedValue(null);
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === cashLedgerA.id) return cashLedgerA;
        if (where.id === bankLedgerA1.id) return bankLedgerA1;
        return null;
      });
      vi.mocked(prisma.fiscalPeriod.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.journalEntry.count).mockResolvedValue(0);

      const createdMockJournal: any = {
        id: 'cv-created-1',
        companyId: companyAId,
        voucherNumber: 'CV-2026-0001',
        entryDate: new Date('2026-02-15'),
        fiscalPeriodId: null,
        narration: 'Deposit vault cash into main bank account',
        reference: 'DEP-101',
        status: 'POSTED',
        totalDebit: '3500.0000',
        totalCredit: '3500.0000',
        lines: [
          {
            id: 'line-1',
            ledgerId: bankLedgerA1.id,
            lineNumber: 1,
            debit: '3500.0000',
            credit: '0.0000',
            description: 'Contra Transfer To: Operating Bank Account (JPMorgan)',
            ledger: { code: '1020', name: bankLedgerA1.name },
          },
          {
            id: 'line-2',
            ledgerId: cashLedgerA.id,
            lineNumber: 2,
            debit: '0.0000',
            credit: '3500.0000',
            description: 'Contra Transfer From: Cash on Hand (Vault)',
            ledger: { code: '1010', name: cashLedgerA.name },
          },
        ],
        createdByUser: { fullName: userA.fullName },
        postedByUser: { fullName: userA.fullName },
        createdAt: new Date(),
      };
      vi.mocked(prisma.journalEntry.create).mockResolvedValue(createdMockJournal);

      const result = await ContraService.createContraEntry(userA, {
        entryDate: '2026-02-15',
        sourceLedgerId: cashLedgerA.id,
        destinationLedgerId: bankLedgerA1.id,
        amount: '3500.0000',
        reference: 'DEP-101',
        narration: 'Deposit vault cash into main bank account',
        autoPost: true,
      });

      expect(result.voucherNumber).toBe('CV-2026-0001');
      expect(result.contraType).toBe('CASH_TO_BANK');
      expect(result.sourceLedgerId).toBe(cashLedgerA.id);
      expect(result.destinationLedgerId).toBe(bankLedgerA1.id);
      expect(result.amount).toBe('3500.0000');
      expect(result.status).toBe('POSTED');

      // Verify Prisma create arguments: Destination debited, Source credited
      expect(prisma.journalEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            companyId: companyAId,
            voucherNumber: 'CV-2026-0001',
            totalDebit: '3500.0000',
            totalCredit: '3500.0000',
            status: 'POSTED',
            lines: {
              create: [
                expect.objectContaining({
                  ledgerId: bankLedgerA1.id,
                  debit: '3500.0000',
                  credit: '0.0000',
                }),
                expect.objectContaining({
                  ledgerId: cashLedgerA.id,
                  debit: '0.0000',
                  credit: '3500.0000',
                }),
              ],
            },
          }),
        })
      );
    });

    it('should successfully record a Bank to Cash transfer (Cash Withdrawal)', async () => {
      vi.mocked(prisma.journalEntry.findUnique).mockResolvedValue(null);
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === bankLedgerA1.id) return bankLedgerA1;
        if (where.id === pettyCashLedgerA.id) return pettyCashLedgerA;
        return null;
      });
      vi.mocked(prisma.journalEntry.count).mockResolvedValue(1);

      const createdMockJournal: any = {
        id: 'cv-created-2',
        companyId: companyAId,
        voucherNumber: 'CV-2026-0002',
        entryDate: new Date('2026-02-16'),
        status: 'POSTED',
        totalDebit: '1000.0000',
        totalCredit: '1000.0000',
        lines: [
          {
            id: 'line-1',
            ledgerId: pettyCashLedgerA.id,
            lineNumber: 1,
            debit: '1000.0000',
            credit: '0.0000',
            ledger: { code: '1015', name: pettyCashLedgerA.name },
          },
          {
            id: 'line-2',
            ledgerId: bankLedgerA1.id,
            lineNumber: 2,
            debit: '0.0000',
            credit: '1000.0000',
            ledger: { code: '1020', name: bankLedgerA1.name },
          },
        ],
        createdByUser: { fullName: userA.fullName },
        postedByUser: { fullName: userA.fullName },
        createdAt: new Date(),
      };
      vi.mocked(prisma.journalEntry.create).mockResolvedValue(createdMockJournal);

      const result = await ContraService.createContraEntry(userA, {
        entryDate: '2026-02-16',
        sourceLedgerId: bankLedgerA1.id,
        destinationLedgerId: pettyCashLedgerA.id,
        amount: '1000.0000',
        autoPost: true,
      });

      expect(result.voucherNumber).toBe('CV-2026-0002');
      expect(result.contraType).toBe('BANK_TO_CASH');
      expect(result.sourceLedgerId).toBe(bankLedgerA1.id);
      expect(result.destinationLedgerId).toBe(pettyCashLedgerA.id);
    });

    it('should successfully record a Bank to Bank transfer (Account Transfer)', async () => {
      vi.mocked(prisma.journalEntry.findUnique).mockResolvedValue(null);
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === bankLedgerA1.id) return bankLedgerA1;
        if (where.id === bankLedgerA2.id) return bankLedgerA2;
        return null;
      });
      vi.mocked(prisma.journalEntry.count).mockResolvedValue(2);

      const createdMockJournal: any = {
        id: 'cv-created-3',
        companyId: companyAId,
        voucherNumber: 'CV-2026-0003',
        entryDate: new Date('2026-02-17'),
        status: 'DRAFT',
        totalDebit: '20000.0000',
        totalCredit: '20000.0000',
        lines: [
          {
            id: 'line-1',
            ledgerId: bankLedgerA2.id,
            lineNumber: 1,
            debit: '20000.0000',
            credit: '0.0000',
            ledger: { code: '1025', name: bankLedgerA2.name },
          },
          {
            id: 'line-2',
            ledgerId: bankLedgerA1.id,
            lineNumber: 2,
            debit: '0.0000',
            credit: '20000.0000',
            ledger: { code: '1020', name: bankLedgerA1.name },
          },
        ],
        createdByUser: { fullName: userA.fullName },
        createdAt: new Date(),
      };
      vi.mocked(prisma.journalEntry.create).mockResolvedValue(createdMockJournal);

      const result = await ContraService.createContraEntry(userA, {
        entryDate: '2026-02-17',
        sourceLedgerId: bankLedgerA1.id,
        destinationLedgerId: bankLedgerA2.id,
        amount: '20000.0000',
        autoPost: false,
      });

      expect(result.voucherNumber).toBe('CV-2026-0003');
      expect(result.contraType).toBe('BANK_TO_BANK');
      expect(result.status).toBe('DRAFT');
    });

    it('should successfully record a Cash to Cash transfer (Till Replenishment)', async () => {
      vi.mocked(prisma.journalEntry.findUnique).mockResolvedValue(null);
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === cashLedgerA.id) return cashLedgerA;
        if (where.id === pettyCashLedgerA.id) return pettyCashLedgerA;
        return null;
      });
      vi.mocked(prisma.journalEntry.count).mockResolvedValue(3);

      const createdMockJournal: any = {
        id: 'cv-created-4',
        companyId: companyAId,
        voucherNumber: 'CV-2026-0004',
        entryDate: new Date('2026-02-18'),
        status: 'POSTED',
        totalDebit: '500.0000',
        totalCredit: '500.0000',
        lines: [
          {
            id: 'line-1',
            ledgerId: pettyCashLedgerA.id,
            lineNumber: 1,
            debit: '500.0000',
            credit: '0.0000',
            ledger: { code: '1015', name: pettyCashLedgerA.name },
          },
          {
            id: 'line-2',
            ledgerId: cashLedgerA.id,
            lineNumber: 2,
            debit: '0.0000',
            credit: '500.0000',
            ledger: { code: '1010', name: cashLedgerA.name },
          },
        ],
        createdByUser: { fullName: userA.fullName },
        postedByUser: { fullName: userA.fullName },
        createdAt: new Date(),
      };
      vi.mocked(prisma.journalEntry.create).mockResolvedValue(createdMockJournal);

      const result = await ContraService.createContraEntry(userA, {
        entryDate: '2026-02-18',
        sourceLedgerId: cashLedgerA.id,
        destinationLedgerId: pettyCashLedgerA.id,
        amount: '500.0000',
        autoPost: true,
      });

      expect(result.voucherNumber).toBe('CV-2026-0004');
      expect(result.contraType).toBe('CASH_TO_CASH');
      expect(result.amount).toBe('500.0000');
    });
  });

  // ========================================================
  // 2. Strict Validation & Invariant Enforcement
  // ========================================================
  describe('2. Strict Server-Side Validation & Invariants', () => {
    it('should reject when source and destination accounts are identical', async () => {
      await expect(
        ContraService.createContraEntry(userA, {
          entryDate: '2026-02-15',
          sourceLedgerId: cashLedgerA.id,
          destinationLedgerId: cashLedgerA.id,
          amount: '100.0000',
        })
      ).rejects.toThrow('Source and destination accounts must be different for a contra transfer.');
    });

    it('should reject zero or negative amounts', async () => {
      await expect(
        ContraService.createContraEntry(userA, {
          entryDate: '2026-02-15',
          sourceLedgerId: cashLedgerA.id,
          destinationLedgerId: bankLedgerA1.id,
          amount: '0.0000',
        })
      ).rejects.toThrow('Transfer amount must be strictly greater than zero.');

      await expect(
        ContraService.createContraEntry(userA, {
          entryDate: '2026-02-15',
          sourceLedgerId: cashLedgerA.id,
          destinationLedgerId: bankLedgerA1.id,
          amount: '-50.0000',
        })
      ).rejects.toThrow('Transfer amount must be strictly greater than zero.');
    });

    it('should reject inactive ledgers', async () => {
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === inactiveLedgerA.id) return inactiveLedgerA;
        if (where.id === bankLedgerA1.id) return bankLedgerA1;
        return null;
      });

      await expect(
        ContraService.createContraEntry(userA, {
          entryDate: '2026-02-15',
          sourceLedgerId: inactiveLedgerA.id,
          destinationLedgerId: bankLedgerA1.id,
          amount: '200.0000',
        })
      ).rejects.toThrow(/is inactive\. Inactive accounts cannot accept contra postings\./);
    });

    it('should reject non-asset root type ledgers (e.g. Expenses or Revenue)', async () => {
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === expenseLedgerA.id) return expenseLedgerA;
        if (where.id === bankLedgerA1.id) return bankLedgerA1;
        return null;
      });

      await expect(
        ContraService.createContraEntry(userA, {
          entryDate: '2026-02-15',
          sourceLedgerId: expenseLedgerA.id,
          destinationLedgerId: bankLedgerA1.id,
          amount: '200.0000',
        })
      ).rejects.toThrow(/Contra entries are restricted to liquid Asset accounts \(Cash and Bank\)/);
    });

    it('should reject ineligible asset ledgers (e.g. Accounts Receivable)', async () => {
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === receivableLedgerA.id) return receivableLedgerA;
        if (where.id === bankLedgerA1.id) return bankLedgerA1;
        return null;
      });

      await expect(
        ContraService.createContraEntry(userA, {
          entryDate: '2026-02-15',
          sourceLedgerId: receivableLedgerA.id,
          destinationLedgerId: bankLedgerA1.id,
          amount: '200.0000',
        })
      ).rejects.toThrow(/is not an eligible Cash or Bank account for Contra transfers/);
    });

    it('should enforce tenant isolation and reject cross-company ledgers', async () => {
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === cashLedgerB.id) return cashLedgerB; // belongs to company B!
        if (where.id === bankLedgerA1.id) return bankLedgerA1;
        return null;
      });

      await expect(
        ContraService.createContraEntry(userA, {
          entryDate: '2026-02-15',
          sourceLedgerId: cashLedgerB.id,
          destinationLedgerId: bankLedgerA1.id,
          amount: '200.0000',
        })
      ).rejects.toThrow('Source account ledger not found in this company.');
    });

    it('should reject contra entry posting into a closed or locked fiscal period', async () => {
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === cashLedgerA.id) return cashLedgerA;
        if (where.id === bankLedgerA1.id) return bankLedgerA1;
        return null;
      });

      vi.mocked(prisma.fiscalPeriod.findUnique).mockResolvedValue({
        id: 'closed-period-1',
        companyId: companyAId,
        periodName: 'FY2025-Q4',
        status: 'CLOSED',
        isLocked: true,
      } as any);

      await expect(
        ContraService.createContraEntry(userA, {
          entryDate: '2025-12-15',
          sourceLedgerId: cashLedgerA.id,
          destinationLedgerId: bankLedgerA1.id,
          amount: '500.0000',
          fiscalPeriodId: 'closed-period-1',
        })
      ).rejects.toThrow('Cannot record contra entry in closed fiscal period "FY2025-Q4".');
    });

    it('should prevent duplicate submission via idempotency key', async () => {
      const existingContra: any = {
        id: 'existing-contra-1',
        companyId: companyAId,
        voucherNumber: 'CV-2026-0001',
        idempotencyKey: 'idemp-key-xyz-123',
        entryDate: new Date('2026-02-15'),
        status: 'POSTED',
        totalDebit: '1000.0000',
        totalCredit: '1000.0000',
        lines: [
          {
            id: 'l1',
            ledgerId: bankLedgerA1.id,
            lineNumber: 1,
            debit: '1000.0000',
            credit: '0.0000',
            ledger: { code: '1020', name: bankLedgerA1.name },
          },
          {
            id: 'l2',
            ledgerId: cashLedgerA.id,
            lineNumber: 2,
            debit: '0.0000',
            credit: '1000.0000',
            ledger: { code: '1010', name: cashLedgerA.name },
          },
        ],
        createdByUser: { fullName: userA.fullName },
        createdAt: new Date(),
      };

      vi.mocked(prisma.journalEntry.findUnique).mockResolvedValue(existingContra);

      const result = await ContraService.createContraEntry(userA, {
        entryDate: '2026-02-15',
        sourceLedgerId: cashLedgerA.id,
        destinationLedgerId: bankLedgerA1.id,
        amount: '1000.0000',
        idempotencyKey: 'idemp-key-xyz-123',
      });

      // Returns existing record without creating a second one
      expect(result.id).toBe('existing-contra-1');
      expect(prisma.journalEntry.create).not.toHaveBeenCalled();
    });
  });

  // ========================================================
  // 3. Double-Entry Posting, Posting Action & Reversal Model
  // ========================================================
  describe('3. Double-Entry Engine & Reversal Mechanics', () => {
    it('should post a draft contra voucher atomically', async () => {
      const draftJournal: any = {
        id: 'cv-draft-1',
        companyId: companyAId,
        voucherNumber: 'CV-2026-0005',
        status: 'DRAFT',
        totalDebit: '4200.0000',
        totalCredit: '4200.0000',
        lines: [
          {
            id: 'l1',
            ledgerId: bankLedgerA1.id,
            lineNumber: 1,
            debit: '4200.0000',
            credit: '0.0000',
            ledger: { code: '1020', name: bankLedgerA1.name },
          },
          {
            id: 'l2',
            ledgerId: cashLedgerA.id,
            lineNumber: 2,
            debit: '0.0000',
            credit: '4200.0000',
            ledger: { code: '1010', name: cashLedgerA.name },
          },
        ],
        entryDate: new Date('2026-02-15'),
        createdByUser: { fullName: userA.fullName },
        createdAt: new Date(),
      };

      vi.mocked(prisma.journalEntry.findUnique).mockResolvedValue(draftJournal);
      vi.mocked(prisma.journalEntry.update).mockResolvedValue({
        ...draftJournal,
        status: 'POSTED',
        postedAt: new Date(),
        postedByUser: { fullName: userA.fullName },
      });

      const posted = await ContraService.postContraEntry(userA, 'cv-draft-1');

      expect(posted.status).toBe('POSTED');
      expect(prisma.journalEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cv-draft-1' },
          data: expect.objectContaining({ status: 'POSTED' }),
        })
      );
    });

    it('should reverse a posted contra entry with inverted lines and mark original as REVERSED', async () => {
      const postedJournal: any = {
        id: 'cv-posted-to-reverse',
        companyId: companyAId,
        voucherNumber: 'CV-2026-0001',
        status: 'POSTED',
        totalDebit: '3500.0000',
        totalCredit: '3500.0000',
        lines: [
          {
            id: 'l1',
            ledgerId: bankLedgerA1.id,
            lineNumber: 1,
            debit: new Decimal('3500.0000'),
            credit: new Decimal('0.0000'),
            ledger: { code: '1020', name: bankLedgerA1.name },
            description: 'Original Line 1',
          },
          {
            id: 'l2',
            ledgerId: cashLedgerA.id,
            lineNumber: 2,
            debit: new Decimal('0.0000'),
            credit: new Decimal('3500.0000'),
            ledger: { code: '1010', name: cashLedgerA.name },
            description: 'Original Line 2',
          },
        ],
        entryDate: new Date('2026-02-15'),
        createdByUser: { fullName: userA.fullName },
        postedByUser: { fullName: userA.fullName },
        createdAt: new Date(),
      };

      vi.mocked(prisma.journalEntry.findUnique).mockResolvedValue(postedJournal);
      vi.mocked(prisma.journalEntry.count).mockResolvedValue(5);

      const reversalCreated: any = {
        id: 'cv-reversal-1',
        companyId: companyAId,
        voucherNumber: 'CV-2026-0006',
        status: 'POSTED',
        totalDebit: '3500.0000',
        totalCredit: '3500.0000',
        reversalOfId: 'cv-posted-to-reverse',
        entryDate: new Date(),
        lines: [
          {
            id: 'rl1',
            ledgerId: bankLedgerA1.id,
            lineNumber: 1,
            debit: '0.0000',
            credit: '3500.0000', // Inverted from original line 1!
            ledger: { code: '1020', name: bankLedgerA1.name },
          },
          {
            id: 'rl2',
            ledgerId: cashLedgerA.id,
            lineNumber: 2,
            debit: '3500.0000', // Inverted from original line 2!
            credit: '0.0000',
            ledger: { code: '1010', name: cashLedgerA.name },
          },
        ],
        createdByUser: { fullName: userA.fullName },
        createdAt: new Date(),
      };

      const originalMarkedReversed: any = {
        ...postedJournal,
        status: 'REVERSED',
        reversedAt: new Date(),
        reversedByUser: { fullName: userA.fullName },
      };

      vi.mocked(prisma.journalEntry.create).mockResolvedValue(reversalCreated);
      vi.mocked(prisma.journalEntry.update).mockResolvedValue(originalMarkedReversed);

      const result = await ContraService.reverseContraEntry(
        userA,
        'cv-posted-to-reverse',
        'Customer deposit wire was recalled by bank'
      );

      expect(result.original.status).toBe('REVERSED');
      expect(result.reversal.status).toBe('POSTED');
      expect(result.reversal.voucherNumber).toBe('CV-2026-0006');
      expect(result.reversal.reversalOfId).toBe('cv-posted-to-reverse');

      // Verify the inversion: Source of original (Cash) is now debited in reversal!
      expect(result.reversal.destinationLedgerId).toBe(cashLedgerA.id);
      expect(result.reversal.sourceLedgerId).toBe(bankLedgerA1.id);
    });
  });

  // ========================================================
  // 4. Preview Mode In-Memory Behavior
  // ========================================================
  describe('4. Preview Mode Deterministic In-Memory Behavior', () => {
    beforeEach(() => {
      previewStore.reset();
    });

    it('should return initial demo contra entries in Preview Mode', () => {
      const entries = previewStore.getContraEntries();
      expect(entries.length).toBeGreaterThanOrEqual(3);

      const v1 = entries.find((e) => e.voucherNumber === 'CV-2026-0001');
      expect(v1).toBeDefined();
      expect(v1?.contraType).toBe('CASH_TO_BANK');
      expect(v1?.status).toBe('POSTED');
    });

    it('should create and post contra entry in Preview Mode memory without live API call', () => {
      const initialCount = previewStore.getContraEntries().length;

      const created = previewStore.createContraEntry({
        entryDate: '2026-02-20',
        sourceLedgerId: 'preview-ldr-1010',
        destinationLedgerId: 'preview-ldr-1020',
        amount: '1200.0000',
        contraType: 'CASH_TO_BANK',
        autoPost: true,
      });

      expect(created.voucherNumber).toMatch(/^CV-2026-\d{4}$/);
      expect(created.status).toBe('POSTED');
      expect(created.amount).toBe('1200.0000');
      expect(previewStore.getContraEntries().length).toBe(initialCount + 1);

      // Verify no database call was made
      expect(prisma.journalEntry.create).not.toHaveBeenCalled();
    });

    it('should reverse a posted contra entry in Preview Mode memory', () => {
      const res = previewStore.reverseContraEntry(
        'preview-contra-1',
        'Duplicate entry in demo simulation'
      );

      expect(res).not.toBeNull();
      expect(res?.original.status).toBe('REVERSED');
      expect(res?.reversal.status).toBe('POSTED');
      expect(res?.reversal.reversalOfId).toBe('preview-contra-1');
      expect(res?.reversal.voucherNumber).toMatch(/^CV-2026-/);
    });
  });

  // ========================================================
  // 5. Sales Invoice Independence (Requirement 8)
  // ========================================================
  describe('5. Sales Invoice Independence', () => {
    it('should allow contra entries when Sales Invoice is disabled for the company', async () => {
      // Simulate company having SALES_INVOICE_ENABLED = 'false'
      vi.mocked(prisma.companySetting.findUnique).mockResolvedValue({
        id: 'setting-1',
        companyId: companyAId,
        key: 'SALES_INVOICE_ENABLED',
        value: 'false',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const isSalesInvoiceEnabled = await CompanyService.isSalesInvoiceEnabled(companyAId);
      expect(isSalesInvoiceEnabled).toBe(false);

      // Setting up ledger mocks
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === cashLedgerA.id) return cashLedgerA;
        if (where.id === bankLedgerA1.id) return bankLedgerA1;
        return null;
      });
      vi.mocked(prisma.journalEntry.count).mockResolvedValue(0);

      const createdJournal: any = {
        id: 'cv-no-invoice-req',
        companyId: companyAId,
        voucherNumber: 'CV-2026-0001',
        entryDate: new Date('2026-02-15'),
        status: 'POSTED',
        totalDebit: '2500.0000',
        totalCredit: '2500.0000',
        lines: [
          {
            id: 'l1',
            ledgerId: bankLedgerA1.id,
            lineNumber: 1,
            debit: '2500.0000',
            credit: '0.0000',
            ledger: { code: '1020', name: bankLedgerA1.name },
          },
          {
            id: 'l2',
            ledgerId: cashLedgerA.id,
            lineNumber: 2,
            debit: '0.0000',
            credit: '2500.0000',
            ledger: { code: '1010', name: cashLedgerA.name },
          },
        ],
        createdByUser: { fullName: userA.fullName },
        postedByUser: { fullName: userA.fullName },
        createdAt: new Date(),
      };
      vi.mocked(prisma.journalEntry.create).mockResolvedValue(createdJournal);

      // Contra entry works completely without any invoice prerequisite
      const contraResult = await ContraService.createContraEntry(userA, {
        entryDate: '2026-02-15',
        sourceLedgerId: cashLedgerA.id,
        destinationLedgerId: bankLedgerA1.id,
        amount: '2500.0000',
        autoPost: true,
      });

      expect(contraResult.voucherNumber).toBe('CV-2026-0001');
      expect(contraResult.status).toBe('POSTED');
      expect(contraResult.amount).toBe('2500.0000');
    });
  });
});
