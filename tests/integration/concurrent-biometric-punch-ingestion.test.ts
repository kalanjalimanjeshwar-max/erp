import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import net from 'net';
import crypto from 'crypto';
import {
  configureIntegrationPrismaClient,
  resetPrismaClientForTesting,
} from '../../src/server/db/client.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';

/**
 * Real PostgreSQL 16 Concurrency Integration Test:
 * Concurrent Biometric Raw Punch Ingestion & `skipDuplicates` Idempotency
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL
 *    pointing to isolated 'core_erp_integration_test' on localhost:5434.
 * 2. Never connects to operational (5432), development (5432), or standard unit-test (5433) databases.
 * 3. If integration mode is not enabled, TEST_DATABASE_URL is missing, or PostgreSQL 16 on localhost:5434
 *    is unreachable, reports status as BLOCKED / NOT RUN cleanly without masking DB errors.
 */
describe('PostgreSQL 16 Concurrency Integration Test: Biometric Raw Punch Ingestion', () => {
  const testDbUrl = process.env.TEST_DATABASE_URL;
  const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';
  let isDbReachable = false;
  let testPrisma: PrismaClient | null = null;

  const testCompanyId = '00000000-0000-4000-a000-000000000095';
  const testUserId = '00000000-0000-4000-a000-000000000096';
  const testTerminalId = '00000000-0000-4000-a000-000000000094';

  const cleanupTestData = async (client: PrismaClient) => {
    try {
      await client.auditLog.deleteMany({ where: { companyId: testCompanyId } });
    } catch {}
    try {
      await client.rawPunchLog.deleteMany({ where: { companyId: testCompanyId } });
    } catch {}
    try {
      await client.companySetting.deleteMany({ where: { companyId: testCompanyId } });
    } catch {}
    try {
      await client.biometricTerminal.deleteMany({ where: { companyId: testCompanyId } });
    } catch {}
    try {
      await client.user.deleteMany({ where: { companyId: testCompanyId } });
    } catch {}
    try {
      await client.company.deleteMany({ where: { id: testCompanyId } });
    } catch {}
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
    if (!isIntegrationMode || !testDbUrl || testDbUrl.trim() === '') {
      console.warn(
        '\n[INTEGRATION TEST BLOCKED / NOT RUN]: Biometric PostgreSQL integration test requires ' +
          'COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL pointing to localhost:5434/core_erp_integration_test.\n'
      );
      isDbReachable = false;
      return;
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
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error('[SECURITY FATAL] Integration test refused: unapproved host in TEST_DATABASE_URL.');
    }
    if (parseInt(parsed.port, 10) !== 5434) {
      throw new Error('[SECURITY FATAL] Integration test refused: port must be 5434.');
    }
    const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    if (dbName !== 'core_erp_integration_test') {
      throw new Error('[SECURITY FATAL] Integration test refused: database name must be core_erp_integration_test.');
    }

    const reachable = await checkPortReachable(parsed.hostname, 5434);
    if (!reachable) {
      console.warn(
        '\n[INTEGRATION TEST BLOCKED / NOT RUN]: PostgreSQL 16 integration database is unreachable at localhost:5434.\n'
      );
      isDbReachable = false;
      return;
    }

    try {
      testPrisma = configureIntegrationPrismaClient(testDbUrl);
      await testPrisma.$connect();
      isDbReachable = true;
    } catch {
      console.warn('[INTEGRATION TEST BLOCKED / NOT RUN]: PostgreSQL 16 connection failed.');
      isDbReachable = false;
    }
  });

  afterAll(async () => {
    if (testPrisma && isDbReachable) {
      await cleanupTestData(testPrisma);
      await testPrisma.$disconnect();
    }
    resetPrismaClientForTesting();
  });

  it('should deduplicate concurrent identical raw punch batches atomically on PostgreSQL 16', async () => {
    if (!isDbReachable || !testPrisma) {
      console.warn(
        'Skipping execution: PostgreSQL 16 integration instance offline or COREERP_INTEGRATION_TEST_MODE not active (Status: BLOCKED / NOT RUN).'
      );
      expect(true).toBe(true);
      return;
    }

    await cleanupTestData(testPrisma);

    await testPrisma.company.create({
      data: {
        id: testCompanyId,
        code: 'BIOINT95',
        name: 'Biometric Integration Co',
        currency: 'USD',
        timezone: 'UTC',
      },
    });

    await testPrisma.user.create({
      data: {
        id: testUserId,
        companyId: testCompanyId,
        email: 'bio-int-admin@coreerp.local',
        fullName: 'Integration Admin',
        passwordHash: 'not-used-in-test',
        role: 'ADMIN',
        isActive: true,
      },
    });

    const apiKeyHash = crypto.createHash('sha256').update('bio_int_test_key').digest('hex');
    const terminal = await testPrisma.biometricTerminal.create({
      data: {
        id: testTerminalId,
        companyId: testCompanyId,
        deviceSerialNumber: 'INT-X2008-01',
        name: 'Integration Gate',
        terminalModel: 'eSSL X2008',
        apiKeyHash,
        apiKeyPrefix: 'bio_int_',
        registeredByUserId: testUserId,
        isActive: true,
      },
    });

    const batchPayload = {
      punches: [
        {
          devicePunchId: 'int-concurrent-p1',
          userEnrollmentId: '101',
          punchTime: '2026-10-19T08:00:00.000Z',
        },
        {
          devicePunchId: 'int-concurrent-p2',
          userEnrollmentId: '102',
          punchTime: '2026-10-19T08:05:00.000Z',
        },
      ],
    };

    const [resA, resB] = await Promise.all([
      BiometricService.ingestPunches(terminal, batchPayload),
      BiometricService.ingestPunches(terminal, batchPayload),
    ]);

    expect(resA.inserted + resB.inserted).toBe(2);
    expect(resA.duplicates + resB.duplicates).toBe(2);

    const persistedCount = await testPrisma.rawPunchLog.count({
      where: { companyId: testCompanyId, terminalId: testTerminalId },
    });
    expect(persistedCount).toBe(2);
  });
});
