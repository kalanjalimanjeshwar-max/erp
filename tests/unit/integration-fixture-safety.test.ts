import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  createIntegrationFixtureScope,
  disconnectIntegrationClients,
  FixturePrismaSubset,
  generateUniqueFixtureIdentifiers,
  runOwnedCleanupSteps,
  throwIfCleanupErrors,
  validateIntegrationDatabaseTarget,
} from '../helpers/integration-fixture-manager.js';

interface InMemoryStore {
  companies: Array<{ id: string; code: string; name: string }>;
  users: Array<{ id: string; companyId: string; email: string }>;
  companyBankAccounts: Array<{ id: string; companyId: string; bankName: string }>;
  biometricTerminals: Array<{ id: string; companyId: string; deviceSerialNumber: string }>;
  rawPunchLogs: Array<{ id: string; companyId: string; terminalId: string }>;
  companySettings: Array<{ id: string; companyId: string; key: string }>;
  auditLogs: Array<{ id: string; companyId: string; action: string }>;
}

function createInMemoryMockPrisma(store: InMemoryStore) {
  const operationLog: string[] = [];

  const filterDelete = <T extends { id: string; companyId?: string }>(
    arr: T[],
    where: any
  ): number => {
    if (!where || (where.id === undefined && where.companyId === undefined)) {
      throw new Error('Refusing unfiltered deleteMany in mock Prisma store');
    }
    const before = arr.length;
    const idSet =
      where.id?.in && Array.isArray(where.id.in)
        ? new Set<string>(where.id.in)
        : typeof where.id === 'string'
          ? new Set<string>([where.id])
          : null;
    const companyIdSet =
      where.companyId?.in && Array.isArray(where.companyId.in)
        ? new Set<string>(where.companyId.in)
        : typeof where.companyId === 'string'
          ? new Set<string>([where.companyId])
          : null;

    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const row = arr[i];
      const matchesId = idSet ? idSet.has(row.id) : true;
      const matchesCompany = companyIdSet ? (row.companyId ? companyIdSet.has(row.companyId) : false) : true;
      if (matchesId && matchesCompany) {
        arr.splice(i, 1);
      }
    }
    return before - arr.length;
  };

  const client: FixturePrismaSubset & {
    $disconnect: () => Promise<void>;
    upsertCalled: boolean;
  } = {
    upsertCalled: false,
    $disconnect: vi.fn(async () => {
      operationLog.push('$disconnect');
    }),
    company: {
      create: vi.fn(async ({ data }: any) => {
        operationLog.push(`company.create:${data.id}`);
        if (store.companies.some((c) => c.id === data.id || c.code === data.code)) {
          throw new Error(`Unique constraint failed on company (${data.id} / ${data.code})`);
        }
        const record = { id: data.id, code: data.code, name: data.name };
        store.companies.push(record);
        return record;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        operationLog.push('company.deleteMany');
        return { count: filterDelete(store.companies, where) };
      }),
    },
    user: {
      create: vi.fn(async ({ data }: any) => {
        operationLog.push(`user.create:${data.id}`);
        if (store.users.some((u) => u.id === data.id || u.email === data.email)) {
          throw new Error(`Unique constraint failed on user (${data.id} / ${data.email})`);
        }
        const record = { id: data.id, companyId: data.companyId, email: data.email };
        store.users.push(record);
        return record;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        operationLog.push('user.deleteMany');
        return { count: filterDelete(store.users, where) };
      }),
    },
    companyBankAccount: {
      create: vi.fn(async ({ data }: any) => {
        operationLog.push(`companyBankAccount.create:${data.id}`);
        const record = { id: data.id, companyId: data.companyId, bankName: data.bankName };
        store.companyBankAccounts.push(record);
        return record;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        operationLog.push('companyBankAccount.deleteMany');
        return { count: filterDelete(store.companyBankAccounts, where) };
      }),
    },
    biometricTerminal: {
      create: vi.fn(async ({ data }: any) => {
        operationLog.push(`biometricTerminal.create:${data.id}`);
        if (store.biometricTerminals.some((t) => t.deviceSerialNumber === data.deviceSerialNumber)) {
          throw new Error(`Unique constraint failed on terminal serial ${data.deviceSerialNumber}`);
        }
        const record = {
          id: data.id,
          companyId: data.companyId,
          deviceSerialNumber: data.deviceSerialNumber,
        };
        store.biometricTerminals.push(record);
        return record;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        operationLog.push('biometricTerminal.deleteMany');
        return { count: filterDelete(store.biometricTerminals, where) };
      }),
    },
    rawPunchLog: {
      deleteMany: vi.fn(async ({ where }: any) => {
        operationLog.push('rawPunchLog.deleteMany');
        return { count: filterDelete(store.rawPunchLogs, where) };
      }),
    },
    companySetting: {
      deleteMany: vi.fn(async ({ where }: any) => {
        operationLog.push('companySetting.deleteMany');
        return { count: filterDelete(store.companySettings, where) };
      }),
    },
    auditLog: {
      deleteMany: vi.fn(async ({ where }: any) => {
        operationLog.push('auditLog.deleteMany');
        return { count: filterDelete(store.auditLogs, where) };
      }),
    },
  };

  return { client, operationLog };
}

