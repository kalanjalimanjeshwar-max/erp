import { PrismaClient } from '@prisma/client';
import { sanitizeDatabaseUrl } from '../config/env.js';

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const url =
    databaseUrl ||
    process.env.DATABASE_URL ||
    (process.env.NODE_ENV === 'test'
      ? process.env.TEST_DATABASE_URL ||
        'postgresql://erp_test_user:test_pass@localhost:5432/core_erp_test?schema=public'
      : undefined);

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


