import { vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { getPrismaClient, prisma } from '../../src/server/db/client.js';

const APPROVED_UNIT_TEST_HOSTS = new Set(['localhost', '127.0.0.1']);
const APPROVED_UNIT_TEST_PORT = '5433';
const APPROVED_UNIT_TEST_DB_NAME = 'core_erp_test';

const DELEGATE_METHODS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
] as const;

const TOP_LEVEL_CLIENT_METHODS = [
  '$connect',
  '$disconnect',
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$transaction',
  '$use',
  '$extends',
] as const;

export interface UnitPrismaGuardContext {
  companySettingStore: Map<string, string>;
}

/**
 * Parses and validates a single database environment variable for isolated unit-test mode.
 *
 * Rules:
 * - If unset/empty, no URL is required by unit-test mocks.
 * - If present, parses strictly via `new URL(...)` (no substring checks).
 * - Rejects non-PostgreSQL protocols and non-local hosts.
 * - Rejects port 5432 (explicit or implicit PostgreSQL default) and port 5434 (integration DB).
 * - Preserves only the approved isolated unit-test target: localhost/127.0.0.1 port 5433 / core_erp_test.
 * - Never includes raw URLs or credentials in error messages.
 */
function validateUnitDatabaseUrl(
  envName: 'DATABASE_URL' | 'TEST_DATABASE_URL',
  rawUrl: string | undefined
): void {
  if (!rawUrl || rawUrl.trim() === '') {
    return;
  }

  const cleaned = rawUrl.trim().replace(/^["']|["']$/g, '');
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error(
      `[UNIT TEST DB SAFETY VIOLATION] Invalid URL format for ${envName} in isolated unit test mode.`
    );
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `[UNIT TEST DB SAFETY VIOLATION] Forbidden protocol "${parsed.protocol}" in ${envName} in isolated unit test mode.`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!APPROVED_UNIT_TEST_HOSTS.has(hostname)) {
    throw new Error(
      `[UNIT TEST DB SAFETY VIOLATION] Unapproved host "${hostname}" in ${envName} in isolated unit test mode. Only localhost or 127.0.0.1 is permitted.`
    );
  }

  // Omitting port in a PostgreSQL URL defaults to port 5432; evaluate effective port explicitly.
  const effectivePort = parsed.port || '5432';
  if (effectivePort === '5432') {
    throw new Error(
      `[UNIT TEST DB SAFETY VIOLATION] ${envName} resolves to port 5432 (operational/dev default) in isolated unit test mode.`
    );
  }
  if (effectivePort === '5434') {
    throw new Error(
      `[UNIT TEST DB SAFETY VIOLATION] ${envName} targets port 5434 (integration test database) in isolated unit test mode.`
    );
  }
  if (effectivePort !== APPROVED_UNIT_TEST_PORT) {
    throw new Error(
      `[UNIT TEST DB SAFETY VIOLATION] ${envName} targets unapproved port ${effectivePort} in isolated unit test mode. Only port ${APPROVED_UNIT_TEST_PORT} is permitted.`
    );
  }

  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (dbName !== APPROVED_UNIT_TEST_DB_NAME) {
    throw new Error(
      `[UNIT TEST DB SAFETY VIOLATION] ${envName} targets unapproved database "${dbName || '(none)'}" in isolated unit test mode. Expected "${APPROVED_UNIT_TEST_DB_NAME}".`
    );
  }
}

/**
 * Validates that the current process environment is safe for isolated unit tests.
 * Performs purely in-memory validation with zero database or network calls.
 */
export function validateIsolatedUnitDbEnv(): void {
  if (process.env.COREERP_INTEGRATION_TEST_MODE === 'true') {
    throw new Error(
      '[UNIT TEST DB SAFETY VIOLATION] COREERP_INTEGRATION_TEST_MODE=true is forbidden in isolated unit test mode.'
    );
  }

  validateUnitDatabaseUrl('DATABASE_URL', process.env.DATABASE_URL);
  validateUnitDatabaseUrl('TEST_DATABASE_URL', process.env.TEST_DATABASE_URL);
}

/**
 * Installs a strict unit-test isolation guard on the shared `prisma` proxy.
 *
 * Guarantees:
 * 1. Parses and validates both DATABASE_URL and TEST_DATABASE_URL (rejects 5432/5434; allows 5433 only).
 * 2. Replaces every Prisma model delegate method (across all Prisma.ModelName delegates)
 *    and client-level query/connection/transaction method with a fail-fast spy throwing
 *    `[UNIT TEST DB ISOLATION ERROR]` if unmocked — without opening any DB connection.
 * 3. Installs a clean per-test in-memory `companySetting` store (`findUnique` / `upsert`)
 *    and baseline `rolePermission` defaults (`findUnique: null`, `findMany: []`).
 *
 * Call inside `beforeEach` paired with `vi.restoreAllMocks()` in `afterEach`.
 */
export function installUnitPrismaGuard(options?: {
  allowCompanySettingStore?: boolean;
}): UnitPrismaGuardContext {
  validateIsolatedUnitDbEnv();

  const client = getPrismaClient() as unknown as Record<string, any>;
  const modelNames = new Set<string>(
    Object.values(Prisma.ModelName).map(
      (name) => name.charAt(0).toLowerCase() + name.slice(1)
    )
  );

  for (const key of Object.keys(client)) {
    if (!key.startsWith('$') && !key.startsWith('_')) {
      const candidate = client[key];
      if (candidate && typeof candidate === 'object' && typeof candidate.findUnique === 'function') {
        modelNames.add(key);
      }
    }
  }

  for (const method of TOP_LEVEL_CLIENT_METHODS) {
    if (typeof (prisma as any)[method] === 'function') {
      vi.spyOn(prisma as any, method).mockImplementation(() => {
        throw new Error(
          `[UNIT TEST DB ISOLATION ERROR] Unexpected unmocked Prisma call: prisma.${method}(). ` +
            'Isolated unit tests must mock database operations and must never connect to PostgreSQL.'
        );
      });
    }
  }

  for (const modelName of modelNames) {
    const delegate = (prisma as any)[modelName];
    if (!delegate || typeof delegate !== 'object') continue;

    const methodsToTrap = new Set<string>(DELEGATE_METHODS);
    for (const prop of [
      ...Object.keys(delegate),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(delegate) || {}),
    ]) {
      if (prop !== 'constructor' && typeof delegate[prop] === 'function') {
        methodsToTrap.add(prop);
      }
    }

    for (const method of methodsToTrap) {
      if (typeof delegate[method] === 'function') {
        vi.spyOn(delegate, method).mockImplementation(() => {
          throw new Error(
            `[UNIT TEST DB ISOLATION ERROR] Unexpected unmocked Prisma call: prisma.${modelName}.${method}(). ` +
              'Isolated unit tests must mock database operations and must never connect to PostgreSQL.'
          );
        });
      }
    }
  }

  if (prisma.rolePermission) {
    vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.rolePermission, 'findMany').mockResolvedValue([]);
  }

  const companySettingStore = new Map<string, string>();
  const makeKey = (companyId: string, key: string) => `${companyId}::${key}`;

  if (options?.allowCompanySettingStore !== false && prisma.companySetting) {
    vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation((async (args: any) => {
      const cid = args?.where?.companyId_key?.companyId ?? '';
      const key = args?.where?.companyId_key?.key ?? '';
      const composite = makeKey(cid, key);
      const val = companySettingStore.get(composite);
      if (val === undefined) return null;
      return {
        id: composite,
        companyId: cid,
        key,
        value: val,
      } as any;
    }) as any);

    vi.spyOn(prisma.companySetting, 'upsert').mockImplementation((async (args: any) => {
      const cid = args?.where?.companyId_key?.companyId ?? args?.create?.companyId ?? '';
      const key = args?.where?.companyId_key?.key ?? args?.create?.key ?? '';
      const composite = makeKey(cid, key);
      const val = args?.update?.value ?? args?.create?.value ?? '{}';
      companySettingStore.set(composite, val);
      return {
        id: composite,
        companyId: cid,
        key,
        value: val,
      } as any;
    }) as any);
  }

  return { companySettingStore };
}
