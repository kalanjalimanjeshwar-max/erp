import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Role } from '../../src/shared/types.js';

interface MockCompany {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  currency: string;
  timezone: string;
  logoUrl: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  appHeaderTitle: string | null;
}

interface MockUser {
  id: string;
  companyId: string;
  email: string;
  fullName: string;
  passwordHash: string;
  role: Role;
  isActive: boolean;
  tokenVersion: number;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  createdAt: Date;
}

const mockStore = vi.hoisted(() => {
  return {
    companies: new Map<string, MockCompany>(),
    users: new Map<string, MockUser>(),
    simulateDbError: null as Error | null,
    auditEntries: [] as Array<Record<string, unknown>>,
  };
});

function matchStringFilter(actual: string, filter: unknown): boolean {
  if (typeof filter === 'string') {
    return actual === filter;
  }
  if (filter && typeof filter === 'object') {
    const obj = filter as { equals?: string; mode?: string };
    if (typeof obj.equals === 'string') {
      return obj.mode === 'insensitive'
        ? actual.toLowerCase() === obj.equals.toLowerCase()
        : actual === obj.equals;
    }
  }
  return true;
}

function queryUsers(where: Record<string, unknown> | undefined): Array<MockUser & { company: MockCompany }> {
  const results: Array<MockUser & { company: MockCompany }> = [];
  for (const user of mockStore.users.values()) {
    const company = mockStore.companies.get(user.companyId);
    if (!company) continue;

    if (where) {
      if (where.id && user.id !== where.id) continue;
      if (where.companyId && user.companyId !== where.companyId) continue;
      if (where.email && !matchStringFilter(user.email, where.email)) continue;
      if (where.role && user.role !== where.role) continue;
      if (typeof where.isActive === 'boolean' && user.isActive !== where.isActive) continue;
      if (where.company && typeof where.company === 'object') {
        const companyWhere = where.company as Record<string, unknown>;
        if (companyWhere.code && !matchStringFilter(company.code, companyWhere.code)) continue;
      }
    }

    results.push({ ...user, company });
  }
  return results;
}

vi.mock('../../src/server/db/client.js', () => ({
  prisma: {
    user: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown>; take?: number }) => {
        if (mockStore.simulateDbError) {
          throw mockStore.simulateDbError;
        }
        const rows = queryUsers(args?.where);
        return typeof args?.take === 'number' ? rows.slice(0, args.take) : rows;
      }),
      findFirst: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        if (mockStore.simulateDbError) {
          throw mockStore.simulateDbError;
        }
        return queryUsers(args?.where)[0] ?? null;
      }),
      findUnique: vi.fn(async (args: { where: { id?: string } }) => {
        if (mockStore.simulateDbError) {
          throw mockStore.simulateDbError;
        }
        if (!args.where.id) return null;
        const user = mockStore.users.get(args.where.id);
        return user ? { ...user } : null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (mockStore.simulateDbError) {
          throw mockStore.simulateDbError;
        }
        const user = mockStore.users.get(args.where.id);
        if (!user) throw new Error('User not found');

        const updated: MockUser = { ...user };
        for (const [key, value] of Object.entries(args.data)) {
          if (
            key === 'tokenVersion' &&
            value &&
            typeof value === 'object' &&
            'increment' in value
          ) {
            updated.tokenVersion += Number((value as { increment: number }).increment);
          } else {
            (updated as unknown as Record<string, unknown>)[key] = value;
          }
        }
        mockStore.users.set(updated.id, updated);
        return { ...updated };
      }),
    },
    company: {
      findUnique: vi.fn(async (args: { where: { id?: string } }) => {
        if (mockStore.simulateDbError) {
          throw mockStore.simulateDbError;
        }
        if (!args.where.id) return null;
        return mockStore.companies.get(args.where.id) ?? null;
      }),
    },
    companySetting: {
      findMany: vi.fn(async () => []),
    },
    rolePermission: {
      findUnique: vi.fn(async () => null),
    },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        mockStore.auditEntries.push(args.data);
        return { id: `audit-${mockStore.auditEntries.length}` };
      }),
    },
  },
}));

