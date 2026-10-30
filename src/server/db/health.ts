import net from 'net';
import { prisma } from './client.js';
import { DatabaseReadiness } from '../../shared/types.js';

/**
 * Parses host and port safely from a PostgreSQL connection string
 */
function parseHostAndPort(databaseUrl: string): { host: string; port: number } {
  try {
    const url = new URL(databaseUrl);
    return {
      host: url.hostname || 'localhost',
      port: parseInt(url.port || '5432', 10),
    };
  } catch {
    return { host: 'localhost', port: 5432 };
  }
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
 * Checks PostgreSQL connectivity cleanly
 * First tests the TCP socket to avoid stderr noise, then verifies query execution
 */
export async function checkPostgresHealth(): Promise<DatabaseReadiness> {
  const startTime = Date.now();
  const dbUrl = process.env.DATABASE_URL || '';

  if (!dbUrl) {
    return {
      status: 'unconfigured',
      database: 'PostgreSQL',
      latencyMs: 0,
      error: 'DATABASE_URL is not set in environment.',
    };
  }

  // 1. Quick TCP socket probe
  const { host, port } = parseHostAndPort(dbUrl);
  const isPortOpen = await isPostgresPortReachable(host, port, 2500);

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
    };
  }

  // 2. Database query probe
  try {
    await prisma.$queryRawUnsafe('SELECT 1 AS alive');
    const latencyMs = Date.now() - startTime;

    return {
      status: 'connected',
      database: 'PostgreSQL',
      latencyMs,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    let sanitizedReason = 'Connection refused or host unreachable';
    if (errorMessage.includes('Authentication failed') || errorMessage.includes('password authentication')) {
      sanitizedReason = 'Authentication failed for specified PostgreSQL user';
    } else if (errorMessage.includes('database') && errorMessage.includes('does not exist')) {
      sanitizedReason = 'Configured PostgreSQL database does not exist';
    } else if (errorMessage.includes('P1001') || errorMessage.includes('Can\'t reach database server')) {
      sanitizedReason = 'Cannot reach PostgreSQL database server. Verify Docker or host service.';
    }

    return {
      status: 'disconnected',
      database: 'PostgreSQL',
      latencyMs,
      error: sanitizedReason,
    };
  }
}
