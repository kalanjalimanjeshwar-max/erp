import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { sanitizeDatabaseUrl } from '../config/env.js';

export const CANONICAL_DEV_USER = 'erp_user';
export const CANONICAL_DEV_PASSWORD = 'erp_password_dev';
export const CANONICAL_DEV_DB = 'core_erp';
export const CANONICAL_DEV_PORT = 5432;
export const CANONICAL_DEV_CONTAINER = 'coreerp-postgres-dev';

export const APPROVED_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface DevPreconditionOptions {
  nodeEnv?: string;
  integrationMode?: string;
  containerName?: string;
  databaseUrl?: string;
  targetRole?: string;
  targetDb?: string;
  targetPort?: number;
}

export interface DevPreconditionResult {
  valid: boolean;
  error?: string;
  sanitizedEndpoint?: string;
  details?: {
    containerName: string;
    database: string;
    role: string;
    port: number;
    host: string;
  };
}

/**
 * Validates that credential synchronization is strictly and exclusively targeted
 * at the local development PostgreSQL environment.
 *
 * Safety Invariants:
 * 1. Strictly rejects production environments (NODE_ENV=production).
 * 2. Strictly rejects integration-test mode (COREERP_INTEGRATION_TEST_MODE=true).
 * 3. Strictly validates container identity (coreerp-postgres-dev).
 * 4. Strictly validates database identity (core_erp).
 * 5. Strictly validates role identity (erp_user). Never assumes or falls back to 'postgres'.
 * 6. Strictly validates port (5432) and loopback host (localhost / 127.0.0.1).
 * 7. Fails closed on any remote, production, staging, or integration targets.
 */
