import { prisma } from '../db/client.js';
import {
  AuthUser,
  ContraEntryItem,
  CreateContraEntryRequest,
  ContraTransferType,
  JournalStatus,
} from '../../shared/types.js';
import { AccountingMath, Decimal } from '../accounting/decimal-math.js';
import { AuditService } from './audit.service.js';

export class ContraService {
  /**
   * Generates a sequential contra voucher number (e.g. CV-2026-0001) scoped to the company and year
   */
  static async generateVoucherNumber(companyId: string, year: number, tx?: any): Promise<string> {
    const client = tx || prisma;
    const prefix = `CV-${year}-`;
    const count = await client.journalEntry.count({
      where: {
        companyId,
        voucherNumber: { startsWith: prefix },
      },
    });

    const nextSeq = (count + 1).toString().padStart(4, '0');
    return `${prefix}${nextSeq}`;
  }

  /**
   * Helper to check whether an asset account is a cash or bank ledger
   */
  static classifyAccountType(ledgerName: string, groupName?: string): 'CASH' | 'BANK' | 'OTHER_ASSET' {
    const text = `${ledgerName} ${groupName || ''}`.toLowerCase();

    // Restricted asset types that can NEVER be used for Contra (Internal Transfer)
    if (
      /\b(receivable|debtor|inventory|stock|equipment|machinery|building|furniture|vehicle|asset\s*clearing|fixed\s*asset)\b/i.test(
        text
      )
    ) {
      return 'OTHER_ASSET';
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

    // Default to BANK if in liquid asset group, or allow as general cash/bank
    return 'BANK';
  }

  /**
   * Determines Contra Transfer Type from source and destination ledger classifications
   */
  static determineContraType(
    sourceType: 'CASH' | 'BANK' | 'OTHER_ASSET',
    destType: 'CASH' | 'BANK' | 'OTHER_ASSET'
  ): ContraTransferType {
    if (sourceType === 'CASH' && destType === 'BANK') return 'CASH_TO_BANK';
    if (sourceType === 'BANK' && destType === 'CASH') return 'BANK_TO_CASH';
    if (sourceType === 'BANK' && destType === 'BANK') return 'BANK_TO_BANK';
    if (sourceType === 'CASH' && destType === 'CASH') return 'CASH_TO_CASH';
    return 'INTERNAL_TRANSFER';
  }

  /**
   * Maps a database JournalEntry to ContraEntryItem
   */
  private static mapToContraItem(j: any): ContraEntryItem {
    // In a contra voucher:
    // Destination account is Debited (debit > 0)
    // Source account is Credited (credit > 0)
    const debitLine = j.lines.find((l: any) => AccountingMath.gt(AccountingMath.from(l.debit), 0));
    const creditLine = j.lines.find((l: any) => AccountingMath.gt(AccountingMath.from(l.credit), 0));

    const sourceLedgerId = creditLine ? creditLine.ledgerId : '';
    const sourceLedgerName = creditLine?.ledger?.name || 'Unknown Source';
    const sourceLedgerCode = creditLine?.ledger?.code || null;

    const destinationLedgerId = debitLine ? debitLine.ledgerId : '';
    const destinationLedgerName = debitLine?.ledger?.name || 'Unknown Destination';
    const destinationLedgerCode = debitLine?.ledger?.code || null;

    const sourceType = this.classifyAccountType(sourceLedgerName);
    const destType = this.classifyAccountType(destinationLedgerName);
    const contraType = this.determineContraType(sourceType, destType);

    const amount = debitLine
      ? AccountingMath.format(debitLine.debit)
      : AccountingMath.format(j.totalDebit);

    return {
      id: j.id,
      companyId: j.companyId,
      voucherNumber: j.voucherNumber,
      idempotencyKey: j.idempotencyKey,
      entryDate: j.entryDate.toISOString().split('T')[0],
      fiscalPeriodId: j.fiscalPeriodId,
      contraType,
      sourceLedgerId,
      sourceLedgerName,
      sourceLedgerCode,
      destinationLedgerId,
      destinationLedgerName,
      destinationLedgerCode,
      amount,
      reference: j.reference,
      narration: j.narration,
      status: j.status as JournalStatus,
      totalDebit: AccountingMath.format(j.totalDebit),
      totalCredit: AccountingMath.format(j.totalCredit),
      postedAt: j.postedAt ? j.postedAt.toISOString() : null,
      postedByUserName: j.postedByUser?.fullName || null,
      reversedAt: j.reversedAt ? j.reversedAt.toISOString() : null,
      reversedByUserName: j.reversedByUser?.fullName || null,
      reversalOfId: j.reversalOfId,
      createdByUserName: j.createdByUser?.fullName || null,
      createdAt: j.createdAt.toISOString(),
      lines: (j.lines || []).map((l: any) => ({
        id: l.id,
        ledgerId: l.ledgerId,
        ledgerCode: l.ledger?.code || null,
        ledgerName: l.ledger?.name || '',
        lineNumber: l.lineNumber,
        debit: AccountingMath.format(l.debit),
        credit: AccountingMath.format(l.credit),
        description: l.description,
      })),
    };
  }

  /**
   * Lists Contra Entries for the authenticated company
   */
  static async listContraEntries(
    companyId: string,
    filters?: {
      status?: JournalStatus;
      fromDate?: string;
      toDate?: string;
      search?: string;
    }
  ): Promise<ContraEntryItem[]> {
    const where: any = {
      companyId,
      voucherNumber: { startsWith: 'CV-' },
    };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.fromDate || filters?.toDate) {
      where.entryDate = {};
      if (filters.fromDate) where.entryDate.gte = new Date(filters.fromDate);
      if (filters.toDate) where.entryDate.lte = new Date(filters.toDate);
    }

    if (filters?.search && filters.search.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { voucherNumber: { contains: term, mode: 'insensitive' } },
        { narration: { contains: term, mode: 'insensitive' } },
        { reference: { contains: term, mode: 'insensitive' } },
      ];
    }

