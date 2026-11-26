import crypto from 'crypto';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { sanitizeDatabaseUrl } from '../config/env.js';
import { isPostgresPortReachable } from './health.js';
import {
  AppliedMigrationRecord,
  REQUIRED_STAGING_DECIMAL_COLUMNS,
  REQUIRED_STAGING_UNIQUE_INDEXES,
  SchemaDecimalColumnRecord,
  SchemaIndexRecord,
  getExpectedPrismaMigrations,
  getStagingVerificationSteps,
  validateAppliedMigrations,
  validateSchemaInvariants,
  validateStagingDatabaseUrl,
} from './staging-safety.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PRISMA_CLI_PATH = path.resolve(REPO_ROOT, 'node_modules/prisma/build/index.js');
const TSX_CLI_PATH = path.resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const SERVER_ENTRY_PATH = path.resolve(REPO_ROOT, 'server.ts');

export interface CommandExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface StagingDatabaseInspector {
  verifyConnectivityAndIdentity(): Promise<{
    alive: number;
    databaseName: string;
    schemaName: string;
  }>;
  listAppliedMigrations(): Promise<AppliedMigrationRecord[]>;
  listUniqueIndexes(): Promise<SchemaIndexRecord[]>;
  listDecimalColumns(): Promise<SchemaDecimalColumnRecord[]>;
  listAttendanceSourceEnumValues(): Promise<string[]>;
  disconnect(): Promise<void>;
}

export interface StagingServerHandle {
  port: number;
  baseUrl: string;
  hasExited(): boolean;
  getExitCode(): number | null;
  getCombinedLogs(): string;
  requestGracefulShutdown(timeoutMs?: number): Promise<{
    exited: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    logs: string;
  }>;
  forceKill(): void;
}

export interface HttpProbeResponse {
  status: number;
  body: unknown;
  rawText: string;
}

export interface StagingVerifierLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface StagingVerifierDeps {
  checkPortReachable?: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  getExpectedMigrations?: () => string[];
  runPrismaCommand?: (
    args: string[],
    env: Record<string, string>,
    timeoutMs?: number
  ) => Promise<CommandExecutionResult>;
  createDatabaseInspector?: (databaseUrl: string) => StagingDatabaseInspector;
  startStagingServer?: (options: {
    databaseUrl: string;
    env: Record<string, string>;
    port: number;
  }) => Promise<StagingServerHandle>;
  allocatePort?: () => Promise<number>;
  fetchEndpoint?: (url: string, timeoutMs?: number) => Promise<HttpProbeResponse>;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

export interface StagingVerificationOptions {
  execute: boolean;
  env?: Record<string, string | undefined>;
  logger?: StagingVerifierLogger;
  deps?: StagingVerifierDeps;
  healthWaitTimeoutMs?: number;
  healthPollIntervalMs?: number;
  shutdownTimeoutMs?: number;
}

export interface StagingStepOutcome {
  step: number;
  name: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  detail?: string;
}

export interface StagingVerificationRunResult {
  exitCode: 0 | 1 | 2;
  mode: 'DRY_RUN' | 'EXECUTE';
  databaseName?: string;
  steps: StagingStepOutcome[];
  error?: string;
}

/**
 * Scrubs any raw URLs, credentials, passwords, or ephemeral secrets from output text.
 */
export function redactSensitiveText(text: string, sensitiveValues: readonly string[]): string {
  if (!text) return '';
  let output = text;

  for (const secret of sensitiveValues) {
    if (secret && secret.length >= 4) {
      output = output.split(secret).join('[REDACTED]');
    }
  }

  // Always redact embedded credentials inside any PostgreSQL connection URI
  output = output.replace(
    /(postgres(?:ql)?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi,
    '$1$2:*****@'
  );

  return output;
}

function collectSensitiveValues(values: Array<string | undefined>): string[] {
  const secrets = new Set<string>();
  for (const val of values) {
    if (!val || !val.trim()) continue;
    const trimmed = val.trim();
    secrets.add(trimmed);
    try {
      const parsed = new URL(trimmed);
      if (parsed.password) {
        secrets.add(parsed.password);
        const decoded = decodeURIComponent(parsed.password);
        if (decoded) secrets.add(decoded);
      }
    } catch {
      // Not a URL; raw token/secret is already added
    }
  }
  return Array.from(secrets);
}

/**
 * Builds an explicit, isolated environment for Prisma CLI subprocesses targeting ONLY
 * the validated staging URL. Strips conflicting DB/integration/dev credential variables.
 */
export function buildIsolatedPrismaEnv(
  validatedStagingUrl: string,
  baseEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  const isolated: Record<string, string> = {};
  const blockedKeys = new Set([
    'DATABASE_URL',
    'STAGING_DATABASE_URL',
    'TEST_DATABASE_URL',
    'COREERP_INTEGRATION_TEST_MODE',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_DB',
    'BOOTSTRAP_SUPER_ADMIN_PASSWORD',
  ]);

  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined && !blockedKeys.has(k)) {
      isolated[k] = v;
    }
  }

