import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExpenseClaimService } from '../../src/server/services/expense-claim.service.js';
import { AuthUser, ExpenseClaimItem } from '../../src/shared/types.js';
import { prisma } from '../../src/server/db/client.js';

vi.mock('../../src/server/db/client.js', () => {
  return {
    prisma: {
      employee: {
        findFirst: vi.fn(),
      },
      accountLedger: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      accountGroup: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      fiscalPeriod: {
        findFirst: vi.fn(),
      },
      expenseClaim: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn(),
      },
      rolePermission: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      expenseClaimLine: {
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
      expenseClaimAttachment: {
        updateMany: vi.fn(),
        findUnique: vi.fn(),
      },
      expenseClaimEvent: {
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb) => {
        return cb(prisma);
      }),
    },
  };
});

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/server/services/document-sequence.service.js', () => ({
  DocumentSequenceService: {
    allocateNextNumber: vi.fn().mockResolvedValue({
      formattedNumber: 'EXP-2026-00001',
      sequenceNumber: 1,
      prefix: 'EXP',
      fiscalYear: '2026',
    }),
  },
}));

vi.mock('../../src/server/services/journal.service.js', () => ({
  JournalService: {
    createJournal: vi.fn().mockResolvedValue({
      id: 'mock-journal-uuid',
      voucherNumber: 'JV-2026-00001',
      status: 'POSTED',
    }),
  },
}));

