#!/usr/bin/env tsx
/**
 * Corporate Bank Account Encryption Backfill Maintenance CLI (Phase 2.3)
 *
 * Operational Maintenance Entrypoint:
 *   Dry-Run (simulates and verifies without modifying DB):
 *     npm run maintenance:backfill-bank-accounts -- --dry-run
 *
 *   Live Execution (strictly requires explicit --confirm flag):
 *     npm run maintenance:backfill-bank-accounts -- --confirm
 *
 * Safety Invariants:
 * 1. Requires explicit --confirm flag to perform writes.
 * 2. Uses PostgreSQL row-level locking (FOR UPDATE SKIP LOCKED).
 * 3. Never prints plaintext, ciphertext, or key material in stdout/stderr.
 * 4. Disconnects Prisma Client in finally block before exiting.
 * 5. Exits with non-zero code on unrecoverable errors or if verification fails.
 */

import { prisma } from '../src/server/db/client.js';
import { EncryptionService } from '../src/server/security/encryption.service.js';
import { BankAccountBackfillService } from '../src/server/security/bank-account-backfill.service.js';

interface CliArgs {
  isDryRun: boolean;
  isConfirmed: boolean;
  batchSize: number;
  companyId?: string;
}

function parseCliArgs(args: string[]): CliArgs {
  const isDryRun = args.includes('--dry-run');
  const isConfirmed = args.includes('--confirm');

  let batchSize = 50;
  const batchIdx = args.indexOf('--batch-size');
  if (batchIdx !== -1 && args[batchIdx + 1]) {
    const parsed = parseInt(args[batchIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      batchSize = parsed;
    }
  }

  let companyId: string | undefined = undefined;
  const companyIdx = args.indexOf('--company-id');
  if (companyIdx !== -1 && args[companyIdx + 1]) {
    companyId = args[companyIdx + 1].trim();
  }

  return { isDryRun, isConfirmed, batchSize, companyId };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseCliArgs(argv);

  console.log('================================================================');
  console.log('  CoreERP — Bank Account Encryption Backfill Maintenance Utility');
  console.log('================================================================');

  if (!options.isDryRun && !options.isConfirmed) {
    console.error('\n[SAFETY ABORT] Execution halted: live database mutations require explicit confirmation.');
    console.error('Usage:');
    console.error('  Dry-run simulation:  npm run maintenance:backfill-bank-accounts -- --dry-run');
    console.error('  Live batch backfill: npm run maintenance:backfill-bank-accounts -- --confirm');
    console.error('Optional filters:      --company-id <UUID> --batch-size <1-100>\n');
    process.exit(1);
  }

  const modeText = options.isDryRun ? 'DRY-RUN SIMULATION (No DB Writes)' : 'LIVE BATCH EXECUTION';
  console.log(`Mode:       ${modeText}`);
  console.log(`Batch Size: ${options.batchSize}`);
  if (options.companyId) {
    console.log(`Tenant:     ${options.companyId}`);
  }
  console.log('----------------------------------------------------------------');

  try {
    // 1. Initialize Encryption Service and Key Ring
    EncryptionService.init();
    console.log(`Active Encryption Key ID: "${EncryptionService.getActiveKeyId()}"`);
    console.log(`Registered Keys in Ring:  ${EncryptionService.getRegisteredKeyIds().join(', ')}`);

    // 2. Execute bounded, transactional backfill
    const result = await BankAccountBackfillService.runBackfill({
      batchSize: options.batchSize,
      dryRun: options.isDryRun,
      companyId: options.companyId,
    });

    console.log('\n================================================================');
    console.log('  Backfill Execution Summary');
    console.log('================================================================');
    console.log(`Total Records Inspected:        ${result.totalInspected}`);
    console.log(`Records Encrypted & Updated:    ${result.totalUpdated}`);
    console.log(`Records Already Encrypted:      ${result.totalAlreadyEncrypted}`);
    console.log(`Errors / Verification Failures: ${result.totalErrors}`);
    console.log('================================================================');

    if (result.errors.length > 0) {
      console.error('\nErrors encountered during batch processing:');
      for (const err of result.errors) {
        console.error(`  - Account [${err.accountId}]: ${err.error}`);
      }
      process.exit(2);
    }

    console.log('\n[SUCCESS] Maintenance operation finished successfully.');
  } catch (error: any) {
    console.error(`\n[FATAL ERROR] Backfill maintenance failed: ${error?.message || error}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Only execute when run directly via CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Unhandled fatal error in backfill CLI:', err);
    process.exit(1);
  });
}
