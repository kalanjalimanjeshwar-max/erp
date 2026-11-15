import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import request from 'supertest';

// Stateful in-memory Prisma mock to verify sequential, duplicate, and concurrent ledger creation
const dbState: {
  groups: Array<{
    id: string;
    companyId: string;
    code: string;
    name: string;
    rootType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
    parentGroupId: string | null;
    isSystem: boolean;
    createdAt: Date;
  }>;
  ledgers: Array<{
    id: string;
    companyId: string;
    groupId: string;
    code: string | null;
    name: string;
    description: string | null;
    currency: string;
    isActive: boolean;
    openingBalance: Decimal;
    openingBalanceType: 'DEBIT' | 'CREDIT';
    employeeId: string | null;
    createdAt: Date;
  }>;
  journalLineCountByLedger: Record<string, number>;
  injectP2002OnceOnCreate: boolean;
} = {
  groups: [],
  ledgers: [],
  journalLineCountByLedger: {},
  injectP2002OnceOnCreate: false,
};

vi.mock('../../src/server/db/client.js', () => {
  return {
    prisma: {
      accountGroup: {
        count: vi.fn(async ({ where }: any) => {
          return dbState.groups.filter((g) => g.companyId === where.companyId).length;
        }),
        findMany: vi.fn(async ({ where }: any) => {
          return dbState.groups.filter((g) => g.companyId === where.companyId);
        }),
        findFirst: vi.fn(async ({ where }: any) => {
          return (
            dbState.groups.find((g) => {
              if (where.companyId && g.companyId !== where.companyId) return false;
              if (where.OR) {
                return where.OR.some(
                  (cond: any) =>
                    (cond.code && g.code === cond.code) || (cond.name && g.name === cond.name)
                );
              }
              return true;
            }) || null
          );
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          return dbState.groups.find((g) => g.id === where.id) || null;
        }),
        create: vi.fn(async ({ data }: any) => {
          const item = {
            id: `grp-${dbState.groups.length + 1}`,
            companyId: data.companyId,
            code: data.code,
            name: data.name,
            rootType: data.rootType,
            parentGroupId: data.parentGroupId ?? null,
            isSystem: Boolean(data.isSystem),
            createdAt: new Date('2026-11-14T10:00:00Z'),
          };
          dbState.groups.push(item);
          return item;
        }),
      },
      accountLedger: {
        findMany: vi.fn(async ({ where }: any) => {
          return dbState.ledgers
            .filter((l) => {
              if (where?.companyId && l.companyId !== where.companyId) return false;
              if (where?.code?.not === null && l.code === null) return false;
              return true;
            })
            .map((l) => {
              const grp = dbState.groups.find((g) => g.id === l.groupId)!;
              return { ...l, group: { name: grp.name, rootType: grp.rootType } };
            });
        }),
        findFirst: vi.fn(async ({ where }: any) => {
          return (
            dbState.ledgers.find((l) => {
              if (where.companyId && l.companyId !== where.companyId) return false;
              if (where.id?.not && l.id === where.id.not) return false;
              if (where.employeeId && l.employeeId !== where.employeeId) return false;
              if (where.name && l.name !== where.name) return false;
              if (where.code && l.code !== where.code) return false;
              if (where.OR) {
                return where.OR.some(
                  (cond: any) =>
                    (cond.name && l.name === cond.name) ||
                    (cond.code && l.code === cond.code)
                );
              }
              return true;
            }) || null
          );
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          const found = dbState.ledgers.find((l) => l.id === where.id);
          if (!found) return null;
          const grp = dbState.groups.find((g) => g.id === found.groupId)!;
          return { ...found, group: grp };
        }),
        create: vi.fn(async ({ data }: any) => {
          // Simulate concurrent insert from another server instance
          if (dbState.injectP2002OnceOnCreate) {
            dbState.injectP2002OnceOnCreate = false;
            // Another instance inserted the conflicting code first
            dbState.ledgers.push({
              id: `led-racer-${dbState.ledgers.length + 1}`,
              companyId: data.companyId,
              groupId: data.groupId,
              code: data.code,
              name: `Concurrent Winner ${data.code}`,
              description: null,
              currency: data.currency || 'INR',
              isActive: true,
              openingBalance: new Decimal('0'),
              openingBalanceType: data.openingBalanceType,
              employeeId: null,
              createdAt: new Date('2026-11-14T10:00:00Z'),
            });
            const err: any = new Error('Unique constraint failed on the fields: (`companyId`,`code`)');
            err.code = 'P2002';
            err.meta = { target: ['companyId', 'code'] };
            throw err;
          }

          // Enforce DB-level @@unique([companyId, code]) and @@unique([companyId, name])
          const dupCode = dbState.ledgers.find(
            (l) => l.companyId === data.companyId && data.code && l.code === data.code
          );
          if (dupCode) {
            const err: any = new Error('Unique constraint failed on (`companyId`,`code`)');
            err.code = 'P2002';
            err.meta = { target: ['companyId', 'code'] };
            throw err;
          }
          const dupName = dbState.ledgers.find(
            (l) => l.companyId === data.companyId && l.name === data.name
          );
          if (dupName) {
            const err: any = new Error('Unique constraint failed on (`companyId`,`name`)');
            err.code = 'P2002';
            err.meta = { target: ['companyId', 'name'] };
            throw err;
          }

          const created = {
            id: `led-${dbState.ledgers.length + 1}`,
            companyId: data.companyId,
            groupId: data.groupId,
            code: data.code ?? null,
            name: data.name,
            description: data.description ?? null,
            currency: data.currency || 'INR',
            isActive: data.isActive ?? true,
            openingBalance: new Decimal(data.openingBalance || 0),
            openingBalanceType: data.openingBalanceType,
            employeeId: data.employeeId ?? null,
            createdAt: new Date('2026-11-14T10:00:00Z'),
          };
          dbState.ledgers.push(created);
          const grp = dbState.groups.find((g) => g.id === created.groupId)!;
          return { ...created, group: { name: grp.name, rootType: grp.rootType } };
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const idx = dbState.ledgers.findIndex((l) => l.id === where.id);
          if (idx === -1) throw new Error('Not found');
          const existing = dbState.ledgers[idx];
          const updated = {
            ...existing,
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.code !== undefined ? { code: data.code } : {}),
            ...(data.description !== undefined ? { description: data.description } : {}),
            ...(data.currency !== undefined ? { currency: data.currency } : {}),
            ...(data.groupId !== undefined ? { groupId: data.groupId } : {}),
            ...(data.openingBalance !== undefined
              ? { openingBalance: new Decimal(data.openingBalance) }
              : {}),
            ...(data.openingBalanceType !== undefined
              ? { openingBalanceType: data.openingBalanceType }
              : {}),
          };
          dbState.ledgers[idx] = updated;
          const grp = dbState.groups.find((g) => g.id === updated.groupId)!;
          return { ...updated, group: { name: grp.name, rootType: grp.rootType } };
        }),
      },
      journalLine: {
        count: vi.fn(async ({ where }: any) => {
          return dbState.journalLineCountByLedger[where.ledgerId] || 0;
        }),
      },
      companySetting: {
        findUnique: vi.fn(async () => null),
      },
      company: {
        findUnique: vi.fn(async () => ({
          id: 'company-1',
          baseCurrency: 'INR',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
        })),
      },
      auditLog: {
        create: vi.fn(async () => ({ id: 'audit-1' })),
        findFirst: vi.fn(async () => null),
      },
      user: {
        findUnique: vi.fn(),
      },
      rolePermission: {
        findUnique: vi.fn(async () => null),
      },
    },
  };
});

