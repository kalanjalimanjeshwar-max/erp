/**
 * CoreERP Staging Database Safety Validator
 *
 * Enforces strict safety guardrails to ensure staging and integration tests
 * only ever run against explicitly designated, disposable test databases.
 * NEVER allows silent fallback to production DATABASE_URL.
 */

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

/**
 * Returns structured staging verification workflow definition
 */
export function getStagingVerificationSteps() {
  return [
    {
      step: 1,
      name: 'Safety & Environment Pre-Flight',
      description: 'Verify target database URL has explicit test/staging designation and differs from production.',
      critical: true,
    },
    {
      step: 2,
      name: 'Network & Port Reachability Probe',
      description: 'Check TCP socket connectivity to PostgreSQL port (default 5432 or 5433) without Prisma stderr noise.',
      critical: true,
    },
    {
      step: 3,
      name: 'Migration Deployment & History Integrity',
      description: 'Execute npx prisma migrate deploy and verify _prisma_migrations records all 8 versioned migrations.',
      critical: true,
    },
    {
      step: 4,
      name: 'Health & Readiness Endpoint Validation',
      description: 'Verify GET /api/health (200) and GET /api/ready (200 when connected, 503 when disconnected).',
      critical: true,
    },
    {
      step: 5,
      name: 'Relational Invariants & Constraint Verification',
      description: 'Verify composite unique constraints (User companyId+email), Decimal precision (18,6), and journal balancing.',
      critical: true,
    },
    {
      step: 6,
      name: 'Graceful Shutdown & Pool Drain',
      description: 'Verify SIGTERM/SIGINT handler closes HTTP server and disconnects Prisma connection pool cleanly.',
      critical: false,
    },
  ];
}
