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
  logger?: SetupLogger;
  inspectDockerVolumes?: () => Promise<string[] | null>;
  generateSecret?: (bytes?: number) => string;
}

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

function isPlaceholderOrWeak(val: string | undefined): boolean {
  if (!val || val.trim() === '') return true;
  const lower = val.trim().toLowerCase();
  if (PLACEHOLDER_SECRETS.has(lower)) return true;
  if (lower.includes('replace_with') || lower.includes('<') || lower.includes('>')) return true;
  return false;
}

function renderStagingEnvFile(params: {
  user: string;
  password: string;
  database: string;
  stagingUrl: string;
}): string {
  return [
    '# ==============================================================================',
    '# CoreERP Dedicated Staging Verification Environment (.env.staging)',
    '# Git-ignored local credentials generated by `npm run db:setup`.',
    '# Used exclusively by docker-compose.staging.yml (port 5435 / core_erp_staging).',
    '# ==============================================================================',
    `STAGING_POSTGRES_USER="${params.user}"`,
    `STAGING_POSTGRES_PASSWORD="${params.password}"`,
    `STAGING_POSTGRES_DB="${params.database}"`,
    `STAGING_DATABASE_URL="${params.stagingUrl}"`,
    '',
  ].join('\n');
}

function renderIntegrationEnvFile(params: { password: string; testUrl: string }): string {
  return [
    '# ==============================================================================',
    '# CoreERP Dedicated PostgreSQL 16 Integration Test Environment (.env.integration-test)',
    '# Git-ignored local credentials generated by `npm run db:setup`.',
    '# Used exclusively by docker-compose.integration-test.yml (port 5434 / core_erp_integration_test).',
    '# ==============================================================================',
    `POSTGRES_PASSWORD="${params.password}"`,
    `TEST_DATABASE_URL="${params.testUrl}"`,
    '',
  ].join('\n');
}

function renderMainDevEnvFile(params: {
  devUser: string;
  devPassword: string;
  devDatabase: string;
  devUrl: string;
  shadowUser: string;
  shadowPassword: string;
  shadowDatabase: string;
  shadowUrl: string;
  stagingUrl: string;
  sessionSecret: string;
  bankEncryptionKey: string;
  biometricBridgeToken: string;
}): string {
  return [
    '# ==============================================================================',
    '# CoreERP Local Environment Configuration (.env)',
    '# Git-ignored local configuration generated by `npm run db:setup`.',
    '# Never commit this file or share its credentials across environments.',
    '# ==============================================================================',
    'PORT=3000',
    'NODE_ENV=development',
    '',
    '# 1. Primary Development Database (Port 5432 -> core_erp)',
    `POSTGRES_USER="${params.devUser}"`,
    `POSTGRES_PASSWORD="${params.devPassword}"`,
    `POSTGRES_DB="${params.devDatabase}"`,
    `DATABASE_URL="${params.devUrl}"`,
    '',
    '# 2. Dedicated Staging Verification Target (Port 5435 -> core_erp_staging)',
    '# Synchronized with .env.staging (docker-compose.staging.yml). Never points to core_erp or core_erp_test.',
    `STAGING_DATABASE_URL="${params.stagingUrl}"`,
    '',
    '# 3. Dedicated Prisma Shadow Database (Port 5436 -> core_erp_shadow)',
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
    'BANK_ACTIVE_KEY_ID="k1"',
    "BANK_HISTORICAL_KEYS='{}'",
    '',
  ].join('\n');
}

