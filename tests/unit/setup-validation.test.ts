import { describe, it, expect } from 'vitest';
import { initialSetupSchema } from '../../src/server/validation/setup.schema.js';

describe('Setup Validation Schema Unit Tests', () => {
  it('should accept valid company and super admin data', () => {
    const validData = {
      company: {
        name: 'Apex Industrial Solutions',
        code: 'apex',
        currency: 'USD',
        timezone: 'UTC',
      },
      superAdmin: {
        fullName: 'Alex Miller',
        email: 'alex@apex-solutions.com',
        password: 'ValidPassword123!',
        confirmPassword: 'ValidPassword123!',
      },
    };

    const parsed = initialSetupSchema.parse(validData);
    expect(parsed.company.code).toBe('APEX'); // uppercase transform
    expect(parsed.company.currency).toBe('USD');
  });

  it('should reject weak passwords without special characters or uppercase', () => {
    const invalidData = {
      company: {
        name: 'Apex Solutions',
        code: 'APEX',
      },
      superAdmin: {
        fullName: 'Alex Miller',
        email: 'alex@apex.com',
        password: 'weakpassword',
        confirmPassword: 'weakpassword',
      },
    };

    const result = initialSetupSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject mismatched passwords', () => {
    const mismatched = {
      company: {
        name: 'Apex Solutions',
        code: 'APEX',
      },
      superAdmin: {
        fullName: 'Alex Miller',
        email: 'alex@apex.com',
        password: 'ValidPassword123!',
        confirmPassword: 'DifferentPassword123!',
      },
    };

    const result = initialSetupSchema.safeParse(mismatched);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('Passwords do not match'))).toBe(true);
    }
  });

  it('should reject empty company names or invalid codes', () => {
    const invalid = {
      company: {
        name: '',
        code: 'INVALID CODE WITH SPACES',
      },
      superAdmin: {
        fullName: 'Alex Miller',
        email: 'alex@apex.com',
        password: 'ValidPassword123!',
        confirmPassword: 'ValidPassword123!',
      },
    };

    const result = initialSetupSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
