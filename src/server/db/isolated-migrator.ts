import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { isPostgresPortReachable } from './health.js';
import {
  COREERP_DB_ENVIRONMENTS,
  getExpectedPrismaMigrations,
  normalizeDatabaseUrl,
  sanitizeDatabaseUrl,
  validateStagingDatabaseUrl,
} from './staging-safety.js';
import {
  CommandExecutionResult,
  buildIsolatedPrismaEnv,
  redactSensitiveText,
} from './staging-verifier.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PRISMA_CLI_PATH = path.resolve(REPO_ROOT, 'node_modules/prisma/build/index.js');

export type IsolatedMigrationTarget = 'dev' | 'test' | 'integration' | 'staging';

export interface IsolatedMigratorDeps {
  checkPortReachable?: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  getExpectedMigrations?: () => string[];
  runPrismaCommand?: (
    args: string[],
    env: Record<string, string>,
    timeoutMs?: number
  ) => Promise<CommandExecutionResult>;
}

export interface IsolatedMigrationOptions {
  target: string;
  execute: boolean;
  env?: Record<string, string | undefined>;
  logger?: {
    log: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
  deps?: IsolatedMigratorDeps;
}

export interface IsolatedMigrationResult {
  exitCode: 0 | 1 | 2;
  target: string;
  mode: 'DRY_RUN' | 'EXECUTE';
  expectedMigrationsCount: number;
  databaseName?: string;
  error?: string;
}

async function defaultRunPrisma(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 120_000
): Promise<CommandExecutionResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [PRISMA_CLI_PATH, ...args],
      {
        cwd: REPO_ROOT,
        env,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
          return;
        }
        const numericCode =
          typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? Number((error as { code?: unknown }).code)
            : 1;
        resolve({
          exitCode: numericCode === 0 ? 1 : numericCode,
          stdout: String(stdout || ''),
          stderr: String(stderr || error.message || ''),
        });
      }
    );
  });
}

export const DEFAULT_UNIT_TEST_DATABASE_URL =
  'postgresql://erp_test_user:erp_test_password@localhost:5433/core_erp_test?schema=public';

export function resolveAndValidateTargetUrl(
  target: string,
  env: Record<string, string | undefined>
): { valid: true; url: string; host: string; port: number; database: string } | { valid: false; error: string } {
  const normalizedTarget = target.trim().toLowerCase();

  if (normalizedTarget === 'prod' || normalizedTarget === 'production') {
    return {
      valid: false,
      error:
        'Automatic production migration via migrate-target-db is prohibited. Production migrations must be executed explicitly via `docker compose --env-file .env.production --profile migration run --rm migration`.',
    };
  }

  if (normalizedTarget === 'staging') {
    const stagingUrl = env.STAGING_DATABASE_URL?.trim();
    const validation = validateStagingDatabaseUrl(stagingUrl, env.DATABASE_URL, {
      testDatabaseUrl: env.TEST_DATABASE_URL,
      shadowDatabaseUrl: env.SHADOW_DATABASE_URL,
    });
    if (!validation.valid || !validation.endpoint || !validation.url) {
      return { valid: false, error: validation.error || 'Invalid STAGING_DATABASE_URL.' };
    }
    return {
      valid: true,
      url: validation.url,
      host: validation.endpoint.hostname,
      port: validation.endpoint.port,
      database: validation.endpoint.database,
    };
  }

  if (normalizedTarget === 'integration') {
    const testUrl = env.TEST_DATABASE_URL?.trim();
    if (!testUrl) {
      return {
        valid: false,
        error:
          'TEST_DATABASE_URL is required for --target integration (never falls back to DATABASE_URL or STAGING_DATABASE_URL).',
      };
    }
    const ep = normalizeDatabaseUrl(testUrl);
    if (!ep) {
      return { valid: false, error: 'TEST_DATABASE_URL is invalid or unparseable.' };
    }
    if (
      ep.hostname !== '127.0.0.1' ||
      ep.port !== COREERP_DB_ENVIRONMENTS.integrationTest.port ||
      ep.database !== COREERP_DB_ENVIRONMENTS.integrationTest.database
    ) {
      return {
        valid: false,
        error: `Integration target must resolve strictly to localhost:${COREERP_DB_ENVIRONMENTS.integrationTest.port}/${COREERP_DB_ENVIRONMENTS.integrationTest.database}.`,
      };
    }
    return { valid: true, url: testUrl, host: ep.hostname, port: ep.port, database: ep.database };
  }

  if (normalizedTarget === 'test') {
    const url = env.UNIT_TEST_DATABASE_URL?.trim() || DEFAULT_UNIT_TEST_DATABASE_URL;
    const ep = normalizeDatabaseUrl(url);
    if (
      !ep ||
      ep.hostname !== '127.0.0.1' ||
      ep.port !== COREERP_DB_ENVIRONMENTS.automatedTest.port ||
      ep.database !== COREERP_DB_ENVIRONMENTS.automatedTest.database
    ) {
      return {
        valid: false,
        error: `Automated test target must resolve strictly to localhost:${COREERP_DB_ENVIRONMENTS.automatedTest.port}/${COREERP_DB_ENVIRONMENTS.automatedTest.database}.`,
      };
    }
    return { valid: true, url, host: ep.hostname, port: ep.port, database: ep.database };
  }

  if (normalizedTarget === 'dev') {
    if (env.NODE_ENV === 'production') {
      return { valid: false, error: 'Cannot run --target dev when NODE_ENV=production.' };
    }
    const devUrl = env.DATABASE_URL?.trim();
    if (!devUrl) {
      return { valid: false, error: 'DATABASE_URL is required for --target dev.' };
    }
    const ep = normalizeDatabaseUrl(devUrl);
    if (
      !ep ||
      ep.hostname !== '127.0.0.1' ||
      ep.port !== COREERP_DB_ENVIRONMENTS.development.port ||
      ep.database !== COREERP_DB_ENVIRONMENTS.development.database
    ) {
      return {
        valid: false,
        error: `Development target must resolve strictly to localhost:${COREERP_DB_ENVIRONMENTS.development.port}/${COREERP_DB_ENVIRONMENTS.development.database}.`,
      };
    }
    return { valid: true, url: devUrl, host: ep.hostname, port: ep.port, database: ep.database };
  }

  return {
    valid: false,
    error: `Unknown migration target "${target}". Approved targets: dev, test, integration, staging.`,
  };
}

