import { vi } from 'vitest';
import { getPrismaClient, prisma } from '../../src/server/db/client.js';

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
] as const;

const KNOWN_MODEL_DELEGATES = [
  'company',
  'companySetting',
  'user',
  'rolePermission',
  'auditLog',
  'employee',
  'shift',
  'attendance',
  'leaveRequest',
  'payrollPeriod',
  'payslip',
  'biometricTerminal',
  'rawPunchLog',
] as const;

export interface UnitPrismaGuardContext {
  companySettingStore: Map<string, string>;
}

/**
 * Installs a strict unit-test isolation guard on the shared `prisma` proxy.
 *
 * Guarantees:
 * 1. Verifies test DATABASE_URL never targets port 5432.
 * 2. Replaces every Prisma model delegate method and client-level query/transaction method
 *    with a fail-fast spy throwing `[UNIT TEST DB ISOLATION ERROR]` if unmocked.
 * 3. Installs a clean per-test in-memory `companySetting` store (`findUnique` / `upsert`)
 *    and baseline `rolePermission` defaults (`findUnique: null`, `findMany: []`).
 *
 * Call inside `beforeEach` paired with `vi.restoreAllMocks()` in `afterEach`.
 */
export function installUnitPrismaGuard(options?: {
  allowCompanySettingStore?: boolean;
}): UnitPrismaGuardContext {
  const dbUrl = process.env.DATABASE_URL || '';
  if (dbUrl.includes(':5432')) {
    throw new Error(
      '[UNIT TEST DB SAFETY VIOLATION] DATABASE_URL targets port 5432 in isolated unit test mode.'
    );
  }

  const client = getPrismaClient() as unknown as Record<string, any>;
  const modelNames = new Set<string>(KNOWN_MODEL_DELEGATES);

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

    for (const method of DELEGATE_METHODS) {
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
