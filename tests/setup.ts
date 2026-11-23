/**
 * CoreERP Test Setup
 * Registered via Vitest setupFiles for isolated, non-connecting test runs.
 */

// 1. Enforce test environment
process.env.NODE_ENV = 'test';

// Approved endpoints configuration
const APPROVED_TEST_DB_HOSTS = new Set(['localhost', '127.0.0.1']);

// Standard Unit Test Database (Port 5433 from docker-compose.dev.yml)
const STANDARD_TEST_DB_PORT = '5433';
const STANDARD_TEST_DB_NAME = 'core_erp_test';
const APPROVED_STANDARD_TEST_DB_URL =
  'postgresql://erp_test_user:erp_test_password@localhost:5433/core_erp_test?schema=public';

// Dedicated Concurrency Integration Test Database (Port 5434 from docker-compose.integration-test.yml)
const INTEGRATION_TEST_DB_PORT = '5434';
const INTEGRATION_TEST_DB_NAME = 'core_erp_integration_test';

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { beforeAll, beforeEach, afterEach, vi } from 'vitest';

const cjsRequire = createRequire(import.meta.url);
const cjsFs = cjsRequire('node:fs') as typeof fs;

const DOTENV_GUARD_SYMBOL = Symbol.for('coreerp.test.dotenvGuardInstalled');
const PRISMA_CTOR_GUARD_SYMBOL = Symbol.for('coreerp.test.prismaCtorGuarded');

interface FsExistsGuardState {
  originalExistsSync: typeof fs.existsSync;
  depth: number;
  repoRoot: string;
}

const fsExistsGuardStates = new WeakMap<object, FsExistsGuardState>();

export {
  APPROVED_TEST_DB_HOSTS,
  STANDARD_TEST_DB_PORT,
  STANDARD_TEST_DB_NAME,
  APPROVED_STANDARD_TEST_DB_URL,
  INTEGRATION_TEST_DB_PORT,
  INTEGRATION_TEST_DB_NAME,
  normalizeDatabaseUrl,
  validateStandardDatabaseUrl,
  validateIntegrationDatabaseUrl,
  isBlockedRepoEnvPath,
  installRepoDotenvFsGuard,
  restoreRepoDotenvFsGuard,
  withBlockedRepoDotenv,
  initializePrismaWithoutRepoDotenv,
  configureTestEnvironment,
};

/**
 * Returns true ONLY when targetPath resolves to the repository root `.env`
 * or `prisma/.env`. Never blocks `.env.example`, `.env.integration-test`,
 * temporary-directory `.env` files, or any other path.
 */
function isBlockedRepoEnvPath(
  targetPath: unknown,
  repoRoot: string = process.cwd(),
  platform: NodeJS.Platform = process.platform
): boolean {
  let rawPath: string | null = null;
  if (typeof targetPath === 'string') {
    rawPath = targetPath;
  } else if (Buffer.isBuffer(targetPath)) {
    rawPath = targetPath.toString('utf8');
  } else if (targetPath instanceof URL && targetPath.protocol === 'file:') {
    try {
      rawPath = fileURLToPath(targetPath);
    } catch {
      return false;
    }
  }

  if (!rawPath || rawPath.trim() === '') {
    return false;
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolvedRoot = pathApi.resolve(repoRoot);
  const resolvedCandidate = pathApi.resolve(resolvedRoot, rawPath);
  const blockedTargets = [
    pathApi.resolve(resolvedRoot, '.env'),
    pathApi.resolve(resolvedRoot, 'prisma', '.env'),
  ];

  if (platform === 'win32') {
    const lowerCandidate = resolvedCandidate.toLowerCase();
    return blockedTargets.some((target) => target.toLowerCase() === lowerCandidate);
  }

  return blockedTargets.includes(resolvedCandidate);
}

/**
 * Idempotently and reversibly wraps `fsModule.existsSync` so that ONLY while
 * `NODE_ENV === 'test'`, probes for `<repo>/.env` and `<repo>/prisma/.env`
 * return `false`. Reference-counted so nested calls restore cleanly to the
 * exact original function.
 */
function installRepoDotenvFsGuard(
  repoRoot: string = process.cwd(),
  fsModule: { existsSync: typeof fs.existsSync } = cjsFs,
  env: NodeJS.ProcessEnv = process.env
): () => void {
  let state = fsExistsGuardStates.get(fsModule);
  if (state) {
    state.depth += 1;
    state.repoRoot = repoRoot;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        restoreRepoDotenvFsGuard(fsModule);
      }
    };
  }

  const originalExistsSync = fsModule.existsSync;
  state = {
    originalExistsSync,
    depth: 1,
    repoRoot,
  };
  fsExistsGuardStates.set(fsModule, state);

  const guardedExistsSync: typeof fs.existsSync = (targetPath: fs.PathLike) => {
    const activeState = fsExistsGuardStates.get(fsModule);
    if (
      activeState &&
      env.NODE_ENV === 'test' &&
      isBlockedRepoEnvPath(targetPath, activeState.repoRoot)
    ) {
      return false;
    }
    return originalExistsSync.call(fsModule, targetPath);
  };

  fsModule.existsSync = guardedExistsSync;

  let released = false;
  return () => {
    if (!released) {
      released = true;
      restoreRepoDotenvFsGuard(fsModule);
    }
  };
}

