import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  configureIntegrationPrismaClient,
  resetPrismaClientForTesting,
} from '../../src/server/db/client.js';
import { EncryptionService } from '../../src/server/security/encryption.service.js';
import { BankAccountBackfillService } from '../../src/server/security/bank-account-backfill.service.js';
import {
  checkTcpPortReachable,
  createIntegrationFixtureScope,
  disconnectIntegrationClients,
  IntegrationFixtureScope,
  throwIfCleanupErrors,
  validateIntegrationDatabaseTarget,
} from '../helpers/integration-fixture-manager.js';

/**
 * Real PostgreSQL 16 Integration Test:
 * Non-Mutating Key-Aware Re-encryption Dry-Run & Inventory Verification (Phase 2.3)
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires TEST_DATABASE_URL pointing to isolated 'core_erp_integration_test' on port 5434.
 * 2. Never connects to production, development, or standard unit-test databases.
 * 3. If TEST_DATABASE_URL is not set or PostgreSQL 16 is not reachable on localhost:5434, marks
 *    execution status as BLOCKED / NOT RUN without failing the suite.
 * 4. Strictly isolated per-test owned fixtures:
 *    - Creates uniquely identified, test-owned company, user, and bank account records encrypted under test key k1.
 *    - Never uses fixed IDs, upsert reuse, or destructive pre-test cleanup.
 *    - Cleans up only tracked test-owned records in explicit foreign-key order and surfaces any cleanup failures.
 */

