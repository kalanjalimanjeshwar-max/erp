import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../src/server/db/client.js';
import { AccountingReportService } from '../../src/server/services/accounting-report.service.js';
import { JournalService } from '../../src/server/services/journal.service.js';
import { ContraService } from '../../src/server/services/contra.service.js';
import { DocumentSequenceService } from '../../src/server/services/document-sequence.service.js';
import { parseCalendarDate, parseReportDateRange } from '../../src/server/accounting/calendar-date.js';
import { Decimal } from '../../src/server/accounting/decimal-math.js';
import { AuthUser } from '../../src/shared/types.js';

// Stateful in-memory Prisma double that faithfully executes where-clause filtering
// (companyId, ledgerId, journal.status, journal.entryDate lt/gte/lte) so tests verify
// real accounting outcomes rather than only mock call arguments.
vi.mock('../../src/server/db/client.js', () => {
  const mockPrisma: any = {
    company: {
      findUnique: vi.fn(),
    },
    accountLedger: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    fiscalPeriod: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    journalEntry: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    journalLine: {
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => (typeof cb === 'function' ? cb(mockPrisma) : cb)),
  };
  return { prisma: mockPrisma };
});

interface InMemoryLedger {
  id: string;
  companyId: string;
  groupId: string;
  group: { id: string; name: string; rootType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE' };
  code: string;
  name: string;
  description: string | null;
  currency: string;
  isActive: boolean;
  openingBalance: Decimal;
  openingBalanceType: 'DEBIT' | 'CREDIT';
  createdAt: Date;
}

interface InMemoryJournalLine {
  id: string;
  journalId: string;
  companyId: string;
  ledgerId: string;
  lineNumber: number;
  debit: Decimal;
  credit: Decimal;
  description: string | null;
}

interface InMemoryJournal {
  id: string;
  companyId: string;
  voucherNumber: string;
  idempotencyKey: string | null;
  entryDate: Date;
  fiscalPeriodId: string | null;
  narration: string;
  reference: string | null;
  status: 'DRAFT' | 'POSTED' | 'REVERSED';
  totalDebit: Decimal;
  totalCredit: Decimal;
  postedAt: Date | null;
  postedByUserId: string | null;
  reversedAt: Date | null;
  reversedByUserId: string | null;
  reversalOfId: string | null;
  createdByUserId: string;
  createdAt: Date;
  lines: InMemoryJournalLine[];
}

describe('BUG-1 + ADD-1: Journal Reversal Reporting, Date Boundaries, and Company Timezones', () => {
  const companyAId = '11111111-1111-4111-8111-111111111111';
  const companyBId = '22222222-2222-4222-8222-222222222222';

  const actorA: AuthUser = {
    id: 'user-a-1',
    userId: 'user-a-1',
    companyId: companyAId,
    email: 'accountant@alpha.test',
    fullName: 'Alpha Accountant',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  let ledgers: InMemoryLedger[];
  let journals: InMemoryJournal[];
  let companyTimezones: Map<string, string>;
  let journalSeqCounter: number;

  const makeLedgers = (): InMemoryLedger[] => [
    {
      id: 'ldr-cash-a',
      companyId: companyAId,
      groupId: 'grp-cash',
      group: { id: 'grp-cash', name: 'Cash & Cash Equivalents', rootType: 'ASSET' },
      code: '1010',
      name: 'Cash on Hand',
      description: 'Main cash',
      currency: 'INR',
      isActive: true,
      openingBalance: new Decimal('0.0000'),
      openingBalanceType: 'DEBIT',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'ldr-bank-a',
      companyId: companyAId,
      groupId: 'grp-bank',
      group: { id: 'grp-bank', name: 'Bank Accounts', rootType: 'ASSET' },
      code: '1020',
      name: 'Operating Bank Account',
      description: 'Main bank',
      currency: 'INR',
      isActive: true,
      openingBalance: new Decimal('50000.0000'),
      openingBalanceType: 'DEBIT',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'ldr-equity-a',
      companyId: companyAId,
      groupId: 'grp-eq',
      group: { id: 'grp-eq', name: 'Share Capital', rootType: 'EQUITY' },
      code: '3010',
      name: 'Owner Equity',
      description: 'Capital',
      currency: 'INR',
      isActive: true,
      openingBalance: new Decimal('50000.0000'),
      openingBalanceType: 'CREDIT',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'ldr-rev-a',
      companyId: companyAId,
      groupId: 'grp-rev',
      group: { id: 'grp-rev', name: 'Operating Revenue', rootType: 'INCOME' },
      code: '4010',
      name: 'Service Revenue',
      description: 'Sales revenue',
      currency: 'INR',
      isActive: true,
      openingBalance: new Decimal('0.0000'),
      openingBalanceType: 'CREDIT',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'ldr-exp-a',
      companyId: companyAId,
      groupId: 'grp-exp',
      group: { id: 'grp-exp', name: 'Operating Expenses', rootType: 'EXPENSE' },
      code: '5010',
      name: 'Office Rent Expense',
      description: 'Rent',
      currency: 'INR',
      isActive: true,
      openingBalance: new Decimal('0.0000'),
      openingBalanceType: 'DEBIT',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'ldr-cash-b',
      companyId: companyBId,
      groupId: 'grp-cash-b',
      group: { id: 'grp-cash-b', name: 'Cash', rootType: 'ASSET' },
      code: '1010',
      name: 'Tenant B Cash',
      description: 'Cross-tenant cash',
      currency: 'USD',
      isActive: true,
      openingBalance: new Decimal('99999.0000'),
      openingBalanceType: 'DEBIT',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ];

  function matchesJournalWhere(journal: InMemoryJournal, jWhere: any): boolean {
    if (!jWhere) return true;
    if (jWhere.companyId && journal.companyId !== jWhere.companyId) return false;
    if (jWhere.status) {
      if (typeof jWhere.status === 'string') {
        if (journal.status !== jWhere.status) return false;
      } else if (Array.isArray(jWhere.status.in)) {
        if (!jWhere.status.in.includes(journal.status)) return false;
      }
    }
    if (jWhere.entryDate) {
      const t = journal.entryDate.getTime();
      if (jWhere.entryDate.lt && !(t < jWhere.entryDate.lt.getTime())) return false;
      if (jWhere.entryDate.lte && !(t <= jWhere.entryDate.lte.getTime())) return false;
      if (jWhere.entryDate.gte && !(t >= jWhere.entryDate.gte.getTime())) return false;
      if (jWhere.entryDate.gt && !(t > jWhere.entryDate.gt.getTime())) return false;
    }
    if (jWhere.voucherNumber?.startsWith && !journal.voucherNumber.startsWith(jWhere.voucherNumber.startsWith)) {
      return false;
    }
    return true;
  }

  function hydrateJournal(j: InMemoryJournal) {
    return {
      ...j,
      createdByUser: { fullName: actorA.fullName },
      postedByUser: j.postedByUserId ? { fullName: actorA.fullName } : null,
      reversedByUser: j.reversedByUserId ? { fullName: actorA.fullName } : null,
      lines: j.lines.map((l) => {
        const ldr = ledgers.find((x) => x.id === l.ledgerId)!;
        return {
          ...l,
          ledger: { id: ldr.id, code: ldr.code, name: ldr.name },
        };
      }),
    };
  }

  function addJournalDirect(params: {
    id: string;
    companyId?: string;
    voucherNumber: string;
    entryDate: Date;
    status: 'DRAFT' | 'POSTED' | 'REVERSED';
    narration?: string;
    reversalOfId?: string | null;
    lines: Array<{ ledgerId: string; debit: string; credit: string; description?: string }>;
  }): InMemoryJournal {
    const cid = params.companyId || companyAId;
    let td = new Decimal(0);
    let tc = new Decimal(0);
    const builtLines: InMemoryJournalLine[] = params.lines.map((l, idx) => {
      const d = new Decimal(l.debit);
      const c = new Decimal(l.credit);
      td = td.plus(d);
      tc = tc.plus(c);
      return {
        id: `${params.id}-line-${idx + 1}`,
        journalId: params.id,
        companyId: cid,
        ledgerId: l.ledgerId,
        lineNumber: idx + 1,
        debit: d,
        credit: c,
        description: l.description || null,
      };
    });
    const entry: InMemoryJournal = {
      id: params.id,
      companyId: cid,
      voucherNumber: params.voucherNumber,
      idempotencyKey: null,
      entryDate: params.entryDate,
      fiscalPeriodId: null,
      narration: params.narration || `Journal ${params.voucherNumber}`,
      reference: null,
      status: params.status,
      totalDebit: td,
      totalCredit: tc,
      postedAt: params.status !== 'DRAFT' ? params.entryDate : null,
      postedByUserId: params.status !== 'DRAFT' ? actorA.id : null,
      reversedAt: params.status === 'REVERSED' ? params.entryDate : null,
      reversedByUserId: params.status === 'REVERSED' ? actorA.id : null,
      reversalOfId: params.reversalOfId ?? null,
      createdByUserId: actorA.id,
      createdAt: params.entryDate,
      lines: builtLines,
    };
    journals.push(entry);
    return entry;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    ledgers = makeLedgers();
    journals = [];
    companyTimezones = new Map([
      [companyAId, 'UTC'],
      [companyBId, 'UTC'],
    ]);
    journalSeqCounter = 0;

    vi.spyOn(DocumentSequenceService, 'allocateNextNumber').mockImplementation(
      async (companyId, documentType, opts) => {
        journalSeqCounter += 1;
        const fy = String(opts?.fiscalYear ?? '2026');
        const seq = String(journalSeqCounter).padStart(5, '0');
        return {
          formattedNumber: `JV-${fy}-${seq}`,
          sequenceNumber: journalSeqCounter,
          prefix: 'JV',
          fiscalYear: fy,
          documentType,
          companyId,
          paddingZeros: 5,
        };
      }
    );

    (prisma.company.findUnique as any).mockImplementation(async ({ where }: any) => {
      const tz = companyTimezones.get(where.id);
      return tz ? { id: where.id, timezone: tz } : null;
    });

    (prisma.accountLedger.findMany as any).mockImplementation(async ({ where }: any) => {
      return ledgers.filter((l) => {
        if (where?.companyId && l.companyId !== where.companyId) return false;
        if (where?.id?.in && !where.id.in.includes(l.id)) return false;
        if (where?.group?.rootType && l.group.rootType !== where.group.rootType) return false;
        return true;
      });
    });

    (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => {
      return ledgers.find((l) => l.id === where.id) || null;
    });

    (prisma.fiscalPeriod.findFirst as any).mockResolvedValue(null);
    (prisma.fiscalPeriod.findUnique as any).mockResolvedValue(null);
    (prisma.auditLog.create as any).mockResolvedValue({});

    (prisma.journalEntry.count as any).mockImplementation(async ({ where }: any) => {
      return journals.filter((j) => matchesJournalWhere(j, where)).length;
    });

    (prisma.journalEntry.findUnique as any).mockImplementation(async ({ where }: any) => {
      const found = journals.find((j) => j.id === where.id);
      return found ? hydrateJournal(found) : null;
    });

    (prisma.journalEntry.findMany as any).mockImplementation(async ({ where }: any) => {
      return journals
        .filter((j) => matchesJournalWhere(j, where))
        .map((j) => hydrateJournal(j));
    });

    (prisma.journalEntry.create as any).mockImplementation(async ({ data }: any) => {
      const id = `jrn-${journals.length + 1}`;
      const createdLines: InMemoryJournalLine[] = (data.lines?.create || []).map(
        (l: any, idx: number) => ({
          id: `${id}-line-${idx + 1}`,
          journalId: id,
          companyId: l.companyId,
          ledgerId: l.ledgerId,
          lineNumber: l.lineNumber,
          debit: new Decimal(l.debit),
          credit: new Decimal(l.credit),
          description: l.description ?? null,
        })
      );
      const entry: InMemoryJournal = {
        id,
        companyId: data.companyId,
        voucherNumber: data.voucherNumber,
        idempotencyKey: data.idempotencyKey ?? null,
        entryDate: data.entryDate,
        fiscalPeriodId: data.fiscalPeriodId ?? null,
        narration: data.narration,
        reference: data.reference ?? null,
        status: data.status,
        totalDebit: new Decimal(data.totalDebit),
        totalCredit: new Decimal(data.totalCredit),
        postedAt: data.postedAt ?? null,
        postedByUserId: data.postedByUserId ?? null,
        reversedAt: data.reversedAt ?? null,
        reversedByUserId: data.reversedByUserId ?? null,
        reversalOfId: data.reversalOfId ?? null,
        createdByUserId: data.createdByUserId,
        createdAt: new Date(),
        lines: createdLines,
      };
      journals.push(entry);
      return hydrateJournal(entry);
    });

    (prisma.journalEntry.update as any).mockImplementation(async ({ where, data }: any) => {
      const idx = journals.findIndex((j) => j.id === where.id);
      if (idx === -1) throw new Error(`Journal ${where.id} not found`);
      journals[idx] = {
        ...journals[idx],
        ...data,
      };
      return hydrateJournal(journals[idx]);
    });

    (prisma.journalLine.findMany as any).mockImplementation(async ({ where }: any) => {
      const matched: any[] = [];
      for (const j of journals) {
        if (!matchesJournalWhere(j, where?.journal)) continue;
        const hydratedJ = hydrateJournal(j);
        for (const l of j.lines) {
          if (where?.companyId && l.companyId !== where.companyId) continue;
          if (where?.ledgerId && l.ledgerId !== where.ledgerId) continue;
          matched.push({
            ...l,
            journal: hydratedJ,
          });
        }
      }
      matched.sort((a, b) => {
        const dt = a.journal.entryDate.getTime() - b.journal.entryDate.getTime();
        if (dt !== 0) return dt;
        const vn = a.journal.voucherNumber.localeCompare(b.journal.voucherNumber);
        if (vn !== 0) return vn;
        return a.lineNumber - b.lineNumber;
      });
      return matched;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ============================================================================
  // 1. BUG-1 Accounting Invariants Across All 6 Reports (Scenarios A, B, C, D)
  // ============================================================================
  describe('BUG-1: Reversed Journal Accounting Invariants Across All 6 Reports', () => {
    it('Scenarios A–D: retains original before reversal, nets original + reversal to zero on/after reversal date, and excludes DRAFT', async () => {
      // Scenario A: Original POSTED journal on 2026-02-10: Dr Cash 10,000 / Cr Revenue 10,000
      const original = await JournalService.createJournal(actorA, {
        entryDate: '2026-02-10',
        narration: 'Cash consulting fee',
        autoPost: true,
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '10000.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '10000.0000' },
        ],
      });

      // Scenario C: DRAFT journal on 2026-02-11 that must ALWAYS remain excluded
      await JournalService.createJournal(actorA, {
        entryDate: '2026-02-11',
        narration: 'Unposted draft rent',
        autoPost: false,
        lines: [
          { ledgerId: 'ldr-exp-a', debit: '7777.0000', credit: '0.0000' },
          { ledgerId: 'ldr-cash-a', debit: '0.0000', credit: '7777.0000' },
        ],
      });

      // Cross-tenant posted journal that must never leak into companyA reports
      addJournalDirect({
        id: 'jrn-other-tenant',
        companyId: companyBId,
        voucherNumber: 'JV-2026-99999',
        entryDate: new Date('2026-02-10T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-b', debit: '88888.0000', credit: '0.0000' },
          { ledgerId: 'ldr-cash-b', debit: '0.0000', credit: '88888.0000' },
        ],
      });

      // Verify Scenario A (before reversal) across reports
      const tbBefore = await AccountingReportService.getTrialBalance(companyAId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-12',
      });
      expect(tbBefore.isBalanced).toBe(true);
      expect(tbBefore.rows.find((r) => r.ledgerId === 'ldr-cash-a')?.closingDebit).toBe('10000.0000');
      expect(tbBefore.rows.find((r) => r.ledgerId === 'ldr-rev-a')?.closingCredit).toBe('10000.0000');
      // Draft rent expense must NOT appear
      expect(tbBefore.rows.find((r) => r.ledgerId === 'ldr-exp-a')).toBeUndefined();

      const pnlBefore = await AccountingReportService.getProfitAndLoss(companyAId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-12',
      });
      expect(pnlBefore.totalIncome).toBe('10000.0000');
      expect(pnlBefore.netProfit).toBe('10000.0000');

      const bsBefore = await AccountingReportService.getBalanceSheet(companyAId, {
        asOfDate: '2026-02-12',
      });
      expect(bsBefore.isBalanced).toBe(true);
      expect(bsBefore.totalAssets).toBe('60000.0000'); // 50,000 Bank OB + 10,000 Cash
      expect(bsBefore.currentPeriodProfit).toBe('10000.0000');

      // Now execute reversal on 2026-02-15 at 14:30:00 UTC
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-15T14:30:00.000Z'));
      const reversed = await JournalService.reverseJournal(actorA, original.id, 'Duplicate booking');
      expect(reversed.original.status).toBe('REVERSED');
      expect(reversed.reversal.status).toBe('POSTED');
      expect(reversed.reversal.reversalOfId).toBe(original.id);
      expect(reversed.reversal.entryDate).toBe('2026-02-15');
      // Exact UTC audit timestamps preserved
      expect(reversed.reversal.postedAt).toBe('2026-02-15T14:30:00.000Z');
      expect(reversed.original.reversedAt).toBe('2026-02-15T14:30:00.000Z');

      // Scenario D (Historical report ending 2026-02-12 and 2026-02-14 — BEFORE reversal date):
      // Original (now REVERSED) MUST still be visible; reversal (2026-02-15) excluded.
      for (const histDate of ['2026-02-12', '2026-02-14']) {
        const ledgerStmtHist = await AccountingReportService.getLedgerStatement(
          companyAId,
          'ldr-cash-a',
          { fromDate: '2026-02-01', toDate: histDate }
        );
        expect(ledgerStmtHist.lines).toHaveLength(1);
        expect(ledgerStmtHist.closingBalance).toBe('10000.0000');
        expect(ledgerStmtHist.closingBalanceType).toBe('DEBIT');

        const tbHist = await AccountingReportService.getTrialBalance(companyAId, {
          fromDate: '2026-02-01',
          toDate: histDate,
        });
        expect(tbHist.isBalanced).toBe(true);
        expect(tbHist.rows.find((r) => r.ledgerId === 'ldr-cash-a')?.closingDebit).toBe('10000.0000');
        expect(tbHist.rows.find((r) => r.ledgerId === 'ldr-rev-a')?.closingCredit).toBe('10000.0000');

        const pnlHist = await AccountingReportService.getProfitAndLoss(companyAId, {
          fromDate: '2026-02-01',
          toDate: histDate,
        });
        expect(pnlHist.totalIncome).toBe('10000.0000');
        expect(pnlHist.netProfit).toBe('10000.0000');

        const bsHist = await AccountingReportService.getBalanceSheet(companyAId, {
          asOfDate: histDate,
        });
        expect(bsHist.isBalanced).toBe(true);
        expect(bsHist.totalAssets).toBe('60000.0000');
        expect(bsHist.currentPeriodProfit).toBe('10000.0000');

        const cashBookHist = await AccountingReportService.getCashBook(companyAId, {
          ledgerId: 'ldr-cash-a',
          fromDate: '2026-02-01',
          toDate: histDate,
        });
        expect(cashBookHist.lines).toHaveLength(1);
        expect(cashBookHist.closingBalance).toBe('10000.0000');
      }

      // Scenario B (Reports ending 2026-02-15 [same-day reversal] and 2026-02-16):
      // BOTH original (REVERSED) and reversal (POSTED) included; net effect is ZERO across all reports.
      for (const endDate of ['2026-02-15', '2026-02-16']) {
        const ledgerStmt = await AccountingReportService.getLedgerStatement(
          companyAId,
          'ldr-cash-a',
          { fromDate: '2026-02-01', toDate: endDate }
        );
        expect(ledgerStmt.lines).toHaveLength(2);
        expect(ledgerStmt.totalDebit).toBe('10000.0000');
        expect(ledgerStmt.totalCredit).toBe('10000.0000');
        expect(ledgerStmt.closingBalance).toBe('0.0000');

        const tb = await AccountingReportService.getTrialBalance(companyAId, {
          fromDate: '2026-02-01',
          toDate: endDate,
        });
        expect(tb.isBalanced).toBe(true);
        const cashRow = tb.rows.find((r) => r.ledgerId === 'ldr-cash-a')!;
        expect(cashRow.periodDebit).toBe('10000.0000');
        expect(cashRow.periodCredit).toBe('10000.0000');
        expect(cashRow.closingDebit).toBe('0.0000');
        expect(cashRow.closingCredit).toBe('0.0000');
        const revRow = tb.rows.find((r) => r.ledgerId === 'ldr-rev-a')!;
        expect(revRow.closingDebit).toBe('0.0000');
        expect(revRow.closingCredit).toBe('0.0000');
        // Draft still excluded
        expect(tb.rows.find((r) => r.ledgerId === 'ldr-exp-a')).toBeUndefined();

        const pnl = await AccountingReportService.getProfitAndLoss(companyAId, {
          fromDate: '2026-02-01',
          toDate: endDate,
        });
        expect(pnl.totalIncome).toBe('0.0000');
        expect(pnl.totalExpense).toBe('0.0000');
        expect(pnl.netProfit).toBe('0.0000');

        const bs = await AccountingReportService.getBalanceSheet(companyAId, {
          asOfDate: endDate,
        });
        expect(bs.isBalanced).toBe(true);
        expect(bs.totalAssets).toBe('50000.0000'); // Back to exact initial Bank OB
        expect(bs.currentPeriodProfit).toBe('0.0000');
        expect(bs.totalEquity).toBe('50000.0000');

        const cashBook = await AccountingReportService.getCashBook(companyAId, {
          ledgerId: 'ldr-cash-a',
          fromDate: '2026-02-01',
          toDate: endDate,
        });
        expect(cashBook.lines).toHaveLength(2);
        expect(cashBook.closingBalance).toBe('0.0000');
      }

      // Opening balance boundary: fromDate = 2026-02-13 (between original Feb 10 and reversal Feb 15)
      const splitLedger = await AccountingReportService.getLedgerStatement(
        companyAId,
        'ldr-cash-a',
        { fromDate: '2026-02-13', toDate: '2026-02-28' }
      );
      expect(splitLedger.openingBalance).toBe('10000.0000');
      expect(splitLedger.openingBalanceType).toBe('DEBIT');
      expect(splitLedger.lines).toHaveLength(1);
      expect(splitLedger.totalDebit).toBe('0.0000');
      expect(splitLedger.totalCredit).toBe('10000.0000');
      expect(splitLedger.closingBalance).toBe('0.0000');

      const splitCashBook = await AccountingReportService.getCashBook(companyAId, {
        ledgerId: 'ldr-cash-a',
        fromDate: '2026-02-13',
        toDate: '2026-02-28',
      });
      expect(splitCashBook.openingBalance).toBe('10000.0000');
      expect(splitCashBook.closingBalance).toBe('0.0000');
    });

    it('should also net Contra Entry reversals cleanly in both Cash Book and Bank Book', async () => {
      const contra = await ContraService.createContraEntry(actorA, {
        entryDate: '2026-02-10',
        sourceLedgerId: 'ldr-bank-a',
        destinationLedgerId: 'ldr-cash-a',
        amount: '8000.0000',
        autoPost: true,
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-15T10:00:00.000Z'));
      const reversed = await ContraService.reverseContraEntry(actorA, contra.id, 'Bank wire recalled');
      expect(reversed.original.status).toBe('REVERSED');
      expect(reversed.reversal.status).toBe('POSTED');

      // Before reversal (2026-02-12): Bank reduced to 42,000, Cash increased to 8,000
      const bankBefore = await AccountingReportService.getBankBook(companyAId, {
        ledgerId: 'ldr-bank-a',
        fromDate: '2026-02-01',
        toDate: '2026-02-12',
      });
      expect(bankBefore.closingBalance).toBe('42000.0000');

      // On reversal day (2026-02-15): Bank restored to 50,000, Cash restored to 0
      const bankAfter = await AccountingReportService.getBankBook(companyAId, {
        ledgerId: 'ldr-bank-a',
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });
      const cashAfter = await AccountingReportService.getCashBook(companyAId, {
        ledgerId: 'ldr-cash-a',
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });
      expect(bankAfter.closingBalance).toBe('50000.0000');
      expect(cashAfter.closingBalance).toBe('0.0000');
    });
  });

  // ============================================================================
  // 2. ADD-1: Strict YYYY-MM-DD Validation & Exclusive Next-Day Boundary
  // ============================================================================
  describe('ADD-1: Strict Calendar-Date Validation & Exclusive Next-Day Boundary', () => {
    it('computes exact UTC midnight start and exclusive next-day bounds across month, leap-day, and year boundaries', () => {
      const febNonLeap = parseCalendarDate('2026-02-28');
      expect(febNonLeap.year).toBe(2026);
      expect(febNonLeap.startOfDayUtc.toISOString()).toBe('2026-02-28T00:00:00.000Z');
      expect(febNonLeap.nextDayUtc.toISOString()).toBe('2026-03-01T00:00:00.000Z');

      const febLeap = parseCalendarDate('2024-02-29');
      expect(febLeap.startOfDayUtc.toISOString()).toBe('2024-02-29T00:00:00.000Z');
      expect(febLeap.nextDayUtc.toISOString()).toBe('2024-03-01T00:00:00.000Z');

      const yearEnd = parseCalendarDate('2026-12-31');
      expect(yearEnd.startOfDayUtc.toISOString()).toBe('2026-12-31T00:00:00.000Z');
      expect(yearEnd.nextDayUtc.toISOString()).toBe('2027-01-01T00:00:00.000Z');

      const janFirst = parseCalendarDate('2026-01-01');
      expect(janFirst.year).toBe(2026); // Never 2025 regardless of host OS timezone
    });

    it('rejects malformed dates, impossible calendar dates, timestamps with offsets, and inverted ranges with 400', async () => {
      const invalidInputs = [
        '2026-02-29', // non-leap year
        '2026-02-30',
        '2026-13-01',
        '2026-00-10',
        '2026-02-15T12:00:00Z',
        '2026-02-15T00:00:00+05:30',
        '2026/02/15',
        'not-a-date',
        '   ',
      ];

      for (const bad of invalidInputs) {
        let caught: any = null;
        try {
          parseCalendarDate(bad, 'toDate');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught.statusCode).toBe(400);
      }

      await expect(
        AccountingReportService.getTrialBalance(companyAId, {
          fromDate: '2026-02-20',
          toDate: '2026-02-10',
        })
      ).rejects.toMatchObject({ statusCode: 400 });

      await expect(
        AccountingReportService.getBalanceSheet(companyAId, {
          asOfDate: '2026-02-30',
        })
      ).rejects.toMatchObject({ statusCode: 400 });

      await expect(
        AccountingReportService.getLedgerStatement(companyAId, 'ldr-cash-a', {
          toDate: '2026-02-15T23:59:59Z',
        })
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(() =>
        parseReportDateRange({ fromDate: '2026-03-01', toDate: '2026-02-01' })
      ).toThrow();
    });

    it('includes same-day transactions with non-midnight JS timestamps when querying with date-only toDate', async () => {
      // Simulates a row whose JS Date carries a non-midnight time on 2026-02-15
      addJournalDirect({
        id: 'jrn-midday',
        voucherNumber: 'JV-2026-00010',
        entryDate: new Date('2026-02-15T18:45:12.345Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '2500.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '2500.0000' },
        ],
      });

      // Next-day entry on 2026-02-16 00:00:00.000Z MUST be excluded from toDate = 2026-02-15
      addJournalDirect({
        id: 'jrn-nextday',
        voucherNumber: 'JV-2026-00011',
        entryDate: new Date('2026-02-16T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '9000.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '9000.0000' },
        ],
      });

      const tb = await AccountingReportService.getTrialBalance(companyAId, {
        fromDate: '2026-02-15',
        toDate: '2026-02-15',
      });
      const cashRow = tb.rows.find((r) => r.ledgerId === 'ldr-cash-a')!;
      expect(cashRow.openingDebit).toBe('0.0000');
      expect(cashRow.periodDebit).toBe('2500.0000');
      expect(cashRow.closingDebit).toBe('2500.0000');

      const stmt = await AccountingReportService.getLedgerStatement(companyAId, 'ldr-cash-a', {
        fromDate: '2026-02-15',
        toDate: '2026-02-15',
      });
      expect(stmt.lines).toHaveLength(1);
      expect(stmt.lines[0].journalId).toBe('jrn-midday');
      expect(stmt.closingBalance).toBe('2500.0000');

      const cashBook = await AccountingReportService.getCashBook(companyAId, {
        ledgerId: 'ldr-cash-a',
        fromDate: '2026-02-15',
        toDate: '2026-02-15',
      });
      expect(cashBook.lines).toHaveLength(1);
      expect(cashBook.closingBalance).toBe('2500.0000');
    });

    it('uses calendar year from YYYY-MM-DD (never host-local getFullYear) for Jan 1 voucher numbering', async () => {
      const created = await JournalService.createJournal(actorA, {
        entryDate: '2026-01-01',
        narration: 'New Year opening voucher',
        autoPost: true,
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '100.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '100.0000' },
        ],
      });

      expect(created.voucherNumber).toMatch(/^JV-2026-/);
      expect(created.entryDate).toBe('2026-01-01');
    });

    it('ContraService.createContraEntry uses Jan 1 calendar year for CV-YYYY-XXXX numbering independent of host timezone', async () => {
      // Guard against any regression to host-local Date.prototype.getFullYear()
      const getFullYearSpy = vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2025);

      const firstContra = await ContraService.createContraEntry(actorA, {
        entryDate: '2026-01-01',
        sourceLedgerId: 'ldr-bank-a',
        destinationLedgerId: 'ldr-cash-a',
        amount: '1500.0000',
        autoPost: true,
      });

      const secondContra = await ContraService.createContraEntry(actorA, {
        entryDate: '2026-01-01',
        sourceLedgerId: 'ldr-cash-a',
        destinationLedgerId: 'ldr-bank-a',
        amount: '500.0000',
        autoPost: true,
      });

      expect(firstContra.voucherNumber).toBe('CV-2026-0001');
      expect(firstContra.entryDate).toBe('2026-01-01');
      expect(secondContra.voucherNumber).toBe('CV-2026-0002');
      expect(secondContra.entryDate).toBe('2026-01-01');
      expect(prisma.journalEntry.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            companyId: companyAId,
            voucherNumber: { startsWith: 'CV-2026-' },
          }),
        })
      );
      getFullYearSpy.mockRestore();
    });

