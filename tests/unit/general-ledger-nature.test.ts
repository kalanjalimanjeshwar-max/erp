import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';
import request from 'supertest';

// Mock Prisma before importing services/app
vi.mock('../../src/server/db/client.js', () => {
  return {
    prisma: {
      accountGroup: {
        count: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      accountLedger: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      journalLine: {
        count: vi.fn(),
      },
      companySetting: {
        findUnique: vi.fn(),
      },
      company: {
        findUnique: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
        findFirst: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      rolePermission: {
        findUnique: vi.fn(),
      },
      employee: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(async (fn: any) => fn({
        accountGroup: { create: vi.fn() },
        employee: { update: vi.fn() },
        accountLedger: { update: vi.fn() },
      })),
    },
  };
});

import { prisma } from '../../src/server/db/client.js';
import { CoaService } from '../../src/server/services/coa.service.js';
import { ExpenseClaimService } from '../../src/server/services/expense-claim.service.js';
import { EmployeeService } from '../../src/server/services/employee.service.js';
import { previewStore } from '../../src/client/services/previewStore.ts';
import { createApp } from '../../src/server/app.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import {
  getDefaultAccountNature,
  formatAccountNatureDisplay,
  STANDARD_ACCOUNT_GROUP_NATURES,
} from '../../src/shared/account-nature.js';
import type { AccountRootType, AuthUser, BalanceType } from '../../src/shared/types.js';

const SIX_STANDARD_GROUPS: Array<{
  id: string;
  code: string;
  name: string;
  rootType: AccountRootType;
  expectedNature: BalanceType;
}> = [
  { id: 'grp-1000', code: '1000', name: 'Assets', rootType: 'ASSET', expectedNature: 'DEBIT' },
  { id: 'grp-2000', code: '2000', name: 'Liabilities', rootType: 'LIABILITY', expectedNature: 'CREDIT' },
  { id: 'grp-2100', code: '2100', name: 'Employees & Payroll', rootType: 'LIABILITY', expectedNature: 'CREDIT' },
  { id: 'grp-3000', code: '3000', name: 'Equity', rootType: 'EQUITY', expectedNature: 'CREDIT' },
  { id: 'grp-4000', code: '4000', name: 'Income', rootType: 'INCOME', expectedNature: 'CREDIT' },
  { id: 'grp-5000', code: '5000', name: 'Expenses', rootType: 'EXPENSE', expectedNature: 'DEBIT' },
];

describe('CoreERP General Ledger Default Account Nature Automation', () => {
  const companyId = 'company-1';
  const adminActor: AuthUser = {
    id: 'user-admin-1',
    userId: 'user-admin-1',
    companyId,
    email: 'admin@nammamedia.in',
    fullName: 'Finance Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    previewStore.reset();
    (prisma.companySetting.findUnique as any).mockResolvedValue(null);
    (prisma.company.findUnique as any).mockResolvedValue({
      id: companyId,
      baseCurrency: 'INR',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    });
    (prisma.auditLog.findFirst as any).mockResolvedValue(null);
    (prisma.auditLog.create as any).mockResolvedValue({ id: 'audit-1' });
    (prisma.journalLine.count as any).mockResolvedValue(0);
  });

  describe('1. Standard Account Group Default Nature Mapping', () => {
    it.each(SIX_STANDARD_GROUPS)(
      'maps $name ($code) to default nature $expectedNature',
      ({ code, name, rootType, expectedNature }) => {
        expect(getDefaultAccountNature({ code, name, rootType })).toBe(expectedNature);
      }
    );

    it('exports all 6 standard groups in STANDARD_ACCOUNT_GROUP_NATURES and formats display labels', () => {
      expect(STANDARD_ACCOUNT_GROUP_NATURES).toHaveLength(6);
      expect(formatAccountNatureDisplay('DEBIT')).toBe('Debit (Dr)');
      expect(formatAccountNatureDisplay('CREDIT')).toBe('Credit (Cr)');
    });
  });

  describe('2. CoaService.createLedger Server Derivation & Tamper Rejection', () => {
    it.each(SIX_STANDARD_GROUPS)(
      'automatically assigns $expectedNature when creating a ledger under $name ($code)',
      async (grp) => {
        (prisma.accountGroup.findUnique as any).mockResolvedValue({
          id: grp.id,
          companyId,
          code: grp.code,
          name: grp.name,
          rootType: grp.rootType,
        });
        (prisma.accountLedger.findFirst as any).mockResolvedValue(null);
        (prisma.accountLedger.create as any).mockImplementation(async ({ data }: any) => ({
          id: `led-${grp.code}`,
          ...data,
          openingBalance: new Decimal(data.openingBalance || 0),
          createdAt: new Date('2026-11-14T10:00:00Z'),
          group: { name: grp.name, rootType: grp.rootType },
        }));

        const created = await CoaService.createLedger(adminActor, {
          groupId: grp.id,
          code: `${grp.code}-01`,
          name: `${grp.name} Test Ledger`,
          openingBalance: '1000.0000',
        });

        expect(created.openingBalanceType).toBe(grp.expectedNature);
        expect(prisma.accountLedger.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              openingBalanceType: grp.expectedNature,
            }),
          })
        );
      }
    );

    it.each(SIX_STANDARD_GROUPS)(
      'rejects client-submitted incorrect nature for $name ($code)',
      async (grp) => {
        const wrongNature: BalanceType = grp.expectedNature === 'DEBIT' ? 'CREDIT' : 'DEBIT';

        (prisma.accountGroup.findUnique as any).mockResolvedValue({
          id: grp.id,
          companyId,
          code: grp.code,
          name: grp.name,
          rootType: grp.rootType,
        });
        (prisma.accountLedger.findFirst as any).mockResolvedValue(null);

        await expect(
          CoaService.createLedger(adminActor, {
            groupId: grp.id,
            code: `${grp.code}-BAD`,
            name: `${grp.name} Invalid Nature`,
            openingBalance: '500.0000',
            openingBalanceType: wrongNature,
          })
        ).rejects.toThrow(/not allowed|Default nature must be/i);

        expect(prisma.accountLedger.create).not.toHaveBeenCalled();
      }
    );

    it('rejects malformed non-enum nature values submitted by client', async () => {
      (prisma.accountGroup.findUnique as any).mockResolvedValue({
        id: 'grp-1000',
        companyId,
        code: '1000',
        name: 'Assets',
        rootType: 'ASSET',
      });
      (prisma.accountLedger.findFirst as any).mockResolvedValue(null);

      await expect(
        CoaService.createLedger(adminActor, {
          groupId: 'grp-1000',
          name: 'Bogus Nature Ledger',
          openingBalanceType: 'BOTH' as any,
        })
      ).rejects.toThrow(/Invalid account nature/i);

      expect(prisma.accountLedger.create).not.toHaveBeenCalled();
    });
  });

  describe('3. CoaService.updateLedger Automatic Re-Derivation & Historical Record Protection', () => {
    it('automatically updates ledger nature when Account Group changes and no historical transactions exist', async () => {
      const assetsGroup = SIX_STANDARD_GROUPS[0]; // DEBIT
      const liabilitiesGroup = SIX_STANDARD_GROUPS[1]; // CREDIT

      (prisma.accountLedger.findUnique as any).mockResolvedValue({
        id: 'led-edit-1',
        companyId,
        groupId: assetsGroup.id,
        code: '1090',
        name: 'Clearing Ledger',
        description: 'Temp clearing',
        currency: 'INR',
        isActive: true,
        openingBalance: new Decimal('0'),
        openingBalanceType: 'DEBIT',
        employeeId: null,
        createdAt: new Date('2026-11-10T10:00:00Z'),
        group: { id: assetsGroup.id, companyId, code: assetsGroup.code, name: assetsGroup.name, rootType: assetsGroup.rootType },
      });
      (prisma.accountGroup.findUnique as any).mockResolvedValue({
        id: liabilitiesGroup.id,
        companyId,
        code: liabilitiesGroup.code,
        name: liabilitiesGroup.name,
        rootType: liabilitiesGroup.rootType,
      });
      (prisma.journalLine.count as any).mockResolvedValue(0);
      (prisma.accountLedger.update as any).mockImplementation(async ({ data }: any) => ({
        id: 'led-edit-1',
        companyId,
        groupId: data.groupId,
        code: '1090',
        name: 'Clearing Ledger',
        description: 'Temp clearing',
        currency: 'INR',
        isActive: true,
        openingBalance: new Decimal('0'),
        openingBalanceType: data.openingBalanceType,
        employeeId: null,
        createdAt: new Date('2026-11-10T10:00:00Z'),
        group: { name: liabilitiesGroup.name, rootType: liabilitiesGroup.rootType },
      }));

      const updated = await CoaService.updateLedger(adminActor, 'led-edit-1', {
        groupId: liabilitiesGroup.id,
      });

      expect(updated.openingBalanceType).toBe('CREDIT');
      expect(prisma.accountLedger.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            groupId: liabilitiesGroup.id,
            openingBalanceType: 'CREDIT',
          }),
        })
      );
    });

    it('rejects client attempt to force an incorrect nature via updateLedger', async () => {
      const incomeGroup = SIX_STANDARD_GROUPS[4]; // CREDIT

      (prisma.accountLedger.findUnique as any).mockResolvedValue({
        id: 'led-edit-2',
        companyId,
        groupId: incomeGroup.id,
        code: '4010',
        name: 'Media Production Revenue',
        description: null,
        currency: 'INR',
        isActive: true,
        openingBalance: new Decimal('25000'),
        openingBalanceType: 'CREDIT',
        employeeId: null,
        createdAt: new Date('2026-11-10T10:00:00Z'),
        group: { id: incomeGroup.id, companyId, code: incomeGroup.code, name: incomeGroup.name, rootType: incomeGroup.rootType },
      });

      await expect(
        CoaService.updateLedger(adminActor, 'led-edit-2', {
          openingBalanceType: 'DEBIT',
        })
      ).rejects.toThrow(/not allowed|Default nature must be CREDIT/i);

      expect(prisma.accountLedger.update).not.toHaveBeenCalled();
    });

    it('preserves existing ledger balance, nature, and historical transactions when editing metadata without group change', async () => {
      const assetsGroup = SIX_STANDARD_GROUPS[0];

      (prisma.accountLedger.findUnique as any).mockResolvedValue({
        id: 'led-hist-1',
        companyId,
        groupId: assetsGroup.id,
        code: '1010',
        name: 'Main Bank',
        description: 'Old description',
        currency: 'INR',
        isActive: true,
        openingBalance: new Decimal('50000.0000'),
        openingBalanceType: 'DEBIT',
        employeeId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        group: { id: assetsGroup.id, companyId, code: assetsGroup.code, name: assetsGroup.name, rootType: assetsGroup.rootType },
      });
      (prisma.accountLedger.update as any).mockImplementation(async ({ data }: any) => ({
        id: 'led-hist-1',
        companyId,
        groupId: assetsGroup.id,
        code: '1010',
        name: 'Main Bank',
        description: data.description,
        currency: 'INR',
        isActive: true,
        openingBalance: new Decimal('50000.0000'),
        openingBalanceType: 'DEBIT',
        employeeId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        group: { name: assetsGroup.name, rootType: assetsGroup.rootType },
      }));

      const updated = await CoaService.updateLedger(adminActor, 'led-hist-1', {
        description: 'Updated description only',
      });

      expect(updated.openingBalance).toBe('50000.0000');
      expect(updated.openingBalanceType).toBe('DEBIT');
      const updateCallData = (prisma.accountLedger.update as any).mock.calls[0][0].data;
      expect(updateCallData.openingBalance).toBeUndefined();
      expect(updateCallData.openingBalanceType).toBeUndefined();
    });

    it('protects historical accounting transactions by blocking cross-nature group change when transactions exist', async () => {
      const assetsGroup = SIX_STANDARD_GROUPS[0]; // DEBIT
      const liabilitiesGroup = SIX_STANDARD_GROUPS[1]; // CREDIT

      (prisma.accountLedger.findUnique as any).mockResolvedValue({
        id: 'led-hist-2',
        companyId,
        groupId: assetsGroup.id,
        code: '1020',
        name: 'HDFC Operating Account',
        description: null,
        currency: 'INR',
        isActive: true,
        openingBalance: new Decimal('100000.0000'),
        openingBalanceType: 'DEBIT',
        employeeId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        group: { id: assetsGroup.id, companyId, code: assetsGroup.code, name: assetsGroup.name, rootType: assetsGroup.rootType },
      });
      (prisma.accountGroup.findUnique as any).mockResolvedValue({
        id: liabilitiesGroup.id,
        companyId,
        code: liabilitiesGroup.code,
        name: liabilitiesGroup.name,
        rootType: liabilitiesGroup.rootType,
      });
      (prisma.journalLine.count as any).mockResolvedValue(12);

      await expect(
        CoaService.updateLedger(adminActor, 'led-hist-2', {
          groupId: liabilitiesGroup.id,
        })
      ).rejects.toThrow(/existing accounting transaction/i);

      expect(prisma.accountLedger.update).not.toHaveBeenCalled();
    });
  });

  describe('4. Related Services & Preview Store Consistency', () => {
    it('ExpenseClaimService auto-creates payable (CREDIT) and expense (DEBIT) ledgers with group-derived natures', async () => {
      (prisma.accountLedger.findFirst as any).mockResolvedValue(null);
      (prisma.accountGroup.findFirst as any)
        .mockResolvedValueOnce({
          id: 'grp-2100',
          companyId,
          code: '2100',
          name: 'Employees & Payroll',
          rootType: 'LIABILITY',
        })
        .mockResolvedValueOnce({
          id: 'grp-5000',
          companyId,
          code: '5000',
          name: 'Expenses',
          rootType: 'EXPENSE',
        });

      const createdLedgers: any[] = [];
      (prisma.accountLedger.create as any).mockImplementation(async ({ data }: any) => {
        const rec = {
          id: `auto-led-${createdLedgers.length + 1}`,
          ...data,
          group: { rootType: data.groupId === 'grp-2100' ? 'LIABILITY' : 'EXPENSE' },
        };
        createdLedgers.push(rec);
        return rec;
      });

      const result = await ExpenseClaimService.getOrCreateDefaultLedgers(companyId, adminActor);

      expect(result.payableLedger.openingBalanceType).toBe('CREDIT');
      expect(result.expenseLedger.openingBalanceType).toBe('DEBIT');
    });

    it('EmployeeService.linkEmployeeLedger derives CREDIT nature from Employees & Payroll (2100)', async () => {
      (prisma.employee.findUnique as any).mockResolvedValue({
        id: 'emp-1',
        companyId,
        employeeCode: 'EMP001',
        fullName: 'Asha Rao',
        ledger: null,
      });
      (prisma.accountGroup.findFirst as any).mockResolvedValue({
        id: 'grp-2100',
        companyId,
        code: '2100',
        name: 'Employees & Payroll',
        rootType: 'LIABILITY',
      });
      (prisma.accountLedger.findFirst as any).mockResolvedValue(null);

      let capturedNature: BalanceType | undefined;
      (prisma.accountLedger.create as any).mockImplementation(async ({ data }: any) => {
        capturedNature = data.openingBalanceType;
        return { id: 'emp-led-1', ...data };
      });
      (prisma.$transaction as any).mockImplementation(async (fn: any) =>
        fn({
          employee: { update: vi.fn() },
          accountLedger: { update: vi.fn() },
        })
      );
      vi.spyOn(EmployeeService, 'getEmployeeById').mockResolvedValue({ id: 'emp-1' } as any);

      await EmployeeService.linkEmployeeLedger(adminActor, 'emp-1', {
        createLedger: true,
      });

      expect(capturedNature).toBe('CREDIT');
    });

    it('previewStore derives nature from selected group and rejects mismatched nature', () => {
      const assetLedger = previewStore.createAccountLedger({
        groupId: 'preview-grp-1000',
        name: 'Preview Cash',
      });
      expect(assetLedger.openingBalanceType).toBe('DEBIT');

      const liabilityLedger = previewStore.createAccountLedger({
        groupId: 'preview-grp-2000',
        name: 'Preview Vendor Payable',
      });
      expect(liabilityLedger.openingBalanceType).toBe('CREDIT');

      expect(() =>
        previewStore.createAccountLedger({
          groupId: 'preview-grp-2000',
          name: 'Tampered Preview Ledger',
          openingBalanceType: 'DEBIT',
        })
      ).toThrow(/not allowed|Default nature must be CREDIT/i);
    });
  });

  describe('5. HTTP API Endpoint Enforcement (/api/accounting/ledgers)', () => {
    const app = createApp();
    const authToken = AuthService.generateSessionToken({
      userId: adminActor.userId,
      companyId: adminActor.companyId,
      email: adminActor.email,
      role: adminActor.role,
      tokenVersion: 1,
    });

    beforeEach(() => {
      (prisma.user.findUnique as any).mockResolvedValue({
        id: adminActor.userId,
        companyId: adminActor.companyId,
        email: adminActor.email,
        fullName: adminActor.fullName,
        role: adminActor.role,
        isActive: true,
        tokenVersion: 1,
        company: { isActive: true },
      });
      (prisma.rolePermission.findUnique as any).mockResolvedValue(null);
    });

    it('POST /api/accounting/ledgers returns 201 with server-derived nature and rejects tampered nature with 400', async () => {
      (prisma.accountGroup.findUnique as any).mockResolvedValue({
        id: 'grp-3000',
        companyId,
        code: '3000',
        name: 'Equity',
        rootType: 'EQUITY',
      });
      (prisma.accountLedger.findFirst as any).mockResolvedValue(null);
      (prisma.accountLedger.create as any).mockImplementation(async ({ data }: any) => ({
        id: 'led-eq-1',
        ...data,
        openingBalance: new Decimal(data.openingBalance || 0),
        createdAt: new Date('2026-11-14T10:00:00Z'),
        group: { name: 'Equity', rootType: 'EQUITY' },
      }));

      // Valid request without openingBalanceType -> server derives CREDIT
      const okRes = await request(app)
        .post('/api/accounting/ledgers')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          groupId: 'grp-3000',
          code: '3010',
          name: 'Share Capital',
          openingBalance: '100000',
        });

      expect(okRes.status).toBe(201);
      expect(okRes.body.openingBalanceType).toBe('CREDIT');

      // Tampered request attempting to force DEBIT on Equity (3000) -> 400 Bad Request
      const badRes = await request(app)
        .post('/api/accounting/ledgers')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          groupId: 'grp-3000',
          code: '3011',
          name: 'Tampered Equity',
          openingBalance: '5000',
          openingBalanceType: 'DEBIT',
        });

      expect(badRes.status).toBe(400);
      expect(badRes.body.error.message).toMatch(/not allowed|Default nature must be CREDIT/i);
    });

    it('PATCH /api/accounting/ledgers/:id updates nature automatically on group change and rejects tampered nature', async () => {
      (prisma.accountLedger.findUnique as any).mockResolvedValue({
        id: 'led-patch-1',
        companyId,
        groupId: 'grp-1000',
        code: '1095',
        name: 'Reclassifiable Ledger',
        description: null,
        currency: 'INR',
        isActive: true,
        openingBalance: new Decimal('0'),
        openingBalanceType: 'DEBIT',
        employeeId: null,
        createdAt: new Date('2026-11-14T10:00:00Z'),
        group: { id: 'grp-1000', companyId, code: '1000', name: 'Assets', rootType: 'ASSET' },
      });
      (prisma.accountGroup.findUnique as any).mockResolvedValue({
        id: 'grp-4000',
        companyId,
        code: '4000',
        name: 'Income',
        rootType: 'INCOME',
      });
      (prisma.journalLine.count as any).mockResolvedValue(0);
      (prisma.accountLedger.update as any).mockImplementation(async ({ data }: any) => ({
        id: 'led-patch-1',
        companyId,
        groupId: data.groupId,
        code: '1095',
        name: 'Reclassifiable Ledger',
        description: null,
        currency: 'INR',
        isActive: true,
        openingBalance: new Decimal('0'),
        openingBalanceType: data.openingBalanceType,
        employeeId: null,
        createdAt: new Date('2026-11-14T10:00:00Z'),
        group: { name: 'Income', rootType: 'INCOME' },
      }));

      const okPatch = await request(app)
        .patch('/api/accounting/ledgers/led-patch-1')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ groupId: 'grp-4000' });

      expect(okPatch.status).toBe(200);
      expect(okPatch.body.openingBalanceType).toBe('CREDIT');

      const badPatch = await request(app)
        .patch('/api/accounting/ledgers/led-patch-1')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ groupId: 'grp-4000', openingBalanceType: 'DEBIT' });

      expect(badPatch.status).toBe(400);
    });
  });

  describe('6. Create General Ledger Form UI Verification', () => {
    it('removes manual Nature dropdown and renders dynamic read-only Default Nature display', () => {
      const pagePath = path.resolve(process.cwd(), 'src/client/pages/ChartOfAccountsPage.tsx');
      const source = fs.readFileSync(pagePath, 'utf-8');

      // Manual nature state & editable dropdown must not exist
      expect(source).not.toContain('ledgerBalType');
      expect(source).not.toContain('setLedgerBalType');
      expect(source).not.toMatch(/<option value="DEBIT">Debit \(Dr\)<\/option>/);
      expect(source).not.toMatch(/<option value="CREDIT">Credit \(Cr\)<\/option>/);

      // Dynamic read-only label derived from selected Account Group must exist
      expect(source).toContain('getDefaultAccountNature(selectedLedgerGroup)');
      expect(source).toContain('formatAccountNatureDisplay(derivedLedgerNature)');
      expect(source).toContain('Default Nature:');
    });
  });
});
