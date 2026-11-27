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

function readEnvFileMinimal(filePath: string): Record<string, string> | null {
  if (!fs.existsSync(filePath)) return null;
  return parseDotEnvMinimal(fs.readFileSync(filePath, 'utf-8'));
}

function urlsConflict(urlA: string, urlB: string): boolean {
  try {
    const a = new URL(urlA.trim());
    const b = new URL(urlB.trim());
    const normHost = (h: string) => {
      const lower = h.toLowerCase().replace(/^\[|\]$/g, '');
      return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' ? '127.0.0.1' : lower;
    };
    const normDb = (p: string) => decodeURIComponent(p.replace(/^\/+/, '').replace(/\/+$/, '')).toLowerCase();
    return (
      normHost(a.hostname) !== normHost(b.hostname) ||
      (a.port || '5432') !== (b.port || '5432') ||
      normDb(a.pathname) !== normDb(b.pathname) ||
      decodeURIComponent(a.username || '') !== decodeURIComponent(b.username || '') ||
      decodeURIComponent(a.password || '') !== decodeURIComponent(b.password || '')
    );
  } catch {
    return urlA.trim() !== urlB.trim();
  }
}

function captureInitialStagingEnv(): {
  effectiveEnv: Record<string, string | undefined>;
  configErrors: string[];
  secrets: string[];
} {
  // Capture explicit shell environment BEFORE any module import triggers dotenv.config() or Prisma env loading.
  const shellEnv: Record<string, string | undefined> = { ...process.env };
  const effectiveEnv: Record<string, string | undefined> = { ...shellEnv };
  const configErrors: string[] = [];
  const secrets: string[] = [];

  const trackUrlAndPassword = (val: string | undefined) => {
    const trimmed = val?.trim();
    if (!trimmed) return;
    secrets.push(trimmed);
    try {
      const parsed = new URL(trimmed);
      if (parsed.password) {
        secrets.push(parsed.password);
        const decoded = decodeURIComponent(parsed.password);
        if (decoded) secrets.push(decoded);
      }
    } catch {
      // Not a URL
    }
  };

  trackUrlAndPassword(shellEnv.STAGING_DATABASE_URL);
  trackUrlAndPassword(shellEnv.DATABASE_URL);
  trackUrlAndPassword(shellEnv.TEST_DATABASE_URL);
  if (shellEnv.STAGING_POSTGRES_PASSWORD) secrets.push(shellEnv.STAGING_POSTGRES_PASSWORD);

  const mainEnv = readEnvFileMinimal(path.resolve(process.cwd(), '.env'));
  const stagingEnv = readEnvFileMinimal(path.resolve(process.cwd(), '.env.staging'));

  if (mainEnv) {
    trackUrlAndPassword(mainEnv.STAGING_DATABASE_URL);
    trackUrlAndPassword(mainEnv.DATABASE_URL);
    if (mainEnv.STAGING_POSTGRES_PASSWORD) secrets.push(mainEnv.STAGING_POSTGRES_PASSWORD);

    // Reject misplaced staging variables inside .env (staging MUST live exclusively in .env.staging)
    if (mainEnv.STAGING_DATABASE_URL?.trim()) {
      configErrors.push(
        '[.env :: STAGING_DATABASE_URL] Misplaced STAGING_DATABASE_URL found in .env. Staging must use STAGING_DATABASE_URL exclusively from .env.staging (localhost:5435/core_erp_staging). Remove STAGING_DATABASE_URL from .env.'
      );
    }
    for (const stagingKey of [
      'STAGING_POSTGRES_USER',
      'STAGING_POSTGRES_PASSWORD',
      'STAGING_POSTGRES_DB',
    ]) {
      if (mainEnv[stagingKey]?.trim()) {
        configErrors.push(
          `[.env :: ${stagingKey}] Staging Compose variable must live exclusively in .env.staging, not in .env. Remove ${stagingKey} from .env.`
        );
      }
    }

    // Load DATABASE_URL strictly as a protected comparison reference (never as a staging target)
    if (effectiveEnv.DATABASE_URL === undefined && mainEnv.DATABASE_URL !== undefined) {
      effectiveEnv.DATABASE_URL = mainEnv.DATABASE_URL;
    }
  }

  if (stagingEnv) {
    trackUrlAndPassword(stagingEnv.STAGING_DATABASE_URL);
    if (stagingEnv.STAGING_POSTGRES_PASSWORD) secrets.push(stagingEnv.STAGING_POSTGRES_PASSWORD);

    // Detect conflicting shell override vs .env.staging
    if (
      shellEnv.STAGING_DATABASE_URL !== undefined &&
      shellEnv.STAGING_DATABASE_URL.trim() !== '' &&
      stagingEnv.STAGING_DATABASE_URL?.trim() &&
      urlsConflict(shellEnv.STAGING_DATABASE_URL, stagingEnv.STAGING_DATABASE_URL)
    ) {
      configErrors.push(
        '[shell environment :: STAGING_DATABASE_URL] Conflicts with [.env.staging :: STAGING_DATABASE_URL]. Unset the conflicting shell override or align both.'
      );
    }

    // Load exclusively from .env.staging when shell STAGING_DATABASE_URL is unset
    if (effectiveEnv.STAGING_DATABASE_URL === undefined) {
      for (const key of [
        'STAGING_DATABASE_URL',
        'STAGING_POSTGRES_USER',
        'STAGING_POSTGRES_PASSWORD',
        'STAGING_POSTGRES_DB',
      ]) {
        if (effectiveEnv[key] === undefined && stagingEnv[key] !== undefined) {
          effectiveEnv[key] = stagingEnv[key];
        }
      }
    }
  }

  return { effectiveEnv, configErrors, secrets };
}

async function main() {
  const args = process.argv.slice(2);
  const isExecuteRequested = args.includes('--execute');
  const { effectiveEnv, configErrors, secrets } = captureInitialStagingEnv();

  // Dynamically import after capturing shell + .env.staging so repo .env cannot shadow or populate STAGING_DATABASE_URL.
  const { runStagingVerification, redactSensitiveText } = await import(
    '../src/server/db/staging-verifier.js'
  );

  if (configErrors.length > 0) {
    console.error('\n❌ [STAGING CONFIGURATION SAFETY CHECK FAILED]:');
    for (const err of configErrors) {
      console.error(`   - ${redactSensitiveText(err, secrets)}`);
    }
    console.error('');
    process.exit(1);
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
      ...secrets,
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
