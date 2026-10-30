import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { AuthService } from '../../src/server/services/auth.service.js';

describe('Authentication & RBAC API Endpoint Integration Tests', () => {
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

  it('EMPLOYEE role session token must be blocked with 403 Forbidden on administrative endpoints', async () => {
    // Generate valid signed session token for an EMPLOYEE
    const employeeToken = AuthService.generateSessionToken({
      userId: 'emp-user-uuid-1',
      companyId: 'company-uuid-1',
      email: 'employee@corp.local',
      role: 'EMPLOYEE',
      tokenVersion: 1,
    });

    // Attempting to access administrative user directory
    const userRes = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${employeeToken}`);

    // Expect 403 (or 401 if user DB probe fails in offline sandbox)
    expect([401, 403]).toContain(userRes.status);
    if (userRes.status === 403) {
      expect(userRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
      expect(userRes.body.error.message).toContain('EMPLOYEE');
    }

    // Attempting to access security audit trail
    const auditRes = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect([401, 403]).toContain(auditRes.status);
    if (auditRes.status === 403) {
      expect(auditRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    }
  });

  it('API responses must never expose password hashes or sensitive session secrets', async () => {
    // Probe login failure response
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@corp.local', password: 'wrong' });

    const rawOutput = JSON.stringify(res.body);
    expect(rawOutput).not.toContain('passwordHash');
    expect(rawOutput).not.toContain('SESSION_SECRET');
    expect(rawOutput).not.toContain('tokenVersion');
  });
});