  isolated.DATABASE_URL = validatedStagingUrl;
  return isolated;
}

/**
 * Builds an explicit, isolated environment for the temporary staging verification server.
 * Uses freshly generated ephemeral cryptographic secrets (never production secrets) and
 * disables the background auto-checkout scheduler so zero application rows are mutated.
 */
export function buildIsolatedServerEnv(
  validatedStagingUrl: string,
  port: number,
  baseEnv: Record<string, string | undefined> = process.env
): { env: Record<string, string>; ephemeralSecrets: string[] } {
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const bankEncryptionKey = crypto.randomBytes(32).toString('hex');

  const base = buildIsolatedPrismaEnv(validatedStagingUrl, baseEnv);
  delete base.SESSION_SECRET;
  delete base.BANK_ENCRYPTION_KEY;
  delete base.BANK_HISTORICAL_KEYS;
  delete base.BIOMETRIC_BRIDGE_TOKEN;
  delete base.BOOTSTRAP_SUPER_ADMIN_EMAIL;
  delete base.BOOTSTRAP_COMPANY_NAME;
  delete base.BOOTSTRAP_COMPANY_CODE;

  const env: Record<string, string> = {
    ...base,
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: validatedStagingUrl,
    TEST_DATABASE_URL: '',
    COREERP_INTEGRATION_TEST_MODE: '',
    SESSION_SECRET: sessionSecret,
    BANK_ENCRYPTION_KEY: bankEncryptionKey,
    BANK_ACTIVE_KEY_ID: 'k1',
    BANK_HISTORICAL_KEYS: '',
    DISABLE_AUTO_CHECKOUT_SCHEDULER: 'true',
  };

  return {
    env,
    ephemeralSecrets: [sessionSecret, bankEncryptionKey],
  };
}

async function defaultAllocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to allocate ephemeral localhost port for staging server.'));
        return;
      }
      const allocatedPort = addr.port;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(allocatedPort);
      });
    });
  });
}

async function defaultRunPrismaCommand(
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

function defaultCreateDatabaseInspector(databaseUrl: string): StagingDatabaseInspector {
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [],
  });

  return {
    async verifyConnectivityAndIdentity() {
      const rows = await client.$queryRaw<
        Array<{ alive: number; db_name: string; schema_name: string }>
      >`SELECT 1 AS alive, current_database() AS db_name, current_schema() AS schema_name`;
      const row = rows[0];
      if (!row) {
        throw new Error('Connectivity identity probe returned no rows.');
      }
      return {
        alive: Number(row.alive),
        databaseName: String(row.db_name || ''),
        schemaName: String(row.schema_name || ''),
      };
    },

    async listAppliedMigrations() {
      return client.$queryRaw<AppliedMigrationRecord[]>`
        SELECT migration_name, finished_at, rolled_back_at, applied_steps_count, logs
        FROM "_prisma_migrations"
        ORDER BY started_at ASC
      `;
    },

    async listUniqueIndexes() {
      const tableNames = Array.from(new Set(REQUIRED_STAGING_UNIQUE_INDEXES.map((r) => r.table)));
      return client.$queryRaw<SchemaIndexRecord[]>`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = ANY(${tableNames}::text[])
      `;
    },

    async listDecimalColumns() {
      const tableNames = Array.from(new Set(REQUIRED_STAGING_DECIMAL_COLUMNS.map((r) => r.table)));
      return client.$queryRaw<SchemaDecimalColumnRecord[]>`
        SELECT table_name, column_name, data_type,
               numeric_precision::int AS numeric_precision,
               numeric_scale::int AS numeric_scale
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY(${tableNames}::text[])
      `;
    },

    async listAttendanceSourceEnumValues() {
      const rows = await client.$queryRaw<Array<{ enumlabel: string }>>`
        SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'AttendanceSource'
          AND n.nspname = current_schema()
        ORDER BY e.enumsortorder ASC
      `;
      return rows.map((r) => r.enumlabel);
    },

    async disconnect() {
      await client.$disconnect();
    },
  };
}