describe('ExpenseClaimService - Lifecycle State Machine & Separation of Duties', () => {
  const companyId = '11111111-1111-1111-1111-111111111111';

  const employeeUser: AuthUser = {
    id: 'user-emp-01',
    userId: 'user-emp-01',
    companyId,
    email: 'alice@company.com',
    fullName: 'Alice Submitter',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const managerUser: AuthUser = {
    id: 'user-mgr-01',
    userId: 'user-mgr-01',
    companyId,
    email: 'bob@company.com',
    fullName: 'Bob Manager',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const accountsUser: AuthUser = {
    id: 'user-acc-01',
    userId: 'user-acc-01',
    companyId,
    email: 'carol@company.com',
    fullName: 'Carol Accounts',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.expenseClaim.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.rolePermission.findUnique as any).mockResolvedValue(null);
  });

  it('1. should successfully create a DRAFT expense claim with itemized lines', async () => {
    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-01',
      fullName: 'Alice Submitter',
      employeeCode: 'EMP-001',
      userId: employeeUser.id,
      companyId,
    });

    (prisma.fiscalPeriod.findFirst as any).mockResolvedValue({
      id: 'period-01',
      periodName: 'Jan 2026',
      status: 'OPEN',
      isLocked: false,
    });

    (prisma.expenseClaim.create as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      claimNumber: 'EXP-2026-00001',
      employeeId: 'emp-01',
      title: 'Sales Conference Trip',
      description: 'Flights and hotel',
      originalExpenseDate: new Date('2026-01-15'),
      currency: 'USD',
      totalAmount: 450.0,
      status: 'DRAFT',
      lines: [],
      attachments: [],
      events: [],
    });

    // Mock getClaimById call
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      claimNumber: 'EXP-2026-00001',
      employeeId: 'emp-01',
      title: 'Sales Conference Trip',
      description: 'Flights and hotel',
      originalExpenseDate: new Date('2026-01-15'),
      currency: 'USD',
      totalAmount: 450.0,
      status: 'DRAFT',
      lines: [
        {
          id: 'line-01',
          claimId: 'claim-01',
          companyId,
          category: 'TRAVEL',
          description: 'Flight to Chicago',
          expenseDate: new Date('2026-01-15'),
          amount: 350.0,
          merchant: 'United Airlines',
          expenseLedgerId: null,
          attachmentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'line-02',
          claimId: 'claim-01',
          companyId,
          category: 'MEALS',
          description: 'Airport Lunch',
          expenseDate: new Date('2026-01-15'),
          amount: 100.0,
          merchant: 'Airport Diner',
          expenseLedgerId: null,
          attachmentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      attachments: [],
      events: [
        {
          id: 'evt-01',
          claimId: 'claim-01',
          companyId,
          action: 'CREATED_DRAFT',
          fromStatus: null,
          toStatus: 'DRAFT',
          actorUserId: employeeUser.id,
          notes: 'Draft claim created',
          createdAt: new Date(),
          actorUser: { fullName: 'Alice Submitter' },
        },
      ],
      employee: {
        id: 'emp-01',
        fullName: 'Alice Submitter',
        employeeCode: 'EMP-001',
      },
    });

    const result = await ExpenseClaimService.createClaim(employeeUser, {
      title: 'Sales Conference Trip',
      description: 'Flights and hotel',
      originalExpenseDate: '2026-01-15',
      lines: [
        {
          category: 'TRAVEL',
          description: 'Flight to Chicago',
          expenseDate: '2026-01-15',
          amount: 350.0,
          merchant: 'United Airlines',
        },
        {
          category: 'MEALS',
          description: 'Airport Lunch',
          expenseDate: '2026-01-15',
          amount: 100.0,
          merchant: 'Airport Diner',
        },
      ],
      submitImmediately: false,
    });

    expect(result.claimNumber).toBe('EXP-2026-00001');
    expect(result.status).toBe('DRAFT');
    expect(result.totalAmount).toBe(450.0);
    expect(result.lines).toHaveLength(2);
  });

  it('2. should enforce separation of duties: Submitter CANNOT approve their own claim as Manager', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      claimNumber: 'EXP-2026-00001',
      employeeId: 'emp-01',
      status: 'SUBMITTED',
      employee: {
        id: 'emp-01',
        userId: employeeUser.id, // Alice is submitter
      },
    });

    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-01',
      userId: employeeUser.id,
      companyId,
    });

    // Alice attempts to review her own claim as manager
    await expect(
      ExpenseClaimService.reviewAsManager(employeeUser, 'claim-01', { decision: 'APPROVE' })
    ).rejects.toThrow('Separation of Duties violation: Submitter cannot approve their own expense claim as manager.');
  });

  it('3. should allow designated Manager to approve a SUBMITTED claim into MANAGER_APPROVED', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      claimNumber: 'EXP-2026-00001',
      employeeId: 'emp-01',
      title: 'Sales Conference Trip',
      originalExpenseDate: new Date('2026-01-15'),
      currency: 'USD',
      totalAmount: 450.0,
      status: 'SUBMITTED',
      employee: {
        id: 'emp-01',
        userId: employeeUser.id, // Alice is submitter
        fullName: 'Alice Submitter',
        employeeCode: 'EMP-001',
      },
      lines: [],
      attachments: [],
      events: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-02',
      userId: managerUser.id, // Bob is manager
      companyId,
    });

    await ExpenseClaimService.reviewAsManager(managerUser, 'claim-01', {
      decision: 'APPROVE',
      reason: 'Approved for client meeting travel',
    });

    expect(prisma.expenseClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'claim-01', companyId, status: 'SUBMITTED' }),
        data: expect.objectContaining({
          status: 'MANAGER_APPROVED',
          managerApprovedById: managerUser.id,
        }),
      })
    );
  });

  it('4. should enforce separation of duties: Manager who approved CANNOT perform Accounts approval', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      claimNumber: 'EXP-2026-00001',
      employeeId: 'emp-01',
      status: 'MANAGER_APPROVED',
      managerApprovedById: managerUser.id, // Bob approved as manager
      employee: {
        id: 'emp-01',
        userId: employeeUser.id,
      },
      lines: [],
    });

    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-02',
      userId: managerUser.id,
      companyId,
    });

    // Bob attempts to also perform Accounts approval
    await expect(
      ExpenseClaimService.reviewAsAccounts(managerUser, 'claim-01', { decision: 'APPROVE' })
    ).rejects.toThrow('Separation of Duties violation: The manager who approved this claim cannot also perform Accounts approval.');
  });

  it('5. should enforce separation of duties: Submitter CANNOT disburse reimbursement payout', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      claimNumber: 'EXP-2026-00001',
      employeeId: 'emp-01',
      status: 'ACCOUNTS_APPROVED',
      payableLedgerId: 'ledger-payable-01',
      totalAmount: 450.0,
      employee: {
        id: 'emp-01',
        userId: employeeUser.id, // Alice
        fullName: 'Alice Submitter',
      },
    });

    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-01',
      userId: employeeUser.id,
      companyId,
    });

    // Alice attempts to pay herself
    await expect(
      ExpenseClaimService.recordPayment(employeeUser, 'claim-01', {
        paymentMethod: 'BANK_TRANSFER',
      })
    ).rejects.toThrow('Separation of Duties violation: Submitter cannot disburse or record payout for their own expense claim.');
  });

  it('6. should reject review on claims not in the correct preceding state', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      status: 'DRAFT', // Still a draft
      employee: { id: 'emp-01', userId: employeeUser.id },
    });

    await expect(
      ExpenseClaimService.reviewAsManager(managerUser, 'claim-01', { decision: 'APPROVE' })
    ).rejects.toThrow('Manager review can only be performed on SUBMITTED claims. Current status: DRAFT.');
  });

  it('7. should return claim to DRAFT when returned for correction with notes', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      claimNumber: 'EXP-2026-00001',
      employeeId: 'emp-01',
      title: 'Sales Conference Trip',
      originalExpenseDate: new Date('2026-01-15'),
      currency: 'USD',
      totalAmount: 450.0,
      status: 'SUBMITTED',
      employee: { id: 'emp-01', userId: employeeUser.id, fullName: 'Alice', employeeCode: 'EMP-01' },
      lines: [],
      attachments: [],
      events: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-02',
      userId: managerUser.id,
      companyId,
    });

    await ExpenseClaimService.reviewAsManager(managerUser, 'claim-01', {
      decision: 'RETURN',
      reason: 'Please attach hotel receipt for night 2',
    });

    expect(prisma.expenseClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'claim-01', companyId, status: 'SUBMITTED' }),
        data: expect.objectContaining({
          status: 'DRAFT',
          returnReason: 'Please attach hotel receipt for night 2',
        }),
      })
    );
  });

  it('8. should allow owner to update a DRAFT claim and reject editing a SUBMITTED claim', async () => {
    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-01',
      userId: employeeUser.id,
      companyId,
    });

    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      claimNumber: 'EXP-2026-00001',
      employeeId: 'emp-01',
      title: 'Initial Draft',
      description: 'Original notes',
      originalExpenseDate: new Date('2026-01-15'),
      currency: 'USD',
      totalAmount: 100.0,
      status: 'DRAFT',
      managerId: null,
      employee: { id: 'emp-01', userId: employeeUser.id, fullName: 'Alice', employeeCode: 'EMP-01' },
      lines: [],
      attachments: [],
      events: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await ExpenseClaimService.updateClaim(employeeUser, 'claim-01', {
      title: 'Updated Draft Title',
      lines: [
        {
          category: 'MEALS',
          description: 'Team dinner',
          expenseDate: '2026-01-15',
          amount: 125.5,
        },
      ],
    });

    expect(prisma.expenseClaimLine.deleteMany).toHaveBeenCalledWith({ where: { claimId: 'claim-01' } });
    expect(prisma.expenseClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'claim-01', companyId, status: 'DRAFT' }),
        data: expect.objectContaining({
          title: 'Updated Draft Title',
        }),
      })
    );

    // Attempt to update a SUBMITTED claim must fail
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      employeeId: 'emp-01',
      status: 'SUBMITTED',
      employee: { id: 'emp-01', userId: employeeUser.id },
    });

    await expect(
      ExpenseClaimService.updateClaim(employeeUser, 'claim-01', { title: 'Tampered' })
    ).rejects.toThrow('Only claims in DRAFT status can be modified. Current status is SUBMITTED.');
  });

  it('9. should allow cancelling DRAFT or SUBMITTED claims and reject cancelling PAID claims', async () => {
    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-01',
      userId: employeeUser.id,
      companyId,
    });

    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      claimNumber: 'EXP-2026-00001',
      employeeId: 'emp-01',
      title: 'Draft Trip',
      originalExpenseDate: new Date('2026-01-15'),
      currency: 'USD',
      totalAmount: 100.0,
      status: 'SUBMITTED',
      employee: { id: 'emp-01', userId: employeeUser.id, fullName: 'Alice', employeeCode: 'EMP-01' },
      lines: [],
      attachments: [],
      events: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await ExpenseClaimService.cancelClaim(employeeUser, 'claim-01', 'Duplicate submission');

    expect(prisma.expenseClaim.updateMany).toHaveBeenCalledWith({
      where: { id: 'claim-01', companyId, status: 'SUBMITTED' },
      data: { status: 'CANCELLED' },
    });

    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-01',
      companyId,
      employeeId: 'emp-01',
      status: 'PAID',
      employee: { id: 'emp-01', userId: employeeUser.id },
    });

    await expect(ExpenseClaimService.cancelClaim(employeeUser, 'claim-01')).rejects.toThrow(
      'Cannot cancel claim with status PAID. Only DRAFT or SUBMITTED claims can be cancelled.'
    );
  });

  it('10. should reject claim creation when actor has no linked employee profile (no fallback hijacking)', async () => {
    (prisma.employee.findFirst as any).mockResolvedValue(null);

    await expect(
      ExpenseClaimService.createClaim(accountsUser, {
        title: 'Admin Claim Without Profile',
        originalExpenseDate: '2026-01-15',
        lines: [
          {
            category: 'TRAVEL',
            description: 'Taxi',
            expenseDate: '2026-01-15',
            amount: 25.0,
          },
        ],
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('No employee record found for your user account'),
    });
  });

  it('11. should enforce manager assignment authorization and reject wrong or unassigned reviewers', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-assigned',
      companyId,
      claimNumber: 'EXP-2026-00002',
      employeeId: 'emp-01',
      managerId: 'emp-assigned-mgr',
      status: 'SUBMITTED',
      employee: { id: 'emp-01', userId: employeeUser.id, fullName: 'Alice' },
      lines: [],
      attachments: [],
      events: [],
    });

    // Different ADMIN whose employeeId !== emp-assigned-mgr
    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-other-admin',
      userId: managerUser.id,
      companyId,
    });

    await expect(
      ExpenseClaimService.reviewAsManager(managerUser, 'claim-assigned', { decision: 'APPROVE' })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('assigned to a different reviewing manager'),
    });

    // EMPLOYEE without assignment on an unassigned claim
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-unassigned',
      companyId,
      employeeId: 'emp-01',
      managerId: null,
      status: 'SUBMITTED',
      employee: { id: 'emp-01', userId: employeeUser.id },
    });

    const otherEmployee: AuthUser = { ...employeeUser, id: 'user-emp-99', userId: 'user-emp-99' };
    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-99',
      userId: 'user-emp-99',
      companyId,
    });

    await expect(
      ExpenseClaimService.reviewAsManager(otherEmployee, 'claim-unassigned', { decision: 'APPROVE' })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('explicitly assigned to them as manager'),
    });
  });

  it('12. should strictly enforce queue RBAC and employee scoping in listClaims', async () => {
    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-01',
      userId: employeeUser.id,
      companyId,
    });
    (prisma.expenseClaim.findMany as any).mockResolvedValue([]);

    // EMPLOYEE cannot access accounts queue
    await expect(
      ExpenseClaimService.listClaims(employeeUser, { queue: 'accounts' })
    ).rejects.toMatchObject({ statusCode: 403 });

    // EMPLOYEE without EXPENSE:APPROVE cannot access manager queue
    await expect(
      ExpenseClaimService.listClaims(employeeUser, { queue: 'manager' })
    ).rejects.toMatchObject({ statusCode: 403 });

    // EMPLOYEE querying with another employeeId filter must stay locked to own employeeId
    await ExpenseClaimService.listClaims(employeeUser, { employeeId: 'emp-other-999' });
    expect(prisma.expenseClaim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId,
          employeeId: 'emp-01',
        }),
      })
    );
  });

  it('13. should scope summary report strictly to actor employeeId for EMPLOYEE role', async () => {
    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-01',
      userId: employeeUser.id,
      companyId,
    });
    (prisma.expenseClaim.findMany as any).mockResolvedValue([]);

    await ExpenseClaimService.getSummaryReport(employeeUser);

    expect(prisma.expenseClaim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId, employeeId: 'emp-01' },
      })
    );

    // If EMPLOYEE has no employee record, return empty zero report without querying all company claims
    vi.clearAllMocks();
    (prisma.employee.findFirst as any).mockResolvedValue(null);
    const emptySummary = await ExpenseClaimService.getSummaryReport(employeeUser);
    expect(emptySummary.totalClaimsCount).toBe(0);
    expect(prisma.expenseClaim.findMany).not.toHaveBeenCalled();
  });

  it('14. should throw 409 Conflict when concurrent state transition returns updateMany count 0', async () => {
    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-race',
      companyId,
      claimNumber: 'EXP-2026-00088',
      employeeId: 'emp-01',
      status: 'SUBMITTED',
      employee: { id: 'emp-01', userId: employeeUser.id },
    });
    (prisma.employee.findFirst as any).mockResolvedValue({
      id: 'emp-02',
      userId: managerUser.id,
      companyId,
    });
    (prisma.expenseClaim.updateMany as any).mockResolvedValue({ count: 0 });

    await expect(
      ExpenseClaimService.reviewAsManager(managerUser, 'claim-race', { decision: 'APPROVE' })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('concurrently'),
    });
  });
});
