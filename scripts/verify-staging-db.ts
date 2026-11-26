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
 *   STAGING_DATABASE_URL="postgresql://user:pass@localhost:5433/core_erp_staging?schema=public" npm run db:verify:staging -- --execute
 */

import { runStagingVerification, redactSensitiveText } from '../src/server/db/staging-verifier.js';

async function main() {
  const args = process.argv.slice(2);
  const isExecuteRequested = args.includes('--execute');

  const result = await runStagingVerification({
    execute: isExecuteRequested,
    env: process.env,
  });

  process.exit(result.exitCode);
}

main().catch((err: unknown) => {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const safeMessage = redactSensitiveText(rawMessage, [
    process.env.STAGING_DATABASE_URL || '',
    process.env.TEST_DATABASE_URL || '',
    process.env.DATABASE_URL || '',
  ]);
  console.error(`Fatal error in staging verifier: ${safeMessage}`);
  process.exit(1);
});
