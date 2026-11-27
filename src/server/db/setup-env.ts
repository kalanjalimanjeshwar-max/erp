import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  COREERP_DB_ENVIRONMENTS,
  areDatabaseEndpointsEqual,
  normalizeDatabaseUrl,
  sanitizeDatabaseUrl,
  validateStagingDatabaseUrl,
} from './staging-safety.js';
import { redactSensitiveText } from './staging-verifier.js';

export interface PostgresUrlComponents {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  schema?: string;
}

export interface SetupLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface FileSetupStatus {
  file: string;
  action: 'CREATED' | 'PRESERVED' | 'MISSING';
}

export interface DetectedVolumeInfo {
  environment: keyof typeof COREERP_DB_ENVIRONMENTS;
  expectedVolume: string;
  matchedDockerVolume: string;
}

export interface DatabaseSetupResult {
  exitCode: 0 | 1;
  mode: 'SETUP' | 'CHECK';
  files: FileSetupStatus[];
  detectedVolumes: DetectedVolumeInfo[];
  issues: string[];
  warnings: string[];
}

export interface DatabaseSetupOptions {
  projectRoot?: string;
  checkOnly?: boolean;
  shellEnv?: Record<string, string | undefined>;
  logger?: SetupLogger;
  inspectDockerVolumes?: () => Promise<string[] | null>;
  generateSecret?: (bytes?: number) => string;
}

const DEFAULT_UNIT_TEST_DATABASE_URL =
  'postgresql://erp_test_user:erp_test_password@localhost:5433/core_erp_test?schema=public';

const PLACEHOLDER_SECRETS = new Set([
  'replace_with_strong_password',
  'replace_with_test_password',
  'replace_with_64_character_cryptographically_secure_random_string',
  'replace_with_64_character_hex_bank_encryption_key_256_bit',
  'replace_with_lan_bridge_authentication_secret_token',
  'changeme',
  'password',
  'secret',
]);

/**
 * Generates a cryptographically strong hex secret (default 32 bytes = 64 hex chars = 256-bit entropy).
 * Hex credentials are URL-safe and immune to Docker Compose `$` variable expansion or shell quoting issues.
 */
export function generateSecureSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Builds a PostgreSQL connection URL with strict RFC 3986 percent-encoding of credentials.
 * Safely handles special characters (@, :, /, #, %, !, ?, &, +, =, spaces, quotes)
 * and verifies round-trip URL parsing so Prisma never encounters malformed URI or P1000 parsing bugs.
 */
export function buildPostgresConnectionUrl(components: PostgresUrlComponents): string {
  const encodedUser = encodeURIComponent(components.user);
  const encodedPassword = encodeURIComponent(components.password);
  const encodedDb = encodeURIComponent(components.database);
  const schema = components.schema ?? 'public';
  const query = schema ? `?schema=${encodeURIComponent(schema)}` : '';
  const url = `postgresql://${encodedUser}:${encodedPassword}@${components.host}:${components.port}/${encodedDb}${query}`;

  // Round-trip verification guarantees credentials decode cleanly
  const parsed = new URL(url);
  if (
    decodeURIComponent(parsed.username) !== components.user ||
    decodeURIComponent(parsed.password) !== components.password
  ) {
    throw new Error('Failed to encode PostgreSQL credentials losslessly.');
  }

  return url;
}

/**
 * Parses a .env file into key/value pairs without mutating process.env.
 */
export function parseEnvFileContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;

    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function readEnvFileIfPresent(filePath: string): Record<string, string> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return parseEnvFileContent(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Atomically writes an environment file using a unique temporary file + rename.
 * Applies owner-only permissions (0600) on POSIX platforms.
 */
export function writeEnvFileAtomically(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read-only Docker volume discovery using execFile (shell: false).
 * Returns null if Docker CLI/daemon is unavailable. NEVER deletes or modifies volumes.
 */
export async function defaultInspectDockerVolumes(): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['volume', 'ls', '--format', '{{.Name}}'],
      { timeout: 4_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const volumes = String(stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        resolve(volumes);
      }
    );
  });
}

/**
 * Matches existing Docker volume names (including compose project prefixes like `coreerp_postgres_staging_data`)
 * against the five canonical CoreERP environment volumes.
 */
export function matchCoreErpDockerVolumes(dockerVolumes: readonly string[]): DetectedVolumeInfo[] {
  const detected: DetectedVolumeInfo[] = [];
  const envKeys = Object.keys(COREERP_DB_ENVIRONMENTS) as Array<keyof typeof COREERP_DB_ENVIRONMENTS>;

  for (const envKey of envKeys) {
    const expectedVolume = COREERP_DB_ENVIRONMENTS[envKey].volume;
    const matched = dockerVolumes.find(
      (vol) => vol === expectedVolume || vol.endsWith(`_${expectedVolume}`)
    );
    if (matched) {
      detected.push({
        environment: envKey,
        expectedVolume,
        matchedDockerVolume: matched,
      });
    }
  }

  return detected;
}

export function isPlaceholderOrWeak(val: string | undefined): boolean {
  if (!val || val.trim() === '') return true;
  const lower = val.trim().toLowerCase();
  if (PLACEHOLDER_SECRETS.has(lower)) return true;
  if (lower.includes('replace_with') || lower.includes('<') || lower.includes('>')) return true;
  return false;
}

export function renderStagingEnvFile(params: {
  user: string;
  password: string;
  database: string;
  stagingUrl: string;
}): string {
  return [
    '# ==============================================================================',
    '# CoreERP Dedicated Staging Verification Environment (.env.staging)',
    '# Git-ignored local credentials generated by `npm run db:setup`.',
    '# Used EXCLUSIVELY by docker-compose.staging.yml (port 5435 / core_erp_staging).',
    '# NEVER place STAGING_DATABASE_URL inside .env.',
    '# ==============================================================================',
    `STAGING_POSTGRES_USER="${params.user}"`,
    `STAGING_POSTGRES_PASSWORD="${params.password}"`,
    `STAGING_POSTGRES_DB="${params.database}"`,
    `STAGING_DATABASE_URL="${params.stagingUrl}"`,
    '',
  ].join('\n');
}

