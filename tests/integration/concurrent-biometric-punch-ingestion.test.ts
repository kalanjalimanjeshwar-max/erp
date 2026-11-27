import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import {
  configureIntegrationPrismaClient,
  getPrismaClient,
  prisma,
  resetPrismaClientForTesting,
  verifyDatabaseUrlConsistency,
} from '../../src/server/db/client.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';
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
 * Concurrent Biometric Raw Punch Ingestion & `skipDuplicates` Idempotency
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL
 *    pointing to isolated 'core_erp_integration_test' on localhost:5434.
 * 2. Never connects to operational (5432), development (5432), or standard unit-test (5433) databases.
 * 3. If integration mode is not enabled, TEST_DATABASE_URL is missing, or the dedicated PostgreSQL
 *    TCP endpoint on localhost:5434 is unreachable, marks the test genuinely SKIPPED via `ctx.skip(...)`
 *    with an explicit `[BLOCKED / NOT RUN]` diagnostic note — never falsely reporting PASS.
 * 4. Once localhost:5434 is reachable, never masks `$connect()`, authentication, missing database,
 *    missing migration/table, PostgreSQL version, or Prisma configuration errors.
 * 5. Creates uniquely generated, test-owned fixtures (never fixed IDs or pre-test destructive cleanup),
 *    and deletes only tracked test-owned records while surfacing any cleanup or disconnect failures.
 */
