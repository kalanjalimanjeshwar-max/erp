import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  configureIntegrationPrismaClient,
  getPrismaClient,
  prisma,
  resetPrismaClientForTesting,
  verifyDatabaseUrlConsistency,
} from '../../src/server/db/client.js';
import { JournalService } from '../../src/server/services/journal.service.js';
import { ContraService } from '../../src/server/services/contra.service.js';
import { AccountingReportService } from '../../src/server/services/accounting-report.service.js';
import type { AuthUser } from '../../src/shared/types.js';

/**
 * Real PostgreSQL 16 Integration Test Suite:
 * BUG-1 (Reversal Reporting) & ADD-1 (Calendar-Date Boundaries & Company Timezone Handling)
 *
 * Scope & Safety:
 * 1. Dedicated Test Database: Strictly requires COREERP_INTEGRATION_TEST_MODE=true and
 *    TEST_DATABASE_URL pointing to isolated 'core_erp_integration_test' on localhost/127.0.0.1:5434.
 * 2. Never connects to operational/development (5432) or standard unit-test (5433) databases.
 * 3. If integration mode is not enabled, TEST_DATABASE_URL is missing, or port 5434 is unreachable,
 *    marks tests genuinely SKIPPED via `ctx.skip(...)` with an explicit `[BLOCKED / NOT RUN]` note.
 * 4. Uses real Prisma queries against PostgreSQL 16 with zero Prisma mocking.
 * 5. Seeds uniquely scoped per-test tenant fixtures and cleans up only test-owned records in
 *    strict foreign-key order during `afterAll`.
 */