describe('Integration Fixture & Cleanup Safety Protection', () => {
  describe('1. Ownership-scoped cleanup never touches pre-existing records', () => {
    it('deletes ONLY test-owned fixtures in strict FK order and preserves all unrelated pre-existing rows', async () => {
      const store: InMemoryStore = {
        companies: [{ id: 'preexisting-company-1', code: 'PRE1', name: 'Preexisting Corp' }],
        users: [
          {
            id: 'preexisting-user-1',
            companyId: 'preexisting-company-1',
            email: 'owner@preexisting.local',
          },
        ],
        companyBankAccounts: [
          {
            id: 'preexisting-acc-1',
            companyId: 'preexisting-company-1',
            bankName: 'Preexisting Bank',
          },
        ],
        biometricTerminals: [
          {
            id: 'preexisting-term-1',
            companyId: 'preexisting-company-1',
            deviceSerialNumber: 'PRE-X2008-01',
          },
        ],
        rawPunchLogs: [
          {
            id: 'preexisting-punch-1',
            companyId: 'preexisting-company-1',
            terminalId: 'preexisting-term-1',
          },
        ],
        companySettings: [
          {
            id: 'preexisting-setting-1',
            companyId: 'preexisting-company-1',
            key: 'DEFAULT_CURRENCY',
          },
        ],
        auditLogs: [
          {
            id: 'preexisting-audit-1',
            companyId: 'preexisting-company-1',
            action: 'INITIAL_BOOTSTRAP',
          },
        ],
      };

      const { client, operationLog } = createInMemoryMockPrisma(store);
      const scope = createIntegrationFixtureScope('CONC', 'ownership-test');

      // Zero pre-test deletes occur before creating fixtures
      const company = await scope.createCompany(client, { name: 'Owned Test Co' });
      const user = await scope.createUser(client, {
        companyId: company.id,
        fullName: 'Owned Admin',
        role: 'ADMIN',
      });
      const acc1 = await scope.createCompanyBankAccount(client, {
        companyId: company.id,
        bankName: 'Alpha Bank',
        accountHolderName: 'Owned Test Co',
        accountNumber: 'enc:v1:k1:alpha',
      });
      const acc2 = await scope.createCompanyBankAccount(client, {
        companyId: company.id,
        bankName: 'Beta Bank',
        accountHolderName: 'Owned Test Co',
        accountNumber: 'enc:v1:k1:beta',
      });

      // Simulate service-generated audit log under the owned test company
      store.auditLogs.push({
        id: 'owned-audit-1',
        companyId: company.id,
        action: 'BANK_ACCOUNT_DEFAULT_CHANGED',
      });

      expect(operationLog.filter((op) => op.includes('deleteMany'))).toHaveLength(0);
      expect(scope.getTrackedSnapshot()).toEqual({
        companyIds: [company.id],
        userIds: [user.id],
        bankAccountIds: [acc1.id, acc2.id],
        terminalIds: [],
        employeeIds: [],
        shiftIds: [],
        rawPunchLogIds: [],
      });

      await scope.cleanup(client);

      // Verify strict child-to-parent foreign-key delete order
      const deleteOrder = operationLog.filter((op) => op.endsWith('.deleteMany'));
      expect(deleteOrder.indexOf('auditLog.deleteMany')).toBeLessThan(
        deleteOrder.indexOf('companyBankAccount.deleteMany')
      );
      expect(deleteOrder.indexOf('companyBankAccount.deleteMany')).toBeLessThan(
        deleteOrder.indexOf('user.deleteMany')
      );
      expect(deleteOrder.indexOf('user.deleteMany')).toBeLessThan(
        deleteOrder.indexOf('company.deleteMany')
      );

      // Verify ALL owned fixtures were deleted
      expect(store.companies.map((c) => c.id)).toEqual(['preexisting-company-1']);
      expect(store.users.map((u) => u.id)).toEqual(['preexisting-user-1']);
      expect(store.companyBankAccounts.map((a) => a.id)).toEqual(['preexisting-acc-1']);
      expect(store.biometricTerminals.map((t) => t.id)).toEqual(['preexisting-term-1']);
      expect(store.rawPunchLogs.map((p) => p.id)).toEqual(['preexisting-punch-1']);
      expect(store.companySettings.map((s) => s.id)).toEqual(['preexisting-setting-1']);
      expect(store.auditLogs.map((a) => a.id)).toEqual(['preexisting-audit-1']);

      // Subsequent cleanup call is an explicit no-op
      const countBeforeSecondCleanup = operationLog.length;
      await scope.cleanup(client);
      expect(operationLog.length).toBe(countBeforeSecondCleanup);
    });

    it('performs zero database deletes when cleaning up an empty scope', async () => {
      const store: InMemoryStore = {
        companies: [{ id: 'untouched-co', code: 'KEEP', name: 'Keep Me' }],
        users: [],
        companyBankAccounts: [],
        biometricTerminals: [],
        rawPunchLogs: [],
        companySettings: [],
        auditLogs: [],
      };
      const { client, operationLog } = createInMemoryMockPrisma(store);
      const emptyScope = createIntegrationFixtureScope('EMPTY');

      await emptyScope.cleanup(client);
      expect(operationLog).toHaveLength(0);
      expect(store.companies).toHaveLength(1);
    });
  });

  describe('2. Unique identifier generation prevents collisions across runs', () => {
    it('generates strictly disjoint IDs, codes, emails, and device serials across sequential and parallel runs', () => {
      const batches = Array.from({ length: 50 }, () => generateUniqueFixtureIdentifiers('CONC'));

      const companyIds = new Set(batches.map((b) => b.companyId));
      const companyCodes = new Set(batches.map((b) => b.companyCode));
      const userIds = new Set(batches.map((b) => b.userId));
      const userEmails = new Set(batches.map((b) => b.userEmail));
      const employeeIds = new Set(batches.map((b) => b.employeeId));
      const employeeCodes = new Set(batches.map((b) => b.employeeCode));
      const terminalIds = new Set(batches.map((b) => b.terminalId));
      const serials = new Set(batches.map((b) => b.deviceSerialNumber));

      expect(companyIds.size).toBe(50);
      expect(companyCodes.size).toBe(50);
      expect(userIds.size).toBe(50);
      expect(userEmails.size).toBe(50);
      expect(employeeIds.size).toBe(50);
      expect(employeeCodes.size).toBe(50);
      expect(terminalIds.size).toBe(50);
      expect(serials.size).toBe(50);

      for (const id of [...companyIds, ...userIds, ...employeeIds, ...terminalIds]) {
        expect(id).not.toMatch(/^00000000-0000-4000-a000-/i);
      }
    });

    it('proactively rejects legacy fixed UUIDs in fixture creation and tracking', async () => {
      const store: InMemoryStore = {
        companies: [],
        users: [],
        companyBankAccounts: [],
        biometricTerminals: [],
        rawPunchLogs: [],
        companySettings: [],
        auditLogs: [],
      };
      const { client } = createInMemoryMockPrisma(store);
      const scope = createIntegrationFixtureScope('GUARD');

      await expect(
        scope.createCompany(client, {
          id: '00000000-0000-4000-a000-000000000099',
          name: 'Legacy Fixed Company',
        })
      ).rejects.toThrow(/FIXTURE SAFETY VIOLATION/);

      expect(() => scope.trackUserId('00000000-0000-4000-a000-000000000001')).toThrow(
        /FIXTURE SAFETY VIOLATION/
      );
    });
  });

  describe('3. Partial fixture creation failures still clean up already-created records', () => {
    it('cleans up company, user, and first bank account when second bank account creation throws', async () => {
      const store: InMemoryStore = {
        companies: [{ id: 'preexisting-co', code: 'BASE', name: 'Base Co' }],
        users: [],
        companyBankAccounts: [],
        biometricTerminals: [],
        rawPunchLogs: [],
        companySettings: [],
        auditLogs: [],
      };
      const { client } = createInMemoryMockPrisma(store);
      const scope = createIntegrationFixtureScope('PARTIAL');

      let bankCreateAttempt = 0;
      const origCreate = client.companyBankAccount!.create;
      client.companyBankAccount!.create = vi.fn(async (args: any) => {
        bankCreateAttempt += 1;
        if (bankCreateAttempt === 2) {
          throw new Error('Simulated DB error while creating acc2');
        }
        return origCreate(args);
      });

      let caughtError: Error | null = null;
      try {
        const company = await scope.createCompany(client, { name: 'Partial Fail Co' });
        await scope.createUser(client, {
          companyId: company.id,
          fullName: 'Partial Admin',
          role: 'ADMIN',
        });
        await scope.createCompanyBankAccount(client, {
          companyId: company.id,
          bankName: 'Acc1 Bank',
          accountHolderName: 'Partial Fail Co',
          accountNumber: 'enc:v1:k1:1111',
        });
        await scope.createCompanyBankAccount(client, {
          companyId: company.id,
          bankName: 'Acc2 Bank',
          accountHolderName: 'Partial Fail Co',
          accountNumber: 'enc:v1:k1:2222',
        });
      } catch (err) {
        caughtError = err as Error;
      } finally {
        await scope.cleanup(client);
      }

      expect(caughtError?.message).toContain('Simulated DB error while creating acc2');
      // Only the pre-existing company remains; all partially created records were cleaned up
      expect(store.companies.map((c) => c.id)).toEqual(['preexisting-co']);
      expect(store.users).toHaveLength(0);
      expect(store.companyBankAccounts).toHaveLength(0);
    });
  });

  describe('4. Cleanup and disconnect failures are surfaced loudly (never silently swallowed)', () => {
    it('throws [INTEGRATION CLEANUP FAILED] with full context when any delete step fails', async () => {
      const store: InMemoryStore = {
        companies: [],
        users: [],
        companyBankAccounts: [],
        biometricTerminals: [],
        rawPunchLogs: [],
        companySettings: [],
        auditLogs: [],
      };
      const { client } = createInMemoryMockPrisma(store);
      const scope = createIntegrationFixtureScope('FAILCLEAN', 'cleanup-error-test');

      const company = await scope.createCompany(client, { name: 'Fail Cleanup Co' });
      await scope.createUser(client, {
        companyId: company.id,
        fullName: 'Admin',
        role: 'ADMIN',
      });

      client.user.deleteMany = vi.fn(async () => {
        throw new Error('Simulated FK constraint violation on User');
      });

      await expect(scope.cleanup(client)).rejects.toThrow(
        /\[INTEGRATION CLEANUP FAILED\].*cleanup-error-test.*Simulated FK constraint violation on User/s
      );
    });

    it('aggregates errors across runOwnedCleanupSteps and multiple Prisma $disconnect calls without skipping remaining clients', async () => {
      const disconnect1 = vi.fn(async () => {
        throw new Error('client1 socket hangup');
      });
      const disconnect2 = vi.fn(async () => {
        throw new Error('client2 timeout');
      });

      const stepErrors = await runOwnedCleanupSteps('companyId=test-co', [
        {
          label: 'auditLog',
          run: async () => {
            throw new Error('auditLog lock timeout');
          },
        },
        {
          label: 'company',
          run: async () => ({ count: 1 }),
        },
      ]);

      const disconnectErrors = await disconnectIntegrationClients([
        { label: 'testPrisma1', client: { $disconnect: disconnect1 } },
        { label: 'testPrisma2', client: { $disconnect: disconnect2 } },
      ]);

      expect(disconnect1).toHaveBeenCalledTimes(1);
      expect(disconnect2).toHaveBeenCalledTimes(1);

      const allErrors = [...stepErrors, ...disconnectErrors];
      expect(allErrors).toHaveLength(3);
      expect(() => throwIfCleanupErrors(allErrors, 'multi-client-suite')).toThrow(
        /\[INTEGRATION CLEANUP FAILED\].*auditLog lock timeout.*client1 socket hangup.*client2 timeout/s
      );
    });
  });

  describe('5. Concurrent isolated fixtures across independent Prisma clients', () => {
    it('keeps two concurrent scopes completely isolated so cleaning up scope A never affects scope B', async () => {
      const sharedStore: InMemoryStore = {
        companies: [{ id: 'baseline-co', code: 'BASE', name: 'Baseline' }],
        users: [],
        companyBankAccounts: [],
        biometricTerminals: [],
        rawPunchLogs: [],
        companySettings: [],
        auditLogs: [],
      };
      const mock1 = createInMemoryMockPrisma(sharedStore);
      const mock2 = createInMemoryMockPrisma(sharedStore);

      const scopeA = createIntegrationFixtureScope('RUNA', 'concurrent-run-a');
      const scopeB = createIntegrationFixtureScope('RUNB', 'concurrent-run-b');

      const [resA, resB] = await Promise.all([
        (async () => {
          const co = await scopeA.createCompany(mock1.client, { name: 'Run A Co' });
          const user = await scopeA.createUser(mock1.client, {
            companyId: co.id,
            fullName: 'User A',
            role: 'ADMIN',
          });
          const acc = await scopeA.createCompanyBankAccount(mock1.client, {
            companyId: co.id,
            bankName: 'Bank A',
            accountHolderName: 'Run A Co',
            accountNumber: 'enc:v1:k1:a',
          });
          return { co, user, acc };
        })(),
        (async () => {
          const co = await scopeB.createCompany(mock2.client, { name: 'Run B Co' });
          const user = await scopeB.createUser(mock2.client, {
            companyId: co.id,
            fullName: 'User B',
            role: 'ADMIN',
          });
          const acc = await scopeB.createCompanyBankAccount(mock2.client, {
            companyId: co.id,
            bankName: 'Bank B',
            accountHolderName: 'Run B Co',
            accountNumber: 'enc:v1:k1:b',
          });
          return { co, user, acc };
        })(),
      ]);

      expect(resA.co.id).not.toBe(resB.co.id);
      expect(resA.user.email).not.toBe(resB.user.email);

      // Clean up scope A first -> scope B and baseline must remain completely intact
      await scopeA.cleanup(mock1.client);
      expect(sharedStore.companies.map((c) => c.id)).toEqual(['baseline-co', resB.co.id]);
      expect(sharedStore.users.map((u) => u.id)).toEqual([resB.user.id]);
      expect(sharedStore.companyBankAccounts.map((a) => a.id)).toEqual([resB.acc.id]);

      // Clean up scope B -> only baseline remains
      await scopeB.cleanup(mock2.client);
      expect(sharedStore.companies.map((c) => c.id)).toEqual(['baseline-co']);
      expect(sharedStore.users).toHaveLength(0);
      expect(sharedStore.companyBankAccounts).toHaveLength(0);
    });
  });

  describe('6. Integration database target validation rejects all non-integration targets', () => {
    it('returns blocked status when integration mode is off or TEST_DATABASE_URL is missing', () => {
      expect(
        validateIntegrationDatabaseTarget({
          integrationMode: undefined,
          testDatabaseUrl: 'postgresql://u:p@localhost:5434/core_erp_integration_test',
        }).status
      ).toBe('blocked');

      expect(
        validateIntegrationDatabaseTarget({
          integrationMode: 'true',
          testDatabaseUrl: '',
        }).status
      ).toBe('blocked');
    });

    it('accepts dedicated localhost:5434 and 127.0.0.1:5434 core_erp_integration_test when DATABASE_URL is unset', () => {
      const localResult = validateIntegrationDatabaseTarget({
        integrationMode: 'true',
        testDatabaseUrl:
          'postgresql://erp_integration_user:secret@localhost:5434/core_erp_integration_test?schema=public',
        databaseUrl: undefined,
      });
      expect(localResult.status).toBe('valid');
      if (localResult.status === 'valid') {
        expect(localResult.host).toBe('localhost');
        expect(localResult.port).toBe(5434);
        expect(localResult.databaseName).toBe('core_erp_integration_test');
      }

      const loopbackResult = validateIntegrationDatabaseTarget({
        integrationMode: 'true',
        testDatabaseUrl:
          'postgresql://erp_integration_user:secret@127.0.0.1:5434/core_erp_integration_test?schema=public',
        databaseUrl: undefined,
      });
      expect(loopbackResult.status).toBe('valid');
    });

    it('refuses defined DATABASE_URL, dev/test/staging/shadow ports, remote hosts, non-PG protocols, and forbidden DB names without leaking secrets', () => {
      const secretToken = 'SUPER_SECRET_INTEGRATION_PASSWORD_999';

      const unsafeCases: Array<{ name: string; input: Parameters<typeof validateIntegrationDatabaseTarget>[0] }> = [
        {
          name: 'DATABASE_URL defined in integration mode',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `postgresql://u:${secretToken}@localhost:5434/core_erp_integration_test`,
            databaseUrl: `postgresql://dev:${secretToken}@localhost:5432/core_erp`,
          },
        },
        {
          name: 'dev port 5432',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `postgresql://u:${secretToken}@localhost:5432/core_erp_integration_test`,
          },
        },
        {
          name: 'implicit default port (5432)',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `postgresql://u:${secretToken}@localhost/core_erp_integration_test`,
          },
        },
        {
          name: 'unit test port 5433',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `postgresql://u:${secretToken}@localhost:5433/core_erp_test`,
          },
        },
        {
          name: 'staging port 5435',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `postgresql://u:${secretToken}@localhost:5435/core_erp_staging`,
          },
        },
        {
          name: 'shadow port 5436',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `postgresql://u:${secretToken}@localhost:5436/core_erp_shadow`,
          },
        },
        {
          name: 'protected database name core_erp on port 5434',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `postgresql://u:${secretToken}@localhost:5434/core_erp`,
          },
        },
        {
          name: 'protected database name core_erp_staging on port 5434',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `postgresql://u:${secretToken}@localhost:5434/core_erp_staging`,
          },
        },
        {
          name: 'remote production host',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `postgresql://u:${secretToken}@prod-db.internal.company.com:5434/core_erp_integration_test`,
          },
        },
        {
          name: 'non-PostgreSQL protocol',
          input: {
            integrationMode: 'true',
            testDatabaseUrl: `mysql://u:${secretToken}@localhost:5434/core_erp_integration_test`,
          },
        },
      ];

      for (const testCase of unsafeCases) {
        let thrown: Error | null = null;
        try {
          validateIntegrationDatabaseTarget(testCase.input);
        } catch (err) {
          thrown = err as Error;
        }
        expect(thrown, `Expected rejection for ${testCase.name}`).not.toBeNull();
        expect(thrown!.message).toContain('[SECURITY FATAL]');
        expect(thrown!.message).not.toContain(secretToken);
      }
    });
  });

  describe('7. Repository-wide static safety regression audit of tests/integration/*.test.ts', () => {
    const integrationDir = path.resolve(process.cwd(), 'tests/integration');
    const integrationFiles = fs
      .readdirSync(integrationDir)
      .filter((f) => f.endsWith('.test.ts'))
      .sort();

    it('contains zero fixed legacy fixture UUIDs, zero fixture upsert reuse, zero silent empty catch blocks, zero tolerateCleanupErrors swallowing, and zero TRUNCATE statements', () => {
      expect(integrationFiles.length).toBeGreaterThanOrEqual(12);

      for (const fileName of integrationFiles) {
        const content = fs.readFileSync(path.join(integrationDir, fileName), 'utf8');

        // 1. No legacy fixed fixture UUIDs
        expect(content, `${fileName} must not contain fixed legacy fixture UUIDs`).not.toMatch(
          /00000000-0000-4000-a000-/i
        );

        // 2. No upsert() for tenant/user/terminal/bank-account fixture seeding
        expect(content, `${fileName} must not use upsert() to seed fixtures`).not.toMatch(
          /\.(company|user|companyBankAccount|biometricTerminal)\.upsert\s*\(/
        );

        // 3. No empty catch {} blocks silently swallowing cleanup or disconnect failures
        expect(content, `${fileName} must not contain empty catch {} blocks`).not.toMatch(
          /catch\s*(\([^)]*\))?\s*\{\s*\}/
        );

        // 4. No tolerateCleanupErrors = true warning-only cleanup swallowing
        expect(
          content,
          `${fileName} must not pass tolerateCleanupErrors = true to swallow cleanup errors`
        ).not.toMatch(/tolerateCleanupErrors/);

        // 5. No TRUNCATE or global table wipes
        expect(content, `${fileName} must not execute TRUNCATE`).not.toMatch(/\bTRUNCATE\b/i);
      }
    });

    it('preserves dual Prisma clients and real concurrency verification in concurrent-bank-account-default.test.ts', () => {
      const content = fs.readFileSync(
        path.join(integrationDir, 'concurrent-bank-account-default.test.ts'),
        'utf8'
      );

      expect(content).toContain('testPrisma1');
      expect(content).toContain('testPrisma2');
      expect(content).toContain('CompanyBankAccountService.setDefaultAccount');
      expect(content).toContain('toBe(409)');
      expect(content).toContain('core_erp_integration_test');
      expect(content).toContain('createIntegrationFixtureScope');
      expect(content).not.toContain('cleanupTestData');
    });
  });
});
