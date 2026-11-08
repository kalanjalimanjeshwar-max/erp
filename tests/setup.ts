/**
 * CoreERP Test Setup
 * Registered via Vitest setupFiles for isolated, non-connecting test runs.
 */

// 1. Enforce test environment
process.env.NODE_ENV = 'test';

// Approved local unit test database endpoint matching docker-compose.dev.yml test service
const APPROVED_TEST_DB_HOSTS = new Set(['localhost', '127.0.0.1']);
const APPROVED_UNIT_TEST_DB_PORT = '5433';
const APPROVED_UNIT_TEST_DB_NAME = 'core_erp_test';
const APPROVED_TEST_DB_URL =
  'postgresql://erp_test_user:erp_test_password@localhost:5433/core_erp_test?schema=public';

// Approved isolated integration test database endpoint matching docker-compose.integration-test.yml
const APPROVED_INTEGRATION_TEST_DB_PORT = '5434';
const APPROVED_INTEGRATION_TEST_DB_NAME = 'core_erp_integration_test';

/**
 * Validates that a connection URL strictly points to the approved local test database.
 * Throws a fatal safety error if an unapproved, primary (5432), staging, or production
 * database is detected. Credentials are never logged in error messages.
 */
function enforceTestDatabaseUrlSafety(varName: string, urlValue: string | undefined): void {
  if (!urlValue || urlValue.trim() === '') {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error(
      `[DATABASE SAFETY VIOLATION] Invalid or unparseable ${varName} in test environment. Expected approved local test endpoint. Refusing to proceed.`
    );
  }

  const protocol = parsed.protocol;
  if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
    throw new Error(
      `[DATABASE SAFETY VIOLATION] Forbidden database protocol "${protocol}" in ${varName}. PostgreSQL is required. Refusing to proceed.`
    );
  }

  const hostname = parsed.hostname;
  if (!APPROVED_TEST_DB_HOSTS.has(hostname)) {
    throw new Error(
      `[DATABASE SAFETY VIOLATION] Unapproved database host in ${varName}. Remote and production hosts are strictly forbidden in tests. Expected localhost or 127.0.0.1. Refusing to proceed.`
    );
  }

  const port = parsed.port;
  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];

  if (varName === 'DATABASE_URL') {
    if (port !== APPROVED_UNIT_TEST_DB_PORT) {
      throw new Error(
        `[DATABASE SAFETY VIOLATION] Unapproved database port in ${varName}. Primary port 5432 and non-test ports are strictly forbidden in tests. Expected port ${APPROVED_UNIT_TEST_DB_PORT}. Refusing to proceed.`
      );
    }
    if (dbName !== APPROVED_UNIT_TEST_DB_NAME) {
      throw new Error(
        `[DATABASE SAFETY VIOLATION] Unapproved database name "${dbName}" in ${varName}. Expected database "${APPROVED_UNIT_TEST_DB_NAME}". Refusing to proceed.`
      );
    }
  } else if (varName === 'TEST_DATABASE_URL') {
    if (port !== APPROVED_INTEGRATION_TEST_DB_PORT) {
      throw new Error(
        `[DATABASE SAFETY VIOLATION] Unapproved database port in ${varName}. Expected dedicated integration test port ${APPROVED_INTEGRATION_TEST_DB_PORT}. Refusing to proceed.`
      );
    }
    if (dbName !== APPROVED_INTEGRATION_TEST_DB_NAME) {
      throw new Error(
        `[DATABASE SAFETY VIOLATION] Unapproved database name "${dbName}" in ${varName}. Expected dedicated database "${APPROVED_INTEGRATION_TEST_DB_NAME}". Refusing to proceed.`
      );
    }
  }
}

// 2. Validate any pre-existing database URLs for safety before proceeding
enforceTestDatabaseUrlSafety('DATABASE_URL', process.env.DATABASE_URL);
enforceTestDatabaseUrlSafety('TEST_DATABASE_URL', process.env.TEST_DATABASE_URL);

// 3. Populate approved local test database URL for standard unit tests if absent
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = APPROVED_TEST_DB_URL;
}
// Note: TEST_DATABASE_URL is intentionally NOT populated with placeholder credentials.
// Integration tests require explicitly configured TEST_DATABASE_URL from .env.integration-test.

// 4. Provide non-secret, test-only SESSION_SECRET satisfying environment schema
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'test_isolated_session_secret_not_for_production_min32chars';
}

// 5. Default stub for rolePermission in isolated non-connecting test runs
// Prevents offline database connection failures from blocking permission resolution
// in tests that do not connect to a live postgres database.
import { beforeAll, vi } from 'vitest';

beforeAll(async () => {
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



