import { prisma } from '../db/client.js';
import {
  AuthUser,
  JournalStatus,
  JournalEntryItem,
  CreateJournalEntryRequest,
} from '../../shared/types.js';
import { AccountingMath, Decimal } from '../accounting/decimal-math.js';
import { AuditService } from './audit.service.js';
import { DocumentSequenceService } from './document-sequence.service.js';

export class JournalService {
  /**
   * Generates a sequential voucher number (e.g., JV-2026-00001) scoped to the company using DocumentSequenceService
   */
  private static async generateVoucherNumber(companyId: string, year: number, tx?: any): Promise<string> {
    const seq = await DocumentSequenceService.allocateNextNumber(companyId, 'JOURNAL_VOUCHER', {
      fiscalYear: year,
      tx,
    });
    return seq.formattedNumber;
  }

  /**
   * Lists journal entries for the company with filtering
   */
  static async listJournals(
    companyId: string,
    filters?: {
      status?: JournalStatus;
      fromDate?: string;
      toDate?: string;
      ledgerId?: string;
      search?: string;
    }
  ): Promise<JournalEntryItem[]> {
    const where: {
      companyId: string;
      status?: JournalStatus;
      entryDate?: { gte?: Date; lte?: Date };
      lines?: { some: { ledgerId: string } };
      OR?: Array<{ voucherNumber?: { contains: string; mode: 'insensitive' }; narration?: { contains: string; mode: 'insensitive' } }>;
    } = { companyId };

    if (filters?.status) where.status = filters.status;

    if (filters?.fromDate || filters?.toDate) {
      where.entryDate = {};
      if (filters.fromDate) where.entryDate.gte = new Date(filters.fromDate);
      if (filters.toDate) where.entryDate.lte = new Date(filters.toDate);
    }

    if (filters?.ledgerId) {
      where.lines = { some: { ledgerId: filters.ledgerId } };
    }

    if (filters?.search && filters.search.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { voucherNumber: { contains: term, mode: 'insensitive' } },
        { narration: { contains: term, mode: 'insensitive' } },
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

    return entries.map((j) => ({
      id: j.id,
      companyId: j.companyId,
      voucherNumber: j.voucherNumber,
      idempotencyKey: j.idempotencyKey,
      entryDate: j.entryDate.toISOString().split('T')[0],
      fiscalPeriodId: j.fiscalPeriodId,
      narration: j.narration,
      reference: j.reference,
      status: j.status,
      totalDebit: AccountingMath.format(j.totalDebit),
      totalCredit: AccountingMath.format(j.totalCredit),
      postedAt: j.postedAt ? j.postedAt.toISOString() : null,
      postedByUserName: j.postedByUser?.fullName || null,
      reversedAt: j.reversedAt ? j.reversedAt.toISOString() : null,
      reversedByUserName: j.reversedByUser?.fullName || null,
      reversalOfId: j.reversalOfId,
      createdByUserName: j.createdByUser?.fullName,
      createdAt: j.createdAt.toISOString(),
      lines: j.lines.map((l) => ({
        id: l.id,
        ledgerId: l.ledgerId,
        ledgerCode: l.ledger.code,
        ledgerName: l.ledger.name,
        lineNumber: l.lineNumber,
        debit: AccountingMath.format(l.debit),
        credit: AccountingMath.format(l.credit),
        description: l.description,
      })),
    }));
  }

  /**
   * Retrieves a single journal entry with its full posting lines
   */
  static async getJournalById(companyId: string, id: string, tx?: any): Promise<JournalEntryItem> {
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
      const err = new Error('Journal entry not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return {
      id: j.id,
      companyId: j.companyId,
      voucherNumber: j.voucherNumber,
      idempotencyKey: j.idempotencyKey,
      entryDate: j.entryDate.toISOString().split('T')[0],
      fiscalPeriodId: j.fiscalPeriodId,
      narration: j.narration,
      reference: j.reference,
      status: j.status,
      totalDebit: AccountingMath.format(j.totalDebit),
      totalCredit: AccountingMath.format(j.totalCredit),
      postedAt: j.postedAt ? j.postedAt.toISOString() : null,
      postedByUserName: j.postedByUser?.fullName || null,
      reversedAt: j.reversedAt ? j.reversedAt.toISOString() : null,
      reversedByUserName: j.reversedByUser?.fullName || null,
      reversalOfId: j.reversalOfId,
      createdByUserName: j.createdByUser?.fullName,
      createdAt: j.createdAt.toISOString(),
      lines: j.lines.map((l) => ({
        id: l.id,
        ledgerId: l.ledgerId,
        ledgerCode: l.ledger.code,
        ledgerName: l.ledger.name,
        lineNumber: l.lineNumber,
        debit: AccountingMath.format(l.debit),
        credit: AccountingMath.format(l.credit),
        description: l.description,
      })),
    };
  }

  /**
   * Creates a journal entry (Draft or Auto-Posted) in one atomic transaction
   * Strictly enforces double-entry balance, ledger activity, and period checks
   */
  static async createJournal(
    actor: AuthUser,
    input: CreateJournalEntryRequest,
    correlationId?: string,
    txClient?: any
  ): Promise<JournalEntryItem> {
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
      });

