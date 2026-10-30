import { describe, it, expect } from 'vitest';
import { validateEnv, sanitizeDatabaseUrl } from '../../src/server/config/env.js';

describe('Environment Validation Unit Tests', () => {
  it('should successfully validate complete valid PostgreSQL environment', () => {
    const validConfig = validateEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://erp_user:secret_pass123@localhost:5432/core_erp?schema=public',
      SESSION_SECRET: 'super_secret_session_key_32_characters_minimum',
    });

    expect(validConfig.NODE_ENV).toBe('test');
    expect(validConfig.PORT).toBe(3000);
    expect(validConfig.DATABASE_URL).toContain('postgresql://');
  });

  it('should reject missing DATABASE_URL with clear actionable message', () => {
    expect(() => {
      validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: '',
      });
    }).toThrowError(/DATABASE_URL is required/);

    expect(() => {
      validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: undefined,
      });
    }).toThrowError(/DATABASE_URL/);
  });

  it('should strictly reject non-PostgreSQL database URLs (no sqlite/mysql fallbacks)', () => {
    expect(() => {
      validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'file:./local-dev.db',
      });
    }).toThrowError(/Only PostgreSQL is supported|DATABASE_URL must be a valid PostgreSQL/);

    expect(() => {
      validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'mysql://root:pass@localhost:3306/erp',
      });
    }).toThrowError(/DATABASE_URL must be a valid PostgreSQL connection string/);
  });

  it('should reject invalid ports', () => {
    expect(() => {
      validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        PORT: '99999',
      });
    }).toThrowError(/PORT must be a valid integer between 1 and 65535/);
  });

  it('should sanitize credentials from database URLs for safe logging', () => {
    const raw = 'postgresql://admin_user:super_secret_p%40ss@db.internal:5432/production_erp';
    const sanitized = sanitizeDatabaseUrl(raw);

    expect(sanitized).not.toContain('super_secret_p%40ss');
    expect(sanitized).toBe('postgresql://admin_user:*****@db.internal:5432/production_erp');
  });

  describe('Production Security Requirements (Phase 7.6)', () => {
    it('should reject known development placeholder secrets in production mode', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://erp_prod:prod_pass@db.internal:5432/core_erp',
          SESSION_SECRET: 'dev_session_secret_min_32_characters_long_for_security',
        });
      }).toThrowError(/SESSION_SECRET cannot use a known development placeholder/);

      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://erp_prod:prod_pass@db.internal:5432/core_erp',
          SESSION_SECRET: 'replace_with_64_character_cryptographically_secure_random_string',
        });
      }).toThrowError(/SESSION_SECRET cannot use a known development placeholder/);
    });

    it('should reject short session secrets in production mode (<32 characters)', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://erp_prod:prod_pass@db.internal:5432/core_erp',
          SESSION_SECRET: 'short_secret_under_32_chars',
        });
      }).toThrowError(/SESSION_SECRET must be at least 32 characters long/);
    });

    it('should accept strong, unique secrets in production mode (>=32 characters)', () => {
      const prodConfig = validateEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://erp_prod:prod_pass@db.internal:5432/core_erp',
        SESSION_SECRET: 'c8f49b1368a27e059f13e7168d8cb5164d781b0a5381fbc947e2a9b3c4d5e6f7',
      });

      expect(prodConfig.NODE_ENV).toBe('production');
      expect(prodConfig.SESSION_SECRET).toBe('c8f49b1368a27e059f13e7168d8cb5164d781b0a5381fbc947e2a9b3c4d5e6f7');
    });

    it('should strictly reject missing or omitted session secret in production mode', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://erp_prod:prod_pass@db.internal:5432/core_erp',
          // SESSION_SECRET omitted
        });
      }).toThrowError(/SESSION_SECRET is strictly required and cannot use the development fallback/);

      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://erp_prod:prod_pass@db.internal:5432/core_erp',
          SESSION_SECRET: '',
        });
      }).toThrowError(/SESSION_SECRET is strictly required/);
    });

    it('should reject previous docker-compose placeholder secret in production mode', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://erp_prod:prod_pass@db.internal:5432/core_erp',
          SESSION_SECRET: 'a_secure_random_production_secret_key_64_characters_min',
        });
      }).toThrowError(/SESSION_SECRET cannot use a known development placeholder/);
    });

    it('should continue permitting development session secrets when NODE_ENV is development', () => {
      const devConfig = validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://erp_user:pass@localhost:5432/core_erp',
        SESSION_SECRET: 'dev_session_secret_min_32_characters_long_for_security',
      });

      expect(devConfig.NODE_ENV).toBe('development');
      expect(devConfig.SESSION_SECRET).toBe('dev_session_secret_min_32_characters_long_for_security');
    });

    it('should verify docker-compose.yml enforces explicit SESSION_SECRET and dedicated migration runner', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const composePath = path.resolve(import.meta.dirname, '../../docker-compose.yml');
      const composeContent = fs.readFileSync(composePath, 'utf-8');

      // Verifies no insecure fallback for SESSION_SECRET
      expect(composeContent).not.toContain('SESSION_SECRET:-a_secure_random_production_secret_key_64_characters_min');
      expect(composeContent).toContain('SESSION_SECRET: ${SESSION_SECRET:?');

      // Verifies dedicated one-shot migration service and dependency ordering
      expect(composeContent).toContain('coreerp-migration');
      expect(composeContent).toContain('command: ["npx", "prisma", "migrate", "deploy"]');
      expect(composeContent).toContain('condition: service_completed_successfully');
    });

    it('should verify biometric bridge README documents correct endpoint and stub limitations', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const bridgeReadmePath = path.resolve(import.meta.dirname, '../../services/biometric-bridge/README.md');
      const readmeContent = fs.readFileSync(bridgeReadmePath, 'utf-8');

      // Verifies correct endpoint
      expect(readmeContent).toContain('POST /api/biometric/punches');
      expect(readmeContent).not.toContain('POST /api/attendance/punches');

      // Verifies explicit stub and physical hardware limitation documentation
      expect(readmeContent).toContain('NOT YET a working physical ZKTeco socket driver');
      expect(readmeContent).toContain('Zero physical device or live hardware verification has been performed');
    });
  });
});
