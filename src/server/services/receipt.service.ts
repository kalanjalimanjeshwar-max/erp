import { prisma } from '../db/client.js';
import {
  AuthUser,
  CustomerReceiptItem,
  ReceiptStatus,
  CreateCustomerReceiptRequest,
} from '../../shared/types.js';
import { AccountingMath, Decimal } from '../accounting/decimal-math.js';
import { JournalService } from './journal.service.js';
import { AuditService } from './audit.service.js';
import { DocumentSequenceService } from './document-sequence.service.js';

export class ReceiptService {
  /**
   * Generates sequential receipt number scoped to company and year using DocumentSequenceService
   */
  private static async generateReceiptNumber(companyId: string, year: number, tx?: any): Promise<string> {
    const seq = await DocumentSequenceService.allocateNextNumber(companyId, 'RECEIPT', {
      fiscalYear: year,
      tx,
    });
    return seq.formattedNumber;
  }

  /**
   * Lists customer receipts for the company with filtering
   */
  static async listReceipts(
    companyId: string,
    filters?: {
      customerId?: string;
      status?: ReceiptStatus;
      fromDate?: string;
      toDate?: string;
      search?: string;
    }
  ): Promise<CustomerReceiptItem[]> {
    const where: {
      companyId: string;
      customerId?: string;
      status?: ReceiptStatus;
      receiptDate?: { gte?: Date; lte?: Date };
      OR?: Array<{
        receiptNumber?: { contains: string; mode: 'insensitive' };
        customer?: { name?: { contains: string; mode: 'insensitive' } };
      }>;
    } = { companyId };

    if (filters?.customerId) where.customerId = filters.customerId;
    if (filters?.status) where.status = filters.status;

    if (filters?.fromDate || filters?.toDate) {
      where.receiptDate = {};
      if (filters.fromDate) where.receiptDate.gte = new Date(filters.fromDate);
      if (filters.toDate) where.receiptDate.lte = new Date(filters.toDate);
    }

    if (filters?.search && filters.search.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { receiptNumber: { contains: term, mode: 'insensitive' } },
        { customer: { name: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const receipts = await prisma.customerReceipt.findMany({
      where,
      orderBy: [{ receiptDate: 'desc' }, { receiptNumber: 'desc' }],
      include: {
        customer: { select: { name: true } },
        receivingLedger: { select: { name: true } },
        receivableLedger: { select: { name: true } },
        createdByUser: { select: { fullName: true } },
        voidedByUser: { select: { fullName: true } },
        journalEntry: { select: { voucherNumber: true } },
        allocations: {
          include: {
            invoice: { select: { invoiceNumber: true, total: true } },
          },
        },
      },
    });

    return receipts.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      receiptNumber: r.receiptNumber,
      receiptDate: r.receiptDate.toISOString().split('T')[0],
      customerId: r.customerId,
      customerName: r.customer.name,
      amount: AccountingMath.format(r.amount),
      allocatedTotal: AccountingMath.format(r.allocatedTotal),
      unallocatedAmount: AccountingMath.format(r.unallocatedAmount),
      paymentMethod: r.paymentMethod,
      referenceNumber: r.referenceNumber,
      receivingLedgerId: r.receivingLedgerId,
      receivingLedgerName: r.receivingLedger.name,
      receivableLedgerId: r.receivableLedgerId,
      receivableLedgerName: r.receivableLedger.name,
      journalEntryId: r.journalEntryId,
      journalVoucherNumber: r.journalEntry?.voucherNumber || null,
      status: r.status,
      notes: r.notes,
      voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
      voidedByUserName: r.voidedByUser?.fullName || null,
      voidReason: r.voidReason,
      createdByUserName: r.createdByUser?.fullName || null,
      createdAt: r.createdAt.toISOString(),
      allocations: r.allocations.map((a) => ({
        id: a.id,
        receiptId: a.receiptId,
        invoiceId: a.invoiceId,
        invoiceNumber: a.invoice.invoiceNumber,
        invoiceTotal: AccountingMath.format(a.invoice.total),
        allocatedAmount: AccountingMath.format(a.allocatedAmount),
      })),
    }));
  }

