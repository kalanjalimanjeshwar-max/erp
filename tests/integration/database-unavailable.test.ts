import { describe, it, expect } from 'vitest';
import {
  checkPostgresHealth,
  parseHostAndPort,
  sanitizeDatabaseError,
} from '../../src/server/db/health.js';
import { createPrismaClient, sanitizeDatabaseUrl } from '../../src/server/db/client.js';
import { validateEnv } from '../../src/server/config/env.js';

describe('PostgreSQL Exclusivity & Unavailable Database Handling', () => {
  it('should explicitly reject non-PostgreSQL protocols when instantiating client', () => {
    expect(() => {
      createPrismaClient('sqlite://dev.db');
    }).toThrowError(/Only PostgreSQL is supported/);

    expect(() => {
      createPrismaClient('file:./dev.db');
    }).toThrowError(/Only PostgreSQL is supported/);
  });

  it('should return disconnected status and safe diagnostics when database is unreachable', async () => {
    const health = await checkPostgresHealth();

    // In a test container without a local Postgres daemon, health.status will be 'disconnected'
    // It must return database: 'PostgreSQL' and must not throw an unhandled crash
    expect(health.database).toBe('PostgreSQL');
    expect(['connected', 'disconnected']).toContain(health.status);
    if (health.status === 'disconnected') {
      expect(health.error).toBeDefined();
      expect(typeof health.error).toBe('string');
      // Ensure error doesn't expose database credentials
      expect(health.error).not.toMatch(/password/i);
    }
  });

  it('should accept external PostgreSQL URLs with sslmode and mask sensitive auth details', () => {
    const externalUrl =
      'postgresql://cloud_user:secret_remote_pwd123@ep-cool-db.us-east-2.aws.neon.tech:5432/core_erp?sslmode=require';

    // 1. Validate external PostgreSQL URL acceptance in development mode without DB/network access
    const validated = validateEnv({
      NODE_ENV: 'development',
      DATABASE_URL: externalUrl,
    });
    expect(validated.DATABASE_URL).toBe(externalUrl);

    // 2. Verify sanitizeDatabaseUrl() masks credentials and never exposes the original password
    const sanitized = sanitizeDatabaseUrl(externalUrl);
    expect(sanitized).toBe(
      'postgresql://cloud_user:*****@ep-cool-db.us-east-2.aws.neon.tech:5432/core_erp'
    );
    expect(sanitized).not.toContain('secret_remote_pwd123');

    // 3. Verify parseHostAndPort() extracts expected non-secret endpoint metadata
    const parsed = parseHostAndPort(externalUrl);
    expect(parsed).toEqual({
      host: 'ep-cool-db.us-east-2.aws.neon.tech',
      port: 5432,
      database: 'core_erp',
      user: 'cloud_user',
    });

    // 4. Verify sanitizeDatabaseError() categorizes SSL error, retains host:port, and never leaks password
    const sslDiagnostic = sanitizeDatabaseError(
      new Error(
        'SSL connection error for postgresql://cloud_user:secret_remote_pwd123@ep-cool-db.us-east-2.aws.neon.tech:5432/core_erp'
      ),
      externalUrl
    );
    expect(sslDiagnostic.category).toBe('ssl');
    expect(sslDiagnostic.sanitizedMessage).toContain('ep-cool-db.us-east-2.aws.neon.tech:5432');
    expect(sslDiagnostic.sanitizedMessage).not.toContain('secret_remote_pwd123');
  });
});
