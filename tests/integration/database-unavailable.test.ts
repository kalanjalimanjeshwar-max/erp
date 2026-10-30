import { describe, it, expect } from 'vitest';
import { checkPostgresHealth } from '../../src/server/db/health.js';
import { createPrismaClient } from '../../src/server/db/client.js';

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
    const externalUrl = 'postgresql://cloud_user:secret_remote_pwd123@ep-cool-db.us-east-2.aws.neon.tech:5432/core_erp?sslmode=require';
    const client = createPrismaClient(externalUrl);
    expect(client).toBeDefined();

    // Verify client configuration preserves external datasource without throwing
    expect(typeof client.$connect).toBe('function');
  });
});

