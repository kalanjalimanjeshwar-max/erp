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
import { WorkPolicyService } from '../../src/server/services/work-policy.service.js';

/**
 * Real PostgreSQL 16 Concurrency Integration Test Suite:
 * Biometric Punch Reconciliation Locking, Advisory Serialization & Rollback Safety
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL
 *    pointing to isolated 'core_erp_integration_test' on localhost/127.0.0.1:5434.
 * 2. Never connects to operational (5432), development (5432), or standard unit-test (5433) databases.
 * 3. If integration mode is not enabled, TEST_DATABASE_URL is missing, or the dedicated PostgreSQL
 *    TCP endpoint on port 5434 is unreachable, marks the test genuinely SKIPPED via `ctx.skip(...)`
 *    with an explicit `[BLOCKED / NOT RUN]` diagnostic note — never falsely reporting PASS.
 * 4. Once port 5434 is reachable, never masks `$connect()`, authentication, missing database,
 *    missing migration/table, PostgreSQL version, or database identity errors.
 */
describe('PostgreSQL 16 Concurrency Integration Test: Concurrent Punch Reconciliation', () => {
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^["']|["']$/g, '');
  const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma: PrismaClient | null = null;

  const createdCompanyIds = new Set<string>();

  const getCurrentUtcDayStart = (now = new Date()): Date =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));

  const cleanupCompanyFixtures = async (
    client: PrismaClient,
    companyId: string,
    tolerateCleanupErrors = false
  ) => {
    const deleteOps = [
      () => client.auditLog.deleteMany({ where: { companyId } }),
      () => client.attendance.deleteMany({ where: { companyId } }),
      () => client.rawPunchLog.deleteMany({ where: { companyId } }),
      () => client.companySetting.deleteMany({ where: { companyId } }),
      () => client.employee.deleteMany({ where: { companyId } }),
      () => client.biometricTerminal.deleteMany({ where: { companyId } }),
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

  const seedCompanyFixture = async (client: PrismaClient) => {
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const employeeId = crypto.randomUUID();
    const terminalId = crypto.randomUUID();

    createdCompanyIds.add(companyId);

    await client.company.create({
      data: {
        id: companyId,
        code: `RC-${companyId.slice(0, 8)}`,
        name: `Concurrent Reconciliation Test Co ${companyId.slice(0, 6)}`,
        currency: 'USD',
        timezone: 'UTC',
      },
    });

    await client.user.create({
      data: {
        id: userId,
        companyId,
        email: `recon-int-${userId.slice(0, 8)}@coreerp.local`,
        fullName: 'Reconciliation Integration Admin',
        passwordHash: 'not-used-in-test',
        role: 'ADMIN',
        isActive: true,
      },
    });

    await client.employee.create({
      data: {
        id: employeeId,
        companyId,
        employeeCode: `EMP-${employeeId.slice(0, 8)}`,
        fullName: 'Concurrent Test Employee',
        dateOfJoining: new Date('2026-01-01T00:00:00.000Z'),
        status: 'ACTIVE',
        biometricDeviceId: '101',
      },
    });

    const apiKeyHash = crypto
      .createHash('sha256')
      .update(`bio_recon_int_key_${terminalId}`)
      .digest('hex');

    await client.biometricTerminal.create({
      data: {
        id: terminalId,
        companyId,
        deviceSerialNumber: `INT-X2008-${terminalId.slice(0, 8)}`,
        name: 'Reconciliation Integration Gate',
        terminalModel: 'eSSL X2008',
        apiKeyHash,
        apiKeyPrefix: 'bio_rec_',
        registeredByUserId: userId,
        isActive: true,
      },
    });

    return { companyId, userId, employeeId, terminalId };
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
  }): Promise<PrismaClient> => {
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

    return testPrisma;
  };

  beforeAll(async () => {
    if (!isIntegrationMode || !testDbUrl || testDbUrl === '') {
      blockedReason =
        '[BLOCKED / NOT RUN] Concurrent punch reconciliation PostgreSQL 16 integration test requires ' +
        'COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL targeting 127.0.0.1:5434/core_erp_integration_test.';
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
        for (const companyId of createdCompanyIds) {
          await cleanupCompanyFixtures(testPrisma, companyId, true);
        }
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

  it('serializes two concurrent requests that both select the SAME PENDING RawPunchLog at the read boundary', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const { companyId, employeeId, terminalId } = await seedCompanyFixture(client);
    const punchId = crypto.randomUUID();
    const workDateObj = getCurrentUtcDayStart();
    const punchTime = new Date(workDateObj.getTime() + 60_000);

    await client.rawPunchLog.create({
      data: {
        id: punchId,
        companyId,
        terminalId,
        devicePunchId: `dp-${punchId.slice(0, 8)}`,
        userEnrollmentId: '101',
        punchTime,
        verifyType: 'FINGERPRINT',
        inOutMode: 'CHECK_IN',
        syncStatus: 'PENDING',
        idempotencyKey: `${terminalId}:${punchId}`,
        matchedEmployeeId: null,
      },
    });

    // Synchronize at the actual candidate-selection read boundary (`rawPunchLog.findMany`)
    // so both concurrent requests actually observe and return the SAME PENDING record from
    // PostgreSQL before either enters reconcilePunch() / FOR UPDATE locking.
    const observedSelections: Array<Array<{ id: string }>> = [];
    let arrivedAtReadBoundary = 0;
    let releaseReadBarrier!: () => void;
    const bothObservedPending = new Promise<void>((resolve) => {
      releaseReadBarrier = resolve;
    });
    const origFindMany = client.rawPunchLog.findMany.bind(client.rawPunchLog);
    const findManyBarrierSpy = vi
      .spyOn(client.rawPunchLog, 'findMany')
      .mockImplementation((async (args: any) => {
        const rows = (await origFindMany(args)) as Array<{ id: string }>;
        observedSelections.push(rows);
        arrivedAtReadBoundary += 1;
        if (arrivedAtReadBoundary >= 2) {
          releaseReadBarrier();
        }
        await bothObservedPending;
        return rows;
      }) as any);

    const runConcurrentReconcile = () =>
      PunchReconciliationService.reconcilePendingPunches(companyId, {
        punchId,
      }).catch((err) => {
        releaseReadBarrier();
        throw err;
      });

    let resA: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    let resB: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    try {
      [resA, resB] = await Promise.all([runConcurrentReconcile(), runConcurrentReconcile()]);
    } finally {
      findManyBarrierSpy.mockRestore();
    }

    // Prove both callers selected the exact same PENDING row from PostgreSQL before racing
    expect(arrivedAtReadBoundary).toBe(2);
    expect(observedSelections).toEqual([[{ id: punchId }], [{ id: punchId }]]);

    expect(resA.totalEvaluated).toBe(1);
    expect(resB.totalEvaluated).toBe(1);
    expect(resA.errors).toBe(0);
    expect(resB.errors).toBe(0);
    expect(resA.ignored).toBe(0);
    expect(resB.ignored).toBe(0);
    expect(resA.results[0]?.status).toBe('PROCESSED');
    expect(resB.results[0]?.status).toBe('PROCESSED');
    expect([resA.results[0]?.message, resB.results[0]?.message].sort()).toEqual([
      'Check-in recorded as open punch pending check-out.',
      'Punch was already successfully processed.',
    ]);

    const rawPunchAfterConcurrent = await client.rawPunchLog.findUnique({
      where: { id: punchId },
    });
    expect(rawPunchAfterConcurrent).not.toBeNull();
    expect(rawPunchAfterConcurrent!.syncStatus).toBe('PROCESSED');
    expect(rawPunchAfterConcurrent!.errorMessage).toBeNull();
    expect(rawPunchAfterConcurrent!.matchedEmployeeId).toBe(employeeId);

    const attendanceRows = await client.attendance.findMany({
      where: { companyId, employeeId, workDate: workDateObj },
    });
    expect(attendanceRows).toHaveLength(1);
    expect(await client.attendance.count({ where: { companyId } })).toBe(1);

    const attendance = attendanceRows[0];
    expect(attendance.companyId).toBe(companyId);
    expect(attendance.employeeId).toBe(employeeId);
    expect(attendance.workDate.toISOString()).toBe(workDateObj.toISOString());
    expect(attendance.source).toBe('BIOMETRIC');
    expect(attendance.status).toBe('PRESENT');
    expect(attendance.checkIn?.toISOString()).toBe(punchTime.toISOString());
    expect(attendance.checkOut).toBeNull();
    expect(attendance.lateMinutes).toBe(0);
    expect(attendance.overtimeMinutes).toBe(0);
    expect(attendance.notes).toBe(`Biometric Check-In at ${punchTime.toISOString()}`);
    expect(attendance.hasIncompletePunch).toBe(true);
    expect(attendance.punchPairsCount).toBe(0);
    expect(attendance.actualWorkedMinutes).toBe(0);

    const punchEvents = await client.attendancePunchEvent.findMany({
      where: { companyId, attendanceId: attendance.id },
      orderBy: [{ punchTime: 'asc' }, { createdAt: 'asc' }],
    });
    expect(punchEvents).toHaveLength(1);
    expect(punchEvents[0].rawPunchLogId).toBe(punchId);
    expect(punchEvents[0].inOutMode).toBe('CHECK_IN');
    expect(punchEvents[0].punchTime.toISOString()).toBe(punchTime.toISOString());
    expect(punchEvents[0].source).toBe('BIOMETRIC');

    const intervals = await client.attendanceInterval.findMany({
      where: { companyId, attendanceId: attendance.id },
      orderBy: { sequence: 'asc' },
    });
    expect(intervals).toHaveLength(1);
    expect(intervals[0].sequence).toBe(1);
    expect(intervals[0].isComplete).toBe(false);
    expect(intervals[0].durationMinutes).toBe(0);
    expect(intervals[0].inEventId).toBe(punchEvents[0].id);
    expect(intervals[0].outEventId).toBeNull();
    expect(intervals[0].checkIn?.toISOString()).toBe(punchTime.toISOString());
    expect(intervals[0].checkOut).toBeNull();

    expect(await client.auditLog.count({ where: { companyId } })).toBe(0);

    // Subsequent reconciliation is idempotent and leaves DB timestamps/notes untouched
    const followUpBatch = await PunchReconciliationService.reconcilePendingPunches(companyId, {
      punchId,
    });
    expect(followUpBatch.totalEvaluated).toBe(0);
    expect(followUpBatch.processed).toBe(0);
    expect(followUpBatch.errors).toBe(0);

    const followUpSingle = await PunchReconciliationService.reconcilePunch(punchId, undefined, {
      expectedCompanyId: companyId,
    });
    expect(followUpSingle.status).toBe('PROCESSED');
    expect(followUpSingle.message).toBe('Punch was already successfully processed.');

    const rawPunchAfterFollowUp = await client.rawPunchLog.findUnique({ where: { id: punchId } });
    expect(rawPunchAfterFollowUp!.syncStatus).toBe('PROCESSED');
    expect(rawPunchAfterFollowUp!.updatedAt.toISOString()).toBe(
      rawPunchAfterConcurrent!.updatedAt.toISOString()
    );

    const attendanceAfterFollowUp = await client.attendance.findMany({
      where: { companyId, employeeId, workDate: workDateObj },
    });
    expect(attendanceAfterFollowUp).toHaveLength(1);
    expect(attendanceAfterFollowUp[0].updatedAt.toISOString()).toBe(
      attendance.updatedAt.toISOString()
    );
    expect(attendanceAfterFollowUp[0].notes).toBe(attendance.notes);
  });

  it('serializes two DISTINCT PENDING RawPunchLog IDs (CHECK_IN + CHECK_OUT) for the same employee and workDate when no Attendance row exists yet', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const { companyId, employeeId, terminalId } = await seedCompanyFixture(client);
    const punchInId = crypto.randomUUID();
    const punchOutId = crypto.randomUUID();
    const workDateObj = getCurrentUtcDayStart();
    const checkInTime = new Date(workDateObj.getTime() + 30_000);
    const checkOutTime = new Date(workDateObj.getTime() + 210_000); // 3 minutes after check-in (> 2-min debounce, <= 4 min after UTC midnight)

    await client.rawPunchLog.createMany({
      data: [
        {
          id: punchInId,
          companyId,
          terminalId,
          devicePunchId: `dp-in-${punchInId.slice(0, 8)}`,
          userEnrollmentId: '101',
          punchTime: checkInTime,
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          idempotencyKey: `${terminalId}:${punchInId}`,
          matchedEmployeeId: null,
        },
        {
          id: punchOutId,
          companyId,
          terminalId,
          devicePunchId: `dp-out-${punchOutId.slice(0, 8)}`,
          userEnrollmentId: '101',
          punchTime: checkOutTime,
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_OUT',
          syncStatus: 'PENDING',
          idempotencyKey: `${terminalId}:${punchOutId}`,
          matchedEmployeeId: null,
        },
      ],
    });

    // Synchronize inside the transaction right BEFORE the advisory lock acquisition
    // (after each transaction has already locked its own distinct RawPunchLog row FOR UPDATE)
    // so both concurrent transactions observe no pre-existing Attendance row and race into
    // PostgreSQL pg_advisory_xact_lock(companyId, employeeId, workDate).
    const origListRevisions = WorkPolicyService.listRevisionsForEmployee.bind(WorkPolicyService);
    let arrivedBeforeAdvisoryLock = 0;
    let releaseBeforeAdvisoryLock!: () => void;
    const bothReadyForAdvisoryLock = new Promise<void>((resolve) => {
      releaseBeforeAdvisoryLock = resolve;
    });
    const policyBarrierSpy = vi
      .spyOn(WorkPolicyService, 'listRevisionsForEmployee')
      .mockImplementation((async (cid: string, empId: string, db?: any, opts?: any) => {
        const revisions = await origListRevisions(cid, empId, db, opts);
        if (cid === companyId && empId === employeeId) {
          arrivedBeforeAdvisoryLock += 1;
          if (arrivedBeforeAdvisoryLock >= 2) {
            releaseBeforeAdvisoryLock();
          }
          await bothReadyForAdvisoryLock;
        }
        return revisions;
      }) as any);

    const runTargeted = (targetPunchId: string) =>
      PunchReconciliationService.reconcilePendingPunches(companyId, {
        punchId: targetPunchId,
      }).catch((err) => {
        releaseBeforeAdvisoryLock();
        throw err;
      });

    let resIn: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    let resOut: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    try {
      [resIn, resOut] = await Promise.all([runTargeted(punchInId), runTargeted(punchOutId)]);
    } finally {
      policyBarrierSpy.mockRestore();
    }

    expect(arrivedBeforeAdvisoryLock).toBe(2);
    expect(resIn.totalEvaluated).toBe(1);
    expect(resOut.totalEvaluated).toBe(1);
    expect(resIn.errors).toBe(0);
    expect(resOut.errors).toBe(0);
    expect(resIn.ignored).toBe(0);
    expect(resOut.ignored).toBe(0);
    expect(resIn.results[0]?.status).toBe('PROCESSED');
    expect(resOut.results[0]?.status).toBe('PROCESSED');

    // Depending on which transaction acquires pg_advisory_xact_lock first,
    // either (09:00 opens -> 18:00 pairs as OUT) or
    // (18:00 opens as 1st punch -> 09:00 re-sequences chronologically so 09:00=IN and 18:00=OUT).
    const messagePair = [resIn.results[0]?.message, resOut.results[0]?.message];
    const validOrders = [
      [
        'Check-in recorded as open punch pending check-out.',
        'Check-out paired chronologically (1 pair).',
      ],
      [
        'Check-in paired chronologically (1 pair).',
        'Check-in recorded as open punch pending check-out.',
      ],
    ];
    expect(
      validOrders.some(
        (expected) => expected[0] === messagePair[0] && expected[1] === messagePair[1]
      )
    ).toBe(true);

    // Neither punch is overwritten as ERROR
    const [punchInRow, punchOutRow] = await Promise.all([
      client.rawPunchLog.findUnique({ where: { id: punchInId } }),
      client.rawPunchLog.findUnique({ where: { id: punchOutId } }),
    ]);
    expect(punchInRow?.syncStatus).toBe('PROCESSED');
    expect(punchInRow?.errorMessage).toBeNull();
    expect(punchInRow?.matchedEmployeeId).toBe(employeeId);
    expect(punchOutRow?.syncStatus).toBe('PROCESSED');
    expect(punchOutRow?.errorMessage).toBeNull();
    expect(punchOutRow?.matchedEmployeeId).toBe(employeeId);

    // Strictly ONE Attendance record exists with BOTH checkIn and checkOut recorded
    const attendanceRows = await client.attendance.findMany({
      where: { companyId, employeeId, workDate: workDateObj },
    });
    expect(attendanceRows).toHaveLength(1);
    expect(await client.attendance.count({ where: { companyId } })).toBe(1);
    expect(attendanceRows[0].checkIn?.toISOString()).toBe(checkInTime.toISOString());
    expect(attendanceRows[0].checkOut?.toISOString()).toBe(checkOutTime.toISOString());
    expect(attendanceRows[0].status).toBe('PRESENT');
    expect(attendanceRows[0].source).toBe('BIOMETRIC');
    expect(attendanceRows[0].hasIncompletePunch).toBe(false);
    expect(attendanceRows[0].punchPairsCount).toBe(1);
    expect(attendanceRows[0].actualWorkedMinutes).toBe(3);

    const punchEvents = await client.attendancePunchEvent.findMany({
      where: { companyId, attendanceId: attendanceRows[0].id },
      orderBy: [{ punchTime: 'asc' }, { createdAt: 'asc' }],
    });
    expect(punchEvents).toHaveLength(2);
    expect(punchEvents[0].rawPunchLogId).toBe(punchInId);
    expect(punchEvents[0].inOutMode).toBe('CHECK_IN');
    expect(punchEvents[0].punchTime.toISOString()).toBe(checkInTime.toISOString());
    expect(punchEvents[1].rawPunchLogId).toBe(punchOutId);
    expect(punchEvents[1].inOutMode).toBe('CHECK_OUT');
    expect(punchEvents[1].punchTime.toISOString()).toBe(checkOutTime.toISOString());

    const intervals = await client.attendanceInterval.findMany({
      where: { companyId, attendanceId: attendanceRows[0].id },
      orderBy: { sequence: 'asc' },
    });
    expect(intervals).toHaveLength(1);
    expect(intervals[0].sequence).toBe(1);
    expect(intervals[0].isComplete).toBe(true);
    expect(intervals[0].durationMinutes).toBe(3);
    expect(intervals[0].inEventId).toBe(punchEvents[0].id);
    expect(intervals[0].outEventId).toBe(punchEvents[1].id);
    expect(intervals[0].checkIn?.toISOString()).toBe(checkInTime.toISOString());
    expect(intervals[0].checkOut?.toISOString()).toBe(checkOutTime.toISOString());
  });

  it('serializes two DISTINCT rapid duplicate CHECK_IN punches within 2 minutes without P2002 ERROR and debounces the second cleanly', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const { companyId, employeeId, terminalId } = await seedCompanyFixture(client);
    const punch1Id = crypto.randomUUID();
    const punch2Id = crypto.randomUUID();
    const workDateObj = getCurrentUtcDayStart();
    const t1 = new Date(workDateObj.getTime() + 60_000);
    const t2 = new Date(workDateObj.getTime() + 105_000); // 45s apart -> debounced by business rules

    await client.rawPunchLog.createMany({
      data: [
        {
          id: punch1Id,
          companyId,
          terminalId,
          devicePunchId: `dp-dup1-${punch1Id.slice(0, 8)}`,
          userEnrollmentId: '101',
          punchTime: t1,
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          idempotencyKey: `${terminalId}:${punch1Id}`,
          matchedEmployeeId: null,
        },
        {
          id: punch2Id,
          companyId,
          terminalId,
          devicePunchId: `dp-dup2-${punch2Id.slice(0, 8)}`,
          userEnrollmentId: '101',
          punchTime: t2,
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          idempotencyKey: `${terminalId}:${punch2Id}`,
          matchedEmployeeId: null,
        },
      ],
    });

    const origListRevisions = WorkPolicyService.listRevisionsForEmployee.bind(WorkPolicyService);
    let arrivedBeforeAdvisoryLock = 0;
    let releaseBeforeAdvisoryLock!: () => void;
    const bothReadyForAdvisoryLock = new Promise<void>((resolve) => {
      releaseBeforeAdvisoryLock = resolve;
    });
    const policyBarrierSpy = vi
      .spyOn(WorkPolicyService, 'listRevisionsForEmployee')
      .mockImplementation((async (cid: string, empId: string, db?: any, opts?: any) => {
        const revisions = await origListRevisions(cid, empId, db, opts);
        if (cid === companyId && empId === employeeId) {
          arrivedBeforeAdvisoryLock += 1;
          if (arrivedBeforeAdvisoryLock >= 2) {
            releaseBeforeAdvisoryLock();
          }
          await bothReadyForAdvisoryLock;
        }
        return revisions;
      }) as any);

    const runTargeted = (targetPunchId: string) =>
      PunchReconciliationService.reconcilePendingPunches(companyId, {
        punchId: targetPunchId,
      }).catch((err) => {
        releaseBeforeAdvisoryLock();
        throw err;
      });

    let res1: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    let res2: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    try {
      [res1, res2] = await Promise.all([runTargeted(punch1Id), runTargeted(punch2Id)]);
    } finally {
      policyBarrierSpy.mockRestore();
    }

    expect(arrivedBeforeAdvisoryLock).toBe(2);
    expect(res1.errors).toBe(0);
    expect(res2.errors).toBe(0);

    const statuses = [res1.results[0]?.status, res2.results[0]?.status].sort();
    expect(statuses).toEqual(['IGNORED', 'PROCESSED']);

    const messages = [res1.results[0]?.message, res2.results[0]?.message].sort();
    expect(messages).toEqual([
      'Check-in recorded as open punch pending check-out.',
      'Duplicate check-in punch debounced within 2 minutes.',
    ]);

    const [p1Row, p2Row] = await Promise.all([
      client.rawPunchLog.findUnique({ where: { id: punch1Id } }),
      client.rawPunchLog.findUnique({ where: { id: punch2Id } }),
    ]);
    expect([p1Row?.syncStatus, p2Row?.syncStatus].sort()).toEqual(['IGNORED', 'PROCESSED']);
    expect(p1Row?.syncStatus).not.toBe('ERROR');
    expect(p2Row?.syncStatus).not.toBe('ERROR');

    const attendanceRows = await client.attendance.findMany({
      where: { companyId, employeeId, workDate: workDateObj },
    });
    expect(attendanceRows).toHaveLength(1);
    expect(await client.attendance.count({ where: { companyId } })).toBe(1);

    const winningPunch = p1Row?.syncStatus === 'PROCESSED' ? p1Row : p2Row;
    expect(winningPunch).not.toBeNull();

    const attendance = attendanceRows[0];
    expect(attendance.hasIncompletePunch).toBe(true);
    expect(attendance.punchPairsCount).toBe(0);
    expect(attendance.actualWorkedMinutes).toBe(0);

    const punchEvents = await client.attendancePunchEvent.findMany({
      where: { companyId, attendanceId: attendance.id },
      orderBy: [{ punchTime: 'asc' }, { createdAt: 'asc' }],
    });
    expect(punchEvents).toHaveLength(1);
    expect(punchEvents[0].rawPunchLogId).toBe(winningPunch!.id);
    expect(punchEvents[0].inOutMode).toBe('CHECK_IN');
    expect(punchEvents[0].punchTime.toISOString()).toBe(winningPunch!.punchTime.toISOString());
    expect(punchEvents[0].source).toBe('BIOMETRIC');

    const intervals = await client.attendanceInterval.findMany({
      where: { companyId, attendanceId: attendance.id },
      orderBy: { sequence: 'asc' },
    });
    expect(intervals).toHaveLength(1);
    expect(intervals[0].sequence).toBe(1);
    expect(intervals[0].isComplete).toBe(false);
    expect(intervals[0].durationMinutes).toBe(0);
    expect(intervals[0].inEventId).toBe(punchEvents[0].id);
    expect(intervals[0].outEventId).toBeNull();
    expect(intervals[0].checkIn?.toISOString()).toBe(winningPunch!.punchTime.toISOString());
    expect(intervals[0].checkOut).toBeNull();
  });

  it('rolls back PostgreSQL writes on mid-transaction abort and never overwrites committed PROCESSED rows in error handler', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const { companyId, employeeId, terminalId } = await seedCompanyFixture(client);
    const rollbackPunchId = crypto.randomUUID();
    const guardedPunchId = crypto.randomUUID();
    const workDateObj = getCurrentUtcDayStart();
    const rollbackPunchTime = new Date(workDateObj.getTime() + 60_000);
    const guardedPunchTime = new Date(workDateObj.getTime() + 120_000);

    await client.rawPunchLog.createMany({
      data: [
        {
          id: rollbackPunchId,
          companyId,
          terminalId,
          devicePunchId: `dp-rb-${rollbackPunchId.slice(0, 8)}`,
          userEnrollmentId: '101',
          punchTime: rollbackPunchTime,
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          idempotencyKey: `${terminalId}:${rollbackPunchId}`,
          matchedEmployeeId: null,
        },
        {
          id: guardedPunchId,
          companyId,
          terminalId,
          devicePunchId: `dp-guard-${guardedPunchId.slice(0, 8)}`,
          userEnrollmentId: '101',
          punchTime: guardedPunchTime,
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          idempotencyKey: `${terminalId}:${guardedPunchId}`,
          matchedEmployeeId: null,
        },
      ],
    });

    // Part A: Force a real PostgreSQL rollback AFTER Attendance & RawPunchLog writes succeed inside the tx
    const origTx = client.$transaction.bind(client);
    let sawUncommittedAttendance = false;
    const rollbackTxSpy = vi
      .spyOn(client, '$transaction')
      .mockImplementationOnce((async (cb: any, opts?: any) =>
        origTx(async (tx: any) => {
          await cb(tx);
          const inTxCount = await tx.attendance.count({
            where: { companyId, employeeId, workDate: workDateObj },
          });
          sawUncommittedAttendance = inTxCount === 1;
          throw new Error('Simulated post-write PostgreSQL transaction abort');
        }, opts)) as any);

    try {
      await expect(
        PunchReconciliationService.reconcilePunch(rollbackPunchId, undefined, {
          expectedCompanyId: companyId,
        })
      ).rejects.toThrow('Simulated post-write PostgreSQL transaction abort');
    } finally {
      rollbackTxSpy.mockRestore();
    }

    expect(sawUncommittedAttendance).toBe(true);
    // Verify PostgreSQL rolled back both Attendance creation and RawPunchLog updates
    expect(
      await client.attendance.count({
        where: { companyId, employeeId, workDate: workDateObj },
      })
    ).toBe(0);
    const afterDirectRollback = await client.rawPunchLog.findUnique({
      where: { id: rollbackPunchId },
    });
    expect(afterDirectRollback?.syncStatus).toBe('PENDING');
    expect(afterDirectRollback?.matchedEmployeeId).toBeNull();

    // Part B: Verify reconcilePendingPunches catch handler marks unfinalized punch ERROR on failure
    const origTx2 = client.$transaction.bind(client);
    const errorTxSpy = vi
      .spyOn(client, '$transaction')
      .mockImplementationOnce((async (cb: any, opts?: any) =>
        origTx2(async (tx: any) => {
          await cb(tx);
          throw new Error('Simulated batch reconciliation abort');
        }, opts)) as any);

    let errBatchRes: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    try {
      errBatchRes = await PunchReconciliationService.reconcilePendingPunches(companyId, {
        punchId: rollbackPunchId,
      });
    } finally {
      errorTxSpy.mockRestore();
    }

    expect(errBatchRes.errors).toBe(1);
    const afterBatchError = await client.rawPunchLog.findUnique({
      where: { id: rollbackPunchId },
    });
    expect(afterBatchError?.syncStatus).toBe('ERROR');
    expect(afterBatchError?.errorMessage).toContain('Simulated batch reconciliation abort');
    expect(
      await client.attendance.count({
        where: { companyId, employeeId, workDate: workDateObj },
      })
    ).toBe(0);

    // Part C: Verify guarded error handler NEVER overwrites an already-committed PROCESSED punch
    const origReconcilePunch = PunchReconciliationService.reconcilePunch.bind(
      PunchReconciliationService
    );
    const postCommitThrowSpy = vi
      .spyOn(PunchReconciliationService, 'reconcilePunch')
      .mockImplementationOnce(async (id, corrId, opts) => {
        await origReconcilePunch(id, corrId, opts);
        throw new Error('Simulated post-commit caller exception');
      });

    let guardedRes: Awaited<ReturnType<typeof PunchReconciliationService.reconcilePendingPunches>>;
    try {
      guardedRes = await PunchReconciliationService.reconcilePendingPunches(companyId, {
        punchId: guardedPunchId,
      });
    } finally {
      postCommitThrowSpy.mockRestore();
    }

    expect(guardedRes.errors).toBe(1);
    const guardedPunchAfter = await client.rawPunchLog.findUnique({
      where: { id: guardedPunchId },
    });
    // Must stay PROCESSED with null errorMessage because updateMany guards notIn ['PROCESSED', 'IGNORED']
    expect(guardedPunchAfter?.syncStatus).toBe('PROCESSED');
    expect(guardedPunchAfter?.errorMessage).toBeNull();
    expect(
      await client.attendance.count({
        where: { companyId, employeeId, workDate: workDateObj },
      })
    ).toBe(1);
  });
});
