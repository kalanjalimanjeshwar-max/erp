#!/usr/bin/env tsx
/**
 * CoreERP Permanent First-Time Database Environment Setup CLI
 *
 * Idempotently initializes git-ignored local environment files (.env, .env.staging,
 * .env.integration-test) for CoreERP's five separated PostgreSQL environments without
 * ever overwriting existing user files, exposing secrets, or touching Docker volumes.
 *
 * Usage:
 *   npm run db:setup          # Create missing env files & validate all 5 environments
 *   npm run db:setup:check    # Read-only audit without creating any files
 */

import { runDatabaseEnvironmentSetup } from '../src/server/db/setup-env.js';

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check') || args.includes('--dry-run');

  const result = await runDatabaseEnvironmentSetup({
    projectRoot: process.cwd(),
    checkOnly,
    shellEnv: process.env,
  });

  process.exit(result.exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error during database environment setup: ${message}`);
  process.exit(1);
});