import { createApp } from '../../src/server/app.js';
import { AuthService, SESSION_COOKIE_NAME } from '../../src/server/services/auth.service.js';
import { enforceCompanyScope } from '../../src/server/middleware/auth.middleware.js';
import {
  formatHashForTab,
  parseTabFromHash,
  resolveInitialSessionState,
  resolvePostLoginState,
  resolvePostLogoutState,
} from '../../src/client/utils/authSessionState.js';

function extractCookiePair(setCookieHeaders: string[] | string | undefined): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
    ? [setCookieHeaders]
    : [];
  const sessionHeader = list.find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!sessionHeader) return '';
  return sessionHeader.split(';')[0];
}

function findSetCookieHeader(setCookieHeaders: string[] | string | undefined): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
    ? [setCookieHeaders]
    : [];
  return list.find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`)) || '';
}

describe('CoreERP Login & Authentication Permanent Fix (DB-Free Unit Suite)', () => {
  const app = createApp();
  let superAdminHash: string;
  let employeeHash: string;
  let secondTenantHash: string;

  const companyA: MockCompany = {
    id: 'comp-alpha-1',
    code: 'ALPHA',
    name: 'Alpha Industries',
    legalName: 'Alpha Industries Pvt Ltd',
    taxId: null,
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    logoUrl: null,
    address: null,
    phone: null,
    email: 'ops@alpha.local',
    website: null,
    appHeaderTitle: 'Alpha ERP',
  };

  const companyB: MockCompany = {
    id: 'comp-beta-2',
    code: 'BETA',
    name: 'Beta Logistics',
    legalName: 'Beta Logistics LLC',
    taxId: null,
    currency: 'USD',
    timezone: 'UTC',
    logoUrl: null,
    address: null,
    phone: null,
    email: 'ops@beta.local',
    website: null,
    appHeaderTitle: 'Beta ERP',
  };

  beforeEach(async () => {
    AuthService.resetRateLimitsForTesting();
    mockStore.simulateDbError = null;
    mockStore.companies.clear();
    mockStore.users.clear();
    mockStore.auditEntries.length = 0;

    superAdminHash = await bcrypt.hash('SuperAdmin#2026!', 10);
    employeeHash = await bcrypt.hash('Employee#2026!', 10);
    secondTenantHash = await bcrypt.hash('BetaAdmin#2026!', 10);

    mockStore.companies.set(companyA.id, companyA);
    mockStore.companies.set(companyB.id, companyB);

    mockStore.users.set('user-super-1', {
      id: 'user-super-1',
      companyId: companyA.id,
      email: 'Super.Admin@Alpha.Local', // Intentionally mixed case to verify case-insensitive lookup
      fullName: 'Primary Super Admin',
      passwordHash: superAdminHash,
      role: 'SUPER_ADMIN',
      isActive: true,
      tokenVersion: 1,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      lastLoginIp: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    mockStore.users.set('user-emp-1', {
      id: 'user-emp-1',
      companyId: companyA.id,
      email: 'employee@alpha.local',
      fullName: 'Asha Employee',
      passwordHash: employeeHash,
      role: 'EMPLOYEE',
      isActive: true,
      tokenVersion: 1,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      lastLoginIp: null,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });

    mockStore.users.set('user-beta-admin', {
      id: 'user-beta-admin',
      companyId: companyB.id,
      email: 'shared@example.local',
      fullName: 'Beta Admin',
      passwordHash: secondTenantHash,
      role: 'ADMIN',
      isActive: true,
      tokenVersion: 1,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      lastLoginIp: null,
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });
  });

  describe('1. Valid and Invalid Login + Password Hash Compatibility', () => {
    it('authenticates valid credentials with email case normalization and sets HttpOnly session cookie', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: '  super.admin@alpha.local  ', password: 'SuperAdmin#2026!' });

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe('user-super-1');
      expect(res.body.user.role).toBe('SUPER_ADMIN');
      expect(res.body.user.companyId).toBe(companyA.id);
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.body.company.code).toBe('ALPHA');

      const setCookie = findSetCookieHeader(res.headers['set-cookie']);
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).not.toContain('Secure');
    });

    it('rejects wrong password with generic 401 and increments failedLoginAttempts without leaking secrets', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'super.admin@alpha.local', password: 'WrongPassword#999!' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.error.message).toBe('Invalid email or password.');
      expect(JSON.stringify(res.body)).not.toContain(superAdminHash);
      expect(JSON.stringify(res.body)).not.toContain('WrongPassword#999!');
      expect(mockStore.users.get('user-super-1')?.failedLoginAttempts).toBe(1);
    });

    it('supports $2a$ and $2b$ bcrypt hashes and safely rejects malformed hashes without HTTP 500', async () => {
      const hash2a = superAdminHash.replace(/^\$2b\$/, '$2a$');
      const user = mockStore.users.get('user-super-1')!;
      user.passwordHash = hash2a;

      const okRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });
      expect(okRes.status).toBe(200);

      // Corrupt hash should reject safely with 401, never crash with 500
      mockStore.users.get('user-super-1')!.passwordHash = 'not-a-valid-bcrypt-hash';
      const badHashRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });
      expect(badHashRes.status).toBe(401);
      expect(badHashRes.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('2. Unknown User Handling', () => {
    it('rejects unknown email with identical generic 401 message to prevent account enumeration', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nonexistent@alpha.local', password: 'AnyPassword#2026!' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.error.message).toBe('Invalid email or password.');
      expect(findSetCookieHeader(res.headers['set-cookie'])).toBe('');
    });
  });

  describe('3. SUPER_ADMIN Login & Protected Access', () => {
    it('allows authenticated SUPER_ADMIN to access protected administrative endpoints', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });

      expect(loginRes.status).toBe(200);
      const cookie = extractCookiePair(loginRes.headers['set-cookie']);

      const usersRes = await request(app)
        .get('/api/users')
        .set('Cookie', cookie);

      expect(usersRes.status).toBe(200);
      expect(Array.isArray(usersRes.body)).toBe(true);
      expect(usersRes.body.every((u: { companyId: string }) => u.companyId === companyA.id)).toBe(true);
    });
  });

  describe('4. EMPLOYEE Login & Role Authorization', () => {
    it('authenticates EMPLOYEE and enforces RBAC denial on admin-only endpoints', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'employee@alpha.local', password: 'Employee#2026!' });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.role).toBe('EMPLOYEE');
      const cookie = extractCookiePair(loginRes.headers['set-cookie']);

      // Allowed: own session restoration
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', cookie);
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.role).toBe('EMPLOYEE');

      // Denied: User administration directory
      const adminUsersRes = await request(app)
        .get('/api/users')
        .set('Cookie', cookie);
      expect(adminUsersRes.status).toBe(403);
      expect(adminUsersRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    });
  });

  describe('5. Tenant Isolation & Multi-Company Disambiguation', () => {
    it('requires companyCode when the same email exists in multiple tenants and authenticates the scoped tenant', async () => {
      // Add same email to Company A as well
      mockStore.users.set('user-alpha-shared', {
        id: 'user-alpha-shared',
        companyId: companyA.id,
        email: 'shared@example.local',
        fullName: 'Alpha Shared Admin',
        passwordHash: superAdminHash,
        role: 'ADMIN',
        isActive: true,
        tokenVersion: 1,
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        lastLoginIp: null,
        createdAt: new Date('2026-01-04T00:00:00Z'),
      });

      // Without companyCode -> explicit 409 disambiguation prompt
      const ambiguousRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'shared@example.local', password: 'BetaAdmin#2026!' });
      expect(ambiguousRes.status).toBe(409);
      expect(ambiguousRes.body.error.code).toBe('COMPANY_CODE_REQUIRED');

      // With companyCode=BETA -> authenticates into Company B only
      const betaLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: 'shared@example.local', password: 'BetaAdmin#2026!', companyCode: 'beta' });
      expect(betaLogin.status).toBe(200);
      expect(betaLogin.body.user.companyId).toBe(companyB.id);
      expect(betaLogin.body.company.code).toBe('BETA');

      // Wrong tenant password under ALPHA -> rejected 401
      const wrongTenantPwd = await request(app)
        .post('/api/auth/login')
        .send({ email: 'shared@example.local', password: 'BetaAdmin#2026!', companyCode: 'ALPHA' });
      expect(wrongTenantPwd.status).toBe(401);
    });

    it('rejects session tokens whose companyId does not match the database user record', async () => {
      const forgedTenantToken = AuthService.generateSessionToken({
        userId: 'user-emp-1', // Belongs to companyA
        companyId: companyB.id, // Mismatched tenant
        email: 'employee@alpha.local',
        role: 'EMPLOYEE',
        tokenVersion: 1,
      });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${forgedTenantToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('ACCOUNT_INACTIVE_OR_REVOKED');
    });

    it('blocks cross-company route access in enforceCompanyScope middleware', () => {
      const next = vi.fn();
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));

      enforceCompanyScope(
        {
          params: { companyId: companyB.id },
          user: {
            id: 'user-emp-1',
            userId: 'user-emp-1',
            companyId: companyA.id,
            email: 'employee@alpha.local',
            fullName: 'Asha Employee',
            role: 'EMPLOYEE',
            isActive: true,
            tokenVersion: 1,
          },
        } as unknown as Parameters<typeof enforceCompanyScope>[0],
        { status } as unknown as Parameters<typeof enforceCompanyScope>[1],
        next
      );

      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('6. Session Persistence After Page Refresh (HTTP, Proxied HTTPS & Frontend State)', () => {
    it('persists session across GET /api/auth/me over local HTTP and sets Partitioned Secure SameSite=None over proxied HTTPS', async () => {
      // Local HTTP login (e.g. Windows http://localhost:3000)
      const httpLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });
      expect(httpLogin.status).toBe(200);
      const httpCookie = extractCookiePair(httpLogin.headers['set-cookie']);

      const refreshRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', httpCookie);
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.user.id).toBe('user-super-1');
      expect(refreshRes.body.company.id).toBe(companyA.id);

      // Reverse-proxied HTTPS login (e.g. TLS proxy / iframe preview)
      const httpsLogin = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-Proto', 'https')
        .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });
      expect(httpsLogin.status).toBe(200);

      const httpsSetCookie = findSetCookieHeader(httpsLogin.headers['set-cookie']);
      expect(httpsSetCookie).toContain('HttpOnly');
      expect(httpsSetCookie).toContain('Secure');
      expect(httpsSetCookie).toContain('SameSite=None');
      expect(httpsSetCookie).toContain('Partitioned');

      const httpsCookie = extractCookiePair(httpsLogin.headers['set-cookie']);
      const httpsMe = await request(app)
        .get('/api/auth/me')
        .set('X-Forwarded-Proto', 'https')
        .set('Cookie', httpsCookie);
      expect(httpsMe.status).toBe(200);
      expect(httpsMe.body.user.id).toBe('user-super-1');
    });

    it('preserves authenticated protected tab on frontend page refresh without redirecting to Login', () => {
      expect(parseTabFromHash('#/users')).toBe('users');
      expect(formatHashForTab('users')).toBe('#/users');
      expect(parseTabFromHash('#/login')).toBeNull();

      const restored = resolveInitialSessionState({
        auth: {
          ok: true,
          user: {
            id: 'user-super-1',
            userId: 'user-super-1',
            companyId: companyA.id,
            email: 'Super.Admin@Alpha.Local',
            fullName: 'Primary Super Admin',
            role: 'SUPER_ADMIN',
            isActive: true,
            tokenVersion: 1,
          },
          company: {
            id: companyA.id,
            code: companyA.code,
            name: companyA.name,
            currency: companyA.currency,
            timezone: companyA.timezone,
          },
        },
        // Even if readiness probe lagged transiently, successful /api/auth/me confirms DB connectivity
        readiness: null,
        setupStatus: {
          isSetupRequired: false,
          hasCompany: true,
          hasSuperAdmin: true,
          databaseConnected: true,
        },
        requestedTab: 'users',
      });

      expect(restored.currentUser?.id).toBe('user-super-1');
      expect(restored.activeTab).toBe('users');
      expect(restored.dbReadiness.status).toBe('connected');
      expect(restored.sessionExpiredMessage).toBeNull();

      // Post-login state syncs readiness and navigates to requested operational tab
      const postLogin = resolvePostLoginState({
        data: { user: restored.currentUser!, company: restored.companyProfile! },
        currentReadiness: { status: 'disconnected', database: 'PostgreSQL' },
        requestedTab: 'invoices',
      });
      expect(postLogin.activeTab).toBe('invoices');
      expect(postLogin.dbReadiness?.status).toBe('connected');
    });
  });

  describe('7. Invalid, Malformed, Expired, Inactive & Revoked Sessions', () => {
    it('returns 401 SESSION_EXPIRED (never 500 RangeError) on wrong-length or malformed cookie signatures', async () => {
      const malformedTokens = [
        'not-even-a-jwt',
        'a.b.short',
        `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`,
      ];

      for (const badToken of malformedTokens) {
        const res = await request(app)
          .get('/api/auth/me')
          .set('Cookie', `${SESSION_COOKIE_NAME}=${badToken}`);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('SESSION_EXPIRED');
      }
    });

    it('rejects tampered payload and expired tokens with 401 and surfaces expiry message on frontend state', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 60;
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          userId: 'user-super-1',
          companyId: companyA.id,
          email: 'Super.Admin@Alpha.Local',
          role: 'SUPER_ADMIN',
          tokenVersion: 1,
          exp: pastExp,
        })
      ).toString('base64url');
      const sig = crypto
        .createHmac('sha256', 'dev_insecure_fallback_session_secret_32_chars_long')
        .update(`${header}.${payload}`)
        .digest('base64url');

      const expiredRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${header}.${payload}.${sig}`);

      expect(expiredRes.status).toBe(401);
      expect(expiredRes.body.error.code).toBe('SESSION_EXPIRED');

      const frontendExpired = resolveInitialSessionState({
        auth: {
          ok: false,
          errorCode: expiredRes.body.error.code,
          errorMessage: expiredRes.body.error.message,
        },
        readiness: { status: 'connected', database: 'PostgreSQL' },
        setupStatus: {
          isSetupRequired: false,
          hasCompany: true,
          hasSuperAdmin: true,
          databaseConnected: true,
        },
        requestedTab: 'users',
      });

      expect(frontendExpired.currentUser).toBeNull();
      expect(frontendExpired.activeTab).toBe('login');
      expect(frontendExpired.sessionExpiredMessage).toContain('expired');
    });

    it('rejects inactive accounts and stale tokenVersion sessions with 401 ACCOUNT_INACTIVE_OR_REVOKED', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'employee@alpha.local', password: 'Employee#2026!' });
      const cookie = extractCookiePair(loginRes.headers['set-cookie']);

      // Deactivate user
      mockStore.users.get('user-emp-1')!.isActive = false;
      const inactiveRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', cookie);
      expect(inactiveRes.status).toBe(401);
      expect(inactiveRes.body.error.code).toBe('ACCOUNT_INACTIVE_OR_REVOKED');

      // Reactivate user but increment tokenVersion (simulating password reset / session revocation)
      mockStore.users.get('user-emp-1')!.isActive = true;
      mockStore.users.get('user-emp-1')!.tokenVersion = 2;
      const revokedRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', cookie);
      expect(revokedRes.status).toBe(401);
      expect(revokedRes.body.error.code).toBe('ACCOUNT_INACTIVE_OR_REVOKED');
    });
  });

  describe('8. Logout, Cookie Clearing & Subsequent Re-Login', () => {
    it('revokes session tokenVersion, clears cookie with matching attributes, invalidates old cookie, and allows re-login', async () => {
      // 1. Login over proxied HTTPS
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-Proto', 'https')
        .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });
      expect(loginRes.status).toBe(200);
      const oldCookie = extractCookiePair(loginRes.headers['set-cookie']);

      // 2. Logout over proxied HTTPS
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('X-Forwarded-Proto', 'https')
        .set('Cookie', oldCookie);
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);
      expect(mockStore.users.get('user-super-1')?.tokenVersion).toBe(2);

      // Verify cleared cookie preserves Secure, SameSite=None, Partitioned so browsers delete it
      const clearHeader = findSetCookieHeader(logoutRes.headers['set-cookie']);
      expect(clearHeader).toContain(`${SESSION_COOKIE_NAME}=;`);
      expect(clearHeader).toContain('Secure');
      expect(clearHeader).toContain('SameSite=None');
      expect(clearHeader).toContain('Partitioned');

      // 3. Reusing old cookie must now be rejected
      const staleRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', oldCookie);
      expect(staleRes.status).toBe(401);
      expect(staleRes.body.error.code).toBe('ACCOUNT_INACTIVE_OR_REVOKED');

      // 4. Logout is idempotent even when cookie is already invalid/expired
      const idempotentLogout = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `${SESSION_COOKIE_NAME}=invalid.expired.token`);
      expect(idempotentLogout.status).toBe(200);
      expect(findSetCookieHeader(idempotentLogout.headers['set-cookie'])).toContain(`${SESSION_COOKIE_NAME}=;`);

      // 5. Subsequent login issues a fresh valid session at tokenVersion 2
      const reloginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });
      expect(reloginRes.status).toBe(200);
      expect(reloginRes.body.user.tokenVersion).toBe(2);

      const newCookie = extractCookiePair(reloginRes.headers['set-cookie']);
      const meAfterRelogin = await request(app)
        .get('/api/auth/me')
        .set('Cookie', newCookie);
      expect(meAfterRelogin.status).toBe(200);
      expect(meAfterRelogin.body.user.tokenVersion).toBe(2);

      // Frontend logout helper clears user & company profile completely
      const clearedUi = resolvePostLogoutState();
      expect(clearedUi).toEqual({
        currentUser: null,
        companyProfile: null,
        activeTab: 'login',
        sessionExpiredMessage: null,
      });
    });
  });

  describe('9. Login API Error Handling, DB Outage Propagation & CSRF Protection', () => {
    it('returns 400 VALIDATION_ERROR on missing or non-string credentials', async () => {
      const emptyRes = await request(app).post('/api/auth/login').send({});
      expect(emptyRes.status).toBe(400);
      expect(emptyRes.body.error.code).toBe('VALIDATION_ERROR');

      const nonStringRes = await request(app)
        .post('/api/auth/login')
        .send({ email: { $ne: '' }, password: 12345 });
      expect(nonStringRes.status).toBe(400);
      expect(nonStringRes.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 503 DATABASE_UNREACHABLE on DB connectivity errors without masking as 401 or penalizing rate limit', async () => {
      const connErr = new Error("Can't reach database server at localhost:5432");
      (connErr as { code?: string }).code = 'P1001';
      mockStore.simulateDbError = connErr;

      // Repeated DB failures must return 503 and must NOT lock out the account
      for (let i = 0; i < 6; i++) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('DATABASE_UNREACHABLE');
      }

      // Once DB recovers, valid login succeeds immediately
      mockStore.simulateDbError = null;
      const recovered = await request(app)
        .post('/api/auth/login')
        .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });
      expect(recovered.status).toBe(200);
    });

    it('enforces brute-force lockout (429 RATE_LIMITED) after 5 consecutive failed logins', async () => {
      for (let i = 0; i < 5; i++) {
        const failRes = await request(app)
          .post('/api/auth/login')
          .send({ email: 'employee@alpha.local', password: 'WrongPassword!' });
        expect(failRes.status).toBe(401);
      }

      const lockedRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'employee@alpha.local', password: 'Employee#2026!' });
      expect(lockedRes.status).toBe(429);
      expect(lockedRes.body.error.code).toBe('RATE_LIMITED');
    });

    it('rejects cross-origin cookie-authenticated mutations with 403 CSRF_ORIGIN_MISMATCH', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'super.admin@alpha.local', password: 'SuperAdmin#2026!' });
      const cookie = extractCookiePair(loginRes.headers['set-cookie']);

      const csrfLogout = await request(app)
        .post('/api/auth/logout')
        .set('Host', 'erp.alpha.local')
        .set('Origin', 'https://attacker.example.com')
        .set('Cookie', cookie);
      expect(csrfLogout.status).toBe(403);
      expect(csrfLogout.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
      // Session must remain intact after blocked CSRF attempt
      expect(mockStore.users.get('user-super-1')?.tokenVersion).toBe(1);

      // Same-origin mutation succeeds
      const sameOriginLogout = await request(app)
        .post('/api/auth/logout')
        .set('Host', 'erp.alpha.local')
        .set('Origin', 'https://erp.alpha.local')
        .set('Cookie', cookie);
      expect(sameOriginLogout.status).toBe(200);
    });
  });
});
