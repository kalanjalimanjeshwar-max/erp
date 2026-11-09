#!/usr/bin/env tsx
/**
 * Corporate Bank Account Encryption, Re-encryption & Key Inventory Maintenance CLI (Phase 2.3)
 *
 * Operational Maintenance Entrypoint:
 *   Key Inventory (pure read-only inspection):
 *     npm run maintenance:backfill-bank-accounts -- --inventory
 *
 *   Dry-Run Simulation (verifies encryption/re-encryption without DB writes):
 *     npm run maintenance:backfill-bank-accounts -- --dry-run
 *     npm run maintenance:backfill-bank-accounts -- --dry-run --mode rotation-only
 *
 *   Live Execution (strictly requires explicit --confirm flag):
 *     npm run maintenance:backfill-bank-accounts -- --confirm
 *     npm run maintenance:backfill-bank-accounts -- --confirm --mode rotation-only
 *
 * Safety Invariants:
 * 1. Read-only inventory never executes mutations or prints sensitive key/credential material.
 * 2. Requires explicit --confirm flag to perform writes.
 * 3. Uses PostgreSQL row-level locking (FOR UPDATE SKIP LOCKED).
 * 4. Never prints plaintext, ciphertext, or key material in stdout/stderr.
 * 5. Disconnects Prisma Client in finally block before exiting.
 * 6. Exits with non-zero code on unrecoverable errors or if verification fails.
 */

import { prisma } from '../src/server/db/client.js';
import { EncryptionService } from '../src/server/security/encryption.service.js';
import {
  BankAccountBackfillService,
  BackfillMode,
} from '../src/server/security/bank-account-backfill.service.js';

interface CliArgs {
  isInventory: boolean;
  isDryRun: boolean;
  isConfirmed: boolean;
  mode: BackfillMode;
  batchSize: number;
  companyId?: string;
}

function parseCliArgs(args: string[]): CliArgs {
  const isInventory = args.includes('--inventory');
  const isDryRun = args.includes('--dry-run') || (!args.includes('--confirm') && !isInventory);
  const isConfirmed = args.includes('--confirm');

  let mode: BackfillMode = 'all';
  const modeIdx = args.indexOf('--mode');
  if (modeIdx !== -1 && args[modeIdx + 1]) {
    const requestedMode = args[modeIdx + 1].trim().toLowerCase();
    if (requestedMode === 'plaintext-only' || requestedMode === 'rotation-only' || requestedMode === 'all') {
      mode = requestedMode as BackfillMode;
    }
  }

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

  return { isInventory, isDryRun, isConfirmed, mode, batchSize, companyId };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseCliArgs(argv);

  console.log('================================================================');
  console.log('  CoreERP — Bank Account Encryption & Key Maintenance Utility');
  console.log('================================================================');

  try {
    // 1. Initialize Encryption Service and Key Ring
    EncryptionService.init();
    const activeKeyId = EncryptionService.getActiveKeyId();
    const registeredKeys = EncryptionService.getRegisteredKeyIds();

    console.log(`Active Encryption Key ID: "${activeKeyId}"`);
    console.log(`Registered Keys in Ring:  ${registeredKeys.join(', ')}`);
    if (options.companyId) {
      console.log(`Tenant Filter:            ${options.companyId}`);
    }
    console.log('----------------------------------------------------------------');

    // 2. Read-only Key Inventory mode
    if (options.isInventory) {
      console.log('Mode: READ-ONLY KEY INVENTORY REPORT');
      console.log('Scanning database bank account records...\n');

      const inventory = await BankAccountBackfillService.getKeyInventory(options.companyId);

      console.log('================================================================');
      console.log('  Database Key Inventory Summary');
      console.log('================================================================');
      console.log(`Total Records Scanned:          ${inventory.totalRecords}`);
      console.log(`Fully Active Key Records:       ${inventory.fullyActiveCount}`);
      console.log(`Records Needing Rotation:       ${inventory.needsRotationCount}`);
      console.log(`Legacy Plaintext Records:       ${inventory.plaintextCount}`);
      console.log('----------------------------------------------------------------');
      console.log('Credential Count by Key Identifier:');
      for (const [keyId, count] of Object.entries(inventory.countsByKeyId)) {
        const tag = keyId === activeKeyId ? ' [ACTIVE KEY]' : ' [HISTORICAL KEY]';
        console.log(`  - Key "${keyId}"${tag}: ${count}`);
      }
      if (inventory.unknownKeyCount > 0) {
        console.log(`  - Unknown Key IDs:            ${inventory.unknownKeyCount}`);
      }
      if (inventory.unsupportedVersionCount > 0) {
        console.log(`  - Unsupported Versions:       ${inventory.unsupportedVersionCount}`);
      }
      if (inventory.malformedCount > 0) {
        console.log(`  - Malformed Envelopes:        ${inventory.malformedCount}`);
      }
      console.log('================================================================');
      console.log(`\nAdvisory: ${inventory.retirementSafetyNotice}\n`);
      return;
    }

    // 3. Safety check for live execution
    if (!options.isDryRun && !options.isConfirmed) {
      console.error('\n[SAFETY ABORT] Execution halted: live database mutations require explicit confirmation.');
      console.error('Usage:');
      console.error('  Key inventory:       npm run maintenance:backfill-bank-accounts -- --inventory');
      console.error('  Dry-run simulation:  npm run maintenance:backfill-bank-accounts -- --dry-run');
      console.error('  Live batch backfill: npm run maintenance:backfill-bank-accounts -- --confirm');
      console.error('Optional arguments:');
      console.error('  --mode <all|plaintext-only|rotation-only>');
      console.error('  --company-id <UUID>');
      console.error('  --batch-size <1-100>\n');
      process.exit(1);
    }

    const modeText = options.isDryRun ? 'DRY-RUN SIMULATION (No DB Writes)' : 'LIVE BATCH EXECUTION';
    console.log(`Execution Mode:  ${modeText}`);
    console.log(`Candidate Mode:  ${options.mode}`);
    console.log(`Batch Size:      ${options.batchSize}`);
    console.log('----------------------------------------------------------------');

    // 4. Execute bounded, transactional backfill or re-encryption
    const result = await BankAccountBackfillService.runBackfill({
      batchSize: options.batchSize,
      dryRun: options.isDryRun,
      companyId: options.companyId,
      mode: options.mode,
    });

    console.log('\n================================================================');
    console.log('  Maintenance Execution Summary');
    console.log('================================================================');
    console.log(`Total Records Inspected:        ${result.totalInspected}`);
    console.log(`Plaintext Fields Encrypted:     ${result.totalPlaintextEncrypted}`);
    console.log(`Historical Fields Re-encrypted: ${result.totalHistoricalReencrypted}`);
    console.log(`Records Updated in DB:          ${result.totalUpdated}`);
    console.log(`Records Already Active Key:     ${result.totalAlreadyActiveKey}`);
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
    console.error(`\n[FATAL ERROR] Maintenance operation failed: ${error?.message || error}`);
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
