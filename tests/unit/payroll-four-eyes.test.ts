import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { PayrollService } from '../../src/server/services/payroll.service.js';
import { PermissionService } from '../../src/server/services/permission.service.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { JournalService } from '../../src/server/services/journal.service.js';
import { AuthUser } from '../../src/shared/types.js';

describe('SEC-11-03: Four-Eyes Dual Approval for Payroll Finalization', () => {
  const companyA = 'company-alpha-1111-1111-1111-111111111111';
  const companyB = 'company-beta-2222-2222-2222-222222222222';

  // Accounts Approver (Option A: has ACCOUNTING:APPROVE)
  const accountsUser: AuthUser = {
    id: 'user-accounts-101',
    userId: 'user-accounts-101',
    companyId: companyA,
    email: 'accounts@alpha.corp',
    fullName: 'Alice Accounts',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  // Distinct Admin Approver (has PAYROLL:APPROVE)
  const adminPosterUser: AuthUser = {
    id: 'user-admin-202',
    userId: 'user-admin-202',
    companyId: companyA,
    email: 'payroll.admin@alpha.corp',
    fullName: 'Bob Payroll Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  // Super Admin
  const superAdminUser: AuthUser = {
    id: 'user-superadmin-303',
    userId: 'user-superadmin-303',
    companyId: companyA,
    email: 'superadmin@alpha.corp',
    fullName: 'Samantha SuperAdmin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  // Employee (lacks approvals)
  const employeeUser: AuthUser = {
    id: 'user-employee-404',
    userId: 'user-employee-404',
    companyId: companyA,
    email: 'employee@alpha.corp',
    fullName: 'Evan Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  // Foreign Company User
  const foreignUser: AuthUser = {
    id: 'user-foreign-999',
    userId: 'user-foreign-999',
    companyId: companyB,
    email: 'finance@beta.corp',
    fullName: 'Frank Foreign',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  function createMockPeriod(overrides: Record<string, unknown> = {}) {
    return {
      id: 'period-mock-id',
      companyId: companyA,
      name: 'May 2026',
      month: 5,
      year: 2026,
      status: 'PROCESSED',
      startDate: new Date('2026-05-01'),
      endDate: new Date('2026-05-31'),
      totalGross: '10000.00',
      totalDeductions: '500.00',
      totalNet: '9500.00',
      payslipsCount: 1,
      accountsApprovedAt: null,
      accountsApprovedByUserId: null,
      accountsApprovalNotes: null,
      adminApprovedAt: null,
      adminApprovedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      payslips: [
        {
          id: 'ps-1',
          grossSalary: '10000.00',
          netSalary: '9500.00',
          deductions: '500.00',
          employee: { id: 'emp-1', fullName: 'Alice', employeeCode: 'EMP001', ledgerId: 'ldr-emp-1' },
        },
      ],
      ...overrides,
    };
  }

  const app = createApp();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as any);
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.accountLedger, 'findFirst').mockResolvedValue({
      id: 'default-ledger-id',
      code: '5010',
      name: 'Salaries Expense',
      isActive: true,
      companyId: companyA,
    } as any);
    vi.spyOn(prisma.accountLedger, 'findUnique').mockResolvedValue({
      id: 'default-ledger-id',
      code: '5010',
      name: 'Salaries Expense',
      isActive: true,
      companyId: companyA,
    } as any);
  });

  // --------------------------------------------------------------------------
  // Requirement 1 & 2: Accounts Approver Qualification & Rejection
  // --------------------------------------------------------------------------
  describe('1 & 2: Accounts Approver Qualification (Option A: ACCOUNTING:APPROVE)', () => {
    it('1. should allow a user with ACCOUNTING:APPROVE to approve a PROCESSED period', async () => {
      const periodId = 'period-p1-processed';
      const existingPeriod = createMockPeriod({
        id: periodId,
        status: 'PROCESSED',
      });

      const updatedPeriod = {
        ...existingPeriod,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedAt: new Date(),
        accountsApprovedByUserId: accountsUser.id,
        accountsApprovalNotes: 'Reconciled attendance',
      };

      vi.spyOn(prisma.payrollPeriod, 'findUnique')
        .mockResolvedValueOnce(existingPeriod as any)
        .mockResolvedValueOnce(updatedPeriod as any);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue(existingPeriod),
            update: vi.fn().mockResolvedValue(updatedPeriod),
          },
        };
        return callback(txMock);
      });

      const result = await PayrollService.approveAccounts(
        accountsUser,
        periodId,
        'Reconciled attendance'
      );

      expect(result).toBeDefined();
      expect(result.status).toBe('ACCOUNTS_APPROVED');
      expect(result.accountsApprovedByUserId).toBe(accountsUser.id);
    });

    it('2. should reject approval with 403 when user lacks ACCOUNTING:APPROVE', async () => {
      const periodId = 'period-p2-processed';
      vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);

      await expect(
        PayrollService.approveAccounts(employeeUser, periodId, 'Attempted approval')
      ).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(/ACCOUNTING:APPROVE/i),
      });
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 3: Posting without Accounts Approval is Rejected
  // --------------------------------------------------------------------------
  describe('3: Posting Without Accounts Approval is Strictly Rejected', () => {
    it('should reject posting if period status is DRAFT', async () => {
      const draftPeriod = createMockPeriod({
        id: 'period-draft-1',
        status: 'DRAFT',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(draftPeriod as any);

      await expect(
        PayrollService.postPeriod(adminPosterUser, draftPeriod.id)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/must be processed and receive Accounts approval first/i),
      });
    });

    it('should reject posting if period status is PROCESSED but not yet ACCOUNTS_APPROVED', async () => {
      const processedPeriod = createMockPeriod({
        id: 'period-processed-1',
        status: 'PROCESSED',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(processedPeriod as any);

      await expect(
        PayrollService.postPeriod(adminPosterUser, processedPeriod.id)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/must receive Accounts approval \(ACCOUNTING:APPROVE\) prior to final Admin posting/i),
      });
    });

    it('should reject posting if ACCOUNTS_APPROVED status is set but accountsApprovedByUserId is null', async () => {
      const corruptedPeriod = createMockPeriod({
        id: 'period-corrupted-1',
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: null,
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(corruptedPeriod as any);

      await expect(
        PayrollService.postPeriod(adminPosterUser, corruptedPeriod.id)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/Missing Accounts approver record/i),
      });
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 4: Distinct User Posting After Accounts Approval
  // --------------------------------------------------------------------------
  describe('4: Distinct User with PAYROLL:APPROVE Can Finalize Posting', () => {
    it('should successfully post period when Accounts Approver and Admin Poster are distinct users', async () => {
      const periodId = 'period-ready-for-post';
      const approvedPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedAt: new Date('2026-05-31T10:00:00Z'),
        accountsApprovedByUserId: accountsUser.id,
      });

      const postedPeriod = {
        ...approvedPeriod,
        status: 'POSTED',
        postedAt: new Date(),
        adminApprovedAt: new Date(),
        adminApprovedByUserId: adminPosterUser.id,
      };

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(postedPeriod as any);
      vi.spyOn(prisma.accountLedger, 'findMany').mockResolvedValue([{ id: 'ldr-emp-1' }] as any);
      vi.spyOn(JournalService, 'createJournal').mockResolvedValue({
        id: 'jrn-1',
        voucherNumber: 'JV-2026-0001',
      } as any);

      // Mock transaction
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue(approvedPeriod),
            update: vi.fn().mockResolvedValue(postedPeriod),
          },
          payslip: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return callback(txMock);
      });

      // Distinct approver: adminPosterUser !== accountsUser
      expect(adminPosterUser.id).not.toBe(accountsUser.id);

      const result = await PayrollService.postPeriod(adminPosterUser, periodId);
      expect(result).toBeDefined();
      expect(result.status).toBe('POSTED');
      expect(result.adminApprovedByUserId).toBe(adminPosterUser.id);
      expect(result.accountsApprovedByUserId).toBe(accountsUser.id);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 5 & 6: Four-Eyes Self-Dual-Approval Invariant & SUPER_ADMIN
  // --------------------------------------------------------------------------
  describe('5 & 6: Four-Eyes Invariant & SUPER_ADMIN Prohibition Against Self-Approval', () => {
    it('5. should reject posting with 403 when the same user provides both Accounts and Admin approvals', async () => {
      const periodId = 'period-same-user';
      const period = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: accountsUser.id,
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(period as any);

      // Same user (accountsUser) attempts to also post
      await expect(
        PayrollService.postPeriod(accountsUser, periodId)
      ).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(/Four-Eyes Security Violation/i),
      });
    });

    it('6. SUPER_ADMIN cannot bypass the distinct-user requirement', async () => {
      const periodId = 'period-superadmin-attempt';
      const period = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: superAdminUser.id, // SuperAdmin did Accounts approval
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(period as any);

      // SuperAdmin attempts to provide Admin posting approval on their own Accounts-approved period
      await expect(
        PayrollService.postPeriod(superAdminUser, periodId)
      ).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(/Four-Eyes Security Violation.*distinct administrator/i),
      });
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 7: Tenant Isolation
  // --------------------------------------------------------------------------
  describe('7: Tenant Isolation for Both Approval Stages', () => {
    it('should reject Accounts approval across tenant boundaries with 404', async () => {
      const periodFromCompanyA = createMockPeriod({
        id: 'period-comp-a',
        companyId: companyA,
        status: 'PROCESSED',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(periodFromCompanyA as any);

      // Foreign user from companyB attempts to approve period from companyA
      await expect(
        PayrollService.approveAccounts(foreignUser, periodFromCompanyA.id)
      ).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringMatching(/Payroll period not found in this company/i),
      });
    });

    it('should reject GL posting across tenant boundaries with 404', async () => {
      const periodFromCompanyA = createMockPeriod({
        id: 'period-comp-a-post',
        companyId: companyA,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: accountsUser.id,
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(periodFromCompanyA as any);

      // Foreign user from companyB attempts to post period from companyA
      await expect(
        PayrollService.postPeriod(foreignUser, periodFromCompanyA.id)
      ).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringMatching(/Payroll period not found in this company/i),
      });
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 8: Duplicate Accounts Approval
  // --------------------------------------------------------------------------
  describe('8: Duplicate Accounts Approval on ACCOUNTS_APPROVED Period', () => {
    it('should reject Accounts approval if period is already ACCOUNTS_APPROVED', async () => {
      const periodId = 'period-already-approved';
      const period = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: 'user-first-approver',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(period as any);

      await expect(
        PayrollService.approveAccounts(accountsUser, periodId)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/already received Accounts approval/i),
      });
    });

    it('should reject Accounts approval if period is already POSTED', async () => {
      const periodId = 'period-already-posted';
      const period = createMockPeriod({
        id: periodId,
        status: 'POSTED',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(period as any);

      await expect(
        PayrollService.approveAccounts(accountsUser, periodId)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/Posted payroll period is finalized and cannot be modified|PROCESSED/i),
      });
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 9: Recalculation Invalidation
  // --------------------------------------------------------------------------
  describe('9: Recalculation Invalidation of Prior Approvals', () => {
    it('should invalidate existing Accounts approval and reset status to PROCESSED when processPeriod is run', async () => {
      const periodId = 'period-recalc-target';
      const accountsApprovedPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedAt: new Date(),
        accountsApprovedByUserId: accountsUser.id,
        accountsApprovalNotes: 'Prior note',
      });

      const processedPeriod = {
        ...accountsApprovedPeriod,
        status: 'PROCESSED',
        accountsApprovedAt: null,
        accountsApprovedByUserId: null,
        accountsApprovalNotes: null,
      };

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(processedPeriod as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([]);

      const updatePeriodMock = vi.fn().mockImplementation(({ data }) => ({
        ...accountsApprovedPeriod,
        ...data,
      }));

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          payslip: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
          companySetting: { findUnique: vi.fn().mockResolvedValue(null) },
          payrollPeriod: { update: updatePeriodMock },
        };
        return callback(txMock);
      });

      await PayrollService.processPeriod(accountsUser, periodId);

      expect(updatePeriodMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PROCESSED',
            accountsApprovedAt: null,
            accountsApprovedByUserId: null,
            accountsApprovalNotes: null,
            adminApprovedAt: null,
            adminApprovedByUserId: null,
          }),
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 10: Concurrency Race-Condition Checks
  // --------------------------------------------------------------------------
  describe('10: Concurrency Race-Condition Protection', () => {
    it('should reject postPeriod inside transaction if status concurrently reverted to PROCESSED', async () => {
      const periodId = 'period-race-condition';
      const initialPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: accountsUser.id,
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(initialPeriod as any);
      vi.spyOn(prisma.accountLedger, 'findMany').mockResolvedValue([]);

      // In transaction: findUnique returns a reverted status (e.g. recalculation happened concurrently)
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue({
              ...initialPeriod,
              status: 'PROCESSED', // Concurrently modified
            }),
          },
        };
        return callback(txMock);
      });

      await expect(
        PayrollService.postPeriod(adminPosterUser, periodId, {
          payrollExpenseLedgerId: 'ldr-exp',
          payrollPayableLedgerId: 'ldr-pay',
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/must be in ACCOUNTS_APPROVED status/i),
      });
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 11: POSTED Period Strict Immutability
  // --------------------------------------------------------------------------
  describe('11: POSTED Period Strict Immutability', () => {
    it('should reject cancellation of a POSTED period', async () => {
      const postedPeriod = createMockPeriod({
        id: 'period-posted-immutable',
        status: 'POSTED',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(postedPeriod as any);

      await expect(
        PayrollService.cancelPeriod(adminPosterUser, postedPeriod.id)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/Posted payroll period cannot be cancelled/i),
      });
    });

    it('should reject recalculation / processPeriod of a POSTED period', async () => {
      const postedPeriod = createMockPeriod({
        id: 'period-posted-recalc',
        status: 'POSTED',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(postedPeriod as any);

      await expect(
        PayrollService.processPeriod(adminPosterUser, postedPeriod.id)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/Posted payroll period cannot be recalculated or modified/i),
      });
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 12: Route & Controller API Integration
  // --------------------------------------------------------------------------
  describe('12: Route Integration & Permission Enforcement', () => {
    it('POST /api/payroll/periods/:id/approve-accounts should enforce ACCOUNTING:APPROVE', async () => {
      const token = AuthService.generateSessionToken(accountsUser);
      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValue(accountsUser);

      vi.spyOn(PermissionService, 'hasPermission').mockImplementation(
        async (_cid, _role, module, action) => {
          if (module === 'ACCOUNTING' && action === 'APPROVE') {
            return false; // User denied
          }
          return true;
        }
      );

      const res = await request(app)
        .post('/api/payroll/periods/period-123/approve-accounts')
        .set('Authorization', `Bearer ${token}`)
        .send({ notes: 'Test' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    });

    it('POST /api/payroll/periods/:id/post should enforce PAYROLL:APPROVE', async () => {
      const token = AuthService.generateSessionToken(adminPosterUser);
      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValue(adminPosterUser);

      vi.spyOn(PermissionService, 'hasPermission').mockImplementation(
        async (_cid, _role, module, action) => {
          if (module === 'PAYROLL' && action === 'APPROVE') {
            return false; // Denied PAYROLL:APPROVE
          }
          return true;
        }
      );

      const res = await request(app)
        .post('/api/payroll/periods/period-123/post')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 13: Recalculation vs Posting Concurrency (SEC-11-03 Fix A)
  // --------------------------------------------------------------------------
  describe('13: Concurrency Protection — Recalculation vs Posting (SEC-11-03 Fix A)', () => {
    it('1. should reject processPeriod if period becomes POSTED before transaction acquires lock and preserve existing payslips', async () => {
      const periodId = 'period-recalc-race';
      const initialPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
      });

      // Outer read sees ACCOUNTS_APPROVED
      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(initialPeriod as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([]);

      const deleteManySpy = vi.fn().mockResolvedValue({ count: 0 });
      const updatePeriodSpy = vi.fn();

      // Inside transaction: period is already POSTED (e.g. postPeriod committed while waiting for lock)
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue({
              ...initialPeriod,
              status: 'POSTED',
            }),
            update: updatePeriodSpy,
          },
          payslip: {
            deleteMany: deleteManySpy,
          },
        };
        return callback(txMock);
      });

      await expect(
        PayrollService.processPeriod(accountsUser, periodId)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/Posted payroll period cannot be recalculated or modified/i),
      });

      // Critical invariant: payslips belonging to the posted period must NEVER be deleted
      expect(deleteManySpy).not.toHaveBeenCalled();
      expect(updatePeriodSpy).not.toHaveBeenCalled();
    });

    it('2. should prevent processPeriod from overwriting POSTED status inside transaction', async () => {
      const periodId = 'period-recalc-race-2';
      const initialPeriod = createMockPeriod({
        id: periodId,
        status: 'PROCESSED',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(initialPeriod as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([]);

      const updatePeriodSpy = vi.fn();

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue({
              ...initialPeriod,
              status: 'POSTED',
            }),
            update: updatePeriodSpy,
          },
          payslip: {
            deleteMany: vi.fn(),
          },
        };
        return callback(txMock);
      });

      await expect(
        PayrollService.processPeriod(accountsUser, periodId)
      ).rejects.toThrow();

      expect(updatePeriodSpy).not.toHaveBeenCalled();
    });

    it('3. should ensure processPeriod never calls payslip.deleteMany when in-transaction status is POSTED', async () => {
      const periodId = 'period-recalc-race-3';
      const initialPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(initialPeriod as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([]);

      const deleteManySpy = vi.fn();

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue({
              ...initialPeriod,
              status: 'POSTED',
            }),
          },
          payslip: {
            deleteMany: deleteManySpy,
          },
        };
        return callback(txMock);
      });

      await expect(
        PayrollService.processPeriod(accountsUser, periodId)
      ).rejects.toThrow();

      expect(deleteManySpy).not.toHaveBeenCalled();
    });

    it('4. should safely invalidate ACCOUNTS_APPROVED approval fields and transition to PROCESSED when recalculation is permitted', async () => {
      const periodId = 'period-recalc-allowed';
      const approvedPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedAt: new Date(),
        accountsApprovedByUserId: accountsUser.id,
      });

      const updatedPeriod = {
        ...approvedPeriod,
        status: 'PROCESSED',
        accountsApprovedAt: null,
        accountsApprovedByUserId: null,
      };

      vi.spyOn(prisma.payrollPeriod, 'findUnique')
        .mockResolvedValueOnce(approvedPeriod as any)
        .mockResolvedValueOnce(updatedPeriod as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([]);

      const updatePeriodSpy = vi.fn().mockResolvedValue(updatedPeriod);
      const deleteManySpy = vi.fn().mockResolvedValue({ count: 1 });

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue(approvedPeriod),
            update: updatePeriodSpy,
          },
          payslip: {
            deleteMany: deleteManySpy,
          },
          companySetting: {
            findUnique: vi.fn().mockResolvedValue(null),
          },
        };
        return callback(txMock);
      });

      const result = await PayrollService.processPeriod(accountsUser, periodId);
      expect(result.status).toBe('PROCESSED');
      expect(updatePeriodSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: periodId },
          data: expect.objectContaining({
            status: 'PROCESSED',
            accountsApprovedAt: null,
            accountsApprovedByUserId: null,
          }),
        })
      );
    });

    it('5. should enforce strict immutability of POSTED periods at outer boundary', async () => {
      const postedPeriod = createMockPeriod({
        id: 'period-posted-immut',
        status: 'POSTED',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(postedPeriod as any);

      await expect(
        PayrollService.processPeriod(accountsUser, postedPeriod.id)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/Posted payroll period cannot be recalculated or modified/i),
      });

      await expect(
        PayrollService.cancelPeriod(accountsUser, postedPeriod.id)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/Posted payroll period cannot be cancelled/i),
      });
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 14: Posting Concurrency & Idempotency (SEC-11-03 Fix A)
  // --------------------------------------------------------------------------
  describe('14: Concurrency Protection — Posting Race & Idempotency (SEC-11-03 Fix A)', () => {
    it('6. should reject postPeriod inside transaction if period status was reverted or invalidated', async () => {
      const periodId = 'period-post-reverted';
      const approvedPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: accountsUser.id,
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(approvedPeriod as any);
      vi.spyOn(prisma.accountLedger, 'findMany').mockResolvedValue([]);
      const createJournalSpy = vi.spyOn(JournalService, 'createJournal');

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue({
              ...approvedPeriod,
              status: 'PROCESSED', // Concurrently reverted by processPeriod
            }),
          },
        };
        return callback(txMock);
      });

      await expect(
        PayrollService.postPeriod(adminPosterUser, periodId, {
          payrollExpenseLedgerId: 'ldr-exp',
          payrollPayableLedgerId: 'ldr-pay',
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/must be in ACCOUNTS_APPROVED status/i),
      });

      expect(createJournalSpy).not.toHaveBeenCalled();
    });

    it('7. should prevent duplicate JournalEntries and duplicate posting when two concurrent post requests execute', async () => {
      const periodId = 'period-concurrent-post';
      const approvedPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: accountsUser.id,
      });
      const postedPeriod = {
        ...approvedPeriod,
        status: 'POSTED',
        postedAt: new Date(),
        adminApprovedAt: new Date(),
        adminApprovedByUserId: adminPosterUser.id,
      };

      vi.spyOn(prisma.payrollPeriod, 'findUnique')
        .mockResolvedValueOnce(approvedPeriod as any) // outer read
        .mockResolvedValue(postedPeriod as any);

      vi.spyOn(prisma.accountLedger, 'findMany').mockResolvedValue([]);
      const createJournalSpy = vi.spyOn(JournalService, 'createJournal');

      // Request 2 enters transaction after Request 1 committed:
      // under the lock, currentInTx is already POSTED!
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue(postedPeriod), // already posted by request 1!
            update: vi.fn(),
          },
          payslip: {
            updateMany: vi.fn(),
          },
        };
        return callback(txMock);
      });

      const result = await PayrollService.postPeriod(adminPosterUser, periodId, {
        payrollExpenseLedgerId: 'ldr-exp',
        payrollPayableLedgerId: 'ldr-pay',
      });

      expect(result.status).toBe('POSTED');
      // Invariant: JournalService.createJournal was NOT called for request 2!
      expect(createJournalSpy).not.toHaveBeenCalled();
    });

    it('8. should abort and roll back transaction if JournalService.createJournal fails', async () => {
      const periodId = 'period-journal-failure';
      const approvedPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: accountsUser.id,
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(approvedPeriod as any);
      vi.spyOn(prisma.accountLedger, 'findMany').mockResolvedValue([]);
      vi.spyOn(JournalService, 'createJournal').mockRejectedValue(
        new Error('General Ledger posting rejected: Account period closed.')
      );

      const updatePeriodSpy = vi.fn();
      const updatePayslipSpy = vi.fn();

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue(approvedPeriod),
            update: updatePeriodSpy,
          },
          payslip: {
            updateMany: updatePayslipSpy,
          },
        };
        return callback(txMock);
      });

      await expect(
        PayrollService.postPeriod(adminPosterUser, periodId, {
          payrollExpenseLedgerId: 'ldr-exp',
          payrollPayableLedgerId: 'ldr-pay',
        })
      ).rejects.toThrow('Account period closed');

      // Invariant: status update and payslip approval must NOT have executed
      expect(updatePeriodSpy).not.toHaveBeenCalled();
      expect(updatePayslipSpy).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 15: Atomic Audit Logging (SEC-11-03 Fix B)
  // --------------------------------------------------------------------------
  describe('15: Atomic Audit Logging — Transactional Commit and Rollback (SEC-11-03 Fix B)', () => {
    it('9. should abort and roll back Accounts approval if audit write fails inside transaction', async () => {
      const periodId = 'period-audit-accounts-fail';
      const existingPeriod = createMockPeriod({
        id: periodId,
        status: 'PROCESSED',
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(existingPeriod as any);

      // Audit logging fails inside transaction
      vi.spyOn(AuditService, 'log').mockRejectedValueOnce(
        new Error('Database error: Audit log partition unavailable')
      );

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue(existingPeriod),
            update: vi.fn().mockResolvedValue({ ...existingPeriod, status: 'ACCOUNTS_APPROVED' }),
          },
        };
        return callback(txMock);
      });

      await expect(
        PayrollService.approveAccounts(accountsUser, periodId, 'Approve')
      ).rejects.toThrow('Audit log partition unavailable');
    });

    it('10. should abort and roll back payroll posting if audit write fails inside transaction', async () => {
      const periodId = 'period-audit-post-fail';
      const approvedPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: accountsUser.id,
      });

      vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValue(approvedPeriod as any);
      vi.spyOn(prisma.accountLedger, 'findMany').mockResolvedValue([]);
      vi.spyOn(JournalService, 'createJournal').mockResolvedValue({
        id: 'jrn-temp',
        voucherNumber: 'JV-2026-9999',
      } as any);

      // Audit logging fails inside transaction
      vi.spyOn(AuditService, 'log').mockRejectedValueOnce(
        new Error('Audit write timed out')
      );

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue(approvedPeriod),
            update: vi.fn(),
          },
          payslip: {
            updateMany: vi.fn(),
          },
        };
        return callback(txMock);
      });

      await expect(
        PayrollService.postPeriod(adminPosterUser, periodId, {
          payrollExpenseLedgerId: 'ldr-exp',
          payrollPayableLedgerId: 'ldr-pay',
        })
      ).rejects.toThrow('Audit write timed out');
    });

    it('11. should write exactly one PAYROLL_ACCOUNTS_APPROVED audit entry with the transaction client on successful approval', async () => {
      const periodId = 'period-audit-accounts-success';
      const existingPeriod = createMockPeriod({
        id: periodId,
        status: 'PROCESSED',
      });
      const updatedPeriod = {
        ...existingPeriod,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: accountsUser.id,
      };

      vi.spyOn(prisma.payrollPeriod, 'findUnique')
        .mockResolvedValueOnce(existingPeriod as any)
        .mockResolvedValueOnce(updatedPeriod as any);

      const auditLogSpy = vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as any);

      let capturedTx: any;
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue(existingPeriod),
            update: vi.fn().mockResolvedValue(updatedPeriod),
          },
        };
        capturedTx = txMock;
        return callback(txMock);
      });

      await PayrollService.approveAccounts(accountsUser, periodId, 'Verified timesheets');

      expect(auditLogSpy).toHaveBeenCalledTimes(1);
      expect(auditLogSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PAYROLL_ACCOUNTS_APPROVED',
          entity: 'PayrollPeriod',
          entityId: periodId,
          userId: accountsUser.id,
        }),
        capturedTx // Must pass the active transaction client!
      );
    });

    it('12. should write exactly one PAYROLL_PERIOD_POST audit entry with the transaction client on successful posting', async () => {
      const periodId = 'period-audit-post-success';
      const approvedPeriod = createMockPeriod({
        id: periodId,
        status: 'ACCOUNTS_APPROVED',
        accountsApprovedByUserId: accountsUser.id,
      });
      const postedPeriod = {
        ...approvedPeriod,
        status: 'POSTED',
        adminApprovedByUserId: adminPosterUser.id,
      };

      vi.spyOn(prisma.payrollPeriod, 'findUnique')
        .mockResolvedValueOnce(approvedPeriod as any)
        .mockResolvedValueOnce(postedPeriod as any);

      vi.spyOn(prisma.accountLedger, 'findMany').mockResolvedValue([]);
      vi.spyOn(JournalService, 'createJournal').mockResolvedValue({
        id: 'jrn-audit-test',
        voucherNumber: 'JV-2026-AUDIT',
      } as any);

      const auditLogSpy = vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as any);

      let capturedTx: any;
      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          payrollPeriod: {
            findUnique: vi.fn().mockResolvedValue(approvedPeriod),
            update: vi.fn().mockResolvedValue(postedPeriod),
          },
          payslip: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        capturedTx = txMock;
        return callback(txMock);
      });

      await PayrollService.postPeriod(adminPosterUser, periodId, {
        payrollExpenseLedgerId: 'ldr-exp',
        payrollPayableLedgerId: 'ldr-pay',
      });

      expect(auditLogSpy).toHaveBeenCalledTimes(1);
      expect(auditLogSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PAYROLL_PERIOD_POST',
          entity: 'PayrollPeriod',
          entityId: periodId,
          userId: adminPosterUser.id,
          details: expect.objectContaining({
            journalEntryId: 'jrn-audit-test',
            voucherNumber: 'JV-2026-AUDIT',
          }),
        }),
        capturedTx // Must pass the active transaction client!
      );
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 16: AuditService.log txClient Isolation & Backwards Compatibility
  // --------------------------------------------------------------------------
  describe('16: AuditService.log Transaction Client Behavior', () => {
    it('should route create to txClient when txClient is supplied', async () => {
      vi.spyOn(AuditService, 'log').mockRestore();

      const mockTxClient = {
        auditLog: {
          create: vi.fn().mockResolvedValue({ id: 'audit-tx-1' }),
        },
      };

      const result = await AuditService.log(
        {
          companyId: companyA,
          userId: accountsUser.id,
          action: 'PAYROLL_ACCOUNTS_APPROVED',
          entity: 'PayrollPeriod',
          entityId: 'period-123',
        },
        mockTxClient
      );

      expect(mockTxClient.auditLog.create).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'audit-tx-1' });
    });

    it('should route create to global prisma client when txClient is omitted (backwards compatibility)', async () => {
      vi.spyOn(AuditService, 'log').mockRestore();
      const prismaCreateSpy = vi.spyOn(prisma.auditLog, 'create').mockResolvedValue({
        id: 'audit-global-1',
      } as any);

      const result = await AuditService.log({
        companyId: companyA,
        userId: adminPosterUser.id,
        action: 'PAYROLL_PERIOD_POST',
        entity: 'PayrollPeriod',
        entityId: 'period-456',
      });

      expect(prismaCreateSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'audit-global-1' });
    });
  });
});
