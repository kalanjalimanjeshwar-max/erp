/**
 * CoreERP Staging Database Safety Validator
 *
 * Enforces strict safety guardrails to ensure staging and integration tests
 * only ever run against explicitly designated, disposable test databases.
 * NEVER allows silent fallback to production DATABASE_URL.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface NormalizedDatabaseEndpoint {
  protocol: string;
  hostname: string;
  port: number;
  database: string;
}

export interface StagingUrlValidationResult {
  valid: boolean;
  error?: string;
  url?: string;
  databaseName?: string;
  endpoint?: NormalizedDatabaseEndpoint;
}

// Explicitly approved standard test/staging database names
export const APPROVED_STANDARD_NAMES = new Set([
  'core_erp_test',
  'core_erp_staging',
  'coreerp_test',
  'coreerp_staging',
]);

// Unadorned core database names that must NEVER be targeted
export const UNADORNED_SYSTEM_NAMES = new Set([
  'core_erp',
  'coreerp',
  'erp',
  'main',
  'primary',
  'production',
  'prod',
  'live',
  'default',
  'postgres',
]);

// Strictly prohibited persistence/backup tokens (fail closed to protect snapshots)
export const PROHIBITED_MODIFIERS = [
  'copy',
  'backup',
  'bak',
  'snapshot',
  'dump',
  'clone',
  'restore',
  'replica',
  'shadow',
  'archive',
];

// Production roots that must never appear in a disposable database name
export const PROHIBITED_PROD_ROOTS = [
  'production',
  'live',
  'primary',
];

// Approved disposable indicator tokens
export const APPROVED_DISPOSABLE_TOKENS = [
  'test',
  'staging',
  'disposable',
  'sandbox',
  'temp',
];

/**
 * Normalizes host representation:
 * Maps 'localhost', '127.0.0.1', '::1', and '[::1]' to '127.0.0.1'
 */
export function normalizeHostname(rawHost: string): string {
  const host = rawHost.toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return '127.0.0.1';
  }
  return host;
}

/**
 * Parses and normalizes a PostgreSQL database URL into its core endpoint elements.
 * Returns null if the URL is invalid, ambiguous, or contains illegal paths.
 */
export function normalizeDatabaseUrl(urlStr: string | undefined): NormalizedDatabaseEndpoint | null {
  if (!urlStr || typeof urlStr !== 'string' || urlStr.trim() === '') {
    return null;
  }

  const trimmed = urlStr.trim();
  if (!trimmed.startsWith('postgresql://') && !trimmed.startsWith('postgres://')) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (protocol !== 'postgresql' && protocol !== 'postgres') {
      return null;
    }

    const rawHost = parsed.hostname;
    if (!rawHost) {
      return null;
    }
    const hostname = normalizeHostname(rawHost);

    // Effective port: Default for PostgreSQL is 5432
    let port = 5432;
    if (parsed.port) {
      port = parseInt(parsed.port, 10);
      if (isNaN(port) || port <= 0 || port > 65535) {
        return null;
      }
    }

    // Database name from pathname (stripping leading and trailing slashes)
    const rawPath = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!rawPath) {
      return null;
    }

    // Path must not contain subdirectories (e.g. /db/extra is ambiguous/invalid for PostgreSQL)
    if (rawPath.includes('/')) {
      return null;
    }

    // Decode URL-encoded characters (e.g. %20)
    const database = decodeURIComponent(rawPath).toLowerCase().trim();
    if (!database) {
      return null;
    }

    return {
      protocol,
      hostname,
      port,
      database,
    };
  } catch {
    return null;
  }
}

/**
 * Checks whether two normalized database endpoints resolve to the exact same physical database
 */
export function areDatabaseEndpointsEqual(
  endpointA: NormalizedDatabaseEndpoint,
  endpointB: NormalizedDatabaseEndpoint
): boolean {
  return (
    endpointA.hostname === endpointB.hostname &&
    endpointA.port === endpointB.port &&
    endpointA.database === endpointB.database
  );
}

/**
 * Validates database name according to CoreERP Disposable Database Naming Policy
 */
