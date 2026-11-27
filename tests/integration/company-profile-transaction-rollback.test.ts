import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import {
  configureIntegrationPrismaClient,
  getPrismaClient,
  prisma,
  resetPrismaClientForTesting,
  verifyDatabaseUrlConsistency,
} from '../../src/server/db/client.js';
import {
  CompanyService,
  PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY,
} from '../../src/server/services/company.service.js';
import { AuthUser } from '../../src/shared/types.js';
import {
  checkTcpPortReachable,
  disconnectIntegrationClients,
  runOwnedCleanupSteps,
  throwIfCleanupErrors,
  validateIntegrationDatabaseTarget,
} from '../helpers/integration-fixture-manager.js';

/**
 * Real PostgreSQL 16 Integration Test Suite:
 * CompanyService.updateProfile Atomic CompanySetting Persistence & Transaction Rollback
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL
 *    pointing to isolated 'core_erp_integration_test' on localhost/127.0.0.1:5434.
 * 2. Never connects to operational (5432), development (5432), or standard unit-test (5433) databases.
 * 3. If integration mode is not enabled, TEST_DATABASE_URL is missing, or port 5434 is unreachable,
 *    marks tests genuinely SKIPPED via `ctx.skip(...)` with an explicit `[BLOCKED / NOT RUN]` note.
 * 4. Induces a genuine PostgreSQL persistence failure (foreign-key violation 23503 inside the active
 *    transaction) on the second CompanySetting upsert without mutating database schema/DDL, proving
 *    PostgreSQL atomically rolls back both the Company update and the first CompanySetting upsert,
 *    and that no COMPANY_PROFILE_UPDATED audit log is recorded.
 * 5. Uses randomly generated per-test company fixtures and deletes only test-owned records in strict
 *    foreign-key order.
 */