function collectSecretsFromEnvMap(map: Record<string, string> | null): string[] {
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

/**
 * Repeatable, idempotent, non-destructive CoreERP database environment setup & validator.
 *
 * Guarantees:
 * - Never overwrites existing `.env`, `.env.staging`, or `.env.integration-test` files.
 * - Never prints passwords, tokens, or raw database URLs.
 * - Never deletes, resets, or modifies Docker volumes or databases.
 * - Establishes strict five-environment isolation (5432 dev, 5433 test, 5434 integration, 5435 staging, 5436 shadow).
 * - Detects credential mismatches and existing Docker volumes with clear, actionable instructions.
 */
export async function runDatabaseEnvironmentSetup(
  options: DatabaseSetupOptions = {}
): Promise<DatabaseSetupResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const checkOnly = options.checkOnly ?? false;
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
  let resolvedStagingPassword: string;
  let resolvedStagingUser: string = COREERP_DB_ENVIRONMENTS.staging.user;
  let resolvedStagingDb: string = COREERP_DB_ENVIRONMENTS.staging.database;
  let resolvedStagingUrl: string;

  if (stagingEnv) {
    files.push({ file: '.env.staging', action: 'PRESERVED' });
    resolvedStagingUser = stagingEnv.STAGING_POSTGRES_USER || COREERP_DB_ENVIRONMENTS.staging.user;
    resolvedStagingPassword = stagingEnv.STAGING_POSTGRES_PASSWORD || '';
    resolvedStagingDb = stagingEnv.STAGING_POSTGRES_DB || COREERP_DB_ENVIRONMENTS.staging.database;
    resolvedStagingUrl =
      stagingEnv.STAGING_DATABASE_URL ||
      (resolvedStagingPassword
        ? buildPostgresConnectionUrl({
            user: resolvedStagingUser,
            password: resolvedStagingPassword,
            host: 'localhost',
            port: COREERP_DB_ENVIRONMENTS.staging.port,
            database: resolvedStagingDb,
          })
        : '');
  } else if (checkOnly) {
    files.push({ file: '.env.staging', action: 'MISSING' });
    issues.push(
      'Missing .env.staging file for isolated staging PostgreSQL (port 5435 / core_erp_staging). Run `npm run db:setup` to generate it safely.'
    );
    resolvedStagingPassword = '';
    resolvedStagingUrl = '';
  } else {
    resolvedStagingPassword = generateSecret(32);
    trackSecrets([resolvedStagingPassword]);
    resolvedStagingUrl = buildPostgresConnectionUrl({
      user: resolvedStagingUser,
      password: resolvedStagingPassword,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.staging.port,
      database: resolvedStagingDb,
    });
    trackSecrets([resolvedStagingUrl]);

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
      'Missing .env.integration-test file for isolated integration PostgreSQL (port 5434 / core_erp_integration_test). Run `npm run db:setup` to generate it safely.'
    );
  } else {
    const integrationPassword = generateSecret(32);
    trackSecrets([integrationPassword]);
    const integrationUrl = buildPostgresConnectionUrl({
      user: COREERP_DB_ENVIRONMENTS.integrationTest.user,
      password: integrationPassword,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.integrationTest.port,
      database: COREERP_DB_ENVIRONMENTS.integrationTest.database,
    });
    trackSecrets([integrationUrl]);

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

  // 2c. Main development environment file (.env -> core_erp on 5432, core_erp_shadow on 5436, staging URL ref)
  if (mainEnv) {
    files.push({ file: '.env', action: 'PRESERVED' });
  } else if (checkOnly) {
    files.push({ file: '.env', action: 'MISSING' });
    issues.push(
      'Missing .env file for local development (port 5432 / core_erp) and Prisma shadow DB (port 5436 / core_erp_shadow). Run `npm run db:setup` to initialize it safely.'
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
        stagingUrl: resolvedStagingUrl,
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

  // 3. Cross-file credential consistency & five-environment isolation validation
  logger.log('\n2. Environment File Status (Existing files are strictly preserved):');
  for (const f of files) {
    logger.log(`   - ${f.file}: ${f.action}`);
  }

  // Validate .env.staging consistency
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
      issues.push('.env.staging is missing STAGING_POSTGRES_USER.');
    }
    if (isPlaceholderOrWeak(sPass)) {
      issues.push(
        '.env.staging has a missing or placeholder STAGING_POSTGRES_PASSWORD. Set a strong unique secret (e.g. `openssl rand -hex 32`).'
      );
    }
    if (sDb !== COREERP_DB_ENVIRONMENTS.staging.database) {
      issues.push(
        `.env.staging STAGING_POSTGRES_DB must be "${COREERP_DB_ENVIRONMENTS.staging.database}" (found "${sDb || '(empty)'}").`
      );
    }
    if (!sUrl) {
      issues.push('.env.staging is missing STAGING_DATABASE_URL.');
    } else {
      const stagingValidation = validateStagingDatabaseUrl(sUrl, mainEnv?.DATABASE_URL, {
        testDatabaseUrl: integrationEnv?.TEST_DATABASE_URL,
        shadowDatabaseUrl: mainEnv?.SHADOW_DATABASE_URL,
      });
      if (!stagingValidation.valid) {
        issues.push(`.env.staging STAGING_DATABASE_URL failed safety validation: ${stagingValidation.error}`);
      } else {
        try {
          const parsed = new URL(sUrl);
          if (sUser && decodeURIComponent(parsed.username) !== sUser) {
            issues.push('.env.staging STAGING_DATABASE_URL username does not match STAGING_POSTGRES_USER.');
          }
          if (sPass && decodeURIComponent(parsed.password) !== sPass) {
            issues.push(
              '.env.staging STAGING_DATABASE_URL password does not match STAGING_POSTGRES_PASSWORD (would cause P1000).'
            );
          }
        } catch {
          issues.push('.env.staging STAGING_DATABASE_URL could not be parsed.');
        }
      }
    }
  }

  // Validate .env.integration-test consistency
  let integrationPasswordFromFile = '';
  if (integrationEnv) {
    const iPass = integrationEnv.POSTGRES_PASSWORD?.trim() || '';
    const iUrl = integrationEnv.TEST_DATABASE_URL?.trim() || '';
    integrationPasswordFromFile = iPass;

    if (isPlaceholderOrWeak(iPass)) {
      issues.push(
        '.env.integration-test has a missing or placeholder POSTGRES_PASSWORD. Set a strong unique secret.'
      );
    }
    if (iUrl) {
      try {
        const parsed = new URL(iUrl);
        const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, ''));
        if (parsed.port !== String(COREERP_DB_ENVIRONMENTS.integrationTest.port)) {
          issues.push(
            `.env.integration-test TEST_DATABASE_URL must target port ${COREERP_DB_ENVIRONMENTS.integrationTest.port}.`
          );
        }
        if (dbName !== COREERP_DB_ENVIRONMENTS.integrationTest.database) {
          issues.push(
            `.env.integration-test TEST_DATABASE_URL must target database "${COREERP_DB_ENVIRONMENTS.integrationTest.database}".`
          );
        }
        if (iPass && decodeURIComponent(parsed.password) !== iPass) {
          issues.push(
            '.env.integration-test TEST_DATABASE_URL password does not match POSTGRES_PASSWORD (would cause P1000).'
          );
        }
      } catch {
        issues.push('.env.integration-test TEST_DATABASE_URL is malformed.');
      }
    }
  }

  // Validate .env consistency and cross-environment separation
  let devPasswordFromFile = '';
  if (mainEnv) {
    const dUser = mainEnv.POSTGRES_USER?.trim() || '';
    const dPass = mainEnv.POSTGRES_PASSWORD?.trim() || '';
    const dDb = mainEnv.POSTGRES_DB?.trim() || '';
    const dUrl = mainEnv.DATABASE_URL?.trim() || '';

    if (!dUrl) {
      issues.push('.env is missing DATABASE_URL.');
    } else {
      const devEndpoint = normalizeDatabaseUrl(dUrl);
      if (!devEndpoint) {
        issues.push('.env DATABASE_URL is not a valid PostgreSQL connection string.');
      } else {
        try {
          const parsedDev = new URL(dUrl);
          devPasswordFromFile = decodeURIComponent(parsedDev.password || '');
          if (isPlaceholderOrWeak(devPasswordFromFile)) {
            issues.push(
              '.env DATABASE_URL uses a placeholder or empty password. Replace it with a real credential matching your PostgreSQL container.'
            );
          }
          if (dPass && devPasswordFromFile !== dPass) {
            issues.push(
              '.env DATABASE_URL password does not match POSTGRES_PASSWORD (this causes P1000 authentication failures). Align both values or run `npm run db:sync:dev-credentials -- --confirm`.'
            );
          }
          if (dUser && decodeURIComponent(parsedDev.username || '') !== dUser) {
            issues.push('.env DATABASE_URL username does not match POSTGRES_USER.');
          }
          if (dDb && devEndpoint.database !== dDb.toLowerCase()) {
            issues.push('.env DATABASE_URL database name does not match POSTGRES_DB.');
          }
        } catch {
          issues.push('.env DATABASE_URL could not be parsed.');
        }
      }
    }

    // If .env defines STAGING_DATABASE_URL, validate it AND confirm parity with .env.staging
    if (mainEnv.STAGING_DATABASE_URL?.trim()) {
      const envStagingUrl = mainEnv.STAGING_DATABASE_URL.trim();
      const stagingVal = validateStagingDatabaseUrl(envStagingUrl, mainEnv.DATABASE_URL, {
        testDatabaseUrl: integrationEnv?.TEST_DATABASE_URL,
        shadowDatabaseUrl: mainEnv.SHADOW_DATABASE_URL,
      });
      if (!stagingVal.valid) {
        issues.push(`.env STAGING_DATABASE_URL is invalid: ${stagingVal.error}`);
      } else if (stagingUrlFromStagingFile) {
        try {
          const parsedA = new URL(envStagingUrl);
          const parsedB = new URL(stagingUrlFromStagingFile);
          if (
            decodeURIComponent(parsedA.password) !== decodeURIComponent(parsedB.password) ||
            decodeURIComponent(parsedA.username) !== decodeURIComponent(parsedB.username) ||
            parsedA.port !== parsedB.port
          ) {
            issues.push(
              'Staging credential mismatch between .env (STAGING_DATABASE_URL) and .env.staging. Update .env STAGING_DATABASE_URL to match .env.staging or unset STAGING_DATABASE_URL in .env so verification loads .env.staging directly.'
            );
          }
        } catch {
          issues.push('Failed to compare STAGING_DATABASE_URL between .env and .env.staging.');
        }
      }
    }

    // Validate SHADOW_DATABASE_URL if set
    if (mainEnv.SHADOW_DATABASE_URL?.trim()) {
      const shadowUrl = mainEnv.SHADOW_DATABASE_URL.trim();
      const shadowEndpoint = normalizeDatabaseUrl(shadowUrl);
      if (!shadowEndpoint) {
        issues.push('.env SHADOW_DATABASE_URL is not a valid PostgreSQL connection string.');
      } else {
        if (shadowEndpoint.database !== COREERP_DB_ENVIRONMENTS.shadow.database) {
          issues.push(
            `.env SHADOW_DATABASE_URL must target database "${COREERP_DB_ENVIRONMENTS.shadow.database}" (found "${shadowEndpoint.database}").`
          );
        }
        const devEp = normalizeDatabaseUrl(mainEnv.DATABASE_URL);
        if (devEp && areDatabaseEndpointsEqual(shadowEndpoint, devEp)) {
          issues.push('.env SHADOW_DATABASE_URL must not target the same database endpoint as DATABASE_URL.');
        }
        try {
          const parsedShadow = new URL(shadowUrl);
          if (
            mainEnv.SHADOW_POSTGRES_PASSWORD &&
            decodeURIComponent(parsedShadow.password || '') !== mainEnv.SHADOW_POSTGRES_PASSWORD
          ) {
            issues.push('.env SHADOW_DATABASE_URL password does not match SHADOW_POSTGRES_PASSWORD.');
          }
        } catch {
          issues.push('.env SHADOW_DATABASE_URL could not be parsed.');
        }
      }
    }
  }

  // Enforce unique staging credentials (never shared with dev or integration)
  if (
    stagingPasswordFromStagingFile &&
    devPasswordFromFile &&
    stagingPasswordFromStagingFile === devPasswordFromFile
  ) {
    issues.push(
      'Staging password in .env.staging matches development password in .env. Never share staging credentials with development.'
    );
  }
  if (
    stagingPasswordFromStagingFile &&
    integrationPasswordFromFile &&
    stagingPasswordFromStagingFile === integrationPasswordFromFile
  ) {
    issues.push(
      'Staging password in .env.staging matches integration-test password in .env.integration-test. Never share staging credentials with test environments.'
    );
  }

  // 4. Print sanitized summary
  logger.log('\n3. Five-Environment Separation Summary:');
  logger.log(
    `   1) Development:      ${mainEnv?.DATABASE_URL ? sanitizeDatabaseUrl(mainEnv.DATABASE_URL) : '[NOT CONFIGURED]'} (docker-compose.dev.yml -> postgres)`
  );
  logger.log(
    '   2) Automated Test:   postgresql://erp_test_user:*****@localhost:5433/core_erp_test (docker-compose.dev.yml -> postgres-test)'
  );
  logger.log(
    `   3) Integration Test: ${integrationEnv?.TEST_DATABASE_URL ? sanitizeDatabaseUrl(integrationEnv.TEST_DATABASE_URL) : 'postgresql://erp_integration_user:*****@localhost:5434/core_erp_integration_test'} (docker-compose.integration-test.yml)`
  );
  logger.log(
    `   4) Staging Verify:   ${stagingUrlFromStagingFile ? sanitizeDatabaseUrl(stagingUrlFromStagingFile) : '[NOT CONFIGURED]'} (docker-compose.staging.yml)`
  );
  logger.log(
    `   5) Prisma Shadow:    ${mainEnv?.SHADOW_DATABASE_URL ? sanitizeDatabaseUrl(mainEnv.SHADOW_DATABASE_URL) : '[OPTIONAL — port 5436 / core_erp_shadow]'} (docker-compose.dev.yml --profile shadow)`
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
