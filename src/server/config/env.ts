import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import dotenv from 'dotenv';

const isTestRuntime =
  typeof process !== 'undefined' &&
  (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true');

// In development, ensure default development .env file exists if missing
if (
  typeof process !== 'undefined' &&
  process.env.NODE_ENV !== 'production' &&
  process.env.VITEST !== 'true' &&
  process.env.COREERP_INTEGRATION_TEST_MODE !== 'true' &&
  !process.env.DATABASE_URL
) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      const defaultDevEnv = [
        'PORT=3000',
        'NODE_ENV=development',
        'POSTGRES_USER=erp_user',
        'POSTGRES_PASSWORD=erp_password_dev',
        'POSTGRES_DB=core_erp',
        'DATABASE_URL="postgresql://erp_user:erp_password_dev@localhost:5432/core_erp?schema=public"',
        '# Run `npm run db:setup` to generate isolated staging (5435), shadow (5436), and integration (5434) credentials.',
        'SESSION_SECRET="dev_insecure_fallback_session_secret_32_chars_long"',
        'BIOMETRIC_BRIDGE_TOKEN="dev_biometric_bridge_secret_token_123456"',
        '',
      ].join('\n');
      fs.writeFileSync(envPath, defaultDevEnv, 'utf-8');
    }
  } catch {
    // Non-fatal if filesystem is read-only
  }
}

// Load environment variables from .env if present (skipped in test/Vitest runtimes)
if (!isTestRuntime) {
  dotenv.config();
}

const APPROVED_INTEGRATION_TEST_HOSTS = new Set(['localhost', '127.0.0.1']);
const INTEGRATION_TEST_DB_PORT = '5434';
const INTEGRATION_TEST_DB_NAME = 'core_erp_integration_test';

/**
 * Independently validates TEST_DATABASE_URL for isolated PostgreSQL 16 integration-test mode.
 * Credentials and raw connection strings are never included in returned error messages.
 */
function validateIntegrationTestDatabaseUrl(urlValue: string | undefined): string | null {
  if (!urlValue || urlValue.trim() === '') {
    return 'TEST_DATABASE_URL is required when NODE_ENV=test and COREERP_INTEGRATION_TEST_MODE=true.';
  }

  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    return 'TEST_DATABASE_URL must be a valid PostgreSQL connection string in integration test mode.';
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return 'TEST_DATABASE_URL must use a PostgreSQL protocol ("postgresql://" or "postgres://") in integration test mode.';
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!APPROVED_INTEGRATION_TEST_HOSTS.has(hostname)) {
    return 'TEST_DATABASE_URL must target localhost or 127.0.0.1 in integration test mode.';
  }

  if (parsed.port !== INTEGRATION_TEST_DB_PORT) {
    return `TEST_DATABASE_URL must explicitly target port ${INTEGRATION_TEST_DB_PORT} in integration test mode.`;
  }

  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (dbName !== INTEGRATION_TEST_DB_NAME) {
    return `TEST_DATABASE_URL must target database "${INTEGRATION_TEST_DB_NAME}" in integration test mode.`;
  }

  return null;
}

