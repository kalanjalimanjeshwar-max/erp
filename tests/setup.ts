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

export {
  APPROVED_TEST_DB_HOSTS,
  STANDARD_TEST_DB_PORT,
  STANDARD_TEST_DB_NAME,
  APPROVED_STANDARD_TEST_DB_URL,
  INTEGRATION_TEST_DB_PORT,
  INTEGRATION_TEST_DB_NAME,
  validateStandardDatabaseUrl,
  validateIntegrationDatabaseUrl,
};

/**
 * Validates that DATABASE_URL strictly points to the approved standard unit test database.
 * Credentials and raw connection strings are NEVER logged in error messages.
 */
function validateStandardDatabaseUrl(urlValue: string | undefined): void {
  if (!urlValue || urlValue.trim() === '') {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlValue);
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
  if (!urlValue || urlValue.trim() === '') {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlValue);
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
import dotenv from 'dotenv';

const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';

if (isIntegrationMode) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      '[DATABASE SAFETY VIOLATION] COREERP_INTEGRATION_TEST_MODE requires NODE_ENV=test. Refusing to proceed.'
    );
  }
  // Wrap dotenv.config so subsequent calls do not inject DATABASE_URL from .env
  const origDotenvConfig = dotenv.config;
  dotenv.config = (options?: any) => {
    const res = origDotenvConfig(options);
    delete process.env.DATABASE_URL;
    return res;
  };

  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
    throw new Error(
      '[DATABASE SAFETY VIOLATION] Conflicting DATABASE_URL detected in integration test mode. Integration tests must exclusively use TEST_DATABASE_URL to prevent split-brain routing. Refusing to proceed.'
    );
  }
  if (!process.env.TEST_DATABASE_URL || process.env.TEST_DATABASE_URL.trim() === '') {
    throw new Error(
      '[DATABASE SAFETY VIOLATION] TEST_DATABASE_URL is required in integration test mode. Refusing to proceed.'
    );
  }
  validateIntegrationDatabaseUrl(process.env.TEST_DATABASE_URL);
  // In integration mode, DATABASE_URL is deliberately not populated with the port 5433 fallback.
} else {
  validateStandardDatabaseUrl(process.env.DATABASE_URL);
  validateIntegrationDatabaseUrl(process.env.TEST_DATABASE_URL);

  // 3. Populate approved local test database URL for standard unit tests if absent
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = APPROVED_STANDARD_TEST_DB_URL;
  }
  // Note: TEST_DATABASE_URL is NEVER automatically populated with default or placeholder credentials.
  // Missing TEST_DATABASE_URL remains missing so dedicated integration tests report BLOCKED / NOT RUN safely.
}

// 4. Provide non-secret, test-only SESSION_SECRET satisfying environment schema
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'test_isolated_session_secret_not_for_production_min32chars';
}

// 5. Default stub for rolePermission in isolated non-connecting test runs
// Prevents offline database connection failures from blocking permission resolution
// in tests that do not connect to a live postgres database.
import { beforeAll, vi } from 'vitest';

beforeAll(async () => {
  if (process.env.COREERP_INTEGRATION_TEST_MODE === 'true') {
    return;
  }
  const { prisma } = await import('../src/server/db/client.js');
  if (prisma?.rolePermission) {
    if ('findUnique' in prisma.rolePermission) {
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
    }
    if ('findMany' in prisma.rolePermission) {
      vi.spyOn(prisma.rolePermission, 'findMany').mockResolvedValue([]);
    }
  }
});



