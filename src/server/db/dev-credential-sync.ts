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
 * 5. Strictly validates role identity (erp_user).
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
      error: `[SAFETY VIOLATION] Target role must be exactly "${expectedRole}". Received "${user}".`,
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

export interface SyncEnvFileResult {
  updated: boolean;
  alreadySynchronized: boolean;
  sanitizedPreviousUrl: string;
  sanitizedCurrentUrl: string;
}

/**
 * Safely synchronizes DATABASE_URL and POSTGRES_* credentials in a local .env file.
 *
 * Preserves:
 * - All comments (# ...)
 * - Empty lines and whitespace
 * - All unrelated environment variables (PORT, SESSION_SECRET, etc.)
 * - File formatting and order
 *
 * Redacts:
 * - Credentials from all returned diagnostic data.
 */
export function syncEnvFileDatabaseUrl(
  envFilePath: string = path.resolve(process.cwd(), '.env'),
  options?: { targetPassword?: string }
): SyncEnvFileResult {
  if (!fs.existsSync(envFilePath)) {
    // Generate fresh development .env with canonical credentials
    const defaultEnv = [
      'PORT=3000',
      'NODE_ENV=development',
      `POSTGRES_USER="${CANONICAL_DEV_USER}"`,
      `POSTGRES_PASSWORD="${CANONICAL_DEV_PASSWORD}"`,
      `POSTGRES_DB="${CANONICAL_DEV_DB}"`,
      `DATABASE_URL="postgresql://${CANONICAL_DEV_USER}:${CANONICAL_DEV_PASSWORD}@localhost:${CANONICAL_DEV_PORT}/${CANONICAL_DEV_DB}?schema=public"`,
      'TEST_DATABASE_URL="postgresql://erp_test_user:dev_test_password@localhost:5433/core_erp_test?schema=public"',
      'STAGING_DATABASE_URL="postgresql://erp_test_user:dev_test_password@localhost:5433/core_erp_staging?schema=public"',
      'SESSION_SECRET="dev_insecure_fallback_session_secret_32_chars_long"',
      'BIOMETRIC_BRIDGE_TOKEN="dev_biometric_bridge_secret_token_123456"',
      '',
    ].join('\n');
    fs.writeFileSync(envFilePath, defaultEnv, 'utf-8');

    return {
      updated: true,
      alreadySynchronized: false,
      sanitizedPreviousUrl: '[NEW_FILE_CREATED]',
      sanitizedCurrentUrl: `postgresql://${CANONICAL_DEV_USER}:*****@localhost:${CANONICAL_DEV_PORT}/${CANONICAL_DEV_DB}?schema=public`,
    };
  }

  const newPassword = options?.targetPassword ?? CANONICAL_DEV_PASSWORD;
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
        // Fallback replacement if URL parsing failed
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
    fs.writeFileSync(envFilePath, finalContent, 'utf-8');
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

export interface SyncDatabaseRoleResult {
  success: boolean;
  executed: boolean;
  error?: string;
  message: string;
}

/**
 * Updates the running PostgreSQL role password inside Docker using a secure stdin pipe.
 *
 * Security Guarantee:
 * - SQL and credentials are NEVER passed via process arguments (which would leak in ps/Task Manager).
 * - SQL is piped directly into psql's standard input.
 * - Does NOT restart or recreate the container.
 * - Does NOT modify database schema or records.
 */
export async function syncPostgresRoleViaStdin(options?: {
  containerName?: string;
  database?: string;
  role?: string;
  password?: string;
  timeoutMs?: number;
}): Promise<SyncDatabaseRoleResult> {
  const container = options?.containerName ?? CANONICAL_DEV_CONTAINER;
  const db = options?.database ?? CANONICAL_DEV_DB;
  const role = options?.role ?? CANONICAL_DEV_USER;
  const password = options?.password ?? CANONICAL_DEV_PASSWORD;
  const timeoutMs = options?.timeoutMs ?? 5000;

  const sql = generateRoleSyncSql(role, password);

  return new Promise((resolve) => {
    // Pipe directly via stdin to psql running as superuser inside container
    // No SQL or credentials appear in process argv!
    const child = spawn(
      'docker',
      ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let stdoutData = '';
    let stderrData = '';
    let isSettled = false;

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        try {
          child.kill();
        } catch {}
        resolve({
          success: false,
          executed: false,
          error: `[TIMEOUT] docker exec timed out after ${timeoutMs}ms. Verify Docker Desktop is running.`,
          message: 'Operation timed out.',
        });
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdoutData += d.toString();
    });

    child.stderr.on('data', (d) => {
      stderrData += d.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        const isNotFound = err.code === 'ENOENT';
        const msg = isNotFound
          ? 'Docker executable not found in PATH. If running in a host terminal, ensure Docker CLI is available.'
          : err.message;
        resolve({
          success: false,
          executed: false,
          error: msg,
          message: 'Failed to spawn docker process.',
        });
      }
    });

    child.on('close', (code) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);

        if (code === 0) {
          resolve({
            success: true,
            executed: true,
            message: `Role "${role}" credentials successfully synchronized in container "${container}".`,
          });
        } else {
          // Sanitize any raw output to prevent accidental leaks
          const cleanErr = stderrData.replace(password, '*****').trim();
          resolve({
            success: false,
            executed: false,
            error: cleanErr || `Process exited with code ${code}`,
            message: `Failed to update role password in container "${container}".`,
          });
        }
      }
    });

    // Write SQL to stdin and close pipe securely
    try {
      child.stdin.write(sql);
      child.stdin.end();
    } catch (e: unknown) {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({
          success: false,
          executed: false,
          error: e instanceof Error ? e.message : String(e),
          message: 'Failed to write to docker stdin pipe.',
        });
      }
    }
  });
}
