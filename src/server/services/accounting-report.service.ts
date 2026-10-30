import { prisma } from '../db/client.js';
import {
  BalanceType,
  AccountRootType,
  TrialBalanceReport,
  TrialBalanceRow,
  LedgerStatementReport,
  LedgerStatementLine,
  ProfitAndLossReport,
  BalanceSheetReport,
  OpeningBalanceValidationResult,
  CashBankBookType,
  CashBankBookLine,
  CashBankBookEligibleLedger,
  CashBankBookReport,
  AccountLedgerItem,
} from '../../shared/types.js';
import { AccountingMath, Decimal } from '../accounting/decimal-math.js';

export class AccountingReportService {
  /**
   * Helper: evaluates whether an account root type has a normal debit balance
   * ASSET & EXPENSE -> Normal Debit
   * LIABILITY, EQUITY, INCOME -> Normal Credit
   */
  static isNormalDebit(rootType: AccountRootType): boolean {
    return rootType === 'ASSET' || rootType === 'EXPENSE';
  }

  /**
   * Validates if opening balances across all company ledgers balance
   * Phase 4 Section 4 Requirement
   */
  static async validateOpeningBalances(companyId: string): Promise<OpeningBalanceValidationResult> {
    const ledgers = await prisma.accountLedger.findMany({
      where: { companyId },
    });

    let sumDebit = new Decimal(0);
    let sumCredit = new Decimal(0);
    let count = 0;

    for (const l of ledgers) {
      const ob = AccountingMath.from(l.openingBalance);
      if (!AccountingMath.isZero(ob)) {
        count++;
        if (l.openingBalanceType === 'DEBIT') {
          sumDebit = sumDebit.plus(ob);
        } else {
          sumCredit = sumCredit.plus(ob);
        }
      }
    }

    const isBalanced = AccountingMath.equals(sumDebit, sumCredit);
    const discrepancy = AccountingMath.abs(sumDebit.minus(sumCredit));

    return {
      isBalanced,
      totalOpeningDebit: AccountingMath.format(sumDebit),
      totalOpeningCredit: AccountingMath.format(sumCredit),
      discrepancy: AccountingMath.format(discrepancy),
      unbalancedLedgersCount: count,
    };
  }