/**
 * Decrements the guard reference count and restores the original `fs.existsSync`
 * function as soon as no active guard scope remains.
 */
function restoreRepoDotenvFsGuard(
  fsModule: { existsSync: typeof fs.existsSync } = cjsFs,
  force = false
): void {
  const state = fsExistsGuardStates.get(fsModule);
  if (!state) {
    return;
  }

  state.depth = force ? 0 : Math.max(0, state.depth - 1);
  if (state.depth === 0) {
    fsModule.existsSync = state.originalExistsSync;
    fsExistsGuardStates.delete(fsModule);
  }
}

/**
 * Executes `fn` with `<repo>/.env` and `<repo>/prisma/.env` temporarily hidden
 * from `fs.existsSync`, guaranteeing restoration in `finally`.
 */
function withBlockedRepoDotenv<T>(
  fn: () => T,
  options?: {
    repoRoot?: string;
    fsModule?: { existsSync: typeof fs.existsSync };
    env?: NodeJS.ProcessEnv;
  }
): T {
  const release = installRepoDotenvFsGuard(
    options?.repoRoot ?? process.cwd(),
    options?.fsModule ?? cjsFs,
    options?.env ?? process.env
  );
  try {
    return fn();
  } finally {
    release();
  }
}

/**
 * Wraps a PrismaClient constructor idempotently via Proxy `construct` trap so
 * each `new PrismaClient(...)` call runs under a scoped, immediately restored
 * repo `.env` guard while preserving Prisma's exact prototype chain.
 */
function wrapPrismaClientConstructor<T extends new (...args: any[]) => any>(
  OriginalPrismaClient: T,
  repoRoot: string = process.cwd(),
  fsModule: { existsSync: typeof fs.existsSync } = cjsFs,
  env: NodeJS.ProcessEnv = process.env
): T {
  if ((OriginalPrismaClient as any)[PRISMA_CTOR_GUARD_SYMBOL]) {
    return OriginalPrismaClient;
  }

  const GuardedPrismaClient = new Proxy(OriginalPrismaClient, {
    construct(target, args, newTarget) {
      const release = installRepoDotenvFsGuard(repoRoot, fsModule, env);
      try {
        const effectiveNewTarget = newTarget === GuardedPrismaClient ? target : newTarget;
        return Reflect.construct(target, args, effectiveNewTarget);
      } finally {
        release();
      }
    },
    get(target, prop) {
      if (prop === PRISMA_CTOR_GUARD_SYMBOL) {
        return true;
      }
      return Reflect.get(target, prop, target);
    },
  });

  return GuardedPrismaClient;
}

