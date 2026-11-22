import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import net from 'net';
import crypto from 'crypto';
import { createApp } from '../../src/server/app.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { resetConfigForTesting } from '../../src/server/config/env.js';
import {
  configureIntegrationPrismaClient,
  getPrismaClient,
  prisma,
  resetPrismaClientForTesting,
  verifyDatabaseUrlConsistency,
} from '../../src/server/db/client.js';

/**
 * Real PostgreSQL 16 HTTP Integration Test Suite:
 * Attendance Authorization (EMPLOYEE Self-Scope + Cross-Tenant Denial) & Payroll Lock (HTTP 409)
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL
 *    pointing to isolated 'core_erp_integration_test' on localhost/127.0.0.1:5434.
 * 2. Never connects to operational (5432), development (5432), or standard unit-test (5433) databases.
 * 3. DATABASE_URL remains strictly unset throughout integration mode.
 * 4. If integration mode is not enabled, TEST_DATABASE_URL is missing, or port 5434 is unreachable,
 *    marks tests genuinely SKIPPED via `ctx.skip(...)` with an explicit `[BLOCKED / NOT RUN]` note.
 * 5. Exercises the real Express app, AuthService, getConfig(), requireAuth, requirePermission,
 *    PermissionService, AttendanceController, AttendanceService, and Prisma against PostgreSQL 16
 *    with zero mocks.
 * 6. Uses randomly generated per-test company fixtures and deletes only test-owned records in strict
 *    foreign-key order.
 */