  /**
   * Retrieves single receipt by ID
   */
  static async getReceiptById(companyId: string, id: string): Promise<CustomerReceiptItem> {
    const r = await prisma.customerReceipt.findUnique({
      where: { id },
      include: {
        customer: { select: { name: true } },
        receivingLedger: { select: { name: true } },
        receivableLedger: { select: { name: true } },
        createdByUser: { select: { fullName: true } },
        voidedByUser: { select: { fullName: true } },
        journalEntry: { select: { voucherNumber: true } },
        allocations: {
          include: {
            invoice: { select: { invoiceNumber: true, total: true } },
          },
        },
      },
    });

    if (!r || r.companyId !== companyId) {
      const err = new Error('Customer receipt not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return {
      id: r.id,
      companyId: r.companyId,
      receiptNumber: r.receiptNumber,
      receiptDate: r.receiptDate.toISOString().split('T')[0],
      customerId: r.customerId,
      customerName: r.customer.name,
      amount: AccountingMath.format(r.amount),
      allocatedTotal: AccountingMath.format(r.allocatedTotal),
      unallocatedAmount: AccountingMath.format(r.unallocatedAmount),
      paymentMethod: r.paymentMethod,
      referenceNumber: r.referenceNumber,
      receivingLedgerId: r.receivingLedgerId,
      receivingLedgerName: r.receivingLedger.name,
      receivableLedgerId: r.receivableLedgerId,
      receivableLedgerName: r.receivableLedger.name,
      journalEntryId: r.journalEntryId,
      journalVoucherNumber: r.journalEntry?.voucherNumber || null,
      status: r.status,
      notes: r.notes,
      voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
      voidedByUserName: r.voidedByUser?.fullName || null,
      voidReason: r.voidReason,
      createdByUserName: r.createdByUser?.fullName || null,
      createdAt: r.createdAt.toISOString(),
      allocations: r.allocations.map((a) => ({
        id: a.id,
        receiptId: a.receiptId,
        invoiceId: a.invoiceId,
        invoiceNumber: a.invoice.invoiceNumber,
        invoiceTotal: AccountingMath.format(a.invoice.total),
        allocatedAmount: AccountingMath.format(a.allocatedAmount),
      })),
    };
  }

  /**
   * Creates customer receipt, updates invoices, and atomically posts double-entry journal entry
   */
  static async createReceipt(
    actor: AuthUser,
    input: CreateCustomerReceiptRequest,
    correlationId?: string
  ): Promise<CustomerReceiptItem> {
    const totalAmount = AccountingMath.from(input.amount);
    if (!AccountingMath.gt(totalAmount, 0)) {
      const err = new Error('Receipt amount must be strictly greater than zero.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const rDate = new Date(input.receiptDate);
    if (isNaN(rDate.getTime())) {
      const err = new Error('Invalid receipt date.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 1. Verify customer exists in this company
    const customer = await prisma.customer.findUnique({
      where: { id: input.customerId },
    });
    if (!customer || customer.companyId !== actor.companyId) {
      const err = new Error('Customer not found in this company.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 2. Verify receiving ledger (Cash/Bank Asset)
    const receivingLedger = await prisma.accountLedger.findUnique({
      where: { id: input.receivingLedgerId },
      include: { group: true },
    });
    if (!receivingLedger || receivingLedger.companyId !== actor.companyId || !receivingLedger.isActive) {
      const err = new Error('Receiving Cash/Bank ledger is invalid or inactive.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 3. Resolve receivable ledger
    let receivableLedgerId = input.receivableLedgerId || customer.receivableLedgerId;
    if (!receivableLedgerId) {
      const setting = await prisma.companySetting.findUnique({
        where: { companyId_key: { companyId: actor.companyId, key: 'DEFAULT_RECEIVABLES_LEDGER_ID' } },
      });
      if (setting && setting.value) receivableLedgerId = setting.value;
    }
    if (!receivableLedgerId) {
      const autoFound = await prisma.accountLedger.findFirst({
        where: {
          companyId: actor.companyId,
          isActive: true,
          group: { rootType: 'ASSET' },
          name: { contains: 'Receivable', mode: 'insensitive' },
        },
      });
      if (autoFound) receivableLedgerId = autoFound.id;
    }

    if (!receivableLedgerId) {
      const err = new Error(
        'Configuration required: Accounts Receivable ledger mapping is missing.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const receivableLedger = await prisma.accountLedger.findUnique({
      where: { id: receivableLedgerId },
    });
    if (!receivableLedger || receivableLedger.companyId !== actor.companyId || !receivableLedger.isActive) {
      const err = new Error('Accounts Receivable ledger is invalid or inactive.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 4. Validate allocations
    let allocatedTotal = new Decimal(0);
    const parsedAllocations: Array<{
      invoiceId: string;
      invoice: { id: string; invoiceNumber: string; balanceDue: Decimal; amountPaid: Decimal };
      amount: Decimal;
    }> = [];

    if (input.allocations && input.allocations.length > 0) {
      for (let i = 0; i < input.allocations.length; i++) {
        const alloc = input.allocations[i];
        const allocAmount = AccountingMath.from(alloc.amount);

        if (!AccountingMath.gt(allocAmount, 0)) {
          const err = new Error(`Allocation for invoice on row ${i + 1} must be greater than zero.`);
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        const invoice = await prisma.invoice.findUnique({
          where: { id: alloc.invoiceId },
        });

        if (!invoice || invoice.companyId !== actor.companyId) {
          const err = new Error(`Invoice on row ${i + 1} does not exist in this company.`);
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        if (invoice.customerId && invoice.customerId !== customer.id) {
          const err = new Error(`Invoice ${invoice.invoiceNumber} belongs to a different customer.`);
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') {
          const err = new Error(
            `Cannot allocate payment to invoice ${invoice.invoiceNumber} with status ${invoice.status}. Only ISSUED or PARTIALLY_PAID invoices accept payments.`
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        if (AccountingMath.gt(allocAmount, invoice.balanceDue)) {
          const err = new Error(
            `Allocated amount ($${AccountingMath.format(allocAmount)}) exceeds invoice ${invoice.invoiceNumber} balance due ($${AccountingMath.format(invoice.balanceDue)}).`
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        allocatedTotal = allocatedTotal.plus(allocAmount);
        parsedAllocations.push({
          invoiceId: invoice.id,
          invoice: {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            balanceDue: invoice.balanceDue,
            amountPaid: invoice.amountPaid,
          },
          amount: allocAmount,
        });
      }
    }

    if (AccountingMath.gt(allocatedTotal, totalAmount)) {
      const err = new Error(
        `Total allocated amounts ($${AccountingMath.format(allocatedTotal)}) exceed the receipt amount ($${AccountingMath.format(totalAmount)}).`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const unallocatedAmount = totalAmount.minus(allocatedTotal);

    // 5. Execute atomic transaction
    const createdReceipt = await prisma.$transaction(async (tx) => {
      const seq = await DocumentSequenceService.allocateNextNumber(actor.companyId, 'RECEIPT', {
        date: rDate,
        tx,
      });
      const receiptNumber = seq.formattedNumber;

      // Create and post double-entry Journal Voucher
      // Debit: Receiving Cash/Bank ledger (amount)
      // Credit: Accounts Receivable ledger (amount)
      const journal = await JournalService.createJournal(
        actor,
        {
          entryDate: input.receiptDate,
          reference: input.referenceNumber || receiptNumber,
          narration: `Payment received from ${customer.name} (${receiptNumber})`,
          lines: [
            {
              ledgerId: receivingLedger.id,
              debit: AccountingMath.format(totalAmount),
              credit: '0.0000',
              description: `Receipt ${receiptNumber} - ${receivingLedger.name}`,
            },
            {
              ledgerId: receivableLedger.id,
              debit: '0.0000',
              credit: AccountingMath.format(totalAmount),
              description: `Accounts Receivable credit - ${customer.name}`,
            },
          ],
          autoPost: true,
        },
        correlationId
      );

      // Create Receipt header
      const receipt = await tx.customerReceipt.create({
        data: {
          companyId: actor.companyId,
          receiptNumber,
          receiptDate: rDate,
          customerId: customer.id,
          amount: totalAmount,
          allocatedTotal,
          unallocatedAmount,
          paymentMethod: input.paymentMethod,
          referenceNumber: input.referenceNumber?.trim() || null,
          receivingLedgerId: receivingLedger.id,
          receivableLedgerId: receivableLedger.id,
          journalEntryId: journal.id,
          status: 'POSTED',
          notes: input.notes?.trim() || null,
          createdByUserId: actor.userId,
        },
      });

      // Create Allocations and update Invoices
      for (const item of parsedAllocations) {
        await tx.receiptAllocation.create({
          data: {
            companyId: actor.companyId,
            receiptId: receipt.id,
            invoiceId: item.invoiceId,
            allocatedAmount: item.amount,
          },
        });

        const newAmountPaid = item.invoice.amountPaid.plus(item.amount);
        const newBalanceDue = item.invoice.balanceDue.minus(item.amount);
        const newStatus = AccountingMath.isZero(newBalanceDue) ? 'PAID' : 'PARTIALLY_PAID';

        await tx.invoice.update({
          where: { id: item.invoiceId },
          data: {
            amountPaid: newAmountPaid,
            balanceDue: newBalanceDue,
            status: newStatus,
          },
        });
      }

      return receipt;
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'CUSTOMER_RECEIPT_POST',
      entity: 'CustomerReceipt',
      entityId: createdReceipt.id,
      correlationId,
      details: {
        receiptNumber: createdReceipt.receiptNumber,
        amount: AccountingMath.format(totalAmount),
        allocatedTotal: AccountingMath.format(allocatedTotal),
        journalEntryId: createdReceipt.journalEntryId,
      },
    });

    return this.getReceiptById(actor.companyId, createdReceipt.id);
  }

  /**
   * Voids a customer receipt and restores all invoice balances and reverses journal entries
   */
  static async voidReceipt(
    actor: AuthUser,
    id: string,
    reason: string,
    correlationId?: string
  ): Promise<CustomerReceiptItem> {
    const receipt = await prisma.customerReceipt.findUnique({
      where: { id },
      include: {
        allocations: {
          include: { invoice: true },
        },
      },
    });

    if (!receipt || receipt.companyId !== actor.companyId) {
      const err = new Error('Customer receipt not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (receipt.status === 'VOID') {
      const err = new Error('Receipt is already void.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    await prisma.$transaction(async (tx) => {
      // 1. Reverse accounting journal voucher
      if (receipt.journalEntryId) {
        await JournalService.reverseJournal(
          actor,
          receipt.journalEntryId,
          `Customer receipt ${receipt.receiptNumber} voided: ${reason.trim()}`,
          correlationId
        );
      }

      // 2. Restore balances on all allocated invoices
      for (const alloc of receipt.allocations) {
        const inv = alloc.invoice;
        const restoredAmountPaid = inv.amountPaid.minus(alloc.allocatedAmount);
        const restoredBalanceDue = inv.balanceDue.plus(alloc.allocatedAmount);
        const restoredStatus = AccountingMath.isZero(restoredAmountPaid) ? 'ISSUED' : 'PARTIALLY_PAID';

        await tx.invoice.update({
          where: { id: inv.id },
          data: {
            amountPaid: restoredAmountPaid,
            balanceDue: restoredBalanceDue,
            status: restoredStatus,
          },
        });
      }

      // 3. Mark receipt as VOID
      await tx.customerReceipt.update({
        where: { id },
        data: {
          status: 'VOID',
          voidedAt: new Date(),
          voidedByUserId: actor.userId,
          voidReason: reason.trim(),
        },
      });
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'CUSTOMER_RECEIPT_VOID',
      entity: 'CustomerReceipt',
      entityId: id,
      correlationId,
      details: { receiptNumber: receipt.receiptNumber, reason: reason.trim() },
    });

    return this.getReceiptById(actor.companyId, id);
  }
}