export function renderIntegrationEnvFile(params: { password: string; testUrl: string }): string {
  return [
    '# ==============================================================================',
    '# CoreERP Dedicated PostgreSQL 16 Integration Test Environment (.env.integration-test)',
    '# Git-ignored local credentials generated by `npm run db:setup`.',
    '# Used EXCLUSIVELY by docker-compose.integration-test.yml (port 5434 / core_erp_integration_test).',
    '# NEVER place TEST_DATABASE_URL inside .env.',
    '# ==============================================================================',
    `POSTGRES_PASSWORD="${params.password}"`,
    `TEST_DATABASE_URL="${params.testUrl}"`,
    '',
  ].join('\n');
}

export function renderMainDevEnvFile(params: {
  devUser: string;
  devPassword: string;
  devDatabase: string;
  devUrl: string;
  shadowUser: string;
  shadowPassword: string;
  shadowDatabase: string;
  shadowUrl: string;
  stagingUrl?: string;
  unitTestUrl?: string;
  port?: string;
  nodeEnv?: string;
  sessionSecret: string;
  bankEncryptionKey: string;
  bankActiveKeyId?: string;
  bankHistoricalKeys?: string;
  biometricBridgeToken: string;
}): string {
  const port = params.port?.trim() || '3000';
  const nodeEnv = params.nodeEnv?.trim() || 'development';
  const bankActiveKeyId = params.bankActiveKeyId?.trim() || 'k1';
  const bankHistoricalKeys = params.bankHistoricalKeys?.trim() || '{}';
  const bankHistoricalKeysLine = bankHistoricalKeys.includes("'")
    ? `BANK_HISTORICAL_KEYS="${bankHistoricalKeys.replace(/"/g, '\\"')}"`
    : `BANK_HISTORICAL_KEYS='${bankHistoricalKeys}'`;

  const lines = [
    '# ==============================================================================',
    '# CoreERP Local Environment Configuration (.env)',
    '# Git-ignored local configuration generated by `npm run db:setup`.',
    '# Never commit this file or share its credentials across environments.',
    '#',
    '# Strict Five-Environment Ownership:',
    '#   - Development (5432 / core_erp):                  .env -> DATABASE_URL',
    '#   - Automated Test (5433 / core_erp_test):          UNIT_TEST_DATABASE_URL (default managed by tests/setup.ts)',
    '#   - Integration Test (5434 / core_erp_integration_test): .env.integration-test -> TEST_DATABASE_URL ONLY',
    '#   - Staging (5435 / core_erp_staging):              .env.staging -> STAGING_DATABASE_URL ONLY',
    '#   - Prisma Shadow (5436 / core_erp_shadow):         .env -> SHADOW_DATABASE_URL',
    '#',
    '# IMPORTANT: Do NOT put STAGING_DATABASE_URL or TEST_DATABASE_URL in .env.',
    '# ==============================================================================',
    `PORT=${port}`,
    `NODE_ENV=${nodeEnv}`,
    '',
    '# 1. Primary Development Database (Port 5432 -> core_erp)',
    `POSTGRES_USER="${params.devUser}"`,
    `POSTGRES_PASSWORD="${params.devPassword}"`,
    `POSTGRES_DB="${params.devDatabase}"`,
    `DATABASE_URL="${params.devUrl}"`,
  ];

  if (params.unitTestUrl?.trim()) {
    lines.push(`UNIT_TEST_DATABASE_URL="${params.unitTestUrl.trim()}"`);
  }

  lines.push(
    '',
    '# 2. Dedicated Prisma Shadow Database (Port 5436 -> core_erp_shadow)',
    '# Used only when authoring new migrations via `prisma migrate dev` (--profile shadow).',
    `SHADOW_POSTGRES_USER="${params.shadowUser}"`,
    `SHADOW_POSTGRES_PASSWORD="${params.shadowPassword}"`,
    `SHADOW_POSTGRES_DB="${params.shadowDatabase}"`,
    `SHADOW_DATABASE_URL="${params.shadowUrl}"`,
    '',
    '# Application Security Secrets (unique per installation)',
    `SESSION_SECRET="${params.sessionSecret}"`,
    `BIOMETRIC_BRIDGE_TOKEN="${params.biometricBridgeToken}"`,
    `BANK_ENCRYPTION_KEY="${params.bankEncryptionKey}"`,
    `BANK_ACTIVE_KEY_ID="${bankActiveKeyId}"`,
    bankHistoricalKeysLine,
    ''
  );

  return lines.join('\n');
}

function collectSecretsFromEnvMap(map: Record<string, string | undefined> | null): string[] {
  if (!map) return [];
  const secrets: string[] = [];
  const secretKeys = [
    'POSTGRES_PASSWORD',
    'STAGING_POSTGRES_PASSWORD',
    'SHADOW_POSTGRES_PASSWORD',
    'SESSION_SECRET',
    'BANK_ENCRYPTION_KEY',
    'BIOMETRIC_BRIDGE_TOKEN',
    'BOOTSTRAP_SUPER_ADMIN_PASSWORD',
    'DATABASE_URL',
    'UNIT_TEST_DATABASE_URL',
    'STAGING_DATABASE_URL',
    'TEST_DATABASE_URL',
    'SHADOW_DATABASE_URL',
  ];
  for (const key of secretKeys) {
    const val = map[key]?.trim();
    if (!val) continue;
    secrets.push(val);
    try {
      const parsed = new URL(val);
      if (parsed.password) {
        secrets.push(parsed.password);
        const decoded = decodeURIComponent(parsed.password);
        if (decoded) secrets.push(decoded);
      }
    } catch {
      // Not a URL
    }
  }
  return secrets;
}

function parseUrlCredentialsSafe(urlStr: string): { username: string; password: string } | null {
  try {
    const parsed = new URL(urlStr);
    return {
      username: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || ''),
    };
  } catch {
    return null;
  }
}

