import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import {
  CompanyService,
  PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY,
} from '../../src/server/services/company.service.js';
import { AuthUser } from '../../src/shared/types.js';

describe('P2-2: CompanyService.updateProfile Atomic PERMITTED_MONTHLY_LEAVE_ALLOWANCES_V1 Persistence', () => {
  const app = createApp();
  const companyId = 'comp-p22-1';

  const superAdminActor: AuthUser = {
    id: 'user-super-p22',
    userId: 'user-super-p22',
    companyId,
    email: 'super@corp.local',
    fullName: 'Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const adminActor: AuthUser = {
    id: 'user-admin-p22',
    userId: 'user-admin-p22',
    companyId,
    email: 'admin@corp.local',
    fullName: 'Company Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const authenticateAs = (user: AuthUser) => {
    vi.spyOn(AuthService, 'verifySessionToken').mockReturnValue({
      userId: user.id,
      email: user.email,
      companyId: user.companyId,
      role: user.role,
      tokenVersion: user.tokenVersion,
      exp: Date.now() + 60_000,
    });
    vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValue(user);
    vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
  };

  const createTransactionalStore = (options?: {
    failAllowanceUpsert?: boolean;
    failSalesInvoiceUpsert?: boolean;
  }) => {
    let companyRow: Record<string, any> = {
      id: companyId,
      code: 'CORP',
      name: 'Original Corp',
      legalName: 'Original Corp LLC',
      taxId: 'TAX-001',
      currency: 'USD',
      timezone: 'UTC',
      logoUrl: null,
      address: '100 Main St',
      phone: '555-0100',
      email: 'info@corp.local',
      website: 'https://corp.local',
      appHeaderTitle: 'Original Corp',
      defaultDocumentLanguage: 'EN',
    };

    let settingsMap = new Map<string, string>([
      [PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY, JSON.stringify([4, 5, 6])],
      ['SALES_INVOICE_ENABLED', 'false'],
    ]);
    const txUpsertedKeys: string[] = [];

    const txSpy = vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => {
      // Snapshot state before transaction to simulate real PostgreSQL ROLLBACK on error
      const companySnapshot = { ...companyRow };
      const settingsSnapshot = new Map(settingsMap);

      const txClient = {
        company: {
          update: vi.fn(async ({ data }: any) => {
            companyRow = { ...companyRow, ...data };
            return companyRow;
          }),
        },
        companySetting: {
          upsert: vi.fn(async ({ where, create, update }: any) => {
            const key = where?.companyId_key?.key || create?.key;
            txUpsertedKeys.push(key);
            if (
              options?.failAllowanceUpsert &&
              key === PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY
            ) {
              throw new Error('Simulated DB error persisting PERMITTED_MONTHLY_LEAVE_ALLOWANCES_V1');
            }
            if (options?.failSalesInvoiceUpsert && key === 'SALES_INVOICE_ENABLED') {
              throw new Error('Simulated DB error persisting SALES_INVOICE_ENABLED');
            }
            settingsMap.set(key, create?.value ?? update?.value);
            return { companyId, key, value: settingsMap.get(key) };
          }),
        },
      };

      try {
        return await cb(txClient);
      } catch (err) {
        // Atomic rollback
        companyRow = companySnapshot;
        settingsMap = settingsSnapshot;
        throw err;
      }
    }) as any);

    vi.spyOn(prisma.company, 'findUnique').mockImplementation((async () => ({ ...companyRow })) as any);
    vi.spyOn(prisma.companySetting, 'findMany').mockImplementation((async () =>
      Array.from(settingsMap.entries()).map(([key, value]) => ({ companyId, key, value }))
    ) as any);
    vi.spyOn(prisma.currencyConfig, 'findUnique').mockResolvedValue(null);
    const directCompanyUpdateSpy = vi
      .spyOn(prisma.company, 'update')
      .mockImplementation((async ({ data }: any) => {
        companyRow = { ...companyRow, ...data };
        return companyRow;
      }) as any);
    const directSettingUpsertSpy = vi
      .spyOn(prisma.companySetting, 'upsert')
      .mockImplementation((async ({ where, create, update }: any) => {
        const key = where?.companyId_key?.key || create?.key;
        settingsMap.set(key, create?.value ?? update?.value);
        return { companyId, key, value: settingsMap.get(key) };
      }) as any);

    return {
      txSpy,
      txUpsertedKeys,
      directCompanyUpdateSpy,
      directSettingUpsertSpy,
      getCompany: () => ({ ...companyRow }),
      getSetting: (key: string) => settingsMap.get(key),
    };
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);
  });

  it('persists company profile and permitted monthly leave allowances atomically for SUPER_ADMIN', async () => {
    const store = createTransactionalStore();
    const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);

    const updated = await CompanyService.updateProfile(superAdminActor, {
      name: 'Updated Corp',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      permittedMonthlyLeaveAllowances: [6, 5],
    });

    expect(store.txSpy).toHaveBeenCalledTimes(1);
    expect(store.getCompany().name).toBe('Updated Corp');
    expect(store.getCompany().timezone).toBe('Asia/Kolkata');
    expect(store.getCompany().currency).toBe('INR');
    expect(store.getSetting(PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY)).toBe('[5,6]');
    expect(updated.name).toBe('Updated Corp');
    expect(updated.permittedMonthlyLeaveAllowances).toEqual([5, 6]);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COMPANY_PROFILE_UPDATED',
        companyId,
      })
    );
  });

  it('preserves ADMIN maker-checker approval workflow when permitted monthly leave allowances change', async () => {
    const store = createTransactionalStore();
    const now = new Date('2026-11-21T00:00:00.000Z');
    const createReqSpy = vi
      .spyOn(prisma.companySettingsChangeRequest, 'create')
      .mockImplementation((async ({ data }: any) => ({
        id: 'cr-p22-1',
        companyId: data.companyId,
        requestedById: data.requestedById,
        payload: data.payload,
        status: 'PENDING',
        rejectionReason: null,
        reviewedById: null,
        reviewedAt: null,
        appliedAt: null,
        createdAt: now,
        updatedAt: now,
        requestedBy: { fullName: adminActor.fullName, email: adminActor.email },
        reviewedBy: null,
      })) as any);

    const result = await CompanyService.updateProfile(adminActor, {
      name: 'Original Corp',
      legalName: 'Original Corp LLC',
      taxId: 'TAX-001',
      timezone: 'UTC',
      currency: 'USD',
      permittedMonthlyLeaveAllowances: [5, 6],
    });

    expect(result.pendingApproval).toBe(true);
    expect(result.changeRequest?.id).toBe('cr-p22-1');
    expect(result.changeRequest?.status).toBe('PENDING');
    expect(result.changeRequest?.payload.permittedMonthlyLeaveAllowances).toEqual([5, 6]);
    expect(createReqSpy).toHaveBeenCalledTimes(1);
    expect(store.txSpy).not.toHaveBeenCalled();
    expect(store.directCompanyUpdateSpy).not.toHaveBeenCalled();
    expect(store.directSettingUpsertSpy).not.toHaveBeenCalled();
    // Live settings remain unchanged until SUPER_ADMIN approves
    expect(store.getSetting(PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY)).toBe('[4,5,6]');
  });

  it('propagates CompanySetting upsert failure, rolls back the company update atomically, and does not return HTTP 200', async () => {
    authenticateAs(superAdminActor);
    const store = createTransactionalStore({ failAllowanceUpsert: true });
    const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);

    // 1. Direct service call must reject and roll back company changes
    await expect(
      CompanyService.updateProfile(superAdminActor, {
        name: 'Should Rollback Corp',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        permittedMonthlyLeaveAllowances: [5, 6],
      })
    ).rejects.toThrow(/Simulated DB error persisting PERMITTED_MONTHLY_LEAVE_ALLOWANCES_V1/);

    expect(store.txSpy).toHaveBeenCalledTimes(1);
    expect(store.getCompany().name).toBe('Original Corp');
    expect(store.getCompany().timezone).toBe('UTC');
    expect(store.getCompany().currency).toBe('USD');
    expect(store.getSetting(PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY)).toBe('[4,5,6]');
    expect(auditSpy).not.toHaveBeenCalled();

    // 2. HTTP route PATCH /api/company/profile must not report success (HTTP 200)
    const res = await request(app)
      .patch('/api/company/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({
        name: 'Should Rollback Via HTTP',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        permittedMonthlyLeaveAllowances: [5, 6],
      });

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(500);
    expect(store.getCompany().name).toBe('Original Corp');
    expect(store.getSetting(PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY)).toBe('[4,5,6]');
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('preserves existing behavior for unrelated profile updates without permittedMonthlyLeaveAllowances', async () => {
    const store = createTransactionalStore();

    const updated = await CompanyService.updateProfile(superAdminActor, {
      name: 'Renamed Only Corp',
      timezone: 'UTC',
      currency: 'USD',
      phone: '555-9999',
    });

    expect(store.txSpy).not.toHaveBeenCalled();
    expect(store.directCompanyUpdateSpy).toHaveBeenCalledTimes(1);
    expect(store.directSettingUpsertSpy).not.toHaveBeenCalled();
    expect(updated.name).toBe('Renamed Only Corp');
    expect(updated.phone).toBe('555-9999');
    expect(updated.permittedMonthlyLeaveAllowances).toEqual([4, 5, 6]);
  });

  describe('Decision 3 (P2-2 Adjacent): Atomic SALES_INVOICE_ENABLED Persistence', () => {
    it('uses prisma.$transaction to persist company.update and SALES_INVOICE_ENABLED atomically when permittedMonthlyLeaveAllowances is omitted', async () => {
      const store = createTransactionalStore();
      const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);

      const updated = await CompanyService.updateProfile(superAdminActor, {
        name: 'Invoice Enabled Corp',
        timezone: 'UTC',
        currency: 'USD',
        salesInvoiceEnabled: true,
      });

      expect(store.txSpy).toHaveBeenCalledTimes(1);
      expect(store.directCompanyUpdateSpy).not.toHaveBeenCalled();
      expect(store.directSettingUpsertSpy).not.toHaveBeenCalled();
      expect(store.txUpsertedKeys).toEqual(['SALES_INVOICE_ENABLED']);
      expect(store.getCompany().name).toBe('Invoice Enabled Corp');
      expect(store.getSetting('SALES_INVOICE_ENABLED')).toBe('true');
      expect(store.getSetting(PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY)).toBe('[4,5,6]');
      expect(updated.name).toBe('Invoice Enabled Corp');
      expect(updated.salesInvoiceEnabled).toBe(true);
      expect(updated.permittedMonthlyLeaveAllowances).toEqual([4, 5, 6]);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'COMPANY_PROFILE_UPDATED',
          companyId,
        })
      );
    });

    it('rolls back company.update, propagates persistence error, and never returns HTTP 200 when SALES_INVOICE_ENABLED upsert fails', async () => {
      authenticateAs(superAdminActor);
      const store = createTransactionalStore({ failSalesInvoiceUpsert: true });
      const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);

      // 1. Direct service call must reject and roll back company.update atomically
      await expect(
        CompanyService.updateProfile(superAdminActor, {
          name: 'Should Rollback Sales Invoice Corp',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
          salesInvoiceEnabled: true,
        })
      ).rejects.toThrow(/Simulated DB error persisting SALES_INVOICE_ENABLED/);

      expect(store.txSpy).toHaveBeenCalledTimes(1);
      expect(store.directCompanyUpdateSpy).not.toHaveBeenCalled();
      expect(store.directSettingUpsertSpy).not.toHaveBeenCalled();
      expect(store.getCompany().name).toBe('Original Corp');
      expect(store.getCompany().timezone).toBe('UTC');
      expect(store.getCompany().currency).toBe('USD');
      expect(store.getSetting('SALES_INVOICE_ENABLED')).toBe('false');
      expect(auditSpy).not.toHaveBeenCalled();

      // 2. HTTP route PATCH /api/company/profile must not report false HTTP 200 success
      const res = await request(app)
        .patch('/api/company/profile')
        .set('Authorization', 'Bearer valid-token')
        .send({
          name: 'Should Rollback Sales Invoice Via HTTP',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
          salesInvoiceEnabled: true,
        });

      expect(res.status).not.toBe(200);
      expect(res.status).toBe(500);
      expect(store.getCompany().name).toBe('Original Corp');
      expect(store.getSetting('SALES_INVOICE_ENABLED')).toBe('false');
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('persists both SALES_INVOICE_ENABLED and PERMITTED_MONTHLY_LEAVE_ALLOWANCES_V1 together in one atomic transaction', async () => {
      const store = createTransactionalStore();

      const updated = await CompanyService.updateProfile(superAdminActor, {
        name: 'Combined Settings Corp',
        timezone: 'UTC',
        currency: 'USD',
        salesInvoiceEnabled: true,
        permittedMonthlyLeaveAllowances: [5, 6],
      });

      expect(store.txSpy).toHaveBeenCalledTimes(1);
      expect(store.txUpsertedKeys).toEqual([
        'SALES_INVOICE_ENABLED',
        PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY,
      ]);
      expect(store.getCompany().name).toBe('Combined Settings Corp');
      expect(store.getSetting('SALES_INVOICE_ENABLED')).toBe('true');
      expect(store.getSetting(PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY)).toBe('[5,6]');
      expect(updated.salesInvoiceEnabled).toBe(true);
      expect(updated.permittedMonthlyLeaveAllowances).toEqual([5, 6]);
    });
  });
});