const KNOWN_DEV_SECRETS = new Set([
  'dev_session_secret_min_32_characters_long_for_security',
  'dev_insecure_fallback_session_secret_32_chars_long',
  'replace_with_64_character_cryptographically_secure_random_string',
  'a_secure_random_production_secret_key_64_characters_min',
  'super_secret_session_key_32_characters_minimum',
  'default_session_secret',
  'secret',
  'changeme',
  'password',
  '12345678901234567890123456789012',
]);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z
      .union([z.string(), z.number()])
      .default('3000')
      .transform((val) => (typeof val === 'number' ? val : parseInt(val, 10)))
      .refine((val) => !isNaN(val) && val > 0 && val <= 65535, {
        message: 'PORT must be a valid integer between 1 and 65535',
      }),
    DATABASE_URL: z
      .string()
      .optional()
      .transform((val) =>
        val === undefined ? undefined : val.trim().replace(/^["']|["']$/g, '')
      ),
    UNIT_TEST_DATABASE_URL: z
      .string()
      .optional()
      .transform((val) =>
        val === undefined ? undefined : val.trim().replace(/^["']|["']$/g, '')
      ),
    TEST_DATABASE_URL: z
      .string()
      .optional()
      .transform((val) =>
        val === undefined ? undefined : val.trim().replace(/^["']|["']$/g, '')
      ),
    STAGING_DATABASE_URL: z
      .string()
      .optional()
      .transform((val) =>
        val === undefined ? undefined : val.trim().replace(/^["']|["']$/g, '')
      ),
    SHADOW_DATABASE_URL: z
      .string()
      .optional()
      .transform((val) =>
        val === undefined ? undefined : val.trim().replace(/^["']|["']$/g, '')
      ),
    COREERP_INTEGRATION_TEST_MODE: z.string().optional(),
    SESSION_SECRET: z
      .string()
      .min(16, 'SESSION_SECRET must be at least 16 characters for security')
      .default('dev_insecure_fallback_session_secret_32_chars_long'),
    BOOTSTRAP_SUPER_ADMIN_EMAIL: z.string().email().optional(),
    BOOTSTRAP_SUPER_ADMIN_PASSWORD: z.string().min(8).optional(),
    BOOTSTRAP_COMPANY_NAME: z.string().min(2).optional(),
    BOOTSTRAP_COMPANY_CODE: z.string().min(2).max(10).optional(),
    BIOMETRIC_BRIDGE_TOKEN: z.string().optional(),
    BANK_ENCRYPTION_KEY: z.string().optional(),
    BANK_ACTIVE_KEY_ID: z
      .string()
      .trim()
      .regex(
        /^[a-zA-Z0-9_-]{1,32}$/,
        'BANK_ACTIVE_KEY_ID must be 1-32 alphanumeric, dash, or underscore characters'
      )
      .default('k1'),
    BANK_HISTORICAL_KEYS: z.string().optional(),
    POSTGRES_USER: z.string().optional(),
    POSTGRES_PASSWORD: z.string().optional(),
    POSTGRES_DB: z.string().optional(),
    STAGING_POSTGRES_USER: z.string().optional(),
    STAGING_POSTGRES_PASSWORD: z.string().optional(),
    STAGING_POSTGRES_DB: z.string().optional(),
    SHADOW_POSTGRES_USER: z.string().optional(),
    SHADOW_POSTGRES_PASSWORD: z.string().optional(),
    SHADOW_POSTGRES_DB: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const isIntegrationFlagSet = data.COREERP_INTEGRATION_TEST_MODE === 'true';
    const isIntegrationTestMode = data.NODE_ENV === 'test' && isIntegrationFlagSet;

    if (isIntegrationFlagSet && data.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COREERP_INTEGRATION_TEST_MODE'],
        message: 'COREERP_INTEGRATION_TEST_MODE=true is only permitted when NODE_ENV=test.',
      });
    }

    if (isIntegrationTestMode) {
      if (data.DATABASE_URL && data.DATABASE_URL.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message:
            'Conflicting DATABASE_URL detected in integration test mode. DATABASE_URL must remain unset when COREERP_INTEGRATION_TEST_MODE=true.',
        });
      }

      const integrationUrlError = validateIntegrationTestDatabaseUrl(data.TEST_DATABASE_URL);
      if (integrationUrlError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TEST_DATABASE_URL'],
          message: integrationUrlError,
        });
      }
    } else {
      if (!data.DATABASE_URL || data.DATABASE_URL.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message:
            'DATABASE_URL is required. PostgreSQL is the sole operational database. Please configure a valid PostgreSQL connection string.',
        });
      } else if (
        !data.DATABASE_URL.startsWith('postgresql://') &&
        !data.DATABASE_URL.startsWith('postgres://')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message:
            'DATABASE_URL must be a valid PostgreSQL connection string starting with "postgresql://" or "postgres://". Other database providers or local file fallbacks are strictly prohibited.',
        });
      }
    }

    // 0. Development Docker Compose / DATABASE_URL consistency check
    if (data.NODE_ENV === 'development' && data.DATABASE_URL) {
      try {
        const parsedUrl = new URL(data.DATABASE_URL);
        const urlPass = decodeURIComponent(parsedUrl.password || '');
        const urlUser = decodeURIComponent(parsedUrl.username || '');
        const urlDb = decodeURIComponent(parsedUrl.pathname.replace(/^\//, '').split('?')[0]);

        if (data.POSTGRES_PASSWORD && urlPass && urlPass !== data.POSTGRES_PASSWORD) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['DATABASE_URL'],
            message:
              'DATABASE_URL password does not match POSTGRES_PASSWORD. In development, ensure Docker Compose and application DATABASE_URL use matching credentials.',
          });
        }
        if (data.POSTGRES_USER && urlUser && urlUser !== data.POSTGRES_USER) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['DATABASE_URL'],
            message:
              'DATABASE_URL username does not match POSTGRES_USER. Ensure Docker Compose and application DATABASE_URL use matching credentials.',
          });
        }
        if (data.POSTGRES_DB && urlDb && urlDb !== data.POSTGRES_DB) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['DATABASE_URL'],
            message:
              'DATABASE_URL database name does not match POSTGRES_DB. Ensure Docker Compose and application DATABASE_URL target the same database.',
          });
        }
      } catch {
        // Base validation handles unparseable URLs
      }
    }

    // 0b. Cross-environment database URL isolation & consistency checks (never silent fallback)
    const extractEndpointKey = (rawUrl: string | undefined): string | null => {
      if (!rawUrl || rawUrl.trim() === '') return null;
      try {
        const p = new URL(rawUrl);
        if (p.protocol !== 'postgresql:' && p.protocol !== 'postgres:') return null;
        const host = p.hostname.toLowerCase();
        const normHost = host === 'localhost' || host === '::1' || host === '[::1]' ? '127.0.0.1' : host;
        const port = p.port || '5432';
        const db = decodeURIComponent(p.pathname.replace(/^\/+/, '').replace(/\/+$/, '')).toLowerCase();
        if (!db) return null;
        return `${normHost}:${port}/${db}`;
      } catch {
        return null;
      }
    };

    const primaryKey = extractEndpointKey(data.DATABASE_URL);
    const unitTestKey = extractEndpointKey(data.UNIT_TEST_DATABASE_URL);
    const testKey = extractEndpointKey(data.TEST_DATABASE_URL);
    const stagingKey = extractEndpointKey(data.STAGING_DATABASE_URL);
    const shadowKey = extractEndpointKey(data.SHADOW_DATABASE_URL);

    if (data.UNIT_TEST_DATABASE_URL && data.UNIT_TEST_DATABASE_URL.length > 0) {
      if (
        !data.UNIT_TEST_DATABASE_URL.startsWith('postgresql://') &&
        !data.UNIT_TEST_DATABASE_URL.startsWith('postgres://')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['UNIT_TEST_DATABASE_URL'],
          message:
            'UNIT_TEST_DATABASE_URL must be a valid PostgreSQL connection string targeting local port 5433 and database "core_erp_test".',
        });
      } else {
        try {
          const parsedUnit = new URL(data.UNIT_TEST_DATABASE_URL);
          const unitHost = parsedUnit.hostname.toLowerCase();
          const unitPort = parsedUnit.port || '5432';
          const unitDb = decodeURIComponent(
            parsedUnit.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
          ).toLowerCase();

          if (!APPROVED_INTEGRATION_TEST_HOSTS.has(unitHost)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['UNIT_TEST_DATABASE_URL'],
              message:
                'UNIT_TEST_DATABASE_URL must target localhost or 127.0.0.1 (automated test database only).',
            });
          }
          if (unitPort !== '5433') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['UNIT_TEST_DATABASE_URL'],
              message:
                'UNIT_TEST_DATABASE_URL must target port 5433 (core_erp_test). Do not point automated tests to dev (5432), integration (5434), staging (5435), or shadow (5436).',
            });
          }
          if (unitDb !== 'core_erp_test') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['UNIT_TEST_DATABASE_URL'],
              message:
                'UNIT_TEST_DATABASE_URL must point exclusively to database "core_erp_test".',
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['UNIT_TEST_DATABASE_URL'],
            message: 'UNIT_TEST_DATABASE_URL is malformed or unparseable.',
          });
        }
      }

      if (
        unitTestKey &&
        ((primaryKey && unitTestKey === primaryKey && data.NODE_ENV !== 'test') ||
          (testKey && unitTestKey === testKey) ||
          (stagingKey && unitTestKey === stagingKey) ||
          (shadowKey && unitTestKey === shadowKey))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['UNIT_TEST_DATABASE_URL'],
          message:
            'Conflicting database configuration: UNIT_TEST_DATABASE_URL must be isolated from DATABASE_URL, TEST_DATABASE_URL, STAGING_DATABASE_URL, and SHADOW_DATABASE_URL.',
        });
      }
    }

    if (data.STAGING_DATABASE_URL && data.STAGING_DATABASE_URL.length > 0) {
      if (
        !data.STAGING_DATABASE_URL.startsWith('postgresql://') &&
        !data.STAGING_DATABASE_URL.startsWith('postgres://')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STAGING_DATABASE_URL'],
          message:
            'STAGING_DATABASE_URL must be a valid PostgreSQL connection string targeting core_erp_staging.',
        });
      } else {
        try {
          const parsedStaging = new URL(data.STAGING_DATABASE_URL);
          const stagingHost = parsedStaging.hostname.toLowerCase();
          const stagingPort = parsedStaging.port || '5432';
          const stagingDb = decodeURIComponent(
            parsedStaging.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
          ).toLowerCase();
          if (stagingDb !== 'core_erp_staging') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['STAGING_DATABASE_URL'],
              message:
                'STAGING_DATABASE_URL must point exclusively to database "core_erp_staging" (never core_erp, core_erp_test, core_erp_integration_test, or core_erp_shadow).',
            });
          }
          const isStagingLoopback =
            stagingHost === 'localhost' ||
            stagingHost === '127.0.0.1' ||
            stagingHost === '::1' ||
            stagingHost === '[::1]';
          if (
            isStagingLoopback &&
            (stagingPort === '5432' ||
              stagingPort === '5433' ||
              stagingPort === '5434' ||
              stagingPort === '5436')
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['STAGING_DATABASE_URL'],
              message: `STAGING_DATABASE_URL cannot target localhost port ${stagingPort} (reserved for another CoreERP environment). Local staging must use port 5435 via .env.staging.`,
            });
          }
          if (
            data.STAGING_POSTGRES_PASSWORD &&
            decodeURIComponent(parsedStaging.password || '') !== data.STAGING_POSTGRES_PASSWORD
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['STAGING_DATABASE_URL'],
              message:
                'STAGING_DATABASE_URL password does not match STAGING_POSTGRES_PASSWORD. Ensure Docker Compose and Prisma use matching staging credentials.',
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['STAGING_DATABASE_URL'],
            message: 'STAGING_DATABASE_URL is malformed or unparseable.',
          });
        }
      }

      if (stagingKey && primaryKey && stagingKey === primaryKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STAGING_DATABASE_URL'],
          message:
            'Conflicting database configuration: STAGING_DATABASE_URL must not target the same endpoint as DATABASE_URL.',
        });
      }
      if (stagingKey && unitTestKey && stagingKey === unitTestKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STAGING_DATABASE_URL'],
          message:
            'Conflicting database configuration: STAGING_DATABASE_URL must not target the same endpoint as UNIT_TEST_DATABASE_URL.',
        });
      }
      if (stagingKey && testKey && stagingKey === testKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STAGING_DATABASE_URL'],
          message:
            'Conflicting database configuration: STAGING_DATABASE_URL must not target the same endpoint as TEST_DATABASE_URL.',
        });
      }
    }

    if (data.SHADOW_DATABASE_URL && data.SHADOW_DATABASE_URL.length > 0) {
      if (
        !data.SHADOW_DATABASE_URL.startsWith('postgresql://') &&
        !data.SHADOW_DATABASE_URL.startsWith('postgres://')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SHADOW_DATABASE_URL'],
          message:
            'SHADOW_DATABASE_URL must be a valid PostgreSQL connection string targeting core_erp_shadow.',
        });
      } else {
        try {
          const parsedShadow = new URL(data.SHADOW_DATABASE_URL);
          const shadowHost = parsedShadow.hostname.toLowerCase();
          const shadowPort = parsedShadow.port || '5432';
          const shadowDb = decodeURIComponent(
            parsedShadow.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
          ).toLowerCase();
          if (shadowDb !== 'core_erp_shadow') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['SHADOW_DATABASE_URL'],
              message:
                'SHADOW_DATABASE_URL must point exclusively to database "core_erp_shadow".',
            });
          }
          const isShadowLoopback =
            shadowHost === 'localhost' ||
            shadowHost === '127.0.0.1' ||
            shadowHost === '::1' ||
            shadowHost === '[::1]';
          if (
            isShadowLoopback &&
            (shadowPort === '5432' ||
              shadowPort === '5433' ||
              shadowPort === '5434' ||
              shadowPort === '5435')
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['SHADOW_DATABASE_URL'],
              message: `SHADOW_DATABASE_URL cannot target localhost port ${shadowPort} (reserved for another CoreERP environment). Local Prisma shadow must use port 5436.`,
            });
          }
          if (
            data.SHADOW_POSTGRES_PASSWORD &&
            decodeURIComponent(parsedShadow.password || '') !== data.SHADOW_POSTGRES_PASSWORD
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['SHADOW_DATABASE_URL'],
              message:
                'SHADOW_DATABASE_URL password does not match SHADOW_POSTGRES_PASSWORD.',
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['SHADOW_DATABASE_URL'],
            message: 'SHADOW_DATABASE_URL is malformed or unparseable.',
          });
        }
      }

      if (
        shadowKey &&
        ((primaryKey && shadowKey === primaryKey) ||
          (unitTestKey && shadowKey === unitTestKey) ||
          (stagingKey && shadowKey === stagingKey) ||
          (testKey && shadowKey === testKey))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SHADOW_DATABASE_URL'],
          message:
            'Conflicting database configuration: SHADOW_DATABASE_URL must be isolated from DATABASE_URL, UNIT_TEST_DATABASE_URL, TEST_DATABASE_URL, and STAGING_DATABASE_URL.',
        });
      }
    }

    // 1. Validation for BANK_HISTORICAL_KEYS (all environments)
    if (data.BANK_HISTORICAL_KEYS && data.BANK_HISTORICAL_KEYS.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.BANK_HISTORICAL_KEYS.trim());
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BANK_HISTORICAL_KEYS'],
          message: 'BANK_HISTORICAL_KEYS must be a valid JSON object mapping key IDs to 64-hexadecimal key strings.',
        });
        parsed = null;
      }

      if (parsed !== null) {
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BANK_HISTORICAL_KEYS'],
            message: 'BANK_HISTORICAL_KEYS must be a JSON object (dictionary) of { [keyId: string]: string }.',
          });
        } else {
          const activeId = data.BANK_ACTIVE_KEY_ID || 'k1';
          const entries = Object.entries(parsed as Record<string, unknown>);

          for (const [keyId, keyMaterial] of entries) {
            // Validate keyId syntax
            if (!keyId || typeof keyId !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(keyId)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['BANK_HISTORICAL_KEYS', keyId],
                message: `Historical key ID "${keyId}" is invalid. Must be 1-32 characters of [a-zA-Z0-9_-].`,
              });
            }

            // Key material must be a string and 64 hex characters
            if (typeof keyMaterial !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyMaterial.trim())) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['BANK_HISTORICAL_KEYS', keyId],
                message: `Historical key "${keyId}" material must be a 64-character hexadecimal string representing a 256-bit key.`,
              });
            }

            // Conflict check: Active key ID cannot conflict with historical keys unless identical
            if (keyId === activeId) {
              const activeKeyHex = data.BANK_ENCRYPTION_KEY?.trim();
              if (activeKeyHex && typeof keyMaterial === 'string' && keyMaterial.trim().toLowerCase() !== activeKeyHex.toLowerCase()) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['BANK_HISTORICAL_KEYS', keyId],
                  message: `Historical key ID "${keyId}" conflicts with BANK_ACTIVE_KEY_ID but contains different key material.`,
                });
              }
            }
          }
        }
      }
    }

    if (data.NODE_ENV === 'production') {
      // 2. Explicitly check if session secret was omitted or defaulted to insecure development fallback
      if (
        !data.SESSION_SECRET ||
        data.SESSION_SECRET.trim() === '' ||
        data.SESSION_SECRET === 'dev_insecure_fallback_session_secret_32_chars_long'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_SECRET'],
          message:
            'In production mode (NODE_ENV=production), SESSION_SECRET is strictly required and cannot use the development fallback. An explicit high-entropy secret must be provided (e.g. generate via `openssl rand -hex 32`).',
        });
        return;
      }

      // 3. Minimum length check (at least 32 characters)
      if (data.SESSION_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_SECRET'],
          message:
            'In production mode (NODE_ENV=production), SESSION_SECRET must be at least 32 characters long.',
        });
        return;
      }

      // 4. Known placeholder / template string check
      const lowerSecret = data.SESSION_SECRET.toLowerCase();
      if (
        KNOWN_DEV_SECRETS.has(data.SESSION_SECRET) ||
        lowerSecret.includes('replace_with') ||
        lowerSecret.includes('dev_insecure') ||
        lowerSecret.includes('dev_session') ||
        lowerSecret.includes('default_session') ||
        lowerSecret.includes('change_me') ||
        lowerSecret.includes('changeme') ||
        lowerSecret.includes('example') ||
        lowerSecret.includes('password')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_SECRET'],
          message:
            'In production mode (NODE_ENV=production), SESSION_SECRET cannot use a known development placeholder or template string. Generate a high-entropy secret.',
        });
      }

      // 5. Production fail-closed check for BANK_ENCRYPTION_KEY (Phase 2.3)
      if (!data.BANK_ENCRYPTION_KEY || data.BANK_ENCRYPTION_KEY.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BANK_ENCRYPTION_KEY'],
          message:
            'In production mode (NODE_ENV=production), BANK_ENCRYPTION_KEY is strictly required and must be provided (64 hex characters / 256 bits). It does NOT fall back to SESSION_SECRET.',
        });
      } else if (!/^[0-9a-fA-F]{64}$/.test(data.BANK_ENCRYPTION_KEY.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BANK_ENCRYPTION_KEY'],
          message:
            'In production mode (NODE_ENV=production), BANK_ENCRYPTION_KEY must be exactly 64 hexadecimal characters representing a 256-bit key.',
        });
      }
    }
  });

