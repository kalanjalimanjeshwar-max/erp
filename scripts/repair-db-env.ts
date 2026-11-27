#!/usr/bin/env tsx
/**
 * CoreERP Permanent Local Database Environment Repair CLI
 *
 * Strictly read-only audit (`--check`) or safe, backed-up, atomic local environment repair.
 *
 * Usage:
 *   npm run db:repair:check                                   # Read-only audit (zero mutations)
 *   npm run db:repair:local                                   # Safe dry-run preview (zero mutations)
 *   npm run db:repair:local -- --confirm-local-env-repair     # Confirmed repair with backups & verification
 *
 * Safety guarantees:
 * - Never deletes, stops, creates, or recreates Docker containers or volumes.
 * - Never runs Prisma migrations or Clean Reset.
 * - Never modifies Windows User or Machine environment variables automatically.
 * - Never exposes passwords or complete connection URLs.
 * - Never touches eSSL X2008 biometric bridge files or USER_SYNC_ONLY configuration.
 */

import {
  REQUIRED_REPAIR_CONFIRMATION_FLAG,
  runLocalDatabaseEnvRepair,
  type RepairMode,
} from '../src/server/db/repair-env.js';

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const confirmed = !checkOnly && args.includes(REQUIRED_REPAIR_CONFIRMATION_FLAG);

  const mode: RepairMode = checkOnly ? 'CHECK' : confirmed ? 'REPAIR' : 'DRY_RUN';

  if (checkOnly && args.includes(REQUIRED_REPAIR_CONFIRMATION_FLAG)) {
    console.warn(
      `[Notice] --check takes precedence over ${REQUIRED_REPAIR_CONFIRMATION_FLAG}; running in strictly read-only CHECK mode.`
    );
  }

  const result = await runLocalDatabaseEnvRepair({
    projectRoot: process.cwd(),
    mode,
    confirmed,
    shellEnv: process.env,
  });

  process.exit(result.exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error during local database environment repair: ${message}`);
  process.exit(1);
});
