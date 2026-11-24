import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeAuditMetadata, AuditService } from '../../src/server/services/audit.service.js';
import { prisma } from '../../src/server/db/client.js';

describe('Audit Log Integrity & Safe Metadata Tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should deeply redact sensitive passwords, hashes, tokens and secrets', () => {
    const rawMetadata = {
      ip: '192.168.1.100',
      action: 'USER_PASSWORD_CHANGE',
      user: {
        id: 'user-123',
        email: 'admin@corp.local',
        password: 'SuperSecretPassword123!',
        passwordHash: '$2a$12$e8Y5l...',
        token: 'eyJhGciOiJIUzI1NiIsIn...',
      },
      securityContext: {
        bridgeToken: 'lan_bridge_secret_999',
        apiKey: 'ai_studio_api_key_xxx',
        sessionSecret: 'super_secret_cookie_key',
        creditCard: '4111-2222-3333-4444',
      },
      directSecret: 'top_secret_val',
      safeDetails: {
        reason: 'Periodic security rotation',
        status: 'SUCCESS',
      },
    };

    const sanitized = sanitizeAuditMetadata(rawMetadata) as Record<string, unknown>;

    // Ensure safe details are preserved
    expect(sanitized.ip).toBe('192.168.1.100');
    expect(sanitized.action).toBe('USER_PASSWORD_CHANGE');
    const safeDetails = sanitized.safeDetails as Record<string, unknown>;
    expect(safeDetails.reason).toBe('Periodic security rotation');
    expect(safeDetails.status).toBe('SUCCESS');

    // Ensure sensitive fields are strictly redacted
    const user = sanitized.user as Record<string, unknown>;
    expect(user.password).toBe('[REDACTED]');
    expect(user.passwordHash).toBe('[REDACTED]');
    expect(user.token).toBe('[REDACTED]');

    const sec = sanitized.securityContext as Record<string, unknown>;
    expect(sec.bridgeToken).toBe('[REDACTED]');
    expect(sec.apiKey).toBe('[REDACTED]');
    expect(sec.sessionSecret).toBe('[REDACTED]');
    expect(sec.creditCard).toBe('[REDACTED]');
    expect(sanitized.directSecret).toBe('[REDACTED]');
  });

  it('AUDIT-1: preserves authorizedAt in sanitizeAuditMetadata() and persisted AuditService.log() JSON while redacting auth credentials and secrets', async () => {
    const authorizedAtIso = '2026-11-23T04:00:00.000Z';
    const rawDetails = {
      companyId: 'company-uuid-1',
      actorUserId: 'user-super-1',
      actorRole: 'SUPER_ADMIN',
      authorizedAt: authorizedAtIso,
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret',
      authHeader: 'Basic dXNlcjpwYXNz',
      authToken: 'tok_live_secret_123',
      auth: 'raw-auth-credential',
      cookie: 'coreerp_session=abc123',
      sessionId: 'sess-secret-999',
      password: 'PlainPassword123!',
      nested: {
        authorizedAt: 'postgresql://dbuser:pw123@localhost:5432/core_erp',
        privateKey: '-----BEGIN PRIVATE KEY-----',
      },
    };

    const sanitized = sanitizeAuditMetadata(rawDetails) as Record<string, any>;
    expect(sanitized.authorizedAt).toBe(authorizedAtIso);
    expect(sanitized.authorization).toBe('[REDACTED]');
    expect(sanitized.authHeader).toBe('[REDACTED]');
    expect(sanitized.authToken).toBe('[REDACTED]');
    expect(sanitized.auth).toBe('[REDACTED]');
    expect(sanitized.cookie).toBe('[REDACTED]');
    expect(sanitized.sessionId).toBe('[REDACTED]');
    expect(sanitized.password).toBe('[REDACTED]');
    // Even allowlisted keys still have embedded DB credentials scrubbed
    expect(sanitized.nested.authorizedAt).toBe('postgresql://***:***@localhost:5432/core_erp');
    expect(sanitized.nested.privateKey).toBe('[REDACTED]');

    // Exercise the real AuditService.log() -> prisma.auditLog.create() JSON persistence path
    let persistedCreateArg: any = null;
    const createSpy = vi
      .spyOn(prisma.auditLog, 'create')
      .mockImplementation((async (args: any) => {
        persistedCreateArg = args;
        return { id: 'audit-1', ...args.data };
      }) as any);

    await AuditService.log({
      companyId: 'company-uuid-1',
      userId: 'user-super-1',
      action: 'BIOMETRIC_HISTORICAL_RECONCILE',
      entity: 'RawPunchLog',
      entityId: 'term-1',
      details: rawDetails,
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(typeof persistedCreateArg?.data?.details).toBe('string');
    const persistedJson = JSON.parse(persistedCreateArg.data.details);
    expect(persistedJson.authorizedAt).toBe(authorizedAtIso);
    expect(persistedJson.authorization).toBe('[REDACTED]');
    expect(persistedJson.authHeader).toBe('[REDACTED]');
    expect(persistedJson.authToken).toBe('[REDACTED]');
    expect(persistedJson.auth).toBe('[REDACTED]');
    expect(persistedJson.cookie).toBe('[REDACTED]');
    expect(persistedJson.password).toBe('[REDACTED]');
    expect(persistedJson.nested.privateKey).toBe('[REDACTED]');
  });

  it('should sanitize credentials embedded inside database connection strings', () => {
    const stringData = 'Failed connecting to postgresql://dbuser:super_secret_pw@localhost:5432/core_erp';
    const sanitized = sanitizeAuditMetadata(stringData);

    expect(sanitized).not.toContain('super_secret_pw');
    expect(sanitized).toContain('postgresql://***:***@localhost:5432/core_erp');
  });

  it('should enforce minimum 90-day retention window on audit purges', async () => {
    await expect(
      AuditService.purgeExpiredLogs('company-uuid-1', 30)
    ).rejects.toThrowError(/at least 90 days/);

    await expect(
      AuditService.purgeExpiredLogs('', 180)
    ).rejects.toThrowError(/companyId is required/);
  });

  it('should require companyId when querying company audit logs', async () => {
    await expect(
      AuditService.getCompanyAuditLogs('')
    ).rejects.toThrowError(/companyId is mandatory/);
  });
});