import { prisma } from '../../src/server/db/client.js';
import { CoaService } from '../../src/server/services/coa.service.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { createApp } from '../../src/server/app.js';
import { previewStore } from '../../src/client/services/previewStore.ts';
import {
  suggestNextLedgerCode,
  validateLedgerCodeForGroup,
} from '../../src/shared/account-code.js';
import type { AuthUser } from '../../src/shared/types.js';

describe('CoreERP Chart of Accounts: Ledger Code Generation & Group Management', () => {
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

  function seedStandardGroups() {
    dbState.groups = [
      {
        id: 'grp-1000',
        companyId,
        code: '1000',
        name: 'Assets',
        rootType: 'ASSET',
        parentGroupId: null,
        isSystem: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'grp-2000',
        companyId,
        code: '2000',
        name: 'Liabilities',
        rootType: 'LIABILITY',
        parentGroupId: null,
        isSystem: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'grp-2100',
        companyId,
        code: '2100',
        name: 'Employees & Payroll',
        rootType: 'LIABILITY',
        parentGroupId: 'grp-2000',
        isSystem: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'grp-3000',
        companyId,
        code: '3000',
        name: 'Equity',
        rootType: 'EQUITY',
        parentGroupId: null,
        isSystem: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'grp-4000',
        companyId,
        code: '4000',
        name: 'Income',
        rootType: 'INCOME',
        parentGroupId: null,
        isSystem: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'grp-5000',
        companyId,
        code: '5000',
        name: 'Expenses',
        rootType: 'EXPENSE',
        parentGroupId: null,
        isSystem: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.ledgers = [];
    dbState.journalLineCountByLedger = {};
    dbState.injectP2002OnceOnCreate = false;
    seedStandardGroups();
    previewStore.reset();
  });

  describe('1. Multiple Ledgers per Account Group', () => {
    it('allows creating multiple unique ledgers under Assets (1000) and sequential groups without restriction', async () => {
      const l1 = await CoaService.createLedger(adminActor, {
        groupId: 'grp-1000',
        name: 'Cash in Hand',
      });
      const l2 = await CoaService.createLedger(adminActor, {
        groupId: 'grp-1000',
        name: 'HDFC Operating Bank',
      });
      const l3 = await CoaService.createLedger(adminActor, {
        groupId: 'grp-1000',
        name: 'ICICI Reserve Bank',
      });
      const l4 = await CoaService.createLedger(adminActor, {
        groupId: 'grp-1000',
        name: 'Accounts Receivable',
      });

      expect([l1.code, l2.code, l3.code, l4.code]).toEqual(['1001', '1002', '1003', '1004']);
      expect(new Set([l1.code, l2.code, l3.code, l4.code]).size).toBe(4);
    });

    it('supports unlimited overflow codes once the primary numeric block is exhausted', () => {
      const fullEmployeesBlock = Array.from({ length: 99 }, (_, i) => String(2101 + i));
      const overflow1 = suggestNextLedgerCode({
        targetGroup: dbState.groups.find((g) => g.id === 'grp-2100')!,
        allGroups: dbState.groups,
        existingLedgerCodes: fullEmployeesBlock,
      });
      expect(overflow1).toBe('2100-001');

      const overflowValidation = validateLedgerCodeForGroup({
        code: overflow1,
        targetGroup: dbState.groups.find((g) => g.id === 'grp-2100')!,
        allGroups: dbState.groups,
      });
      expect(overflowValidation.valid).toBe(true);
    });
  });

  describe('2. Automatic Ledger Code Suggestion', () => {
    it('suggests the first available code for every standard Account Group', async () => {
      expect((await CoaService.suggestNextCode(companyId, 'grp-1000')).suggestedCode).toBe('1001');
      expect((await CoaService.suggestNextCode(companyId, 'grp-2000')).suggestedCode).toBe('2001');
      expect((await CoaService.suggestNextCode(companyId, 'grp-2100')).suggestedCode).toBe('2101');
      expect((await CoaService.suggestNextCode(companyId, 'grp-3000')).suggestedCode).toBe('3001');
      expect((await CoaService.suggestNextCode(companyId, 'grp-4000')).suggestedCode).toBe('4001');
      expect((await CoaService.suggestNextCode(companyId, 'grp-5000')).suggestedCode).toBe('5001');
    });

    it('skips existing ledger codes and sub-group ranges when suggesting next code', async () => {
      await CoaService.createLedger(adminActor, {
        groupId: 'grp-1000',
        code: '1001',
        name: 'Vault Cash',
      });
      await CoaService.createLedger(adminActor, {
        groupId: 'grp-1000',
        code: '1002',
        name: 'Petty Cash',
      });

      const nextAsset = await CoaService.suggestNextCode(companyId, 'grp-1000');
      expect(nextAsset.suggestedCode).toBe('1003');

      // Liabilities (2000) skips 2100..2199 owned by Employees & Payroll (2100)
      const liabilityUsed = Array.from({ length: 99 }, (_, i) => String(2001 + i));
      const nextAfter2099 = suggestNextLedgerCode({
        targetGroup: dbState.groups.find((g) => g.id === 'grp-2000')!,
        allGroups: dbState.groups,
        existingLedgerCodes: liabilityUsed,
      });
      expect(nextAfter2099).toBe('2200');
    });

    it('supports previewStore automatic ledger code suggestions', () => {
      const suggestion = previewStore.suggestAccountLedgerCode('preview-grp-1000');
      expect(suggestion.suggestedCode).toBe('1001');
    });
  });

  describe('3. Manual Ledger Code Entry & Group Validation', () => {
    it('allows authorized users to enter valid manual ledger codes belonging to the selected group', async () => {
      const ledger = await CoaService.createLedger(adminActor, {
        groupId: 'grp-4000',
        code: '4050',
        codeSource: 'MANUAL',
        name: 'Digital Production Retainers',
      });
      expect(ledger.code).toBe('4050');
      expect(ledger.openingBalanceType).toBe('CREDIT');
    });

    it('rejects manual codes belonging to a different Account Group', async () => {
      await expect(
        CoaService.createLedger(adminActor, {
          groupId: 'grp-1000', // Assets
          code: '5001', // Expenses code
          codeSource: 'MANUAL',
          name: 'Misclassified Expense Under Assets',
        })
      ).rejects.toThrow(/does not belong to Account Group "Assets" \(1000\)/i);

      await expect(
        CoaService.createLedger(adminActor, {
          groupId: 'grp-2000', // Liabilities
          code: '2105', // Belongs to Employees & Payroll (2100)
          codeSource: 'MANUAL',
          name: 'Payroll Under Root Liabilities',
        })
      ).rejects.toThrow(/belongs to sub-group "Employees & Payroll" \(2100\)/i);
    });
  });

  describe('4. Duplicate Code Rejection', () => {
    it('rejects duplicate manual ledger codes within the same company with clear 409 message', async () => {
      await CoaService.createLedger(adminActor, {
        groupId: 'grp-5000',
        code: '5001',
        codeSource: 'MANUAL',
        name: 'Office Rent',
      });

      await expect(
        CoaService.createLedger(adminActor, {
          groupId: 'grp-5000',
          code: '5001',
          codeSource: 'MANUAL',
          name: 'Studio Rent',
        })
      ).rejects.toThrow(/Ledger code "5001" already exists/i);
    });

    it('rejects duplicate ledger code when updating an existing ledger', async () => {
      await CoaService.createLedger(adminActor, {
        groupId: 'grp-5000',
        code: '5001',
        name: 'Electricity',
      });
      const second = await CoaService.createLedger(adminActor, {
        groupId: 'grp-5000',
        code: '5002',
        name: 'Internet',
      });

      await expect(
        CoaService.updateLedger(adminActor, second.id, { code: '5001' })
      ).rejects.toThrow(/Ledger code "5001" already exists/i);
    });
  });

  describe('5. Concurrent Ledger Creation Safety', () => {
    it('allocates distinct sequential codes when multiple concurrent auto-code creations run simultaneously', async () => {
      const results = await Promise.all([
        CoaService.createLedger(adminActor, { groupId: 'grp-1000', code: '1001', codeSource: 'AUTO', name: 'Bank A' }),
        CoaService.createLedger(adminActor, { groupId: 'grp-1000', code: '1001', codeSource: 'AUTO', name: 'Bank B' }),
        CoaService.createLedger(adminActor, { groupId: 'grp-1000', code: '1001', codeSource: 'AUTO', name: 'Bank C' }),
        CoaService.createLedger(adminActor, { groupId: 'grp-1000', codeSource: 'AUTO', name: 'Bank D' }),
      ]);

      expect(results.map((r) => r.code)).toEqual(['1001', '1002', '1003', '1004']);
    });

    it('recovers from cross-process Prisma P2002 unique code race in AUTO mode by allocating next free code', async () => {
      dbState.injectP2002OnceOnCreate = true;

      const created = await CoaService.createLedger(adminActor, {
        groupId: 'grp-3000',
        code: '3001',
        codeSource: 'AUTO',
        name: 'Founder Equity',
      });

      // Concurrent winner took 3001 via P2002 simulation, so this request safely received 3002
      expect(created.code).toBe('3002');
      expect(created.openingBalanceType).toBe('CREDIT');
    });
  });

  describe('6. Root Classification Code Protection', () => {
    it.each(['1000', '2000', '2100', '3000', '4000', '5000'])(
      'prevents using reserved Account Group classification code %s as a ledger code',
      async (reservedCode) => {
        const groupId = `grp-${reservedCode}`;
        await expect(
          CoaService.createLedger(adminActor, {
            groupId,
            code: reservedCode,
            codeSource: 'MANUAL',
            name: `Forbidden Root ${reservedCode}`,
          })
        ).rejects.toThrow(/reserved Account Group classification code/i);
      }
    );
  });

  describe('7. Default Nature Consistency & RBAC HTTP Enforcement', () => {
    const app = createApp();
    const makeToken = (user: AuthUser) =>
      AuthService.generateSessionToken({
        userId: user.userId,
        companyId: user.companyId,
        email: user.email,
        role: user.role,
        tokenVersion: 1,
      });

    it('enforces default account nature across all 6 groups alongside automatic codes', async () => {
      const expectations: Array<{ groupId: string; expectedCode: string; expectedNature: 'DEBIT' | 'CREDIT' }> = [
        { groupId: 'grp-1000', expectedCode: '1001', expectedNature: 'DEBIT' },
        { groupId: 'grp-2000', expectedCode: '2001', expectedNature: 'CREDIT' },
        { groupId: 'grp-2100', expectedCode: '2101', expectedNature: 'CREDIT' },
        { groupId: 'grp-3000', expectedCode: '3001', expectedNature: 'CREDIT' },
        { groupId: 'grp-4000', expectedCode: '4001', expectedNature: 'CREDIT' },
        { groupId: 'grp-5000', expectedCode: '5001', expectedNature: 'DEBIT' },
      ];

      for (const item of expectations) {
        const ledger = await CoaService.createLedger(adminActor, {
          groupId: item.groupId,
          name: `Auto Ledger ${item.expectedCode}`,
        });
        expect(ledger.code).toBe(item.expectedCode);
        expect(ledger.openingBalanceType).toBe(item.expectedNature);
      }
    });

    it('enforces RBAC and API validation on GET /suggest-code and POST /ledgers', async () => {
      const adminToken = makeToken(adminActor);
      const viewerUser: AuthUser = {
        ...adminActor,
        id: 'user-view-1',
        userId: 'user-view-1',
        email: 'viewer@nammamedia.in',
        role: 'VICE_ADMIN',
      };
      const viewerToken = makeToken(viewerUser);

      (prisma.user.findUnique as any).mockImplementation(async ({ where }: any) => {
        if (where.id === viewerUser.id) {
          return { ...viewerUser, company: { isActive: true } };
        }
        return { ...adminActor, company: { isActive: true } };
      });

      // USER without ACCOUNTING:CREATE cannot request code suggestion or create ledgers
      const forbiddenSuggest = await request(app)
        .get('/api/accounting/ledgers/suggest-code?groupId=grp-1000')
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(forbiddenSuggest.status).toBe(403);

      // ADMIN gets suggested code 1001
      const okSuggest = await request(app)
        .get('/api/accounting/ledgers/suggest-code?groupId=grp-1000')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(okSuggest.status).toBe(200);
      expect(okSuggest.body.suggestedCode).toBe('1001');

      // ADMIN creates ledger via HTTP POST -> 201 with 1001 and DEBIT nature
      const createRes = await request(app)
        .post('/api/accounting/ledgers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ groupId: 'grp-1000', name: 'Bank Current Account' });
      expect(createRes.status).toBe(201);
      expect(createRes.body.code).toBe('1001');
      expect(createRes.body.openingBalanceType).toBe('DEBIT');

      // Next suggestion immediately advances to 1002
      const nextSuggest = await request(app)
        .get('/api/accounting/ledgers/suggest-code?groupId=grp-1000')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(nextSuggest.status).toBe(200);
      expect(nextSuggest.body.suggestedCode).toBe('1002');

      // Duplicate manual code returns 409 Conflict
      const dupRes = await request(app)
        .post('/api/accounting/ledgers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ groupId: 'grp-1000', code: '1001', codeSource: 'MANUAL', name: 'Second Bank' });
      expect(dupRes.status).toBe(409);
    });
  });

  describe('8. Preservation of Existing Financial Records', () => {
    it('does not renumber existing ledgers or alter opening balances when creating new ledgers or updating descriptions', async () => {
      // Seed historical ledger with legacy code 1010 and posted journal transactions
      const legacy = await CoaService.createLedger(adminActor, {
        groupId: 'grp-1000',
        code: '1010',
        codeSource: 'MANUAL',
        name: 'Legacy Operating Bank',
        openingBalance: '250000.0000',
      });
      dbState.journalLineCountByLedger[legacy.id] = 42;

      // Creating a new ledger under the same group leaves legacy 1010 untouched and gets 1001
      const added = await CoaService.createLedger(adminActor, {
        groupId: 'grp-1000',
        name: 'New Cash Vault',
      });
      expect(added.code).toBe('1001');

      // Editing legacy description preserves code 1010, balance 250000.0000, and nature DEBIT
      const updated = await CoaService.updateLedger(adminActor, legacy.id, {
        description: 'Preserved historical account',
      });
      expect(updated.code).toBe('1010');
      expect(updated.openingBalance).toBe('250000.0000');
      expect(updated.openingBalanceType).toBe('DEBIT');

      // Cannot clear existing ledger code
      await expect(
        CoaService.updateLedger(adminActor, legacy.id, { code: '' })
      ).rejects.toThrow(/cannot be cleared/i);
    });
  });
});