export function validateDevSyncPreconditions(
  options?: DevPreconditionOptions
): DevPreconditionResult {
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const isIntegration =
    options?.integrationMode ?? process.env.COREERP_INTEGRATION_TEST_MODE ?? 'false';

  if (nodeEnv === 'production') {
    return {
      valid: false,
      error:
        '[SECURITY VIOLATION] Development credential synchronization is strictly forbidden in production mode.',
    };
  }

  if (isIntegration === 'true') {
    return {
      valid: false,
      error:
        '[SECURITY VIOLATION] Development credential synchronization is strictly forbidden in integration-test mode.',
    };
  }

  const containerName = options?.containerName ?? CANONICAL_DEV_CONTAINER;
  if (containerName !== CANONICAL_DEV_CONTAINER) {
    return {
      valid: false,
      error: `[SAFETY VIOLATION] Target container must be exactly "${CANONICAL_DEV_CONTAINER}". Received "${containerName}".`,
    };
  }

  const rawUrl = options?.databaseUrl ?? process.env.DATABASE_URL ?? '';
  const cleanUrl = rawUrl.trim().replace(/^["']|["']$/g, '');

  if (!cleanUrl) {
    return {
      valid: false,
      error: '[SAFETY VIOLATION] DATABASE_URL is not configured.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return {
      valid: false,
      error: '[SAFETY VIOLATION] DATABASE_URL is not a valid URL.',
    };
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return {
      valid: false,
      error: `[SAFETY VIOLATION] Unsupported protocol "${parsed.protocol}". Expected postgresql.`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!APPROVED_LOCAL_HOSTS.has(host)) {
    return {
      valid: false,
      error: `[SECURITY VIOLATION] Remote hosts are strictly forbidden for dev credential sync. Expected localhost or 127.0.0.1, got "${host}".`,
    };
  }

  const port = parseInt(parsed.port || '5432', 10);
  if (port !== CANONICAL_DEV_PORT) {
    return {
      valid: false,
      error: `[SECURITY VIOLATION] Port must be development port ${CANONICAL_DEV_PORT}. Ports 5433 (staging) and 5434 (integration) are strictly forbidden. Received port ${port}.`,
    };
  }

  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (dbName !== CANONICAL_DEV_DB) {
    return {
      valid: false,
      error: `[SAFETY VIOLATION] Target database must be exactly "${CANONICAL_DEV_DB}". Received "${dbName}".`,
    };
  }

  const user = decodeURIComponent(parsed.username || '');
  const expectedRole = options?.targetRole ?? CANONICAL_DEV_USER;
  if (user !== expectedRole) {
    return {
      valid: false,
      error: `[SAFETY VIOLATION] Target role must be exactly "${expectedRole}". Received "${user}". Do not assume a postgres role exists.`,
    };
  }

  const sanitizedEndpoint = sanitizeDatabaseUrl(cleanUrl);

  return {
    valid: true,
    sanitizedEndpoint,
    details: {
      containerName,
      database: dbName,
      role: user,
      port,
      host,
    },
  };
}

/**
 * Verifies that the .env file (or parent directory) has write permissions
 * before executing any database changes.
 */
export function verifyEnvFileWritable(envFilePath: string): { writable: boolean; error?: string } {
  try {
    if (fs.existsSync(envFilePath)) {
      fs.accessSync(envFilePath, fs.constants.W_OK | fs.constants.R_OK);
    } else {
      const parentDir = path.dirname(path.resolve(envFilePath));
      fs.accessSync(parentDir, fs.constants.W_OK);
    }
    return { writable: true };
  } catch (err: unknown) {
    return {
      writable: false,
      error: `Cannot write to "${envFilePath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface SyncEnvFileResult {
  updated: boolean;
  alreadySynchronized: boolean;
  sanitizedPreviousUrl: string;
  sanitizedCurrentUrl: string;
}

/**
 * Atomically synchronizes DATABASE_URL and POSTGRES_* credentials in a local .env file.
 *
 * Safety & Atomicity Guarantees:
 * - Writes to a temporary file (.env.tmp.<timestamp>) first, then atomically replaces via rename.
 * - Preserves all comments (# ...), empty lines, whitespace, and unrelated variables.
 * - Redacts credentials from all diagnostic return values.
 */
export function syncEnvFileDatabaseUrl(
  envFilePath: string = path.resolve(process.cwd(), '.env'),
  options?: { targetPassword?: string }
): SyncEnvFileResult {
  const newPassword = options?.targetPassword ?? CANONICAL_DEV_PASSWORD;

  if (!fs.existsSync(envFilePath)) {
    const defaultEnv = [
      'PORT=3000',
      'NODE_ENV=development',
      `POSTGRES_USER="${CANONICAL_DEV_USER}"`,
      `POSTGRES_PASSWORD="${newPassword}"`,
      `POSTGRES_DB="${CANONICAL_DEV_DB}"`,
      `DATABASE_URL="postgresql://${CANONICAL_DEV_USER}:${newPassword}@localhost:${CANONICAL_DEV_PORT}/${CANONICAL_DEV_DB}?schema=public"`,
      'TEST_DATABASE_URL="postgresql://erp_test_user:dev_test_password@localhost:5433/core_erp_test?schema=public"',
      'STAGING_DATABASE_URL="postgresql://erp_test_user:dev_test_password@localhost:5433/core_erp_staging?schema=public"',
      'SESSION_SECRET="dev_insecure_fallback_session_secret_32_chars_long"',
      'BIOMETRIC_BRIDGE_TOKEN="dev_biometric_bridge_secret_token_123456"',
      '',
    ].join('\n');

    const tempPath = `${envFilePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, defaultEnv, 'utf-8');
    fs.renameSync(tempPath, envFilePath);

    return {
      updated: true,
      alreadySynchronized: false,
      sanitizedPreviousUrl: '[NEW_FILE_CREATED]',
      sanitizedCurrentUrl: `postgresql://${CANONICAL_DEV_USER}:*****@localhost:${CANONICAL_DEV_PORT}/${CANONICAL_DEV_DB}?schema=public`,
    };
  }

  const rawContent = fs.readFileSync(envFilePath, 'utf-8');
  const lines = rawContent.split(/\r?\n/);

  let databaseUrlFound = false;
  let alreadySynchronized = false;
  let sanitizedPrev = '[NOT_FOUND]';
  let sanitizedCurr = '[NOT_SET]';

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return line;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      return line;
    }

    const key = line.slice(0, eqIdx).trim();
    const rawVal = line.slice(eqIdx + 1).trim();

    if (key === 'DATABASE_URL') {
      databaseUrlFound = true;
      const quoteChar =
        rawVal.startsWith('"') && rawVal.endsWith('"')
          ? '"'
          : rawVal.startsWith("'") && rawVal.endsWith("'")
          ? "'"
          : '';

      const unquoted = quoteChar ? rawVal.slice(1, -1) : rawVal;
      sanitizedPrev = sanitizeDatabaseUrl(unquoted);

      try {
        const parsed = new URL(unquoted);
        const currentPass = decodeURIComponent(parsed.password || '');
        if (currentPass === newPassword) {
          alreadySynchronized = true;
          sanitizedCurr = sanitizedPrev;
          return line;
        }

        parsed.password = encodeURIComponent(newPassword);
        const updatedUrl = parsed.toString();
        sanitizedCurr = sanitizeDatabaseUrl(updatedUrl);

        const wrappedVal = quoteChar ? `${quoteChar}${updatedUrl}${quoteChar}` : `"${updatedUrl}"`;
        return `${line.slice(0, eqIdx)}=${wrappedVal}`;
      } catch {
        const canonical = `postgresql://${CANONICAL_DEV_USER}:${newPassword}@localhost:${CANONICAL_DEV_PORT}/${CANONICAL_DEV_DB}?schema=public`;
        sanitizedCurr = sanitizeDatabaseUrl(canonical);
        return `DATABASE_URL="${canonical}"`;
      }
    }

    if (key === 'POSTGRES_PASSWORD') {
      const quoteChar =
        rawVal.startsWith('"') && rawVal.endsWith('"')
          ? '"'
          : rawVal.startsWith("'") && rawVal.endsWith("'")
          ? "'"
          : '"';
      return `POSTGRES_PASSWORD=${quoteChar}${newPassword}${quoteChar}`;
    }

    return line;
  });

  if (!databaseUrlFound) {
    const canonical = `postgresql://${CANONICAL_DEV_USER}:${newPassword}@localhost:${CANONICAL_DEV_PORT}/${CANONICAL_DEV_DB}?schema=public`;
    updatedLines.push(`DATABASE_URL="${canonical}"`);
    sanitizedCurr = sanitizeDatabaseUrl(canonical);
  }

  const finalContent = updatedLines.join('\n');
  const wasUpdated = finalContent !== rawContent;

  if (wasUpdated) {
    // Atomic file replacement to prevent partial or corrupted file states
    const tempPath = `${envFilePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, finalContent, 'utf-8');
    fs.renameSync(tempPath, envFilePath);
  }

  return {
    updated: wasUpdated,
    alreadySynchronized,
    sanitizedPreviousUrl: sanitizedPrev,
    sanitizedCurrentUrl: sanitizedCurr,
  };
}

/**
 * Generates the idempotent SQL statement to synchronize the development PostgreSQL role password.
 * Uses exact quoting to prevent injection.
 */
export function generateRoleSyncSql(
  role: string = CANONICAL_DEV_USER,
  password: string = CANONICAL_DEV_PASSWORD
): string {
  const safeRole = role.replace(/"/g, '""');
  const safePass = password.replace(/'/g, "''");
  return `ALTER ROLE "${safeRole}" WITH PASSWORD '${safePass}';\n`;
}

/**
 * Generates the verification SQL to check role existence and superuser privilege.
 */
export function generateRoleVerificationSql(role: string = CANONICAL_DEV_USER): string {
  const safeRole = role.replace(/'/g, "''");
  return `SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = '${safeRole}';\n`;
}

export interface VerifyRoleResult {
  verified: boolean;
  role: string;
  isSuperuser: boolean;
  canLogin: boolean;
  error?: string;
}

export type StdinCommandRunner = (
  args: string[],
  stdinInput: string,
  timeoutMs?: number
) => Promise<{ code: number; stdout: string; stderr: string; spawnError?: Error }>;

/**
 * Default runner invoking docker CLI with piped stdin.
 */
export const defaultDockerStdinRunner: StdinCommandRunner = async (
  args: string[],
  stdinInput: string,
  timeoutMs = 5000
) => {
  return new Promise((resolve) => {
    const child = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let isSettled = false;

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        try {
          child.kill();
        } catch {}
        resolve({
          code: -1,
          stdout,
          stderr: `[TIMEOUT] docker command timed out after ${timeoutMs}ms.`,
        });
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({
          code: -1,
          stdout,
          stderr: err.message,
          spawnError: err,
        });
      }
    });

    child.on('close', (code) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({
          code: code ?? -1,
          stdout,
          stderr,
        });
      }
    });

    try {
      child.stdin.write(stdinInput);
      child.stdin.end();
    } catch (e: unknown) {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({
          code: -1,
          stdout,
          stderr: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });
};

/**
 * Verifies that the initialized role (erp_user) exists and has superuser privileges
 * by connecting directly as erp_user over the local Unix socket.
 *
 * Invariant: Never assumes a 'postgres' role exists. Uses erp_user explicitly.
 */
export async function verifyPostgresRoleViaStdin(options?: {
  containerName?: string;
  database?: string;
  role?: string;
  runner?: StdinCommandRunner;
  timeoutMs?: number;
}): Promise<VerifyRoleResult> {
  const container = options?.containerName ?? CANONICAL_DEV_CONTAINER;
  const db = options?.database ?? CANONICAL_DEV_DB;
  const role = options?.role ?? CANONICAL_DEV_USER;
  const runner = options?.runner ?? defaultDockerStdinRunner;
  const timeoutMs = options?.timeoutMs ?? 5000;

  const sql = generateRoleVerificationSql(role);

  // Connect as erp_user directly via local Unix socket (trust mode)
  // Flags: -t (tuples only), -A (unaligned) for clean tabular output parsing
  const args = [
    'exec',
    '-i',
    container,
    'psql',
    '-U',
    role,
    '-d',
    db,
    '-t',
    '-A',
    '-F',
    '|',
    '-v',
    'ON_ERROR_STOP=1',
  ];

  const res = await runner(args, sql, timeoutMs);

  if (res.spawnError || res.code !== 0) {
    const cleanErr = res.stderr.trim();
    return {
      verified: false,
      role,
      isSuperuser: false,
      canLogin: false,
      error: cleanErr || `Process exited with code ${res.code}`,
    };
  }

  // Parse pipe-delimited output: <rolname>|<rolsuper>|<rolcanlogin>
  const outputLines = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.includes('|'));

  if (outputLines.length === 0) {
    return {
      verified: false,
      role,
      isSuperuser: false,
      canLogin: false,
      error: `Role "${role}" was not found in pg_roles.`,
    };
  }

  const [rolname, rolsuper, rolcanlogin] = outputLines[0].split('|');

  const matchesRole = rolname === role;
  const isSuper = rolsuper === 't';
  const canLogin = rolcanlogin === 't';

  if (!matchesRole) {
    return {
      verified: false,
      role,
      isSuperuser: isSuper,
      canLogin,
      error: `Role mismatch: expected "${role}", got "${rolname}".`,
    };
  }

  if (!isSuper) {
    return {
      verified: false,
      role,
      isSuperuser: false,
      canLogin,
      error: `Role "${role}" exists but does not have superuser privileges (rolsuper = f). Cannot safely perform administrative role adjustments.`,
    };
  }

  return {
    verified: true,
    role,
    isSuperuser: isSuper,
    canLogin,
  };
}

export interface SyncDatabaseRoleResult {
  success: boolean;
  executed: boolean;
  error?: string;
  message: string;
}

/**
 * Updates the running PostgreSQL role password inside Docker using a secure stdin pipe.
 *
 * Security & Reliability Guarantees:
 * - Connects as the initialized role (erp_user), NOT 'postgres'.
 * - Transmits SQL and credentials strictly through stdin, NEVER command arguments.
 * - Does NOT restart or recreate the container.
 * - Does NOT modify database schema or records.
 */
export async function syncPostgresRoleViaStdin(options?: {
  containerName?: string;
  database?: string;
  role?: string;
  password?: string;
  runner?: StdinCommandRunner;
  timeoutMs?: number;
}): Promise<SyncDatabaseRoleResult> {
  const container = options?.containerName ?? CANONICAL_DEV_CONTAINER;
  const db = options?.database ?? CANONICAL_DEV_DB;
  const role = options?.role ?? CANONICAL_DEV_USER;
  const password = options?.password ?? CANONICAL_DEV_PASSWORD;
  const runner = options?.runner ?? defaultDockerStdinRunner;
  const timeoutMs = options?.timeoutMs ?? 5000;

  const sql = generateRoleSyncSql(role, password);

  // Connect as erp_user directly (NOT postgres)
  const args = [
    'exec',
    '-i',
    container,
    'psql',
    '-U',
    role,
    '-d',
    db,
    '-v',
    'ON_ERROR_STOP=1',
  ];

  const res = await runner(args, sql, timeoutMs);

  if (res.code === 0) {
    return {
      success: true,
      executed: true,
      message: `Role "${role}" credentials successfully synchronized in container "${container}".`,
    };
  }

  // Sanitize any raw output to prevent accidental credential leaks
  const cleanErr = res.stderr.replace(password, '*****').trim();
  return {
    success: false,
    executed: false,
    error: cleanErr || `Process exited with code ${res.code}`,
    message: `Failed to update role password in container "${container}".`,
  };
}

export interface DevSyncOrchestrationResult {
  success: boolean;
  preconditionsValid: boolean;
  envWritable: boolean;
  roleVerified: boolean;
  roleUpdated: boolean;
  envUpdated: boolean;
  error?: string;
  details?: {
    containerName: string;
    database: string;
    role: string;
    sanitizedEndpoint: string;
    envResult?: SyncEnvFileResult;
  };
}

/**
 * Phased, atomic orchestrator for local development PostgreSQL credential synchronization.
 *
 * Strict Execution Order:
 * Phase 1: Precondition validation (rejects prod/integration/ports 5433 & 5434).
 * Phase 2: Environment file write permission check.
 * Phase 3: Verify PostgreSQL role identity and superuser privilege via stdin.
 * Phase 4: Synchronize role password in container via stdin.
 * Phase 5: ONLY after Phase 4 succeeds, update .env file atomically.
 *
 * Invariant: If Phase 3 or 4 fails, .env is NEVER modified.
 */
export async function executeDevCredentialSync(options?: {
  envFilePath?: string;
  containerName?: string;
  databaseUrl?: string;
  runner?: StdinCommandRunner;
  dryRun?: boolean;
}): Promise<DevSyncOrchestrationResult> {
  const envPath = options?.envFilePath ?? path.resolve(process.cwd(), '.env');
  const runner = options?.runner ?? defaultDockerStdinRunner;
  const isDryRun = options?.dryRun ?? false;

  // Phase 1: Precondition Safety Validation
  const precheck = validateDevSyncPreconditions({
    containerName: options?.containerName,
    databaseUrl: options?.databaseUrl,
  });

  if (!precheck.valid) {
    return {
      success: false,
      preconditionsValid: false,
      envWritable: false,
      roleVerified: false,
      roleUpdated: false,
      envUpdated: false,
      error: precheck.error,
    };
  }

  // Phase 2: Verify .env write permissions before touching database
  const writeCheck = verifyEnvFileWritable(envPath);
  if (!writeCheck.writable) {
    return {
      success: false,
      preconditionsValid: true,
      envWritable: false,
      roleVerified: false,
      roleUpdated: false,
      envUpdated: false,
      error: `[PREFLIGHT FAILED] ${writeCheck.error}`,
    };
  }

  if (isDryRun) {
    return {
      success: true,
      preconditionsValid: true,
      envWritable: true,
      roleVerified: true,
      roleUpdated: false,
      envUpdated: false,
      details: {
        containerName: precheck.details!.containerName,
        database: precheck.details!.database,
        role: precheck.details!.role,
        sanitizedEndpoint: precheck.sanitizedEndpoint!,
      },
    };
  }

  // Phase 3: Verify Role Identity & Superuser Privilege via Stdin
  const roleCheck = await verifyPostgresRoleViaStdin({
    containerName: precheck.details!.containerName,
    database: precheck.details!.database,
    role: precheck.details!.role,
    runner,
  });

  if (!roleCheck.verified) {
    return {
      success: false,
      preconditionsValid: true,
      envWritable: true,
      roleVerified: false,
      roleUpdated: false,
      envUpdated: false,
      error: `[ROLE VERIFICATION FAILED] ${roleCheck.error}`,
    };
  }

  // Phase 4: Synchronize PostgreSQL Role Password via Stdin
  const roleSync = await syncPostgresRoleViaStdin({
    containerName: precheck.details!.containerName,
    database: precheck.details!.database,
    role: precheck.details!.role,
    runner,
  });

  if (!roleSync.success) {
    return {
      success: false,
      preconditionsValid: true,
      envWritable: true,
      roleVerified: true,
      roleUpdated: false,
      envUpdated: false,
      error: `[DATABASE UPDATE FAILED] ${roleSync.error}. Local .env was NOT modified to prevent split-brain state.`,
    };
  }

  // Phase 5: Atomically update .env ONLY after database update succeeded
  const envResult = syncEnvFileDatabaseUrl(envPath);

  return {
    success: true,
    preconditionsValid: true,
    envWritable: true,
    roleVerified: true,
    roleUpdated: true,
    envUpdated: envResult.updated || envResult.alreadySynchronized,
    details: {
      containerName: precheck.details!.containerName,
      database: precheck.details!.database,
      role: precheck.details!.role,
      sanitizedEndpoint: precheck.sanitizedEndpoint!,
      envResult,
    },
  };
}