/**
 * Pre-initializes `@prisma/client` under a temporary, immediately restored
 * `fs.existsSync` guard so Prisma 6.19.3's module-top-level `warnEnvConflicts`
 * and subsequent `new PrismaClient(...)` constructor calls can never read
 * `<repo>/.env` or `<repo>/prisma/.env` into `process.env`, while leaving zero
 * permanent global filesystem override after setup completes.
 */
function initializePrismaWithoutRepoDotenv(
  repoRoot: string = process.cwd(),
  fsModule: { existsSync: typeof fs.existsSync } = cjsFs,
  env: NodeJS.ProcessEnv = process.env
): { initialized: boolean; guardActiveAfter: boolean } {
  if (!isPrismaClientInitialized()) {
    return {
      initialized: false,
      guardActiveAfter: fsExistsGuardStates.has(fsModule),
    };
  }

  withBlockedRepoDotenv(
    () => {
      const generatedEntryPath = path.resolve(repoRoot, 'node_modules/.prisma/client/index.js');
      if (fs.existsSync(generatedEntryPath)) {
        const generatedMod = cjsRequire(generatedEntryPath) as Record<string, any>;
        if (generatedMod && typeof generatedMod.PrismaClient === 'function') {
          generatedMod.PrismaClient = wrapPrismaClientConstructor(
            generatedMod.PrismaClient,
            repoRoot,
            fsModule,
            env
          );
        }
      }

      // Load `.prisma/client/default` before `@prisma/client` so re-exports inherit the guarded constructor.
      const dotPrismaMod = cjsRequire('.prisma/client/default') as Record<string, any>;
      if (dotPrismaMod && typeof dotPrismaMod.PrismaClient === 'function') {
        dotPrismaMod.PrismaClient = wrapPrismaClientConstructor(
          dotPrismaMod.PrismaClient,
          repoRoot,
          fsModule,
          env
        );
      }

      const prismaPkgMod = cjsRequire('@prisma/client') as Record<string, any>;
      if (prismaPkgMod && typeof prismaPkgMod.PrismaClient === 'function') {
        prismaPkgMod.PrismaClient = wrapPrismaClientConstructor(
          prismaPkgMod.PrismaClient,
          repoRoot,
          fsModule,
          env
        );
      }
    },
    { repoRoot, fsModule, env }
  );

  return {
    initialized: true,
    guardActiveAfter: fsExistsGuardStates.has(fsModule),
  };
}

/**
 * Trims whitespace and strips matching surrounding single or double quotes.
 */
function normalizeDatabaseUrl(urlValue: string | undefined): string | undefined {
  if (!urlValue) {
    return undefined;
  }
  const trimmed = urlValue.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted === '' ? undefined : unquoted;
  }
  return trimmed;
}

/**
 * Validates that DATABASE_URL strictly points to the approved standard unit test database.
 * Credentials and raw connection strings are NEVER logged in error messages.
 */
function validateStandardDatabaseUrl(urlValue: string | undefined): void {
  const normalized = normalizeDatabaseUrl(urlValue);
  if (!normalized) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(
      '[DATABASE SAFETY VIOLATION] Invalid or unparseable DATABASE_URL in test environment. Expected approved local test endpoint. Refusing to proceed.'
    );
  }

  const protocol = parsed.protocol;
  if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
    throw new Error(
      '[DATABASE SAFETY VIOLATION] Forbidden database protocol in DATABASE_URL. PostgreSQL is required. Refusing to proceed.'
    );
  }

  const hostname = parsed.hostname;
  if (!APPROVED_TEST_DB_HOSTS.has(hostname)) {
    throw new Error(
      '[DATABASE SAFETY VIOLATION] Unapproved database host in DATABASE_URL. Remote and production hosts are strictly forbidden in tests. Expected localhost or 127.0.0.1. Refusing to proceed.'
    );
  }

  const port = parsed.port;
  if (port !== STANDARD_TEST_DB_PORT) {
    throw new Error(
      `[DATABASE SAFETY VIOLATION] Unapproved database port in DATABASE_URL. Primary port 5432 and non-test ports are strictly forbidden in tests. Expected port ${STANDARD_TEST_DB_PORT}. Refusing to proceed.`
    );
  }

  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (dbName !== STANDARD_TEST_DB_NAME) {
    throw new Error(
      `[DATABASE SAFETY VIOLATION] Unapproved database name in DATABASE_URL. Expected database "${STANDARD_TEST_DB_NAME}". Refusing to proceed.`
    );
  }
}