    it('JournalService.listJournals enforces inclusive start, exclusive next-day end, tenant isolation, and 400 validation', async () => {
      // Day before start (excluded)
      addJournalDirect({
        id: 'jrn-before',
        voucherNumber: 'JV-2026-00001',
        entryDate: new Date('2026-02-09T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '100.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '100.0000' },
        ],
      });
      // Exact start date (included)
      addJournalDirect({
        id: 'jrn-start',
        voucherNumber: 'JV-2026-00002',
        entryDate: new Date('2026-02-10T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '200.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '200.0000' },
        ],
      });
      // End date with non-midnight timestamp (included via exclusive next-day lt)
      addJournalDirect({
        id: 'jrn-end-midday',
        voucherNumber: 'JV-2026-00003',
        entryDate: new Date('2026-02-15T19:45:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '300.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '300.0000' },
        ],
      });
      // Next day 00:00:00.000Z (excluded)
      addJournalDirect({
        id: 'jrn-after',
        voucherNumber: 'JV-2026-00004',
        entryDate: new Date('2026-02-16T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '400.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '400.0000' },
        ],
      });
      // Other tenant on exact matching date (excluded by companyId)
      addJournalDirect({
        id: 'jrn-tenant-b',
        companyId: companyBId,
        voucherNumber: 'JV-2026-00099',
        entryDate: new Date('2026-02-12T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-b', debit: '500.0000', credit: '0.0000' },
          { ledgerId: 'ldr-cash-b', debit: '0.0000', credit: '500.0000' },
        ],
      });

      const list = await JournalService.listJournals(companyAId, {
        fromDate: '2026-02-10',
        toDate: '2026-02-15',
      });

      expect(list.map((j) => j.id).sort()).toEqual(['jrn-end-midday', 'jrn-start']);
      expect(prisma.journalEntry.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            companyId: companyAId,
            entryDate: {
              gte: new Date('2026-02-10T00:00:00.000Z'),
              lt: new Date('2026-02-16T00:00:00.000Z'),
            },
          }),
        })
      );

      // Invalid date formats and inverted ranges must fail with HTTP 400 before hitting Prisma
      const callsBeforeErrors = vi.mocked(prisma.journalEntry.findMany).mock.calls.length;
      await expect(
        JournalService.listJournals(companyAId, { fromDate: '2026-02-29' })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        JournalService.listJournals(companyAId, { toDate: '2026-02-15T12:00:00Z' })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        JournalService.listJournals(companyAId, {
          fromDate: '2026-02-20',
          toDate: '2026-02-10',
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(vi.mocked(prisma.journalEntry.findMany).mock.calls.length).toBe(callsBeforeErrors);
    });

    it('ContraService.listContraEntries enforces inclusive start, exclusive next-day end, tenant isolation, and 400 validation', async () => {
      // Day before start (excluded)
      addJournalDirect({
        id: 'cv-before',
        voucherNumber: 'CV-2026-0001',
        entryDate: new Date('2026-02-09T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '1000.0000', credit: '0.0000' },
          { ledgerId: 'ldr-bank-a', debit: '0.0000', credit: '1000.0000' },
        ],
      });
      // Exact start date (included)
      addJournalDirect({
        id: 'cv-start',
        voucherNumber: 'CV-2026-0002',
        entryDate: new Date('2026-02-10T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '2000.0000', credit: '0.0000' },
          { ledgerId: 'ldr-bank-a', debit: '0.0000', credit: '2000.0000' },
        ],
      });
      // End date with non-midnight timestamp (included via exclusive next-day lt)
      addJournalDirect({
        id: 'cv-end-midday',
        voucherNumber: 'CV-2026-0003',
        entryDate: new Date('2026-02-15T22:15:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '3000.0000', credit: '0.0000' },
          { ledgerId: 'ldr-bank-a', debit: '0.0000', credit: '3000.0000' },
        ],
      });
      // Next day 00:00:00.000Z (excluded)
      addJournalDirect({
        id: 'cv-after',
        voucherNumber: 'CV-2026-0004',
        entryDate: new Date('2026-02-16T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '4000.0000', credit: '0.0000' },
          { ledgerId: 'ldr-bank-a', debit: '0.0000', credit: '4000.0000' },
        ],
      });
      // Regular JV in range (excluded because ContraService filters startsWith 'CV-')
      addJournalDirect({
        id: 'jv-not-contra',
        voucherNumber: 'JV-2026-00050',
        entryDate: new Date('2026-02-12T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '500.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '500.0000' },
        ],
      });
      // Other tenant contra entry in range (excluded by companyId)
      addJournalDirect({
        id: 'cv-tenant-b',
        companyId: companyBId,
        voucherNumber: 'CV-2026-0099',
        entryDate: new Date('2026-02-12T00:00:00.000Z'),
        status: 'POSTED',
        lines: [
          { ledgerId: 'ldr-cash-b', debit: '7000.0000', credit: '0.0000' },
          { ledgerId: 'ldr-cash-b', debit: '0.0000', credit: '7000.0000' },
        ],
      });

      const list = await ContraService.listContraEntries(companyAId, {
        fromDate: '2026-02-10',
        toDate: '2026-02-15',
      });

      expect(list.map((c) => c.id).sort()).toEqual(['cv-end-midday', 'cv-start']);
      expect(prisma.journalEntry.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            companyId: companyAId,
            voucherNumber: { startsWith: 'CV-' },
            entryDate: {
              gte: new Date('2026-02-10T00:00:00.000Z'),
              lt: new Date('2026-02-16T00:00:00.000Z'),
            },
          }),
        })
      );

      // Invalid date formats and inverted ranges must fail with HTTP 400 before hitting Prisma
      const callsBeforeErrors = vi.mocked(prisma.journalEntry.findMany).mock.calls.length;
      await expect(
        ContraService.listContraEntries(companyAId, { fromDate: '2026-02-30' })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        ContraService.listContraEntries(companyAId, { toDate: '2026-02-15T00:00:00+05:30' })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        ContraService.listContraEntries(companyAId, {
          fromDate: '2026-02-20',
          toDate: '2026-02-10',
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(vi.mocked(prisma.journalEntry.findMany).mock.calls.length).toBe(callsBeforeErrors);
    });

    it('accepts max safe calendar date 9999-12-30 and explicitly rejects 9999-12-31 (and year 0000) with 400 instead of overflowing RFC 3339 year 9999', async () => {
      const maxSafe = parseCalendarDate('9999-12-30', 'toDate');
      expect(maxSafe.startOfDayUtc.toISOString()).toBe('9999-12-30T00:00:00.000Z');
      expect(maxSafe.nextDayUtc.toISOString()).toBe('9999-12-31T00:00:00.000Z');

      for (const outOfRange of ['9999-12-31', '0000-01-01']) {
        let caught: any = null;
        try {
          parseCalendarDate(outOfRange, 'toDate');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught.statusCode).toBe(400);
        expect(caught.message).toContain('9999-12-30');
      }

      const tbCallsBefore = vi.mocked(prisma.journalLine.findMany).mock.calls.length;
      await expect(
        AccountingReportService.getTrialBalance(companyAId, { toDate: '9999-12-31' })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        JournalService.listJournals(companyAId, { toDate: '9999-12-31' })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        ContraService.listContraEntries(companyAId, { toDate: '9999-12-31' })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(vi.mocked(prisma.journalLine.findMany).mock.calls.length).toBe(tbCallsBefore);
    });
  });

  // ============================================================================
  // 3. ADD-1: Company Timezone Correctness for Reversals & Balance Sheet Default
  // ============================================================================
  describe('ADD-1: Company Timezone Correctness', () => {
    it('America/New_York evening reversal (UTC next day) books on company-local Feb 15 and nets in Feb 15 report', async () => {
      companyTimezones.set(companyAId, 'America/New_York');

      const original = await JournalService.createJournal(actorA, {
        entryDate: '2026-02-10',
        narration: 'NY invoice revenue',
        autoPost: true,
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '10000.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '10000.0000' },
        ],
      });

      // 2026-02-16T01:30:00.000Z UTC == 2026-02-15 20:30 EST in America/New_York
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-16T01:30:00.000Z'));

      const { reversal, original: updatedOrig } = await JournalService.reverseJournal(
        actorA,
        original.id,
        'Late evening NY reversal'
      );

      // Reversal calendar date MUST be 2026-02-15 (company local), NOT 2026-02-16 (UTC)
      expect(reversal.entryDate).toBe('2026-02-15');
      // Exact UTC audit timestamps preserved
      expect(reversal.postedAt).toBe('2026-02-16T01:30:00.000Z');
      expect(updatedOrig.reversedAt).toBe('2026-02-16T01:30:00.000Z');

      // Same-day report ending 2026-02-15 MUST include the reversal and net to 0
      const tbFeb15 = await AccountingReportService.getTrialBalance(companyAId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });
      expect(tbFeb15.rows.find((r) => r.ledgerId === 'ldr-cash-a')?.closingDebit).toBe('0.0000');
      expect(tbFeb15.isBalanced).toBe(true);
    });

    it('Asia/Kolkata early-morning reversal (UTC previous day) books on company-local Feb 15 and does NOT leak into Feb 14 report', async () => {
      companyTimezones.set(companyAId, 'Asia/Kolkata');

      const original = await JournalService.createJournal(actorA, {
        entryDate: '2026-02-10',
        narration: 'IST service revenue',
        autoPost: true,
        lines: [
          { ledgerId: 'ldr-cash-a', debit: '10000.0000', credit: '0.0000' },
          { ledgerId: 'ldr-rev-a', debit: '0.0000', credit: '10000.0000' },
        ],
      });

      // 2026-02-14T20:00:00.000Z UTC == 2026-02-15 01:30 IST in Asia/Kolkata
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-14T20:00:00.000Z'));

      const { reversal } = await JournalService.reverseJournal(
        actorA,
        original.id,
        'Early morning IST reversal'
      );

      // Reversal calendar date MUST be 2026-02-15 (IST), NOT 2026-02-14 (UTC)
      expect(reversal.entryDate).toBe('2026-02-15');
      expect(reversal.postedAt).toBe('2026-02-14T20:00:00.000Z');

      // Historical report ending 2026-02-14 MUST retain the unreversed +10,000 balance
      const tbFeb14 = await AccountingReportService.getTrialBalance(companyAId, {
        fromDate: '2026-02-01',
        toDate: '2026-02-14',
      });
      expect(tbFeb14.rows.find((r) => r.ledgerId === 'ldr-cash-a')?.closingDebit).toBe('10000.0000');

      // Default Balance Sheet asOfDate (omitted) MUST default to company-local 2026-02-15
      const defaultBs = await AccountingReportService.getBalanceSheet(companyAId);
      expect(defaultBs.asOfDate).toBe('2026-02-15');
      expect(defaultBs.totalAssets).toBe('50000.0000'); // Original + Feb 15 reversal netted to 0
      expect(defaultBs.isBalanced).toBe(true);
    });

    it('ContraService.reverseContraEntry respects Company.timezone across UTC midnight', async () => {
      companyTimezones.set(companyAId, 'America/Los_Angeles');

      const contra = await ContraService.createContraEntry(actorA, {
        entryDate: '2026-02-10',
        sourceLedgerId: 'ldr-bank-a',
        destinationLedgerId: 'ldr-cash-a',
        amount: '4000.0000',
        autoPost: true,
      });

      // 2026-02-16T03:00:00.000Z UTC == 2026-02-15 19:00 PST
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-16T03:00:00.000Z'));

      const { reversal } = await ContraService.reverseContraEntry(
        actorA,
        contra.id,
        'PST evening contra reversal'
      );

      expect(reversal.entryDate).toBe('2026-02-15');
      expect(reversal.postedAt).toBe('2026-02-16T03:00:00.000Z');

      const bankBookFeb15 = await AccountingReportService.getBankBook(companyAId, {
        ledgerId: 'ldr-bank-a',
        fromDate: '2026-02-01',
        toDate: '2026-02-15',
      });
      expect(bankBookFeb15.closingBalance).toBe('50000.0000');
    });
  });
});
