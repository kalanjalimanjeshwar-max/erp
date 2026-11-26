#!/usr/bin/env tsx
/**
 * CoreERP Staging Database Verification Tool
 *
 * Prepares and executes the isolated, fail-closed staging verification workflow.
 * Enforces strict safety rules: NEVER touches production databases, NEVER falls back
 * to DATABASE_URL, and NEVER mutates application data.
 *
 * Usage:
 *   # Dry run / Safety pre-flight check (Default, safe, no DB connection):
 *   npm run db:verify:staging
 *
 *   # Execute full staging verification against an explicitly validated disposable target:
 *   STAGING_DATABASE_URL="postgresql://erp_staging_user:pass@localhost:5435/core_erp_staging?schema=public" npm run db:verify:staging -- --execute
 */

import fs from 'fs';
import path from 'path';

function parseDotEnvMinimal(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
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

function captureInitialStagingEnv(): Record<string, string | undefined> {
  // Capture explicit shell environment BEFORE any module import triggers dotenv.config() or Prisma env loading.
  const effectiveEnv: Record<string, string | undefined> = { ...process.env };

  // Only consult local .env.staging when STAGING_DATABASE_URL was not explicitly provided in shell env.
  // Never overwrite explicit values (including explicit empty string '') and never touch DATABASE_URL or TEST_DATABASE_URL.
  if (effectiveEnv.STAGING_DATABASE_URL === undefined) {
    const stagingEnvPath = path.resolve(process.cwd(), '.env.staging');
    if (fs.existsSync(stagingEnvPath)) {
      const parsed = parseDotEnvMinimal(fs.readFileSync(stagingEnvPath, 'utf-8'));
      for (const key of [
        'STAGING_DATABASE_URL',
        'STAGING_POSTGRES_USER',
        'STAGING_POSTGRES_PASSWORD',
        'STAGING_POSTGRES_DB',
      ]) {
        if (effectiveEnv[key] === undefined && parsed[key] !== undefined) {
          effectiveEnv[key] = parsed[key];
        }
      }
    }
  }

  return effectiveEnv;
}

async function main() {
  const args = process.argv.slice(2);
  const isExecuteRequested = args.includes('--execute');
  const effectiveEnv = captureInitialStagingEnv();

  // Dynamically import after capturing shell + .env.staging so repo .env cannot shadow .env.staging.
  const { runStagingVerification, redactSensitiveText } = await import(
    '../src/server/db/staging-verifier.js'
  );

  // If neither shell nor .env.staging provided STAGING_DATABASE_URL, allow .env-loaded value (if present)
  // while still strictly never falling back to DATABASE_URL or TEST_DATABASE_URL.
  if (
    effectiveEnv.STAGING_DATABASE_URL === undefined &&
    process.env.STAGING_DATABASE_URL !== undefined
  ) {
    effectiveEnv.STAGING_DATABASE_URL = process.env.STAGING_DATABASE_URL;
  }
  if (effectiveEnv.DATABASE_URL === undefined && process.env.DATABASE_URL !== undefined) {
    effectiveEnv.DATABASE_URL = process.env.DATABASE_URL;
  }

  try {
    const result = await runStagingVerification({
      execute: isExecuteRequested,
      env: effectiveEnv,
    });
    process.exit(result.exitCode);
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const safeMessage = redactSensitiveText(rawMessage, [
      effectiveEnv.STAGING_DATABASE_URL || '',
      effectiveEnv.TEST_DATABASE_URL || '',
      effectiveEnv.DATABASE_URL || '',
    ]);
    console.error(`Fatal error in staging verifier: ${safeMessage}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const rawMessage = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error in staging verifier: ${rawMessage}`);
  process.exit(1);
});