  /**
   * Generates Individual Ledger Statement with running balance
   * Phase 4 Section 5 Requirement
   */
  static async getLedgerStatement(
    companyId: string,
    ledgerId: string,
    options?: { fromDate?: string; toDate?: string }
  ): Promise<LedgerStatementReport> {
    const ledger = await prisma.accountLedger.findUnique({
      where: { id: ledgerId },
      include: { group: true },
    });

    if (!ledger || ledger.companyId !== companyId) {
      const err = new Error('Ledger not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const fromDate = options?.fromDate ? new Date(options.fromDate) : new Date('1970-01-01');
    const toDate = options?.toDate ? new Date(options.toDate) : new Date('2099-12-31');

    // 1. Fetch pre-period postings for historical balance prior to fromDate
    const preLines = await prisma.journalLine.findMany({
      where: {
        ledgerId,
        companyId,
        journal: {
          status: 'POSTED',
          entryDate: { lt: fromDate },
        },
      },
      select: { debit: true, credit: true },
    });

    let preDebit = new Decimal(0);
    let preCredit = new Decimal(0);
    for (const pl of preLines) {
      preDebit = preDebit.plus(AccountingMath.from(pl.debit));
      preCredit = preCredit.plus(AccountingMath.from(pl.credit));
    }

    // Include configured ledger opening balance
    const configuredOb = AccountingMath.from(ledger.openingBalance);
    let initialDebit = ledger.openingBalanceType === 'DEBIT' ? configuredOb : new Decimal(0);
    let initialCredit = ledger.openingBalanceType === 'CREDIT' ? configuredOb : new Decimal(0);

    initialDebit = initialDebit.plus(preDebit);
    initialCredit = initialCredit.plus(preCredit);

    // Compute net starting opening balance for the period
    const isDebitType = this.isNormalDebit(ledger.group.rootType);
    let startingBalance: Decimal;
    let startingBalanceType: BalanceType;

    if (isDebitType) {
      const net = initialDebit.minus(initialCredit);
      if (AccountingMath.gte(net, 0)) {
        startingBalance = net;
        startingBalanceType = 'DEBIT';
      } else {
        startingBalance = net.abs();
        startingBalanceType = 'CREDIT';
      }
    } else {
      const net = initialCredit.minus(initialDebit);
      if (AccountingMath.gte(net, 0)) {
        startingBalance = net;
        startingBalanceType = 'CREDIT';
      } else {
        startingBalance = net.abs();
        startingBalanceType = 'DEBIT';
      }
    }

    // 2. Fetch period journal postings
    const periodLines = await prisma.journalLine.findMany({
      where: {
        ledgerId,
        companyId,
        journal: {
          status: 'POSTED',
          entryDate: { gte: fromDate, lte: toDate },
        },
      },
      include: {
        journal: {
          select: {
            id: true,
            voucherNumber: true,
            entryDate: true,
            narration: true,
            reference: true,
          },
        },
      },
      orderBy: [
        { journal: { entryDate: 'asc' } },
        { journal: { voucherNumber: 'asc' } },
        { lineNumber: 'asc' },
      ],
    });

    // 3. Compute running balance line-by-line using exact decimal math
    let currentNetDebit = initialDebit;
    let currentNetCredit = initialCredit;
    let periodTotalDebit = new Decimal(0);
    let periodTotalCredit = new Decimal(0);

    const statementLines: LedgerStatementLine[] = [];

    for (const line of periodLines) {
      const debit = AccountingMath.from(line.debit);
      const credit = AccountingMath.from(line.credit);

      periodTotalDebit = periodTotalDebit.plus(debit);
      periodTotalCredit = periodTotalCredit.plus(credit);

      currentNetDebit = currentNetDebit.plus(debit);
      currentNetCredit = currentNetCredit.plus(credit);

      let runningBal: Decimal;
      let runningType: BalanceType;

      if (isDebitType) {
        const net = currentNetDebit.minus(currentNetCredit);
        if (AccountingMath.gte(net, 0)) {
          runningBal = net;
          runningType = 'DEBIT';
        } else {
          runningBal = net.abs();
          runningType = 'CREDIT';
        }
      } else {
        const net = currentNetCredit.minus(currentNetDebit);
        if (AccountingMath.gte(net, 0)) {
          runningBal = net;
          runningType = 'CREDIT';
        } else {
          runningBal = net.abs();
          runningType = 'DEBIT';
        }
      }

      statementLines.push({
        journalId: line.journal.id,
        voucherNumber: line.journal.voucherNumber,
        entryDate: line.journal.entryDate.toISOString().split('T')[0],
        narration: line.description || line.journal.narration,
        reference: line.journal.reference,
        debit: AccountingMath.format(debit),
        credit: AccountingMath.format(credit),
        runningBalance: AccountingMath.format(runningBal),
        runningBalanceType: runningType,
      });
    }

    // Final closing balance
    let closingBalance: Decimal;
    let closingBalanceType: BalanceType;

    if (isDebitType) {
      const net = currentNetDebit.minus(currentNetCredit);
      if (AccountingMath.gte(net, 0)) {
        closingBalance = net;
        closingBalanceType = 'DEBIT';
      } else {
        closingBalance = net.abs();
        closingBalanceType = 'CREDIT';
      }
    } else {
      const net = currentNetCredit.minus(currentNetDebit);
      if (AccountingMath.gte(net, 0)) {
        closingBalance = net;
        closingBalanceType = 'CREDIT';
      } else {
        closingBalance = net.abs();
        closingBalanceType = 'DEBIT';
      }
    }

    return {
      ledger: {
        id: ledger.id,
        companyId: ledger.companyId,
        groupId: ledger.groupId,
        groupName: ledger.group.name,
        rootType: ledger.group.rootType,
        code: ledger.code,
        name: ledger.name,
        description: ledger.description,
        currency: ledger.currency,
        isActive: ledger.isActive,
        openingBalance: AccountingMath.format(ledger.openingBalance),
        openingBalanceType: ledger.openingBalanceType,
        createdAt: ledger.createdAt.toISOString(),
      },
      fromDate: fromDate.toISOString().split('T')[0],
      toDate: toDate.toISOString().split('T')[0],
      openingBalance: AccountingMath.format(startingBalance),
      openingBalanceType: startingBalanceType,
      lines: statementLines,
      totalDebit: AccountingMath.format(periodTotalDebit),
      totalCredit: AccountingMath.format(periodTotalCredit),
      closingBalance: AccountingMath.format(closingBalance),
      closingBalanceType: closingBalanceType,
    };
  }

  /**
   * Generates Date-Filtered Trial Balance
   * Phase 4 Section 6 Requirement: Includes active & inactive ledgers with postings,
   * excludes drafts/reversed, explicit reconciliation status.
   */
  static async getTrialBalance(
    companyId: string,
    options?: { fromDate?: string; toDate?: string }
  ): Promise<TrialBalanceReport> {
    const fromDate = options?.fromDate ? new Date(options.fromDate) : new Date('1970-01-01');
    const toDate = options?.toDate ? new Date(options.toDate) : new Date('2099-12-31');

    // Fetch all ledgers (both active and inactive to ensure historical accuracy)
    const ledgers = await prisma.accountLedger.findMany({
      where: { companyId },
      include: { group: true },
      orderBy: [{ group: { rootType: 'asc' } }, { code: 'asc' }, { name: 'asc' }],
    });

    // Fetch all posted journal lines in company
    const lines = await prisma.journalLine.findMany({
      where: {
        companyId,
        journal: {
          status: 'POSTED',
          entryDate: { lte: toDate },
        },
      },
      include: {
        journal: { select: { entryDate: true } },
      },
    });

    // Bucket postings per ledger
    const ledgerPostings = new Map<
      string,
      { preDebit: Decimal; preCredit: Decimal; periodDebit: Decimal; periodCredit: Decimal }
    >();

    for (const l of ledgers) {
      ledgerPostings.set(l.id, {
        preDebit: new Decimal(0),
        preCredit: new Decimal(0),
        periodDebit: new Decimal(0),
        periodCredit: new Decimal(0),
      });
    }

    for (const pl of lines) {
      const entryDate = pl.journal.entryDate;
      const bucket = ledgerPostings.get(pl.ledgerId);
      if (!bucket) continue;

      const d = AccountingMath.from(pl.debit);
      const c = AccountingMath.from(pl.credit);

      if (entryDate < fromDate) {
        bucket.preDebit = bucket.preDebit.plus(d);
        bucket.preCredit = bucket.preCredit.plus(c);
      } else {
        bucket.periodDebit = bucket.periodDebit.plus(d);
        bucket.periodCredit = bucket.periodCredit.plus(c);
      }
    }

    let grandOpeningDebit = new Decimal(0);
    let grandOpeningCredit = new Decimal(0);
    let grandPeriodDebit = new Decimal(0);
    let grandPeriodCredit = new Decimal(0);
    let grandClosingDebit = new Decimal(0);
    let grandClosingCredit = new Decimal(0);

    const rows: TrialBalanceRow[] = [];

    for (const ledger of ledgers) {
      const bucket = ledgerPostings.get(ledger.id)!;
      const initialOb = AccountingMath.from(ledger.openingBalance);

      let opDebit = ledger.openingBalanceType === 'DEBIT' ? initialOb : new Decimal(0);
      let opCredit = ledger.openingBalanceType === 'CREDIT' ? initialOb : new Decimal(0);

      opDebit = opDebit.plus(bucket.preDebit);
      opCredit = opCredit.plus(bucket.preCredit);

      // Period postings
      const pDebit = bucket.periodDebit;
      const pCredit = bucket.periodCredit;

      // Net period closing
      const totalD = opDebit.plus(pDebit);
      const totalC = opCredit.plus(pCredit);

      let closeDebit = new Decimal(0);
      let closeCredit = new Decimal(0);

      if (this.isNormalDebit(ledger.group.rootType)) {
        const net = totalD.minus(totalC);
        if (AccountingMath.gte(net, 0)) {
          closeDebit = net;
        } else {
          closeCredit = net.abs();
        }
      } else {
        const net = totalC.minus(totalD);
        if (AccountingMath.gte(net, 0)) {
          closeCredit = net;
        } else {
          closeDebit = net.abs();
        }
      }

      // Skip ledgers with zero opening, zero period, and zero closing balances
      if (
        AccountingMath.isZero(opDebit) &&
        AccountingMath.isZero(opCredit) &&
        AccountingMath.isZero(pDebit) &&
        AccountingMath.isZero(pCredit) &&
        AccountingMath.isZero(closeDebit) &&
        AccountingMath.isZero(closeCredit)
      ) {
        continue;
      }

      grandOpeningDebit = grandOpeningDebit.plus(opDebit);
      grandOpeningCredit = grandOpeningCredit.plus(opCredit);
      grandPeriodDebit = grandPeriodDebit.plus(pDebit);
      grandPeriodCredit = grandPeriodCredit.plus(pCredit);
      grandClosingDebit = grandClosingDebit.plus(closeDebit);
      grandClosingCredit = grandClosingCredit.plus(closeCredit);

      rows.push({
        ledgerId: ledger.id,
        code: ledger.code || '',
        name: ledger.name,
        rootType: ledger.group.rootType,
        groupName: ledger.group.name,
        openingDebit: AccountingMath.format(opDebit),
        openingCredit: AccountingMath.format(opCredit),
        periodDebit: AccountingMath.format(pDebit),
        periodCredit: AccountingMath.format(pCredit),
        closingDebit: AccountingMath.format(closeDebit),
        closingCredit: AccountingMath.format(closeCredit),
      });
    }

    const isBalanced =
      AccountingMath.equals(grandPeriodDebit, grandPeriodCredit) &&
      AccountingMath.equals(grandClosingDebit, grandClosingCredit);

    const imbalanceAmount = AccountingMath.abs(grandClosingDebit.minus(grandClosingCredit));

    return {
      companyId,
      fromDate: fromDate.toISOString().split('T')[0],
      toDate: toDate.toISOString().split('T')[0],
      rows,
      totalOpeningDebit: AccountingMath.format(grandOpeningDebit),
      totalOpeningCredit: AccountingMath.format(grandOpeningCredit),
      totalPeriodDebit: AccountingMath.format(grandPeriodDebit),
      totalPeriodCredit: AccountingMath.format(grandPeriodCredit),
      totalClosingDebit: AccountingMath.format(grandClosingDebit),
      totalClosingCredit: AccountingMath.format(grandClosingCredit),
      isBalanced,
      reconciliationStatus: isBalanced ? 'BALANCED' : 'DISCREPANCY',
      imbalanceAmount: AccountingMath.format(imbalanceAmount),
    };
  }

  /**
   * Generates Profit & Loss Statement (Income - Expenses = Net Profit)
   * Phase 4 Section 7 Requirement
   */
  static async getProfitAndLoss(
    companyId: string,
    options?: { fromDate?: string; toDate?: string }
  ): Promise<ProfitAndLossReport> {
    const tb = await this.getTrialBalance(companyId, options);

    const incomeMap = new Map<string, { ledgers: Array<{ name: string; code?: string | null; amount: string }>; subtotal: Decimal }>();
    const expenseMap = new Map<string, { ledgers: Array<{ name: string; code?: string | null; amount: string }>; subtotal: Decimal }>();

    let totalIncome = new Decimal(0);
    let totalExpense = new Decimal(0);

    for (const row of tb.rows) {
      if (row.rootType === 'INCOME') {
        const netIncome = AccountingMath.from(row.closingCredit).minus(AccountingMath.from(row.closingDebit));
        if (!incomeMap.has(row.groupName)) {
          incomeMap.set(row.groupName, { ledgers: [], subtotal: new Decimal(0) });
        }
        const group = incomeMap.get(row.groupName)!;
        group.ledgers.push({ name: row.name, code: row.code, amount: AccountingMath.format(netIncome) });
        group.subtotal = group.subtotal.plus(netIncome);
        totalIncome = totalIncome.plus(netIncome);
      } else if (row.rootType === 'EXPENSE') {
        const netExpense = AccountingMath.from(row.closingDebit).minus(AccountingMath.from(row.closingCredit));
        if (!expenseMap.has(row.groupName)) {
          expenseMap.set(row.groupName, { ledgers: [], subtotal: new Decimal(0) });
        }
        const group = expenseMap.get(row.groupName)!;
        group.ledgers.push({ name: row.name, code: row.code, amount: AccountingMath.format(netExpense) });
        group.subtotal = group.subtotal.plus(netExpense);
        totalExpense = totalExpense.plus(netExpense);
      }
    }

    const netProfit = totalIncome.minus(totalExpense);

    return {
      companyId,
      fromDate: tb.fromDate,
      toDate: tb.toDate,
      incomeGroups: Array.from(incomeMap.entries()).map(([name, data]) => ({
        groupName: name,
        ledgers: data.ledgers,
        subtotal: AccountingMath.format(data.subtotal),
      })),
      totalIncome: AccountingMath.format(totalIncome),
      expenseGroups: Array.from(expenseMap.entries()).map(([name, data]) => ({
        groupName: name,
        ledgers: data.ledgers,
        subtotal: AccountingMath.format(data.subtotal),
      })),
      totalExpense: AccountingMath.format(totalExpense),
      netProfit: AccountingMath.format(netProfit),
      isProfitable: AccountingMath.gte(netProfit, 0),
    };
  }

  /**
   * Generates Balance Sheet: Assets = Liabilities + Equity (including Net Income)
   * Phase 4 Section 7 Requirement
   */
  static async getBalanceSheet(
    companyId: string,
    options?: { asOfDate?: string }
  ): Promise<BalanceSheetReport> {
    const toDate = options?.asOfDate || new Date().toISOString().split('T')[0];
    const tb = await this.getTrialBalance(companyId, { toDate });
    const pnl = await this.getProfitAndLoss(companyId, { toDate });

    const assetMap = new Map<string, { ledgers: Array<{ name: string; code?: string | null; amount: string }>; subtotal: Decimal }>();
    const liabilityMap = new Map<string, { ledgers: Array<{ name: string; code?: string | null; amount: string }>; subtotal: Decimal }>();
    const equityMap = new Map<string, { ledgers: Array<{ name: string; code?: string | null; amount: string }>; subtotal: Decimal }>();

    let totalAssets = new Decimal(0);
    let totalLiabilities = new Decimal(0);
    let totalEquity = new Decimal(0);

    for (const row of tb.rows) {
      if (row.rootType === 'ASSET') {
        const netAsset = AccountingMath.from(row.closingDebit).minus(AccountingMath.from(row.closingCredit));
        if (!assetMap.has(row.groupName)) assetMap.set(row.groupName, { ledgers: [], subtotal: new Decimal(0) });
        const g = assetMap.get(row.groupName)!;
        g.ledgers.push({ name: row.name, code: row.code, amount: AccountingMath.format(netAsset) });
        g.subtotal = g.subtotal.plus(netAsset);
        totalAssets = totalAssets.plus(netAsset);
      } else if (row.rootType === 'LIABILITY') {
        const netLiab = AccountingMath.from(row.closingCredit).minus(AccountingMath.from(row.closingDebit));
        if (!liabilityMap.has(row.groupName)) liabilityMap.set(row.groupName, { ledgers: [], subtotal: new Decimal(0) });
        const g = liabilityMap.get(row.groupName)!;
        g.ledgers.push({ name: row.name, code: row.code, amount: AccountingMath.format(netLiab) });
        g.subtotal = g.subtotal.plus(netLiab);
        totalLiabilities = totalLiabilities.plus(netLiab);
      } else if (row.rootType === 'EQUITY') {
        const netEq = AccountingMath.from(row.closingCredit).minus(AccountingMath.from(row.closingDebit));
        if (!equityMap.has(row.groupName)) equityMap.set(row.groupName, { ledgers: [], subtotal: new Decimal(0) });
        const g = equityMap.get(row.groupName)!;
        g.ledgers.push({ name: row.name, code: row.code, amount: AccountingMath.format(netEq) });
        g.subtotal = g.subtotal.plus(netEq);
        totalEquity = totalEquity.plus(netEq);
      }
    }

    // Add current period profit/loss into equity
    const currentPeriodProfit = AccountingMath.from(pnl.netProfit);
    const totalEquityWithProfit = totalEquity.plus(currentPeriodProfit);
    const totalLiabAndEquity = totalLiabilities.plus(totalEquityWithProfit);

    const isBalanced = AccountingMath.equals(totalAssets, totalLiabAndEquity);
    const discrepancy = AccountingMath.abs(totalAssets.minus(totalLiabAndEquity));

    return {
      companyId,
      asOfDate: toDate,
      assetGroups: Array.from(assetMap.entries()).map(([name, data]) => ({
        groupName: name,
        ledgers: data.ledgers,
        subtotal: AccountingMath.format(data.subtotal),
      })),
      totalAssets: AccountingMath.format(totalAssets),
      liabilityGroups: Array.from(liabilityMap.entries()).map(([name, data]) => ({
        groupName: name,
        ledgers: data.ledgers,
        subtotal: AccountingMath.format(data.subtotal),
      })),
      totalLiabilities: AccountingMath.format(totalLiabilities),
      equityGroups: Array.from(equityMap.entries()).map(([name, data]) => ({
        groupName: name,
        ledgers: data.ledgers,
        subtotal: AccountingMath.format(data.subtotal),
      })),
      currentPeriodProfit: AccountingMath.format(currentPeriodProfit),
      totalEquity: AccountingMath.format(totalEquityWithProfit),
      totalLiabilitiesAndEquity: AccountingMath.format(totalLiabAndEquity),
      isBalanced,
      discrepancy: AccountingMath.format(discrepancy),
    };
  }

  /**
   * Helper to classify asset ledger as CASH or BANK
   */
  static classifyCashOrBankLedger(
    ledgerName: string,
    groupName?: string
  ): 'CASH' | 'BANK' | 'OTHER' {
    const text = `${ledgerName} ${groupName || ''}`.toLowerCase();

    // Restricted asset types that can NEVER be cash or bank book accounts
    if (
      /\b(receivable|debtor|inventory|stock|equipment|machinery|building|furniture|vehicle|asset\s*clearing|fixed\s*asset|payable|creditor)\b/i.test(
        text
      )
    ) {
      return 'OTHER';
    }

    if (/\b(cash|vault|till|drawer|petty)\b/i.test(text)) {
      return 'CASH';
    }

    if (
      /\b(bank|checking|savings|deposit|current account|treasury|wire|jpmorgan|chase|bofa|citi|wells|barclays|hsbc|svb)\b/i.test(
        text
      )
    ) {
      return 'BANK';
    }

    return 'OTHER';
  }

  /**
   * Generates Cash Book or Bank Book Report
   * Features:
   * - Tenant isolation
   * - Opening balance calculated from configured opening balance + transactions before fromDate
   * - Excludes drafts and reversed entries from effective balances (status: POSTED)
   * - Includes posted journals and posted Contra Entries (CV-YYYY-XXXX) exactly once
   * - Counterparty account identification
   * - Exact Decimal arithmetic for running balances
   */
  static async getCashOrBankBook(
    companyId: string,
    bookType: CashBankBookType,
    options?: { ledgerId?: string; fromDate?: string; toDate?: string }
  ): Promise<CashBankBookReport> {
    const fromDate = options?.fromDate ? new Date(options.fromDate) : new Date('1970-01-01');
    const toDate = options?.toDate ? new Date(options.toDate) : new Date('2099-12-31');

    // 1. Fetch all asset ledgers in this company
    const assetLedgers = await prisma.accountLedger.findMany({
      where: {
        companyId,
        group: { rootType: 'ASSET' },
      },
      include: { group: true },
      orderBy: [{ code: 'asc' }, { name: 'asc' }],
    });

    const eligibleLedgers: CashBankBookEligibleLedger[] = [];
    for (const l of assetLedgers) {
      const cat = this.classifyCashOrBankLedger(l.name, l.group.name);
      if (cat !== 'OTHER') {
        eligibleLedgers.push({
          id: l.id,
          name: l.name,
          code: l.code ?? null,
          currency: l.currency,
          category: cat,
          currentBalance: AccountingMath.format(l.openingBalance),
          currentBalanceType: l.openingBalanceType as BalanceType,
        });
      }
    }

    // 2. Select target ledger
    let targetLedger: (typeof assetLedgers)[0] | null = null;

    if (options?.ledgerId) {
      const requested = await prisma.accountLedger.findUnique({
        where: { id: options.ledgerId },
        include: { group: true },
      });

      if (!requested || requested.companyId !== companyId) {
        const err = new Error('Ledger not found in this company.');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }

      if (requested.group.rootType !== 'ASSET') {
        const err = new Error('Selected ledger must be an asset account.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      targetLedger = requested;
    } else {
      // Find the first eligible ledger matching bookType
      const match = assetLedgers.find((l) => {
        const cat = this.classifyCashOrBankLedger(l.name, l.group.name);
        return cat === bookType;
      });

      if (match) {
        targetLedger = match;
      } else if (eligibleLedgers.length > 0) {
        // Fallback to first eligible
        targetLedger = assetLedgers.find((l) => l.id === eligibleLedgers[0].id) || null;
      } else if (assetLedgers.length > 0) {
        targetLedger = assetLedgers[0];
      }
    }

    if (!targetLedger) {
      return {
        companyId,
        bookType,
        ledger: null,
        eligibleLedgers,
        fromDate: options?.fromDate || '1970-01-01',
        toDate: options?.toDate || '2099-12-31',
        openingBalance: '0.0000',
        openingBalanceType: 'DEBIT',
        lines: [],
        totalDebit: '0.0000',
        totalCredit: '0.0000',
        closingBalance: '0.0000',
        closingBalanceType: 'DEBIT',
      };
    }

    // 3. Pre-period calculations (transactions before fromDate)
    const preLines = await prisma.journalLine.findMany({
      where: {
        ledgerId: targetLedger.id,
        companyId,
        journal: {
          status: 'POSTED',
          entryDate: { lt: fromDate },
        },
      },
      select: { debit: true, credit: true },
    });

    let preDebit = new Decimal(0);
    let preCredit = new Decimal(0);
    for (const pl of preLines) {
      preDebit = preDebit.plus(AccountingMath.from(pl.debit));
      preCredit = preCredit.plus(AccountingMath.from(pl.credit));
    }

    const configuredOb = AccountingMath.from(targetLedger.openingBalance);
    let initialDebit = targetLedger.openingBalanceType === 'DEBIT' ? configuredOb : new Decimal(0);
    let initialCredit = targetLedger.openingBalanceType === 'CREDIT' ? configuredOb : new Decimal(0);

    initialDebit = initialDebit.plus(preDebit);
    initialCredit = initialCredit.plus(preCredit);

    let startingBalance: Decimal;
    let startingBalanceType: BalanceType;
    const netStart = initialDebit.minus(initialCredit);
    if (AccountingMath.gte(netStart, 0)) {
      startingBalance = netStart;
      startingBalanceType = 'DEBIT';
    } else {
      startingBalance = netStart.abs();
      startingBalanceType = 'CREDIT';
    }

    // 4. Fetch period journal postings
    // Explicitly filters journal: { status: 'POSTED' }, excluding DRAFT and REVERSED entries
    const periodLines = await prisma.journalLine.findMany({
      where: {
        ledgerId: targetLedger.id,
        companyId,
        journal: {
          status: 'POSTED',
          entryDate: { gte: fromDate, lte: toDate },
        },
      },
      include: {
        journal: {
          include: {
            lines: {
              include: {
                ledger: {
                  select: { id: true, code: true, name: true },
                },
              },
              orderBy: { lineNumber: 'asc' },
            },
          },
        },
      },
      orderBy: [
        { journal: { entryDate: 'asc' } },
        { journal: { voucherNumber: 'asc' } },
        { lineNumber: 'asc' },
      ],
    });

    // 5. Line-by-line running balance and counterparty resolution
    let currentNetDebit = initialDebit;
    let currentNetCredit = initialCredit;
    let periodTotalDebit = new Decimal(0);
    let periodTotalCredit = new Decimal(0);

    const lines: CashBankBookLine[] = [];

    for (const line of periodLines) {
      const debit = AccountingMath.from(line.debit);
      const credit = AccountingMath.from(line.credit);

      periodTotalDebit = periodTotalDebit.plus(debit);
      periodTotalCredit = periodTotalCredit.plus(credit);

      currentNetDebit = currentNetDebit.plus(debit);
      currentNetCredit = currentNetCredit.plus(credit);

      const net = currentNetDebit.minus(currentNetCredit);
      let runningBal: Decimal;
      let runningType: BalanceType;
      if (AccountingMath.gte(net, 0)) {
        runningBal = net;
        runningType = 'DEBIT';
      } else {
        runningBal = net.abs();
        runningType = 'CREDIT';
      }

      // Resolve counterparty account(s)
      const opposingLines = line.journal.lines.filter((l) => l.ledgerId !== targetLedger!.id);
      let counterpartyAccount = '';
      let counterpartyLedgerId: string | null = null;

      if (opposingLines.length === 1) {
        counterpartyAccount = opposingLines[0].ledger?.name || 'Opposing Ledger';
        counterpartyLedgerId = opposingLines[0].ledgerId;
      } else if (opposingLines.length > 1) {
        const names = opposingLines.map((l) => l.ledger?.name).filter(Boolean);
        counterpartyAccount = names.join(', ');
      } else {
        counterpartyAccount = line.description || line.journal.narration || targetLedger.name;
      }

      lines.push({
        id: line.id,
        journalId: line.journal.id,
        voucherNumber: line.journal.voucherNumber,
        entryDate: line.journal.entryDate.toISOString().split('T')[0],
        reference: line.journal.reference,
        narration: line.description || line.journal.narration,
        counterpartyAccount,
        counterpartyLedgerId,
        debit: AccountingMath.format(debit),
        credit: AccountingMath.format(credit),
        runningBalance: AccountingMath.format(runningBal),
        runningBalanceType: runningType,
      });
    }

    // 6. Net closing balance
    const finalNet = currentNetDebit.minus(currentNetCredit);
    let closingBal: Decimal;
    let closingType: BalanceType;
    if (AccountingMath.gte(finalNet, 0)) {
      closingBal = finalNet;
      closingType = 'DEBIT';
    } else {
      closingBal = finalNet.abs();
      closingType = 'CREDIT';
    }

    const ledgerItem: AccountLedgerItem = {
      id: targetLedger.id,
      companyId: targetLedger.companyId,
      groupId: targetLedger.groupId,
      groupName: targetLedger.group.name,
      rootType: targetLedger.group.rootType,
      code: targetLedger.code,
      name: targetLedger.name,
      description: targetLedger.description,
      currency: targetLedger.currency,
      isActive: targetLedger.isActive,
      openingBalance: AccountingMath.format(targetLedger.openingBalance),
      openingBalanceType: targetLedger.openingBalanceType,
      createdAt: targetLedger.createdAt.toISOString(),
    };

    return {
      companyId,
      bookType,
      ledger: ledgerItem,
      eligibleLedgers,
      fromDate: fromDate.toISOString().split('T')[0],
      toDate: toDate.toISOString().split('T')[0],
      openingBalance: AccountingMath.format(startingBalance),
      openingBalanceType: startingBalanceType,
      lines,
      totalDebit: AccountingMath.format(periodTotalDebit),
      totalCredit: AccountingMath.format(periodTotalCredit),
      closingBalance: AccountingMath.format(closingBal),
      closingBalanceType: closingType,
    };
  }

  static async getCashBook(
    companyId: string,
    options?: { ledgerId?: string; fromDate?: string; toDate?: string }
  ): Promise<CashBankBookReport> {
    return this.getCashOrBankBook(companyId, 'CASH', options);
  }

  static async getBankBook(
    companyId: string,
    options?: { ledgerId?: string; fromDate?: string; toDate?: string }
  ): Promise<CashBankBookReport> {
    return this.getCashOrBankBook(companyId, 'BANK', options);
  }
}
