import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  configureIntegrationPrismaClient,
  resetPrismaClientForTesting,
} from '../../src/server/db/client.js';
import { CompanyBankAccountService } from '../../src/server/services/company-bank-account.service.js';
import { EncryptionService } from '../../src/server/security/encryption.service.js';
import { AuthUser } from '../../src/shared/types.js';
import {
  checkTcpPortReachable,
  createIntegrationFixtureScope,
  disconnectIntegrationClients,
  IntegrationFixtureScope,
  throwIfCleanupErrors,
  validateIntegrationDatabaseTarget,
} from '../helpers/integration-fixture-manager.js';

/**
 * Real PostgreSQL 16 Concurrency Integration Test:
 * Concurrent Default-Account Switching & Partial Unique Index Verification
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires TEST_DATABASE_URL pointing to isolated 'core_erp_integration_test' on port 5434.
 * 2. Never connects to production, development, or standard unit-test databases.
 * 3. If TEST_DATABASE_URL is not set or PostgreSQL 16 is not reachable on localhost:5434, marks
 *    execution status as BLOCKED / NOT RUN without falsifying real concurrency through mocks.
 * 4. Executes independent concurrent transactions against PostgreSQL 16 to prove:
 *    - "CompanyBankAccount_companyId_default_unique" index prevents duplicate active defaults.
 *    - Competing concurrent update maps constraint failure (23505 / P2002) to HTTP 409 Conflict.
 *    - Final committed state contains strictly one active default account per company.
 * 5. Creates uniquely generated, test-owned fixtures (never fixed IDs or upsert reuse), never
 *    performs destructive pre-test cleanup, and deletes only tracked test-owned records while
 *    surfacing any cleanup or disconnect failures.
 */

