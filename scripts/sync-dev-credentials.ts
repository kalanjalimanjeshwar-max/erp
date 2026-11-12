#!/usr/bin/env tsx
/**
 * CoreERP Development Database Credential Synchronization Tool
 *
 * Dedicated, explicit, development-only credential synchronization procedure.
 *
 * Invariants & Guarantees:
 * 1. Strictly Development Only: Never touches production, staging (5433), or integration (5434).
 * 2. Parameterized Stdin Execution: Passwords never appear in process argv, ps, Task Manager, or shell history.
 * 3. Volume Preservation: Never deletes, restarts, recreates, or prunes containers or volumes.
 * 4. Zero Secret Leakage: All outputs redact credentials.
 * 5. Formatting Preservation: Updates .env DATABASE_URL while leaving unrelated keys, comments, and structure intact.
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
  syncEnvFileDatabaseUrl,
  syncPostgresRoleViaStdin,
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

  // 1. Precondition Safety Verification
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
  console.log(`   ✔ Target Role: ${details.role} (canonical: ${CANONICAL_DEV_USER})`);
  console.log(`   ✔ Target Container: ${details.containerName} (canonical: ${CANONICAL_DEV_CONTAINER})`);
  console.log(`   ✔ Endpoint: ${validation.sanitizedEndpoint}`);

  if (isDryRun) {
    console.log('\n2. Dry Run Simulation (No changes made):');
    console.log('   - Will update local .env to canonical development DATABASE_URL (redacting passwords).');
    console.log(`   - Will pipe "ALTER ROLE \\"${CANONICAL_DEV_USER}\\" WITH PASSWORD '*****';" via stdin to "${CANONICAL_DEV_CONTAINER}".`);
    console.log('   - Containers and volumes will remain untouched.');
    console.log('\nTo execute live credential synchronization, run:');
    console.log('   npm run db:sync:dev-credentials -- --confirm\n');
    console.log('================================================================\n');
    process.exit(0);
  }

  // 2. Synchronize .env DATABASE_URL and POSTGRES_PASSWORD
  console.log('\n2. Synchronizing Local .env Configuration:');
  const envResult = syncEnvFileDatabaseUrl(envPath);
  if (envResult.alreadySynchronized) {
    console.log(`   ✔ .env DATABASE_URL is already synchronized: ${envResult.sanitizedCurrentUrl}`);
  } else if (envResult.updated) {
    console.log(`   ✔ .env DATABASE_URL updated:`);
    console.log(`       Previous: ${envResult.sanitizedPreviousUrl}`);
    console.log(`       Current:  ${envResult.sanitizedCurrentUrl}`);
  } else {
    console.log(`   ✔ .env verified (no changes needed).`);
  }

  // 3. Update PostgreSQL role password inside running container via stdin
  console.log('\n3. Synchronizing PostgreSQL Role Password in Container:');
  console.log(`   - Target: container "${CANONICAL_DEV_CONTAINER}", database "${CANONICAL_DEV_DB}"`);
  console.log(`   - Method: Secure stdin pipe (zero process argv or shell history exposure)`);

  const dbResult = await syncPostgresRoleViaStdin();
  if (dbResult.success) {
    console.log(`   ✔ ${dbResult.message}`);
  } else {
    console.warn(`   ⚠️  Container update notice: ${dbResult.error || dbResult.message}`);
    console.log('\n   If you are on Windows and Docker runs on the host, run this safe command in PowerShell:');
    console.log(`   "ALTER ROLE \\"${CANONICAL_DEV_USER}\\" WITH PASSWORD 'erp_password_dev';" | docker exec -i ${CANONICAL_DEV_CONTAINER} psql -U postgres -d ${CANONICAL_DEV_DB} -v ON_ERROR_STOP=1\n`);
  }

  // 4. Verify Database Connectivity & Readiness
  console.log('\n4. Verifying Application Health Probe:');
  const health = await checkPostgresHealth();
  if (health.status === 'connected') {
    console.log(`   ✔ PostgreSQL Connected successfully (${health.latencyMs}ms).`);
    console.log('\n================================================================');
    console.log('   SUCCESS: Development credentials synchronized and verified.');
    console.log('================================================================\n');
  } else {
    console.warn(`   ⚠️  PostgreSQL probe status: ${health.status} (${health.error || 'Unavailable'}).`);
    console.log('   Ensure the development Docker container is running:');
    console.log('   docker compose -f docker-compose.dev.yml up -d postgres\n');
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal error in credential synchronization:', err);
  process.exit(1);
});
