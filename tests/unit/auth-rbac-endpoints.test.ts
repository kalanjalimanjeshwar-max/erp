import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { PermissionService } from '../../src/server/services/permission.service.js';
import { installUnitPrismaGuard } from '../helpers/unit-prisma-guard.js';

describe('Authentication & RBAC HTTP Middleware Unit Tests (Isolated Prisma Mocks)', () => {
  const app = createApp();
  const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
  const EMPLOYEE_USER_ID = '22222222-2222-4222-8222-222222222222';
  const ADMIN_USER_ID = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    installUnitPrismaGuard();
    AuthService.resetRateLimitsForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    AuthService.resetRateLimitsForTesting();
  });

  function mockActiveUserLookup(overrides: Partial<{
    id: string;
    companyId: string;
    email: string;
    fullName: string;
    role: 'SUPER_ADMIN' | 'ADMIN' | 'VICE_ADMIN' | 'EMPLOYEE';
    isActive: boolean;
    tokenVersion: number;
    lastLoginAt: Date | null;
  }> = {}) {
    const userRecord = {
      id: EMPLOYEE_USER_ID,
      companyId: COMPANY_ID,
      email: 'employee@corp.local',
      fullName: 'Active Employee',
      role: 'EMPLOYEE' as const,
      isActive: true,
      tokenVersion: 1,
      lastLoginAt: new Date('2026-01-15T09:00:00.000Z'),
      ...overrides,
    };

    return vi.spyOn(prisma.user, 'findUnique').mockImplementation((async (args: any) => {
      if (args?.where?.id === userRecord.id) {
        return userRecord as any;
      }
      return null;
    }) as any);
  }

  it('returns exactly HTTP 403 FORBIDDEN_PERMISSION_DENIED for an active EMPLOYEE on GET /api/users and GET /api/audit-logs', async () => {
    const findUniqueSpy = mockActiveUserLookup();

    const employeeToken = AuthService.generateSessionToken({
      userId: EMPLOYEE_USER_ID,
      companyId: COMPANY_ID,
      email: 'employee@corp.local',
      role: 'EMPLOYEE',
      tokenVersion: 1,
    });

    const usersRes = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(usersRes.status).toBe(403);
    expect(usersRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(usersRes.body.error.message).toContain('EMPLOYEE');
    expect(usersRes.body.error.message).toContain('USER');

    const auditRes = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(auditRes.status).toBe(403);
    expect(auditRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(auditRes.body.error.message).toContain('EMPLOYEE');
    expect(auditRes.body.error.message).toContain('AUDIT_LOG');

    // Confirm real AuthService.validateSessionUser() queried the DB for both requests
    expect(findUniqueSpy).toHaveBeenCalledTimes(2);
    expect(findUniqueSpy).toHaveBeenNthCalledWith(1, { where: { id: EMPLOYEE_USER_ID } });
    expect(findUniqueSpy).toHaveBeenNthCalledWith(2, { where: { id: EMPLOYEE_USER_ID } });
  });

  it('returns HTTP 503 DATABASE_UNREACHABLE on simulated Prisma P1001 connectivity failure during authentication', async () => {
    const p1001Error = Object.assign(
      new Error("Can't reach database server at `localhost:5433`"),
      { code: 'P1001', name: 'PrismaClientInitializationError' }
    );

    vi.spyOn(prisma.user, 'findUnique').mockRejectedValue(p1001Error);
    const permissionSpy = vi.spyOn(PermissionService, 'hasPermission');

    const employeeToken = AuthService.generateSessionToken({
      userId: EMPLOYEE_USER_ID,
      companyId: COMPANY_ID,
      email: 'employee@corp.local',
      role: 'EMPLOYEE',
      tokenVersion: 1,
    });

    const usersRes = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(usersRes.status).toBe(503);
    expect(usersRes.body.error.code).toBe('DATABASE_UNREACHABLE');

    const auditRes = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(auditRes.status).toBe(503);
    expect(auditRes.body.error.code).toBe('DATABASE_UNREACHABLE');

    // Outage during authentication must fail before RBAC evaluation and never convert to 401/403
    expect(permissionSpy).not.toHaveBeenCalled();
  });

  it('returns HTTP 401 ACCOUNT_INACTIVE_OR_REVOKED when session tokenVersion is revoked or user is inactive', async () => {
    mockActiveUserLookup({ tokenVersion: 2 });
    const permissionSpy = vi.spyOn(PermissionService, 'hasPermission');

    const staleToken = AuthService.generateSessionToken({
      userId: EMPLOYEE_USER_ID,
      companyId: COMPANY_ID,
      email: 'employee@corp.local',
      role: 'EMPLOYEE',
      tokenVersion: 1,
    });

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${staleToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE_OR_REVOKED');
    expect(permissionSpy).not.toHaveBeenCalled();
  });

  it('fails closed with HTTP 403 FORBIDDEN_PERMISSION_DENIED when rolePermission lookup fails with a DB error', async () => {
    mockActiveUserLookup({
      id: ADMIN_USER_ID,
      email: 'admin@corp.local',
      fullName: 'Active Admin',
      role: 'ADMIN',
      tokenVersion: 1,
    });

    const p1001Error = Object.assign(
      new Error("Can't reach database server at `localhost:5433`"),
      { code: 'P1001', name: 'PrismaClientInitializationError' }
    );
    vi.spyOn(prisma.rolePermission, 'findUnique').mockRejectedValue(p1001Error);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const adminToken = AuthService.generateSessionToken({
      userId: ADMIN_USER_ID,
      companyId: COMPANY_ID,
      email: 'admin@corp.local',
      role: 'ADMIN',
      tokenVersion: 1,
    });

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('never exposes passwordHash, SESSION_SECRET, or tokenVersion on failed login responses', async () => {
    const storedHash = await bcrypt.hash('CorrectPassword#2026!', 4);

    vi.spyOn(prisma.user, 'findMany').mockResolvedValue([
      {
        id: EMPLOYEE_USER_ID,
        companyId: COMPANY_ID,
        email: 'employee@corp.local',
        fullName: 'Active Employee',
        passwordHash: storedHash,
        role: 'EMPLOYEE',
        isActive: true,
        tokenVersion: 1,
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        lastLoginIp: null,
        company: {
          id: COMPANY_ID,
          code: 'CORP01',
          name: 'Corp Test',
          currency: 'USD',
          timezone: 'UTC',
        },
      } as any,
    ]);
    vi.spyOn(prisma.user, 'update').mockResolvedValue({} as any);
    vi.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as any);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'employee@corp.local', password: 'WrongPassword!' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const rawOutput = JSON.stringify(res.body);
    expect(rawOutput).not.toContain('passwordHash');
    expect(rawOutput).not.toContain(storedHash);
    expect(rawOutput).not.toContain('SESSION_SECRET');
    expect(rawOutput).not.toContain('tokenVersion');
  });
});
