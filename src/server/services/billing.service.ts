import { prisma } from '../db/client.js';
import {
  AuthUser,
  InvoiceItem,
  InvoiceStatus,
  CreateInvoiceRequest,
  UpdateInvoiceRequest,
  IssueInvoiceRequest,
} from '../../shared/types.js';
import { AccountingMath, Decimal } from '../accounting/decimal-math.js';
import { JournalService } from './journal.service.js';
import { AuditService } from './audit.service.js';
import { CompanyService } from './company.service.js';
import { DocumentSequenceService } from './document-sequence.service.js';

export class BillingService {
  /**
   * Generates sequential invoice number scoped to company and year using DocumentSequenceService
   */
  private static async generateInvoiceNumber(companyId: string, year: number, tx?: any): Promise<string> {
    const seq = await DocumentSequenceService.allocateNextNumber(companyId, 'INVOICE', {
      fiscalYear: year,
      tx,
    });
    return seq.formattedNumber;
  }

  /**
   * Lists invoices for the company with filtering
   */
  static async listInvoices(
    companyId: string,
    filters?: {
      status?: InvoiceStatus;
      customerId?: string;
      search?: string;
      fromDate?: string;
      toDate?: string;
    }
  ): Promise<InvoiceItem[]> {
    const where: {
      companyId: string;
      status?: InvoiceStatus;
      customerId?: string;
      invoiceDate?: { gte?: Date; lte?: Date };
      OR?: Array<{
        invoiceNumber?: { contains: string; mode: 'insensitive' };
        customerName?: { contains: string; mode: 'insensitive' };
      }>;
    } = { companyId };

    if (filters?.status) where.status = filters.status;
    if (filters?.customerId) where.customerId = filters.customerId;

    if (filters?.fromDate || filters?.toDate) {
      where.invoiceDate = {};
      if (filters.fromDate) where.invoiceDate.gte = new Date(filters.fromDate);
      if (filters.toDate) where.invoiceDate.lte = new Date(filters.toDate);
    }

    if (filters?.search && filters.search.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { invoiceNumber: { contains: term, mode: 'insensitive' } },
        { customerName: { contains: term, mode: 'insensitive' } },
      ];
    }