async function defaultStartStagingServer(options: {
  databaseUrl: string;
  env: Record<string, string>;
  port: number;
}): Promise<StagingServerHandle> {
  const child = spawn(
    process.execPath,
    [TSX_CLI_PATH, SERVER_ENTRY_PATH, '--port', String(options.port)],
    {
      cwd: REPO_ROOT,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const logChunks: string[] = [];

  child.stdout?.on('data', (chunk: Buffer) => {
    logChunks.push(chunk.toString('utf-8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    logChunks.push(chunk.toString('utf-8'));
  });

  const exitPromise = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolve({ exitCode: code, signal });
    });
    child.once('error', (err) => {
      exited = true;
      exitCode = 1;
      logChunks.push(`Spawn error: ${err.message}\n`);
      resolve({ exitCode: 1, signal: null });
    });
  });

  return {
    port: options.port,
    baseUrl: `http://127.0.0.1:${options.port}`,
    hasExited: () => exited,
    getExitCode: () => exitCode,
    getCombinedLogs: () => logChunks.join(''),
    async requestGracefulShutdown(timeoutMs = 10_000) {
      if (exited) {
        return {
          exited: true,
          exitCode,
          signal: exitSignal,
          logs: logChunks.join(''),
        };
      }

      child.kill('SIGTERM');

      const result = await Promise.race([
        exitPromise.then((res) => ({ exited: true, ...res })),
        new Promise<{ exited: false; exitCode: null; signal: null }>((resolve) => {
          const timer = setTimeout(() => {
            resolve({ exited: false, exitCode: null, signal: null });
          }, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);

      return {
        ...result,
        logs: logChunks.join(''),
      };
    },
    forceKill() {
      if (!exited) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already terminated
        }
      }
    },
  };
}

async function defaultFetchEndpoint(url: string, timeoutMs = 5_000): Promise<HttpProbeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const res = await fetch(url, { signal: controller.signal });
    const rawText = await res.text();
    let body: unknown = null;
    try {
      body = rawText ? JSON.parse(rawText) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, rawText };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMigrationStatusHealthy(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  if (/Database schema is up to date!/i.test(combined)) {
    return true;
  }
  return false;
}

/**
 * Executes CoreERP's fail-closed staging database verification workflow.
 * - Without `execute: true`, performs preparation-only safety validation without any network/DB I/O.
 * - With `execute: true`, runs strictly against the validated disposable staging URL and
 *   NEVER falls back to DATABASE_URL or mutates application data.
 */
export async function runStagingVerification(
  options: StagingVerificationOptions
): Promise<StagingVerificationRunResult> {
  const env = options.env ?? process.env;
  const logger: StagingVerifierLogger = options.logger ?? {
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };

  const deps: Required<StagingVerifierDeps> = {
    checkPortReachable: options.deps?.checkPortReachable ?? isPostgresPortReachable,
    getExpectedMigrations: options.deps?.getExpectedMigrations ?? getExpectedPrismaMigrations,
    runPrismaCommand: options.deps?.runPrismaCommand ?? defaultRunPrismaCommand,
    createDatabaseInspector: options.deps?.createDatabaseInspector ?? defaultCreateDatabaseInspector,
    startStagingServer: options.deps?.startStagingServer ?? defaultStartStagingServer,
    allocatePort: options.deps?.allocatePort ?? defaultAllocatePort,
    fetchEndpoint: options.deps?.fetchEndpoint ?? defaultFetchEndpoint,
    sleep: options.deps?.sleep ?? defaultSleep,
    platform: options.deps?.platform ?? process.platform,
  };

  const targetUrl = env.STAGING_DATABASE_URL?.trim() || env.TEST_DATABASE_URL?.trim() || undefined;
  const primaryDbUrl = env.DATABASE_URL?.trim() || undefined;
  const sensitiveValues = collectSensitiveValues([targetUrl, primaryDbUrl]);
  const redact = (msg: string) => redactSensitiveText(msg, sensitiveValues);

  const stepOutcomes: StagingStepOutcome[] = [];

  logger.log('\n================================================================');
  logger.log('   CoreERP Staging Database Verification Runner');
  logger.log('================================================================\n');

  // Step 1: Safety & Environment Pre-Flight (NO DB connection)
  logger.log('1. Target Database Safety Inspection:');
  logger.log(
    `   - STAGING_DATABASE_URL: ${targetUrl ? sanitizeDatabaseUrl(targetUrl) : '[NOT SET]'}`
  );
  logger.log(
    `   - Primary DATABASE_URL: ${primaryDbUrl ? sanitizeDatabaseUrl(primaryDbUrl) : '[NOT SET]'}`
  );

  const validation = validateStagingDatabaseUrl(targetUrl, primaryDbUrl);
  if (!validation.valid || !validation.endpoint || !validation.url || !validation.databaseName) {
    const safeError = redact(validation.error || 'Target staging database URL failed validation.');
    stepOutcomes.push({
      step: 1,
      name: 'Safety & Environment Pre-Flight',
      status: 'FAILED',
      detail: safeError,
    });
    logger.error(`\n❌ [SAFETY CHECK FAILED]: ${safeError}\n`);
    logger.log('Guidance:');
    logger.log('  1. Staging verification requires an isolated, disposable database.');
    logger.log('  2. Configure STAGING_DATABASE_URL or TEST_DATABASE_URL with a database name');
    logger.log(
      '     containing "test", "staging", or "disposable" (e.g. core_erp_staging or core_erp_test).'
    );
    logger.log('  3. Example (Local Docker on port 5433 from docker-compose.dev.yml):');
    logger.log(
      '     export STAGING_DATABASE_URL="postgresql://erp_test_user:<auth_secret>@localhost:5433/core_erp_test?schema=public"'
    );
    logger.log('  4. Silent fallback to DATABASE_URL is strictly prohibited.\n');
    return {
      exitCode: 1,
      mode: options.execute ? 'EXECUTE' : 'DRY_RUN',
      steps: stepOutcomes,
      error: safeError,
    };
  }

  let expectedMigrations: string[];
  try {
    expectedMigrations = deps.getExpectedMigrations();
  } catch (err: unknown) {
    const safeError = redact(err instanceof Error ? err.message : String(err));
    stepOutcomes.push({
      step: 1,
      name: 'Safety & Environment Pre-Flight',
      status: 'FAILED',
      detail: safeError,
    });
    logger.error(`\n❌ [MIGRATION DISCOVERY FAILED]: ${safeError}\n`);
    return {
      exitCode: 1,
      mode: options.execute ? 'EXECUTE' : 'DRY_RUN',
      databaseName: validation.databaseName,
      steps: stepOutcomes,
      error: safeError,
    };
  }

  stepOutcomes.push({
    step: 1,
    name: 'Safety & Environment Pre-Flight',
    status: 'PASSED',
    detail: `Validated isolated disposable target "${validation.databaseName}" (${expectedMigrations.length} expected migrations).`,
  });

  logger.log(`   ✔ Safety validation PASSED for database "${validation.databaseName}".`);
  logger.log('   ✔ Target is confirmed isolated and disposable (non-production).');
  logger.log(`   ✔ Discovered ${expectedMigrations.length} versioned migration directories.`);

  logger.log('\n2. Planned Staging Verification Steps:');
  const plannedSteps = getStagingVerificationSteps();
  for (const s of plannedSteps) {
    logger.log(`   [Step ${s.step}] ${s.name}`);
    logger.log(`           ${s.description}`);
  }

  if (!options.execute) {
    logger.log('\n----------------------------------------------------------------');
    logger.log('NOTICE: Running in PREPARATION-ONLY mode.');
    logger.log('No database connections or modifications were made.');
    logger.log('When authorized, run with --execute to perform live staging checks.');
    logger.log('----------------------------------------------------------------\n');
    return {
      exitCode: 0,
      mode: 'DRY_RUN',
      databaseName: validation.databaseName,
      steps: stepOutcomes,
    };
  }

  logger.log('\n3. Executing Staging Checks against Disposable Target...');

  // Step 2: TCP Network & Port Reachability Probe (before ANY Prisma invocation)
  const { hostname: host, port } = validation.endpoint;
  const isReachable = await deps.checkPortReachable(host, port, 3000);
  if (!isReachable) {
    const msg = `PostgreSQL target at ${host}:${port} is not currently reachable.`;
    stepOutcomes.push({
      step: 2,
      name: 'Network & Port Reachability Probe',
      status: 'FAILED',
      detail: msg,
    });
    logger.warn(`\n⚠️  ${msg}`);
    logger.warn(
      '   Ensure your staging PostgreSQL container is running (e.g., docker compose -f docker-compose.dev.yml up -d postgres-test).'
    );
    return {
      exitCode: 2,
      mode: 'EXECUTE',
      databaseName: validation.databaseName,
      steps: stepOutcomes,
      error: msg,
    };
  }

  stepOutcomes.push({
    step: 2,
    name: 'Network & Port Reachability Probe',
    status: 'PASSED',
    detail: `TCP port ${host}:${port} is accepting connections.`,
  });
  logger.log(`   ✔ [Step 2] TCP port ${host}:${port} is open and accepting connections.`);

  // Step 3: Migration Deployment, Status, Connectivity & Database Identity Verification
  const isolatedPrismaEnv = buildIsolatedPrismaEnv(validation.url, env);
  const deployResult = await deps.runPrismaCommand(['migrate', 'deploy'], isolatedPrismaEnv);
  if (deployResult.exitCode !== 0) {
    const detail = redact(
      `prisma migrate deploy failed with exit code ${deployResult.exitCode}: ${(deployResult.stderr || deployResult.stdout).trim()}`
    );
    stepOutcomes.push({
      step: 3,
      name: 'Migration Deployment & History Integrity',
      status: 'FAILED',
      detail,
    });
    logger.error(`\n❌ [Step 3 FAILED] ${detail}`);
    return {
      exitCode: 1,
      mode: 'EXECUTE',
      databaseName: validation.databaseName,
      steps: stepOutcomes,
      error: detail,
    };
  }

  const statusResult = await deps.runPrismaCommand(['migrate', 'status'], isolatedPrismaEnv);
  if (
    statusResult.exitCode !== 0 ||
    !isMigrationStatusHealthy(statusResult.stdout, statusResult.stderr)
  ) {
    const detail = redact(
      `prisma migrate status did not confirm an up-to-date schema (exit ${statusResult.exitCode}): ${(statusResult.stderr || statusResult.stdout).trim()}`
    );
    stepOutcomes.push({
      step: 3,
      name: 'Migration Deployment & History Integrity',
      status: 'FAILED',
      detail,
    });
    logger.error(`\n❌ [Step 3 FAILED] ${detail}`);
    return {
      exitCode: 1,
      mode: 'EXECUTE',
      databaseName: validation.databaseName,
      steps: stepOutcomes,
      error: detail,
    };
  }

  const inspector = deps.createDatabaseInspector(validation.url);
  try {
    // Verify live query connectivity AND confirm exact PostgreSQL database identity
    const identity = await inspector.verifyConnectivityAndIdentity();
    if (identity.alive !== 1) {
      throw new Error('PostgreSQL connectivity probe failed (alive !== 1).');
    }
    if (identity.databaseName.toLowerCase() !== validation.endpoint.database.toLowerCase()) {
      throw new Error(
        `Connected PostgreSQL database identity mismatch: expected "${validation.endpoint.database}", got "${identity.databaseName}". Failing closed.`
      );
    }

    // Verify _prisma_migrations against actual migration directories
    const appliedRows = await inspector.listAppliedMigrations();
    const migrationCheck = validateAppliedMigrations(expectedMigrations, appliedRows);
    if (!migrationCheck.valid) {
      throw new Error(migrationCheck.error || 'Migration history verification failed.');
    }

    stepOutcomes.push({
      step: 3,
      name: 'Migration Deployment & History Integrity',
      status: 'PASSED',
      detail: `Confirmed database "${identity.databaseName}" with all ${migrationCheck.appliedCount}/${migrationCheck.expectedCount} migrations applied cleanly.`,
    });
    logger.log(
      `   ✔ [Step 3] Verified database "${identity.databaseName}" connectivity and all ${migrationCheck.appliedCount}/${migrationCheck.expectedCount} versioned migrations.`
    );

    // Step 4: Read-only schema constraints, Decimal precision, and AttendanceSource enum
    const [indexes, decimalColumns, attendanceSourceValues] = await Promise.all([
      inspector.listUniqueIndexes(),
      inspector.listDecimalColumns(),
      inspector.listAttendanceSourceEnumValues(),
    ]);
    const schemaCheck = validateSchemaInvariants({
      indexes,
      decimalColumns,
      attendanceSourceValues,
    });
    if (!schemaCheck.valid) {
      const detail = redact(schemaCheck.error || 'Schema invariant verification failed.');
      stepOutcomes.push({
        step: 4,
        name: 'Schema Constraints, Precision & Enum Verification',
        status: 'FAILED',
        detail,
      });
      logger.error(`\n❌ [Step 4 FAILED] ${detail}`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        databaseName: validation.databaseName,
        steps: stepOutcomes,
        error: detail,
      };
    }

    stepOutcomes.push({
      step: 4,
      name: 'Schema Constraints, Precision & Enum Verification',
      status: 'PASSED',
      detail:
        'Verified unique indexes, Decimal(18,6) & Decimal(18,4) column precisions, and AttendanceSource enum values (read-only).',
    });
    logger.log(
      '   ✔ [Step 4] Verified required unique indexes, Decimal precisions, and AttendanceSource enum values (read-only).'
    );
  } catch (err: unknown) {
    const detail = redact(err instanceof Error ? err.message : String(err));
    const failedStepNum = stepOutcomes.some((s) => s.step === 3 && s.status === 'PASSED') ? 4 : 3;
    stepOutcomes.push({
      step: failedStepNum,
      name:
        failedStepNum === 3
          ? 'Migration Deployment & History Integrity'
          : 'Schema Constraints, Precision & Enum Verification',
      status: 'FAILED',
      detail,
    });
    logger.error(`\n❌ [Step ${failedStepNum} FAILED] ${detail}`);
    return {
      exitCode: 1,
      mode: 'EXECUTE',
      databaseName: validation.databaseName,
      steps: stepOutcomes,
      error: detail,
    };
  } finally {
    await inspector.disconnect().catch(() => {
      // Best-effort cleanup of inspection client
    });
  }

  // Step 5 & 6: Dedicated Staging Server Process -> /api/health, /api/ready, and Graceful Shutdown
  let serverHandle: StagingServerHandle | null = null;
  let serverSecrets: string[] = [];

  try {
    const serverPort = await deps.allocatePort();
    const built = buildIsolatedServerEnv(validation.url, serverPort, env);
    serverSecrets = built.ephemeralSecrets;

    serverHandle = await deps.startStagingServer({
      databaseUrl: validation.url,
      env: built.env,
      port: serverPort,
    });

    const redactAll = (msg: string) =>
      redactSensitiveText(msg, [...sensitiveValues, ...serverSecrets]);

    const waitTimeoutMs = options.healthWaitTimeoutMs ?? 15_000;
    const pollIntervalMs = options.healthPollIntervalMs ?? 250;
    const deadline = Date.now() + waitTimeoutMs;

    let healthResponse: HttpProbeResponse | null = null;
    let lastHealthError = '';

    while (Date.now() <= deadline) {
      if (serverHandle.hasExited()) {
        throw new Error(
          redactAll(
            `Dedicated staging server exited prematurely with code ${String(serverHandle.getExitCode())}.`
          )
        );
      }
      try {
        const probe = await deps.fetchEndpoint(`${serverHandle.baseUrl}/api/health`, 3_000);
        healthResponse = probe;
        break;
      } catch (err: unknown) {
        lastHealthError = err instanceof Error ? err.message : String(err);
        await deps.sleep(pollIntervalMs);
      }
    }

    if (!healthResponse) {
      throw new Error(
        redactAll(
          `Timed out waiting for dedicated staging server /api/health after ${waitTimeoutMs}ms (${lastHealthError || 'no response'}).`
        )
      );
    }

    const healthBody = healthResponse.body as Record<string, unknown> | null;
    if (healthResponse.status !== 200 || !healthBody || healthBody.status !== 'ok') {
      throw new Error(
        redactAll(
          `GET /api/health failed: expected HTTP 200 with status="ok", received HTTP ${healthResponse.status} (${healthResponse.rawText.slice(0, 200)}).`
        )
      );
    }

    const readyResponse = await deps.fetchEndpoint(`${serverHandle.baseUrl}/api/ready`, 5_000);
    const readyBody = readyResponse.body as {
      status?: unknown;
      checks?: { postgres?: { status?: unknown } };
    } | null;

    if (
      readyResponse.status !== 200 ||
      !readyBody ||
      readyBody.status !== 'ready' ||
      readyBody.checks?.postgres?.status !== 'connected'
    ) {
      throw new Error(
        redactAll(
          `GET /api/ready failed: expected HTTP 200 with status="ready" and checks.postgres.status="connected", received HTTP ${readyResponse.status} (${readyResponse.rawText.slice(0, 200)}).`
        )
      );
    }

    stepOutcomes.push({
      step: 5,
      name: 'Health & Readiness Endpoint Validation',
      status: 'PASSED',
      detail: `GET /api/health (200 ok) and GET /api/ready (200 ready, postgres=connected) passed on ephemeral port ${serverPort}.`,
    });
    logger.log(
      `   ✔ [Step 5] Verified GET /api/health (200) and GET /api/ready (200, postgres=connected) on 127.0.0.1:${serverPort}.`
    );

    // Step 6: Graceful Shutdown & Prisma Pool Disconnect
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    const shutdownResult = await serverHandle.requestGracefulShutdown(shutdownTimeoutMs);
    if (!shutdownResult.exited) {
      serverHandle.forceKill();
      throw new Error(
        `Dedicated staging server did not exit cleanly within ${shutdownTimeoutMs}ms after SIGTERM.`
      );
    }

    if (deps.platform !== 'win32') {
      if (shutdownResult.exitCode !== 0) {
        throw new Error(
          `Dedicated staging server exited with non-zero code ${String(shutdownResult.exitCode)} during graceful shutdown.`
        );
      }
      if (
        !shutdownResult.logs.includes('HTTP server closed.') ||
        !shutdownResult.logs.includes('PostgreSQL connections closed.')
      ) {
        throw new Error(
          'Graceful shutdown did not confirm HTTP server closure and Prisma pool disconnect.'
        );
      }
    }

    stepOutcomes.push({
      step: 6,
      name: 'Graceful Shutdown & Pool Drain',
      status: 'PASSED',
      detail: 'Dedicated staging server exited cleanly after HTTP close and Prisma disconnect.',
    });
    logger.log(
      '   ✔ [Step 6] Verified graceful SIGTERM shutdown and Prisma connection pool disconnect.'
    );
    logger.log('\n✅ All 6 staging verification steps PASSED.\n');

    return {
      exitCode: 0,
      mode: 'EXECUTE',
      databaseName: validation.databaseName,
      steps: stepOutcomes,
    };
  } catch (err: unknown) {
    if (serverHandle && !serverHandle.hasExited()) {
      await serverHandle.requestGracefulShutdown(2_000).catch(() => {});
      serverHandle.forceKill();
    }
    const detail = redactSensitiveText(err instanceof Error ? err.message : String(err), [
      ...sensitiveValues,
      ...serverSecrets,
    ]);
    const failedStepNum = stepOutcomes.some((s) => s.step === 5 && s.status === 'PASSED') ? 6 : 5;
    stepOutcomes.push({
      step: failedStepNum,
      name:
        failedStepNum === 5
          ? 'Health & Readiness Endpoint Validation'
          : 'Graceful Shutdown & Pool Drain',
      status: 'FAILED',
      detail,
    });
    logger.error(`\n❌ [Step ${failedStepNum} FAILED] ${detail}`);
    return {
      exitCode: 1,
      mode: 'EXECUTE',
      databaseName: validation.databaseName,
      steps: stepOutcomes,
      error: detail,
    };
  }
}