      if (existing) {
        return this.getJournalById(actor.companyId, existing.id, txClient);
      }
    }

    // 2. Line count validation
    if (!input.lines || input.lines.length < 2) {
      const err = new Error('Double-entry journals must contain at least two posting lines.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 3. Exact decimal calculation and balance verification
    let sumDebit = new Decimal(0);
    let sumCredit = new Decimal(0);

    const parsedLines: Array<{
      ledgerId: string;
      debit: Decimal;
      credit: Decimal;
      description?: string | null;
      lineNumber: number;
    }> = [];

    const ledgerIds = input.lines.map((l) => l.ledgerId);

    // 4. Validate ledgers exist, belong to this company, and are ACTIVE
    const ledgers = await client.accountLedger.findMany({
      where: {
        id: { in: ledgerIds },
        companyId: actor.companyId,
      },
    });

    const ledgerMap = new Map(ledgers.map((l) => [l.id, l]));

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i];
      const ledger = ledgerMap.get(line.ledgerId);

      if (!ledger) {
        const err = new Error(
          `Posting line ${i + 1} references invalid or cross-company ledger (ID: ${line.ledgerId}).`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      if (!ledger.isActive) {
        const err = new Error(
          `Posting line ${i + 1} references inactive ledger "${ledger.name}". Inactive accounts cannot accept new postings.`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      const debit = AccountingMath.from(line.debit || 0);
      const credit = AccountingMath.from(line.credit || 0);

      // Amounts must be positive
      if (AccountingMath.lt(debit, 0) || AccountingMath.lt(credit, 0)) {
        const err = new Error(`Posting line ${i + 1} contains negative amounts. All amounts must be non-negative.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      // Each line must have either debit OR credit > 0, not both or neither
      const hasDebit = AccountingMath.gt(debit, 0);
      const hasCredit = AccountingMath.gt(credit, 0);

      if ((hasDebit && hasCredit) || (!hasDebit && !hasCredit)) {
        const err = new Error(
          `Posting line ${i + 1} must have either a positive debit OR positive credit amount.`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      sumDebit = sumDebit.plus(debit);
      sumCredit = sumCredit.plus(credit);

      parsedLines.push({
        ledgerId: line.ledgerId,
        debit,
        credit,
        description: line.description?.trim() || null,
        lineNumber: i + 1,
      });
    }

    // 5. Total must be greater than zero
    if (!AccountingMath.gt(sumDebit, 0)) {
      const err = new Error('Journal total must be greater than zero.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 6. Strict Double-Entry equality validation: Total Debit == Total Credit
    if (!AccountingMath.equals(sumDebit, sumCredit)) {
      const diff = AccountingMath.abs(sumDebit.minus(sumCredit));
      const err = new Error(
        `Journal entry is out of balance. Total Debit (${AccountingMath.format(sumDebit)}) != Total Credit (${AccountingMath.format(sumCredit)}). Difference: ${AccountingMath.format(diff)}.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 7. Fiscal period validation (if linked)
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
        const err = new Error(`Cannot post into ${period.status.toLowerCase()} fiscal period "${period.periodName}".`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    const entryDate = new Date(input.entryDate);
    if (isNaN(entryDate.getTime())) {
      const err = new Error('Invalid entry date format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const year = entryDate.getFullYear();
    const shouldAutoPost = Boolean(input.autoPost);
    const now = new Date();

    // 8. Atomic Database Transaction (or participate in provided txClient)
    const executeTx = async (tx: any) => {
      const voucherNumber = await this.generateVoucherNumber(actor.companyId, year, tx);

      const journal = await tx.journalEntry.create({
        data: {
          companyId: actor.companyId,
          voucherNumber,
          idempotencyKey: input.idempotencyKey || null,
          entryDate,
          fiscalPeriodId: input.fiscalPeriodId || null,
          narration: input.narration.trim(),
          reference: input.reference?.trim() || null,
          status: shouldAutoPost ? 'POSTED' : 'DRAFT',
          totalDebit: sumDebit.toString(),
          totalCredit: sumCredit.toString(),
          createdByUserId: actor.id,
          postedAt: shouldAutoPost ? now : null,
          postedByUserId: shouldAutoPost ? actor.id : null,
          lines: {
            create: parsedLines.map((l) => ({
              companyId: actor.companyId,
              ledgerId: l.ledgerId,
              lineNumber: l.lineNumber,
              debit: l.debit.toString(),
              credit: l.credit.toString(),
              description: l.description,
            })),
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
      action: shouldAutoPost ? 'JOURNAL_POSTED' : 'JOURNAL_DRAFT_CREATED',
      entity: 'JournalEntry',
      entityId: createdJournal.id,
      severity: 'INFO',
      correlationId,
      metadata: {
        voucherNumber: createdJournal.voucherNumber,
        totalDebit: AccountingMath.format(sumDebit),
        totalCredit: AccountingMath.format(sumCredit),
        status: createdJournal.status,
      },
    });

    return this.getJournalById(actor.companyId, createdJournal.id, txClient);
  }

  /**
   * Posts an existing draft journal
   */
  static async postJournal(
    actor: AuthUser,
    journalId: string,
    correlationId?: string
  ): Promise<JournalEntryItem> {
    const journal = await prisma.journalEntry.findUnique({
      where: { id: journalId },
      include: { lines: true },
    });

    if (!journal || journal.companyId !== actor.companyId) {
      const err = new Error('Journal not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (journal.status !== 'DRAFT') {
      const err = new Error(`Only draft journals can be posted. Current status: ${journal.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Verify balance
    if (!AccountingMath.equals(journal.totalDebit, journal.totalCredit)) {
      const err = new Error('Cannot post unbalanced journal.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const updated = await prisma.journalEntry.update({
      where: { id: journalId },
      data: {
        status: 'POSTED',
        postedAt: new Date(),
        postedByUserId: actor.id,
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'JOURNAL_POSTED',
      entity: 'JournalEntry',
      entityId: journalId,
      severity: 'INFO',
      correlationId,
      metadata: { voucherNumber: updated.voucherNumber },
    });

    return this.getJournalById(actor.companyId, journalId);
  }

  /**
   * Reverses a posted journal by generating an inverse reversal journal and marking original as REVERSED
   * Section 3 & 9 Reversal Model
   */
  static async reverseJournal(
    actor: AuthUser,
    journalId: string,
    reason: string,
    correlationId?: string
  ): Promise<{ original: JournalEntryItem; reversal: JournalEntryItem }> {
    const original = await prisma.journalEntry.findUnique({
      where: { id: journalId },
      include: { lines: true },
    });

    if (!original || original.companyId !== actor.companyId) {
      const err = new Error('Journal entry not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (original.status !== 'POSTED') {
      const err = new Error(`Only posted journals can be reversed. Current status: ${original.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const now = new Date();
    const year = now.getFullYear();

    const result = await prisma.$transaction(async (tx) => {
      // 1. Generate voucher for reversal entry
      const reversalVoucher = await this.generateVoucherNumber(actor.companyId, year, tx);

      // 2. Create the inverse posting lines (swapping debits and credits)
      const reversalJournal = await tx.journalEntry.create({
        data: {
          companyId: actor.companyId,
          voucherNumber: reversalVoucher,
          entryDate: now,
          narration: `Reversal of ${original.voucherNumber}: ${reason.trim()}`,
          reference: `REV-${original.voucherNumber}`,
          status: 'POSTED',
          totalDebit: original.totalCredit.toString(), // Swapped
          totalCredit: original.totalDebit.toString(),  // Swapped
          postedAt: now,
          postedByUserId: actor.id,
          reversalOfId: original.id,
          createdByUserId: actor.id,
          lines: {
            create: original.lines.map((l) => ({
              companyId: actor.companyId,
              ledgerId: l.ledgerId,
              lineNumber: l.lineNumber,
              debit: l.credit.toString(),  // Inverse: credit becomes debit
              credit: l.debit.toString(),  // Inverse: debit becomes credit
              description: `Inverse of ${original.voucherNumber} line ${l.lineNumber}`,
            })),
          },
        },
      });

      // 3. Mark original journal as REVERSED
      await tx.journalEntry.update({
        where: { id: original.id },
        data: {
          status: 'REVERSED',
          reversedAt: now,
          reversedByUserId: actor.id,
        },
      });

      return reversalJournal;
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'JOURNAL_REVERSED',
      entity: 'JournalEntry',
      entityId: original.id,
      severity: 'WARN',
      correlationId,
      metadata: {
        originalVoucher: original.voucherNumber,
        reversalVoucher: result.voucherNumber,
        reason,
      },
    });

    const [updatedOriginal, reversalItem] = await Promise.all([
      this.getJournalById(actor.companyId, original.id),
      this.getJournalById(actor.companyId, result.id),
    ]);

    return { original: updatedOriginal, reversal: reversalItem };
  }
}