/**
 * Repeatable, idempotent, non-destructive CoreERP database environment setup & validator.
 *
 * Guarantees:
 * - Never overwrites existing `.env`, `.env.staging`, or `.env.integration-test` files.
 * - Never regenerates existing database passwords.
 * - Never prints passwords, tokens, or raw database URLs.
 * - Never deletes, resets, or modifies Docker volumes or databases.
 * - Enforces strict five-environment separation (5432 dev, 5433 unit test, 5434 integration, 5435 staging, 5436 shadow).
 * - Reports exact `[file or shell environment :: VARIABLE]` for every conflict or misconfiguration.
 */
export async function runDatabaseEnvironmentSetup(
  options: DatabaseSetupOptions = {}
): Promise<DatabaseSetupResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const checkOnly = options.checkOnly ?? false;
  const shellEnv: Record<string, string | undefined> =
    options.shellEnv ?? (process.env.VITEST === 'true' ? {} : process.env);
  const generateSecret = options.generateSecret ?? generateSecureSecret;
  const inspectVolumes = options.inspectDockerVolumes ?? defaultInspectDockerVolumes;
  const logger: SetupLogger = options.logger ?? {
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };

  const envPath = path.join(projectRoot, '.env');
  const stagingEnvPath = path.join(projectRoot, '.env.staging');
  const integrationEnvPath = path.join(projectRoot, '.env.integration-test');

  const files: FileSetupStatus[] = [];
  const issues: string[] = [];
  const warnings: string[] = [];
  const sensitiveValues = new Set<string>();

  const trackSecrets = (values: string[]) => {
    for (const v of values) {
      if (v && v.length >= 4) sensitiveValues.add(v);
    }
  };
  const redact = (msg: string) => redactSensitiveText(msg, Array.from(sensitiveValues));

  trackSecrets(collectSecretsFromEnvMap(shellEnv));

  logger.log('\n================================================================');
  logger.log(
    checkOnly
      ? '   CoreERP Database Environment Audit (--check / Read-Only)'
      : '   CoreERP Permanent Database Environment Setup (Idempotent)'
  );
  logger.log('================================================================\n');

  // 1. Read-only Docker volume inspection (never deletes or mutates volumes)
  const rawVolumes = await inspectVolumes();
  const detectedVolumes = rawVolumes ? matchCoreErpDockerVolumes(rawVolumes) : [];
  if (rawVolumes === null) {
    warnings.push(
      'Docker daemon could not be queried for existing volumes (Docker may not be running yet). Volume persistence checks will apply once Docker is active.'
    );
  } else if (detectedVolumes.length > 0) {
    logger.log('1. Existing Persistent Docker Volumes Detected (Preserved — Never Deleted):');
    for (const vol of detectedVolumes) {
      logger.log(`   - ${vol.environment}: volume "${vol.matchedDockerVolume}"`);
    }
  } else {
    logger.log('1. Docker Volumes: No pre-existing CoreERP PostgreSQL volumes found (clean host).');
  }

  // 2. Inspect existing env files (never overwrite existing user files)
  let stagingEnv = readEnvFileIfPresent(stagingEnvPath);
  let integrationEnv = readEnvFileIfPresent(integrationEnvPath);
  let mainEnv = readEnvFileIfPresent(envPath);

  trackSecrets(collectSecretsFromEnvMap(stagingEnv));
  trackSecrets(collectSecretsFromEnvMap(integrationEnv));
  trackSecrets(collectSecretsFromEnvMap(mainEnv));

  // 2a. Staging environment file (.env.staging -> core_erp_staging on port 5435)
  if (stagingEnv) {
    files.push({ file: '.env.staging', action: 'PRESERVED' });
  } else if (checkOnly) {
    files.push({ file: '.env.staging', action: 'MISSING' });
    issues.push(
      '[.env.staging :: STAGING_DATABASE_URL] Missing .env.staging file for isolated staging PostgreSQL (port 5435 / core_erp_staging). Run `npm run db:setup` to generate it safely.'
    );
  } else {
    const resolvedStagingUser = COREERP_DB_ENVIRONMENTS.staging.user;
    const resolvedStagingPassword = generateSecret(32);
    const resolvedStagingDb = COREERP_DB_ENVIRONMENTS.staging.database;
    const resolvedStagingUrl = buildPostgresConnectionUrl({
      user: resolvedStagingUser,
      password: resolvedStagingPassword,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.staging.port,
      database: resolvedStagingDb,
    });
    trackSecrets([resolvedStagingPassword, resolvedStagingUrl]);

    writeEnvFileAtomically(
      stagingEnvPath,
      renderStagingEnvFile({
        user: resolvedStagingUser,
        password: resolvedStagingPassword,
        database: resolvedStagingDb,
        stagingUrl: resolvedStagingUrl,
      })
    );
    stagingEnv = readEnvFileIfPresent(stagingEnvPath);
    files.push({ file: '.env.staging', action: 'CREATED' });

    const existingStagingVol = detectedVolumes.find((v) => v.environment === 'staging');
    if (existingStagingVol) {
      warnings.push(
        `Existing staging Docker volume "${existingStagingVol.matchedDockerVolume}" was detected while creating a new .env.staging. ` +
          'PostgreSQL preserves the password initialized inside an existing volume and ignores new POSTGRES_PASSWORD values on restart. ' +
          'If you see P1000 authentication errors, synchronize the staging role password via stdin pipe without deleting the volume (see README.md P1000 troubleshooting).'
      );
    }
  }

  // 2b. Integration test environment file (.env.integration-test -> core_erp_integration_test on port 5434)
  if (integrationEnv) {
    files.push({ file: '.env.integration-test', action: 'PRESERVED' });
  } else if (checkOnly) {
    files.push({ file: '.env.integration-test', action: 'MISSING' });
    issues.push(
      '[.env.integration-test :: TEST_DATABASE_URL] Missing .env.integration-test file for isolated integration PostgreSQL (port 5434 / core_erp_integration_test). Run `npm run db:setup` to generate it safely.'
    );
  } else {
    const integrationPassword = generateSecret(32);
    const integrationUrl = buildPostgresConnectionUrl({
      user: COREERP_DB_ENVIRONMENTS.integrationTest.user,
      password: integrationPassword,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.integrationTest.port,
      database: COREERP_DB_ENVIRONMENTS.integrationTest.database,
    });
    trackSecrets([integrationPassword, integrationUrl]);

    writeEnvFileAtomically(
      integrationEnvPath,
      renderIntegrationEnvFile({
        password: integrationPassword,
        testUrl: integrationUrl,
      })
    );
    integrationEnv = readEnvFileIfPresent(integrationEnvPath);
    files.push({ file: '.env.integration-test', action: 'CREATED' });

    const existingIntVol = detectedVolumes.find((v) => v.environment === 'integrationTest');
    if (existingIntVol) {
      warnings.push(
        `Existing integration Docker volume "${existingIntVol.matchedDockerVolume}" was detected while creating a new .env.integration-test. ` +
          'If integration tests fail with P1000, align the role password in coreerp-postgres-integration-test with .env.integration-test without deleting the volume.'
      );
    }
  }

  // 2c. Main development environment file (.env -> core_erp on 5432, core_erp_shadow on 5436)
  if (mainEnv) {
    files.push({ file: '.env', action: 'PRESERVED' });
  } else if (checkOnly) {
    files.push({ file: '.env', action: 'MISSING' });
    issues.push(
      '[.env :: DATABASE_URL] Missing .env file for local development (port 5432 / core_erp) and Prisma shadow DB (port 5436 / core_erp_shadow). Run `npm run db:setup` to initialize it safely.'
    );
  } else {
    const devUser = COREERP_DB_ENVIRONMENTS.development.user;
    const devPassword = 'erp_password_dev';
    const devDatabase = COREERP_DB_ENVIRONMENTS.development.database;
    const devUrl = buildPostgresConnectionUrl({
      user: devUser,
      password: devPassword,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.development.port,
      database: devDatabase,
    });

    const shadowUser = COREERP_DB_ENVIRONMENTS.shadow.user;
    const shadowPassword = generateSecret(32);
    const shadowDatabase = COREERP_DB_ENVIRONMENTS.shadow.database;
    const shadowUrl = buildPostgresConnectionUrl({
      user: shadowUser,
      password: shadowPassword,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.shadow.port,
      database: shadowDatabase,
    });

    const sessionSecret = generateSecret(32);
    const bankEncryptionKey = generateSecret(32);
    const biometricBridgeToken = generateSecret(24);
    trackSecrets([
      devPassword,
      devUrl,
      shadowPassword,
      shadowUrl,
      sessionSecret,
      bankEncryptionKey,
      biometricBridgeToken,
    ]);

    writeEnvFileAtomically(
      envPath,
      renderMainDevEnvFile({
        devUser,
        devPassword,
        devDatabase,
        devUrl,
        shadowUser,
        shadowPassword,
        shadowDatabase,
        shadowUrl,
        sessionSecret,
        bankEncryptionKey,
        biometricBridgeToken,
      })
    );
    mainEnv = readEnvFileIfPresent(envPath);
    files.push({ file: '.env', action: 'CREATED' });

    const existingDevVol = detectedVolumes.find((v) => v.environment === 'development');
    if (existingDevVol) {
      warnings.push(
        `Existing development Docker volume "${existingDevVol.matchedDockerVolume}" was detected while creating a new .env. ` +
          'If Prisma reports P1000 against localhost:5432/core_erp, run `npm run db:sync:dev-credentials -- --confirm` to synchronize the existing role password safely without deleting the volume.'
      );
    }
  }

  // 3. Strict cross-file ownership, five-environment separation, shell-override & credential validation
  logger.log('\n2. Environment File Status (Existing files are strictly preserved):');
  for (const f of files) {
    logger.log(`   - ${f.file}: ${f.action}`);
  }

  // 3a. Detect strictly prohibited misplaced cross-environment variables (exact file + variable)
  if (mainEnv) {
    if (mainEnv.STAGING_DATABASE_URL?.trim()) {
      const misplacedEp = normalizeDatabaseUrl(mainEnv.STAGING_DATABASE_URL.trim());
      const epNote = misplacedEp
        ? ` (currently targets ${misplacedEp.hostname}:${misplacedEp.port}/${misplacedEp.database})`
        : ' (unparseable URL)';
      issues.push(
        `[.env :: STAGING_DATABASE_URL] Misplaced variable in .env${epNote}. Staging must use STAGING_DATABASE_URL exclusively from .env.staging (localhost:5435/core_erp_staging). Remove STAGING_DATABASE_URL from .env.`
      );
    }
    for (const stagingKey of [
      'STAGING_POSTGRES_USER',
      'STAGING_POSTGRES_PASSWORD',
      'STAGING_POSTGRES_DB',
    ]) {
      if (mainEnv[stagingKey]?.trim()) {
        issues.push(
          `[.env :: ${stagingKey}] Staging Compose variable must be defined exclusively in .env.staging, not in .env. Remove ${stagingKey} from .env.`
        );
      }
    }
    if (mainEnv.TEST_DATABASE_URL?.trim()) {
      const misplacedEp = normalizeDatabaseUrl(mainEnv.TEST_DATABASE_URL.trim());
      const epNote = misplacedEp
        ? ` (currently targets ${misplacedEp.hostname}:${misplacedEp.port}/${misplacedEp.database})`
        : ' (unparseable URL)';
      issues.push(
        `[.env :: TEST_DATABASE_URL] Misplaced variable in .env${epNote}. Integration tests use TEST_DATABASE_URL exclusively from .env.integration-test (localhost:5434/core_erp_integration_test); automated unit tests use UNIT_TEST_DATABASE_URL (localhost:5433/core_erp_test). Remove TEST_DATABASE_URL from .env.`
      );
    }
  }

  if (stagingEnv) {
    for (const forbiddenKey of [
      'DATABASE_URL',
      'TEST_DATABASE_URL',
      'UNIT_TEST_DATABASE_URL',
      'SHADOW_DATABASE_URL',
    ]) {
      if (stagingEnv[forbiddenKey]?.trim()) {
        issues.push(
          `[.env.staging :: ${forbiddenKey}] Non-staging variable must not be defined in .env.staging. Remove ${forbiddenKey} from .env.staging.`
        );
      }
    }
  }

  if (integrationEnv) {
    for (const forbiddenKey of [
      'DATABASE_URL',
      'STAGING_DATABASE_URL',
      'UNIT_TEST_DATABASE_URL',
      'SHADOW_DATABASE_URL',
    ]) {
      if (integrationEnv[forbiddenKey]?.trim()) {
        issues.push(
          `[.env.integration-test :: ${forbiddenKey}] Non-integration variable must not be defined in .env.integration-test. Remove ${forbiddenKey} from .env.integration-test.`
        );
      }
    }
  }

  // 3b. Detect conflicting or unsafe shell environment overrides before resolving targets
  const validateShellOverride = (params: {
    varName: string;
    fileLabel: string;
    fileValue?: string;
    expectedPort: number;
    expectedDb: string;
  }) => {
    const rawShell = shellEnv[params.varName]?.trim();
    if (!rawShell) return;

    const shellEp = normalizeDatabaseUrl(rawShell);
    if (!shellEp) {
      issues.push(
        `[shell environment :: ${params.varName}] Malformed or unparseable PostgreSQL URL in shell environment.`
      );
      return;
    }
    if (shellEp.hostname !== '127.0.0.1') {
      issues.push(
        `[shell environment :: ${params.varName}] Targets remote host "${shellEp.hostname}". Expected localhost:${params.expectedPort}/${params.expectedDb}. Unset the shell override to avoid misrouting.`
      );
      return;
    }
    if (shellEp.port !== params.expectedPort || shellEp.database !== params.expectedDb) {
      issues.push(
        `[shell environment :: ${params.varName}] Targets ${shellEp.hostname}:${shellEp.port}/${shellEp.database}, but expected localhost:${params.expectedPort}/${params.expectedDb}. Unset or fix the shell override.`
      );
      return;
    }
    if (params.fileValue?.trim()) {
      const fileEp = normalizeDatabaseUrl(params.fileValue.trim());
      const shellCreds = parseUrlCredentialsSafe(rawShell);
      const fileCreds = parseUrlCredentialsSafe(params.fileValue.trim());
      if (
        fileEp &&
        (!areDatabaseEndpointsEqual(shellEp, fileEp) ||
          (shellCreds &&
            fileCreds &&
            (shellCreds.username !== fileCreds.username ||
              shellCreds.password !== fileCreds.password)))
      ) {
        issues.push(
          `[shell environment :: ${params.varName}] Conflicts with [${params.fileLabel} :: ${params.varName}]. Unset the conflicting shell override so ${params.fileLabel} is used unambiguously.`
        );
      }
    }
  };

  validateShellOverride({
    varName: 'DATABASE_URL',
    fileLabel: '.env',
    fileValue: mainEnv?.DATABASE_URL,
    expectedPort: COREERP_DB_ENVIRONMENTS.development.port,
    expectedDb: COREERP_DB_ENVIRONMENTS.development.database,
  });
  validateShellOverride({
    varName: 'UNIT_TEST_DATABASE_URL',
    fileLabel: '.env',
    fileValue: mainEnv?.UNIT_TEST_DATABASE_URL,
    expectedPort: COREERP_DB_ENVIRONMENTS.automatedTest.port,
    expectedDb: COREERP_DB_ENVIRONMENTS.automatedTest.database,
  });
  validateShellOverride({
    varName: 'TEST_DATABASE_URL',
    fileLabel: '.env.integration-test',
    fileValue: integrationEnv?.TEST_DATABASE_URL,
    expectedPort: COREERP_DB_ENVIRONMENTS.integrationTest.port,
    expectedDb: COREERP_DB_ENVIRONMENTS.integrationTest.database,
  });
  validateShellOverride({
    varName: 'STAGING_DATABASE_URL',
    fileLabel: '.env.staging',
    fileValue: stagingEnv?.STAGING_DATABASE_URL,
    expectedPort: COREERP_DB_ENVIRONMENTS.staging.port,
    expectedDb: COREERP_DB_ENVIRONMENTS.staging.database,
  });
  validateShellOverride({
    varName: 'SHADOW_DATABASE_URL',
    fileLabel: '.env',
    fileValue: mainEnv?.SHADOW_DATABASE_URL,
    expectedPort: COREERP_DB_ENVIRONMENTS.shadow.port,
    expectedDb: COREERP_DB_ENVIRONMENTS.shadow.database,
  });

  // 3c. Target 1 — Development (.env :: DATABASE_URL -> localhost:5432 / core_erp)
  let devPasswordFromFile = '';
  const devUrl = mainEnv?.DATABASE_URL?.trim() || '';
  if (mainEnv) {
    const dUser = mainEnv.POSTGRES_USER?.trim() || '';
    const dPass = mainEnv.POSTGRES_PASSWORD?.trim() || '';
    const dDb = mainEnv.POSTGRES_DB?.trim() || '';

    if (!devUrl) {
      issues.push('[.env :: DATABASE_URL] Missing DATABASE_URL for development (localhost:5432/core_erp).');
    } else {
      const devEndpoint = normalizeDatabaseUrl(devUrl);
      if (!devEndpoint) {
        issues.push('[.env :: DATABASE_URL] Not a valid PostgreSQL connection string.');
      } else {
        if (devEndpoint.hostname !== '127.0.0.1') {
          issues.push(
            `[.env :: DATABASE_URL] Targets remote host "${devEndpoint.hostname}"; local Docker development requires localhost:5432/core_erp.`
          );
        }
        if (devEndpoint.port !== COREERP_DB_ENVIRONMENTS.development.port) {
          issues.push(
            `[.env :: DATABASE_URL] Targets port ${devEndpoint.port}, but development must use port ${COREERP_DB_ENVIRONMENTS.development.port}.`
          );
        }
        if (devEndpoint.database !== COREERP_DB_ENVIRONMENTS.development.database) {
          issues.push(
            `[.env :: DATABASE_URL] Targets database "${devEndpoint.database}", but development must target "${COREERP_DB_ENVIRONMENTS.development.database}".`
          );
        }
        const devCreds = parseUrlCredentialsSafe(devUrl);
        if (!devCreds) {
          issues.push('[.env :: DATABASE_URL] Credentials could not be parsed.');
        } else {
          devPasswordFromFile = devCreds.password;
          if (isPlaceholderOrWeak(devPasswordFromFile)) {
            issues.push(
              '[.env :: DATABASE_URL] Uses a placeholder or empty password. Replace it with a real credential matching your PostgreSQL container.'
            );
          }
          if (dPass && devPasswordFromFile !== dPass) {
            issues.push(
              '[.env :: DATABASE_URL vs POSTGRES_PASSWORD] DATABASE_URL password does not match POSTGRES_PASSWORD in .env (causes P1000 authentication failures). Align both values or run `npm run db:sync:dev-credentials -- --confirm`.'
            );
          }
          if (shellEnv.POSTGRES_PASSWORD?.trim() && devPasswordFromFile !== shellEnv.POSTGRES_PASSWORD.trim()) {
            issues.push(
              '[shell environment :: POSTGRES_PASSWORD] Conflicts with [.env :: DATABASE_URL] password.'
            );
          }
          if (dUser && devCreds.username !== dUser) {
            issues.push('[.env :: DATABASE_URL] Username does not match [.env :: POSTGRES_USER].');
          }
          if (dDb && devEndpoint.database !== dDb.toLowerCase()) {
            issues.push('[.env :: DATABASE_URL] Database name does not match [.env :: POSTGRES_DB].');
          }
        }
      }
    }
  }

  // 3d. Target 2 — Automated Unit Test (UNIT_TEST_DATABASE_URL -> localhost:5433 / core_erp_test)
  const rawUnitTestUrl =
    mainEnv?.UNIT_TEST_DATABASE_URL?.trim() ||
    shellEnv.UNIT_TEST_DATABASE_URL?.trim() ||
    DEFAULT_UNIT_TEST_DATABASE_URL;
  const unitTestSource = mainEnv?.UNIT_TEST_DATABASE_URL?.trim()
    ? '.env :: UNIT_TEST_DATABASE_URL'
    : shellEnv.UNIT_TEST_DATABASE_URL?.trim()
      ? 'shell environment :: UNIT_TEST_DATABASE_URL'
      : 'default :: UNIT_TEST_DATABASE_URL';
  if (mainEnv?.UNIT_TEST_DATABASE_URL?.trim()) {
    const unitEp = normalizeDatabaseUrl(mainEnv.UNIT_TEST_DATABASE_URL.trim());
    if (!unitEp) {
      issues.push('[.env :: UNIT_TEST_DATABASE_URL] Not a valid PostgreSQL connection string.');
    } else {
      if (unitEp.hostname !== '127.0.0.1') {
        issues.push(
          `[.env :: UNIT_TEST_DATABASE_URL] Targets remote host "${unitEp.hostname}"; automated tests require localhost:5433/core_erp_test.`
        );
      }
      if (unitEp.port !== COREERP_DB_ENVIRONMENTS.automatedTest.port) {
        issues.push(
          `[.env :: UNIT_TEST_DATABASE_URL] Targets port ${unitEp.port}, but automated tests must use port ${COREERP_DB_ENVIRONMENTS.automatedTest.port}.`
        );
      }
      if (unitEp.database !== COREERP_DB_ENVIRONMENTS.automatedTest.database) {
        issues.push(
          `[.env :: UNIT_TEST_DATABASE_URL] Targets database "${unitEp.database}", but automated tests must target "${COREERP_DB_ENVIRONMENTS.automatedTest.database}".`
        );
      }
      const unitCreds = parseUrlCredentialsSafe(mainEnv.UNIT_TEST_DATABASE_URL.trim());
      if (!unitCreds || isPlaceholderOrWeak(unitCreds.password)) {
        issues.push('[.env :: UNIT_TEST_DATABASE_URL] Uses an empty or placeholder password.');
      }
    }
  }

  // 3e. Target 3 — Integration Test (.env.integration-test :: TEST_DATABASE_URL -> localhost:5434 / core_erp_integration_test)
  let integrationPasswordFromFile = '';
  const integrationUrl = integrationEnv?.TEST_DATABASE_URL?.trim() || '';
  if (integrationEnv) {
    const iPass = integrationEnv.POSTGRES_PASSWORD?.trim() || '';
    integrationPasswordFromFile = iPass;

    if (isPlaceholderOrWeak(iPass)) {
      issues.push(
        '[.env.integration-test :: POSTGRES_PASSWORD] Missing or placeholder POSTGRES_PASSWORD. Set a strong unique secret.'
      );
    }
    if (!integrationUrl) {
      issues.push(
        '[.env.integration-test :: TEST_DATABASE_URL] Missing TEST_DATABASE_URL (localhost:5434/core_erp_integration_test).'
      );
    } else {
      const intEp = normalizeDatabaseUrl(integrationUrl);
      if (!intEp) {
        issues.push('[.env.integration-test :: TEST_DATABASE_URL] Malformed PostgreSQL URL.');
      } else {
        if (intEp.hostname !== '127.0.0.1') {
          issues.push(
            `[.env.integration-test :: TEST_DATABASE_URL] Targets remote host "${intEp.hostname}"; integration tests require localhost:5434/core_erp_integration_test.`
          );
        }
        if (intEp.port !== COREERP_DB_ENVIRONMENTS.integrationTest.port) {
          issues.push(
            `[.env.integration-test :: TEST_DATABASE_URL] Targets port ${intEp.port}, but integration tests must use port ${COREERP_DB_ENVIRONMENTS.integrationTest.port}.`
          );
        }
        if (intEp.database !== COREERP_DB_ENVIRONMENTS.integrationTest.database) {
          issues.push(
            `[.env.integration-test :: TEST_DATABASE_URL] Targets database "${intEp.database}", but integration tests must target "${COREERP_DB_ENVIRONMENTS.integrationTest.database}".`
          );
        }
        const intCreds = parseUrlCredentialsSafe(integrationUrl);
        if (!intCreds) {
          issues.push('[.env.integration-test :: TEST_DATABASE_URL] Credentials could not be parsed.');
        } else {
          if (intCreds.username !== COREERP_DB_ENVIRONMENTS.integrationTest.user) {
            issues.push(
              `[.env.integration-test :: TEST_DATABASE_URL] Username must be "${COREERP_DB_ENVIRONMENTS.integrationTest.user}".`
            );
          }
          if (isPlaceholderOrWeak(intCreds.password)) {
            issues.push(
              '[.env.integration-test :: TEST_DATABASE_URL] Uses an empty or placeholder password.'
            );
          }
          if (iPass && intCreds.password !== iPass) {
            issues.push(
              '[.env.integration-test :: TEST_DATABASE_URL] Password does not match [.env.integration-test :: POSTGRES_PASSWORD] (causes P1000).'
            );
          }
        }
      }
    }
  }

  // 3f. Target 4 — Staging (.env.staging :: STAGING_DATABASE_URL -> localhost:5435 / core_erp_staging)
  let stagingPasswordFromStagingFile = '';
  let stagingUrlFromStagingFile = '';
  if (stagingEnv) {
    const sUser = stagingEnv.STAGING_POSTGRES_USER?.trim() || '';
    const sPass = stagingEnv.STAGING_POSTGRES_PASSWORD?.trim() || '';
    const sDb = stagingEnv.STAGING_POSTGRES_DB?.trim() || '';
    const sUrl = stagingEnv.STAGING_DATABASE_URL?.trim() || '';
    stagingPasswordFromStagingFile = sPass;
    stagingUrlFromStagingFile = sUrl;

    if (!sUser) {
      issues.push('[.env.staging :: STAGING_POSTGRES_USER] Missing STAGING_POSTGRES_USER.');
    }
    if (isPlaceholderOrWeak(sPass)) {
      issues.push(
        '[.env.staging :: STAGING_POSTGRES_PASSWORD] Missing or placeholder STAGING_POSTGRES_PASSWORD. Set a strong unique secret (e.g. `openssl rand -hex 32`).'
      );
    }
    if (sDb !== COREERP_DB_ENVIRONMENTS.staging.database) {
      issues.push(
        `[.env.staging :: STAGING_POSTGRES_DB] Must be "${COREERP_DB_ENVIRONMENTS.staging.database}" (found "${sDb || '(empty)'}").`
      );
    }
    if (!sUrl) {
      issues.push('[.env.staging :: STAGING_DATABASE_URL] Missing STAGING_DATABASE_URL.');
    } else {
      const stagingValidation = validateStagingDatabaseUrl(sUrl, mainEnv?.DATABASE_URL, {
        testDatabaseUrl: integrationEnv?.TEST_DATABASE_URL,
        shadowDatabaseUrl: mainEnv?.SHADOW_DATABASE_URL,
      });
      if (!stagingValidation.valid || !stagingValidation.endpoint) {
        issues.push(
          `[.env.staging :: STAGING_DATABASE_URL] Failed safety validation: ${stagingValidation.error}`
        );
      } else {
        if (
          stagingValidation.endpoint.hostname !== '127.0.0.1' ||
          stagingValidation.endpoint.port !== COREERP_DB_ENVIRONMENTS.staging.port
        ) {
          issues.push(
            `[.env.staging :: STAGING_DATABASE_URL] Must target localhost:${COREERP_DB_ENVIRONMENTS.staging.port}/${COREERP_DB_ENVIRONMENTS.staging.database} (found ${stagingValidation.endpoint.hostname}:${stagingValidation.endpoint.port}/${stagingValidation.endpoint.database}).`
          );
        }
        const sCreds = parseUrlCredentialsSafe(sUrl);
        if (!sCreds) {
          issues.push('[.env.staging :: STAGING_DATABASE_URL] Credentials could not be parsed.');
        } else {
          if (sUser && sCreds.username !== sUser) {
            issues.push(
              '[.env.staging :: STAGING_DATABASE_URL] Username does not match [.env.staging :: STAGING_POSTGRES_USER].'
            );
          }
          if (sPass && sCreds.password !== sPass) {
            issues.push(
              '[.env.staging :: STAGING_DATABASE_URL] Password does not match [.env.staging :: STAGING_POSTGRES_PASSWORD] (causes P1000).'
            );
          }
          if (
            shellEnv.STAGING_POSTGRES_PASSWORD?.trim() &&
            sCreds.password !== shellEnv.STAGING_POSTGRES_PASSWORD.trim()
          ) {
            issues.push(
              '[shell environment :: STAGING_POSTGRES_PASSWORD] Conflicts with [.env.staging :: STAGING_DATABASE_URL] password.'
            );
          }
        }
      }
    }
  }

  // 3g. Target 5 — Prisma Shadow (.env :: SHADOW_DATABASE_URL -> localhost:5436 / core_erp_shadow)
  const rawShadowUrl = mainEnv?.SHADOW_DATABASE_URL?.trim() || '';
  if (mainEnv) {
    if (
      mainEnv.SHADOW_POSTGRES_DB?.trim() &&
      mainEnv.SHADOW_POSTGRES_DB.trim().toLowerCase() !== COREERP_DB_ENVIRONMENTS.shadow.database
    ) {
      issues.push(
        `[.env :: SHADOW_POSTGRES_DB] Must be "${COREERP_DB_ENVIRONMENTS.shadow.database}".`
      );
    }
    if (rawShadowUrl) {
      const shadowEndpoint = normalizeDatabaseUrl(rawShadowUrl);
      if (!shadowEndpoint) {
        issues.push('[.env :: SHADOW_DATABASE_URL] Not a valid PostgreSQL connection string.');
      } else {
        if (shadowEndpoint.hostname !== '127.0.0.1') {
          issues.push(
            `[.env :: SHADOW_DATABASE_URL] Targets remote host "${shadowEndpoint.hostname}"; Prisma shadow DB requires localhost:5436/core_erp_shadow.`
          );
        }
        if (shadowEndpoint.port !== COREERP_DB_ENVIRONMENTS.shadow.port) {
          issues.push(
            `[.env :: SHADOW_DATABASE_URL] Targets port ${shadowEndpoint.port}, but Prisma shadow DB must use port ${COREERP_DB_ENVIRONMENTS.shadow.port}.`
          );
        }
        if (shadowEndpoint.database !== COREERP_DB_ENVIRONMENTS.shadow.database) {
          issues.push(
            `[.env :: SHADOW_DATABASE_URL] Targets database "${shadowEndpoint.database}", but Prisma shadow DB must target "${COREERP_DB_ENVIRONMENTS.shadow.database}".`
          );
        }
        const shadowCreds = parseUrlCredentialsSafe(rawShadowUrl);
        if (!shadowCreds) {
          issues.push('[.env :: SHADOW_DATABASE_URL] Credentials could not be parsed.');
        } else {
          if (isPlaceholderOrWeak(shadowCreds.password)) {
            issues.push('[.env :: SHADOW_DATABASE_URL] Uses an empty or placeholder password.');
          }
          if (
            mainEnv.SHADOW_POSTGRES_USER?.trim() &&
            shadowCreds.username !== mainEnv.SHADOW_POSTGRES_USER.trim()
          ) {
            issues.push(
              '[.env :: SHADOW_DATABASE_URL] Username does not match [.env :: SHADOW_POSTGRES_USER].'
            );
          }
          if (
            mainEnv.SHADOW_POSTGRES_PASSWORD?.trim() &&
            shadowCreds.password !== mainEnv.SHADOW_POSTGRES_PASSWORD.trim()
          ) {
            issues.push(
              '[.env :: SHADOW_DATABASE_URL] Password does not match [.env :: SHADOW_POSTGRES_PASSWORD] (causes P1000).'
            );
          }
        }
      }
    }
  }

  // 3h. Enforce unique staging credentials (never shared with dev or integration)
  if (
    stagingPasswordFromStagingFile &&
    devPasswordFromFile &&
    stagingPasswordFromStagingFile === devPasswordFromFile
  ) {
    issues.push(
      '[.env.staging :: STAGING_POSTGRES_PASSWORD] matches development password in [.env :: POSTGRES_PASSWORD]. Never share staging credentials with development.'
    );
  }
  if (
    stagingPasswordFromStagingFile &&
    integrationPasswordFromFile &&
    stagingPasswordFromStagingFile === integrationPasswordFromFile
  ) {
    issues.push(
      '[.env.staging :: STAGING_POSTGRES_PASSWORD] matches integration-test password in [.env.integration-test :: POSTGRES_PASSWORD]. Never share staging credentials with test environments.'
    );
  }

  // 3i. Five-target pairwise duplicate endpoint check (never allow any two targets to share an endpoint)
  const effectiveShadowUrl =
    rawShadowUrl ||
    'postgresql://erp_shadow_user:shadow_default_placeholder@localhost:5436/core_erp_shadow?schema=public';
  const candidateTargets: Array<{ source: string; url: string }> = [
    { source: '.env :: DATABASE_URL', url: devUrl },
    { source: unitTestSource, url: rawUnitTestUrl },
    { source: '.env.integration-test :: TEST_DATABASE_URL', url: integrationUrl },
    { source: '.env.staging :: STAGING_DATABASE_URL', url: stagingUrlFromStagingFile },
    {
      source: rawShadowUrl ? '.env :: SHADOW_DATABASE_URL' : 'default :: SHADOW_DATABASE_URL',
      url: effectiveShadowUrl,
    },
  ];
  const parsedEndpoints = candidateTargets
    .map((entry) => {
      const ep = normalizeDatabaseUrl(entry.url);
      return ep ? { source: entry.source, ep } : null;
    })
    .filter((entry): entry is { source: string; ep: NonNullable<ReturnType<typeof normalizeDatabaseUrl>> } => entry !== null);

  for (let i = 0; i < parsedEndpoints.length; i += 1) {
    for (let j = i + 1; j < parsedEndpoints.length; j += 1) {
      const a = parsedEndpoints[i];
      const b = parsedEndpoints[j];
      if (areDatabaseEndpointsEqual(a.ep, b.ep)) {
        issues.push(
          `Duplicate database endpoint detected: [${a.source}] and [${b.source}] both resolve to ${a.ep.hostname}:${a.ep.port}/${a.ep.database}.`
        );
      }
    }
  }

  // 4. Print sanitized summary
  logger.log('\n3. Five-Environment Separation Summary:');
  logger.log(
    `   1) Development:      ${devUrl ? sanitizeDatabaseUrl(devUrl) : '[NOT CONFIGURED]'} (.env -> DATABASE_URL)`
  );
  logger.log(
    `   2) Automated Test:   ${sanitizeDatabaseUrl(rawUnitTestUrl)} (UNIT_TEST_DATABASE_URL / port 5433)`
  );
  logger.log(
    `   3) Integration Test: ${integrationUrl ? sanitizeDatabaseUrl(integrationUrl) : '[NOT CONFIGURED]'} (.env.integration-test -> TEST_DATABASE_URL)`
  );
  logger.log(
    `   4) Staging Verify:   ${stagingUrlFromStagingFile ? sanitizeDatabaseUrl(stagingUrlFromStagingFile) : '[NOT CONFIGURED]'} (.env.staging -> STAGING_DATABASE_URL)`
  );
  logger.log(
    `   5) Prisma Shadow:    ${rawShadowUrl ? sanitizeDatabaseUrl(rawShadowUrl) : '[DEFAULT — port 5436 / core_erp_shadow]'} (.env -> SHADOW_DATABASE_URL)`
  );

  const safeWarnings = warnings.map(redact);
  const safeIssues = issues.map(redact);

  if (safeWarnings.length > 0) {
    logger.log('\nWarnings:');
    for (const w of safeWarnings) {
      logger.warn(`   ⚠️  ${w}`);
    }
  }

  if (safeIssues.length > 0) {
    logger.log('\nConfiguration Issues Detected:');
    for (const issue of safeIssues) {
      logger.error(`   ❌ ${issue}`);
    }
    logger.log('');
    return {
      exitCode: 1,
      mode: checkOnly ? 'CHECK' : 'SETUP',
      files,
      detectedVolumes,
      issues: safeIssues,
      warnings: safeWarnings,
    };
  }

  logger.log('\n✅ Database environment setup & consistency checks PASSED.');
  logger.log('   No live database commands, migrations, or volume mutations were performed.\n');

  return {
    exitCode: 0,
    mode: checkOnly ? 'CHECK' : 'SETUP',
    files,
    detectedVolumes,
    issues: [],
    warnings: safeWarnings,
  };
}