export function validateDisposableDatabaseName(dbName: string): { valid: boolean; error?: string } {
  const name = dbName.toLowerCase().trim();
  if (!name) {
    return {
      valid: false,
      error: 'No database name specified in target URL path.',
    };
  }

  // 1. Prohibit exact unadorned production/system database names
  if (UNADORNED_SYSTEM_NAMES.has(name)) {
    return {
      valid: false,
      error: `Database "${name}" appears to be a production or default database. Target database must be explicitly designated for testing or staging.`,
    };
  }

  // 2. Prohibit backup/snapshot/copy keywords (protects cloned production data)
  const matchedModifier = PROHIBITED_MODIFIERS.find((mod) => name.includes(mod));
  if (matchedModifier) {
    return {
      valid: false,
      error: `Database "${name}" contains prohibited backup/copy indicator "${matchedModifier}". Never run staging tests against database backups, clones, or snapshots.`,
    };
  }

  // 3. Prohibit production root keywords in any position (e.g. 'production', 'live', 'primary')
  const matchedProdRoot = PROHIBITED_PROD_ROOTS.find((root) => name.includes(root));
  if (matchedProdRoot) {
    return {
      valid: false,
      error: `Database "${name}" contains prohibited production indicator "${matchedProdRoot}". Refusing execution.`,
    };
  }

  // 4. Prohibit standalone 'prod' token (e.g. 'prod_test', 'test_prod', 'staging_prod')
  const tokens = name.split(/[_-]/);
  if (tokens.includes('prod') || name.startsWith('prod_') || name.endsWith('_prod') || name.includes('_prod_')) {
    return {
      valid: false,
      error: `Database "${name}" contains prohibited production indicator "prod". Refusing execution.`,
    };
  }

  // 5. Explicitly approved standard names pass immediately
  if (APPROVED_STANDARD_NAMES.has(name)) {
    return { valid: true };
  }

  // 6. If name starts with core_erp or coreerp, require approved test suffixes only
  if (name.startsWith('core_erp') || name.startsWith('coreerp')) {
    const nonCoreTokens = tokens.filter((t) => t !== 'core' && t !== 'erp');
    const hasApprovedDisposableToken = nonCoreTokens.some((t) => APPROVED_DISPOSABLE_TOKENS.includes(t));
    const allTokensSafe = nonCoreTokens.every(
      (t) => APPROVED_DISPOSABLE_TOKENS.includes(t) || ['db', 'database', 'local'].includes(t)
    );

    if (!hasApprovedDisposableToken || !allTokensSafe) {
      return {
        valid: false,
        error: `Database "${name}" uses core_erp with unrecognized or ambiguous modifiers. Approved names: core_erp_test, core_erp_staging.`,
      };
    }
    return { valid: true };
  }

  // 7. General disposable database names must contain at least one approved disposable token
  const hasApprovedToken = APPROVED_DISPOSABLE_TOKENS.some((indicator) => name.includes(indicator));
  if (!hasApprovedToken) {
    return {
      valid: false,
      error: `Database name "${name}" does not contain an approved disposable keyword (${APPROVED_DISPOSABLE_TOKENS.join(
        ', '
      )}). Name your database with a suffix like "_test" or "_staging".`,
    };
  }

  return { valid: true };
}

/**
 * Validates whether a target connection string is safe and valid for staging verification.
 * Compares normalized endpoints against primary DATABASE_URL to prevent accidental production targeting.
 */
