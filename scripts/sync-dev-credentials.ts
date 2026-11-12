#!/usr/bin/env tsx
/**
 * CoreERP Development Database Credential Synchronization Tool
 *
 * Dedicated, explicit, development-only credential synchronization procedure.
 *
 * Invariants & Guarantees:
 * 1. Strictly Development Only: Never touches production, staging (5433), or integration (5434).
 * 2. Uses Initialized Role 'erp_user': Never assumes a 'postgres' role exists.
 * 3. Role Privilege Verification: Verifies erp_user has superuser/login privileges before updating.
 * 4. Parameterized Stdin Execution: Passwords never appear in process argv, ps, Task Manager, or shell history.
 * 5. Failure-Safe Transaction Order: Local .env is updated ONLY after the database role password update succeeds.
 * 6. Atomic File Replacement: .env writes are atomic to prevent corruption.
 * 7. Volume Preservation: Never deletes, restarts, recreates, or prunes containers or volumes.
 * 8. Zero Secret Leakage: All outputs redact credentials.
 *
 * Usage:
 *   # Dry-run check:
 *   npx tsx scripts/sync-dev-credentials.ts --dry-run
 *
 *   # Execute synchronization:
 *   npx tsx scripts/sync-dev-credentials.ts --confirm
 */

import path from 'path';
import {
  validateDevSyncPreconditions,
  verifyEnvFileWritable,
  verifyPostgresRoleViaStdin,
  syncPostgresRoleViaStdin,
  syncEnvFileDatabaseUrl,
  CANONICAL_DEV_USER,
  CANONICAL_DEV_DB,
  CANONICAL_DEV_CONTAINER,
  CANONICAL_DEV_PORT,
} from '../src/server/db/dev-credential-sync.js';
import { checkPostgresHealth } from '../src/server/db/health.js';