describe('PostgreSQL 16 Integration Test: CompanyService.updateProfile Transaction Rollback', () => {
  let validatedTestDbUrl: string | null = null;
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma: PrismaClient | null = null;

  const createdCompanyIds = new Set<string>();

  const cleanupCompanyFixtures = async (
    client: PrismaClient,
    companyId: string
  ): Promise<string[]> =>
    runOwnedCleanupSteps(`companyId=${companyId}`, [
      { label: 'auditLog', run: () => client.auditLog.deleteMany({ where: { companyId } }) },
      {
        label: 'companySettingsChangeRequest',
        run: () => client.companySettingsChangeRequest.deleteMany({ where: { companyId } }),
      },
      {
        label: 'companySetting',
        run: () => client.companySetting.deleteMany({ where: { companyId } }),
      },
      { label: 'user', run: () => client.user.deleteMany({ where: { companyId } }) },
      { label: 'company', run: () => client.company.deleteMany({ where: { id: companyId } }) },
    ]);

  const seedCompanyFixture = async (client: PrismaClient, initialName: string) => {
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const email = `company-tx-${userId.slice(0, 8)}@coreerp.local`;

    createdCompanyIds.add(companyId);

    await client.company.create({
      data: {
        id: companyId,
        code: `CT-${companyId.slice(0, 8)}`,
        name: initialName,
        legalName: `${initialName} LLC`,
        currency: 'USD',
        timezone: 'UTC',
      },
    });

    await client.user.create({
      data: {
        id: userId,
        companyId,
        email,
        fullName: 'Company Tx Super Admin',
        passwordHash: '$2a$10$abcdefghijklmnopqrstuuNOPASSWORDHASHFORTESTONLY123456',
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });

    const actor: AuthUser = {
      id: userId,
      userId,
      companyId,
      email,
      fullName: 'Company Tx Super Admin',
      role: 'SUPER_ADMIN',
      isActive: true,
      tokenVersion: 1,
    };

    return { companyId, userId, actor };
  };

  const assertDatabaseSafety = async (ctx: {
    annotate: (message: string, type?: string) => Promise<unknown>;
    skip: (note?: string) => never;
  }): Promise<PrismaClient> => {
    if (blockedReason) {
      console.warn(blockedReason);
      await ctx.annotate(blockedReason, 'blocked');
      ctx.skip(blockedReason);
    }

    if (!isDbConnected || !testPrisma || !validatedTestDbUrl) {
      throw new Error(
        '[INTEGRATION TEST INVARIANT ERROR] Database connection state inconsistent without blockedReason.'
      );
    }

    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.COREERP_INTEGRATION_TEST_MODE).toBe('true');
    expect(getPrismaClient()).toBe(testPrisma);
    expect(global.__prismaClient).toBe(testPrisma);

    const urlConsistency = verifyDatabaseUrlConsistency(validatedTestDbUrl, prisma);
    expect(urlConsistency.consistent).toBe(true);
    expect(urlConsistency.portMatch).toBe(true);
    expect(urlConsistency.databaseMatch).toBe(true);

    const liveDbCheck = await prisma.$queryRaw<Array<{ db_name: string }>>`
      SELECT current_database() AS db_name
    `;
    expect(liveDbCheck[0]?.db_name).toBe('core_erp_integration_test');

    return testPrisma;
  };

  beforeAll(async () => {
    const target = validateIntegrationDatabaseTarget({
      integrationMode: process.env.COREERP_INTEGRATION_TEST_MODE,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      databaseUrl: process.env.DATABASE_URL,
      suiteLabel: 'CompanySetting transaction rollback PostgreSQL 16 integration test',
    });

    if (target.status === 'blocked') {
      blockedReason = target.reason;
      console.warn(`\n${blockedReason}\n`);
      return;
    }

    const probe = await checkTcpPortReachable(target.host, target.port);
    if (!probe.reachable) {
      blockedReason =
        `[BLOCKED / NOT RUN] PostgreSQL 16 integration endpoint is unreachable at ${target.host}:${target.port} ` +
        `(${probe.code || 'UNREACHABLE'}). No integration assertions were executed.`;
      console.warn(`\n${blockedReason}\n`);
      return;
    }

    validatedTestDbUrl = target.cleanedUrl;
    testPrisma = configureIntegrationPrismaClient(target.cleanedUrl);
    await testPrisma.$connect();

    const versionRows = await testPrisma.$queryRaw<Array<{ version: string }>>`
      SELECT version() AS version
    `;
    const serverVersion = versionRows[0]?.version || '';
    if (!/PostgreSQL 16\b/.test(serverVersion)) {
      throw new Error(
        `[SECURITY FATAL] Integration test requires PostgreSQL major version 16, got: "${serverVersion || 'unknown'}".`
      );
    }

    const dbRows = await testPrisma.$queryRaw<Array<{ db_name: string }>>`
      SELECT current_database() AS db_name
    `;
    if (dbRows[0]?.db_name !== 'core_erp_integration_test') {
      throw new Error(
        `[SECURITY FATAL] Integration client connected to unexpected database "${dbRows[0]?.db_name || 'unknown'}".`
      );
    }

    isDbConnected = true;
  });

  afterAll(async () => {
    const cleanupErrors: string[] = [];
    try {
      if (testPrisma && isDbConnected) {
        for (const companyId of createdCompanyIds) {
          const tenantErrors = await cleanupCompanyFixtures(testPrisma, companyId);
          cleanupErrors.push(...tenantErrors);
        }
      }
    } finally {
      const disconnectErrors = await disconnectIntegrationClients([
        { label: 'testPrisma', client: testPrisma },
      ]);
      cleanupErrors.push(...disconnectErrors);
      resetPrismaClientForTesting();
    }

    throwIfCleanupErrors(cleanupErrors, 'company-profile-transaction-rollback');
  });

  it('persists SALES_INVOICE_ENABLED-only updates atomically in PostgreSQL and records a single audit event', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const { companyId, actor } = await seedCompanyFixture(client, 'Sales Toggle Initial Co');

    const updatedProfile = await CompanyService.updateProfile(
      actor,
      {
        name: 'Sales Toggle Enabled Co',
        legalName: 'Sales Toggle Enabled LLC',
        timezone: 'UTC',
        currency: 'USD',
        salesInvoiceEnabled: true,
      },
      'corr-sales-only-1'
    );

    expect(updatedProfile.name).toBe('Sales Toggle Enabled Co');
    expect(updatedProfile.salesInvoiceEnabled).toBe(true);
    expect(updatedProfile.permittedMonthlyLeaveAllowances).toEqual([4, 5, 6]);

    const companyRow = await client.company.findUnique({ where: { id: companyId } });
    expect(companyRow?.name).toBe('Sales Toggle Enabled Co');

    const salesSetting = await client.companySetting.findUnique({
      where: {
        companyId_key: {
          companyId,
          key: 'SALES_INVOICE_ENABLED',
        },
      },
    });
    expect(salesSetting?.value).toBe('true');

    const allowanceSetting = await client.companySetting.findUnique({
      where: {
        companyId_key: {
          companyId,
          key: PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY,
        },
      },
    });
    expect(allowanceSetting).toBeNull();

    const auditCount = await client.auditLog.count({
      where: { companyId, action: 'COMPANY_PROFILE_UPDATED' },
    });
    expect(auditCount).toBe(1);

    // Toggle back to false and confirm update path persists cleanly
    const disabledProfile = await CompanyService.updateProfile(
      actor,
      {
        name: 'Sales Toggle Disabled Co',
        timezone: 'UTC',
        currency: 'USD',
        salesInvoiceEnabled: false,
      },
      'corr-sales-only-2'
    );
    expect(disabledProfile.salesInvoiceEnabled).toBe(false);

    const salesSettingAfterDisable = await client.companySetting.findUnique({
      where: {
        companyId_key: {
          companyId,
          key: 'SALES_INVOICE_ENABLED',
        },
      },
    });
    expect(salesSettingAfterDisable?.value).toBe('false');
  });

  it('persists combined SALES_INVOICE_ENABLED and PERMITTED_MONTHLY_LEAVE_ALLOWANCES_V1 updates atomically', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const { companyId, actor } = await seedCompanyFixture(client, 'Combined Settings Initial Co');

    const updatedProfile = await CompanyService.updateProfile(
      actor,
      {
        name: 'Combined Settings Updated Co',
        legalName: 'Combined Settings Updated Pvt Ltd',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        salesInvoiceEnabled: true,
        permittedMonthlyLeaveAllowances: [6, 4],
      },
      'corr-combined-ok'
    );

    expect(updatedProfile.name).toBe('Combined Settings Updated Co');
    expect(updatedProfile.timezone).toBe('Asia/Kolkata');
    expect(updatedProfile.currency).toBe('INR');
    expect(updatedProfile.salesInvoiceEnabled).toBe(true);
    expect(updatedProfile.permittedMonthlyLeaveAllowances).toEqual([4, 6]);

    const [companyRow, salesSetting, allowanceSetting, auditCount] = await Promise.all([
      client.company.findUnique({ where: { id: companyId } }),
      client.companySetting.findUnique({
        where: { companyId_key: { companyId, key: 'SALES_INVOICE_ENABLED' } },
      }),
      client.companySetting.findUnique({
        where: {
          companyId_key: { companyId, key: PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY },
        },
      }),
      client.auditLog.count({
        where: { companyId, action: 'COMPANY_PROFILE_UPDATED' },
      }),
    ]);

    expect(companyRow?.name).toBe('Combined Settings Updated Co');
    expect(companyRow?.timezone).toBe('Asia/Kolkata');
    expect(companyRow?.currency).toBe('INR');
    expect(salesSetting?.value).toBe('true');
    expect(allowanceSetting?.value).toBe('[4,6]');
    expect(auditCount).toBe(1);
  });

  it('rolls back company update and first CompanySetting upsert atomically when the second setting upsert hits a genuine PostgreSQL error, recording no success audit event', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const { companyId, actor } = await seedCompanyFixture(client, 'Rollback Baseline Co');

    // Seed pre-existing SALES_INVOICE_ENABLED='false' so we prove rollback restores prior persisted state
    await client.companySetting.create({
      data: {
        companyId,
        key: 'SALES_INVOICE_ENABLED',
        value: 'false',
      },
    });

    const origTx = client.$transaction.bind(client);
    let upsertCallIndex = 0;
    let firstUpsertKey: string | null = null;
    let secondUpsertKey: string | null = null;
    let sawUncommittedCompanyUpdate = false;
    let sawUncommittedFirstSetting = false;
    const nonexistentCompanyId = '00000000-0000-0000-0000-000000000000';

    const txSpy = vi.spyOn(client, '$transaction').mockImplementationOnce((async (cb: any, opts?: any) =>
      origTx(async (tx: any) => {
        const origUpsert = tx.companySetting.upsert.bind(tx.companySetting);

        tx.companySetting.upsert = async (args: any) => {
          upsertCallIndex += 1;
          const settingKey = args?.where?.companyId_key?.key ?? args?.create?.key ?? null;

          if (upsertCallIndex === 1) {
            firstUpsertKey = settingKey;
            const res = await origUpsert(args);

            // Confirm both the Company update and first CompanySetting upsert succeeded inside the open PostgreSQL tx
            const [inTxCompany, inTxSalesSetting] = await Promise.all([
              tx.company.findUnique({
                where: { id: companyId },
                select: { name: true, timezone: true, currency: true },
              }),
              tx.companySetting.findUnique({
                where: { companyId_key: { companyId, key: 'SALES_INVOICE_ENABLED' } },
              }),
            ]);
            sawUncommittedCompanyUpdate =
              inTxCompany?.name === 'Should Roll Back Co' &&
              inTxCompany?.timezone === 'Asia/Kolkata' &&
              inTxCompany?.currency === 'INR';
            sawUncommittedFirstSetting = inTxSalesSetting?.value === 'true';

            return res;
          }

          secondUpsertKey = settingKey;
          // Induce a genuine PostgreSQL persistence failure (FK violation 23503 on CompanySetting_companyId_fkey)
          // inside the live transaction so PostgreSQL itself aborts and rolls back all prior writes.
          await tx.$executeRaw`
            INSERT INTO "CompanySetting" ("id", "companyId", "key", "value", "updatedAt")
            VALUES (
              ${crypto.randomUUID()}::uuid,
              ${nonexistentCompanyId}::uuid,
              ${PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY},
              '[4,5]',
              NOW()
            )
          `;
          return origUpsert(args);
        };

        return cb(tx);
      }, opts)) as any);

    let thrownError: unknown = null;
    try {
      await CompanyService.updateProfile(
        actor,
        {
          name: 'Should Roll Back Co',
          legalName: 'Should Roll Back LLC',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
          salesInvoiceEnabled: true,
          permittedMonthlyLeaveAllowances: [4, 5],
        },
        'corr-rollback-failure'
      );
    } catch (err) {
      thrownError = err;
    } finally {
      txSpy.mockRestore();
    }

    // 1. Genuine PostgreSQL persistence failure propagated (never swallowed)
    expect(thrownError).not.toBeNull();
    expect(
      (thrownError as { meta?: { code?: string }; message?: string })?.meta?.code === '23503' ||
        String((thrownError as { message?: string })?.message || '').includes('23503') ||
        String((thrownError as { message?: string })?.message || '').includes('CompanySetting_companyId_fkey')
    ).toBe(true);

    // 2. Prove both earlier writes actually executed inside the open PostgreSQL transaction before abort
    expect(upsertCallIndex).toBe(2);
    expect(firstUpsertKey).toBe('SALES_INVOICE_ENABLED');
    expect(secondUpsertKey).toBe(PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY);
    expect(sawUncommittedCompanyUpdate).toBe(true);
    expect(sawUncommittedFirstSetting).toBe(true);

    // 3. Verify PostgreSQL rolled back Company update and first CompanySetting upsert atomically
    const [companyAfter, salesAfter, allowanceAfter, auditCountAfter] = await Promise.all([
      client.company.findUnique({ where: { id: companyId } }),
      client.companySetting.findUnique({
        where: { companyId_key: { companyId, key: 'SALES_INVOICE_ENABLED' } },
      }),
      client.companySetting.findUnique({
        where: {
          companyId_key: { companyId, key: PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY },
        },
      }),
      client.auditLog.count({
        where: { companyId, action: 'COMPANY_PROFILE_UPDATED' },
      }),
    ]);

    expect(companyAfter?.name).toBe('Rollback Baseline Co');
    expect(companyAfter?.legalName).toBe('Rollback Baseline Co LLC');
    expect(companyAfter?.timezone).toBe('UTC');
    expect(companyAfter?.currency).toBe('USD');
    expect(salesAfter?.value).toBe('false');
    expect(allowanceAfter).toBeNull();

    // 4. Verify no success audit log was recorded after transaction failure
    expect(auditCountAfter).toBe(0);
  });
});