export function validateStagingDatabaseUrl(
  targetUrl?: string,
  primaryDatabaseUrl?: string
): StagingUrlValidationResult {
  // 1. Explicit target URL is strictly required
  if (!targetUrl || targetUrl.trim() === '') {
    return {
      valid: false,
      error:
        'Refusing to run staging verification: No explicit staging database URL provided. ' +
        'Set STAGING_DATABASE_URL or TEST_DATABASE_URL in environment or pass as argument. ' +
        'Silent fallback to DATABASE_URL is strictly prohibited to prevent data loss.',
    };
  }

  // 2. Must be a valid PostgreSQL protocol string
  const trimmedTarget = targetUrl.trim();
  if (!trimmedTarget.startsWith('postgresql://') && !trimmedTarget.startsWith('postgres://')) {
    return {
      valid: false,
      error:
        'Refusing to run staging verification: Invalid URL protocol. ' +
        'Target URL must start with "postgresql://" or "postgres://".',
    };
  }

  // 3. Parse and normalize target database URL
  const targetEndpoint = normalizeDatabaseUrl(trimmedTarget);
  if (!targetEndpoint) {
    return {
      valid: false,
      error: 'Refusing to run staging verification: Failed to parse target database connection string or port/path is invalid.',
    };
  }

  // 4. If primary DATABASE_URL is configured, compare normalized endpoints (unconditional rejection of match)
  if (primaryDatabaseUrl && primaryDatabaseUrl.trim() !== '') {
    const primaryEndpoint = normalizeDatabaseUrl(primaryDatabaseUrl);
    if (!primaryEndpoint) {
      return {
        valid: false,
        error: 'Refusing to run staging verification: Primary DATABASE_URL is malformed or ambiguous, preventing safety comparison.',
      };
    }

    if (areDatabaseEndpointsEqual(targetEndpoint, primaryEndpoint)) {
      return {
        valid: false,
        error:
          `Refusing to run staging verification: Target database resolves to the same database endpoint as primary DATABASE_URL ` +
          `(${targetEndpoint.hostname}:${targetEndpoint.port}/${targetEndpoint.database}). Staging verification must target an isolated, disposable database.`,
        databaseName: targetEndpoint.database,
      };
    }
  }

  // 5. Validate database name against disposable policy
  const nameValidation = validateDisposableDatabaseName(targetEndpoint.database);
  if (!nameValidation.valid) {
    return {
      valid: false,
      error: `Refusing to run staging verification: ${nameValidation.error}`,
      databaseName: targetEndpoint.database,
    };
  }

  return {
    valid: true,
    url: targetUrl,
    databaseName: targetEndpoint.database,
    endpoint: targetEndpoint,
  };
}

export interface AppliedMigrationRecord {
  migration_name: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
  applied_steps_count?: number | null;
  logs?: string | null;
}

export interface MigrationValidationResult {
  valid: boolean;
  expectedCount: number;
  appliedCount: number;
  missingMigrations: string[];
  unexpectedMigrations: string[];
  failedMigrations: string[];
  error?: string;
}

export interface SchemaIndexRecord {
  tablename: string;
  indexname: string;
  indexdef: string;
}

export interface SchemaDecimalColumnRecord {
  table_name: string;
  column_name: string;
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

export interface SchemaInvariantValidationResult {
  valid: boolean;
  missingIndexes: string[];
  precisionMismatches: string[];
  missingEnumValues: string[];
  error?: string;
}

export interface StagingVerificationStep {
  step: number;
  name: string;
  description: string;
  critical: boolean;
}

export const REQUIRED_STAGING_UNIQUE_INDEXES: ReadonlyArray<{
  table: string;
  indexName: string;
}> = [
  { table: 'Company', indexName: 'Company_code_key' },
  { table: 'User', indexName: 'User_companyId_email_key' },
  { table: 'Attendance', indexName: 'Attendance_companyId_employeeId_workDate_key' },
];

export const REQUIRED_STAGING_DECIMAL_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  precision: number;
  scale: number;
}> = [
  { table: 'CurrencyConfig', column: 'exchangeRate', precision: 18, scale: 6 },
  { table: 'JournalEntry', column: 'totalDebit', precision: 18, scale: 4 },
  { table: 'JournalEntry', column: 'totalCredit', precision: 18, scale: 4 },
  { table: 'JournalLine', column: 'debit', precision: 18, scale: 4 },
  { table: 'JournalLine', column: 'credit', precision: 18, scale: 4 },
];

export const REQUIRED_ATTENDANCE_SOURCE_VALUES: ReadonlyArray<string> = [
  'MANUAL',
  'BIOMETRIC',
  'SYSTEM_GENERATED',
];

const DEFAULT_PRISMA_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations'
);

/**
 * Dynamically discovers versioned Prisma migration directories under `prisma/migrations`.
 * Only directories containing a `migration.sql` file are counted, sorted chronologically.
 * Fails closed if the directory is missing or contains no versioned migrations.
 */