    const entries = await prisma.journalEntry.findMany({
      where,
      orderBy: [{ entryDate: 'desc' }, { voucherNumber: 'desc' }],
      include: {
        createdByUser: { select: { fullName: true } },
        postedByUser: { select: { fullName: true } },
        reversedByUser: { select: { fullName: true } },
        lines: {
          include: { ledger: { select: { code: true, name: true } } },
          orderBy: { lineNumber: 'asc' },
        },
      },
    });

    return entries.map((entry) => this.mapToContraItem(entry));
  }

  /**
   * Retrieves single Contra Entry by ID
   */
  static async getContraEntryById(companyId: string, id: string, tx?: any): Promise<ContraEntryItem> {
    const client = (tx || prisma) as typeof prisma;
    const j = await client.journalEntry.findUnique({
      where: { id },
      include: {
        createdByUser: { select: { fullName: true } },
        postedByUser: { select: { fullName: true } },
        reversedByUser: { select: { fullName: true } },
        lines: {
          include: { ledger: { select: { code: true, name: true } } },
          orderBy: { lineNumber: 'asc' },
        },
      },
    });

    if (!j || j.companyId !== companyId) {
      const err = new Error('Contra voucher not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!j.voucherNumber.startsWith('CV-')) {
      const err = new Error('The requested journal is not a contra entry voucher.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    return this.mapToContraItem(j);
  }

  /**
   * Creates a new Contra Entry (Draft or Auto-Posted)
   * Validates accounts, positive amount, different accounts, period status, and atomicity
   */
  static async createContraEntry(
    actor: AuthUser,
    input: CreateContraEntryRequest,
    correlationId?: string,
    txClient?: any
  ): Promise<ContraEntryItem> {
    const client = (txClient || prisma) as typeof prisma;

    // 1. Idempotency protection check
    if (input.idempotencyKey) {
      const existing = await client.journalEntry.findUnique({
        where: {
          companyId_idempotencyKey: {
            companyId: actor.companyId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: {
          createdByUser: { select: { fullName: true } },
          postedByUser: { select: { fullName: true } },
          reversedByUser: { select: { fullName: true } },
          lines: {
            include: { ledger: { select: { code: true, name: true } } },
            orderBy: { lineNumber: 'asc' },
          },
        },
      });

      if (existing) {
        return this.mapToContraItem(existing);
      }
    }

    // 2. Validate accounts are different
    if (!input.sourceLedgerId || !input.destinationLedgerId) {
      const err = new Error('Both source and destination accounts are required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (input.sourceLedgerId === input.destinationLedgerId) {
      const err = new Error('Source and destination accounts must be different for a contra transfer.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 3. Validate positive decimal amount
    const transferAmount = AccountingMath.from(input.amount || '0');
    if (!AccountingMath.gt(transferAmount, 0)) {
      const err = new Error('Transfer amount must be strictly greater than zero.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 4. Validate entry date
    const entryDate = new Date(input.entryDate);
    if (isNaN(entryDate.getTime())) {
      const err = new Error('Invalid entry date format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 5. Query and validate both ledgers belong to company, are active, and are ASSET ledgers
    const [sourceLedger, destLedger] = await Promise.all([
      client.accountLedger.findUnique({
        where: { id: input.sourceLedgerId },
        include: { group: true },
      }),
      client.accountLedger.findUnique({
        where: { id: input.destinationLedgerId },
        include: { group: true },
      }),
    ]);

    if (!sourceLedger || sourceLedger.companyId !== actor.companyId) {
      const err = new Error('Source account ledger not found in this company.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!destLedger || destLedger.companyId !== actor.companyId) {
      const err = new Error('Destination account ledger not found in this company.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!sourceLedger.isActive) {
      const err = new Error(
        `Source account "${sourceLedger.name}" is inactive. Inactive accounts cannot accept contra postings.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!destLedger.isActive) {
      const err = new Error(
        `Destination account "${destLedger.name}" is inactive. Inactive accounts cannot accept contra postings.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 6. Enforce rootType ASSET (Cash and Bank accounts only)
    if (sourceLedger.group.rootType !== 'ASSET') {
      const err = new Error(
        `Contra entries are restricted to liquid Asset accounts (Cash and Bank). "${sourceLedger.name}" is a ${sourceLedger.group.rootType} account.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (destLedger.group.rootType !== 'ASSET') {
      const err = new Error(
        `Contra entries are restricted to liquid Asset accounts (Cash and Bank). "${destLedger.name}" is a ${destLedger.group.rootType} account.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 7. Verify not a non-cash/bank asset (e.g. Accounts Receivable, Inventory, Fixed Assets)
    const sourceType = this.classifyAccountType(sourceLedger.name, sourceLedger.group.name);
    const destType = this.classifyAccountType(destLedger.name, destLedger.group.name);

    if (sourceType === 'OTHER_ASSET') {
      const err = new Error(
        `Source account "${sourceLedger.name}" is not an eligible Cash or Bank account for Contra transfers.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (destType === 'OTHER_ASSET') {
      const err = new Error(
        `Destination account "${destLedger.name}" is not an eligible Cash or Bank account for Contra transfers.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 8. Fiscal period validation (if linked or in date range)
    if (input.fiscalPeriodId) {
      const period = await client.fiscalPeriod.findUnique({
        where: { id: input.fiscalPeriodId },
      });

      if (!period || period.companyId !== actor.companyId) {
        const err = new Error('Linked fiscal period not found in this company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      if (period.status !== 'OPEN' || period.isLocked) {
        const err = new Error(
          `Cannot record contra entry in ${period.status.toLowerCase()} fiscal period "${period.periodName}".`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    } else {
      // Check if any existing period contains entryDate and is locked/closed
      const activePeriod = await client.fiscalPeriod.findFirst({
        where: {
          companyId: actor.companyId,
          startDate: { lte: entryDate },
          endDate: { gte: entryDate },
        },
      });

      if (activePeriod && (activePeriod.status !== 'OPEN' || activePeriod.isLocked)) {
        const err = new Error(
          `Cannot record contra entry in ${activePeriod.status.toLowerCase()} fiscal period "${activePeriod.periodName}".`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    const year = entryDate.getFullYear();
    const shouldAutoPost = Boolean(input.autoPost);
    const now = new Date();
    const amountStr = AccountingMath.format(transferAmount);

    // Compute default narration if not provided
    const contraType = this.determineContraType(sourceType, destType);
    const defaultNarration =
      input.narration?.trim() ||
      `Internal Contra Transfer (${contraType.replace(/_/g, ' ')}): ${sourceLedger.name} to ${destLedger.name}`;

    // 9. Atomic Double-Entry Transaction
    const executeTx = async (tx: any) => {
      const voucherNumber = await this.generateVoucherNumber(actor.companyId, year, tx);

      // Debit Destination Account (cash/bank receiving funds)
      // Credit Source Account (cash/bank releasing funds)
      const journal = await tx.journalEntry.create({
        data: {
          companyId: actor.companyId,
          voucherNumber,
          idempotencyKey: input.idempotencyKey || null,
          entryDate,
          fiscalPeriodId: input.fiscalPeriodId || null,
          narration: defaultNarration,
          reference: input.reference?.trim() || null,
          status: shouldAutoPost ? 'POSTED' : 'DRAFT',
          totalDebit: amountStr,
          totalCredit: amountStr,
          createdByUserId: actor.id,
          postedAt: shouldAutoPost ? now : null,
          postedByUserId: shouldAutoPost ? actor.id : null,
          lines: {
            create: [
              {
                companyId: actor.companyId,
                ledgerId: destLedger.id,
                lineNumber: 1,
                debit: amountStr,
                credit: '0.0000',
                description: `Contra Transfer To: ${destLedger.name}`,
              },
              {
                companyId: actor.companyId,
                ledgerId: sourceLedger.id,
                lineNumber: 2,
                debit: '0.0000',
                credit: amountStr,
                description: `Contra Transfer From: ${sourceLedger.name}`,
              },
            ],
          },
        },
        include: {
          createdByUser: { select: { fullName: true } },
          postedByUser: { select: { fullName: true } },
          reversedByUser: { select: { fullName: true } },
          lines: {
            include: { ledger: { select: { code: true, name: true } } },
            orderBy: { lineNumber: 'asc' },
          },
        },
      });

      return journal;
    };

    const createdJournal = txClient
      ? await executeTx(txClient)
      : await prisma.$transaction(executeTx);

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: shouldAutoPost ? 'CONTRA_VOUCHER_POSTED' : 'CONTRA_VOUCHER_DRAFT_CREATED',
      entity: 'JournalEntry',
      entityId: createdJournal.id,
      severity: 'INFO',
      correlationId,
      metadata: {
        voucherNumber: createdJournal.voucherNumber,
        amount: amountStr,
        sourceLedger: sourceLedger.name,
        destinationLedger: destLedger.name,
        status: createdJournal.status,
      },
    });

    return this.mapToContraItem(createdJournal);
  }

  /**
   * Posts an existing draft Contra Entry
   */
  static async postContraEntry(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<ContraEntryItem> {
    const journal = await prisma.journalEntry.findUnique({
      where: { id },
      include: {
        lines: {
          include: { ledger: { select: { code: true, name: true } } },
        },
      },
    });

    if (!journal || journal.companyId !== actor.companyId) {
      const err = new Error('Contra voucher not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!journal.voucherNumber.startsWith('CV-')) {
      const err = new Error('The specified voucher is not a contra entry.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (journal.status !== 'DRAFT') {
      const err = new Error(`Only draft contra entries can be posted. Current status: ${journal.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Verify balance
    if (!AccountingMath.equals(journal.totalDebit, journal.totalCredit)) {
      const err = new Error('Cannot post unbalanced contra entry.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check fiscal period
    if (journal.fiscalPeriodId) {
      const period = await prisma.fiscalPeriod.findUnique({
        where: { id: journal.fiscalPeriodId },
      });
      if (period && (period.status !== 'OPEN' || period.isLocked)) {
        const err = new Error(`Cannot post into ${period.status.toLowerCase()} fiscal period "${period.periodName}".`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    const updated = await prisma.journalEntry.update({
      where: { id },
      data: {
        status: 'POSTED',
        postedAt: new Date(),
        postedByUserId: actor.id,
      },
      include: {
        createdByUser: { select: { fullName: true } },
        postedByUser: { select: { fullName: true } },
        reversedByUser: { select: { fullName: true } },
        lines: {
          include: { ledger: { select: { code: true, name: true } } },
          orderBy: { lineNumber: 'asc' },
        },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'CONTRA_VOUCHER_POSTED',
      entity: 'JournalEntry',
      entityId: id,
      severity: 'INFO',
      correlationId,
      metadata: { voucherNumber: updated.voucherNumber },
    });

    return this.mapToContraItem(updated);
  }

  /**
   * Reverses a posted Contra Entry by generating an inverse contra entry and marking original as REVERSED
   */
  static async reverseContraEntry(
    actor: AuthUser,
    id: string,
    reason: string,
    correlationId?: string
  ): Promise<{ original: ContraEntryItem; reversal: ContraEntryItem }> {
    const original = await prisma.journalEntry.findUnique({
      where: { id },
      include: {
        lines: {
          include: { ledger: { select: { code: true, name: true } } },
          orderBy: { lineNumber: 'asc' },
        },
      },
    });

    if (!original || original.companyId !== actor.companyId) {
      const err = new Error('Contra voucher not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!original.voucherNumber.startsWith('CV-')) {
      const err = new Error('The specified voucher is not a contra entry.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (original.status !== 'POSTED') {
      const err = new Error(
        `Only posted contra entries can be reversed. Current status: ${original.status}.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const now = new Date();
    const year = now.getFullYear();

    const result = await prisma.$transaction(async (tx) => {
      // Generate reversal voucher number
      const reversalVoucherNumber = await this.generateVoucherNumber(actor.companyId, year, tx);

      // Invert lines: original debit becomes credit; original credit becomes debit
      const reversalLines = original.lines.map((line, idx) => ({
        companyId: actor.companyId,
        ledgerId: line.ledgerId,
        lineNumber: idx + 1,
        debit: line.credit.toString(),
        credit: line.debit.toString(),
        description: `Reversal of ${original.voucherNumber} line ${line.lineNumber}: ${line.description || ''}`,
      }));

      // Create reversing journal entry
      const reversalJournal = await tx.journalEntry.create({
        data: {
          companyId: actor.companyId,
          voucherNumber: reversalVoucherNumber,
          entryDate: now,
          fiscalPeriodId: original.fiscalPeriodId,
          narration: `Reversal of Contra Voucher ${original.voucherNumber}. Reason: ${reason}`,
          reference: `REV-${original.voucherNumber}`,
          status: 'POSTED',
          totalDebit: original.totalCredit.toString(),
          totalCredit: original.totalDebit.toString(),
          createdByUserId: actor.id,
          postedAt: now,
          postedByUserId: actor.id,
          reversalOfId: original.id,
          lines: {
            create: reversalLines,
          },
        },
        include: {
          createdByUser: { select: { fullName: true } },
          postedByUser: { select: { fullName: true } },
          reversedByUser: { select: { fullName: true } },
          lines: {
            include: { ledger: { select: { code: true, name: true } } },
            orderBy: { lineNumber: 'asc' },
          },
        },
      });

      // Mark original as REVERSED
      const updatedOriginal = await tx.journalEntry.update({
        where: { id: original.id },
        data: {
          status: 'REVERSED',
          reversedAt: now,
          reversedByUserId: actor.id,
        },
        include: {
          createdByUser: { select: { fullName: true } },
          postedByUser: { select: { fullName: true } },
          reversedByUser: { select: { fullName: true } },
          lines: {
            include: { ledger: { select: { code: true, name: true } } },
            orderBy: { lineNumber: 'asc' },
          },
        },
      });

      return {
        original: updatedOriginal,
        reversal: reversalJournal,
      };
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'CONTRA_VOUCHER_REVERSED',
      entity: 'JournalEntry',
      entityId: original.id,
      severity: 'WARN',
      correlationId,
      metadata: {
        originalVoucherNumber: original.voucherNumber,
        reversalVoucherNumber: result.reversal.voucherNumber,
        reason,
      },
    });

    return {
      original: this.mapToContraItem(result.original),
      reversal: this.mapToContraItem(result.reversal),
    };
  }
}
