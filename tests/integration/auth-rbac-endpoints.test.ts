import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import net from 'node:net';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
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

describe('Authentication & RBAC API Endpoint Integration Tests — Database-Independent HTTP Contracts', () => {
  const app = createApp();

  it('POST /api/auth/login should reject empty body with 400', async () => {
    const res = await request(app).post('/api/auth/login').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error.message).toContain('required');
  });

  it('Protected endpoints must reject unauthenticated requests with 401 Unauthorized', async () => {
    const protectedRoutes = [
      '/api/auth/me',
      '/api/users',
      '/api/company/profile',
      '/api/audit-logs',
      '/api/permissions/matrix',
    ];

    for (const route of protectedRoutes) {
      const res = await request(app).get(route);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    }
  });
});

/**
 * Real PostgreSQL 16 HTTP Integration Test Suite:
 * Authentication & RBAC Administrative Endpoint Enforcement
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires COREERP_INTEGRATION_TEST_MODE=true and
 *    TEST_DATABASE_URL pointing to isolated 'core_erp_integration_test' on localhost/127.0.0.1:5434.
 * 2. Never connects to operational/development (5432) or standard unit-test (5433) databases.
 * 3. DATABASE_URL remains strictly unset throughout integration mode.
 * 4. If integration mode is not enabled, TEST_DATABASE_URL is missing, or port 5434 is unreachable,
 *    marks DB-dependent tests genuinely SKIPPED via `ctx.skip(...)` with an explicit `[BLOCKED / NOT RUN]` note.
 * 5. Seeds uniquely scoped temporary Company + active EMPLOYEE User fixtures and deletes only
 *    test-owned records in strict foreign-key order during `afterAll`.
 */
describe('Authentication & RBAC API Endpoint Integration Tests — PostgreSQL 16', () => {
  const app = createApp();
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^["']|["']$/g, '');
  const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma: PrismaClient | null = null;

  const createdCompanyIds = new Set<string>();

  const cleanupCompanyFixtures = async (
    client: PrismaClient,
    companyId: string
  ): Promise<string[]> => {
    const deleteSteps: Array<{ label: string; run: () => Promise<unknown> }> = [
      { label: 'auditLog', run: () => client.auditLog.deleteMany({ where: { companyId } }) },
      {
        label: 'rolePermission',
        run: () => client.rolePermission.deleteMany({ where: { companyId } }),
      },
      { label: 'user', run: () => client.user.deleteMany({ where: { companyId } }) },
      { label: 'company', run: () => client.company.deleteMany({ where: { id: companyId } }) },
    ];

    const errors: string[] = [];
    for (const step of deleteSteps) {
      try {
        await step.run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`companyId=${companyId} step=${step.label}: ${message}`);
      }
    }
    return errors;
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

  const seedTemporaryEmployeeTenant = async (client: PrismaClient, label: string) => {
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const shortCompany = companyId.slice(0, 8);
    const shortUser = userId.slice(0, 8);
    const email = `rbac-emp-${shortUser}@coreerp.local`;
    const passwordHash = await bcrypt.hash('EmployeePass#2026!', 4);

    createdCompanyIds.add(companyId);

    await client.company.create({
      data: {
        id: companyId,
        code: `RBAC-${shortCompany}`,
        name: `${label} Company`,
        legalName: `${label} LLC`,
        currency: 'USD',
        timezone: 'UTC',
      },
    });

    await client.user.create({
      data: {
        id: userId,
        companyId,
        email,
        fullName: `${label} Employee`,
        passwordHash,
        role: 'EMPLOYEE',
        isActive: true,
        tokenVersion: 1,
      },
    });

    return {
      companyId,
      userId,
      email,
      passwordHash,
      tokenVersion: 1,
    };
  };

  beforeAll(async () => {
    if (!isIntegrationMode || !testDbUrl || testDbUrl === '') {
      blockedReason =
        '[BLOCKED / NOT RUN] Auth & RBAC PostgreSQL 16 integration test requires ' +
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
    const cleanupErrors: string[] = [];
    try {
      if (testPrisma && isDbConnected) {
        for (const companyId of createdCompanyIds) {
          try {
            const tenantErrors = await cleanupCompanyFixtures(testPrisma, companyId);
            cleanupErrors.push(...tenantErrors);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            cleanupErrors.push(`companyId=${companyId} unexpected cleanup error: ${message}`);
          }
        }
      }
    } finally {
      AuthService.resetRateLimitsForTesting();
      if (testPrisma) {
        try {
          await testPrisma.$disconnect();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          cleanupErrors.push(`prisma.$disconnect failed: ${message}`);
        }
      }
      resetPrismaClientForTesting();
      resetConfigForTesting();
    }

    if (cleanupErrors.length > 0) {
      throw new Error(
        `[INTEGRATION CLEANUP FAILED] ${cleanupErrors.length} error(s) occurred while cleaning up test fixtures:\n` +
          cleanupErrors.join('\n')
      );
    }
  });

  it('EMPLOYEE role session token must be blocked with 403 Forbidden on administrative endpoints', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const seeded = await seedTemporaryEmployeeTenant(client, 'RBAC Admin Block');

    const employeeToken = AuthService.generateSessionToken({
      userId: seeded.userId,
      companyId: seeded.companyId,
      email: seeded.email,
      role: 'EMPLOYEE',
      tokenVersion: seeded.tokenVersion,
    });

    // Attempting to access administrative user directory
    const userRes = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(userRes.status).toBe(403);
    expect(userRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(userRes.body.error.message).toContain('EMPLOYEE');

    // Attempting to access security audit trail
    const auditRes = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(auditRes.status).toBe(403);
    expect(auditRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(auditRes.body.error.message).toContain('EMPLOYEE');
  });

  it('API responses must never expose password hashes or sensitive session secrets', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const seeded = await seedTemporaryEmployeeTenant(client, 'Secret Non-Leakage');

    // Probe real login failure response against seeded PostgreSQL 16 user
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: seeded.email, password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const rawOutput = JSON.stringify(res.body);
    expect(rawOutput).not.toContain('passwordHash');
    expect(rawOutput).not.toContain(seeded.passwordHash);
    expect(rawOutput).not.toContain('SESSION_SECRET');
    expect(rawOutput).not.toContain('tokenVersion');
  });
});
