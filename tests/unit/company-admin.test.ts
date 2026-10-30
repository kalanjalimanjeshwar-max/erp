import { describe, it, expect } from 'vitest';
import { CompanyService } from '../../src/server/services/company.service.js';
import { AuthUser } from '../../src/shared/types.ts';

describe('Company Administration & Logo Security Tests', () => {
  const actor: AuthUser = {
    id: 'user-admin-1',
    userId: 'user-admin-1',
    companyId: 'company-uuid-1',
    email: 'admin@corp.local',
    fullName: 'Corporate Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  it('should reject dangerous javascript: or data: URIs in logoUrl', async () => {
    // Malicious XSS vector in logo URL
    await expect(
      CompanyService.updateProfile(actor, {
        name: 'Safe Corp',
        timezone: 'UTC',
        currency: 'USD',
        logoUrl: 'javascript:alert(document.cookie)',
      })
    ).rejects.toThrowError(/Invalid logo URL|Dangerous URL scheme/);

    await expect(
      CompanyService.updateProfile(actor, {
        name: 'Safe Corp',
        timezone: 'UTC',
        currency: 'USD',
        logoUrl: 'data:text/html;base64,PHNjcmlwdD4=',
      })
    ).rejects.toThrowError(/Invalid logo URL|Dangerous URL scheme/);
  });

  it('should accept valid HTTPS URLs or clean relative asset paths for logo', async () => {
    // We test that validation passes before hitting the database
    // (In offline unit test without live DB, Prisma error indicates validation succeeded)
    try {
      await CompanyService.updateProfile(actor, {
        name: 'Safe Corp',
        timezone: 'UTC',
        currency: 'USD',
        logoUrl: 'https://images.example.com/branding/logo.png',
      });
    } catch (err: unknown) {
      // Must not fail with URL validation error
      expect((err as Error).message).not.toMatch(/Invalid logo URL|Dangerous URL scheme/);
    }

    try {
      await CompanyService.updateProfile(actor, {
        name: 'Safe Corp',
        timezone: 'UTC',
        currency: 'USD',
        logoUrl: '/assets/logos/corporate-header.png',
      });
    } catch (err: unknown) {
      // Must not fail with URL validation error
      expect((err as Error).message).not.toMatch(/Invalid logo URL|Dangerous URL scheme/);
    }
  });
});