describe('PostgreSQL 16 Integration Test: Accounting Reversals (BUG-1) & Calendar Dates (ADD-1)', () => {
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^["']|["']$/g, '');
  const isIntegrationMode = process.env.COREERP_INTEGRATION_TEST_MODE === 'true';
  let blockedReason: string | null = null;
  let isDbConnected = false;
  let testPrisma: PrismaClient | null = null;

  const createdCompanyIds = new Set<string>();

  interface SeededAccountingTenant {
    companyId: string;
    userId: string;
    actor: AuthUser;
    cashLedgerId: string;
    bankLedgerId: string;
    revenueLedgerId: string;
    equityLedgerId: string;
  }

  const cleanupCompanyFixtures = async (
    client: PrismaClient,
    companyId: string
  ): Promise<string[]> => {
    const deleteSteps: Array<{ label: string; run: () => Promise<unknown> }> = [
      { label: 'auditLog', run: () => client.auditLog.deleteMany({ where: { companyId } }) },
      { label: 'journalLine', run: () => client.journalLine.deleteMany({ where: { companyId } }) },
      { label: 'journalEntry', run: () => client.journalEntry.deleteMany({ where: { companyId } }) },
      {
        label: 'documentNumberSequence',
        run: () => client.documentNumberSequence.deleteMany({ where: { companyId } }),
      },
      { label: 'accountLedger', run: () => client.accountLedger.deleteMany({ where: { companyId } }) },
      { label: 'accountGroup', run: () => client.accountGroup.deleteMany({ where: { companyId } }) },
      { label: 'user', run: () => client.user.deleteMany({ where: { companyId } }) },
      { label: 'company', run: () => client.company.deleteMany({ where: { id: companyId } }) },
    ];

    const errors: string[] = [];
    for (const step of deleteSteps) {
      try {
        await step.run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`companyId=${companyId} step=${step.label}: ${message}`);
      }
    }
    return errors;
  };

  const seedAccountingTenant = async (
    client: PrismaClient,
    options: { name: string; timezone?: string }
  ): Promise<SeededAccountingTenant> => {
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const shortId = companyId.slice(0, 8);
    const email = `acct-int-${userId.slice(0, 8)}@coreerp.local`;
    const timezone = options.timezone ?? 'UTC';

    createdCompanyIds.add(companyId);

    await client.company.create({
      data: {
        id: companyId,
        code: `ARD-${shortId}`,
        name: options.name,
        legalName: `${options.name} LLC`,
        currency: 'USD',
        timezone,
      },
    });

    await client.user.create({
      data: {
        id: userId,
        companyId,
        email,
        fullName: `${options.name} Super Admin`,
        passwordHash: '$2a$10$abcdefghijklmnopqrstuuNOPASSWORDHASHFORTESTONLY123456',
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });

    const assetGroupId = crypto.randomUUID();
    const incomeGroupId = crypto.randomUUID();
    const equityGroupId = crypto.randomUUID();

    await client.accountGroup.createMany({
      data: [
        {
          id: assetGroupId,
          companyId,
          code: '1000',
          name: 'Current Assets',
          rootType: 'ASSET',
          isSystem: false,
        },
        {
          id: equityGroupId,
          companyId,
          code: '3000',
          name: 'Capital & Equity',
          rootType: 'EQUITY',
          isSystem: false,
        },
        {
          id: incomeGroupId,
          companyId,
          code: '4000',
          name: 'Operating Income',
          rootType: 'INCOME',
          isSystem: false,
        },
      ],
    });

    const cashLedgerId = crypto.randomUUID();
    const bankLedgerId = crypto.randomUUID();
    const equityLedgerId = crypto.randomUUID();
    const revenueLedgerId = crypto.randomUUID();

    // Opening balances are balanced: Cash (5,000 Dr) + Bank (10,000 Dr) = Owner Capital (15,000 Cr)
    await client.accountLedger.createMany({
      data: [
        {
          id: cashLedgerId,
          companyId,
          groupId: assetGroupId,
          code: '1001',
          name: 'Main Cash Account',
          currency: 'USD',
          isActive: true,
          openingBalance: '5000.0000',
          openingBalanceType: 'DEBIT',
        },
        {
          id: bankLedgerId,
          companyId,
          groupId: assetGroupId,
          code: '1002',
          name: 'Operating Bank Account',
          currency: 'USD',
          isActive: true,
          openingBalance: '10000.0000',
          openingBalanceType: 'DEBIT',
        },
        {
          id: equityLedgerId,
          companyId,
          groupId: equityGroupId,
          code: '3001',
          name: 'Owner Capital',
          currency: 'USD',
          isActive: true,
          openingBalance: '15000.0000',
          openingBalanceType: 'CREDIT',
        },
        {
          id: revenueLedgerId,
          companyId,
          groupId: incomeGroupId,
          code: '4001',
          name: 'Consulting Revenue',
          currency: 'USD',
          isActive: true,
          openingBalance: '0.0000',
          openingBalanceType: 'CREDIT',
        },
      ],
    });

    const actor: AuthUser = {
      id: userId,
      userId,
      companyId,
      email,
      fullName: `${options.name} Super Admin`,
      role: 'SUPER_ADMIN',
      isActive: true,
      tokenVersion: 1,
    };

    return {
      companyId,
      userId,
      actor,
      cashLedgerId,
      bankLedgerId,
      revenueLedgerId,
      equityLedgerId,
    };
  };

  const checkPortReachable = (
    host: string,
    port: number,
    timeoutMs = 1000
  ): Promise<{ reachable: boolean; code?: string }> => {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (result: { reachable: boolean; code?: string }) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve(result);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish({ reachable: true }));
      socket.once('timeout', () => finish({ reachable: false, code: 'TIMEOUT' }));
      socket.once('error', (err: NodeJS.ErrnoException) =>
        finish({ reachable: false, code: err.code || 'SOCKET_ERROR' })
      );
      socket.connect(port, host);
    });
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

    if (!isDbConnected || !testPrisma) {
      throw new Error(
        '[INTEGRATION TEST INVARIANT ERROR] Database connection state inconsistent without blockedReason.'
      );
    }

    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.COREERP_INTEGRATION_TEST_MODE).toBe('true');
    expect(getPrismaClient()).toBe(testPrisma);
    expect(global.__prismaClient).toBe(testPrisma);

    const urlConsistency = verifyDatabaseUrlConsistency(testDbUrl!, prisma);
    expect(urlConsistency.consistent).toBe(true);
    expect(urlConsistency.portMatch).toBe(true);
    expect(urlConsistency.databaseMatch).toBe(true);

    const liveDbCheck = await prisma.$queryRaw<Array<{ db_name: string }>>`
      SELECT current_database() AS db_name
    `;
    expect(liveDbCheck[0]?.db_name).toBe('core_erp_integration_test');

    return testPrisma;
  };

  const expectHttp400 = async (promise: Promise<unknown>, expectedMessagePattern?: RegExp) => {
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { statusCode?: number }).statusCode).toBe(400);
    if (expectedMessagePattern) {
      expect((caught as Error).message).toMatch(expectedMessagePattern);
    }
  };

  beforeAll(async () => {
    if (!isIntegrationMode || !testDbUrl || testDbUrl === '') {
      blockedReason =
        '[BLOCKED / NOT RUN] Accounting reversals (BUG-1) and calendar-date (ADD-1) PostgreSQL 16 integration test requires ' +
        'COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL targeting localhost:5434/core_erp_integration_test.';
      console.warn(`\n${blockedReason}\n`);
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

    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      throw new Error('[SECURITY FATAL] Integration test refused: unapproved host in TEST_DATABASE_URL.');
    }

    if (parsed.port !== '5434') {
      throw new Error('[SECURITY FATAL] Integration test refused: port must be explicitly 5434.');
    }

    const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    if (dbName !== 'core_erp_integration_test') {
      throw new Error(
        '[SECURITY FATAL] Integration test refused: database name must be core_erp_integration_test.'
      );
    }

    const probe = await checkPortReachable(hostname, 5434);
    if (!probe.reachable) {
      blockedReason =
        `[BLOCKED / NOT RUN] PostgreSQL 16 integration endpoint is unreachable at ${hostname}:5434 ` +
        `(${probe.code || 'UNREACHABLE'}). No integration assertions were executed.`;
      console.warn(`\n${blockedReason}\n`);
      return;
    }

    testPrisma = configureIntegrationPrismaClient(testDbUrl);
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
    vi.useRealTimers();
    const cleanupErrors: string[] = [];
    try {
      if (testPrisma && isDbConnected) {
        for (const companyId of createdCompanyIds) {
          try {
            const tenantErrors = await cleanupCompanyFixtures(testPrisma, companyId);
            cleanupErrors.push(...tenantErrors);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            cleanupErrors.push(`companyId=${companyId} unexpected cleanup error: ${message}`);
          }
        }
      }
    } finally {
      if (testPrisma) {
        try {
          await testPrisma.$disconnect();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          cleanupErrors.push(`prisma.$disconnect failed: ${message}`);
        }
      }
      resetPrismaClientForTesting();
    }

    if (cleanupErrors.length > 0) {
      throw new Error(
        `[INTEGRATION CLEANUP FAILED] ${cleanupErrors.length} error(s) occurred while cleaning up test fixtures:\n${cleanupErrors.join('\n')}`
      );
    }
  });

  it('BUG-1: preserves historical pre-reversal reports, nets post-reversal to zero, and excludes DRAFT journals across Ledger, Trial Balance, P&L, Balance Sheet, and Cash Book', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const tenant = await seedAccountingTenant(client, {
      name: 'BUG1 Reversal Reporting Co',
      timezone: 'UTC',
    });

    // Fake ONLY Date so Prisma/PostgreSQL async I/O timers are unaffected
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-20T12:00:00.000Z'));

    try {
      // 1. Create draft journal and explicitly post it through the supported service flow
      const createdDraft = await JournalService.createJournal(tenant.actor, {
        entryDate: '2026-02-10',
        narration: 'Consulting retainer received in cash',
        reference: 'INV-BUG1-01',
        autoPost: false,
        lines: [
          { ledgerId: tenant.cashLedgerId, debit: '2500.0000', credit: '0.0000' },
          { ledgerId: tenant.revenueLedgerId, debit: '0.0000', credit: '2500.0000' },
        ],
      });
      expect(createdDraft.status).toBe('DRAFT');

      const postedOriginal = await JournalService.postJournal(tenant.actor, createdDraft.id);
      expect(postedOriginal.status).toBe('POSTED');
      expect(postedOriginal.entryDate).toBe('2026-02-10');

      // 2. Create an unposted DRAFT journal in the same window that must remain excluded everywhere
      const unpostedDraft = await JournalService.createJournal(tenant.actor, {
        entryDate: '2026-02-11',
        narration: 'Unposted draft must stay excluded',
        reference: 'DRAFT-BUG1-01',
        autoPost: false,
        lines: [
          { ledgerId: tenant.cashLedgerId, debit: '999.0000', credit: '0.0000' },
          { ledgerId: tenant.revenueLedgerId, debit: '0.0000', credit: '999.0000' },
        ],
      });
      expect(unpostedDraft.status).toBe('DRAFT');

      // 3. Capture historical pre-reversal reports ending 2026-02-15 (before 2026-02-20 reversal)
      const preRevLedger = await AccountingReportService.getLedgerStatement(
        tenant.companyId,
        tenant.cashLedgerId,
        { fromDate: '2026-02-01', toDate: '2026-02-15' }
      );
      const preRevTrialBalance = await AccountingReportService.getTrialBalance(tenant.companyId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });
      const preRevPnl = await AccountingReportService.getProfitAndLoss(tenant.companyId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });
      const preRevBalanceSheet = await AccountingReportService.getBalanceSheet(tenant.companyId, {
        asOfDate: '2026-02-15',
      });
      const preRevCashBook = await AccountingReportService.getCashBook(tenant.companyId, {
        ledgerId: tenant.cashLedgerId,
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });

      expect(preRevLedger.openingBalance).toBe('5000.0000');
      expect(preRevLedger.totalDebit).toBe('2500.0000');
      expect(preRevLedger.totalCredit).toBe('0.0000');
      expect(preRevLedger.closingBalance).toBe('7500.0000');
      expect(preRevLedger.lines.map((l) => l.journalId)).toEqual([postedOriginal.id]);

      expect(preRevTrialBalance.isBalanced).toBe(true);
      expect(preRevTrialBalance.reconciliationStatus).toBe('BALANCED');
      expect(preRevTrialBalance.rows.find((r) => r.ledgerId === tenant.cashLedgerId)?.closingDebit).toBe(
        '7500.0000'
      );
      expect(
        preRevTrialBalance.rows.find((r) => r.ledgerId === tenant.revenueLedgerId)?.closingCredit
      ).toBe('2500.0000');

      expect(preRevPnl.totalIncome).toBe('2500.0000');
      expect(preRevPnl.netProfit).toBe('2500.0000');

      expect(preRevBalanceSheet.isBalanced).toBe(true);
      expect(preRevBalanceSheet.totalAssets).toBe('17500.0000');
      expect(preRevBalanceSheet.currentPeriodProfit).toBe('2500.0000');
      expect(preRevBalanceSheet.totalLiabilitiesAndEquity).toBe('17500.0000');

      expect(preRevCashBook.closingBalance).toBe('7500.0000');
      expect(preRevCashBook.lines.map((l) => l.journalId)).toEqual([postedOriginal.id]);

      // 4. Reverse the posted journal on 2026-02-20
      const { original, reversal } = await JournalService.reverseJournal(
        tenant.actor,
        postedOriginal.id,
        'Duplicate consulting invoice'
      );

      expect(original.status).toBe('REVERSED');
      expect(original.reversedAt).not.toBeNull();
      expect(reversal.status).toBe('POSTED');
      expect(reversal.reversalOfId).toBe(original.id);
      expect(reversal.entryDate).toBe('2026-02-20');
      expect(reversal.totalDebit).toBe('2500.0000');
      expect(reversal.totalCredit).toBe('2500.0000');

      // Confirm persisted PostgreSQL statuses directly
      const [dbOriginal, dbReversal] = await Promise.all([
        client.journalEntry.findUnique({ where: { id: original.id } }),
        client.journalEntry.findUnique({ where: { id: reversal.id } }),
      ]);
      expect(dbOriginal?.status).toBe('REVERSED');
      expect(dbReversal?.status).toBe('POSTED');
      expect(dbReversal?.reversalOfId).toBe(original.id);

      // 5. Re-run historical reports ending 2026-02-15: must remain unchanged after reversal
      const histLedger = await AccountingReportService.getLedgerStatement(
        tenant.companyId,
        tenant.cashLedgerId,
        { fromDate: '2026-02-01', toDate: '2026-02-15' }
      );
      const histTrialBalance = await AccountingReportService.getTrialBalance(tenant.companyId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });
      const histPnl = await AccountingReportService.getProfitAndLoss(tenant.companyId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });
      const histBalanceSheet = await AccountingReportService.getBalanceSheet(tenant.companyId, {
        asOfDate: '2026-02-15',
      });
      const histCashBook = await AccountingReportService.getCashBook(tenant.companyId, {
        ledgerId: tenant.cashLedgerId,
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });

      expect(histLedger.closingBalance).toBe(preRevLedger.closingBalance);
      expect(histLedger.lines.map((l) => l.journalId)).toEqual([original.id]);
      expect(histTrialBalance.rows).toEqual(preRevTrialBalance.rows);
      expect(histTrialBalance.isBalanced).toBe(true);
      expect(histPnl.netProfit).toBe(preRevPnl.netProfit);
      expect(histBalanceSheet.totalAssets).toBe(preRevBalanceSheet.totalAssets);
      expect(histBalanceSheet.currentPeriodProfit).toBe(preRevBalanceSheet.currentPeriodProfit);
      expect(histBalanceSheet.isBalanced).toBe(true);
      expect(histCashBook.closingBalance).toBe(preRevCashBook.closingBalance);
      expect(histCashBook.lines.map((l) => l.journalId)).toEqual([original.id]);

      // 6. Run post-reversal reports through 2026-02-20: both entries included, net effect is zero, DRAFT excluded
      const postRevLedger = await AccountingReportService.getLedgerStatement(
        tenant.companyId,
        tenant.cashLedgerId,
        { fromDate: '2026-02-01', toDate: '2026-02-20' }
      );
      const postRevTrialBalance = await AccountingReportService.getTrialBalance(tenant.companyId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-20',
      });
      const postRevPnl = await AccountingReportService.getProfitAndLoss(tenant.companyId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-20',
      });
      const postRevBalanceSheet = await AccountingReportService.getBalanceSheet(tenant.companyId, {
        asOfDate: '2026-02-20',
      });
      const postRevCashBook = await AccountingReportService.getCashBook(tenant.companyId, {
        ledgerId: tenant.cashLedgerId,
        fromDate: '2026-02-01',
        toDate: '2026-02-20',
      });

      expect(postRevLedger.lines.map((l) => l.journalId)).toEqual([original.id, reversal.id]);
      expect(postRevLedger.lines.some((l) => l.journalId === unpostedDraft.id)).toBe(false);
      expect(postRevLedger.totalDebit).toBe('2500.0000');
      expect(postRevLedger.totalCredit).toBe('2500.0000');
      expect(postRevLedger.closingBalance).toBe('5000.0000');
      expect(postRevLedger.closingBalanceType).toBe('DEBIT');

      expect(postRevTrialBalance.isBalanced).toBe(true);
      const postCashRow = postRevTrialBalance.rows.find((r) => r.ledgerId === tenant.cashLedgerId);
      const postRevRow = postRevTrialBalance.rows.find((r) => r.ledgerId === tenant.revenueLedgerId);
      expect(postCashRow?.periodDebit).toBe('2500.0000');
      expect(postCashRow?.periodCredit).toBe('2500.0000');
      expect(postCashRow?.closingDebit).toBe('5000.0000');
      expect(postRevRow?.periodDebit).toBe('2500.0000');
      expect(postRevRow?.periodCredit).toBe('2500.0000');
      expect(postRevRow?.closingCredit).toBe('0.0000');

      expect(postRevPnl.totalIncome).toBe('0.0000');
      expect(postRevPnl.netProfit).toBe('0.0000');

      expect(postRevBalanceSheet.isBalanced).toBe(true);
      expect(postRevBalanceSheet.totalAssets).toBe('15000.0000');
      expect(postRevBalanceSheet.currentPeriodProfit).toBe('0.0000');
      expect(postRevBalanceSheet.totalLiabilitiesAndEquity).toBe('15000.0000');

      expect(postRevCashBook.lines.map((l) => l.journalId)).toEqual([original.id, reversal.id]);
      expect(postRevCashBook.lines.some((l) => l.journalId === unpostedDraft.id)).toBe(false);
      expect(postRevCashBook.totalDebit).toBe('2500.0000');
      expect(postRevCashBook.totalCredit).toBe('2500.0000');
      expect(postRevCashBook.closingBalance).toBe('5000.0000');
    } finally {
      vi.useRealTimers();
    }
  });

  it('BUG-1: preserves historical Cash Book & Bank Book balances on Contra reversal, nets to zero post-reversal, and excludes DRAFT contras', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const tenant = await seedAccountingTenant(client, {
      name: 'BUG1 Contra CashBank Co',
      timezone: 'UTC',
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-18T12:00:00.000Z'));

    try {
      const postedContra = await ContraService.createContraEntry(tenant.actor, {
        entryDate: '2026-03-10',
        sourceLedgerId: tenant.cashLedgerId,
        destinationLedgerId: tenant.bankLedgerId,
        amount: '1200.0000',
        narration: 'Cash deposit into operating bank',
        autoPost: true,
      });
      expect(postedContra.status).toBe('POSTED');

      const draftContra = await ContraService.createContraEntry(tenant.actor, {
        entryDate: '2026-03-11',
        sourceLedgerId: tenant.cashLedgerId,
        destinationLedgerId: tenant.bankLedgerId,
        amount: '444.0000',
        narration: 'Draft contra must be excluded',
        autoPost: false,
      });
      expect(draftContra.status).toBe('DRAFT');

      const preBankBook = await AccountingReportService.getBankBook(tenant.companyId, {
        ledgerId: tenant.bankLedgerId,
        fromDate: '2026-03-01',
        toDate: '2026-03-15',
      });
      const preCashBook = await AccountingReportService.getCashBook(tenant.companyId, {
        ledgerId: tenant.cashLedgerId,
        fromDate: '2026-03-01',
        toDate: '2026-03-15',
      });

      expect(preBankBook.closingBalance).toBe('11200.0000');
      expect(preBankBook.lines.map((l) => l.journalId)).toEqual([postedContra.id]);
      expect(preCashBook.closingBalance).toBe('3800.0000');
      expect(preCashBook.lines.map((l) => l.journalId)).toEqual([postedContra.id]);

      const { original, reversal } = await ContraService.reverseContraEntry(
        tenant.actor,
        postedContra.id,
        'Deposit slip cancelled'
      );

      expect(original.status).toBe('REVERSED');
      expect(reversal.status).toBe('POSTED');
      expect(reversal.reversalOfId).toBe(original.id);
      expect(reversal.entryDate).toBe('2026-03-18');

      // Historical reports before reversal date remain identical
      const histBankBook = await AccountingReportService.getBankBook(tenant.companyId, {
        ledgerId: tenant.bankLedgerId,
        fromDate: '2026-03-01',
        toDate: '2026-03-15',
      });
      const histCashBook = await AccountingReportService.getCashBook(tenant.companyId, {
        ledgerId: tenant.cashLedgerId,
        fromDate: '2026-03-01',
        toDate: '2026-03-15',
      });
      expect(histBankBook.closingBalance).toBe('11200.0000');
      expect(histBankBook.lines.map((l) => l.journalId)).toEqual([original.id]);
      expect(histCashBook.closingBalance).toBe('3800.0000');
      expect(histCashBook.lines.map((l) => l.journalId)).toEqual([original.id]);

      // Post-reversal reports include original + reversal, exclude draft, and net back to opening balances
      const postBankBook = await AccountingReportService.getBankBook(tenant.companyId, {
        ledgerId: tenant.bankLedgerId,
        fromDate: '2026-03-01',
        toDate: '2026-03-18',
      });
      const postCashBook = await AccountingReportService.getCashBook(tenant.companyId, {
        ledgerId: tenant.cashLedgerId,
        fromDate: '2026-03-01',
        toDate: '2026-03-18',
      });

      expect(postBankBook.lines.map((l) => l.journalId)).toEqual([original.id, reversal.id]);
      expect(postBankBook.lines.some((l) => l.journalId === draftContra.id)).toBe(false);
      expect(postBankBook.closingBalance).toBe('10000.0000');

      expect(postCashBook.lines.map((l) => l.journalId)).toEqual([original.id, reversal.id]);
      expect(postCashBook.lines.some((l) => l.journalId === draftContra.id)).toBe(false);
      expect(postCashBook.closingBalance).toBe('5000.0000');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ADD-1: enforces inclusive start date, exclusive next-day end boundary, and tenant isolation across reports, JournalService.listJournals, and ContraService.listContraEntries', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const tenantA = await seedAccountingTenant(client, { name: 'ADD1 Boundary Tenant A' });
    const tenantB = await seedAccountingTenant(client, { name: 'ADD1 Boundary Tenant B' });

    // Tenant A journals spanning day-before, start, end, and day-after
    const jBefore = await JournalService.createJournal(tenantA.actor, {
      entryDate: '2026-04-09',
      narration: 'Day before fromDate',
      autoPost: true,
      lines: [
        { ledgerId: tenantA.cashLedgerId, debit: '100.0000', credit: '0.0000' },
        { ledgerId: tenantA.revenueLedgerId, debit: '0.0000', credit: '100.0000' },
      ],
    });
    const jStart = await JournalService.createJournal(tenantA.actor, {
      entryDate: '2026-04-10',
      narration: 'Exact fromDate',
      autoPost: true,
      lines: [
        { ledgerId: tenantA.cashLedgerId, debit: '200.0000', credit: '0.0000' },
        { ledgerId: tenantA.revenueLedgerId, debit: '0.0000', credit: '200.0000' },
      ],
    });
    const jEnd = await JournalService.createJournal(tenantA.actor, {
      entryDate: '2026-04-15',
      narration: 'Exact toDate',
      autoPost: true,
      lines: [
        { ledgerId: tenantA.cashLedgerId, debit: '300.0000', credit: '0.0000' },
        { ledgerId: tenantA.revenueLedgerId, debit: '0.0000', credit: '300.0000' },
      ],
    });
    const jAfter = await JournalService.createJournal(tenantA.actor, {
      entryDate: '2026-04-16',
      narration: 'Day after toDate',
      autoPost: true,
      lines: [
        { ledgerId: tenantA.cashLedgerId, debit: '400.0000', credit: '0.0000' },
        { ledgerId: tenantA.revenueLedgerId, debit: '0.0000', credit: '400.0000' },
      ],
    });

    // Tenant A contra entries on exact boundaries (excluded day-before, included start/end, excluded day-after)
    const cBefore = await ContraService.createContraEntry(tenantA.actor, {
      entryDate: '2026-04-09',
      sourceLedgerId: tenantA.cashLedgerId,
      destinationLedgerId: tenantA.bankLedgerId,
      amount: '50.0000',
      autoPost: true,
    });
    const cStart = await ContraService.createContraEntry(tenantA.actor, {
      entryDate: '2026-04-10',
      sourceLedgerId: tenantA.cashLedgerId,
      destinationLedgerId: tenantA.bankLedgerId,
      amount: '60.0000',
      autoPost: true,
    });
    const cEnd = await ContraService.createContraEntry(tenantA.actor, {
      entryDate: '2026-04-15',
      sourceLedgerId: tenantA.cashLedgerId,
      destinationLedgerId: tenantA.bankLedgerId,
      amount: '70.0000',
      autoPost: true,
    });
    const cAfter = await ContraService.createContraEntry(tenantA.actor, {
      entryDate: '2026-04-16',
      sourceLedgerId: tenantA.cashLedgerId,
      destinationLedgerId: tenantA.bankLedgerId,
      amount: '80.0000',
      autoPost: true,
    });

    // Tenant B entries right in the middle of the date window (must never leak into Tenant A)
    const tenantBJournal = await JournalService.createJournal(tenantB.actor, {
      entryDate: '2026-04-12',
      narration: 'Tenant B isolated journal',
      autoPost: true,
      lines: [
        { ledgerId: tenantB.cashLedgerId, debit: '7777.0000', credit: '0.0000' },
        { ledgerId: tenantB.revenueLedgerId, debit: '0.0000', credit: '7777.0000' },
      ],
    });
    const tenantBContra = await ContraService.createContraEntry(tenantB.actor, {
      entryDate: '2026-04-12',
      sourceLedgerId: tenantB.cashLedgerId,
      destinationLedgerId: tenantB.bankLedgerId,
      amount: '5555.0000',
      autoPost: true,
    });

    // 1. Ledger Statement (Revenue): opening=100 (from 2026-04-09), period=200+300=500, closing=600
    const revLedger = await AccountingReportService.getLedgerStatement(
      tenantA.companyId,
      tenantA.revenueLedgerId,
      { fromDate: '2026-04-10', toDate: '2026-04-15' }
    );
    expect(revLedger.openingBalance).toBe('100.0000');
    expect(revLedger.openingBalanceType).toBe('CREDIT');
    expect(revLedger.lines.map((l) => l.journalId)).toEqual([jStart.id, jEnd.id]);
    expect(revLedger.totalCredit).toBe('500.0000');
    expect(revLedger.closingBalance).toBe('600.0000');

    // 2. Trial Balance for Tenant A: balanced, reflects exact boundaries, zero Tenant B leakage
    const tb = await AccountingReportService.getTrialBalance(tenantA.companyId, {
      fromDate: '2026-04-10',
      toDate: '2026-04-15',
    });
    expect(tb.isBalanced).toBe(true);
    const tbRevRow = tb.rows.find((r) => r.ledgerId === tenantA.revenueLedgerId);
    expect(tbRevRow?.openingCredit).toBe('100.0000');
    expect(tbRevRow?.periodCredit).toBe('500.0000');
    expect(tbRevRow?.closingCredit).toBe('600.0000');
    expect(tb.rows.some((r) => r.ledgerId === tenantB.cashLedgerId)).toBe(false);

    // 3. Cash Book for Tenant A: opening = 5000 + 100 - 50 = 5050, period Dr = 500, period Cr = 130, closing = 5420
    const cashBook = await AccountingReportService.getCashBook(tenantA.companyId, {
      ledgerId: tenantA.cashLedgerId,
      fromDate: '2026-04-10',
      toDate: '2026-04-15',
    });
    expect(cashBook.openingBalance).toBe('5050.0000');
    expect(cashBook.totalDebit).toBe('500.0000');
    expect(cashBook.totalCredit).toBe('130.0000');
    expect(cashBook.closingBalance).toBe('5420.0000');
    const cashBookIds = new Set(cashBook.lines.map((l) => l.journalId));
    expect(cashBookIds.has(jStart.id)).toBe(true);
    expect(cashBookIds.has(jEnd.id)).toBe(true);
    expect(cashBookIds.has(cStart.id)).toBe(true);
    expect(cashBookIds.has(cEnd.id)).toBe(true);
    expect(cashBookIds.has(jBefore.id)).toBe(false);
    expect(cashBookIds.has(jAfter.id)).toBe(false);
    expect(cashBookIds.has(cBefore.id)).toBe(false);
    expect(cashBookIds.has(cAfter.id)).toBe(false);
    expect(cashBookIds.has(tenantBJournal.id)).toBe(false);
    expect(cashBookIds.has(tenantBContra.id)).toBe(false);

    // 4. Single-day range (fromDate === toDate === '2026-04-15') includes exact day and excludes next day
    const singleDayLedger = await AccountingReportService.getLedgerStatement(
      tenantA.companyId,
      tenantA.revenueLedgerId,
      { fromDate: '2026-04-15', toDate: '2026-04-15' }
    );
    expect(singleDayLedger.openingBalance).toBe('300.0000');
    expect(singleDayLedger.lines.map((l) => l.journalId)).toEqual([jEnd.id]);
    expect(singleDayLedger.closingBalance).toBe('600.0000');

    // 5. JournalService.listJournals date boundaries & tenant isolation
    const listedJournals = await JournalService.listJournals(tenantA.companyId, {
      fromDate: '2026-04-10',
      toDate: '2026-04-15',
    });
    const listedJournalIds = new Set(listedJournals.map((j) => j.id));
    expect(listedJournalIds).toEqual(new Set([jStart.id, jEnd.id, cStart.id, cEnd.id]));

    // 6. ContraService.listContraEntries date boundaries, CV- filtering, & tenant isolation
    const listedContras = await ContraService.listContraEntries(tenantA.companyId, {
      fromDate: '2026-04-10',
      toDate: '2026-04-15',
    });
    expect(new Set(listedContras.map((c) => c.id))).toEqual(new Set([cStart.id, cEnd.id]));

    // 7. Cross-tenant ledger access fails closed with 404
    let crossTenantLedgerErr: unknown;
    try {
      await AccountingReportService.getLedgerStatement(tenantA.companyId, tenantB.cashLedgerId, {
        fromDate: '2026-04-01',
        toDate: '2026-04-30',
      });
    } catch (err) {
      crossTenantLedgerErr = err;
    }
    expect((crossTenantLedgerErr as { statusCode?: number })?.statusCode).toBe(404);

    let crossTenantBookErr: unknown;
    try {
      await AccountingReportService.getCashBook(tenantA.companyId, {
        ledgerId: tenantB.cashLedgerId,
        fromDate: '2026-04-01',
        toDate: '2026-04-30',
      });
    } catch (err) {
      crossTenantBookErr = err;
    }
    expect((crossTenantBookErr as { statusCode?: number })?.statusCode).toBe(404);
  });

  it('ADD-1: assigns Jan 1 Contra voucher numbers using calendar year (CV-2026-XXXX) independent of host local timezone', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const tenant = await seedAccountingTenant(client, {
      name: 'ADD1 Jan1 Contra Co',
      timezone: 'America/New_York',
    });

    // Simulate a negative-UTC host where Date.prototype.getFullYear() on 2026-01-01T00:00:00Z returns 2025
    const getFullYearSpy = vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2025);

    try {
      const firstContra = await ContraService.createContraEntry(tenant.actor, {
        entryDate: '2026-01-01',
        sourceLedgerId: tenant.cashLedgerId,
        destinationLedgerId: tenant.bankLedgerId,
        amount: '250.0000',
        narration: 'New Year opening transfer 1',
        autoPost: true,
      });

      const secondContra = await ContraService.createContraEntry(tenant.actor, {
        entryDate: '2026-01-01',
        sourceLedgerId: tenant.bankLedgerId,
        destinationLedgerId: tenant.cashLedgerId,
        amount: '100.0000',
        narration: 'New Year opening transfer 2',
        autoPost: true,
      });

      expect(firstContra.voucherNumber).toBe('CV-2026-0001');
      expect(firstContra.entryDate).toBe('2026-01-01');
      expect(secondContra.voucherNumber).toBe('CV-2026-0002');
      expect(secondContra.entryDate).toBe('2026-01-01');

      // Verify exact PostgreSQL @db.Date column storage
      const persistedDates = await client.$queryRaw<Array<{ id: string; entry_date: string }>>`
        SELECT id::text AS id, to_char("entryDate", 'YYYY-MM-DD') AS entry_date
        FROM "JournalEntry"
        WHERE id IN (${firstContra.id}::uuid, ${secondContra.id}::uuid)
        ORDER BY "voucherNumber" ASC
      `;
      expect(persistedDates).toEqual([
        { id: firstContra.id, entry_date: '2026-01-01' },
        { id: secondContra.id, entry_date: '2026-01-01' },
      ]);
    } finally {
      getFullYearSpy.mockRestore();
    }
  });

  it('ADD-1: resolves company-configured timezone for reversal dates, reversal voucher years, and default Balance Sheet asOfDate across UTC midnight rollover', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const asiaTenant = await seedAccountingTenant(client, {
      name: 'ADD1 Asia Kolkata Co',
      timezone: 'Asia/Kolkata', // UTC+05:30 -> 2026-01-01 07:00 IST at 2026-01-01T01:30:00Z
    });
    const americasTenant = await seedAccountingTenant(client, {
      name: 'ADD1 Americas LA Co',
      timezone: 'America/Los_Angeles', // UTC-08:00 -> 2025-12-31 17:30 PST at 2026-01-01T01:30:00Z
    });

    // Pin ONLY Date to 2026-01-01T01:30:00.000Z (straddles year boundary between IST and PST)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T01:30:00.000Z'));

    try {
      // Seed 2025-12-15 posted journals and contras in both tenants
      const asiaJournal = await JournalService.createJournal(asiaTenant.actor, {
        entryDate: '2025-12-15',
        narration: 'Asia Dec journal',
        autoPost: true,
        lines: [
          { ledgerId: asiaTenant.cashLedgerId, debit: '500.0000', credit: '0.0000' },
          { ledgerId: asiaTenant.revenueLedgerId, debit: '0.0000', credit: '500.0000' },
        ],
      });
      const asiaContra = await ContraService.createContraEntry(asiaTenant.actor, {
        entryDate: '2025-12-15',
        sourceLedgerId: asiaTenant.cashLedgerId,
        destinationLedgerId: asiaTenant.bankLedgerId,
        amount: '300.0000',
        autoPost: true,
      });

      const americasJournal = await JournalService.createJournal(americasTenant.actor, {
        entryDate: '2025-12-15',
        narration: 'Americas Dec journal',
        autoPost: true,
        lines: [
          { ledgerId: americasTenant.cashLedgerId, debit: '500.0000', credit: '0.0000' },
          { ledgerId: americasTenant.revenueLedgerId, debit: '0.0000', credit: '500.0000' },
        ],
      });
      const americasContra = await ContraService.createContraEntry(americasTenant.actor, {
        entryDate: '2025-12-15',
        sourceLedgerId: americasTenant.cashLedgerId,
        destinationLedgerId: americasTenant.bankLedgerId,
        amount: '300.0000',
        autoPost: true,
      });

      expect(asiaJournal.voucherNumber).toBe('JV-2025-00001');
      expect(asiaContra.voucherNumber).toBe('CV-2025-0001');
      expect(americasJournal.voucherNumber).toBe('JV-2025-00001');
      expect(americasContra.voucherNumber).toBe('CV-2025-0001');

      // Reverse both journals & contras at the same UTC instant (2026-01-01T01:30:00Z)
      const asiaJournalRev = await JournalService.reverseJournal(
        asiaTenant.actor,
        asiaJournal.id,
        'IST New Year reversal'
      );
      const asiaContraRev = await ContraService.reverseContraEntry(
        asiaTenant.actor,
        asiaContra.id,
        'IST New Year contra reversal'
      );

      const americasJournalRev = await JournalService.reverseJournal(
        americasTenant.actor,
        americasJournal.id,
        'PST Year-End reversal'
      );
      const americasContraRev = await ContraService.reverseContraEntry(
        americasTenant.actor,
        americasContra.id,
        'PST Year-End contra reversal'
      );

      // Asia/Kolkata resolves to 2026-01-01 (2026 voucher sequence)
      expect(asiaJournalRev.reversal.entryDate).toBe('2026-01-01');
      expect(asiaJournalRev.reversal.voucherNumber).toBe('JV-2026-00001');
      expect(asiaContraRev.reversal.entryDate).toBe('2026-01-01');
      expect(asiaContraRev.reversal.voucherNumber).toBe('CV-2026-0001');

      // America/Los_Angeles resolves to 2025-12-31 (2025 voucher sequence)
      expect(americasJournalRev.reversal.entryDate).toBe('2025-12-31');
      expect(americasJournalRev.reversal.voucherNumber).toBe('JV-2025-00002');
      expect(americasContraRev.reversal.entryDate).toBe('2025-12-31');
      expect(americasContraRev.reversal.voucherNumber).toBe('CV-2025-0002');

      // Default Balance Sheet without explicit asOfDate uses each company's timezone date
      const asiaDefaultBs = await AccountingReportService.getBalanceSheet(asiaTenant.companyId);
      const americasDefaultBs = await AccountingReportService.getBalanceSheet(americasTenant.companyId);

      expect(asiaDefaultBs.asOfDate).toBe('2026-01-01');
      expect(asiaDefaultBs.isBalanced).toBe(true);
      expect(asiaDefaultBs.currentPeriodProfit).toBe('0.0000');

      expect(americasDefaultBs.asOfDate).toBe('2025-12-31');
      expect(americasDefaultBs.isBalanced).toBe(true);
      expect(americasDefaultBs.currentPeriodProfit).toBe('0.0000');

      // Verify persisted PostgreSQL DATE values directly
      const dbReversalDates = await client.$queryRaw<Array<{ id: string; entry_date: string }>>`
        SELECT id::text AS id, to_char("entryDate", 'YYYY-MM-DD') AS entry_date
        FROM "JournalEntry"
        WHERE id IN (${asiaJournalRev.reversal.id}::uuid, ${americasJournalRev.reversal.id}::uuid)
      `;
      const dateById = new Map(dbReversalDates.map((r) => [r.id, r.entry_date]));
      expect(dateById.get(asiaJournalRev.reversal.id)).toBe('2026-01-01');
      expect(dateById.get(americasJournalRev.reversal.id)).toBe('2025-12-31');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ADD-1: rejects invalid calendar dates, timestamps, inverted ranges, and 9999-12-31 overflow with HTTP 400 while accepting max safe 9999-12-30 on PostgreSQL 16', async (ctx) => {
    const client = await assertDatabaseSafety(ctx);
    const tenant = await seedAccountingTenant(client, { name: 'ADD1 Validation Co' });

    const captureWriteCounts = async () => {
      const [journalEntry, journalLine, documentNumberSequence, auditLog] = await Promise.all([
        client.journalEntry.count({ where: { companyId: tenant.companyId } }),
        client.journalLine.count({ where: { companyId: tenant.companyId } }),
        client.documentNumberSequence.count({ where: { companyId: tenant.companyId } }),
        client.auditLog.count({ where: { companyId: tenant.companyId } }),
      ]);
      return { journalEntry, journalLine, documentNumberSequence, auditLog };
    };

    const beforeCounts = await captureWriteCounts();

    // Journal creation rejects impossible date, ISO timestamp, and out-of-range 9999-12-31 / 0000-01-01
    for (const badDate of ['2026-02-29', '2026-02-15T12:00:00Z', '9999-12-31', '0000-01-01']) {
      await expectHttp400(
        JournalService.createJournal(tenant.actor, {
          entryDate: badDate,
          narration: 'Invalid date test',
          autoPost: false,
          lines: [
            { ledgerId: tenant.cashLedgerId, debit: '100.0000', credit: '0.0000' },
            { ledgerId: tenant.revenueLedgerId, debit: '0.0000', credit: '100.0000' },
          ],
        })
      );
    }

    // Contra creation rejects invalid calendar date and timestamp with timezone offset
    for (const badDate of ['2026-02-30', '2026-02-15T00:00:00+05:30', '9999-12-31']) {
      await expectHttp400(
        ContraService.createContraEntry(tenant.actor, {
          entryDate: badDate,
          sourceLedgerId: tenant.cashLedgerId,
          destinationLedgerId: tenant.bankLedgerId,
          amount: '100.0000',
          autoPost: false,
        })
      );
    }

    // List & report endpoints reject invalid formats, impossible dates, inverted ranges, and 9999-12-31
    await expectHttp400(
      JournalService.listJournals(tenant.companyId, {
        fromDate: '2026-02-20',
        toDate: '2026-02-10',
      }),
      /cannot be after/
    );
    await expectHttp400(
      JournalService.listJournals(tenant.companyId, { toDate: '9999-12-31' }),
      /9999-12-30/
    );
    await expectHttp400(
      ContraService.listContraEntries(tenant.companyId, {
        fromDate: '2026-02-20',
        toDate: '2026-02-10',
      }),
      /cannot be after/
    );
    await expectHttp400(
      ContraService.listContraEntries(tenant.companyId, { toDate: '9999-12-31' }),
      /9999-12-30/
    );
    await expectHttp400(
      AccountingReportService.getLedgerStatement(tenant.companyId, tenant.cashLedgerId, {
        fromDate: '2026-02-15T00:00:00Z',
        toDate: '2026-02-20',
      })
    );
    await expectHttp400(
      AccountingReportService.getTrialBalance(tenant.companyId, {
        fromDate: '2026-02-20',
        toDate: '2026-02-10',
      }),
      /cannot be after/
    );
    await expectHttp400(
      AccountingReportService.getTrialBalance(tenant.companyId, { toDate: '9999-12-31' }),
      /9999-12-30/
    );
    await expectHttp400(
      AccountingReportService.getCashBook(tenant.companyId, {
        ledgerId: tenant.cashLedgerId,
        toDate: '2026-02-29',
      })
    );
    await expectHttp400(
      AccountingReportService.getBalanceSheet(tenant.companyId, {
        asOfDate: '2026-02-15T12:00:00Z',
      })
    );

    // Ensure no rows were persisted in any write-capable table by rejected requests
    const afterCounts = await captureWriteCounts();
    expect(afterCounts).toEqual(beforeCounts);

    // Confirm max safe calendar date 9999-12-30 executes cleanly against PostgreSQL 16
    const maxSafeTb = await AccountingReportService.getTrialBalance(tenant.companyId, {
      fromDate: '2026-01-01',
      toDate: '9999-12-30',
    });
    expect(maxSafeTb.toDate).toBe('9999-12-30');
    expect(maxSafeTb.isBalanced).toBe(true);

    const maxSafeJournals = await JournalService.listJournals(tenant.companyId, {
      fromDate: '2026-01-01',
      toDate: '9999-12-30',
    });
    expect(Array.isArray(maxSafeJournals)).toBe(true);

    const maxSafeContras = await ContraService.listContraEntries(tenant.companyId, {
      fromDate: '2026-01-01',
      toDate: '9999-12-30',
    });
    expect(Array.isArray(maxSafeContras)).toBe(true);
  });
});
