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
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';

/**
 * Real PostgreSQL 16 Concurrency Integration Test:
 * Concurrent Punch Reconciliation Race-Condition Investigation
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL
 *    pointing to isolated 'core_erp_integration_test' on localhost:5434.
 * 2. Never connects to operational (5432), development (5432), or standard unit-test (5433) databases.
 * 3. If integration mode is not enabled, TEST_DATABASE_URL is missing, or the dedicated PostgreSQL
 *    TCP endpoint on localhost:5434 is unreachable, marks the test genuinely SKIPPED via `ctx.skip(...)`
 *    with an explicit `[BLOCKED / NOT RUN]` diagnostic note — never falsely reporting PASS.
 * 4. Once localhost:5434 is reachable, never masks `$connect()`, authentication, missing database,
 *    missing migration/table, PostgreSQL version, or database identity errors.
 */
describe('PostgreSQL 16 Concurrency Integration Test: Concurrent Punch Reconciliation', () => {
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^["']|["']$/g, '');
  const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma: PrismaClient | null = null;

  const testCompanyId = crypto.randomUUID();
  const testUserId = crypto.randomUUID();
  const testEmployeeId = crypto.randomUUID();
  const testTerminalId = crypto.randomUUID();
  const testPunchId = crypto.randomUUID();

  const cleanupTestData = async (client: PrismaClient, tolerateCleanupErrors = false) => {
    const deleteOps = [
      () => client.auditLog.deleteMany({ where: { companyId: testCompanyId } }),
      () => client.attendance.deleteMany({ where: { companyId: testCompanyId } }),
      () => client.rawPunchLog.deleteMany({ where: { companyId: testCompanyId } }),
      () => client.companySetting.deleteMany({ where: { companyId: testCompanyId } }),
      () => client.employee.deleteMany({ where: { companyId: testCompanyId } }),
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
        '[BLOCKED / NOT RUN] Concurrent punch reconciliation PostgreSQL 16 integration test requires ' +
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

    // Endpoint is reachable: do NOT catch or downgrade $connect(), auth, missing DB, PG version, identity, or Prisma errors.
    testPrisma = configureIntegrationPrismaClient(testDbUrl);
    await testPrisma.$connect();

    const versionRows = await testPrisma.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
    const serverVersion = versionRows[0]?.version || '';
    if (!/PostgreSQL 16\b/.test(serverVersion)) {
      throw new Error(
        `[SECURITY FATAL] Integration test requires PostgreSQL major version 16, got: "${serverVersion || 'unknown'}".`
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

  it('should investigate concurrent reconciliation of the same RawPunchLog punch on PostgreSQL 16', async (ctx) => {
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

    const urlConsistency = verifyDatabaseUrlConsistency(testDbUrl!, prisma);
    expect(urlConsistency.consistent).toBe(true);
    expect(urlConsistency.portMatch).toBe(true);
    expect(urlConsistency.databaseMatch).toBe(true);

    const liveDbCheck = await prisma.$queryRaw<Array<{ db_name: string }>>`
      SELECT current_database() AS db_name
    `;
    expect(liveDbCheck[0]?.db_name).toBe('core_erp_integration_test');

    // 1. Create isolated company, user, employee, terminal, and pending raw punch fixtures
    await testPrisma.company.create({
      data: {
        id: testCompanyId,
        code: `RC-${testCompanyId.slice(0, 8)}`,
        name: 'Concurrent Reconciliation Test Co',
        currency: 'USD',
        timezone: 'UTC',
      },
    });

    await testPrisma.user.create({
      data: {
        id: testUserId,
        companyId: testCompanyId,
        email: 'recon-int-admin@coreerp.local',
        fullName: 'Reconciliation Integration Admin',
        passwordHash: 'not-used-in-test',
        role: 'ADMIN',
        isActive: true,
      },
    });

    await testPrisma.employee.create({
      data: {
        id: testEmployeeId,
        companyId: testCompanyId,
        employeeCode: 'EMP-RECON-101',
        fullName: 'Concurrent Test Employee',
        dateOfJoining: new Date('2026-01-01T00:00:00.000Z'),
        status: 'ACTIVE',
        biometricDeviceId: '101',
      },
    });

    const apiKeyHash = crypto
      .createHash('sha256')
      .update(`bio_recon_int_key_${testTerminalId}`)
      .digest('hex');
    await testPrisma.biometricTerminal.create({
      data: {
        id: testTerminalId,
        companyId: testCompanyId,
        deviceSerialNumber: 'INT-RECON-X2008',
        name: 'Reconciliation Integration Gate',
        terminalModel: 'eSSL X2008',
        apiKeyHash,
        apiKeyPrefix: 'bio_rec_',
        registeredByUserId: testUserId,
        isActive: true,
      },
    });

    const punchTime = new Date('2026-10-19T09:30:00.000Z');
    const workDateObj = new Date('2026-10-19T00:00:00.000Z');

    await testPrisma.rawPunchLog.create({
      data: {
        id: testPunchId,
        companyId: testCompanyId,
        terminalId: testTerminalId,
        devicePunchId: 'int-reconcile-concurrent-p1',
        userEnrollmentId: '101',
        punchTime,
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        idempotencyKey: `${testTerminalId}:int-reconcile-concurrent-p1`,
        matchedEmployeeId: null,
      },
    });

    // 2. Invoke targeted reconciliation concurrently twice for the SAME PENDING RawPunchLog punch.
    // Synchronize at $transaction entry so both calls are guaranteed to observe syncStatus === 'PENDING'
    // in findMany() and race concurrently against PostgreSQL FOR UPDATE row-level locking.
    let arrivedAtTransaction = 0;
    let releaseBarrier!: () => void;
    const bothEnteredTransaction = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const origTransaction = testPrisma.$transaction.bind(testPrisma);
    const txBarrierSpy = vi
      .spyOn(testPrisma, '$transaction')
      .mockImplementation((async (fn: any, opts?: any) => {
        arrivedAtTransaction += 1;
        if (arrivedAtTransaction >= 2) {
          releaseBarrier();
        }
        await bothEnteredTransaction;
        return origTransaction(fn, opts);
      }) as any);

    const runConcurrentReconcile = () =>
      PunchReconciliationService.reconcilePendingPunches(testCompanyId, {
        punchId: testPunchId,
      }).catch((err) => {
        releaseBarrier();
        throw err;
      });

    let resA: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    let resB: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    try {
      [resA, resB] = await Promise.all([runConcurrentReconcile(), runConcurrentReconcile()]);
    } finally {
      txBarrierSpy.mockRestore();
    }

    expect(arrivedAtTransaction).toBe(2);
    expect(resA.totalEvaluated).toBe(1);
    expect(resB.totalEvaluated).toBe(1);
    expect(resA.errors).toBe(0);
    expect(resB.errors).toBe(0);
    expect(resA.ignored).toBe(0);
    expect(resB.ignored).toBe(0);
    expect(resA.results[0]?.status).toBe('PROCESSED');
    expect(resB.results[0]?.status).toBe('PROCESSED');
    expect([resA.results[0]?.message, resB.results[0]?.message].sort()).toEqual([
      'Check-in recorded successfully.',
      'Punch was already successfully processed.',
    ]);

    // 3. Verify RawPunchLog final status is PROCESSED with resolved employee and no error
    const rawPunchAfterConcurrent = await testPrisma.rawPunchLog.findUnique({
      where: { id: testPunchId },
    });
    expect(rawPunchAfterConcurrent).not.toBeNull();
    expect(rawPunchAfterConcurrent!.syncStatus).toBe('PROCESSED');
    expect(rawPunchAfterConcurrent!.errorMessage).toBeNull();
    expect(rawPunchAfterConcurrent!.matchedEmployeeId).toBe(testEmployeeId);

    const totalPunchesForCompany = await testPrisma.rawPunchLog.count({
      where: { companyId: testCompanyId },
    });
    expect(totalPunchesForCompany).toBe(1);

    // 4. Verify exactly one Attendance record exists for (companyId, employeeId, workDate)
    const attendanceRows = await testPrisma.attendance.findMany({
      where: {
        companyId: testCompanyId,
        employeeId: testEmployeeId,
        workDate: workDateObj,
      },
    });
    expect(attendanceRows).toHaveLength(1);

    const totalAttendanceForCompany = await testPrisma.attendance.count({
      where: { companyId: testCompanyId },
    });
    expect(totalAttendanceForCompany).toBe(1);

    const attendance = attendanceRows[0];
    expect(attendance.companyId).toBe(testCompanyId);
    expect(attendance.employeeId).toBe(testEmployeeId);
    expect(attendance.workDate.toISOString()).toBe(workDateObj.toISOString());
    expect(attendance.source).toBe('BIOMETRIC');
    expect(attendance.status).toBe('PRESENT');
    expect(attendance.checkIn?.toISOString()).toBe(punchTime.toISOString());
    expect(attendance.checkOut).toBeNull();
    expect(attendance.lateMinutes).toBe(0);
    expect(attendance.overtimeMinutes).toBe(0);
    expect(attendance.notes).toBe(`Biometric Check-In at ${punchTime.toISOString()}`);

    // Verify no unexpected AuditLog side effects occurred during punch-level reconciliation
    const auditLogCountAfterConcurrent = await testPrisma.auditLog.count({
      where: { companyId: testCompanyId },
    });
    expect(auditLogCountAfterConcurrent).toBe(0);

    // 5. Verify subsequent reconciliation call does not re-process an already-processed punch
    const followUpBatch = await PunchReconciliationService.reconcilePendingPunches(testCompanyId, {
      punchId: testPunchId,
    });
    expect(followUpBatch.totalEvaluated).toBe(0);
    expect(followUpBatch.processed).toBe(0);
    expect(followUpBatch.pending).toBe(0);
    expect(followUpBatch.ignored).toBe(0);
    expect(followUpBatch.errors).toBe(0);

    const followUpSingle = await PunchReconciliationService.reconcilePunch(testPunchId);
    expect(followUpSingle.status).toBe('PROCESSED');
    expect(followUpSingle.message).toBe('Punch was already successfully processed.');

    // Re-query DB directly to confirm Attendance and RawPunchLog were untouched by subsequent calls
    const rawPunchAfterFollowUp = await testPrisma.rawPunchLog.findUnique({
      where: { id: testPunchId },
    });
    expect(rawPunchAfterFollowUp!.syncStatus).toBe('PROCESSED');
    expect(rawPunchAfterFollowUp!.updatedAt.toISOString()).toBe(
      rawPunchAfterConcurrent!.updatedAt.toISOString()
    );

    const attendanceAfterFollowUp = await testPrisma.attendance.findMany({
      where: {
        companyId: testCompanyId,
        employeeId: testEmployeeId,
        workDate: workDateObj,
      },
    });
    expect(attendanceAfterFollowUp).toHaveLength(1);
    expect(attendanceAfterFollowUp[0].updatedAt.toISOString()).toBe(
      attendance.updatedAt.toISOString()
    );
    expect(attendanceAfterFollowUp[0].notes).toBe(attendance.notes);
  });
});