export function parseBankHistoricalKeys(rawJson?: string): Record<string, string> {
  if (!rawJson || rawJson.trim() === '') return {};
  try {
    const parsed = JSON.parse(rawJson.trim());
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v.trim())) {
          clean[k] = v.trim();
        }
      }
      return clean;
    }
    return {};
  } catch {
    return {};
  }
}

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Redacts sensitive credentials from database connection string for safe logging
 */
export { sanitizeDatabaseUrl } from '../db/staging-safety.js';

/**
 * Validates environment variables and exits gracefully with actionable message if invalid
 */
export function validateEnv(customEnv?: Record<string, string | undefined>): AppConfig {
  const source = customEnv || process.env;
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - [${i.path.join('.')}]: ${i.message}`).join('\n');
    const errorMessage = `\n=======================================================\n` +
      `[CRITICAL CONFIGURATION ERROR] Environment validation failed:\n` +
      `${issues}\n\n` +
      `Action required: Check your .env file or environment settings.\n` +
      `Refer to .env.example for required variables.\n` +
      `=======================================================\n`;
    
    // In test environment or unit test, we throw an error instead of exiting process
    if (source.NODE_ENV === 'test' || process.env.VITEST === 'true') {
      throw new Error(errorMessage);
    }
    
    console.error(errorMessage);
    process.exit(1);
  }

  return result.data;
}

// Cached singleton config
let cachedConfig: AppConfig | null = null;

export function resetConfigForTesting(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[SECURITY FATAL] resetConfigForTesting cannot be used in production mode.'
    );
  }
  cachedConfig = null;
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = validateEnv();
  }
  return cachedConfig;
}