/**
 * Validates that TEST_DATABASE_URL strictly points to the dedicated concurrency integration test database.
 * Credentials and raw connection strings are NEVER logged in error messages.
 */
function validateIntegrationDatabaseUrl(urlValue: string | undefined): void {
  const normalized = normalizeDatabaseUrl(urlValue);
  if (!normalized) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(
      '[DATABASE SAFETY VIOLATION] Invalid or unparseable TEST_DATABASE_URL in test environment. Expected approved local test endpoint. Refusing to proceed.'
    );
  }

  const protocol = parsed.protocol;
  if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
    throw new Error(
      '[DATABASE SAFETY VIOLATION] Forbidden database protocol in TEST_DATABASE_URL. PostgreSQL is required. Refusing to proceed.'
    );
  }

  const hostname = parsed.hostname;
  if (!APPROVED_TEST_DB_HOSTS.has(hostname)) {
    throw new Error(
      '[DATABASE SAFETY VIOLATION] Unapproved database host in TEST_DATABASE_URL. Remote and production hosts are strictly forbidden in tests. Expected localhost or 127.0.0.1. Refusing to proceed.'
    );
  }

  const port = parsed.port;
  if (port !== INTEGRATION_TEST_DB_PORT) {
    throw new Error(
      `[DATABASE SAFETY VIOLATION] Unapproved database port in TEST_DATABASE_URL. Dedicated integration test must run on port ${INTEGRATION_TEST_DB_PORT}. Refusing to proceed.`
    );
  }

  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (dbName !== INTEGRATION_TEST_DB_NAME) {
    throw new Error(
      `[DATABASE SAFETY VIOLATION] Unapproved database name in TEST_DATABASE_URL. Expected dedicated database "${INTEGRATION_TEST_DB_NAME}". Refusing to proceed.`
    );
  }
}

