import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { EncryptionService } from '../../src/server/security/encryption.service.js';
import { BankAccountBackfillService } from '../../src/server/security/bank-account-backfill.service.js';
import net from 'net';

/**
 * Real PostgreSQL 16 Integration Test:
 * Non-Mutating Key-Aware Re-encryption Dry-Run & Inventory Verification (Phase 2.3)
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires TEST_DATABASE_URL pointing to isolated 'core_erp_integration_test' on port 5434.
 * 2. Never connects to production, development, or standard unit-test databases.
 * 3. If TEST_DATABASE_URL is not set or PostgreSQL 16 is not reachable on localhost:5434, marks
 *    execution status as BLOCKED / NOT RUN without failing the suite.
 * 4. Strictly NON-MUTATING verification:
 *    - Creates an isolated, test-owned bank account record encrypted under test key k1.
 *    - Switches active key to k2 with k1 retained in the historical key ring.
 *    - Executes dry-run re-encryption.
 *    - Asserts dry-run reports 1 record requiring re-encryption to k2.
 *    - Asserts database record still contains the exact original k1 ciphertext (unmodified).
 *    - Asserts key inventory accurately reflects 1 record under k1 and 0 under k2.
 *    - Cleans up all test-owned records in safe foreign-key order.
 */

describe('PostgreSQL 16 Non-Mutating Key-Aware Re-encryption & Inventory Dry-Run', () => {
  const testDbUrl = process.env.TEST_DATABASE_URL;
  let isDbReachable = false;
  let testPrisma: PrismaClient | null = null;

  const testCompanyId = '00000000-0000-4000-a000-000000000097';
  const testUserId = '00000000-0000-4000-a000-000000000007';

  const testK1Hex = '1111111111111111111111111111111111111111111111111111111111111111';
  const testK2Hex = '2222222222222222222222222222222222222222222222222222222222222222';

  const cleanupTestData = async (client: PrismaClient) => {
    const errors: string[] = [];
    try {
      await client.auditLog.deleteMany({ where: { companyId: testCompanyId } });
    } catch (err: any) {
      errors.push(`auditLog: ${err?.message || err}`);
    }
    try {
      await client.companyBankAccount.deleteMany({ where: { companyId: testCompanyId } });
    } catch (err: any) {
      errors.push(`companyBankAccount: ${err?.message || err}`);
    }
    try {
      await client.user.deleteMany({ where: { companyId: testCompanyId } });
    } catch (err: any) {
      errors.push(`user: ${err?.message || err}`);
    }
    try {
      await client.company.deleteMany({ where: { id: testCompanyId } });
    } catch (err: any) {
      errors.push(`company: ${err?.message || err}`);
    }

    if (errors.length > 0) {
      console.error(
        `[TEST CLEANUP WARNING] Safe foreign-key cleanup encountered errors for company "${testCompanyId}":\n  ${errors.join('\n  ')}`
      );
    }
  };

  const checkPortReachable = (host: string, port: number, timeoutMs = 1000): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        resolve(false);
      });
      socket.connect(port, host);
    });
  };

  beforeAll(async () => {
    if (!testDbUrl || testDbUrl.trim() === '') {
      console.warn(
        '\n[INTEGRATION TEST BLOCKED / NOT RUN]: TEST_DATABASE_URL is not configured.\n' +
        'To run live integration tests against PostgreSQL 16 on Windows/Docker:\n' +
        '  TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npm test\n'
      );
      isDbReachable = false;
      return;
    }

    if (process.env.DATABASE_URL && testDbUrl === process.env.DATABASE_URL) {
      throw new Error(
        '[SECURITY FATAL] Integration test refused: TEST_DATABASE_URL matches primary DATABASE_URL.'
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(testDbUrl);
    } catch {
      throw new Error('[SECURITY FATAL] Invalid database URL format for TEST_DATABASE_URL.');
    }

    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      throw new Error('[SECURITY FATAL] Forbidden database protocol in TEST_DATABASE_URL.');
    }

    const host = parsed.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
      throw new Error('[SECURITY FATAL] Unapproved host in TEST_DATABASE_URL.');
    }

    const port = parseInt(parsed.port, 10);
    if (port !== 5434) {
      throw new Error('[SECURITY FATAL] Dedicated integration test must run on port 5434.');
    }

    const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    if (dbName !== 'core_erp_integration_test') {
      throw new Error('[SECURITY FATAL] Dedicated database name must strictly be "core_erp_integration_test".');
    }

    const reachable = await checkPortReachable(host, port);
    if (!reachable) {
      console.warn(
        '\n[INTEGRATION TEST BLOCKED / NOT RUN]: PostgreSQL 16 integration database is unreachable at localhost:5434.\n'
      );
      isDbReachable = false;
      return;
    }

    try {
      testPrisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
      await testPrisma.$connect();

      const versionResult = await testPrisma.$queryRawUnsafe<Array<{ version: string }>>('SELECT version();');
      const versionString = versionResult[0]?.version || '';
      const isPg16 = /PostgreSQL\s+16\b/i.test(versionString);
      if (!isPg16) {
        throw new Error('[SECURITY FATAL] Integration test requires PostgreSQL major version 16.');
      }

      isDbReachable = true;
    } catch (err: any) {
      if (err.message && err.message.includes('[SECURITY FATAL]')) {
        throw err;
      }
      console.warn('[INTEGRATION TEST BLOCKED]: Database connection failed.');
      isDbReachable = false;
    }
  });

  afterAll(async () => {
    if (testPrisma) {
      await cleanupTestData(testPrisma);
      await testPrisma.$disconnect();
    }
    EncryptionService.resetKeyRingForTesting();
  });

  it('should identify historical-key record in dry run, verify inventory, and leave database unmutated', async () => {
    if (!isDbReachable || !testPrisma) {
      console.warn('Skipping execution: PostgreSQL 16 test instance offline or TEST_DATABASE_URL not configured (Status: BLOCKED / NOT RUN).');
      expect(true).toBe(true);
      return;
    }

    // Clean up any stale data from previous aborted runs
    await cleanupTestData(testPrisma);

    try {
      // 1. Setup initial cryptographic state: k1 is active
      EncryptionService.resetKeyRingForTesting();
      EncryptionService.registerKey('k1', Buffer.from(testK1Hex, 'hex'), true);

      const testPlaintext = 'CONCURRENT_ROTATION_TEST_ACC_1001';
      const originalK1Ciphertext = EncryptionService.encrypt(testPlaintext)!;
      expect(originalK1Ciphertext.startsWith('enc:v1:k1:')).toBe(true);

      // 2. Insert test fixtures: Company, User, and BankAccount encrypted with k1
      await testPrisma.company.upsert({
        where: { id: testCompanyId },
        update: {},
        create: {
          id: testCompanyId,
          name: 'Rotation Verification Corp',
          code: 'ROTC',
          currency: 'USD',
          timezone: 'UTC',
        },
      });

      await testPrisma.user.upsert({
        where: { id: testUserId },
        update: {},
        create: {
          id: testUserId,
          companyId: testCompanyId,
          email: 'rotation-test-user@coreerp.local',
          fullName: 'Rotation Test User',
          role: 'ADMIN',
          isActive: true,
          passwordHash: '$2a$10$abcdefghijklmnopqrstuuNOPASSWORDHASHFORTESTONLY123456',
        },
      });

      const testAccount = await testPrisma.companyBankAccount.create({
        data: {
          companyId: testCompanyId,
          bankName: 'Historical Key Bank',
          accountHolderName: 'Rotation Verification Corp',
          accountNumber: originalK1Ciphertext,
          isDefault: false,
          isActive: true,
        },
      });

      // 3. Promote k2 to active key, retaining k1 as historical
      EncryptionService.registerKey('k2', Buffer.from(testK2Hex, 'hex'), true);
      expect(EncryptionService.getActiveKeyId()).toBe('k2');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k1');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k2');

      // 4. Execute Dry-Run Re-encryption
      const dryRunResult = await BankAccountBackfillService.runBackfill({
        dryRun: true,
        companyId: testCompanyId,
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
      const inventory = await BankAccountBackfillService.getKeyInventory(testCompanyId);
      expect(inventory.totalRecords).toBe(1);
      expect(inventory.activeKeyId).toBe('k2');
      expect(inventory.countsByKeyId['k1']).toBe(1);
      expect(inventory.countsByKeyId['k2']).toBe(0);
      expect(inventory.needsRotationCount).toBe(1);
      expect(inventory.fullyActiveCount).toBe(0);
    } finally {
      // 8. Clean up test data in guaranteed finally block
      await cleanupTestData(testPrisma);
    }
  });

  it('should execute live controlled re-encryption on a single test fixture under active key k2, verify round-trip, and clean up safely', async () => {
    if (!isDbReachable || !testPrisma) {
      console.warn('Skipping execution: PostgreSQL 16 test instance offline or TEST_DATABASE_URL not configured (Status: BLOCKED / NOT RUN).');
      expect(true).toBe(true);
      return;
    }

    // Clean up any stale data from previous runs
    await cleanupTestData(testPrisma);

    try {
      // 1. Setup initial cryptographic state: k1 is active
      EncryptionService.resetKeyRingForTesting();
      EncryptionService.registerKey('k1', Buffer.from(testK1Hex, 'hex'), true);

      const testPlaintext = 'LIVE_ROTATION_AUTHORIZED_ACC_2002';
      const originalK1Ciphertext = EncryptionService.encrypt(testPlaintext)!;
      expect(originalK1Ciphertext.startsWith('enc:v1:k1:')).toBe(true);
      expect(EncryptionService.decrypt(originalK1Ciphertext)).toBe(testPlaintext);

      // 2. Insert test fixtures: Company, User, and BankAccount encrypted with k1
      await testPrisma.company.upsert({
        where: { id: testCompanyId },
        update: {},
        create: {
          id: testCompanyId,
          name: 'Live Rotation Corp',
          code: 'LROTC',
          currency: 'USD',
          timezone: 'UTC',
        },
      });

      await testPrisma.user.upsert({
        where: { id: testUserId },
        update: {},
        create: {
          id: testUserId,
          companyId: testCompanyId,
          email: 'live-rotation-user@coreerp.local',
          fullName: 'Live Rotation User',
          role: 'ADMIN',
          isActive: true,
          passwordHash: '$2a$10$abcdefghijklmnopqrstuuNOPASSWORDHASHFORTESTONLY123456',
        },
      });

      const testAccount = await testPrisma.companyBankAccount.create({
        data: {
          companyId: testCompanyId,
          bankName: 'Live Historical Key Bank',
          accountHolderName: 'Live Rotation Corp',
          accountNumber: originalK1Ciphertext,
          isDefault: false,
          isActive: true,
        },
      });

      // 3. Promote k2 to active key, retaining k1 as historical
      EncryptionService.registerKey('k2', Buffer.from(testK2Hex, 'hex'), true);
      expect(EncryptionService.getActiveKeyId()).toBe('k2');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k1');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k2');

      // 4. Step 8 of pre-flight: Dry-Run scoped strictly to test fixture
      const dryRunResult = await BankAccountBackfillService.runBackfill({
        dryRun: true,
        companyId: testCompanyId,
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
        companyId: testCompanyId,
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
      const inventory = await BankAccountBackfillService.getKeyInventory(testCompanyId, testAccount.id);
      expect(inventory.totalRecords).toBe(1);
      expect(inventory.activeKeyId).toBe('k2');
      expect(inventory.countsByKeyId['k1']).toBe(0);
      expect(inventory.countsByKeyId['k2']).toBe(1);
      expect(inventory.needsRotationCount).toBe(0);
      expect(inventory.fullyActiveCount).toBe(1);

      // 6.5. Idempotent re-run skips already active key record
      const rerunResult = await BankAccountBackfillService.runBackfill({
        dryRun: false,
        companyId: testCompanyId,
        accountId: testAccount.id,
        mode: 'rotation-only',
      });
      expect(rerunResult.totalUpdated).toBe(0);
      expect(rerunResult.totalAlreadyActiveKey).toBe(1);
    } finally {
      // 7. Safe cleanup of test-owned records in guaranteed finally block
      await cleanupTestData(testPrisma);
      const countRemaining = await testPrisma.companyBankAccount.count({
        where: { companyId: testCompanyId },
      });
      expect(countRemaining).toBe(0);
    }
  });
});