    const invoices = await prisma.invoice.findMany({
      where,
      orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }],
      include: {
        createdByUser: { select: { fullName: true } },
        issuedByUser: { select: { fullName: true } },
        voidedByUser: { select: { fullName: true } },
        journalEntry: { select: { voucherNumber: true } },
        lines: {
          include: { revenueLedger: { select: { name: true } } },
          orderBy: { lineNumber: 'asc' },
        },
        allocations: {
          include: {
            receipt: { select: { receiptNumber: true, receiptDate: true } },
          },
        },
      },
    });

    return invoices.map((inv) => ({
      id: inv.id,
      companyId: inv.companyId,
      invoiceNumber: inv.invoiceNumber,
      quotationId: inv.quotationId,
      customerId: inv.customerId,
      customerName: inv.customerName,
      customerEmail: inv.customerEmail,
      customerPhone: inv.customerPhone,
      customerAddress: inv.customerAddress,
      customerTaxId: inv.customerTaxId,
      invoiceDate: inv.invoiceDate.toISOString().split('T')[0],
      dueDate: inv.dueDate.toISOString().split('T')[0],
      status: inv.status,
      currency: inv.currency,
      subtotal: AccountingMath.format(inv.subtotal),
      discountTotal: AccountingMath.format(inv.discountTotal),
      taxTotal: AccountingMath.format(inv.taxTotal),
      total: AccountingMath.format(inv.total),
      amountPaid: AccountingMath.format(inv.amountPaid),
      balanceDue: AccountingMath.format(inv.balanceDue),
      notes: inv.notes,
      terms: inv.terms,
      documentTitle: inv.documentTitle,
      journalEntryId: inv.journalEntryId,
      journalVoucherNumber: inv.journalEntry?.voucherNumber || null,
      issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
      issuedByUserName: inv.issuedByUser?.fullName || null,
      voidedAt: inv.voidedAt ? inv.voidedAt.toISOString() : null,
      voidedByUserName: inv.voidedByUser?.fullName || null,
      voidReason: inv.voidReason,
      createdByUserName: inv.createdByUser?.fullName || null,
      createdAt: inv.createdAt.toISOString(),
      lines: inv.lines.map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        itemDescription: l.itemDescription,
        quantity: AccountingMath.format(l.quantity),
        unitPrice: AccountingMath.format(l.unitPrice),
        discountAmount: AccountingMath.format(l.discountAmount),
        taxRate: AccountingMath.format(l.taxRate),
        taxAmount: AccountingMath.format(l.taxAmount),
        lineTotal: AccountingMath.format(l.lineTotal),
        revenueLedgerId: l.revenueLedgerId,
        revenueLedgerName: l.revenueLedger?.name || null,
      })),
      allocations: inv.allocations.map((a) => ({
        receiptId: a.receiptId,
        receiptNumber: a.receipt.receiptNumber,
        receiptDate: a.receipt.receiptDate.toISOString().split('T')[0],
        allocatedAmount: AccountingMath.format(a.allocatedAmount),
      })),
    }));
  }

  /**
   * Retrieves single invoice by ID
   */
  static async getInvoiceById(companyId: string, id: string): Promise<InvoiceItem> {
    const inv = await prisma.invoice.findUnique({
      where: { id },
      include: {
        createdByUser: { select: { fullName: true } },
        issuedByUser: { select: { fullName: true } },
        voidedByUser: { select: { fullName: true } },
        journalEntry: { select: { voucherNumber: true } },
        lines: {
          include: { revenueLedger: { select: { name: true } } },
          orderBy: { lineNumber: 'asc' },
        },
        allocations: {
          include: {
            receipt: { select: { receiptNumber: true, receiptDate: true } },
          },
        },
      },
    });

    if (!inv || inv.companyId !== companyId) {
      const err = new Error('Invoice not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return {
      id: inv.id,
      companyId: inv.companyId,
      invoiceNumber: inv.invoiceNumber,
      quotationId: inv.quotationId,
      customerId: inv.customerId,
      customerName: inv.customerName,
      customerEmail: inv.customerEmail,
      customerPhone: inv.customerPhone,
      customerAddress: inv.customerAddress,
      customerTaxId: inv.customerTaxId,
      invoiceDate: inv.invoiceDate.toISOString().split('T')[0],
      dueDate: inv.dueDate.toISOString().split('T')[0],
      status: inv.status,
      currency: inv.currency,
      subtotal: AccountingMath.format(inv.subtotal),
      discountTotal: AccountingMath.format(inv.discountTotal),
      taxTotal: AccountingMath.format(inv.taxTotal),
      total: AccountingMath.format(inv.total),
      amountPaid: AccountingMath.format(inv.amountPaid),
      balanceDue: AccountingMath.format(inv.balanceDue),
      notes: inv.notes,
      terms: inv.terms,
      documentTitle: inv.documentTitle,
      journalEntryId: inv.journalEntryId,
      journalVoucherNumber: inv.journalEntry?.voucherNumber || null,
      issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
      issuedByUserName: inv.issuedByUser?.fullName || null,
      voidedAt: inv.voidedAt ? inv.voidedAt.toISOString() : null,
      voidedByUserName: inv.voidedByUser?.fullName || null,
      voidReason: inv.voidReason,
      createdByUserName: inv.createdByUser?.fullName || null,
      createdAt: inv.createdAt.toISOString(),
      lines: inv.lines.map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        itemDescription: l.itemDescription,
        quantity: AccountingMath.format(l.quantity),
        unitPrice: AccountingMath.format(l.unitPrice),
        discountAmount: AccountingMath.format(l.discountAmount),
        taxRate: AccountingMath.format(l.taxRate),
        taxAmount: AccountingMath.format(l.taxAmount),
        lineTotal: AccountingMath.format(l.lineTotal),
        revenueLedgerId: l.revenueLedgerId,
        revenueLedgerName: l.revenueLedger?.name || null,
      })),
      allocations: inv.allocations.map((a) => ({
        receiptId: a.receiptId,
        receiptNumber: a.receipt.receiptNumber,
        receiptDate: a.receipt.receiptDate.toISOString().split('T')[0],
        allocatedAmount: AccountingMath.format(a.allocatedAmount),
      })),
    };
  }

  /**
   * Creates a new DRAFT Invoice
   * GUARANTEE: Draft invoice creates NO journal entries and does NOT alter financial reports.
   */
  static async createInvoice(
    actor: AuthUser,
    input: CreateInvoiceRequest,
    correlationId?: string
  ): Promise<InvoiceItem> {
    const isEnabled = await CompanyService.isSalesInvoiceEnabled(actor.companyId);
    if (!isEnabled) {
      const err = new Error('Sales Invoice feature is disabled for this company in Company Settings.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    if (!input.customerName || !input.customerName.trim()) {
      const err = new Error('Customer name is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!input.lines || input.lines.length === 0) {
      const err = new Error('Invoice must contain at least one line item.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const invDate = new Date(input.invoiceDate);
    const dueDate = new Date(input.dueDate);

    if (isNaN(invDate.getTime()) || isNaN(dueDate.getTime())) {
      const err = new Error('Invalid invoice or due dates.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (dueDate < invDate) {
      const err = new Error('Due date cannot be earlier than invoice date.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Exact decimal calculations
    let subtotal = new Decimal(0);
    let discountTotal = new Decimal(0);
    let taxTotal = new Decimal(0);

    const parsedLines: Array<{
      lineNumber: number;
      itemDescription: string;
      quantity: Decimal;
      unitPrice: Decimal;
      discountAmount: Decimal;
      taxRate: Decimal;
      taxAmount: Decimal;
      lineTotal: Decimal;
      revenueLedgerId?: string | null;
    }> = [];

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i];
      if (!line.itemDescription || !line.itemDescription.trim()) {
        const err = new Error(`Line ${i + 1} must have a description.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      const qty = AccountingMath.from(line.quantity);
      const price = AccountingMath.from(line.unitPrice);
      const discount = AccountingMath.from(line.discountAmount || 0);
      const taxRate = AccountingMath.from(line.taxRate || 0);

      if (AccountingMath.lt(qty, 0) || AccountingMath.isZero(qty)) {
        const err = new Error(`Line ${i + 1} quantity must be greater than zero.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      if (AccountingMath.lt(price, 0)) {
        const err = new Error(`Line ${i + 1} unit price cannot be negative.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      if (AccountingMath.lt(discount, 0)) {
        const err = new Error(`Line ${i + 1} discount cannot be negative.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      const baseAmount = qty.times(price);
      if (AccountingMath.gt(discount, baseAmount)) {
        const err = new Error(`Line ${i + 1} discount exceeds line item base total.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      const afterDiscount = baseAmount.minus(discount);
      const taxAmount = afterDiscount.times(taxRate).dividedBy(100);
      const lineTotal = afterDiscount.plus(taxAmount);

      subtotal = subtotal.plus(baseAmount);
      discountTotal = discountTotal.plus(discount);
      taxTotal = taxTotal.plus(taxAmount);

      parsedLines.push({
        lineNumber: i + 1,
        itemDescription: line.itemDescription.trim(),
        quantity: qty,
        unitPrice: price,
        discountAmount: discount,
        taxRate,
        taxAmount,
        lineTotal,
        revenueLedgerId: line.revenueLedgerId || null,
      });
    }

    const total = subtotal.minus(discountTotal).plus(taxTotal);

    const created = await prisma.$transaction(async (tx) => {
      const seq = await DocumentSequenceService.allocateNextNumber(actor.companyId, 'INVOICE', {
        date: invDate,
        tx,
      });
      const invoiceNumber = seq.formattedNumber;

      const inv = await tx.invoice.create({
        data: {
          companyId: actor.companyId,
          invoiceNumber,
          quotationId: input.quotationId || null,
          customerId: input.customerId || null,
          customerName: input.customerName.trim(),
          customerEmail: input.customerEmail?.trim() || null,
          customerPhone: input.customerPhone?.trim() || null,
          customerAddress: input.customerAddress?.trim() || null,
          customerTaxId: input.customerTaxId?.trim() || null,
          invoiceDate: invDate,
          dueDate,
          status: 'DRAFT',
          subtotal,
          discountTotal,
          taxTotal,
          total,
          amountPaid: new Decimal(0),
          balanceDue: total,
          notes: input.notes?.trim() || null,
          terms: input.terms?.trim() || null,
          documentTitle: input.documentTitle?.trim() || null,
          createdByUserId: actor.userId,
        },
      });

      for (const line of parsedLines) {
        await tx.invoiceLine.create({
          data: {
            invoiceId: inv.id,
            lineNumber: line.lineNumber,
            itemDescription: line.itemDescription,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountAmount: line.discountAmount,
            taxRate: line.taxRate,
            taxAmount: line.taxAmount,
            lineTotal: line.lineTotal,
            revenueLedgerId: line.revenueLedgerId || null,
          },
        });
      }

      return inv;
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'INVOICE_CREATE_DRAFT',
      entity: 'Invoice',
      entityId: created.id,
      correlationId,
      details: { invoiceNumber: created.invoiceNumber, total: AccountingMath.format(total) },
    });

    return this.getInvoiceById(actor.companyId, created.id);
  }

  /**
   * Converts an ACCEPTED quotation into a DRAFT invoice
   * Idempotent: returns existing invoice if already converted
   */
  static async convertQuotationToInvoice(
    actor: AuthUser,
    quotationId: string,
    correlationId?: string
  ): Promise<InvoiceItem> {
    const isEnabled = await CompanyService.isSalesInvoiceEnabled(actor.companyId);
    if (!isEnabled) {
      const err = new Error('Sales Invoice feature is disabled for this company in Company Settings.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const quotation = await prisma.quotation.findUnique({
      where: { id: quotationId },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });

    if (!quotation || quotation.companyId !== actor.companyId) {
      const err = new Error('Quotation not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Idempotency: if already converted, return existing invoice
    if (quotation.convertedToInvoiceId) {
      return this.getInvoiceById(actor.companyId, quotation.convertedToInvoiceId);
    }

    // Calculate default due date (30 days from today)
    const today = new Date();
    const dueDate = new Date(today);
    dueDate.setDate(dueDate.getDate() + 30);

    const draftInvoice = await this.createInvoice(
      actor,
      {
        quotationId: quotation.id,
        customerId: quotation.customerId,
        customerName: quotation.customerName,
        customerEmail: quotation.customerEmail,
        customerPhone: quotation.customerPhone,
        customerAddress: quotation.customerAddress,
        invoiceDate: today.toISOString().split('T')[0],
        dueDate: dueDate.toISOString().split('T')[0],
        notes: quotation.notes,
        terms: quotation.terms,
        documentTitle: quotation.documentTitle,
        lines: quotation.lines.map((l) => ({
          itemDescription: l.itemDescription,
          quantity: AccountingMath.format(l.quantity),
          unitPrice: AccountingMath.format(l.unitPrice),
          discountAmount: AccountingMath.format(l.discountAmount),
          taxRate: AccountingMath.format(l.taxRate),
        })),
      },
      correlationId
    );

    // Link quotation to invoice
    await prisma.quotation.update({
      where: { id: quotation.id },
      data: {
        convertedToInvoiceId: draftInvoice.id,
        status: 'ACCEPTED',
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'QUOTATION_CONVERT_TO_INVOICE',
      entity: 'Quotation',
      entityId: quotation.id,
      correlationId,
      details: { invoiceId: draftInvoice.id, invoiceNumber: draftInvoice.invoiceNumber },
    });

    return draftInvoice;
  }

  /**
   * Resolves required company-specific account mapping or throws descriptive configuration error
   */
  private static async resolveAccountMappings(
    companyId: string,
    customerReceivableLedgerId?: string | null,
    overrides?: IssueInvoiceRequest
  ): Promise<{
    receivablesLedgerId: string;
    revenueLedgerId: string;
    taxPayableLedgerId?: string;
  }> {
    // 1. Receivables Ledger (Asset)
    let receivablesLedgerId = overrides?.receivablesLedgerId || customerReceivableLedgerId;

    if (!receivablesLedgerId) {
      const setting = await prisma.companySetting.findUnique({
        where: { companyId_key: { companyId, key: 'DEFAULT_RECEIVABLES_LEDGER_ID' } },
      });
      if (setting && setting.value) {
        receivablesLedgerId = setting.value;
      }
    }

    if (!receivablesLedgerId) {
      // Find active asset ledger named "Accounts Receivable"
      const autoFound = await prisma.accountLedger.findFirst({
        where: {
          companyId,
          isActive: true,
          group: { rootType: 'ASSET' },
          name: { contains: 'Receivable', mode: 'insensitive' },
        },
      });
      if (autoFound) receivablesLedgerId = autoFound.id;
    }

    if (!receivablesLedgerId) {
      const err = new Error(
        'Configuration required: Accounts Receivable ledger mapping is missing. Please configure an Accounts Receivable account in Company Settings or create one under Asset Groups.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Verify receivables ledger is active and belongs to this company
    const recLedger = await prisma.accountLedger.findUnique({
      where: { id: receivablesLedgerId },
    });
    if (!recLedger || recLedger.companyId !== companyId || !recLedger.isActive) {
      const err = new Error(
        'Configured Accounts Receivable ledger is invalid, inactive, or belongs to another company.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 2. Revenue Ledger (Income)
    let revenueLedgerId = overrides?.revenueLedgerId;

    if (!revenueLedgerId) {
      const setting = await prisma.companySetting.findUnique({
        where: { companyId_key: { companyId, key: 'DEFAULT_REVENUE_LEDGER_ID' } },
      });
      if (setting && setting.value) {
        revenueLedgerId = setting.value;
      }
    }

    if (!revenueLedgerId) {
      const autoFound = await prisma.accountLedger.findFirst({
        where: {
          companyId,
          isActive: true,
          group: { rootType: 'INCOME' },
        },
      });
      if (autoFound) revenueLedgerId = autoFound.id;
    }

    if (!revenueLedgerId) {
      const err = new Error(
        'Configuration required: Sales Revenue ledger mapping is missing. Please configure a Revenue account in Company Settings or create one under Income Groups.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const revLedger = await prisma.accountLedger.findUnique({
      where: { id: revenueLedgerId },
    });
    if (!revLedger || revLedger.companyId !== companyId || !revLedger.isActive) {
      const err = new Error(
        'Configured Revenue ledger is invalid, inactive, or belongs to another company.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 3. Tax Payable Ledger (Liability)
    let taxPayableLedgerId = overrides?.taxPayableLedgerId;
    if (!taxPayableLedgerId) {
      const setting = await prisma.companySetting.findUnique({
        where: { companyId_key: { companyId, key: 'DEFAULT_TAX_PAYABLE_LEDGER_ID' } },
      });
      if (setting && setting.value) {
        taxPayableLedgerId = setting.value;
      }
    }
    if (!taxPayableLedgerId) {
      const autoFound = await prisma.accountLedger.findFirst({
        where: {
          companyId,
          isActive: true,
          group: { rootType: 'LIABILITY' },
          name: { contains: 'Tax', mode: 'insensitive' },
        },
      });
      if (autoFound) taxPayableLedgerId = autoFound.id;
    }

    return { receivablesLedgerId, revenueLedgerId, taxPayableLedgerId };
  }

  /**
   * Issues/finalizes an invoice and atomically posts the double-entry accounting journal
   * Idempotent & atomic: Single database transaction ensures either both invoice and journal succeed, or both roll back.
   */
  static async issueInvoice(
    actor: AuthUser,
    id: string,
    req?: IssueInvoiceRequest,
    correlationId?: string
  ): Promise<InvoiceItem> {
    const isEnabled = await CompanyService.isSalesInvoiceEnabled(actor.companyId);
    if (!isEnabled) {
      const err = new Error('Sales Invoice feature is disabled for this company in Company Settings.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        customer: true,
        lines: true,
      },
    });

    if (!invoice || invoice.companyId !== actor.companyId) {
      const err = new Error('Invoice not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Idempotency: If already issued, return cleanly
    if (invoice.status !== 'DRAFT') {
      return this.getInvoiceById(actor.companyId, id);
    }

    // Resolve mappings
    const mappings = await this.resolveAccountMappings(
      actor.companyId,
      invoice.customer?.receivableLedgerId,
      req
    );

    const subtotalAfterDiscount = invoice.subtotal.minus(invoice.discountTotal);
    const taxTotal = invoice.taxTotal;
    const total = invoice.total;

    if (taxTotal.greaterThan(0) && !mappings.taxPayableLedgerId) {
      const err = new Error(
        'Configuration required: Tax Payable ledger mapping is missing for an invoice with configured taxes.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Build balanced double-entry posting lines
    // Debit: Accounts Receivable (total)
    // Credit: Revenue (subtotal after discount)
    // Credit (optional): Tax Payable (taxTotal)
    const journalLines: Array<{
      ledgerId: string;
      debit: string;
      credit: string;
      description: string;
    }> = [
      {
        ledgerId: mappings.receivablesLedgerId,
        debit: AccountingMath.format(total),
        credit: '0.0000',
        description: `Invoice ${invoice.invoiceNumber} - ${invoice.customerName}`,
      },
      {
        ledgerId: mappings.revenueLedgerId,
        debit: '0.0000',
        credit: AccountingMath.format(subtotalAfterDiscount),
        description: `Revenue: Invoice ${invoice.invoiceNumber}`,
      },
    ];

    if (taxTotal.greaterThan(0) && mappings.taxPayableLedgerId) {
      journalLines.push({
        ledgerId: mappings.taxPayableLedgerId,
        debit: '0.0000',
        credit: AccountingMath.format(taxTotal),
        description: `Tax Payable: Invoice ${invoice.invoiceNumber}`,
      });
    }

    // Atomically create Journal voucher and update Invoice in a transaction
    const issuedInvoice = await prisma.$transaction(async (tx) => {
      // 1. Create and post Journal Voucher
      const journal = await JournalService.createJournal(
        actor,
        {
          entryDate: invoice.invoiceDate.toISOString().split('T')[0],
          reference: invoice.invoiceNumber,
          narration: `Sales Invoice ${invoice.invoiceNumber} for ${invoice.customerName}`,
          lines: journalLines,
          autoPost: true,
        },
        correlationId
      );

      // 2. Mark invoice as ISSUED and link journal
      const updated = await tx.invoice.update({
        where: { id },
        data: {
          status: 'ISSUED',
          journalEntryId: journal.id,
          issuedAt: new Date(),
          issuedByUserId: actor.userId,
        },
      });

      return updated;
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'INVOICE_ISSUE',
      entity: 'Invoice',
      entityId: id,
      correlationId,
      details: {
        invoiceNumber: invoice.invoiceNumber,
        total: AccountingMath.format(total),
        journalEntryId: issuedInvoice.journalEntryId,
      },
    });

    return this.getInvoiceById(actor.companyId, id);
  }

  /**
   * Voids an issued invoice and reverses its accounting journal
   */
  static async voidInvoice(
    actor: AuthUser,
    id: string,
    reason: string,
    correlationId?: string
  ): Promise<InvoiceItem> {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
    });

    if (!invoice || invoice.companyId !== actor.companyId) {
      const err = new Error('Invoice not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (invoice.status === 'VOID') {
      const err = new Error('Invoice is already void.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (AccountingMath.gt(invoice.amountPaid, 0)) {
      const err = new Error(
        `Cannot void invoice with existing payments (Paid: $${AccountingMath.format(invoice.amountPaid)}). Void all related customer receipts first.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    await prisma.$transaction(async (tx) => {
      // Reverse journal voucher if it was posted
      if (invoice.journalEntryId) {
        await JournalService.reverseJournal(
          actor,
          invoice.journalEntryId,
          `Invoice ${invoice.invoiceNumber} voided: ${reason.trim()}`,
          correlationId
        );
      }

      await tx.invoice.update({
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
      action: 'INVOICE_VOID',
      entity: 'Invoice',
      entityId: id,
      correlationId,
      details: { invoiceNumber: invoice.invoiceNumber, reason: reason.trim() },
    });

    return this.getInvoiceById(actor.companyId, id);
  }
}
