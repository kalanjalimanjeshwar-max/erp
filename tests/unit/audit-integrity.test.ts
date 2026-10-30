import { describe, it, expect } from 'vitest';
import { sanitizeAuditMetadata, AuditService } from '../../src/server/services/audit.service.js';

describe('Audit Log Integrity & Safe Metadata Tests', () => {
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