describe('PostgreSQL 16 HTTP Integration Test: Attendance Authorization & Payroll Lock', () => {
  const app = createApp();
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^["']|["']$/g, '');
  const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma: PrismaClient | null = null;

  const createdCompanyIds = new Set<string>();

  const cleanupCompanyFixtures = async (
    client: PrismaClient,
    companyId: string,
    tolerateCleanupErrors = false
  ) => {
    const deleteOps = [
      () => client.auditLog.deleteMany({ where: { companyId } }),
      () => client.attendanceInterval.deleteMany({ where: { companyId } }),
      () => client.attendancePunchEvent.deleteMany({ where: { companyId } }),
      () => client.attendance.deleteMany({ where: { companyId } }),
      () => client.payslip.deleteMany({ where: { companyId } }),
      () => client.payrollPeriod.deleteMany({ where: { companyId } }),
      () => client.rolePermission.deleteMany({ where: { companyId } }),
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

  const seedCompanyWithShift = async (client: PrismaClient, label: string) => {
    const companyId = crypto.randomUUID();
    const shiftId = crypto.randomUUID();
    createdCompanyIds.add(companyId);

    await client.company.create({
      data: {
        id: companyId,
        code: `AT-${companyId.slice(0, 8)}`,
        name: `${label} Co`,
        legalName: `${label} LLC`,
        currency: 'USD',
        timezone: 'UTC',
      },
    });

    await client.shift.create({
      data: {
        id: shiftId,
        companyId,
        code: `SH-${shiftId.slice(0, 8)}`,
        name: 'Standard Day Shift',
        startTime: '09:00',
        endTime: '18:00',
        isOvernight: false,
        graceMinutes: 15,
        halfDayMinutes: 240,
        isActive: true,
      },
    });

    return { companyId, shiftId };
  };

  const seedUser = async (
    client: PrismaClient,
    params: {
      companyId: string;
      role: 'SUPER_ADMIN' | 'ADMIN' | 'VICE_ADMIN' | 'EMPLOYEE';
      fullName: string;
    }
  ) => {
    const userId = crypto.randomUUID();
    const email = `att-${params.role.toLowerCase()}-${userId.slice(0, 8)}@coreerp.local`;

    await client.user.create({
      data: {
        id: userId,
        companyId: params.companyId,
        email,
        fullName: params.fullName,
        passwordHash: '$2a$10$abcdefghijklmnopqrstuuNOPASSWORDHASHFORTESTONLY123456',
        role: params.role,
        isActive: true,
        tokenVersion: 1,
      },
    });

    return { userId, email, role: params.role, tokenVersion: 1 };
  };

  const seedEmployee = async (
    client: PrismaClient,
    params: {
      companyId: string;
      shiftId: string;
      fullName: string;
      userId?: string;
    }
  ) => {
    const employeeId = crypto.randomUUID();
    await client.employee.create({
      data: {
        id: employeeId,
        companyId: params.companyId,
        employeeCode: `EMP-${employeeId.slice(0, 8)}`,
        fullName: params.fullName,
        dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
        shiftId: params.shiftId,
        userId: params.userId ?? null,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
      },
    });
    return { employeeId };
  };

  const seedAttendance = async (
    client: PrismaClient,
    params: {
      companyId: string;
      employeeId: string;
      shiftId: string;
      workDate: string;
      notes: string;
    }
  ) => {
    const attendanceId = crypto.randomUUID();
    await client.attendance.create({
      data: {
        id: attendanceId,
        companyId: params.companyId,
        employeeId: params.employeeId,
        shiftId: params.shiftId,
        workDate: new Date(`${params.workDate}T00:00:00.000Z`),
        checkIn: new Date(`${params.workDate}T09:00:00.000Z`),
        checkOut: new Date(`${params.workDate}T18:00:00.000Z`),
        status: 'PRESENT',
        lateMinutes: 0,
        overtimeMinutes: 0,
        actualWorkedMinutes: 540,
        hasIncompletePunch: false,
        punchPairsCount: 1,
        source: 'MANUAL',
        notes: params.notes,
      },
    });
    return { attendanceId };
  };

  beforeAll(async () => {
    if (!isIntegrationMode || !testDbUrl || testDbUrl === '') {
      blockedReason =
        '[BLOCKED / NOT RUN] Attendance HTTP authorization & payroll-lock PostgreSQL 16 integration test requires ' +
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
      throw new Error(
        '[SECURITY FATAL] Integration test refused: unapproved host in TEST_DATABASE_URL.'
      );
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
    resetConfigForTesting();
    await testPrisma.$connect();

    const versionRows = await testPrisma.$queryRaw<Array<{ version: string }>>`
      SELECT version() AS version
    `;
    const serverVersion = versionRows[0]?.version || '';
    if (!/PostgreSQL 16\b/.test(serverVersion)) {
      throw new Error(
        `[SECURITY FATAL] Integration test requires PostgreSQL major version 16, got: "${serverVersion || 'unknown'}".`
      );
    }

    const dbRows = await testPrisma.$queryRaw<Array<{ db_name: string }>>`
      SELECT current_database() AS db_name
    `;
    if (dbRows[0]?.db_name !== 'core_erp_integration_test') {
      throw new Error(
        `[SECURITY FATAL] Integration client connected to unexpected database "${dbRows[0]?.db_name || 'unknown'}".`
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
      resetConfigForTesting();
    }
  });

  it('denies EMPLOYEE with ATTENDANCE:EDIT override from updating another employee attendance record (HTTP 403) while permitting self update', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const { companyId, shiftId } = await seedCompanyWithShift(client, 'Employee Self-Scope');

    const empUser1 = await seedUser(client, {
      companyId,
      role: 'EMPLOYEE',
      fullName: 'Employee One',
    });
    const empUser2 = await seedUser(client, {
      companyId,
      role: 'EMPLOYEE',
      fullName: 'Employee Two',
    });

    const emp1 = await seedEmployee(client, {
      companyId,
      shiftId,
      fullName: 'Employee One',
      userId: empUser1.userId,
    });
    const emp2 = await seedEmployee(client, {
      companyId,
      shiftId,
      fullName: 'Employee Two',
      userId: empUser2.userId,
    });

    // Grant ATTENDANCE:EDIT to EMPLOYEE in PostgreSQL so requirePermission passes genuinely
    // and AttendanceService.updateAttendance self-ownership enforcement is exercised end-to-end.
    await client.rolePermission.create({
      data: {
        companyId,
        role: 'EMPLOYEE',
        module: 'ATTENDANCE',
        action: 'EDIT',
        isGranted: true,
      },
    });

    const att1 = await seedAttendance(client, {
      companyId,
      employeeId: emp1.employeeId,
      shiftId,
      workDate: '2026-06-15',
      notes: 'Employee One Original Note',
    });
    const att2 = await seedAttendance(client, {
      companyId,
      employeeId: emp2.employeeId,
      shiftId,
      workDate: '2026-06-15',
      notes: 'Employee Two Original Note',
    });

    const emp1Token = AuthService.generateSessionToken({
      userId: empUser1.userId,
      companyId,
      email: empUser1.email,
      role: 'EMPLOYEE',
      tokenVersion: empUser1.tokenVersion,
    });

    // 1. Attempting to edit another employee's attendance record -> HTTP 403
    const peerRes = await request(app)
      .patch(`/api/attendance/${att2.attendanceId}`)
      .set('Authorization', `Bearer ${emp1Token}`)
      .send({ notes: 'Unauthorized Peer Edit' });

    expect(peerRes.status).toBe(403);
    expect(peerRes.body?.error?.code).toBe('FORBIDDEN');
    expect(peerRes.body?.error?.message).toMatch(/own attendance records/i);

    const att2After = await client.attendance.findUnique({ where: { id: att2.attendanceId } });
    expect(att2After?.notes).toBe('Employee Two Original Note');

    const peerAuditCount = await client.auditLog.count({
      where: { companyId, entity: 'Attendance', entityId: att2.attendanceId, action: 'ATTENDANCE_UPDATE' },
    });
    expect(peerAuditCount).toBe(0);

    // 2. Positive control: updating own attendance succeeds with HTTP 200 (proving RolePermission DB grant was live)
    const selfRes = await request(app)
      .patch(`/api/attendance/${att1.attendanceId}`)
      .set('Authorization', `Bearer ${emp1Token}`)
      .send({ notes: 'Employee One Self Update' });

    expect(selfRes.status).toBe(200);
    expect(selfRes.body?.notes).toBe('Employee One Self Update');

    const att1After = await client.attendance.findUnique({ where: { id: att1.attendanceId } });
    expect(att1After?.notes).toBe('Employee One Self Update');
    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it('denies cross-tenant attendance read and update requests with HTTP 404 without mutating target tenant data', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const tenantA = await seedCompanyWithShift(client, 'Tenant Alpha');
    const tenantB = await seedCompanyWithShift(client, 'Tenant Beta');

    const adminUserA = await seedUser(client, {
      companyId: tenantA.companyId,
      role: 'ADMIN',
      fullName: 'Alpha Admin',
    });

    const empB = await seedEmployee(client, {
      companyId: tenantB.companyId,
      shiftId: tenantB.shiftId,
      fullName: 'Beta Employee',
    });
    const attB = await seedAttendance(client, {
      companyId: tenantB.companyId,
      employeeId: empB.employeeId,
      shiftId: tenantB.shiftId,
      workDate: '2026-06-16',
      notes: 'Tenant Beta Confidential Note',
    });

    const adminAToken = AuthService.generateSessionToken({
      userId: adminUserA.userId,
      companyId: tenantA.companyId,
      email: adminUserA.email,
      role: 'ADMIN',
      tokenVersion: adminUserA.tokenVersion,
    });

    const getRes = await request(app)
      .get(`/api/attendance/${attB.attendanceId}`)
      .set('Authorization', `Bearer ${adminAToken}`);

    expect(getRes.status).toBe(404);
    expect(getRes.body?.error?.code).toBe('ATTENDANCE_NOT_FOUND');

    const patchRes = await request(app)
      .patch(`/api/attendance/${attB.attendanceId}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ notes: 'Cross-Tenant Tamper Attempt', status: 'ABSENT' });

    expect(patchRes.status).toBe(404);
    expect(patchRes.body?.error?.code).toBe('ATTENDANCE_NOT_FOUND');

    const attBAfter = await client.attendance.findUnique({ where: { id: attB.attendanceId } });
    expect(attBAfter?.notes).toBe('Tenant Beta Confidential Note');
    expect(attBAfter?.status).toBe('PRESENT');

    const crossTenantAuditCount = await client.auditLog.count({
      where: {
        entity: 'Attendance',
        entityId: attB.attendanceId,
        action: 'ATTENDANCE_UPDATE',
      },
    });
    expect(crossTenantAuditCount).toBe(0);
    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it('rejects attendance updates inside a locked payroll period with HTTP 409 without mutating the record', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const { companyId, shiftId } = await seedCompanyWithShift(client, 'Payroll Lock');

    const adminUser = await seedUser(client, {
      companyId,
      role: 'ADMIN',
      fullName: 'Payroll Lock Admin',
    });

    const emp = await seedEmployee(client, {
      companyId,
      shiftId,
      fullName: 'Locked Period Employee',
    });

    const attLocked = await seedAttendance(client, {
      companyId,
      employeeId: emp.employeeId,
      shiftId,
      workDate: '2026-05-15',
      notes: 'Pre-Lock Attendance Note',
    });

    await client.payrollPeriod.create({
      data: {
        id: crypto.randomUUID(),
        companyId,
        year: 2026,
        month: 5,
        name: 'May 2026 Payroll',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T00:00:00.000Z'),
        status: 'PROCESSED',
        processedAt: new Date('2026-06-01T00:00:00.000Z'),
        createdByUserId: adminUser.userId,
      },
    });

    const adminToken = AuthService.generateSessionToken({
      userId: adminUser.userId,
      companyId,
      email: adminUser.email,
      role: 'ADMIN',
      tokenVersion: adminUser.tokenVersion,
    });

    const lockedRes = await request(app)
      .patch(`/api/attendance/${attLocked.attendanceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ABSENT', notes: 'Post-Payroll Tamper Attempt' });

    expect(lockedRes.status).toBe(409);
    expect(lockedRes.body?.error?.code).toBe('ATTENDANCE_CONFLICT');
    expect(lockedRes.body?.error?.message).toMatch(/PROCESSED/);

    const attAfter = await client.attendance.findUnique({ where: { id: attLocked.attendanceId } });
    expect(attAfter?.status).toBe('PRESENT');
    expect(attAfter?.notes).toBe('Pre-Lock Attendance Note');

    const lockedAuditCount = await client.auditLog.count({
      where: {
        companyId,
        entity: 'Attendance',
        entityId: attLocked.attendanceId,
        action: 'ATTENDANCE_UPDATE',
      },
    });
    expect(lockedAuditCount).toBe(0);
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});
