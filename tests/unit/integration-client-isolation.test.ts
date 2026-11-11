import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  prisma,
  getPrismaClient,
  createPrismaClient,
  configureIntegrationPrismaClient,
  resetPrismaClientForTesting,
  validateIntegrationDatabaseEndpoint,
} from '../../src/server/db/client.js';

describe('PostgreSQL 16 Integration Client Isolation & Proxy Binding (Phase 2.3)', () => {
  const origEnv = { ...process.env };
  const validIntegrationUrl =
    'postgresql://erp_integration_user:test_secret@localhost:5434/core_erp_integration_test?schema=public';

  beforeEach(() => {
    resetPrismaClientForTesting();
    process.env = { ...origEnv };
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    resetPrismaClientForTesting();
    process.env = { ...origEnv };
  });

  it('Requirement A: configureIntegrationPrismaClient strictly rejects production mode', () => {
    process.env.NODE_ENV = 'production';

    expect(() => configureIntegrationPrismaClient(validIntegrationUrl)).toThrow(
      /configureIntegrationPrismaClient cannot be used in production mode/
    );
  });

  it('Requirement B: configureIntegrationPrismaClient enforces endpoint validation', () => {
    // Rejects invalid port
    expect(() =>
      configureIntegrationPrismaClient(
        'postgresql://erp_integration_user:test@localhost:5432/core_erp_integration_test'
      )
    ).toThrow(/Unapproved port in TEST_DATABASE_URL/);

    // Rejects invalid database name
    expect(() =>
      configureIntegrationPrismaClient(
        'postgresql://erp_integration_user:test@localhost:5434/core_erp_test'
      )
    ).toThrow(/Unapproved database name in TEST_DATABASE_URL/);

    // Rejects remote / unapproved host
    expect(() =>
      configureIntegrationPrismaClient(
        'postgresql://erp_integration_user:test@db.internal:5434/core_erp_integration_test'
      )
    ).toThrow(/Unapproved host in TEST_DATABASE_URL/);

    // Rejects invalid protocol
    expect(() =>
      configureIntegrationPrismaClient(
        'mysql://erp_integration_user:test@localhost:5434/core_erp_integration_test'
      )
    ).toThrow(/Forbidden database protocol in TEST_DATABASE_URL/);
  });

  it('Requirement C: configureIntegrationPrismaClient binds the global prisma proxy and cleans conflicting DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://erp_test_user:test@localhost:5433/core_erp_test';

    const client = configureIntegrationPrismaClient(validIntegrationUrl);

    // Conflict guard satisfied because DATABASE_URL was stripped
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.COREERP_INTEGRATION_TEST_MODE).toBe('true');
    expect(process.env.TEST_DATABASE_URL).toBe(validIntegrationUrl);

    // getPrismaClient returns the identical client
    const currentSingleton = getPrismaClient();
    expect(currentSingleton).toBe(client);

    // Check datasource URL on the configured client
    const resolvedUrl = (client as any)._engineConfig?.overrideDatasources?.db?.url;
    expect(resolvedUrl).toBe(validIntegrationUrl);
    expect(resolvedUrl).toContain(':5434/core_erp_integration_test');
  });

  it('Requirement D: Global prisma proxy routes calls directly to the integration client', () => {
    const client = configureIntegrationPrismaClient(validIntegrationUrl);

    // Access property via proxy
    expect((prisma as any)._engineConfig?.overrideDatasources?.db?.url).toBe(validIntegrationUrl);
    expect(getPrismaClient()).toBe(client);
  });

  it('Requirement E: resetPrismaClientForTesting resets both cachedClient and global.__prismaClient', () => {
    configureIntegrationPrismaClient(validIntegrationUrl);
    expect(global.__prismaClient).toBeDefined();

    resetPrismaClientForTesting();
    expect(global.__prismaClient).toBeUndefined();
  });
});
