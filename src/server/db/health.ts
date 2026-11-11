import net from 'net';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from './client.js';
import { DatabaseReadiness } from '../../shared/types.js';

export interface PostgresHealthOptions {
  client?: PrismaClient;
  targetUrl?: string;
  skipPortCheck?: boolean;
}

export interface SanitizedDatabaseErrorResult {
  sanitizedMessage: string;
  category: NonNullable<DatabaseReadiness['category']>;
  code?: string;
}

/**
 * Parses host, port, database, and user safely from a PostgreSQL connection string.
 * Never returns or extracts passwords.
 */
export function parseHostAndPort(databaseUrl: string): {
  host: string;
  port: number;
  database?: string;
  user?: string;
} {
  const cleanUrl = databaseUrl ? databaseUrl.trim().replace(/^["']|["']$/g, '') : '';
  try {
    const url = new URL(cleanUrl);
    return {
      host: url.hostname || 'localhost',
      port: parseInt(url.port || '5432', 10),
      database: url.pathname.replace(/^\//, '').split('?')[0] || undefined,
      user: url.username ? decodeURIComponent(url.username) : undefined,
    };
  } catch {
    return { host: 'localhost', port: 5432 };
  }
}

/**
 * Sanitizes and categorizes raw database errors into safe, actionable diagnostics
 * without ever exposing passwords, secrets, or raw connection strings.
 */
export function sanitizeDatabaseError(
  err: unknown,
  urlValue?: string
): SanitizedDatabaseErrorResult {
  const code = (err as any)?.code || (err as any)?.errorCode || undefined;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const { host, port, database, user } = parseHostAndPort(urlValue || '');

  // 1. Authentication failure
  if (
    code === 'P1000' ||
    code === '28P01' ||
    rawMessage.includes('Authentication failed') ||
    rawMessage.includes('password authentication') ||
    rawMessage.includes('authentication failed')
  ) {
    const userDetail = user ? ` for user "${user}"` : '';
    const dbDetail = database ? ` on database "${database}"` : '';
    return {
      sanitizedMessage: `Authentication failed${userDetail}${dbDetail} at ${host}:${port}. Verify credentials in environment configuration.`,
      category: 'authentication',
      code: code || 'AUTH_FAILED',
    };
  }

  // 2. Database not found
  if (
    code === 'P1003' ||
    code === '3D000' ||
    (rawMessage.includes('database') && rawMessage.includes('does not exist'))
  ) {
    const dbName = database || 'specified database';
    return {
      sanitizedMessage: `Configured PostgreSQL database "${dbName}" does not exist at ${host}:${port}.`,
      category: 'database_not_found',
      code: code || 'DB_NOT_FOUND',
    };
  }

  // 3. Network unreachable / server offline
  if (
    code === 'P1001' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    rawMessage.includes("Can't reach database server") ||
    rawMessage.includes('Connection refused')
  ) {
    return {
      sanitizedMessage: `Cannot reach PostgreSQL database server at ${host}:${port}. Verify Docker or host service.`,
      category: 'network',
      code: code || 'NETWORK_UNREACHABLE',
    };
  }

  // 4. Connection timeout
  if (
    code === 'P1002' ||
    code === 'ETIMEDOUT' ||
    rawMessage.includes('timed out') ||
    rawMessage.includes('timeout')
  ) {
    return {
      sanitizedMessage: `Connection to PostgreSQL server at ${host}:${port} timed out.`,
      category: 'timeout',
      code: code || 'TIMEOUT',
    };
  }

  // 5. SSL / TLS negotiation failure
  if (
    rawMessage.includes('SSL') ||
    rawMessage.includes('sslmode') ||
    rawMessage.includes('certificate')
  ) {
    return {
      sanitizedMessage: `SSL/TLS connection error with PostgreSQL server at ${host}:${port}.`,
      category: 'ssl',
      code: code || 'SSL_ERROR',
    };
  }

  // 6. Configuration error
  if (
    code === 'P1013' ||
    rawMessage.includes('DATABASE_URL is not set') ||
    rawMessage.includes('Invalid database protocol') ||
    rawMessage.includes('Invalid database URL')
  ) {
    return {
      sanitizedMessage: `Database configuration error for endpoint at ${host}:${port}.`,
      category: 'configuration',
      code: code || 'CONFIG_ERROR',
    };
  }

  // Fallback query probe failure (cleanly sanitized)
  return {
    sanitizedMessage: `Database connection probe failed at ${host}:${port}.`,
    category: 'query_failure',
    code,
  };
}

/**
 * Checks whether the PostgreSQL TCP port is accepting connections
 * Fast non-blocking socket check to prevent raw Prisma engine errors in logs
 */
export async function isPostgresPortReachable(
  host: string,
  port: number,
  timeoutMs = 2500
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      settled = true;
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.once('error', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.connect(port, host);
  });
}

/**
 * Checks PostgreSQL connectivity cleanly.
 *
 * Diagnostic Order:
 * 1. Resolves configured client and target database URL.
 * 2. Quick TCP socket probe avoiding raw engine stderr logs if port is closed.
 * 3. Database query probe executing 'SELECT 1 AS alive' using the application client.
 * 4. Error sanitization distinguishing authentication, database-not-found, network,
 *    timeout, and configuration without ever exposing passwords or secrets.
 */
export async function checkPostgresHealth(
  options?: PostgresHealthOptions
): Promise<DatabaseReadiness> {
  const startTime = Date.now();

  const client: PrismaClient = options?.client || getPrismaClient();
  const rawDbUrl =
    options?.targetUrl ||
    (client as any)._engineConfig?.overrideDatasources?.db?.url ||
    process.env.DATABASE_URL ||
    '';

  const dbUrl = rawDbUrl.trim().replace(/^["']|["']$/g, '');

  if (!dbUrl) {
    return {
      status: 'unconfigured',
      database: 'PostgreSQL',
      latencyMs: 0,
      error: 'DATABASE_URL is not set in environment.',
      category: 'configuration',
    };
  }

  // 1. Quick TCP socket probe
  const { host, port } = parseHostAndPort(dbUrl);
  const isPortOpen = options?.skipPortCheck
    ? true
    : await isPostgresPortReachable(host, port, 2500);

  if (!isPortOpen) {
    const latencyMs = Date.now() - startTime;
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    const detail = isLocal
      ? `Cannot reach local PostgreSQL server at ${host}:${port}. In local development, verify Docker is running (docker compose -f docker-compose.dev.yml up -d postgres). In AI Studio Preview, configure an external PostgreSQL database in .env.`
      : `Cannot reach external PostgreSQL server at ${host}:${port}. Verify database hostname, network connectivity, SSL (?sslmode=require), and database IP allowlist.`;
    return {
      status: 'disconnected',
      database: 'PostgreSQL',
      latencyMs,
      error: detail,
      category: 'network',
    };
  }

  // 2. Database query probe using application Prisma client
  try {
    await client.$queryRawUnsafe('SELECT 1 AS alive');
    const latencyMs = Date.now() - startTime;

    return {
      status: 'connected',
      database: 'PostgreSQL',
      latencyMs,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    const { sanitizedMessage, category, code } = sanitizeDatabaseError(err, dbUrl);

    return {
      status: 'disconnected',
      database: 'PostgreSQL',
      latencyMs,
      error: sanitizedMessage,
      category,
      code,
    };
  }
}