export function getExpectedPrismaMigrations(
  migrationsDir: string = DEFAULT_PRISMA_MIGRATIONS_DIR
): string[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Prisma migrations directory not found at "${migrationsDir}".`);
  }

  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      return fs.existsSync(path.join(migrationsDir, entry.name, 'migration.sql'));
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (migrationNames.length === 0) {
    throw new Error(`No versioned Prisma migration directories found in "${migrationsDir}".`);
  }

  return migrationNames;
}

/**
 * Validates `_prisma_migrations` rows against the exact list of repository migration directories.
 * Fails closed on any failed/incomplete migration, missing migration, unexpected migration,
 * or count mismatch.
 */
export function validateAppliedMigrations(
  expectedMigrations: readonly string[],
  appliedRows: readonly AppliedMigrationRecord[]
): MigrationValidationResult {
  if (expectedMigrations.length === 0) {
    return {
      valid: false,
      expectedCount: 0,
      appliedCount: 0,
      missingMigrations: [],
      unexpectedMigrations: [],
      failedMigrations: [],
      error: 'Expected migration list is empty; refusing to validate migration history.',
    };
  }

  const failedMigrations: string[] = [];
  const appliedSuccessful = new Set<string>();

  for (const row of appliedRows) {
    const name = typeof row.migration_name === 'string' ? row.migration_name.trim() : '';
    if (!name) {
      failedMigrations.push('<unnamed-migration>');
      continue;
    }

    const isFinished = row.finished_at !== null && row.finished_at !== undefined;
    const isRolledBack = row.rolled_back_at !== null && row.rolled_back_at !== undefined;

    if (!isFinished && !isRolledBack) {
      failedMigrations.push(name);
    } else if (isFinished && !isRolledBack) {
      appliedSuccessful.add(name);
    }
  }

  const expectedSet = new Set(expectedMigrations);
  const missingMigrations = expectedMigrations.filter((m) => !appliedSuccessful.has(m));
  const unexpectedMigrations = Array.from(appliedSuccessful)
    .filter((m) => !expectedSet.has(m))
    .sort((a, b) => a.localeCompare(b));

  const issues: string[] = [];
  if (failedMigrations.length > 0) {
    issues.push(`failed/incomplete migrations: ${failedMigrations.join(', ')}`);
  }
  if (missingMigrations.length > 0) {
    issues.push(`missing migrations (${missingMigrations.length}): ${missingMigrations.join(', ')}`);
  }
  if (unexpectedMigrations.length > 0) {
    issues.push(
      `unexpected migrations (${unexpectedMigrations.length}): ${unexpectedMigrations.join(', ')}`
    );
  }
  if (appliedSuccessful.size !== expectedMigrations.length) {
    issues.push(
      `applied migration count mismatch (expected ${expectedMigrations.length}, found ${appliedSuccessful.size})`
    );
  }

  if (issues.length > 0) {
    return {
      valid: false,
      expectedCount: expectedMigrations.length,
      appliedCount: appliedSuccessful.size,
      missingMigrations,
      unexpectedMigrations,
      failedMigrations,
      error: `Migration history verification failed: ${issues.join('; ')}.`,
    };
  }

  return {
    valid: true,
    expectedCount: expectedMigrations.length,
    appliedCount: appliedSuccessful.size,
    missingMigrations: [],
    unexpectedMigrations: [],
    failedMigrations: [],
  };
}

/**
 * Validates read-only PostgreSQL catalog results for required unique indexes,
 * schema-backed Decimal precisions, and AttendanceSource enum values.
 */
export function validateSchemaInvariants(params: {
  indexes: readonly SchemaIndexRecord[];
  decimalColumns: readonly SchemaDecimalColumnRecord[];
  attendanceSourceValues: readonly string[];
}): SchemaInvariantValidationResult {
  const missingIndexes: string[] = [];
  for (const required of REQUIRED_STAGING_UNIQUE_INDEXES) {
    const found = params.indexes.some(
      (idx) =>
        idx.tablename === required.table &&
        idx.indexname === required.indexName &&
        /CREATE\s+UNIQUE\s+INDEX/i.test(idx.indexdef || '')
    );
    if (!found) {
      missingIndexes.push(`${required.table}.${required.indexName}`);
    }
  }

  const precisionMismatches: string[] = [];
  for (const required of REQUIRED_STAGING_DECIMAL_COLUMNS) {
    const col = params.decimalColumns.find(
      (c) => c.table_name === required.table && c.column_name === required.column
    );
    if (!col) {
      precisionMismatches.push(
        `${required.table}.${required.column} (missing column; expected Decimal(${required.precision},${required.scale}))`
      );
      continue;
    }
    const actualPrecision = col.numeric_precision !== null ? Number(col.numeric_precision) : null;
    const actualScale = col.numeric_scale !== null ? Number(col.numeric_scale) : null;
    if (
      col.data_type !== 'numeric' ||
      actualPrecision !== required.precision ||
      actualScale !== required.scale
    ) {
      precisionMismatches.push(
        `${required.table}.${required.column} (expected numeric(${required.precision},${required.scale}), got ${col.data_type}(${actualPrecision},${actualScale}))`
      );
    }
  }

  const enumSet = new Set(params.attendanceSourceValues);
  const missingEnumValues = REQUIRED_ATTENDANCE_SOURCE_VALUES.filter((v) => !enumSet.has(v));

  const issues: string[] = [];
  if (missingIndexes.length > 0) {
    issues.push(`missing unique indexes: ${missingIndexes.join(', ')}`);
  }
  if (precisionMismatches.length > 0) {
    issues.push(`decimal precision mismatches: ${precisionMismatches.join(', ')}`);
  }
  if (missingEnumValues.length > 0) {
    issues.push(`missing AttendanceSource enum values: ${missingEnumValues.join(', ')}`);
  }

  if (issues.length > 0) {
    return {
      valid: false,
      missingIndexes,
      precisionMismatches,
      missingEnumValues,
      error: `Schema invariant verification failed: ${issues.join('; ')}.`,
    };
  }

  return {
    valid: true,
    missingIndexes: [],
    precisionMismatches: [],
    missingEnumValues: [],
  };
}

/**
 * Returns structured staging verification workflow definition matching the exact
 * executable checks performed by scripts/verify-staging-db.ts.
 */
export function getStagingVerificationSteps(
  migrationsDir?: string
): StagingVerificationStep[] {
  const expectedMigrationCount = getExpectedPrismaMigrations(migrationsDir).length;
  return [
    {
      step: 1,
      name: 'Safety & Environment Pre-Flight',
      description:
        'Validate STAGING_DATABASE_URL or TEST_DATABASE_URL against disposable naming rules and primary DATABASE_URL without connecting or falling back to DATABASE_URL.',
      critical: true,
    },
    {
      step: 2,
      name: 'Network & Port Reachability Probe',
      description:
        'Check TCP socket connectivity to the validated staging PostgreSQL host and port before running Prisma commands.',
      critical: true,
    },
    {
      step: 3,
      name: 'Migration Deployment & History Integrity',
      description: `Execute prisma migrate deploy and prisma migrate status strictly against the validated staging URL, confirm database identity, and verify _prisma_migrations records all ${expectedMigrationCount} versioned migrations with zero failed or missing entries.`,
      critical: true,
    },
    {
      step: 4,
      name: 'Schema Constraints, Precision & Enum Verification',
      description:
        'Query read-only PostgreSQL catalogs to verify unique constraints (Company_code_key, User_companyId_email_key, Attendance_companyId_employeeId_workDate_key), Decimal precision (CurrencyConfig.exchangeRate 18,6; JournalEntry/JournalLine 18,4), and AttendanceSource enum values without modifying application data.',
      critical: true,
    },
    {
      step: 5,
      name: 'Health & Readiness Endpoint Validation',
      description:
        'Start an isolated staging server process bound strictly to the validated staging URL (with auto-checkout scheduler disabled) and verify GET /api/health (HTTP 200, status=ok) and GET /api/ready (HTTP 200, postgres=connected).',
      critical: true,
    },
    {
      step: 6,
      name: 'Graceful Shutdown & Pool Drain',
      description:
        'Send SIGTERM to the isolated staging server process and verify clean exit after HTTP server close and Prisma connection pool disconnect.',
      critical: true,
    },
  ];
}
