import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateEnv,
  sanitizeDatabaseUrl,
  getConfig,
  resetConfigForTesting,
} from '../../src/server/config/env.js';
import { AuthService } from '../../src/server/services/auth.service.js';

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
        BANK_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      });

      expect(prodConfig.NODE_ENV).toBe('production');
      expect(prodConfig.SESSION_SECRET).toBe('c8f49b1368a27e059f13e7168d8cb5164d781b0a5381fbc947e2a9b3c4d5e6f7');
      expect(prodConfig.BANK_ENCRYPTION_KEY).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    });

    it('should fail closed in production when BANK_ENCRYPTION_KEY is missing or invalid', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://erp_prod:prod_pass@db.internal:5432/core_erp',
          SESSION_SECRET: 'c8f49b1368a27e059f13e7168d8cb5164d781b0a5381fbc947e2a9b3c4d5e6f7',
          // BANK_ENCRYPTION_KEY omitted
        });
      }).toThrowError(/BANK_ENCRYPTION_KEY is strictly required/);

      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://erp_prod:prod_pass@db.internal:5432/core_erp',
          SESSION_SECRET: 'c8f49b1368a27e059f13e7168d8cb5164d781b0a5381fbc947e2a9b3c4d5e6f7',
          BANK_ENCRYPTION_KEY: 'invalid_short_key',
        });
      }).toThrowError(/BANK_ENCRYPTION_KEY must be exactly 64 hexadecimal characters/);
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
      const YAML = (await import('yaml')).default;
      const composePath = path.resolve(import.meta.dirname, '../../docker-compose.yml');
      const composeContent = fs.readFileSync(composePath, 'utf-8');
      const composeDoc = YAML.parse(composeContent);

      // Verifies no insecure fallback for SESSION_SECRET and fail-closed syntax properly quoted
      expect(composeContent).not.toContain('SESSION_SECRET:-a_secure_random_production_secret_key_64_characters_min');
      expect(composeContent).toContain('SESSION_SECRET: "${SESSION_SECRET:?');

      // Verifies dedicated one-shot migration service uses explicit migration profile
      expect(composeContent).toContain('coreerp-migration');
      expect(composeContent).toContain('command: ["npx", "prisma", "migrate", "deploy"]');
      expect(composeDoc.services.migration.profiles).toEqual(['migration']);

      // Verifies ordinary app startup depends on healthy postgres only and does not auto-run migration
      expect(composeDoc.services.app.depends_on).toEqual({
        postgres: { condition: 'service_healthy' },
      });
      expect(composeDoc.services.app.depends_on.migration).toBeUndefined();
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

    it('should accept valid BANK_ACTIVE_KEY_ID and valid BANK_HISTORICAL_KEYS JSON', () => {
      const validConfig = validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://erp_user:pass@localhost:5432/core_erp',
        BANK_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        BANK_ACTIVE_KEY_ID: 'k2',
        BANK_HISTORICAL_KEYS: JSON.stringify({
          k1: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          k0: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        }),
      });

      expect(validConfig.BANK_ACTIVE_KEY_ID).toBe('k2');
      expect(validConfig.BANK_HISTORICAL_KEYS).toBeDefined();
    });

    it('should reject malformed JSON in BANK_HISTORICAL_KEYS', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://erp_user:pass@localhost:5432/core_erp',
          BANK_HISTORICAL_KEYS: 'not-json-{{{',
        });
      }).toThrowError(/BANK_HISTORICAL_KEYS must be a valid JSON object/);
    });

    it('should reject invalid historical key hex material length or format', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://erp_user:pass@localhost:5432/core_erp',
          BANK_HISTORICAL_KEYS: JSON.stringify({
            k1: 'too-short',
          }),
        });
      }).toThrowError(/must be a 64-character hexadecimal string/);
    });

    it('should reject conflict when historical key ID matches active key ID with different key material', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://erp_user:pass@localhost:5432/core_erp',
          BANK_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          BANK_ACTIVE_KEY_ID: 'k1',
          BANK_HISTORICAL_KEYS: JSON.stringify({
            k1: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          }),
        });
      }).toThrowError(/conflicts with BANK_ACTIVE_KEY_ID but contains different key material/);
    });
  });

  describe('Integration-Test Mode Environment Validation', () => {
    const validIntegrationUrl =
      'postgresql://erp_integration_user:super_secret_int_pw_987@localhost:5434/core_erp_integration_test?schema=public';
    const validSessionSecret =
      'c8f49b1368a27e059f13e7168d8cb5164d781b0a5381fbc947e2a9b3c4d5e6f7';
    const validBankKey =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      savedEnv = { ...process.env };
      resetConfigForTesting();
    });

    afterEach(() => {
      process.env = { ...savedEnv };
      resetConfigForTesting();
    });

    it('accepts valid integration-test configuration with DATABASE_URL unset (localhost and 127.0.0.1)', () => {
      const localhostConfig = validateEnv({
        NODE_ENV: 'test',
        COREERP_INTEGRATION_TEST_MODE: 'true',
        DATABASE_URL: undefined,
        TEST_DATABASE_URL: ` "${validIntegrationUrl}" `,
        SESSION_SECRET: validSessionSecret,
      });

      expect(localhostConfig.NODE_ENV).toBe('test');
      expect(localhostConfig.DATABASE_URL).toBeUndefined();
      expect(localhostConfig.TEST_DATABASE_URL).toBe(validIntegrationUrl);

      const loopbackUrl =
        'postgres://erp_integration_user:another_secret@127.0.0.1:5434/core_erp_integration_test';
      const loopbackConfig = validateEnv({
        NODE_ENV: 'test',
        COREERP_INTEGRATION_TEST_MODE: 'true',
        DATABASE_URL: undefined,
        TEST_DATABASE_URL: loopbackUrl,
        SESSION_SECRET: validSessionSecret,
      });

      expect(loopbackConfig.DATABASE_URL).toBeUndefined();
      expect(loopbackConfig.TEST_DATABASE_URL).toBe(loopbackUrl);
    });

    it('rejects missing or empty TEST_DATABASE_URL in integration mode', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'test',
          COREERP_INTEGRATION_TEST_MODE: 'true',
          DATABASE_URL: undefined,
          TEST_DATABASE_URL: undefined,
          SESSION_SECRET: validSessionSecret,
        });
      }).toThrowError(/TEST_DATABASE_URL is required/);

      expect(() => {
        validateEnv({
          NODE_ENV: 'test',
          COREERP_INTEGRATION_TEST_MODE: 'true',
          DATABASE_URL: undefined,
          TEST_DATABASE_URL: '   ',
          SESSION_SECRET: validSessionSecret,
        });
      }).toThrowError(/TEST_DATABASE_URL is required/);
    });

    it('rejects wrong port, host, protocol, database name, or malformed TEST_DATABASE_URL without exposing credentials', () => {
      const secretToken = 'never_leak_this_integration_secret_42';
      const invalidCases: Array<{ url: string; expectedPattern: RegExp }> = [
        {
          url: `postgresql://erp_integration_user:${secretToken}@localhost:5432/core_erp_integration_test`,
          expectedPattern: /port 5434/,
        },
        {
          url: `postgresql://erp_integration_user:${secretToken}@localhost:5433/core_erp_integration_test`,
          expectedPattern: /port 5434/,
        },
        {
          url: `postgresql://erp_integration_user:${secretToken}@localhost/core_erp_integration_test`,
          expectedPattern: /port 5434/,
        },
        {
          url: `postgresql://erp_integration_user:${secretToken}@db.prod.internal:5434/core_erp_integration_test`,
          expectedPattern: /localhost or 127\.0\.0\.1/,
        },
        {
          url: `mysql://erp_integration_user:${secretToken}@localhost:5434/core_erp_integration_test`,
          expectedPattern: /PostgreSQL protocol/,
        },
        {
          url: `file:./${secretToken}.db`,
          expectedPattern: /PostgreSQL protocol/,
        },
        {
          url: `not-a-valid-url-${secretToken}`,
          expectedPattern: /valid PostgreSQL connection string/,
        },
        {
          url: `postgresql://erp_integration_user:${secretToken}@localhost:5434/core_erp`,
          expectedPattern: /core_erp_integration_test/,
        },
        {
          url: `postgresql://erp_integration_user:${secretToken}@localhost:5434/core_erp_test`,
          expectedPattern: /core_erp_integration_test/,
        },
      ];

      for (const { url, expectedPattern } of invalidCases) {
        let caughtMessage = '';
        try {
          validateEnv({
            NODE_ENV: 'test',
            COREERP_INTEGRATION_TEST_MODE: 'true',
            DATABASE_URL: undefined,
            TEST_DATABASE_URL: url,
            SESSION_SECRET: validSessionSecret,
          });
        } catch (err) {
          caughtMessage = err instanceof Error ? err.message : String(err);
        }

        expect(caughtMessage).toMatch(expectedPattern);
        expect(caughtMessage).not.toContain(secretToken);
      }
    });

    it('rejects conflicting non-empty DATABASE_URL in integration mode', () => {
      const secretPw = 'split_brain_secret_pw_999';
      let caughtMessage = '';
      try {
        validateEnv({
          NODE_ENV: 'test',
          COREERP_INTEGRATION_TEST_MODE: 'true',
          DATABASE_URL: `postgresql://erp_user:${secretPw}@localhost:5432/core_erp`,
          TEST_DATABASE_URL: validIntegrationUrl,
          SESSION_SECRET: validSessionSecret,
        });
      } catch (err) {
        caughtMessage = err instanceof Error ? err.message : String(err);
      }

      expect(caughtMessage).toMatch(/Conflicting DATABASE_URL detected in integration test mode/);
      expect(caughtMessage).not.toContain(secretPw);
    });

    it('rejects missing DATABASE_URL in production even if integration flag and port-5434 TEST_DATABASE_URL are set', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: undefined,
          SESSION_SECRET: validSessionSecret,
          BANK_ENCRYPTION_KEY: validBankKey,
        });
      }).toThrowError(/DATABASE_URL is required/);

      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          COREERP_INTEGRATION_TEST_MODE: 'true',
          DATABASE_URL: undefined,
          TEST_DATABASE_URL: validIntegrationUrl,
          SESSION_SECRET: validSessionSecret,
          BANK_ENCRYPTION_KEY: validBankKey,
        });
      }).toThrowError(/COREERP_INTEGRATION_TEST_MODE=true is only permitted when NODE_ENV=test/);

      expect(() => {
        validateEnv({
          NODE_ENV: 'production',
          COREERP_INTEGRATION_TEST_MODE: 'true',
          DATABASE_URL: undefined,
          TEST_DATABASE_URL: validIntegrationUrl,
          SESSION_SECRET: validSessionSecret,
          BANK_ENCRYPTION_KEY: validBankKey,
        });
      }).toThrowError(/DATABASE_URL is required/);
    });

    it('rejects COREERP_INTEGRATION_TEST_MODE=true in development mode', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'development',
          COREERP_INTEGRATION_TEST_MODE: 'true',
          DATABASE_URL: 'postgresql://erp_user:dev_pass@localhost:5432/core_erp',
          TEST_DATABASE_URL: validIntegrationUrl,
          SESSION_SECRET: validSessionSecret,
        });
      }).toThrowError(/COREERP_INTEGRATION_TEST_MODE=true is only permitted when NODE_ENV=test/);

      expect(() => {
        validateEnv({
          NODE_ENV: 'development',
          COREERP_INTEGRATION_TEST_MODE: 'true',
          DATABASE_URL: undefined,
          TEST_DATABASE_URL: validIntegrationUrl,
          SESSION_SECRET: validSessionSecret,
        });
      }).toThrowError(/DATABASE_URL is required/);
    });

    it('rejects missing DATABASE_URL in ordinary unit-test mode without integration flag even when TEST_DATABASE_URL is valid', () => {
      expect(() => {
        validateEnv({
          NODE_ENV: 'test',
          DATABASE_URL: undefined,
          TEST_DATABASE_URL: validIntegrationUrl,
          SESSION_SECRET: validSessionSecret,
        });
      }).toThrowError(/DATABASE_URL is required/);

      expect(() => {
        validateEnv({
          NODE_ENV: 'test',
          COREERP_INTEGRATION_TEST_MODE: 'false',
          DATABASE_URL: undefined,
          TEST_DATABASE_URL: validIntegrationUrl,
          SESSION_SECRET: validSessionSecret,
        });
      }).toThrowError(/DATABASE_URL is required/);
    });

    it('supports real AuthService token generation and verification in integration mode without DATABASE_URL or database access', () => {
      process.env.NODE_ENV = 'test';
      process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
      delete process.env.DATABASE_URL;
      process.env.TEST_DATABASE_URL = validIntegrationUrl;
      process.env.SESSION_SECRET = validSessionSecret;
      resetConfigForTesting();

      const config = getConfig();
      expect(config.DATABASE_URL).toBeUndefined();
      expect(config.TEST_DATABASE_URL).toBe(validIntegrationUrl);
      expect(process.env.DATABASE_URL).toBeUndefined();

      const token = AuthService.generateSessionToken({
        userId: '11111111-1111-4111-8111-111111111111',
        companyId: '22222222-2222-4222-8222-222222222222',
        email: 'employee.integration@coreerp.local',
        role: 'EMPLOYEE',
        tokenVersion: 3,
      });

      const verified = AuthService.verifySessionToken(token);
      expect(verified).not.toBeNull();
      expect(verified?.userId).toBe('11111111-1111-4111-8111-111111111111');
      expect(verified?.companyId).toBe('22222222-2222-4222-8222-222222222222');
      expect(verified?.email).toBe('employee.integration@coreerp.local');
      expect(verified?.role).toBe('EMPLOYEE');
      expect(verified?.tokenVersion).toBe(3);

      // Tampered signature must be rejected
      const [h, p, s] = token.split('.');
      const tamperedSig = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
      expect(AuthService.verifySessionToken(`${h}.${p}.${tamperedSig}`)).toBeNull();

      // Confirm DATABASE_URL was never restored or populated
      expect(process.env.DATABASE_URL).toBeUndefined();
    });

    it('forbids resetConfigForTesting in production mode', () => {
      process.env.NODE_ENV = 'production';
      expect(() => resetConfigForTesting()).toThrowError(
        /resetConfigForTesting cannot be used in production mode/
      );
    });
  });
});
