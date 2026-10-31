import { describe, it, expect, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { AuthService, SessionPayload } from '../../src/server/services/auth.service.js';

// Mock only the Prisma methods required by the failed-login rate-limit test
vi.mock('../../src/server/db/client.js', () => ({
  prisma: {
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
    },
  },
}));

describe('Phase 3 Authentication, Passwords & Session Security Tests', () => {
  it('should securely hash passwords with bcrypt and reject plaintext comparisons', async () => {
    const rawPassword = 'SecurePassword2026!';
    const hash = await bcrypt.hash(rawPassword, 12);

    expect(hash).not.toBe(rawPassword);
    expect(hash.startsWith('$2a$') || hash.startsWith('$2b$')).toBe(true);

    // Verifies valid password matches
    const isMatch = await bcrypt.compare(rawPassword, hash);
    expect(isMatch).toBe(true);

    // Rejects incorrect password
    const isWrongMatch = await bcrypt.compare('WrongPassword123!', hash);
    expect(isWrongMatch).toBe(false);
  });

  it('should generate and verify cryptographically signed HMAC session tokens', () => {
    const payload = {
      userId: 'user-uuid-1',
      companyId: 'company-uuid-1',
      email: 'admin@corp.local',
      role: 'ADMIN' as const,
      tokenVersion: 1,
    };

    const token = AuthService.generateSessionToken(payload);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);

    const verified = AuthService.verifySessionToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe(payload.userId);
    expect(verified?.companyId).toBe(payload.companyId);
    expect(verified?.role).toBe('ADMIN');
    expect(verified?.tokenVersion).toBe(1);
    expect(verified?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('should strictly reject tampered session tokens with invalid signatures', () => {
    const payload = {
      userId: 'user-uuid-1',
      companyId: 'company-uuid-1',
      email: 'admin@corp.local',
      role: 'ADMIN' as const,
      tokenVersion: 1,
    };

    const token = AuthService.generateSessionToken(payload);
    const [header, body, signature] = token.split('.');

    // Tamper with payload (elevating role to SUPER_ADMIN)
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...payload, role: 'SUPER_ADMIN', exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');

    const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

    const result = AuthService.verifySessionToken(tamperedToken);
    expect(result).toBeNull();
  });

  it('should reject expired session tokens', () => {
    // Manually create expired token
    const pastExp = Math.floor(Date.now() / 1000) - 100;
    const expiredPayload: SessionPayload = {
      userId: 'user-uuid-1',
      companyId: 'company-uuid-1',
      email: 'admin@corp.local',
      role: 'ADMIN',
      tokenVersion: 1,
      exp: pastExp,
    };

    const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');

    // Sign with config secret
    const crypto = require('crypto');
    const signature = crypto
      .createHmac('sha256', 'dev_insecure_fallback_session_secret_32_chars_long')
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    const expiredToken = `${encodedHeader}.${encodedPayload}.${signature}`;

    const result = AuthService.verifySessionToken(expiredToken);
    expect(result).toBeNull();
  });

  it('should rate-limit repeated failed login attempts after 5 consecutive failures', async () => {
    const targetEmail = 'bruteforce_target@company.local';
    const fakeIp = '10.0.0.99';

    // Attempt 5 failed logins
    for (let i = 0; i < 5; i++) {
      await expect(
        AuthService.login(targetEmail, 'wrong-password', { ipAddress: fakeIp })
      ).rejects.toThrowError(/Invalid email or password/);
    }

    // 6th attempt should be rate limited with HTTP 429 message
    await expect(
      AuthService.login(targetEmail, 'wrong-password', { ipAddress: fakeIp })
    ).rejects.toThrowError(/Too many failed login attempts/);
  });
});
