import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import net from 'net';
import crypto from 'crypto';
import {
  configureIntegrationPrismaClient,
  getPrismaClient,
  prisma,
  resetPrismaClientForTesting,
  verifyDatabaseUrlConsistency,
} from '../../src/server/db/client.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';

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
 */
describe('PostgreSQL 16 Concurrency Integration Test: Biometric Raw Punch Ingestion', () => {
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^["']|["']$/g, '');
  const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma: PrismaClient | null = null;

  const testCompanyId = '00000000-0000-4000-a000-000000000095';
  const testUserId = '00000000-0000-4000-a000-000000000096';
  const testTerminalId = '00000000-0000-4000-a000-000000000094';

  const cleanupTestData = async (client: PrismaClient, tolerateCleanupErrors = false) => {
    const deleteOps = [
      () => client.auditLog.deleteMany({ where: { companyId: testCompanyId } }),
      () => client.rawPunchLog.deleteMany({ where: { companyId: testCompanyId } }),
      () => client.companySetting.deleteMany({ where: { companyId: testCompanyId } }),
      () => client.biometricTerminal.deleteMany({ where: { companyId: testCompanyId } }),
      () => client.user.deleteMany({ where: { companyId: testCompanyId } }),
      () => client.company.deleteMany({ where: { id: testCompanyId } }),
    ];

    for (const op of deleteOps) {
      if (tolerateCleanupErrors) {
        try {
          await op();
        } catch (err) {
          console.warn('[INTEGRATION CLEANUP WARNING]', err);
        }
      } else {
        await op();
      }
    }
  };

  const checkPortReachable = (
    host: string,
    port: number,
    timeoutMs = 1000
  ): Promise<{ reachable: boolean; code?: string }> => {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (result: { reachable: boolean; code?: string }) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve(result);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish({ reachable: true }));
      socket.once('timeout', () => finish({ reachable: false, code: 'TIMEOUT' }));
      socket.once('error', (err: NodeJS.ErrnoException) =>
        finish({ reachable: false, code: err.code || 'SOCKET_ERROR' })
      );
      socket.connect(port, host);
    });
  };

  beforeAll(async () => {
    if (!isIntegrationMode || !testDbUrl || testDbUrl === '') {
      blockedReason =
        '[BLOCKED / NOT RUN] Biometric PostgreSQL 16 integration test requires ' +
        'COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL targeting localhost:5434/core_erp_integration_test.';
      console.warn(`\n${blockedReason}\n`);
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(testDbUrl);
    } catch {
      throw new Error('[SECURITY FATAL] Invalid database URL format for TEST_DATABASE_URL.');
    }

    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      throw new Error('[SECURITY FATAL] Forbidden database protocol in TEST_DATABASE_URL.');
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      throw new Error('[SECURITY FATAL] Integration test refused: unapproved host in TEST_DATABASE_URL.');
    }
    if (parsed.port !== '5434') {
      throw new Error('[SECURITY FATAL] Integration test refused: port must be explicitly 5434.');
    }
    const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    if (dbName !== 'core_erp_integration_test') {
      throw new Error(
        '[SECURITY FATAL] Integration test refused: database name must be core_erp_integration_test.'
      );
    }

    const probe = await checkPortReachable(hostname, 5434);
    if (!probe.reachable) {
      blockedReason =
        `[BLOCKED / NOT RUN] PostgreSQL 16 integration endpoint is unreachable at ${hostname}:5434 ` +
        `(${probe.code || 'UNREACHABLE'}). No integration assertions were executed.`;
      console.warn(`\n${blockedReason}\n`);
      return;
    }

    // Endpoint is reachable: do NOT catch or downgrade $connect(), auth, missing DB, schema, or config errors.
    testPrisma = configureIntegrationPrismaClient(testDbUrl);
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
    try {
      if (testPrisma && isDbConnected) {
        await cleanupTestData(testPrisma, true);
      }
    } finally {
      if (testPrisma) {
        try {
          await testPrisma.$disconnect();
        } catch {}
      }
      resetPrismaClientForTesting();
    }
  });

  it('should deduplicate concurrent identical raw punch batches atomically on PostgreSQL 16', async (ctx) => {
    if (blockedReason) {
      console.warn(blockedReason);
      await ctx.annotate(blockedReason, 'blocked');
      ctx.skip(blockedReason);
    }

    if (!isDbConnected || !testPrisma) {
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
    expect(configuredEngineUrl).toBe(testDbUrl);
    expect(proxiedEngineUrl).toBe(testDbUrl);

    const urlConsistency = verifyDatabaseUrlConsistency(testDbUrl!, prisma);
    expect(urlConsistency.consistent).toBe(true);
    expect(urlConsistency.portMatch).toBe(true);
    expect(urlConsistency.databaseMatch).toBe(true);

    const liveDbCheck = await prisma.$queryRaw<Array<{ db_name: string; server_port: number | null }>>`
      SELECT current_database() AS db_name, inet_server_port() AS server_port
    `;
    expect(liveDbCheck[0]?.db_name).toBe('core_erp_integration_test');
    if (liveDbCheck[0]?.server_port !== null && liveDbCheck[0]?.server_port !== undefined) {
      expect(liveDbCheck[0].server_port).toBe(5434);
    }

    await cleanupTestData(testPrisma);

    await testPrisma.company.create({
      data: {
        id: testCompanyId,
        code: 'BIOINT95',
        name: 'Biometric Integration Co',
        currency: 'USD',
        timezone: 'UTC',
      },
    });

    await testPrisma.user.create({
      data: {
        id: testUserId,
        companyId: testCompanyId,
        email: 'bio-int-admin@coreerp.local',
        fullName: 'Integration Admin',
        passwordHash: 'not-used-in-test',
        role: 'ADMIN',
        isActive: true,
      },
    });

    const apiKeyHash = crypto.createHash('sha256').update('bio_int_test_key').digest('hex');
    const terminal = await testPrisma.biometricTerminal.create({
      data: {
        id: testTerminalId,
        companyId: testCompanyId,
        deviceSerialNumber: 'INT-X2008-01',
        name: 'Integration Gate',
        terminalModel: 'eSSL X2008',
        apiKeyHash,
        apiKeyPrefix: 'bio_int_',
        registeredByUserId: testUserId,
        isActive: true,
      },
    });

    const batchPayload = {
      punches: [
        {
          devicePunchId: 'int-concurrent-p1',
          userEnrollmentId: '101',
          punchTime: '2026-10-19T08:00:00.000Z',
        },
        {
          devicePunchId: 'int-concurrent-p2',
          userEnrollmentId: '102',
          punchTime: '2026-10-19T08:05:00.000Z',
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
      where: { companyId: testCompanyId, terminalId: testTerminalId },
    });
    expect(persistedCount).toBe(2);
  });
});