describe('PostgreSQL 16 Non-Mutating Key-Aware Re-encryption & Inventory Dry-Run', () => {
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma: PrismaClient | null = null;
  const activeScopes: IntegrationFixtureScope[] = [];

  const testK1Hex = '1111111111111111111111111111111111111111111111111111111111111111';
  const testK2Hex = '2222222222222222222222222222222222222222222222222222222222222222';

  beforeAll(async () => {
    const target = validateIntegrationDatabaseTarget({
      integrationMode: process.env.COREERP_INTEGRATION_TEST_MODE,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      databaseUrl: process.env.DATABASE_URL,
      suiteLabel: 'PostgreSQL 16 key-rotation integration test',
    });

    if (target.status === 'blocked') {
      blockedReason = target.reason;
      console.warn(
        `\n${blockedReason}\n` +
          'To run live key-rotation integration tests against PostgreSQL 16 on Docker:\n' +
          '  1. Start container: docker compose --env-file .env.integration-test -f docker-compose.integration-test.yml up -d\n' +
          '  2. Deploy migrations: DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx prisma migrate deploy\n' +
          '  3. Run test: TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npm run test:integration:key-rotation\n'
      );
      return;
    }

    const probe = await checkTcpPortReachable(target.host, target.port);
    if (!probe.reachable) {
      blockedReason =
        `[BLOCKED / NOT RUN] PostgreSQL 16 integration database is unreachable at ${target.host}:${target.port} ` +
        `(${probe.code || 'UNREACHABLE'}).`;
      console.warn(`\n${blockedReason}\n`);
      return;
    }

    // Endpoint is reachable: do NOT catch or downgrade $connect(), auth, missing DB, PG version, identity, or Prisma errors.
    testPrisma = configureIntegrationPrismaClient(target.cleanedUrl);
    await testPrisma.$connect();
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.COREERP_INTEGRATION_TEST_MODE).toBe('true');

    const versionResult = await testPrisma.$queryRawUnsafe<Array<{ version: string }>>('SELECT version();');
    const versionString = versionResult[0]?.version || '';
    const isPg16 = /PostgreSQL\s+16\b/i.test(versionString);
    if (!isPg16) {
      throw new Error('[SECURITY FATAL] Integration test requires PostgreSQL major version 16.');
    }

    const dbRows = await testPrisma.$queryRawUnsafe<Array<{ db_name: string }>>(
      'SELECT current_database() AS db_name;'
    );
    const actualDbName = dbRows[0]?.db_name;
    if (actualDbName !== 'core_erp_integration_test') {
      throw new Error(
        `[SECURITY FATAL] Integration client connected to unexpected database "${actualDbName || 'unknown'}".`
      );
    }

    isDbConnected = true;
  });

  afterAll(async () => {
    const cleanupErrors: string[] = [];
    try {
      if (testPrisma && isDbConnected) {
        for (const scope of activeScopes) {
          if (scope.hasTrackedRecords()) {
            const scopeErrors = await scope.cleanup(testPrisma, { returnErrors: true });
            cleanupErrors.push(...scopeErrors);
          }
        }
      }
    } finally {
      const disconnectErrors = await disconnectIntegrationClients([
        { label: 'testPrisma', client: testPrisma },
      ]);
      cleanupErrors.push(...disconnectErrors);
      resetPrismaClientForTesting();
      EncryptionService.resetKeyRingForTesting();
    }

    throwIfCleanupErrors(cleanupErrors, 'key-rotation-reencryption');
  });

  it('should identify historical-key record in dry run, verify inventory, and leave database unmutated', async (ctx) => {
    if (blockedReason) {
      console.warn(blockedReason);
      await ctx.annotate(blockedReason, 'blocked');
      ctx.skip(blockedReason);
    }

    if (!isDbConnected || !testPrisma) {
      throw new Error(
        '[INTEGRATION TEST INVARIANT ERROR] Database connection state inconsistent without blockedReason.'
      );
    }

    const fixtures = createIntegrationFixtureScope('ROTC', 'key-rotation-dry-run');
    activeScopes.push(fixtures);

    try {
      // 1. Setup initial cryptographic state: k1 is active
      EncryptionService.resetKeyRingForTesting();
      EncryptionService.registerKey('k1', Buffer.from(testK1Hex, 'hex'), true);

      const testPlaintext = 'CONCURRENT_ROTATION_TEST_ACC_1001';
      const originalK1Ciphertext = EncryptionService.encrypt(testPlaintext)!;
      expect(originalK1Ciphertext.startsWith('enc:v1:k1:')).toBe(true);

      // 2. Insert uniquely identified, test-owned fixtures: Company, User, and BankAccount encrypted with k1
      const company = await fixtures.createCompany(testPrisma, {
        name: `Rotation Verification Corp ${fixtures.tokens.runToken}`,
        currency: 'USD',
        timezone: 'UTC',
      });

      await fixtures.createUser(testPrisma, {
        companyId: company.id,
        fullName: 'Rotation Test User',
        role: 'ADMIN',
        isActive: true,
      });

      const testAccount = await fixtures.createCompanyBankAccount(testPrisma, {
        companyId: company.id,
        bankName: 'Historical Key Bank',
        accountHolderName: company.name,
        accountNumber: originalK1Ciphertext,
        isDefault: false,
        isActive: true,
      });

      // 3. Promote k2 to active key, retaining k1 as historical
      EncryptionService.registerKey('k2', Buffer.from(testK2Hex, 'hex'), true);
      expect(EncryptionService.getActiveKeyId()).toBe('k2');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k1');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k2');

      // 4. Execute Dry-Run Re-encryption
      const dryRunResult = await BankAccountBackfillService.runBackfill({
        dryRun: true,
        companyId: company.id,
        mode: 'rotation-only',
      });

      expect(dryRunResult.dryRun).toBe(true);
      expect(dryRunResult.totalInspected).toBe(1);
      expect(dryRunResult.totalUpdated).toBe(1); // Simulated update count
      expect(dryRunResult.totalHistoricalReencrypted).toBe(1);
      expect(dryRunResult.totalErrors).toBe(0);

      // 5. Verify database record was NOT mutated (Strict non-mutating invariant)
      const recordAfterDryRun = await testPrisma.companyBankAccount.findUnique({
        where: { id: testAccount.id },
      });

      expect(recordAfterDryRun).toBeDefined();
      // Database record MUST still contain the exact original k1 ciphertext
      expect(recordAfterDryRun!.accountNumber).toBe(originalK1Ciphertext);
      expect(recordAfterDryRun!.accountNumber.startsWith('enc:v1:k1:')).toBe(true);

      // 6. Verify original k1 ciphertext still decrypts to expected plaintext
      const decrypted = EncryptionService.decrypt(recordAfterDryRun!.accountNumber);
      expect(decrypted).toBe(testPlaintext);

      // 7. Verify Key Inventory Report reflects exactly 1 record under k1 and 0 under k2
      const inventory = await BankAccountBackfillService.getKeyInventory(company.id);
      expect(inventory.totalRecords).toBe(1);
      expect(inventory.activeKeyId).toBe('k2');
      expect(inventory.countsByKeyId['k1']).toBe(1);
      expect(inventory.countsByKeyId['k2']).toBe(0);
      expect(inventory.needsRotationCount).toBe(1);
      expect(inventory.fullyActiveCount).toBe(0);
    } finally {
      // 8. Clean up test-owned data in guaranteed finally block
      await fixtures.cleanup(testPrisma);
    }
  });

  it('should execute live controlled re-encryption on a single test fixture under active key k2, verify round-trip, and clean up safely', async (ctx) => {
    if (blockedReason) {
      console.warn(blockedReason);
      await ctx.annotate(blockedReason, 'blocked');
      ctx.skip(blockedReason);
    }

    if (!isDbConnected || !testPrisma) {
      throw new Error(
        '[INTEGRATION TEST INVARIANT ERROR] Database connection state inconsistent without blockedReason.'
      );
    }

    const fixtures = createIntegrationFixtureScope('LROTC', 'key-rotation-live');
    activeScopes.push(fixtures);
    let createdCompanyId: string | null = null;

    try {
      // 1. Setup initial cryptographic state: k1 is active
      EncryptionService.resetKeyRingForTesting();
      EncryptionService.registerKey('k1', Buffer.from(testK1Hex, 'hex'), true);

      const testPlaintext = 'LIVE_ROTATION_AUTHORIZED_ACC_2002';
      const originalK1Ciphertext = EncryptionService.encrypt(testPlaintext)!;
      expect(originalK1Ciphertext.startsWith('enc:v1:k1:')).toBe(true);
      expect(EncryptionService.decrypt(originalK1Ciphertext)).toBe(testPlaintext);

      // 2. Insert uniquely identified, test-owned fixtures: Company, User, and BankAccount encrypted with k1
      const company = await fixtures.createCompany(testPrisma, {
        name: `Live Rotation Corp ${fixtures.tokens.runToken}`,
        currency: 'USD',
        timezone: 'UTC',
      });
      createdCompanyId = company.id;

      await fixtures.createUser(testPrisma, {
        companyId: company.id,
        fullName: 'Live Rotation User',
        role: 'ADMIN',
        isActive: true,
      });

      const testAccount = await fixtures.createCompanyBankAccount(testPrisma, {
        companyId: company.id,
        bankName: 'Live Historical Key Bank',
        accountHolderName: company.name,
        accountNumber: originalK1Ciphertext,
        isDefault: false,
        isActive: true,
      });

      // 3. Promote k2 to active key, retaining k1 as historical
      EncryptionService.registerKey('k2', Buffer.from(testK2Hex, 'hex'), true);
      expect(EncryptionService.getActiveKeyId()).toBe('k2');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k1');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k2');

      // 4. Step 8 of pre-flight: Dry-Run scoped strictly to test fixture
      const dryRunResult = await BankAccountBackfillService.runBackfill({
        dryRun: true,
        companyId: company.id,
        accountId: testAccount.id,
        mode: 'rotation-only',
      });

      expect(dryRunResult.dryRun).toBe(true);
      expect(dryRunResult.totalInspected).toBe(1);
      expect(dryRunResult.totalUpdated).toBe(1);
      expect(dryRunResult.totalHistoricalReencrypted).toBe(1);
      expect(dryRunResult.totalErrors).toBe(0);

      // Verify record was NOT mutated during dry-run
      const recordAfterDryRun = await testPrisma.companyBankAccount.findUnique({
        where: { id: testAccount.id },
      });
      expect(recordAfterDryRun!.accountNumber).toBe(originalK1Ciphertext);

      // 5. Authorized Live Re-encryption scoped strictly to test fixture
      const liveResult = await BankAccountBackfillService.runBackfill({
        dryRun: false,
        companyId: company.id,
        accountId: testAccount.id,
        mode: 'rotation-only',
      });

      expect(liveResult.dryRun).toBe(false);
      expect(liveResult.totalInspected).toBe(1);
      expect(liveResult.totalUpdated).toBe(1);
      expect(liveResult.totalHistoricalReencrypted).toBe(1);
      expect(liveResult.totalErrors).toBe(0);

      // 6. Post-operation verification
      const recordAfterLive = await testPrisma.companyBankAccount.findUnique({
        where: { id: testAccount.id },
      });
      expect(recordAfterLive).toBeDefined();

      // 6.1. Fixture now uses active test key k2
      expect(recordAfterLive!.accountNumber.startsWith('enc:v1:k2:')).toBe(true);

      // 6.2. Old k1 ciphertext is no longer stored
      expect(recordAfterLive!.accountNumber).not.toBe(originalK1Ciphertext);

      // 6.3. New ciphertext decrypts successfully and matches original plaintext
      const decryptedLive = EncryptionService.decrypt(recordAfterLive!.accountNumber);
      expect(decryptedLive).toBe(testPlaintext);

      // 6.4. Scoped key inventory reports expected counts (k1: 0, k2: 1)
      const inventory = await BankAccountBackfillService.getKeyInventory(company.id, testAccount.id);
      expect(inventory.totalRecords).toBe(1);
      expect(inventory.activeKeyId).toBe('k2');
      expect(inventory.countsByKeyId['k1']).toBe(0);
      expect(inventory.countsByKeyId['k2']).toBe(1);
      expect(inventory.needsRotationCount).toBe(0);
      expect(inventory.fullyActiveCount).toBe(1);

      // 6.5. Idempotent re-run skips already active key record
      const rerunResult = await BankAccountBackfillService.runBackfill({
        dryRun: false,
        companyId: company.id,
        accountId: testAccount.id,
        mode: 'rotation-only',
      });
      expect(rerunResult.totalUpdated).toBe(0);
      expect(rerunResult.totalAlreadyActiveKey).toBe(1);
    } finally {
      // 7. Safe cleanup of test-owned records in guaranteed finally block
      await fixtures.cleanup(testPrisma);
      if (createdCompanyId) {
        const countRemaining = await testPrisma.companyBankAccount.count({
          where: { companyId: createdCompanyId },
        });
        expect(countRemaining).toBe(0);
      }
    }
  });
});