// 2. Validate environment database URLs independently for safety
function configureTestEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  dotenvModule: { config?: (...args: any[]) => any } = dotenv,
  repoRoot: string = process.cwd()
): { isIntegrationMode: boolean } {
  // Integration mode must ONLY be activated explicitly via COREERP_INTEGRATION_TEST_MODE=true.
  const isIntegrationMode = env.COREERP_INTEGRATION_TEST_MODE === 'true';

  if (isIntegrationMode) {
    if (env.NODE_ENV !== 'test') {
      throw new Error(
        '[DATABASE SAFETY VIOLATION] COREERP_INTEGRATION_TEST_MODE requires NODE_ENV=test. Refusing to proceed.'
      );
    }

    // Fail closed if DATABASE_URL is defined — never silently delete a conflicting value before validation.
    if (env.DATABASE_URL && env.DATABASE_URL.trim() !== '') {
      throw new Error(
        '[DATABASE SAFETY VIOLATION] Conflicting DATABASE_URL detected in integration test mode. Integration tests must exclusively use TEST_DATABASE_URL to prevent split-brain routing. Refusing to proceed.'
      );
    }

    const normalizedTestDbUrl = normalizeDatabaseUrl(env.TEST_DATABASE_URL);
    if (!normalizedTestDbUrl) {
      throw new Error(
        '[DATABASE SAFETY VIOLATION] TEST_DATABASE_URL is required in integration test mode. Refusing to proceed.'
      );
    }
    validateIntegrationDatabaseUrl(normalizedTestDbUrl);
    env.TEST_DATABASE_URL = normalizedTestDbUrl;

    // Prevent dotenv.config from loading the repository .env or prisma/.env in integration mode.
    if (
      dotenvModule &&
      typeof dotenvModule.config === 'function' &&
      !(dotenvModule.config as any)[DOTENV_GUARD_SYMBOL]
    ) {
      const origDotenvConfig = dotenvModule.config;
      const guardedDotenvConfig = (options?: { path?: string | string[] | URL }) => {
        if (!options || options.path == null) {
          return { parsed: {} };
        }
        const candidatePaths = Array.isArray(options.path) ? options.path : [options.path];
        if (candidatePaths.some((candidate) => isBlockedRepoEnvPath(candidate, repoRoot))) {
          return { parsed: {} };
        }
        return origDotenvConfig(options);
      };
      (guardedDotenvConfig as any)[DOTENV_GUARD_SYMBOL] = true;
      dotenvModule.config = guardedDotenvConfig;
    }
    // In integration mode, DATABASE_URL is deliberately not populated with the port 5433 fallback.
  } else {
    validateStandardDatabaseUrl(env.DATABASE_URL);
    validateIntegrationDatabaseUrl(env.TEST_DATABASE_URL);

    // In normal DB-free mode, remove any validated TEST_DATABASE_URL from the environment so
    // unit database guards and integration suites never mistake it for an active integration target.
    delete env.TEST_DATABASE_URL;

    // 3. Populate approved local test database URL for standard unit tests if absent
    if (!env.DATABASE_URL) {
      env.DATABASE_URL = APPROVED_STANDARD_TEST_DB_URL;
    } else {
      const normalizedDbUrl = normalizeDatabaseUrl(env.DATABASE_URL);
      if (normalizedDbUrl) {
        env.DATABASE_URL = normalizedDbUrl;
      }
    }
    // Note: TEST_DATABASE_URL is NEVER automatically populated with default or placeholder credentials.
    // Missing TEST_DATABASE_URL remains missing so dedicated integration tests report BLOCKED / NOT RUN safely.
  }

  return { isIntegrationMode };
}

export function isPrismaClientInitialized(): boolean {
  try {
    const prismaClientDir = path.resolve(process.cwd(), 'node_modules/.prisma/client');
    return (
      fs.existsSync(path.join(prismaClientDir, 'schema.prisma')) ||
      fs.existsSync(path.join(prismaClientDir, 'index.js'))
    );
  } catch {
    return false;
  }
}

configureTestEnvironment(process.env, dotenv, process.cwd());

// Pre-initialize Prisma under a temporary, immediately restored repo `.env` guard
// BEFORE any test file imports `@prisma/client`.
initializePrismaWithoutRepoDotenv(process.cwd(), cjsFs, process.env);

// 4. Provide non-secret, test-only SESSION_SECRET satisfying environment schema
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'test_isolated_session_secret_not_for_production_min32chars';
}

// 5. Default stub for rolePermission in isolated non-connecting test runs
// Prevents offline database connection failures from blocking permission resolution
// in tests that do not connect to a live postgres database.

async function ensureRolePermissionStub(): Promise<void> {
  if (process.env.COREERP_INTEGRATION_TEST_MODE === 'true') {
    return;
  }

  // Ensure Prisma Client is generated before attempting to import or stub database models.
  // This prevents premature instantiation exceptions during test setup for non-database suites.
  if (!isPrismaClientInitialized()) {
    return;
  }

  try {
    const { prisma } = await import('../src/server/db/client.js');
    if (prisma?.rolePermission) {
      if ('findUnique' in prisma.rolePermission && !vi.isMockFunction(prisma.rolePermission.findUnique)) {
        vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
      }
      if ('findMany' in prisma.rolePermission && !vi.isMockFunction(prisma.rolePermission.findMany)) {
        vi.spyOn(prisma.rolePermission, 'findMany').mockResolvedValue([]);
      }
    }
  } catch (err: any) {
    if (err?.message?.includes('did not initialize yet')) {
      return;
    }
    throw err;
  }
}

beforeAll(ensureRolePermissionStub);
beforeEach(ensureRolePermissionStub);
afterEach(ensureRolePermissionStub);