describe('PostgreSQL 16 Concurrency Integration Test: Default Bank Account Switching', () => {
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma1: PrismaClient | null = null;
  let testPrisma2: PrismaClient | null = null;
  const activeScopes: IntegrationFixtureScope[] = [];

  beforeAll(async () => {
    // 1. Strictly validate integration mode, unset DATABASE_URL, and dedicated localhost:5434/core_erp_integration_test target
    const target = validateIntegrationDatabaseTarget({
      integrationMode: process.env.COREERP_INTEGRATION_TEST_MODE,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      databaseUrl: process.env.DATABASE_URL,
      suiteLabel: 'PostgreSQL 16 concurrency integration test',
    });

    if (target.status === 'blocked') {
      blockedReason = target.reason;
      console.warn(
        `\n${blockedReason}` +
          '\nTo run live concurrency tests against PostgreSQL 16 on Windows/Docker:' +
          '\n  1. Start container: docker compose --env-file .env.integration-test -f docker-compose.integration-test.yml up -d' +
          '\n  2. Deploy migrations: DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx prisma migrate deploy' +
          '\n  3. Run test: TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npm run test:integration:concurrency\n'
      );
      return;
    }

    const probe = await checkTcpPortReachable(target.host, target.port);
    if (!probe.reachable) {
      blockedReason =
        `[BLOCKED / NOT RUN] PostgreSQL 16 integration database is unreachable at ${target.host}:${target.port} ` +
        `(${probe.code || 'UNREACHABLE'}).`;
      console.warn(
        `\n${blockedReason}` +
          '\nTo run live concurrency tests against PostgreSQL 16 on Windows/Docker:' +
          '\n  1. Start container: docker compose --env-file .env.integration-test -f docker-compose.integration-test.yml up -d' +
          '\n  2. Deploy migrations: DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx prisma migrate deploy' +
          '\n  3. Run test: TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npm run test:integration:concurrency\n'
      );
      return;
    }

    // Endpoint is reachable: do NOT catch or downgrade $connect(), auth, missing DB, PG version, identity, or Prisma errors.
    testPrisma1 = configureIntegrationPrismaClient(target.cleanedUrl);
    testPrisma2 = new PrismaClient({ datasources: { db: { url: target.cleanedUrl } } });
    await testPrisma1.$connect();
    await testPrisma2.$connect();
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.COREERP_INTEGRATION_TEST_MODE).toBe('true');

    // Verify secondary integration client database identity immediately after connect
    const dbRows2 = await testPrisma2.$queryRawUnsafe<Array<{ db_name: string }>>(
      'SELECT current_database() AS db_name;'
    );
    const actualDbName2 = dbRows2[0]?.db_name;
    if (actualDbName2 !== 'core_erp_integration_test') {
      throw new Error(
        `[SECURITY FATAL] Secondary integration client connected to unexpected database "${actualDbName2 || 'unknown'}".`
      );
    }

    // Verify PostgreSQL major version 16
    const versionResult = await testPrisma1.$queryRawUnsafe<Array<{ version: string }>>('SELECT version();');
    const versionString = versionResult[0]?.version || '';
    const isPg16 = /PostgreSQL\s+16\b/i.test(versionString);
    if (!isPg16) {
      throw new Error(
        '[SECURITY FATAL] Integration test requires PostgreSQL major version 16.'
      );
    }

    // Verify connected database identity
    const dbRows = await testPrisma1.$queryRawUnsafe<Array<{ db_name: string }>>(
      'SELECT current_database() AS db_name;'
    );
    const actualDbName = dbRows[0]?.db_name;
    if (actualDbName !== 'core_erp_integration_test') {
      throw new Error(
        `[SECURITY FATAL] Integration client connected to unexpected database "${actualDbName || 'unknown'}".`
      );
    }

    isDbConnected = true;
  });

  afterAll(async () => {
    const cleanupErrors: string[] = [];
    try {
      if (testPrisma1 && isDbConnected) {
        for (const scope of activeScopes) {
          if (scope.hasTrackedRecords()) {
            const scopeErrors = await scope.cleanup(testPrisma1, { returnErrors: true });
            cleanupErrors.push(...scopeErrors);
          }
        }
      }
    } finally {
      const disconnectErrors = await disconnectIntegrationClients([
        { label: 'testPrisma1', client: testPrisma1 },
        { label: 'testPrisma2', client: testPrisma2 },
      ]);
      cleanupErrors.push(...disconnectErrors);
      resetPrismaClientForTesting();
    }

    throwIfCleanupErrors(cleanupErrors, 'concurrent-bank-account-default');
  });

  it('should enforce exactly one active default bank account under real concurrent switching', async (ctx) => {
    if (blockedReason) {
      console.warn(blockedReason);
      await ctx.annotate(blockedReason, 'blocked');
      ctx.skip(blockedReason);
    }

    if (!isDbConnected || !testPrisma1 || !testPrisma2) {
      throw new Error(
        '[INTEGRATION TEST INVARIANT ERROR] Database connection state inconsistent without blockedReason.'
      );
    }

    // Initialize encryption service for test session
    EncryptionService.init();

    const fixtures = createIntegrationFixtureScope('CONC', 'bank-account-default-concurrency');
    activeScopes.push(fixtures);

    try {
      // Setup: Create uniquely identified, test-owned company, user actor, and two active accounts
      const company = await fixtures.createCompany(testPrisma1, {
        name: `Concurrency Test Corp ${fixtures.tokens.runToken}`,
        currency: 'USD',
        timezone: 'UTC',
      });

      const user = await fixtures.createUser(testPrisma1, {
        companyId: company.id,
        fullName: 'Integration Test Admin',
        role: 'ADMIN',
        isActive: true,
      });

      const testActor: AuthUser = {
        id: user.id,
        userId: user.id,
        companyId: company.id,
        email: user.email,
        fullName: 'Integration Test Admin',
        role: 'ADMIN',
        isActive: true,
        tokenVersion: 1,
      };

      const encAcc1 = EncryptionService.encrypt('1111222233334444')!;
      const encAcc2 = EncryptionService.encrypt('5555666677778888')!;

      const acc1 = await fixtures.createCompanyBankAccount(testPrisma1, {
        companyId: company.id,
        bankName: 'Concurrent Bank Alpha',
        accountHolderName: company.name,
        accountNumber: encAcc1,
        isDefault: false,
        isActive: true,
      });

      const acc2 = await fixtures.createCompanyBankAccount(testPrisma1, {
        companyId: company.id,
        bankName: 'Concurrent Bank Beta',
        accountHolderName: company.name,
        accountNumber: encAcc2,
        isDefault: false,
        isActive: true,
      });

      // Fire two competing transactions concurrently to set both as default
      const [res1, res2] = await Promise.allSettled([
        CompanyBankAccountService.setDefaultAccount(testActor, acc1.id),
        CompanyBankAccountService.setDefaultAccount(testActor, acc2.id),
      ]);

      // One must succeed, while the competing concurrent update encounters conflict (or handles gracefully)
      const successCount = [res1, res2].filter((r) => r.status === 'fulfilled').length;
      const rejectedCount = [res1, res2].filter((r) => r.status === 'rejected').length;

      if (successCount === 0) {
        const formatRejection = (res: PromiseSettledResult<any>, idx: number) => {
          if (res.status === 'rejected') {
            const reason = res.reason;
            return `Op ${idx}: code=${reason?.code || 'N/A'}, status=${reason?.statusCode || 'N/A'}, message=${reason?.message || reason}`;
          }
          return `Op ${idx}: fulfilled`;
        };
        console.error(
          `[CONCURRENCY TEST FAILURE] Both competing operations rejected:\n  ${formatRejection(res1, 1)}\n  ${formatRejection(res2, 2)}`
        );
      }

      expect(successCount).toBeGreaterThanOrEqual(1);

      if (rejectedCount > 0) {
        const rejected = [res1, res2].find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect((rejected.reason as { statusCode?: number })?.statusCode).toBe(409);
      }

      // Verify database invariant: Exactly ONE default account can be active in the real PostgreSQL table
      const defaultAccounts = await testPrisma1.companyBankAccount.findMany({
        where: {
          companyId: company.id,
          isDefault: true,
          isActive: true,
        },
      });

      expect(defaultAccounts.length).toBe(1);
      expect([acc1.id, acc2.id]).toContain(defaultAccounts[0].id);
    } finally {
      await fixtures.cleanup(testPrisma1);
    }
  });
});
