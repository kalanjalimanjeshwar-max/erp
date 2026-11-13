import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExpenseClaimService } from '../../src/server/services/expense-claim.service.js';
import { AuthUser } from '../../src/shared/types.js';
import { prisma } from '../../src/server/db/client.js';
import { JournalService } from '../../src/server/services/journal.service.js';

vi.mock('../../src/server/db/client.js', () => ({
  prisma: {
    employee: { findFirst: vi.fn() },
    accountLedger: { findFirst: vi.fn(), create: vi.fn() },
    accountGroup: { findFirst: vi.fn(), create: vi.fn() },
    fiscalPeriod: { findFirst: vi.fn() },
    expenseClaim: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    expenseClaimEvent: { create: vi.fn() },
    companyBankAccount: { findFirst: vi.fn() },
    $transaction: vi.fn(async (cb) => cb(prisma)),
  },
}));

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: { log: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/server/services/journal.service.js', () => ({
  JournalService: {
    createJournal: vi.fn().mockResolvedValue({
      id: 'mock-journal-uuid',
      voucherNumber: 'JV-2026-00045',
      status: 'POSTED',
    }),
  },
}));

describe('ExpenseClaimService - Accounts Payable Double-Entry Accounting', () => {
  const companyId = '22222222-2222-2222-2222-222222222222';

  const accountsUser: AuthUser = {
    id: 'user-accounts-01',
    userId: 'user-accounts-01',
    companyId,
    email: 'finance@company.com',
    fullName: 'Finley Accounts',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.expenseClaim.updateMany as any).mockResolvedValue({ count: 1 });
  });

  it('1. should reject accounts approval if fiscal period covering originalExpenseDate is LOCKED or CLOSED', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-101',
      companyId,
      claimNumber: 'EXP-2025-0099',
      employeeId: 'emp-submitter',
      status: 'MANAGER_APPROVED',
      originalExpenseDate: new Date('2025-11-10'),
      managerApprovedById: 'mgr-01', // Different from accountsUser
      employee: { id: 'emp-submitter', userId: 'user-submitter-99' },
      lines: [{ id: 'l-1', category: 'TRAVEL', description: 'Flight', amount: 100 }],
    });

    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-finance',
      userId: accountsUser.id,
      companyId,
    });

    // Mock fiscal period is CLOSED
    (prisma.fiscalPeriod.findFirst as any).mockResolvedValue({
      id: 'period-nov-2025',
      periodName: 'Nov 2025',
      status: 'CLOSED',
      isLocked: true,
      startDate: new Date('2025-11-01'),
      endDate: new Date('2025-11-30'),
    });

    await expect(
      ExpenseClaimService.reviewAsAccounts(accountsUser, 'claim-101', { decision: 'APPROVE' })
    ).rejects.toThrow('Cannot process expense claim for date 2025-11-10: Linked fiscal period "Nov 2025" is closed and locked.');
  });

  it('2. should post double-entry Journal Voucher to Accounts Payable (Credit) and Expense Ledgers (Debit) on Accounts Approval', async () => {
    const originalDate = new Date('2026-02-14');

    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-202',
      companyId,
      claimNumber: 'EXP-2026-00045',
      employeeId: 'emp-submitter',
      title: 'Marketing Expo Materials',
      status: 'MANAGER_APPROVED',
      originalExpenseDate: originalDate,
      totalAmount: 320.0,
      managerApprovedById: 'mgr-01',
      employee: {
        id: 'emp-submitter',
        userId: 'user-submitter-99',
        fullName: 'Jane Submitter',
        employeeCode: 'EMP-045',
      },
      lines: [
        {
          id: 'line-1',
          category: 'OFFICE_SUPPLIES',
          description: 'Banner Printing',
          amount: 200.0,
          expenseLedgerId: 'ledger-printing',
        },
        {
          id: 'line-2',
          category: 'MEALS',
          description: 'Client Lunch at Expo',
          amount: 120.0,
          expenseLedgerId: 'ledger-meals',
        },
      ],
      attachments: [],
      events: [],
    });

    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-finance',
      userId: accountsUser.id,
      companyId,
    });

    // Fiscal period is OPEN
    (prisma.fiscalPeriod.findFirst as any).mockResolvedValue({
      id: 'period-q1-2026',
      periodName: 'Q1 2026',
      status: 'OPEN',
      isLocked: false,
    });

    // Accounts Payable & Expense ledgers
    (prisma.accountLedger.findFirst as any).mockImplementation(({ where }: any) => {
      if (where?.id === 'ledger-printing') {
        return Promise.resolve({
          id: 'ledger-printing',
          name: 'Printing & Supplies',
          isActive: true,
          group: { rootType: 'EXPENSE' },
        });
      }
      if (where?.id === 'ledger-meals') {
        return Promise.resolve({
          id: 'ledger-meals',
          name: 'Meals & Entertainment',
          isActive: true,
          group: { rootType: 'EXPENSE' },
        });
      }
      return Promise.resolve({
        id: 'ledger-ap-liability',
        name: 'Employee Reimbursements Payable',
        isActive: true,
        group: { rootType: 'LIABILITY' },
      });
    });

    await ExpenseClaimService.reviewAsAccounts(accountsUser, 'claim-202', { decision: 'APPROVE' });

    // Verify atomic transition
    expect(prisma.expenseClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'claim-202', companyId, status: 'MANAGER_APPROVED' },
        data: expect.objectContaining({
          status: 'ACCOUNTS_APPROVED',
          payableLedgerId: 'ledger-ap-liability',
        }),
      })
    );

    // Verify createJournal was invoked with correct balanced lines, idempotency key, and tx client
    expect(JournalService.createJournal).toHaveBeenCalledWith(
      accountsUser,
      expect.objectContaining({
        entryDate: '2026-02-14',
        fiscalPeriodId: 'period-q1-2026',
        reference: 'EXP-2026-00045',
        idempotencyKey: 'EXPENSE_AP:claim-202',
        autoPost: true,
        lines: [
          {
            ledgerId: 'ledger-printing',
            debit: '200.0000',
            credit: '0.0000',
            description: 'OFFICE_SUPPLIES: Banner Printing',
          },
          {
            ledgerId: 'ledger-meals',
            debit: '120.0000',
            credit: '0.0000',
            description: 'MEALS: Client Lunch at Expo',
          },
          {
            ledgerId: 'ledger-ap-liability',
            debit: '0.0000',
            credit: '320.0000',
            description: 'Payable for EXP-2026-00045 (Jane Submitter)',
          },
        ],
      }),
      undefined,
      expect.anything()
    );

    // Verify journalEntryId linked back to claim
    expect(prisma.expenseClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'claim-202' },
        data: { journalEntryId: 'mock-journal-uuid' },
      })
    );
  });

  it('3. should post reimbursement payment: Debit Accounts Payable Liability and Credit Bank/Cash Asset account', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-303',
      companyId,
      claimNumber: 'EXP-2026-00077',
      employeeId: 'emp-submitter',
      title: 'Tools and Hardware',
      status: 'ACCOUNTS_APPROVED',
      totalAmount: 180.0,
      payableLedgerId: 'ledger-ap-liability',
      employee: {
        id: 'emp-submitter',
        userId: 'user-submitter-99',
        fullName: 'Jane Submitter',
      },
      lines: [],
      attachments: [],
      events: [],
    });

    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-finance',
      userId: accountsUser.id,
      companyId,
    });

    (prisma.fiscalPeriod.findFirst as any).mockResolvedValue({
      id: 'period-q1-2026',
      periodName: 'Q1 2026',
      status: 'OPEN',
      isLocked: false,
    });

    (prisma.accountLedger.findFirst as any).mockResolvedValue({
      id: 'ledger-bank-asset',
      name: 'Corporate Checking Account',
      isActive: true,
      group: { rootType: 'ASSET' },
    });

    await ExpenseClaimService.recordPayment(accountsUser, 'claim-303', {
      paymentMethod: 'BANK_TRANSFER',
      paymentReference: 'WIRE-2026-7890',
      paymentDate: '2026-02-20',
    });

    // Verify atomic status transition
    expect(prisma.expenseClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'claim-303', companyId, status: 'ACCOUNTS_APPROVED' },
        data: expect.objectContaining({
          status: 'PAID',
          paymentMethod: 'BANK_TRANSFER',
          paymentReference: 'WIRE-2026-7890',
        }),
      })
    );

    // Verify reimbursement double-entry journal lines, idempotency key, and tx client
    expect(JournalService.createJournal).toHaveBeenCalledWith(
      accountsUser,
      expect.objectContaining({
        entryDate: '2026-02-20',
        fiscalPeriodId: 'period-q1-2026',
        reference: 'WIRE-2026-7890',
        idempotencyKey: 'EXPENSE_PAY:claim-303',
        autoPost: true,
        lines: [
          {
            ledgerId: 'ledger-ap-liability',
            debit: '180.0000',
            credit: '0.0000',
            description: 'Settle payable for EXP-2026-00077',
          },
          {
            ledgerId: 'ledger-bank-asset',
            debit: '0.0000',
            credit: '180.0000',
            description: 'Payment to Jane Submitter via BANK_TRANSFER',
          },
        ],
      }),
      undefined,
      expect.anything()
    );

    // Verify paymentJournalEntryId linked back to claim
    expect(prisma.expenseClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'claim-303' },
        data: { paymentJournalEntryId: 'mock-journal-uuid' },
      })
    );
  });

  it('4. should prevent duplicate AP journal posting on concurrent accounts approval (409 Conflict)', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-race-ap',
      companyId,
      claimNumber: 'EXP-2026-00088',
      employeeId: 'emp-submitter',
      status: 'MANAGER_APPROVED',
      originalExpenseDate: new Date('2026-02-14'),
      totalAmount: 100.0,
      managerApprovedById: 'mgr-01',
      employee: { id: 'emp-submitter', userId: 'user-submitter-99', fullName: 'Jane' },
      lines: [{ id: 'l-1', category: 'MEALS', description: 'Lunch', amount: 100 }],
    });
    (prisma.employee.findFirst as any).mockResolvedValue({ id: 'emp-fin', userId: accountsUser.id, companyId });
    (prisma.fiscalPeriod.findFirst as any).mockResolvedValue({ id: 'p-1', status: 'OPEN', isLocked: false });
    (prisma.accountLedger.findFirst as any).mockResolvedValue({
      id: 'ledger-default',
      name: 'Default',
      isActive: true,
      group: { rootType: 'LIABILITY' },
    });
    (prisma.expenseClaim.updateMany as any).mockResolvedValue({ count: 0 });

    await expect(
      ExpenseClaimService.reviewAsAccounts(accountsUser, 'claim-race-ap', { decision: 'APPROVE' })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(JournalService.createJournal).not.toHaveBeenCalled();
  });

  it('5. should prevent duplicate payout journal posting on concurrent payment disbursement (409 Conflict)', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-race-pay',
      companyId,
      claimNumber: 'EXP-2026-00089',
      employeeId: 'emp-submitter',
      status: 'ACCOUNTS_APPROVED',
      totalAmount: 150.0,
      payableLedgerId: 'ledger-ap',
      employee: { id: 'emp-submitter', userId: 'user-submitter-99', fullName: 'Jane' },
      lines: [],
    });
    (prisma.employee.findFirst as any).mockResolvedValue({ id: 'emp-fin', userId: accountsUser.id, companyId });
    (prisma.fiscalPeriod.findFirst as any).mockResolvedValue({ id: 'p-1', status: 'OPEN', isLocked: false });
    (prisma.accountLedger.findFirst as any).mockResolvedValue({
      id: 'ledger-bank',
      name: 'Bank',
      isActive: true,
      group: { rootType: 'ASSET' },
    });
    (prisma.expenseClaim.updateMany as any).mockResolvedValue({ count: 0 });

    await expect(
      ExpenseClaimService.recordPayment(accountsUser, 'claim-race-pay', { paymentMethod: 'BANK_TRANSFER' })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(JournalService.createJournal).not.toHaveBeenCalled();
  });

  it('6. should reject explicit wrong-rootType or inactive ledgers and inactive bank accounts (400 Bad Request)', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-bad-ledger',
      companyId,
      claimNumber: 'EXP-2026-00090',
      employeeId: 'emp-submitter',
      status: 'MANAGER_APPROVED',
      originalExpenseDate: new Date('2026-02-14'),
      totalAmount: 100.0,
      managerApprovedById: 'mgr-01',
      employee: { id: 'emp-submitter', userId: 'user-submitter-99', fullName: 'Jane' },
      lines: [{ id: 'l-1', category: 'TRAVEL', description: 'Cab', amount: 100 }],
    });
    (prisma.employee.findFirst as any).mockResolvedValue({ id: 'emp-fin', userId: accountsUser.id, companyId });
    (prisma.fiscalPeriod.findFirst as any).mockResolvedValue({ id: 'p-1', status: 'OPEN', isLocked: false });

    // Provide an ASSET ledger where LIABILITY payableLedgerId is required
    (prisma.accountLedger.findFirst as any).mockImplementation(({ where }: any) => {
      if (where?.id === 'bad-payable-asset') {
        return Promise.resolve({
          id: 'bad-payable-asset',
          name: 'Cash On Hand',
          isActive: true,
          group: { rootType: 'ASSET' },
        });
      }
      return Promise.resolve({
        id: 'default-ledger',
        name: 'Default',
        isActive: true,
        group: { rootType: 'LIABILITY' },
      });
    });

    await expect(
      ExpenseClaimService.reviewAsAccounts(accountsUser, 'claim-bad-ledger', {
        decision: 'APPROVE',
        payableLedgerId: 'bad-payable-asset',
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('must belong to a LIABILITY account group'),
    });

    // Inactive bankAccountId during recordPayment must reject with 400
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-bad-bank',
      companyId,
      claimNumber: 'EXP-2026-00091',
      employeeId: 'emp-submitter',
      status: 'ACCOUNTS_APPROVED',
      totalAmount: 100.0,
      payableLedgerId: 'ledger-ap',
      employee: { id: 'emp-submitter', userId: 'user-submitter-99', fullName: 'Jane' },
    });
    (prisma.companyBankAccount.findFirst as any).mockResolvedValue({
      id: 'bank-acc-inactive',
      bankName: 'Closed Bank',
      isActive: false,
    });

    await expect(
      ExpenseClaimService.recordPayment(accountsUser, 'claim-bad-bank', {
        paymentMethod: 'BANK_TRANSFER',
        bankAccountId: 'bank-acc-inactive',
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('is inactive'),
    });
  });
});
