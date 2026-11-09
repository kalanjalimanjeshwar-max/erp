import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createPrismaClient,
  getPrismaClient,
  resetPrismaClientForTesting,
} from '../../src/server/db/client.js';
import {
  APPROVED_STANDARD_TEST_DB_URL,
} from '../setup.js';

describe('Integration Test Database Routing and Isolation Safety', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    resetPrismaClientForTesting();
    process.env = { ...origEnv };
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    resetPrismaClientForTesting();
    process.env = { ...origEnv };
  });

  it('Test 1: Integration mode without TEST_DATABASE_URL fails closed', () => {
    process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;

    expect(() => createPrismaClient()).toThrow(
      /TEST_DATABASE_URL is required in integration test mode/
    );
  });

  it('Test 2: Integration mode with invalid host/port/database name fails closed', () => {
    process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
    delete process.env.DATABASE_URL;

    // Invalid host
    process.env.TEST_DATABASE_URL =
      'postgresql://erp_integration_user:pass@remote-db.production.local:5434/core_erp_integration_test';
    expect(() => createPrismaClient()).toThrow(/Unapproved host in TEST_DATABASE_URL/);

    // Invalid port
    process.env.TEST_DATABASE_URL =
      'postgresql://erp_integration_user:pass@localhost:5432/core_erp_integration_test';
    expect(() => createPrismaClient()).toThrow(/Unapproved port in TEST_DATABASE_URL/);

    // Invalid database name
    process.env.TEST_DATABASE_URL =
      'postgresql://erp_integration_user:pass@localhost:5434/core_erp_test';
    expect(() => createPrismaClient()).toThrow(/Unapproved database name in TEST_DATABASE_URL/);

    // Forbidden protocol
    process.env.TEST_DATABASE_URL =
      'mysql://erp_integration_user:pass@localhost:5434/core_erp_integration_test';
    expect(() => createPrismaClient()).toThrow(/Forbidden database protocol in TEST_DATABASE_URL/);
  });

  it('Test 3: Integration mode with valid port-5434 URL does not use port-5433 fallback', () => {
    process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
    delete process.env.DATABASE_URL;
    process.env.TEST_DATABASE_URL =
      'postgresql://erp_integration_user:test_secret@localhost:5434/core_erp_integration_test?schema=public';

    const client = createPrismaClient();
    const resolvedUrl = (client as any)._engineConfig?.overrideDatasources?.db?.url;

    expect(resolvedUrl).toBe(process.env.TEST_DATABASE_URL);
    expect(resolvedUrl).toContain(':5434/');
    expect(resolvedUrl).toContain('/core_erp_integration_test');
    expect(resolvedUrl).not.toContain(':5433');
    expect(resolvedUrl).not.toContain('/core_erp_test');
  });

  it('Test 4: Integration mode rejects conflicting DATABASE_URL', () => {
    process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
    process.env.DATABASE_URL = APPROVED_STANDARD_TEST_DB_URL;
    process.env.TEST_DATABASE_URL =
      'postgresql://erp_integration_user:test_secret@localhost:5434/core_erp_integration_test?schema=public';

    expect(() => createPrismaClient()).toThrow(
      /Conflicting DATABASE_URL detected in integration test mode/
    );
  });

  it('Test 5: Normal test mode preserves standard port-5433 fallback', () => {
    delete process.env.COREERP_INTEGRATION_TEST_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;

    process.env.DATABASE_URL = APPROVED_STANDARD_TEST_DB_URL;

    const client = createPrismaClient();
    const resolvedUrl = (client as any)._engineConfig?.overrideDatasources?.db?.url;

    expect(resolvedUrl).toBe(APPROVED_STANDARD_TEST_DB_URL);
    expect(resolvedUrl).toContain(':5433/');
    expect(resolvedUrl).toContain('/core_erp_test');
  });

  it('Test 6: Shared application Prisma client connects to TEST_DATABASE_URL in integration mode', () => {
    process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
    delete process.env.DATABASE_URL;
    process.env.TEST_DATABASE_URL =
      'postgresql://erp_integration_user:test_secret@localhost:5434/core_erp_integration_test?schema=public';

    resetPrismaClientForTesting();
    const client = getPrismaClient();
    const resolvedUrl = (client as any)._engineConfig?.overrideDatasources?.db?.url;

    expect(resolvedUrl).toBe(process.env.TEST_DATABASE_URL);
    expect(resolvedUrl).toContain(':5434/core_erp_integration_test');
  });
});
