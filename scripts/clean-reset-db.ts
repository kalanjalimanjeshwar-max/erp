#!/usr/bin/env tsx
/**
 * CoreERP Explicitly Confirmed Local Docker Clean-Reset & Fresh-Install CLI
 *
 * Scoped EXCLUSIVELY to CoreERP's five local Docker PostgreSQL environments:
 *   - dev         (coreerp-postgres-dev / postgres_dev_data / port 5432)
 *   - test        (coreerp-postgres-test / postgres_test_data / port 5433)
 *   - integration (coreerp-postgres-integration-test / postgres_integration_test_data / port 5434)
 *   - staging     (coreerp-postgres-staging / postgres_staging_data / port 5435)
 *   - shadow      (coreerp-postgres-shadow / postgres_shadow_data / port 5436)
 *
 * NEVER runs global Docker prune commands, NEVER touches production containers/volumes
 * (coreerp-postgres, coreerp-app, postgres_data, coreerp_storage), NEVER removes unrelated
 * Docker resources, and NEVER modifies source code, Git history, or eSSL X2008 biometric bridge files.
 *
 * Usage:
 *   # Safe Dry-Run Preview (default — zero Docker/file/DB mutations):
 *   npm run db:clean-reset
 *
 *   # Explicitly Confirmed Scoped Clean Reset + Recreate + Ordered Migrations + Staging Verification:
 *   npm run db:clean-reset -- --execute --confirm-coreerp-local-reset
 *
 *   # Optional: Back up existing .env* files and regenerate fresh consistent credentials:
 *   npm run db:clean-reset -- --execute --confirm-coreerp-local-reset --recreate-env
 *
 *   # Optional: Scope to specific local targets only (never accepts prod/production):
 *   npm run db:clean-reset -- --targets dev,staging --execute --confirm-coreerp-local-reset
 */

import { REQUIRED_CONFIRMATION_FLAG, runCoreErpCleanReset } from '../src/server/db/clean-reset.js';

function parseTargetsArg(args: string[]): string[] | undefined {
  const idx = args.findIndex((a) => a === '--targets');
  if (idx === -1 || !args[idx + 1]) return undefined;
  return args[idx + 1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const confirmed = args.includes(REQUIRED_CONFIRMATION_FLAG);
  const recreateEnv = args.includes('--recreate-env');
  const skipStagingVerify = args.includes('--skip-staging-verify');
  const targets = parseTargetsArg(args);

  const result = await runCoreErpCleanReset({
    targets,
    execute,
    confirmed,
    recreateEnv,
    verifyStaging: !skipStagingVerify,
  });

  process.exit(result.exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error in clean-reset workflow: ${message}`);
  process.exit(1);
});
