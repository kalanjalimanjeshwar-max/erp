import { describe, it, expect, vi, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { AuthService, SessionPayload } from '../../src/server/services/auth.service.js';
import { prisma } from '../../src/server/db/client.js';

// Mock only the Prisma methods required by the auth security unit tests
vi.mock('../../src/server/db/client.js', () => ({
  prisma: {
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
    },
  },
}));

describe('Phase 3 Authentication, Passwords & Session Security Tests', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

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

  describe('SEC-1: Session Provenance Binding to Cryptographically Verified Payloads', () => {
    const mockDbUser = {
      id: 'user-sec1-super',
      companyId: 'company-sec1-1',
      email: 'super@sec1.local',
      fullName: 'SEC1 Super Admin',
      role: 'SUPER_ADMIN' as const,
      isActive: true,
      lastLoginAt: new Date('2026-11-23T04:00:00.000Z'),
      tokenVersion: 1,
    };

    it('rejects caller-fabricated SessionPayload literals without touching DB or minting provenance', async () => {
      const findUniqueMock = vi.mocked(prisma.user.findUnique);
      findUniqueMock.mockResolvedValue(mockDbUser as any);

      const fabricatedPayload: SessionPayload = {
        userId: mockDbUser.id,
        companyId: mockDbUser.companyId,
        email: mockDbUser.email,
        role: 'SUPER_ADMIN',
        tokenVersion: 1,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const user = await AuthService.validateSessionUser(fabricatedPayload);
      expect(user).toBeNull();
      expect(findUniqueMock).not.toHaveBeenCalled();
      expect(AuthService.getAuthenticatedActorProvenance(user)).toBeNull();
    });

    it('mints server-provenanced AuthUser from verifySessionToken() once and rejects replay on second call', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(mockDbUser.lastLoginAt);

      const findUniqueMock = vi.mocked(prisma.user.findUnique);
      findUniqueMock.mockResolvedValue(mockDbUser as any);

      const token = AuthService.generateSessionToken({
        userId: mockDbUser.id,
        companyId: mockDbUser.companyId,
        email: mockDbUser.email,
        role: mockDbUser.role,
        tokenVersion: mockDbUser.tokenVersion,
      });

      const verifiedPayload = AuthService.verifySessionToken(token);
      expect(verifiedPayload).not.toBeNull();
      expect(Object.isFrozen(verifiedPayload)).toBe(true);

      // First validation succeeds and mints frozen provenanced AuthUser
      const authUser = await AuthService.validateSessionUser(verifiedPayload!);
      expect(authUser).not.toBeNull();
      expect(Object.isFrozen(authUser)).toBe(true);
      expect(authUser).toEqual({
        id: mockDbUser.id,
        userId: mockDbUser.id,
        companyId: mockDbUser.companyId,
        email: mockDbUser.email,
        fullName: mockDbUser.fullName,
        role: 'SUPER_ADMIN',
        isActive: true,
        lastLoginAt: mockDbUser.lastLoginAt.toISOString(),
        tokenVersion: 1,
      });
      expect(AuthService.getAuthenticatedActorProvenance(authUser)).toEqual({
        userId: mockDbUser.id,
        companyId: mockDbUser.companyId,
        role: 'SUPER_ADMIN',
        tokenVersion: 1,
        isActive: true,
        isPreview: false,
        authenticatedAtMs: mockDbUser.lastLoginAt.getTime(),
        source: 'SESSION_VALIDATION',
      });
      expect(findUniqueMock).toHaveBeenCalledTimes(1);

      // Replaying the exact same verified payload object MUST fail closed (single-use consumption)
      const replayedUser = await AuthService.validateSessionUser(verifiedPayload!);
      expect(replayedUser).toBeNull();
      expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });

    it('rejects cloned or mutated copies of a verified SessionPayload', async () => {
      const findUniqueMock = vi.mocked(prisma.user.findUnique);
      findUniqueMock.mockResolvedValue(mockDbUser as any);

      const token = AuthService.generateSessionToken({
        userId: mockDbUser.id,
        companyId: mockDbUser.companyId,
        email: mockDbUser.email,
        role: 'ADMIN',
        tokenVersion: 1,
      });

      const verifiedPayload = AuthService.verifySessionToken(token)!;

      // Direct in-place mutation throws because verifiedPayload is frozen
      expect(() => {
        (verifiedPayload as { role: string }).role = 'SUPER_ADMIN';
      }).toThrow(TypeError);

      // Shallow clone & modified clone are NOT registered in verifiedSessionPayloadRegistry
      const shallowClone: SessionPayload = { ...verifiedPayload };
      const escalatedClone: SessionPayload = { ...verifiedPayload, role: 'SUPER_ADMIN' };

      expect(await AuthService.validateSessionUser(shallowClone)).toBeNull();
      expect(await AuthService.validateSessionUser(escalatedClone)).toBeNull();
      expect(findUniqueMock).not.toHaveBeenCalled();
    });

    it('re-checks exp against server clock inside validateSessionUser() and rejects expired verified payloads', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-23T04:00:00.000Z'));

      const findUniqueMock = vi.mocked(prisma.user.findUnique);
      findUniqueMock.mockResolvedValue(mockDbUser as any);

      const token = AuthService.generateSessionToken({
        userId: mockDbUser.id,
        companyId: mockDbUser.companyId,
        email: mockDbUser.email,
        role: mockDbUser.role,
        tokenVersion: mockDbUser.tokenVersion,
      });

      const verifiedPayload = AuthService.verifySessionToken(token)!;
      expect(verifiedPayload).not.toBeNull();

      // Advance clock past the verified payload's exp timestamp before calling validateSessionUser()
      const msUntilAfterExp = (verifiedPayload.exp - Math.floor(Date.now() / 1000) + 5) * 1000;
      vi.advanceTimersByTime(msUntilAfterExp);

      const expiredResult = await AuthService.validateSessionUser(verifiedPayload);
      expect(expiredResult).toBeNull();
      expect(findUniqueMock).not.toHaveBeenCalled();
    });

    it('preserves logout fallback verification while denying AuthUser provenance for inactive/revoked users', async () => {
      const findUniqueMock = vi.mocked(prisma.user.findUnique);
      findUniqueMock.mockResolvedValue({
        ...mockDbUser,
        tokenVersion: 2, // Revoked session
      } as any);

      const token = AuthService.generateSessionToken({
        userId: mockDbUser.id,
        companyId: mockDbUser.companyId,
        email: mockDbUser.email,
        role: mockDbUser.role,
        tokenVersion: 1,
      });

      const verifiedPayload = AuthService.verifySessionToken(token);
      expect(verifiedPayload).not.toBeNull();
      expect(verifiedPayload?.userId).toBe(mockDbUser.id);

      const authUser = await AuthService.validateSessionUser(verifiedPayload!);
      expect(authUser).toBeNull();
      expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });

    describe('P2-1: Session Expiry TOCTOU Protection Across Async DB Lookup', () => {
      it('rejects a session that was valid before prisma.user.findUnique() but expired while the DB query was pending, without minting provenance', async () => {
        vi.useFakeTimers();
        const issuedAt = new Date('2026-11-23T04:00:00.000Z');
        vi.setSystemTime(issuedAt);

        const token = AuthService.generateSessionToken({
          userId: mockDbUser.id,
          companyId: mockDbUser.companyId,
          email: mockDbUser.email,
          role: mockDbUser.role,
          tokenVersion: mockDbUser.tokenVersion,
        });

        const verifiedPayload = AuthService.verifySessionToken(token)!;
        expect(verifiedPayload).not.toBeNull();

        // Advance clock to 2 seconds before expiration so pre-query check succeeds
        const preQueryTimeMs = (verifiedPayload.exp - 2) * 1000;
        vi.setSystemTime(preQueryTimeMs);

        let resolveDbLookup!: (value: unknown) => void;
        const pendingDbLookup = new Promise((resolve) => {
          resolveDbLookup = resolve;
        });

        const findUniqueMock = vi.mocked(prisma.user.findUnique);
        findUniqueMock.mockImplementationOnce(() => pendingDbLookup as any);

        const weakMapSetSpy = vi.spyOn(WeakMap.prototype, 'set');
        try {
          const validationPromise = AuthService.validateSessionUser(verifiedPayload);
          expect(findUniqueMock).toHaveBeenCalledTimes(1);

          // Advance clock past exact expiry boundary while the DB lookup is still in flight
          vi.advanceTimersByTime(2000);
          expect(Math.floor(Date.now() / 1000)).toBe(verifiedPayload.exp);

          resolveDbLookup(mockDbUser);
          const result = await validationPromise;

          expect(result).toBeNull();
          expect(AuthService.getAuthenticatedActorProvenance(result)).toBeNull();

          const mintedProvenanceCalls = weakMapSetSpy.mock.calls.filter(
            ([, value]) =>
              value !== null &&
              typeof value === 'object' &&
              (value as { source?: string }).source === 'SESSION_VALIDATION'
          );
          expect(mintedProvenanceCalls).toHaveLength(0);
        } finally {
          weakMapSetSpy.mockRestore();
        }
      });

      it('accepts a session and mints provenance when it remains valid after a delayed prisma.user.findUnique() lookup', async () => {
        vi.useFakeTimers();
        const issuedAt = new Date('2026-11-23T04:00:00.000Z');
        vi.setSystemTime(issuedAt);

        const token = AuthService.generateSessionToken({
          userId: mockDbUser.id,
          companyId: mockDbUser.companyId,
          email: mockDbUser.email,
          role: mockDbUser.role,
          tokenVersion: mockDbUser.tokenVersion,
        });

        const verifiedPayload = AuthService.verifySessionToken(token)!;
        expect(verifiedPayload).not.toBeNull();

        // Advance clock to 5 seconds before expiration
        const preQueryTimeMs = (verifiedPayload.exp - 5) * 1000;
        vi.setSystemTime(preQueryTimeMs);

        let resolveDbLookup!: (value: unknown) => void;
        const pendingDbLookup = new Promise((resolve) => {
          resolveDbLookup = resolve;
        });

        const findUniqueMock = vi.mocked(prisma.user.findUnique);
        findUniqueMock.mockImplementationOnce(() => pendingDbLookup as any);

        const validationPromise = AuthService.validateSessionUser(verifiedPayload);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);

        // Advance clock by 4 seconds while DB lookup is pending (1 second before expiry — still valid)
        vi.advanceTimersByTime(4000);
        expect(Math.floor(Date.now() / 1000)).toBe(verifiedPayload.exp - 1);

        resolveDbLookup(mockDbUser);
        const authUser = await validationPromise;

        expect(authUser).not.toBeNull();
        expect(Object.isFrozen(authUser)).toBe(true);
        expect(authUser?.id).toBe(mockDbUser.id);
        expect(AuthService.getAuthenticatedActorProvenance(authUser)).toEqual({
          userId: mockDbUser.id,
          companyId: mockDbUser.companyId,
          role: 'SUPER_ADMIN',
          tokenVersion: 1,
          isActive: true,
          isPreview: false,
          authenticatedAtMs: (verifiedPayload.exp - 1) * 1000,
          source: 'SESSION_VALIDATION',
        });
      });
    });
  });
});