describe('PostgreSQL 16 Concurrency Integration Test: Biometric Raw Punch Ingestion', () => {
  let validatedTestDbUrl: string | null = null;
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma: PrismaClient | null = null;
  const activeScopes: IntegrationFixtureScope[] = [];

  beforeAll(async () => {
    const target = validateIntegrationDatabaseTarget({
      integrationMode: process.env.COREERP_INTEGRATION_TEST_MODE,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      databaseUrl: process.env.DATABASE_URL,
      suiteLabel: 'Biometric PostgreSQL 16 integration test',
    });

    if (target.status === 'blocked') {
      blockedReason = target.reason;
      console.warn(`\n${blockedReason}\n`);
      return;
    }

    const probe = await checkTcpPortReachable(target.host, target.port);
    if (!probe.reachable) {
      blockedReason =
        `[BLOCKED / NOT RUN] PostgreSQL 16 integration endpoint is unreachable at ${target.host}:${target.port} ` +
        `(${probe.code || 'UNREACHABLE'}). No integration assertions were executed.`;
      console.warn(`\n${blockedReason}\n`);
      return;
    }

    validatedTestDbUrl = target.cleanedUrl;

    // Endpoint is reachable: do NOT catch or downgrade $connect(), auth, missing DB, schema, or config errors.
    testPrisma = configureIntegrationPrismaClient(target.cleanedUrl);
    await testPrisma.$connect();

    const versionRows = await testPrisma.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
    const serverVersion = versionRows[0]?.version || '';
    if (!/PostgreSQL 16\b/.test(serverVersion)) {
      throw new Error(
        `[INTEGRATION ENV ERROR] Expected PostgreSQL 16 on localhost:5434, got: "${serverVersion || 'unknown'}".`
      );
    }

    const dbRows = await testPrisma.$queryRaw<Array<{ db_name: string }>>`SELECT current_database() AS db_name`;
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
      if (testPrisma && isDbConnected) {
        for (const scope of activeScopes) {
          if (scope.hasTrackedRecords()) {
            const scopeErrors = await scope.cleanup(testPrisma, { returnErrors: true });
            cleanupErrors.push(...scopeErrors);
          }
        }
      }
    } finally {
      const disconnectErrors = await disconnectIntegrationClients([
        { label: 'testPrisma', client: testPrisma },
      ]);
      cleanupErrors.push(...disconnectErrors);
      resetPrismaClientForTesting();
    }

    throwIfCleanupErrors(cleanupErrors, 'concurrent-biometric-punch-ingestion');
  });

  it('should deduplicate concurrent identical raw punch batches atomically on PostgreSQL 16', async (ctx) => {
    if (blockedReason) {
      console.warn(blockedReason);
      await ctx.annotate(blockedReason, 'blocked');
      ctx.skip(blockedReason);
    }

    if (!isDbConnected || !testPrisma || !validatedTestDbUrl) {
      throw new Error(
        '[INTEGRATION TEST INVARIANT ERROR] Database connection state inconsistent without blockedReason.'
      );
    }

    // Prove singleton & proxy routing points strictly to the dedicated localhost:5434 integration client
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.COREERP_INTEGRATION_TEST_MODE).toBe('true');
    expect(getPrismaClient()).toBe(testPrisma);
    expect(global.__prismaClient).toBe(testPrisma);

    const configuredEngineUrl = (testPrisma as any)._engineConfig?.overrideDatasources?.db?.url;
    const proxiedEngineUrl = (prisma as any)._engineConfig?.overrideDatasources?.db?.url;
    expect(configuredEngineUrl).toBe(validatedTestDbUrl);
    expect(proxiedEngineUrl).toBe(validatedTestDbUrl);

    const urlConsistency = verifyDatabaseUrlConsistency(validatedTestDbUrl, prisma);
    expect(urlConsistency.consistent).toBe(true);
    expect(urlConsistency.portMatch).toBe(true);
    expect(urlConsistency.databaseMatch).toBe(true);

    const liveDbCheck = await prisma.$queryRaw<
      Array<{ db_name: string; db_user: string; server_port: number | null }>
    >`
      SELECT current_database() AS db_name, current_user AS db_user, inet_server_port() AS server_port
    `;
    expect(liveDbCheck[0]?.db_name).toBe('core_erp_integration_test');
    expect(liveDbCheck[0]?.db_user).toBe('erp_integration_user');
    // Docker maps host port 5434 to container-internal port 5432 ("5434:5432"), so PostgreSQL's
    // inet_server_port() reports 5432 inside the container (or 5434 on a native host listener).
    // Client-side host port 5434 routing is strictly enforced above via _engineConfig & verifyDatabaseUrlConsistency.
    if (liveDbCheck[0]?.server_port !== null && liveDbCheck[0]?.server_port !== undefined) {
      expect([5432, 5434]).toContain(liveDbCheck[0].server_port);
    }

    const fixtures = createIntegrationFixtureScope('BIOINT', 'biometric-punch-ingestion');
    activeScopes.push(fixtures);

    try {
      const company = await fixtures.createCompany(testPrisma, {
        name: `Biometric Integration Co ${fixtures.tokens.runToken}`,
        currency: 'USD',
        timezone: 'UTC',
      });

      const user = await fixtures.createUser(testPrisma, {
        companyId: company.id,
        fullName: 'Integration Admin',
        passwordHash: 'not-used-in-test',
        role: 'ADMIN',
        isActive: true,
      });

      const apiKeyHash = crypto
        .createHash('sha256')
        .update(`bio_int_test_key_${fixtures.tokens.terminalId}`)
        .digest('hex');

      const terminal = await fixtures.createBiometricTerminal(testPrisma, {
        companyId: company.id,
        name: 'Integration Gate',
        terminalModel: 'eSSL X2008',
        apiKeyHash,
        apiKeyPrefix: 'bio_int_',
        registeredByUserId: user.id,
        isActive: true,
      });

      const getCurrentUtcDayStart = (now = new Date()): Date =>
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
      const currentUtcDayStart = getCurrentUtcDayStart();

      const batchPayload = {
        punches: [
          {
            devicePunchId: `int-concurrent-p1-${fixtures.tokens.runToken}`,
            userEnrollmentId: '101',
            punchTime: new Date(currentUtcDayStart.getTime() + 60_000).toISOString(),
          },
          {
            devicePunchId: `int-concurrent-p2-${fixtures.tokens.runToken}`,
            userEnrollmentId: '102',
            punchTime: new Date(currentUtcDayStart.getTime() + 120_000).toISOString(),
          },
        ],
      };

      // Instrument the dedicated `testPrisma` instance with pass-through spies (no mocking)
      // to prove BiometricService.ingestPunches() executes real queries directly against testPrisma.
      const findManySpy = vi.spyOn(testPrisma.rawPunchLog, 'findMany');
      const transactionSpy = vi.spyOn(testPrisma, '$transaction');
      const settingFindUniqueSpy = vi.spyOn(testPrisma.companySetting, 'findUnique');
      const settingUpsertSpy = vi.spyOn(testPrisma.companySetting, 'upsert');

      try {
        const [resA, resB] = await Promise.all([
          BiometricService.ingestPunches(terminal, batchPayload),
          BiometricService.ingestPunches(terminal, batchPayload),
        ]);

        expect(resA.inserted + resB.inserted).toBe(2);
        expect(resA.duplicates + resB.duplicates).toBe(2);

        // Verify BiometricService routed its real Prisma operations through `testPrisma`
        expect(findManySpy).toHaveBeenCalledTimes(2);
        expect(transactionSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(settingFindUniqueSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(settingUpsertSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        findManySpy.mockRestore();
        transactionSpy.mockRestore();
        settingFindUniqueSpy.mockRestore();
        settingUpsertSpy.mockRestore();
      }

      const persistedCount = await testPrisma.rawPunchLog.count({
        where: { companyId: company.id, terminalId: terminal.id },
      });
      expect(persistedCount).toBe(2);
    } finally {
      await fixtures.cleanup(testPrisma);
    }
  });
});
