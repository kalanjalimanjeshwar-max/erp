import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { WorkPolicyService } from '../../src/server/services/work-policy.service.js';

/**
 * Real PostgreSQL 16 Integration Test Suite:
 * EmployeeWorkPolicyRevision Non-Overlap Trigger (SQLSTATE 23P01) & Advisory-Lock Serialization
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL
 *    pointing to isolated 'core_erp_integration_test' on localhost/127.0.0.1:5434.
 * 2. Never connects to operational (5432), development (5432), or standard unit-test (5433) databases.
 * 3. If integration mode is not enabled, TEST_DATABASE_URL is missing, or the dedicated PostgreSQL
 *    TCP endpoint on port 5434 is unreachable, marks tests genuinely SKIPPED via `ctx.skip(...)`
 *    with an explicit `[BLOCKED / NOT RUN]` diagnostic note — never falsely reporting PASS.
 * 4. Once port 5434 is reachable, never masks `$connect()`, authentication, missing database,
 *    missing migration/table, PostgreSQL version, or database identity errors.
 * 5. Uses randomly generated per-test company/employee fixtures and deletes only test-owned records
 *    in strict foreign-key order.
 */
describe('PostgreSQL 16 Integration Test: EmployeeWorkPolicyRevision Overlap Trigger & Advisory Locking', () => {
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^["']|["']$/g, '');
  const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma1: PrismaClient | null = null;
  let testPrisma2: PrismaClient | null = null;

  const createdCompanyIds = new Set<string>();

  const cleanupCompanyFixtures = async (
    client: PrismaClient,
    companyId: string,
    tolerateCleanupErrors = false
  ) => {
    const deleteOps = [
      () => client.auditLog.deleteMany({ where: { companyId } }),
      () => client.employeeWorkPolicyRevision.deleteMany({ where: { companyId } }),
      () => client.employee.deleteMany({ where: { companyId } }),
      () => client.shift.deleteMany({ where: { companyId } }),
      () => client.user.deleteMany({ where: { companyId } }),
      () => client.company.deleteMany({ where: { id: companyId } }),
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

  const seedWorkPolicyFixture = async (client: PrismaClient) => {
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const employeeId = crypto.randomUUID();

    createdCompanyIds.add(companyId);

    await client.company.create({
      data: {
        id: companyId,
        code: `WP-${companyId.slice(0, 8)}`,
        name: `Work Policy Integration Co ${companyId.slice(0, 6)}`,
        currency: 'USD',
        timezone: 'UTC',
      },
    });

    await client.user.create({
      data: {
        id: userId,
        companyId,
        email: `wp-int-${userId.slice(0, 8)}@coreerp.local`,
        fullName: 'Work Policy Integration Admin',
        passwordHash: '$2a$10$abcdefghijklmnopqrstuuNOPASSWORDHASHFORTESTONLY123456',
        role: 'ADMIN',
        isActive: true,
      },
    });

    await client.employee.create({
      data: {
        id: employeeId,
        companyId,
        employeeCode: `WPEMP-${employeeId.slice(0, 8)}`,
        fullName: 'Work Policy Test Employee',
        dateOfJoining: new Date('2026-01-01T00:00:00.000Z'),
        status: 'ACTIVE',
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
      },
    });

    return { companyId, userId, employeeId };
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

  const assertDatabaseSafety = async (ctx: {
    annotate: (message: string, type?: string) => Promise<unknown>;
    skip: (note?: string) => never;
  }): Promise<{ client1: PrismaClient; client2: PrismaClient }> => {
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

    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.COREERP_INTEGRATION_TEST_MODE).toBe('true');
    expect(getPrismaClient()).toBe(testPrisma1);
    expect(global.__prismaClient).toBe(testPrisma1);

    const urlConsistency = verifyDatabaseUrlConsistency(testDbUrl!, prisma);
    expect(urlConsistency.consistent).toBe(true);
    expect(urlConsistency.portMatch).toBe(true);
    expect(urlConsistency.databaseMatch).toBe(true);

    const liveDbCheck = await prisma.$queryRaw<Array<{ db_name: string }>>`
      SELECT current_database() AS db_name
    `;
    expect(liveDbCheck[0]?.db_name).toBe('core_erp_integration_test');

    return { client1: testPrisma1, client2: testPrisma2 };
  };

  const extractPgErrorDetails = (err: unknown): { pgCode: string | null; message: string } => {
    const anyErr = err as {
      code?: string;
      message?: string;
      meta?: {
        code?: string;
        message?: string;
        driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } };
      };
    };
    const metaCode = anyErr?.meta?.code || anyErr?.meta?.driverAdapterError?.cause?.originalCode || null;
    const message = String(
      anyErr?.meta?.message ||
        anyErr?.meta?.driverAdapterError?.cause?.originalMessage ||
        anyErr?.message ||
        err ||
        ''
    );
    const codeMatch = message.match(/\b(23P01)\b/);
    const pgCode =
      metaCode || (anyErr?.code === '23P01' ? '23P01' : null) || (codeMatch ? codeMatch[1] : null);
    return { pgCode, message };
  };

  const expectPg23P01OverlapError = (err: unknown) => {
    const { pgCode, message } = extractPgErrorDetails(err);
    expect(pgCode).toBe('23P01');
    expect(message).toContain('Overlapping EmployeeWorkPolicyRevision period');
  };

  beforeAll(async () => {
    if (!isIntegrationMode || !testDbUrl || testDbUrl === '') {
      blockedReason =
        '[BLOCKED / NOT RUN] Work-policy revision PostgreSQL 16 integration test requires ' +
        'COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL targeting localhost:5434/core_erp_integration_test.';
      console.warn(`\n${blockedReason}\n`);
      return;
    }

    if (process.env.DATABASE_URL && testDbUrl === process.env.DATABASE_URL) {
      throw new Error(
        '[SECURITY FATAL] Integration test refused: TEST_DATABASE_URL matches primary DATABASE_URL.'
      );
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

    testPrisma1 = configureIntegrationPrismaClient(testDbUrl);
    testPrisma2 = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    // Prisma's bundled dotenv loader may repopulate DATABASE_URL during construction; clear it immediately.
    delete process.env.DATABASE_URL;
    await testPrisma1.$connect();
    await testPrisma2.$connect();

    const versionRows = await testPrisma1.$queryRaw<Array<{ version: string }>>`
      SELECT version() AS version
    `;
    const serverVersion = versionRows[0]?.version || '';
    if (!/PostgreSQL 16\b/.test(serverVersion)) {
      throw new Error(
        `[SECURITY FATAL] Integration test requires PostgreSQL major version 16, got: "${serverVersion || 'unknown'}".`
      );
    }

    const [dbRows1, dbRows2] = await Promise.all([
      testPrisma1.$queryRaw<Array<{ db_name: string }>>`SELECT current_database() AS db_name`,
      testPrisma2.$queryRaw<Array<{ db_name: string }>>`SELECT current_database() AS db_name`,
    ]);
    if (dbRows1[0]?.db_name !== 'core_erp_integration_test') {
      throw new Error(
        `[SECURITY FATAL] Primary integration client connected to unexpected database "${dbRows1[0]?.db_name || 'unknown'}".`
      );
    }
    if (dbRows2[0]?.db_name !== 'core_erp_integration_test') {
      throw new Error(
        `[SECURITY FATAL] Secondary integration client connected to unexpected database "${dbRows2[0]?.db_name || 'unknown'}".`
      );
    }

    isDbConnected = true;
  });

  afterAll(async () => {
    try {
      if (testPrisma1 && isDbConnected) {
        for (const companyId of createdCompanyIds) {
          await cleanupCompanyFixtures(testPrisma1, companyId, true);
        }
      }
    } finally {
      if (testPrisma1) {
        try {
          await testPrisma1.$disconnect();
        } catch {}
      }
      if (testPrisma2) {
        try {
          await testPrisma2.$disconnect();
        } catch {}
      }
      resetPrismaClientForTesting();
    }
  });

  it('allows non-overlapping historical, current, and future EmployeeWorkPolicyRevision periods to coexist', async (ctx) => {
    const { client1 } = await assertDatabaseSafety(ctx);
    const { companyId, userId, employeeId } = await seedWorkPolicyFixture(client1);

    await client1.employeeWorkPolicyRevision.create({
      data: {
        companyId,
        employeeId,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-05-31T00:00:00.000Z'),
        revisionReason: 'Historical period',
        createdByUserId: userId,
      },
    });

    await client1.employeeWorkPolicyRevision.create({
      data: {
        companyId,
        employeeId,
        dailyWorkingHours: 8.5,
        monthlyLeaveAllowance: 5,
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-11-30T00:00:00.000Z'),
        revisionReason: 'Current period',
        createdByUserId: userId,
      },
    });

    await client1.employeeWorkPolicyRevision.create({
      data: {
        companyId,
        employeeId,
        dailyWorkingHours: 9,
        monthlyLeaveAllowance: 6,
        effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
        effectiveTo: null,
        revisionReason: 'Future open-ended period',
        createdByUserId: userId,
      },
    });

    const revisions = await WorkPolicyService.listRevisionsForEmployee(companyId, employeeId, client1);
    expect(revisions).toHaveLength(3);
    expect(revisions.map((r) => r.effectiveFrom.toISOString().slice(0, 10))).toEqual([
      '2026-01-01',
      '2026-06-01',
      '2026-12-01',
    ]);
    expect(revisions.map((r) => (r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null))).toEqual([
      '2026-05-31',
      '2026-11-30',
      null,
    ]);

    const historicalPolicy = WorkPolicyService.resolvePolicyForDate({
      date: '2026-03-15',
      employee: { dailyWorkingHours: 8, monthlyLeaveAllowance: 4 },
      revisions,
    });
    const currentPolicy = WorkPolicyService.resolvePolicyForDate({
      date: '2026-08-15',
      employee: { dailyWorkingHours: 8, monthlyLeaveAllowance: 4 },
      revisions,
    });
    const futurePolicy = WorkPolicyService.resolvePolicyForDate({
      date: '2027-01-15',
      employee: { dailyWorkingHours: 8, monthlyLeaveAllowance: 4 },
      revisions,
    });

    expect(historicalPolicy.effectiveDailyWorkingHours).toBe(8);
    expect(historicalPolicy.monthlyLeaveAllowance).toBe(4);
    expect(currentPolicy.effectiveDailyWorkingHours).toBe(8.5);
    expect(currentPolicy.monthlyLeaveAllowance).toBe(5);
    expect(futurePolicy.effectiveDailyWorkingHours).toBe(9);
    expect(futurePolicy.monthlyLeaveAllowance).toBe(6);
  });

  it('rejects overlapping EmployeeWorkPolicyRevision inserts and updates via PostgreSQL exclusion trigger with SQLSTATE 23P01', async (ctx) => {
    const { client1 } = await assertDatabaseSafety(ctx);
    const { companyId, userId, employeeId } = await seedWorkPolicyFixture(client1);

    const firstRevision = await client1.employeeWorkPolicyRevision.create({
      data: {
        companyId,
        employeeId,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-06-30T00:00:00.000Z'),
        revisionReason: 'Baseline H1',
        createdByUserId: userId,
      },
    });

    await client1.employeeWorkPolicyRevision.create({
      data: {
        companyId,
        employeeId,
        dailyWorkingHours: 9,
        monthlyLeaveAllowance: 5,
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        effectiveTo: null,
        revisionReason: 'Open-ended from August',
        createdByUserId: userId,
      },
    });

    // 1. Direct SQL INSERT overlap probe: verifies exact PostgreSQL SQLSTATE 23P01 in Prisma P2010 meta.code
    const rawOverlapId = crypto.randomUUID();
    let rawSqlErr: unknown = null;
    try {
      await client1.$executeRaw`
        INSERT INTO "EmployeeWorkPolicyRevision" (
          "id", "companyId", "employeeId", "dailyWorkingHours", "monthlyLeaveAllowance",
          "effectiveFrom", "effectiveTo", "revisionReason", "createdByUserId", "updatedAt"
        ) VALUES (
          ${rawOverlapId}::uuid, ${companyId}::uuid, ${employeeId}::uuid, 8.00, 4.00,
          DATE '2026-06-15', DATE '2026-07-15', 'Mid-range overlap probe', ${userId}::uuid, NOW()
        )
      `;
    } catch (err) {
      rawSqlErr = err;
    }
    expect(rawSqlErr).not.toBeNull();
    expectPg23P01OverlapError(rawSqlErr);
    expect((rawSqlErr as { meta?: { code?: string } })?.meta?.code).toBe('23P01');

    // 2. Prisma INSERT inclusive boundary collision (2026-06-30 touches 2026-01-01..2026-06-30 under '[]' daterange)
    let boundaryErr: unknown = null;
    try {
      await client1.employeeWorkPolicyRevision.create({
        data: {
          companyId,
          employeeId,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
          effectiveFrom: new Date('2026-06-30T00:00:00.000Z'),
          effectiveTo: new Date('2026-07-15T00:00:00.000Z'),
          revisionReason: 'Inclusive boundary overlap',
          createdByUserId: userId,
        },
      });
    } catch (err) {
      boundaryErr = err;
    }
    expect(boundaryErr).not.toBeNull();
    expectPg23P01OverlapError(boundaryErr);

    // 3. Prisma UPDATE extending effectiveTo into open-ended future revision (2026-08-01..infinity)
    let updateOverlapErr: unknown = null;
    try {
      await client1.employeeWorkPolicyRevision.update({
        where: { id: firstRevision.id },
        data: {
          effectiveTo: new Date('2026-08-01T00:00:00.000Z'),
        },
      });
    } catch (err) {
      updateOverlapErr = err;
    }
    expect(updateOverlapErr).not.toBeNull();
    expectPg23P01OverlapError(updateOverlapErr);

    // Database state must remain completely intact with strictly the 2 original non-overlapping revisions
    const remaining = await client1.employeeWorkPolicyRevision.findMany({
      where: { companyId, employeeId },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(remaining).toHaveLength(2);
    expect(remaining[0].effectiveTo?.toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(remaining[1].effectiveFrom.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(remaining[1].effectiveTo).toBeNull();
  });

  it('serializes concurrent revision writes across independent sessions using the trigger advisory lock', async (ctx) => {
    const { client1, client2 } = await assertDatabaseSafety(ctx);
    const { companyId, userId, employeeId } = await seedWorkPolicyFixture(client1);

    // Part A: Overlapping concurrent writes with DISTINCT effectiveFrom dates
    // (bypasses unique index (companyId, employeeId, effectiveFrom) so ONLY the trigger's
    // pg_advisory_xact_lock + daterange overlap check prevents a race-condition double-insert).
    let signalTx1AcquiredLock!: () => void;
    const tx1AcquiredLock = new Promise<void>((resolve) => {
      signalTx1AcquiredLock = resolve;
    });

    let signalTx2Entered!: () => void;
    const tx2Entered = new Promise<void>((resolve) => {
      signalTx2Entered = resolve;
    });

    let tx1CommitReleaseAt = 0;
    let tx2SettledAt = 0;

    const tx1Promise = client1
      .$transaction(
        async (tx) => {
          await tx.employeeWorkPolicyRevision.create({
            data: {
              companyId,
              employeeId,
              dailyWorkingHours: 8,
              monthlyLeaveAllowance: 4,
              effectiveFrom: new Date('2026-03-01T00:00:00.000Z'),
              effectiveTo: new Date('2026-05-31T00:00:00.000Z'),
              revisionReason: 'Concurrent writer 1',
              createdByUserId: userId,
            },
          });

          // Trigger has executed inside tx1 and acquired pg_advisory_xact_lock for (companyId, employeeId)
          signalTx1AcquiredLock();
          await tx2Entered;

          // Hold transaction briefly so tx2 is actively blocked on pg_advisory_xact_lock
          await new Promise((resolve) => setTimeout(resolve, 200));
          tx1CommitReleaseAt = Date.now();
        },
        { timeout: 10000 }
      )
      .catch((err) => {
        signalTx1AcquiredLock();
        throw err;
      });

    const tx2Promise = (async () => {
      try {
        await tx1AcquiredLock;
        signalTx2Entered();
        await client2.$transaction(
          async (tx) => {
            await tx.employeeWorkPolicyRevision.create({
              data: {
                companyId,
                employeeId,
                dailyWorkingHours: 9,
                monthlyLeaveAllowance: 5,
                effectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
                effectiveTo: new Date('2026-06-30T00:00:00.000Z'),
                revisionReason: 'Concurrent overlapping writer 2',
                createdByUserId: userId,
              },
            });
          },
          { timeout: 10000 }
        );
      } finally {
        signalTx2Entered();
        tx2SettledAt = Date.now();
      }
    })();

    const [res1, res2] = await Promise.allSettled([tx1Promise, tx2Promise]);

    expect(res1.status).toBe('fulfilled');
    expect(res2.status).toBe('rejected');
    expect(tx1CommitReleaseAt).toBeGreaterThan(0);
    // Proves tx2 blocked on PostgreSQL pg_advisory_xact_lock until tx1 committed
    expect(tx2SettledAt).toBeGreaterThanOrEqual(tx1CommitReleaseAt);

    if (res2.status === 'rejected') {
      expectPg23P01OverlapError(res2.reason);
    }

    const afterOverlapRace = await client1.employeeWorkPolicyRevision.findMany({
      where: { companyId, employeeId },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(afterOverlapRace).toHaveLength(1);
    expect(afterOverlapRace[0].effectiveFrom.toISOString().slice(0, 10)).toBe('2026-03-01');
    expect(afterOverlapRace[0].effectiveTo?.toISOString().slice(0, 10)).toBe('2026-05-31');

    // Part B: Non-overlapping concurrent writes serialize cleanly and both commit
    let signalNonOverlapTx1Locked!: () => void;
    const nonOverlapTx1Locked = new Promise<void>((resolve) => {
      signalNonOverlapTx1Locked = resolve;
    });

    let signalNonOverlapTx2Started!: () => void;
    const nonOverlapTx2Started = new Promise<void>((resolve) => {
      signalNonOverlapTx2Started = resolve;
    });

    let nonOverlapTx1ReleaseAt = 0;
    let nonOverlapTx2CommitAt = 0;

    const [nonOverlapRes1, nonOverlapRes2] = await Promise.all([
      client1
        .$transaction(
          async (tx) => {
            const created = await tx.employeeWorkPolicyRevision.create({
              data: {
                companyId,
                employeeId,
                dailyWorkingHours: 8.5,
                monthlyLeaveAllowance: 5,
                effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
                effectiveTo: new Date('2026-08-31T00:00:00.000Z'),
                revisionReason: 'Concurrent non-overlapping writer 1',
                createdByUserId: userId,
              },
            });
            signalNonOverlapTx1Locked();
            await nonOverlapTx2Started;
            await new Promise((resolve) => setTimeout(resolve, 150));
            nonOverlapTx1ReleaseAt = Date.now();
            return created;
          },
          { timeout: 10000 }
        )
        .catch((err) => {
          signalNonOverlapTx1Locked();
          throw err;
        }),
      (async () => {
        try {
          await nonOverlapTx1Locked;
          signalNonOverlapTx2Started();
          const created = await client2.$transaction(
            async (tx) =>
              tx.employeeWorkPolicyRevision.create({
                data: {
                  companyId,
                  employeeId,
                  dailyWorkingHours: 9,
                  monthlyLeaveAllowance: 6,
                  effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
                  effectiveTo: new Date('2026-10-31T00:00:00.000Z'),
                  revisionReason: 'Concurrent non-overlapping writer 2',
                  createdByUserId: userId,
                },
              }),
            { timeout: 10000 }
          );
          nonOverlapTx2CommitAt = Date.now();
          return created;
        } finally {
          signalNonOverlapTx2Started();
        }
      })(),
    ]);

    expect(nonOverlapRes1.effectiveFrom.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(nonOverlapRes2.effectiveFrom.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(nonOverlapTx2CommitAt).toBeGreaterThanOrEqual(nonOverlapTx1ReleaseAt);

    const finalRows = await client1.employeeWorkPolicyRevision.findMany({
      where: { companyId, employeeId },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(finalRows).toHaveLength(3);
    expect(finalRows.map((r) => r.effectiveFrom.toISOString().slice(0, 10))).toEqual([
      '2026-03-01',
      '2026-07-01',
      '2026-09-01',
    ]);
  });
});
