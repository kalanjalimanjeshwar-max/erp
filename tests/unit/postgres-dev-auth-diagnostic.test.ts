import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateEnv, sanitizeDatabaseUrl } from '../../src/server/config/env.js';
import {
  createPrismaClient,
  getPrismaClient,
  setPrismaClient,
  resetPrismaClientForTesting,
  verifyDatabaseUrlConsistency,
} from '../../src/server/db/client.js';
import {
  checkPostgresHealth,
  sanitizeDatabaseError,
  parseHostAndPort,
} from '../../src/server/db/health.js';
import * as healthModule from '../../src/server/db/health.js';

describe('Development PostgreSQL & Prisma Diagnostic and Readiness Verification', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    resetPrismaClientForTesting();
    process.env = { ...origEnv };
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    resetPrismaClientForTesting();
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Environment Loading Order & URL Consistency
  // ==========================================================================
  describe('1. Environment Loading Order & URL Consistency', () => {
    it('should strip surrounding quotes and whitespace from DATABASE_URL during validation', () => {
      const config = validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: ' "postgresql://erp_user:dev_password@localhost:5432/core_erp?schema=public" ',
        SESSION_SECRET: 'test_isolated_session_secret_not_for_production_min32chars',
      });

      expect(config.DATABASE_URL).toBe(
        'postgresql://erp_user:dev_password@localhost:5432/core_erp?schema=public'
      );
      expect(config.DATABASE_URL.startsWith('postgresql://')).toBe(true);
      expect(config.DATABASE_URL).not.toContain('"');
    });

    it('should verify that config DATABASE_URL and Prisma client target are identical across all components', () => {
      const targetUrl =
        'postgresql://erp_user:dev_secret_123@localhost:5432/core_erp?schema=public';
      process.env.DATABASE_URL = targetUrl;

      const client = createPrismaClient(targetUrl);
      const result = verifyDatabaseUrlConsistency(targetUrl, client);

      expect(result.consistent).toBe(true);
      expect(result.mismatches).toHaveLength(0);
      expect(result.protocolMatch).toBe(true);
      expect(result.hostMatch).toBe(true);
      expect(result.portMatch).toBe(true);
      expect(result.usernameMatch).toBe(true);
      expect(result.databaseMatch).toBe(true);
      expect(result.queryParamMatch).toBe(true);
      expect(result.credentialsMatch).toBe(true);

      // Verify sanitized targets redact credentials
      expect(result.sanitizedConfigTarget).not.toMatch(/dev_secret_123/);
      expect(result.sanitizedConfigTarget).toContain('erp_user:*****@localhost:5432/core_erp');
      expect(result.sanitizedPrismaTarget).not.toMatch(/dev_secret_123/);
    });

    it('should accurately detect mismatches in port, host, user, or credentials without leaking secrets', () => {
      const configUrl =
        'postgresql://erp_user:password_a@localhost:5432/core_erp?schema=public';
      const differentClientUrl =
        'postgresql://other_user:password_b@127.0.0.1:5433/other_db?schema=other';

      const client = createPrismaClient(differentClientUrl);
      const result = verifyDatabaseUrlConsistency(configUrl, client);

      expect(result.consistent).toBe(false);
      expect(result.mismatches).toContain('host');
      expect(result.mismatches).toContain('port');
      expect(result.mismatches).toContain('username');
      expect(result.mismatches).toContain('database');
      expect(result.mismatches).toContain('credentials');

      // Zero credential leakage
      expect(JSON.stringify(result)).not.toMatch(/password_a/);
      expect(JSON.stringify(result)).not.toMatch(/password_b/);
    });
  });

  // ==========================================================================
  // 2. Prisma Client Singleton Consistency
  // ==========================================================================
  describe('2. Prisma Client Singleton Consistency', () => {
    it('should reuse the cached singleton across calls in non-production mode', () => {
      process.env.DATABASE_URL =
        'postgresql://erp_user:dev_pass@localhost:5432/core_erp?schema=public';

      const client1 = getPrismaClient();
      const client2 = getPrismaClient();

      expect(client1).toBe(client2);
      expect(global.__prismaClient).toBe(client1);
    });

    it('should allow explicit binding of PrismaClient via setPrismaClient', () => {
      const customClient = createPrismaClient(
        'postgresql://erp_user:custom_pass@localhost:5432/core_erp?schema=public'
      );

      setPrismaClient(customClient);

      expect(getPrismaClient()).toBe(customClient);
      expect(global.__prismaClient).toBe(customClient);
    });

    it('should safely reset singleton and clear globals via resetPrismaClientForTesting', () => {
      process.env.DATABASE_URL =
        'postgresql://erp_user:dev_pass@localhost:5432/core_erp?schema=public';

      getPrismaClient();
      expect(global.__prismaClient).toBeDefined();

      resetPrismaClientForTesting();
      expect(global.__prismaClient).toBeUndefined();
    });
  });

  // ==========================================================================
  // 3. Readiness Probe & Application Client Synchronization
  // ==========================================================================
  describe('3. Readiness Probe & Application Client Synchronization', () => {
    it('should use the provided application Prisma client for query probing', async () => {
      const mockClient = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([{ alive: 1 }]),
        _engineConfig: {
          overrideDatasources: {
            db: {
              url: 'postgresql://erp_user:dev_pass@localhost:5432/core_erp?schema=public',
            },
          },
        },
      } as any;

      const health = await healthModule.checkPostgresHealth({
        client: mockClient,
        skipPortCheck: true,
      });

      expect(health.database).toBe('PostgreSQL');
      expect(health.status).toBe('connected');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(mockClient.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1 AS alive');
    });

    it('should report unconfigured when no DATABASE_URL is available', async () => {
      delete process.env.DATABASE_URL;

      const health = await checkPostgresHealth({
        client: {} as any,
        targetUrl: '',
      });

      expect(health.status).toBe('unconfigured');
      expect(health.database).toBe('PostgreSQL');
      expect(health.error).toContain('DATABASE_URL is not set');
      expect(health.category).toBe('configuration');
    });
  });

  // ==========================================================================
  // 4. Safe Error Redaction & Diagnostic Classification
  // ==========================================================================
  describe('4. Safe Error Redaction & Diagnostic Classification', () => {
    const testUrl =
      'postgresql://erp_user:super_secret_auth_token_999@localhost:5432/core_erp?schema=public';

    it('should categorize Prisma P1000 as authentication failure and redact credentials', () => {
      const prismaError = new Error(
        "Authentication failed against database server at 'localhost', the provided database credentials for 'erp_user' are not valid."
      );
      (prismaError as any).code = 'P1000';

      const result = sanitizeDatabaseError(prismaError, testUrl);

      expect(result.category).toBe('authentication');
      expect(result.code).toBe('P1000');
      expect(result.sanitizedMessage).toContain('Authentication failed');
      expect(result.sanitizedMessage).toContain('erp_user');
      expect(result.sanitizedMessage).toContain('localhost:5432');

      // Strict credential redaction (including case-insensitive 'password' check)
      expect(result.sanitizedMessage).not.toMatch(/super_secret_auth_token_999/);
      expect(result.sanitizedMessage).not.toMatch(/password/i);
    });

    it('should categorize PostgreSQL 28P01 as authentication failure', () => {
      const pgError = new Error('password authentication failed for user "erp_user"');
      (pgError as any).code = '28P01';

      const result = sanitizeDatabaseError(pgError, testUrl);

      expect(result.category).toBe('authentication');
      expect(result.code).toBe('28P01');
      expect(result.sanitizedMessage).not.toMatch(/password/i);
    });

    it('should categorize Prisma P1003 as database_not_found', () => {
      const notFoundError = new Error('Database core_erp does not exist');
      (notFoundError as any).code = 'P1003';

      const result = sanitizeDatabaseError(notFoundError, testUrl);

      expect(result.category).toBe('database_not_found');
      expect(result.code).toBe('P1003');
      expect(result.sanitizedMessage).toContain('does not exist');
      expect(result.sanitizedMessage).not.toMatch(/password/i);
    });

    it('should categorize Prisma P1001 as network unreachable', () => {
      const netError = new Error("Can't reach database server at localhost:5432");
      (netError as any).code = 'P1001';

      const result = sanitizeDatabaseError(netError, testUrl);

      expect(result.category).toBe('network');
      expect(result.code).toBe('P1001');
      expect(result.sanitizedMessage).toContain('Cannot reach PostgreSQL database server');
    });

    it('should categorize Prisma P1002 / timeout errors accurately', () => {
      const timeoutError = new Error('Connection timed out');
      (timeoutError as any).code = 'P1002';

      const result = sanitizeDatabaseError(timeoutError, testUrl);

      expect(result.category).toBe('timeout');
      expect(result.sanitizedMessage).toContain('timed out');
    });

    it('should parseHostAndPort without extracting password', () => {
      const parsed = parseHostAndPort(testUrl);
      expect(parsed.host).toBe('localhost');
      expect(parsed.port).toBe(5432);
      expect(parsed.database).toBe('core_erp');
      expect(parsed.user).toBe('erp_user');
      expect((parsed as any).password).toBeUndefined();
    });
  });

  // ==========================================================================
  // 5. Integration Database Isolation Safety
  // ==========================================================================
  describe('5. Integration Database Isolation Safety', () => {
    it('should preserve strict port 5434 requirement in COREERP_INTEGRATION_TEST_MODE', () => {
      process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
      delete process.env.DATABASE_URL;

      process.env.TEST_DATABASE_URL =
        'postgresql://erp_integration_user:secret@localhost:5432/core_erp_integration_test';

      expect(() => createPrismaClient()).toThrow(
        /Dedicated integration test must run on port 5434/
      );
    });

    it('should preserve dedicated database name requirement in integration mode', () => {
      process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
      delete process.env.DATABASE_URL;

      process.env.TEST_DATABASE_URL =
        'postgresql://erp_integration_user:secret@localhost:5434/core_erp';

      expect(() => createPrismaClient()).toThrow(
        /Unapproved database name in TEST_DATABASE_URL/
      );
    });
  });

  // ==========================================================================
  // 6. Production Database Safety & Fail-Closed Behavior
  // ==========================================================================
  describe('6. Production Database Safety & Fail-Closed Behavior', () => {
    it('should fail closed in production when SESSION_SECRET uses development fallback', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://prod_user:prod_pass@db.prod.internal:5432/core_erp',
          SESSION_SECRET: 'dev_insecure_fallback_session_secret_32_chars_long',
          BANK_ENCRYPTION_KEY:
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        })
      ).toThrow(/SESSION_SECRET is strictly required and cannot use the development fallback/);
    });

    it('should fail closed in production when BANK_ENCRYPTION_KEY is missing or invalid', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://prod_user:prod_pass@db.prod.internal:5432/core_erp',
          SESSION_SECRET: 'a_very_secure_high_entropy_production_session_secret_string_64',
          BANK_ENCRYPTION_KEY: '',
        })
      ).toThrow(/BANK_ENCRYPTION_KEY is strictly required/);

      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://prod_user:prod_pass@db.prod.internal:5432/core_erp',
          SESSION_SECRET: 'a_very_secure_high_entropy_production_session_secret_string_64',
          BANK_ENCRYPTION_KEY: 'not_a_hex_key',
        })
      ).toThrow(/must be exactly 64 hexadecimal characters/);
    });
  });
});
