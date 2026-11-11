import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import dotenv from 'dotenv';

// In development, ensure default development .env file exists if missing
if (
  typeof process !== 'undefined' &&
  process.env.NODE_ENV !== 'production' &&
  process.env.VITEST !== 'true' &&
  !process.env.DATABASE_URL
) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      const defaultDevEnv = [
        'PORT=3000',
        'NODE_ENV=development',
        'DATABASE_URL="postgresql://erp_user:dev_password@localhost:5432/core_erp?schema=public"',
        'TEST_DATABASE_URL="postgresql://erp_test_user:dev_test_password@localhost:5433/core_erp_test?schema=public"',
        'STAGING_DATABASE_URL="postgresql://erp_test_user:dev_test_password@localhost:5433/core_erp_staging?schema=public"',
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

// Load environment variables from .env if present
dotenv.config();

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
      .min(
        1,
        'DATABASE_URL is required. PostgreSQL is the sole operational database. Please configure a valid PostgreSQL connection string.'
      )
      .transform((val) => val.trim().replace(/^["']|["']$/g, ''))
      .refine(
        (url) => url.startsWith('postgresql://') || url.startsWith('postgres://'),
        {
          message:
            'DATABASE_URL must be a valid PostgreSQL connection string starting with "postgresql://" or "postgres://". Other database providers or local file fallbacks are strictly prohibited.',
        }
      ),
    TEST_DATABASE_URL: z.string().optional(),
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
  })
  .superRefine((data, ctx) => {
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
export function sanitizeDatabaseUrl(url: string | undefined): string {
  if (!url) return '[NOT_CONFIGURED]';
  try {
    const parsed = new URL(url);
    const auth = parsed.username ? `${parsed.username}:*****@` : '';
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`;
  } catch {
    return 'postgresql://*****:*****@***/***';
  }
}

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

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = validateEnv();
  }
  return cachedConfig;
}