/**
 * Executes an isolated, target-validated Prisma migration workflow.
 * - Dry-run by default (`execute: false`): validates target URL and discovers migrations without touching PostgreSQL.
 * - Requires explicit `execute: true` (--execute) before running `prisma migrate deploy`.
 * - Strictly isolates child environment so Prisma can ONLY see the validated target URL.
 */
export async function runIsolatedTargetMigration(
  options: IsolatedMigrationOptions
): Promise<IsolatedMigrationResult> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? {
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
  const deps: Required<IsolatedMigratorDeps> = {
    checkPortReachable: options.deps?.checkPortReachable ?? isPostgresPortReachable,
    getExpectedMigrations: options.deps?.getExpectedMigrations ?? getExpectedPrismaMigrations,
    runPrismaCommand: options.deps?.runPrismaCommand ?? defaultRunPrisma,
  };

  const expectedMigrations = deps.getExpectedMigrations();
  const resolved = resolveAndValidateTargetUrl(options.target, env);

  if (resolved.valid === false) {
    logger.error(`\n❌ [MIGRATION SAFETY REJECTED]: ${resolved.error}\n`);
    return {
      exitCode: 1,
      target: options.target,
      mode: options.execute ? 'EXECUTE' : 'DRY_RUN',
      expectedMigrationsCount: expectedMigrations.length,
      error: resolved.error,
    };
  }

  const redact = (msg: string) =>
    redactSensitiveText(msg, [
      resolved.url,
      env.DATABASE_URL || '',
      env.STAGING_DATABASE_URL || '',
      env.TEST_DATABASE_URL || '',
      env.POSTGRES_PASSWORD || '',
      env.STAGING_POSTGRES_PASSWORD || '',
    ]);

  logger.log(`\nTarget Environment: ${options.target}`);
  logger.log(`Validated Endpoint: ${sanitizeDatabaseUrl(resolved.url)}`);
  logger.log(`Discovered Migrations: ${expectedMigrations.length}`);

  if (!options.execute) {
    logger.log('Mode: DRY_RUN (no database connection or migration executed).');
    logger.log(`To apply pending migrations explicitly, re-run with --target ${options.target} --execute.\n`);
    return {
      exitCode: 0,
      target: options.target,
      mode: 'DRY_RUN',
      expectedMigrationsCount: expectedMigrations.length,
      databaseName: resolved.database,
    };
  }

  const reachable = await deps.checkPortReachable(resolved.host, resolved.port, 3000);
  if (!reachable) {
    const msg = `PostgreSQL target ${resolved.host}:${resolved.port} (${resolved.database}) is not reachable.`;
    logger.warn(`\n⚠️  ${msg}\n`);
    return {
      exitCode: 2,
      target: options.target,
      mode: 'EXECUTE',
      expectedMigrationsCount: expectedMigrations.length,
      databaseName: resolved.database,
      error: msg,
    };
  }

  const isolatedEnv = buildIsolatedPrismaEnv(resolved.url, env);
  const deployRes = await deps.runPrismaCommand(['migrate', 'deploy'], isolatedEnv);
  if (deployRes.exitCode !== 0) {
    const msg = redact(
      `prisma migrate deploy failed for "${resolved.database}" (exit ${deployRes.exitCode}): ${(deployRes.stderr || deployRes.stdout).trim()}`
    );
    logger.error(`\n❌ ${msg}\n`);
    return {
      exitCode: 1,
      target: options.target,
      mode: 'EXECUTE',
      expectedMigrationsCount: expectedMigrations.length,
      databaseName: resolved.database,
      error: msg,
    };
  }

  const statusRes = await deps.runPrismaCommand(['migrate', 'status'], isolatedEnv);
  if (statusRes.exitCode !== 0 || !/Database schema is up to date!/i.test(`${statusRes.stdout}\n${statusRes.stderr}`)) {
    const msg = redact(
      `prisma migrate status did not confirm up-to-date schema for "${resolved.database}".`
    );
    logger.error(`\n❌ ${msg}\n`);
    return {
      exitCode: 1,
      target: options.target,
      mode: 'EXECUTE',
      expectedMigrationsCount: expectedMigrations.length,
      databaseName: resolved.database,
      error: msg,
    };
  }

  logger.log(`✅ All ${expectedMigrations.length} migrations verified cleanly against "${resolved.database}".\n`);
  return {
    exitCode: 0,
    target: options.target,
    mode: 'EXECUTE',
    expectedMigrationsCount: expectedMigrations.length,
    databaseName: resolved.database,
  };
}
