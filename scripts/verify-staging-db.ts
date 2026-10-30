#!/usr/bin/env tsx
/**
 * CoreERP Staging Database Verification Tool
 *
 * Prepares and validates the isolated staging verification workflow.
 * Enforces strict safety rules: NEVER touches production databases or uses silent fallbacks.
 *
 * Usage:
 *   # Dry run / Safety pre-flight check (Default, safe, no changes):
 *   npm run db:verify:staging
 *
 *   # Check specific target URL safety:
 *   STAGING_DATABASE_URL="postgresql://user:pass@localhost:5433/core_erp_staging?schema=public" npm run db:verify:staging
 */

import { validateStagingDatabaseUrl, getStagingVerificationSteps } from '../src/server/db/staging-safety.js';
import { sanitizeDatabaseUrl } from '../src/server/config/env.js';

async function main() {
  console.log('\n================================================================');
  console.log('   CoreERP Staging Database Verification Pre-Flight (Phase 8.7A)');
  console.log('================================================================\n');

  const args = process.argv.slice(2);
  const isExecuteRequested = args.includes('--execute');
  const targetUrl = process.env.STAGING_DATABASE_URL || process.env.TEST_DATABASE_URL;
  const primaryDbUrl = process.env.DATABASE_URL;

  console.log('1. Target Database Safety Inspection:');
  console.log(`   - STAGING_DATABASE_URL: ${targetUrl ? sanitizeDatabaseUrl(targetUrl) : '[NOT SET]'}`);
  console.log(`   - Primary DATABASE_URL: ${primaryDbUrl ? sanitizeDatabaseUrl(primaryDbUrl) : '[NOT SET]'}`);

  const validation = validateStagingDatabaseUrl(targetUrl, primaryDbUrl);

  if (!validation.valid) {
    console.error(`\n❌ [SAFETY CHECK FAILED]: ${validation.error}\n`);
    console.log('Guidance:');
    console.log('  1. Staging verification requires an isolated, disposable database.');
    console.log('  2. Configure STAGING_DATABASE_URL or TEST_DATABASE_URL with a database name');
    console.log('     containing "test", "staging", or "disposable" (e.g. core_erp_staging or core_erp_test).');
    console.log('  3. Example (Local Docker on port 5433 from docker-compose.dev.yml):');
    console.log('     export STAGING_DATABASE_URL="postgresql://erp_test_user:<auth_secret>@localhost:5433/core_erp_test?schema=public"');
    console.log('  4. Staging verification is currently in PREPARATION ONLY mode.');
    console.log('     Live database execution will only be performed after explicit user authorization.\n');
    process.exit(1);
  }

  console.log(`   ✔ Safety validation PASSED for database "${validation.databaseName}".`);
  console.log('   ✔ Target is confirmed isolated and disposable (non-production).');

  console.log('\n2. Planned Staging Verification Steps:');
  const steps = getStagingVerificationSteps();
  steps.forEach((s) => {
    console.log(`   [Step ${s.step}] ${s.name}`);
    console.log(`           ${s.description}`);
  });

  if (!isExecuteRequested) {
    console.log('\n----------------------------------------------------------------');
    console.log('NOTICE: Phase 8.7A is in PREPARATION-ONLY mode.');
    console.log('No database connections or modifications were made.');
    console.log('When authorized by the user, run with --execute to perform live staging checks.');
    console.log('----------------------------------------------------------------\n');
    process.exit(0);
  }

  // Live execution branch (only invoked when user explicitly authorizes live execution)
  console.log('\n3. Executing Staging Checks against Disposable Target...');
  try {
    const net = await import('net');
    const parsedUrl = new URL(targetUrl!);
    const host = parsedUrl.hostname || 'localhost';
    const port = parseInt(parsedUrl.port || '5432', 10);

    const socket = new net.Socket();
    const isConnected = await new Promise<boolean>((resolve) => {
      socket.setTimeout(3000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });

    if (!isConnected) {
      console.warn(`\n⚠️  PostgreSQL target at ${host}:${port} is not currently reachable.`);
      console.warn('   Ensure your staging PostgreSQL container is running (e.g., docker compose -f docker-compose.dev.yml up -d postgres-test).');
      process.exit(2);
    }

    console.log(`   ✔ Port ${port} is open and accepting TCP connections.`);
    console.log('   ✔ Safe staging probe complete.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Error during staging probe: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in staging verifier:', err);
  process.exit(1);
});
