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

function captureTargetScopedEnv(target: string): {
  effectiveEnv: Record<string, string | undefined>;
  configErrors: string[];
  secrets: string[];
} {
  // Capture explicit shell environment BEFORE any module import triggers dotenv.config() or Prisma env loading.
  const shellEnv: Record<string, string | undefined> = { ...process.env };
  const effectiveEnv: Record<string, string | undefined> = { ...shellEnv };
  const normalized = target.trim().toLowerCase();
  const configErrors: string[] = [];
  const secrets: string[] = [];

  const trackSecret = (val: string | undefined) => {
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

  trackSecret(shellEnv.DATABASE_URL);
  trackSecret(shellEnv.UNIT_TEST_DATABASE_URL);
  trackSecret(shellEnv.TEST_DATABASE_URL);
  trackSecret(shellEnv.STAGING_DATABASE_URL);

  const mainEnv = readEnvFileMinimal(path.resolve(process.cwd(), '.env'));
  const stagingEnv = readEnvFileMinimal(path.resolve(process.cwd(), '.env.staging'));
  const integrationEnv = readEnvFileMinimal(path.resolve(process.cwd(), '.env.integration-test'));

  if (mainEnv) {
    trackSecret(mainEnv.DATABASE_URL);
    trackSecret(mainEnv.UNIT_TEST_DATABASE_URL);
    trackSecret(mainEnv.TEST_DATABASE_URL);
    trackSecret(mainEnv.STAGING_DATABASE_URL);
  }
  if (stagingEnv) {
    trackSecret(stagingEnv.STAGING_DATABASE_URL);
    trackSecret(stagingEnv.STAGING_POSTGRES_PASSWORD);
  }
  if (integrationEnv) {
    trackSecret(integrationEnv.TEST_DATABASE_URL);
    trackSecret(integrationEnv.POSTGRES_PASSWORD);
  }

  // Load ONLY the matching target's dedicated env file and reject misplaced variables or conflicting shell overrides
  if (normalized === 'staging') {
    if (mainEnv?.STAGING_DATABASE_URL?.trim()) {
      configErrors.push(
        '[.env :: STAGING_DATABASE_URL] Misplaced STAGING_DATABASE_URL found in .env. Staging must use STAGING_DATABASE_URL exclusively from .env.staging (localhost:5435/core_erp_staging). Remove STAGING_DATABASE_URL from .env.'
      );
    }
    if (
      shellEnv.STAGING_DATABASE_URL?.trim() &&
      stagingEnv?.STAGING_DATABASE_URL?.trim() &&
      urlsConflict(shellEnv.STAGING_DATABASE_URL, stagingEnv.STAGING_DATABASE_URL)
    ) {
      configErrors.push(
        '[shell environment :: STAGING_DATABASE_URL] Conflicts with [.env.staging :: STAGING_DATABASE_URL]. Unset the conflicting shell override or align both.'
      );
    }
    if (effectiveEnv.STAGING_DATABASE_URL === undefined && stagingEnv) {
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
    // Load DATABASE_URL strictly as a protected comparison reference
    if (effectiveEnv.DATABASE_URL === undefined && mainEnv?.DATABASE_URL !== undefined) {
      effectiveEnv.DATABASE_URL = mainEnv.DATABASE_URL;
    }
  } else if (normalized === 'integration') {
    if (mainEnv?.TEST_DATABASE_URL?.trim()) {
      configErrors.push(
        '[.env :: TEST_DATABASE_URL] Misplaced TEST_DATABASE_URL found in .env. Integration tests must use TEST_DATABASE_URL exclusively from .env.integration-test (localhost:5434/core_erp_integration_test). Remove TEST_DATABASE_URL from .env.'
      );
    }
    if (
      shellEnv.TEST_DATABASE_URL?.trim() &&
      integrationEnv?.TEST_DATABASE_URL?.trim() &&
      urlsConflict(shellEnv.TEST_DATABASE_URL, integrationEnv.TEST_DATABASE_URL)
    ) {
      configErrors.push(
        '[shell environment :: TEST_DATABASE_URL] Conflicts with [.env.integration-test :: TEST_DATABASE_URL]. Unset the conflicting shell override or align both.'
      );
    }
    if (effectiveEnv.TEST_DATABASE_URL === undefined && integrationEnv?.TEST_DATABASE_URL !== undefined) {
      effectiveEnv.TEST_DATABASE_URL = integrationEnv.TEST_DATABASE_URL;
    }
  } else if (normalized === 'dev') {
    if (
      shellEnv.DATABASE_URL?.trim() &&
      mainEnv?.DATABASE_URL?.trim() &&
      urlsConflict(shellEnv.DATABASE_URL, mainEnv.DATABASE_URL)
    ) {
      configErrors.push(
        '[shell environment :: DATABASE_URL] Conflicts with [.env :: DATABASE_URL]. Unset the conflicting shell override or align both.'
      );
    }
    if (effectiveEnv.DATABASE_URL === undefined && mainEnv?.DATABASE_URL !== undefined) {
      effectiveEnv.DATABASE_URL = mainEnv.DATABASE_URL;
    }
  } else if (normalized === 'test') {
    if (
      shellEnv.UNIT_TEST_DATABASE_URL?.trim() &&
      mainEnv?.UNIT_TEST_DATABASE_URL?.trim() &&
      urlsConflict(shellEnv.UNIT_TEST_DATABASE_URL, mainEnv.UNIT_TEST_DATABASE_URL)
    ) {
      configErrors.push(
        '[shell environment :: UNIT_TEST_DATABASE_URL] Conflicts with [.env :: UNIT_TEST_DATABASE_URL]. Unset the conflicting shell override or align both.'
      );
    }
    if (
      effectiveEnv.UNIT_TEST_DATABASE_URL === undefined &&
      mainEnv?.UNIT_TEST_DATABASE_URL !== undefined
    ) {
      effectiveEnv.UNIT_TEST_DATABASE_URL = mainEnv.UNIT_TEST_DATABASE_URL;
    }
  }

  return { effectiveEnv, configErrors, secrets };
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

  const { effectiveEnv, configErrors, secrets } = captureTargetScopedEnv(target);

  const [{ runIsolatedTargetMigration }, { redactSensitiveText }] = await Promise.all([
    import('../src/server/db/isolated-migrator.js'),
    import('../src/server/db/staging-verifier.js'),
  ]);

  if (configErrors.length > 0) {
    console.error('\n❌ [MIGRATION CONFIGURATION SAFETY REJECTED]:');
    for (const err of configErrors) {
      console.error(`   - ${redactSensitiveText(err, secrets)}`);
    }
    console.error('');
    process.exit(1);
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
        ...secrets,
        effectiveEnv.DATABASE_URL || '',
        effectiveEnv.UNIT_TEST_DATABASE_URL || '',
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