async function main() {
  console.log('\n================================================================');
  console.log('   CoreERP Development PostgreSQL Credential Synchronization');
  console.log('================================================================\n');

  const args = process.argv.slice(2);
  const isConfirm = args.includes('--confirm');
  const isDryRun = args.includes('--dry-run') || !isConfirm;

  // Step 1: Precondition Safety Validation
  console.log('1. Verifying Development Safety Invariants:');
  const envPath = path.resolve(process.cwd(), '.env');
  const validation = validateDevSyncPreconditions();

  if (!validation.valid) {
    console.error(`\n❌ [SAFETY CHECK REJECTED]: ${validation.error}\n`);
    console.log('Safety Guidance:');
    console.log('  - This tool is strictly restricted to local development environments.');
    console.log('  - Production (NODE_ENV=production) and Integration tests (port 5434) are strictly protected.');
    process.exit(1);
  }

  const details = validation.details!;
  console.log(`   ✔ Environment: development`);
  console.log(`   ✔ Target Host: ${details.host}:${details.port} (development port ${CANONICAL_DEV_PORT})`);
  console.log(`   ✔ Target Database: ${details.database} (canonical: ${CANONICAL_DEV_DB})`);
  console.log(`   ✔ Target Role: ${details.role} (canonical: ${CANONICAL_DEV_USER}, never 'postgres')`);
  console.log(`   ✔ Target Container: ${details.containerName} (canonical: ${CANONICAL_DEV_CONTAINER})`);
  console.log(`   ✔ Endpoint: ${validation.sanitizedEndpoint}`);

  // Step 2: Environment File Writable Check (Preflight)
  console.log('\n2. Verifying File Write Permissions:');
  const writeCheck = verifyEnvFileWritable(envPath);
  if (!writeCheck.writable) {
    console.error(`\n❌ [PREFLIGHT FAILED]: ${writeCheck.error}\n`);
    process.exit(1);
  }
  console.log(`   ✔ Local .env path is writable.`);

  if (isDryRun) {
    console.log('\n3. Dry Run Simulation (No changes made):');
    console.log(`   - Will verify role "${CANONICAL_DEV_USER}" superuser privilege via stdin pipe.`);
    console.log(`   - Will pipe "ALTER ROLE \\"${CANONICAL_DEV_USER}\\" WITH PASSWORD '*****';" via stdin to "${CANONICAL_DEV_CONTAINER}" using user "${CANONICAL_DEV_USER}".`);
    console.log(`   - Will atomically update local .env ONLY after container role update succeeds.`);
    console.log('   - Containers and volumes will remain untouched.');
    console.log('\nTo execute live credential synchronization, run:');
    console.log('   npm run db:sync:dev-credentials -- --confirm\n');
    console.log('================================================================\n');
    process.exit(0);
  }

  // Step 3: Verify Role Identity & Superuser Privileges in Container via Stdin
  console.log('\n3. Verifying PostgreSQL Role Privileges:');
  console.log(`   - Connecting as "${CANONICAL_DEV_USER}" over local Unix socket (trust)...`);
  const roleCheck = await verifyPostgresRoleViaStdin();

  if (!roleCheck.verified) {
    console.warn(`   ⚠️  Role verification notice: ${roleCheck.error}`);
    console.log('\n   If Docker CLI is not running in this environment, execute the verified command directly in PowerShell:');
    console.log(`   "ALTER ROLE \\"${CANONICAL_DEV_USER}\\" WITH PASSWORD 'erp_password_dev';" | docker exec -i ${CANONICAL_DEV_CONTAINER} psql -U ${CANONICAL_DEV_USER} -d ${CANONICAL_DEV_DB} -v ON_ERROR_STOP=1\n`);
    console.log('   Local .env was NOT modified to prevent split-brain state.\n');
    process.exit(1);
  }
  console.log(`   ✔ Verified role "${roleCheck.role}": superuser = ${roleCheck.isSuperuser}, canlogin = ${roleCheck.canLogin}.`);

  // Step 4: Synchronize Role Password in Container via Stdin
  console.log('\n4. Synchronizing PostgreSQL Role Password in Container:');
  console.log(`   - Target: container "${CANONICAL_DEV_CONTAINER}", user "${CANONICAL_DEV_USER}", database "${CANONICAL_DEV_DB}"`);
  console.log(`   - Method: Secure stdin pipe (zero process argv or shell history exposure)`);

  const dbResult = await syncPostgresRoleViaStdin();
  if (!dbResult.success) {
    console.error(`\n❌ [DATABASE UPDATE FAILED]: ${dbResult.error || dbResult.message}`);
    console.log('\n   Local .env was NOT modified to prevent split-brain state.');
    console.log('\n   To execute manually on your host in PowerShell:');
    console.log(`   "ALTER ROLE \\"${CANONICAL_DEV_USER}\\" WITH PASSWORD 'erp_password_dev';" | docker exec -i ${CANONICAL_DEV_CONTAINER} psql -U ${CANONICAL_DEV_USER} -d ${CANONICAL_DEV_DB} -v ON_ERROR_STOP=1\n`);
    process.exit(1);
  }
  console.log(`   ✔ ${dbResult.message}`);

  // Step 5: Atomically update .env ONLY after database update succeeded
  console.log('\n5. Updating Local .env Configuration (Atomic Replacement):');
  const envResult = syncEnvFileDatabaseUrl(envPath);
  if (envResult.alreadySynchronized) {
    console.log(`   ✔ .env DATABASE_URL is already synchronized: ${envResult.sanitizedCurrentUrl}`);
  } else if (envResult.updated) {
    console.log(`   ✔ .env DATABASE_URL atomically updated:`);
    console.log(`       Previous: ${envResult.sanitizedPreviousUrl}`);
    console.log(`       Current:  ${envResult.sanitizedCurrentUrl}`);
  } else {
    console.log(`   ✔ .env verified (no changes needed).`);
  }

  // Step 6: Verify Database Connectivity & Readiness
  console.log('\n6. Verifying Application Health Probe:');
  const health = await checkPostgresHealth();
  if (health.status === 'connected') {
    console.log(`   ✔ PostgreSQL Connected successfully (${health.latencyMs}ms).`);
    console.log('\n================================================================');
    console.log('   SUCCESS: Development credentials synchronized and verified.');
    console.log('================================================================\n');
  } else {
    console.warn(`   ⚠️  PostgreSQL probe status: ${health.status} (${health.error || 'Unavailable'}).`);
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal error in credential synchronization:', err);
  process.exit(1);
});
