import { PrismaClient } from '@prisma/client';

export function sanitizeDatabaseUrl(url: string | undefined): string {
  if (!url) return '[NOT_CONFIGURED]';
  try {
    const parsed = new URL(url);
    const auth = parsed.username ? `${parsed.username}:*****@` : '';
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`;
  } catch {
    return 'postgresql://*****:*****@***/***';
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

const APPROVED_INTEGRATION_TEST_HOSTS = new Set(['localhost', '127.0.0.1']);
const INTEGRATION_TEST_PORT = '5434';
const INTEGRATION_TEST_DB_NAME = 'core_erp_integration_test';

export function validateIntegrationDatabaseEndpoint(urlValue: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error(
      '[PostgreSQL Configuration Error] Invalid database URL format for TEST_DATABASE_URL.'
    );
  }

  const protocol = parsed.protocol;
  if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
    throw new Error(
      '[PostgreSQL Configuration Error] Forbidden database protocol in TEST_DATABASE_URL. Only PostgreSQL is supported.'
    );
  }

  if (!APPROVED_INTEGRATION_TEST_HOSTS.has(parsed.hostname)) {
    throw new Error(
      '[PostgreSQL Configuration Error] Unapproved host in TEST_DATABASE_URL. Remote and production hosts are strictly forbidden in tests. Expected localhost or 127.0.0.1.'
    );
  }

  if (parsed.port !== INTEGRATION_TEST_PORT) {
    throw new Error(
      `[PostgreSQL Configuration Error] Unapproved port in TEST_DATABASE_URL. Dedicated integration test must run on port ${INTEGRATION_TEST_PORT}.`
    );
  }

  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (dbName !== INTEGRATION_TEST_DB_NAME) {
    throw new Error(
      `[PostgreSQL Configuration Error] Unapproved database name in TEST_DATABASE_URL. Expected "${INTEGRATION_TEST_DB_NAME}".`
    );
  }
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';

  let url: string | undefined;

  if (isIntegrationMode) {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        '[PostgreSQL Configuration Error] COREERP_INTEGRATION_TEST_MODE requires NODE_ENV=test.'
      );
    }
    if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
      throw new Error(
        '[PostgreSQL Configuration Error] Conflicting DATABASE_URL detected in integration test mode. Refusing to proceed to prevent split-brain routing.'
      );
    }
    const targetUrl = databaseUrl || process.env.TEST_DATABASE_URL;
    if (!targetUrl || targetUrl.trim() === '') {
      throw new Error(
        '[PostgreSQL Configuration Error] TEST_DATABASE_URL is required in integration test mode.'
      );
    }
    validateIntegrationDatabaseEndpoint(targetUrl);
    url = targetUrl;
  } else {
    url =
      databaseUrl ||
      process.env.DATABASE_URL ||
      (process.env.NODE_ENV === 'test'
        ? process.env.TEST_DATABASE_URL ||
          'postgresql://erp_test_user:test_pass@localhost:5432/core_erp_test?schema=public'
        : undefined);
  }

  if (url) {
    url = url.trim().replace(/^["']|["']$/g, '');
  }

  if (!url) {
    throw new Error(
      '[PostgreSQL Configuration Error] DATABASE_URL is not set. PostgreSQL is the mandatory sole operational database.'
    );
  }

  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
    throw new Error(
      `[PostgreSQL Configuration Error] Invalid database protocol in "${sanitizeDatabaseUrl(url)}". Only PostgreSQL is supported.`
    );
  }

  return new PrismaClient({
    datasources: {
      db: {
        url,
      },
    },
    // Avoid raw stderr logging; handle errors gracefully through application try/catch handlers
    log: [],
  });
}

/**
 * Singleton Prisma Client proxy for the application lifecycle
 */
let cachedClient: PrismaClient | null = null;

export function resetPrismaClientForTesting(): void {
  if (cachedClient) {
    try {
      cachedClient.$disconnect().catch(() => {});
    } catch {}
  }
  cachedClient = null;
  if (typeof global !== 'undefined') {
    delete (global as any).__prismaClient;
  }
}

/**
 * Test-only explicit integration client configuration (Phase 2.3).
 *
 * Configures and binds the global application Prisma singleton proxy directly
 * to the dedicated PostgreSQL 16 integration test database at localhost:5434.
 *
 * Safety Invariants:
 * 1. Strictly forbidden in production (NODE_ENV=production).
 * 2. Enforces NODE_ENV=test and COREERP_INTEGRATION_TEST_MODE=true.
 * 3. Removes conflicting DATABASE_URL to satisfy the split-brain routing guard.
 * 4. Strictly validates endpoint against localhost:5434 / core_erp_integration_test.
 * 5. Safely disconnects any stale cached client and binds the singleton proxy to the integration database.
 */
export function configureIntegrationPrismaClient(databaseUrl: string): PrismaClient {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[SECURITY FATAL] configureIntegrationPrismaClient cannot be used in production mode.'
    );
  }

  // Enforce test environment and integration mode
  process.env.NODE_ENV = 'test';
  process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
  delete process.env.DATABASE_URL;
  process.env.TEST_DATABASE_URL = databaseUrl;

  validateIntegrationDatabaseEndpoint(databaseUrl);

  // Safely disconnect previous client if exists
  if (cachedClient) {
    try {
      cachedClient.$disconnect().catch(() => {});
    } catch {}
    cachedClient = null;
  }
  if (typeof global !== 'undefined') {
    delete (global as any).__prismaClient;
  }

  const client = createPrismaClient(databaseUrl);
  // Ensure DATABASE_URL is deleted even if Prisma's constructor triggered dotenv loading
  delete process.env.DATABASE_URL;
  cachedClient = client;
  if (typeof global !== 'undefined') {
    global.__prismaClient = client;
  }

  return client;
}

export function setPrismaClient(client: PrismaClient): void {
  cachedClient = client;
  if (typeof global !== 'undefined') {
    global.__prismaClient = client;
  }
}

export function getPrismaClient(): PrismaClient {
  if (global.__prismaClient) {
    return global.__prismaClient;
  }
  if (!cachedClient) {
    cachedClient = createPrismaClient();
    if (process.env.NODE_ENV !== 'production') {
      global.__prismaClient = cachedClient;
    }
  }
  return cachedClient;
}

export interface UrlConsistencyCheckResult {
  consistent: boolean;
  mismatches: string[];
  protocolMatch: boolean;
  hostMatch: boolean;
  portMatch: boolean;
  usernameMatch: boolean;
  databaseMatch: boolean;
  queryParamMatch: boolean;
  credentialsMatch: boolean;
  sanitizedConfigTarget: string;
  sanitizedPrismaTarget: string;
}

/**
 * Diagnostic utility to verify that validated config DATABASE_URL and the URL
 * used by Prisma are identical across all components without logging secrets.
 */
export function verifyDatabaseUrlConsistency(
  configUrl: string,
  client?: PrismaClient
): UrlConsistencyCheckResult {
  const activeClient = client || getPrismaClient();
  const prismaUrl =
    (activeClient as any)._engineConfig?.overrideDatasources?.db?.url ||
    process.env.DATABASE_URL ||
    '';

  const cleanConfigUrl = configUrl ? configUrl.trim().replace(/^["']|["']$/g, '') : '';
  const cleanPrismaUrl = prismaUrl ? prismaUrl.trim().replace(/^["']|["']$/g, '') : '';

  const sanitizedConfigTarget = sanitizeDatabaseUrl(cleanConfigUrl);
  const sanitizedPrismaTarget = sanitizeDatabaseUrl(cleanPrismaUrl);

  const mismatches: string[] = [];

  let pConfig: URL | null = null;
  let pPrisma: URL | null = null;

  try {
    pConfig = new URL(cleanConfigUrl);
  } catch {
    mismatches.push('config_url_invalid');
  }

  try {
    pPrisma = new URL(cleanPrismaUrl);
  } catch {
    mismatches.push('prisma_url_invalid');
  }

  if (!pConfig || !pPrisma) {
    return {
      consistent: false,
      mismatches,
      protocolMatch: false,
      hostMatch: false,
      portMatch: false,
      usernameMatch: false,
      databaseMatch: false,
      queryParamMatch: false,
      credentialsMatch: false,
      sanitizedConfigTarget,
      sanitizedPrismaTarget,
    };
  }

  const protocolMatch = pConfig.protocol === pPrisma.protocol;
  if (!protocolMatch) mismatches.push('protocol');

  const hostMatch = pConfig.hostname.toLowerCase() === pPrisma.hostname.toLowerCase();
  if (!hostMatch) mismatches.push('host');

  const port1 = pConfig.port || '5432';
  const port2 = pPrisma.port || '5432';
  const portMatch = port1 === port2;
  if (!portMatch) mismatches.push('port');

  const user1 = decodeURIComponent(pConfig.username || '');
  const user2 = decodeURIComponent(pPrisma.username || '');
  const usernameMatch = user1 === user2;
  if (!usernameMatch) mismatches.push('username');

  const db1 = pConfig.pathname.replace(/^\//, '').split('?')[0];
  const db2 = pPrisma.pathname.replace(/^\//, '').split('?')[0];
  const databaseMatch = db1 === db2;
  if (!databaseMatch) mismatches.push('database');

  const query1 = pConfig.searchParams.toString();
  const query2 = pPrisma.searchParams.toString();
  const queryParamMatch = query1 === query2;
  if (!queryParamMatch) mismatches.push('query_parameters');

  const pass1 = decodeURIComponent(pConfig.password || '');
  const pass2 = decodeURIComponent(pPrisma.password || '');
  const credentialsMatch = pass1 === pass2;
  if (!credentialsMatch) mismatches.push('credentials');

  return {
    consistent: mismatches.length === 0,
    mismatches,
    protocolMatch,
    hostMatch,
    portMatch,
    usernameMatch,
    databaseMatch,
    queryParamMatch,
    credentialsMatch,
    sanitizedConfigTarget,
    sanitizedPrismaTarget,
  };
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(target, prop) {
    if (prop in target) {
      return (target as unknown as Record<string, unknown>)[prop as string];
    }
    const client = getPrismaClient();
    const value = (client as unknown as Record<string, unknown>)[prop as string];
    if (typeof value === 'function') {
      return value.bind(client);
    }
    return value;
  },
  has(target, prop) {
    return prop in target || prop in getPrismaClient();
  },
  set(target, prop, value) {
    (target as unknown as Record<string, unknown>)[prop as string] = value;
    return true;
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop in target) {
      return Object.getOwnPropertyDescriptor(target, prop);
    }
    const client = getPrismaClient();
    if (prop in client) {
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (client as unknown as Record<string, unknown>)[prop as string],
      };
    }
    return undefined;
  },
});


