#!/usr/bin/env tsx
/**
 * CoreERP Isolated Target Prisma Migration Runner
 *
 * Applies versioned Prisma migrations strictly to one validated target environment.
 * Dry-run by default; requires explicit `--execute` before running `prisma migrate deploy`.
 *
 * Usage:
 *   npm run db:migrate:target -- --target staging            # Dry-run safety check
 *   npm run db:migrate:target -- --target staging --execute  # Explicit migration deploy
 *   npm run db:migrate:target -- --target dev --execute
 *   npm run db:migrate:target -- --target integration --execute
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

function captureTargetScopedEnv(target: string): Record<string, string | undefined> {
  // Capture explicit shell environment BEFORE any module import triggers dotenv.config() or Prisma env loading.
  const effectiveEnv: Record<string, string | undefined> = { ...process.env };
  const normalized = target.trim().toLowerCase();

  // Load ONLY the matching target's dedicated env file when the target URL is not already provided
  if (normalized === 'staging' && effectiveEnv.STAGING_DATABASE_URL === undefined) {
    const stagingFile = path.resolve(process.cwd(), '.env.staging');
    if (fs.existsSync(stagingFile)) {
      const parsed = parseDotEnvMinimal(fs.readFileSync(stagingFile, 'utf-8'));
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

  if (normalized === 'integration' && effectiveEnv.TEST_DATABASE_URL === undefined) {
    const intFile = path.resolve(process.cwd(), '.env.integration-test');
    if (fs.existsSync(intFile)) {
      const parsed = parseDotEnvMinimal(fs.readFileSync(intFile, 'utf-8'));
      if (parsed.TEST_DATABASE_URL !== undefined) {
        effectiveEnv.TEST_DATABASE_URL = parsed.TEST_DATABASE_URL;
      }
    }
  }

  return effectiveEnv;
}

async function main() {
  const args = process.argv.slice(2);
  const targetIdx = args.findIndex((a) => a === '--target');
  const target = targetIdx !== -1 && args[targetIdx + 1] ? args[targetIdx + 1] : '';
  const execute = args.includes('--execute');

  if (!target) {
    console.error('❌ Missing required --target argument. Use --target dev|test|integration|staging.');
    process.exit(1);
  }

  const effectiveEnv = captureTargetScopedEnv(target);

  const [{ runIsolatedTargetMigration }, { redactSensitiveText }] = await Promise.all([
    import('../src/server/db/isolated-migrator.js'),
    import('../src/server/db/staging-verifier.js'),
  ]);

  if (effectiveEnv.DATABASE_URL === undefined && process.env.DATABASE_URL !== undefined) {
    effectiveEnv.DATABASE_URL = process.env.DATABASE_URL;
  }
  if (
    effectiveEnv.STAGING_DATABASE_URL === undefined &&
    process.env.STAGING_DATABASE_URL !== undefined
  ) {
    effectiveEnv.STAGING_DATABASE_URL = process.env.STAGING_DATABASE_URL;
  }

  try {
    const result = await runIsolatedTargetMigration({
      target,
      execute,
      env: effectiveEnv,
    });
    process.exit(result.exitCode);
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error(
      `Fatal error in isolated migration runner: ${redactSensitiveText(raw, [
        effectiveEnv.DATABASE_URL || '',
        effectiveEnv.STAGING_DATABASE_URL || '',
        effectiveEnv.TEST_DATABASE_URL || '',
      ])}`
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const raw = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error in isolated migration runner: ${raw}`);
  process.exit(1);
});
