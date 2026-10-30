import { prisma } from '../db/client.js';
import {
  AuthUser,
  QuotationItem,
  QuotationStatus,
  CreateQuotationRequest,
  UpdateQuotationRequest,
  InvoiceItem,
} from '../../shared/types.js';
import { AccountingMath, Decimal } from '../accounting/decimal-math.js';
import { AuditService } from './audit.service.js';

export class QuotationService {
  /**
   * Generates sequential quotation number scoped to company and year (e.g. QT-2026-0001)
   */
  private static async generateQuotationNumber(companyId: string, year: number): Promise<string> {
    const prefix = `QT-${year}-`;
    const count = await prisma.quotation.count({
      where: {
        companyId,
        quotationNumber: { startsWith: prefix },
      },
    });

    const nextSeq = (count + 1).toString().padStart(4, '0');
    return `${prefix}${nextSeq}`;
  }

  /**
   * Lists quotations for the company with filtering
   */
  static async listQuotations(
    companyId: string,
    filters?: {
      status?: QuotationStatus;
      customerId?: string;
      search?: string;
      fromDate?: string;
      toDate?: string;
    }
  ): Promise<QuotationItem[]> {
    const where: {
      companyId: string;
      status?: QuotationStatus;
      customerId?: string;
      quotationDate?: { gte?: Date; lte?: Date };
      OR?: Array<{
        quotationNumber?: { contains: string; mode: 'insensitive' };
        customerName?: { contains: string; mode: 'insensitive' };
      }>;
    } = { companyId };

    if (filters?.status) where.status = filters.status;
    if (filters?.customerId) where.customerId = filters.customerId;

    if (filters?.fromDate || filters?.toDate) {
      where.quotationDate = {};
      if (filters.fromDate) where.quotationDate.gte = new Date(filters.fromDate);
      if (filters.toDate) where.quotationDate.lte = new Date(filters.toDate);
    }

    if (filters?.search && filters.search.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { quotationNumber: { contains: term, mode: 'insensitive' } },
        { customerName: { contains: term, mode: 'insensitive' } },
      ];
    }

    const quotations = await prisma.quotation.findMany({
      where,
      orderBy: [{ quotationDate: 'desc' }, { quotationNumber: 'desc' }],
      include: {
        createdByUser: { select: { fullName: true } },
        lines: { orderBy: { lineNumber: 'asc' } },
      },
    });

    return quotations.map((q) => ({
      id: q.id,
      companyId: q.companyId,
      quotationNumber: q.quotationNumber,
      customerId: q.customerId,
      customerName: q.customerName,
      customerEmail: q.customerEmail,
      customerPhone: q.customerPhone,
      customerAddress: q.customerAddress,
      quotationDate: q.quotationDate.toISOString().split('T')[0],
      validUntilDate: q.validUntilDate.toISOString().split('T')[0],
      status: q.status,
      currency: q.currency,
      subtotal: AccountingMath.format(q.subtotal),
      discountTotal: AccountingMath.format(q.discountTotal),
      taxTotal: AccountingMath.format(q.taxTotal),
      total: AccountingMath.format(q.total),
      notes: q.notes,
      terms: q.terms,
      documentTitle: q.documentTitle,
      convertedToInvoiceId: q.convertedToInvoiceId,
      createdByUserName: q.createdByUser?.fullName || null,
      createdAt: q.createdAt.toISOString(),
      lines: q.lines.map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        itemDescription: l.itemDescription,
        quantity: AccountingMath.format(l.quantity),
        unitPrice: AccountingMath.format(l.unitPrice),
        discountAmount: AccountingMath.format(l.discountAmount),
        taxRate: AccountingMath.format(l.taxRate),
        taxAmount: AccountingMath.format(l.taxAmount),
        lineTotal: AccountingMath.format(l.lineTotal),
      })),
    }));
  }

  /**
   * Retrieves single quotation by ID
   */
  static async getQuotationById(companyId: string, id: string): Promise<QuotationItem> {
    const q = await prisma.quotation.findUnique({
      where: { id },
      include: {
        createdByUser: { select: { fullName: true } },
        lines: { orderBy: { lineNumber: 'asc' } },
      },
    });

    if (!q || q.companyId !== companyId) {
      const err = new Error('Quotation not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return {
      id: q.id,
      companyId: q.companyId,
      quotationNumber: q.quotationNumber,
      customerId: q.customerId,
      customerName: q.customerName,
      customerEmail: q.customerEmail,
      customerPhone: q.customerPhone,
      customerAddress: q.customerAddress,
      quotationDate: q.quotationDate.toISOString().split('T')[0],
      validUntilDate: q.validUntilDate.toISOString().split('T')[0],
      status: q.status,
      currency: q.currency,
      subtotal: AccountingMath.format(q.subtotal),
      discountTotal: AccountingMath.format(q.discountTotal),
      taxTotal: AccountingMath.format(q.taxTotal),
      total: AccountingMath.format(q.total),
      notes: q.notes,
      terms: q.terms,
      documentTitle: q.documentTitle,
      convertedToInvoiceId: q.convertedToInvoiceId,
      createdByUserName: q.createdByUser?.fullName || null,
      createdAt: q.createdAt.toISOString(),
      lines: q.lines.map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        itemDescription: l.itemDescription,
        quantity: AccountingMath.format(l.quantity),
        unitPrice: AccountingMath.format(l.unitPrice),
        discountAmount: AccountingMath.format(l.discountAmount),
        taxRate: AccountingMath.format(l.taxRate),
        taxAmount: AccountingMath.format(l.taxAmount),
        lineTotal: AccountingMath.format(l.lineTotal),
      })),
    };
  }

  /**
   * Creates a new Quotation
   * GUARANTEE: Does NOT create journal entries, touch ledgers, or affect account balances.
   */
  static async createQuotation(
    actor: AuthUser,
    input: CreateQuotationRequest,
    correlationId?: string
  ): Promise<QuotationItem> {
    if (!input.customerName || !input.customerName.trim()) {
      const err = new Error('Customer name is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!input.lines || input.lines.length === 0) {
      const err = new Error('Quotation must contain at least one line item.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const qDate = new Date(input.quotationDate);
    const vDate = new Date(input.validUntilDate);

    if (isNaN(qDate.getTime()) || isNaN(vDate.getTime())) {
      const err = new Error('Invalid quotation or validity dates.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (vDate < qDate) {
      const err = new Error('Validity date cannot be earlier than quotation date.');
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
      });
    }

    const total = subtotal.minus(discountTotal).plus(taxTotal);
    const quotationNumber = await this.generateQuotationNumber(actor.companyId, qDate.getFullYear());

    const created = await prisma.$transaction(async (tx) => {
      const q = await tx.quotation.create({
        data: {
          companyId: actor.companyId,
          quotationNumber,
          customerId: input.customerId || null,
          customerName: input.customerName.trim(),
          customerEmail: input.customerEmail?.trim() || null,
          customerPhone: input.customerPhone?.trim() || null,
          customerAddress: input.customerAddress?.trim() || null,
          quotationDate: qDate,
          validUntilDate: vDate,
          status: 'DRAFT',
          subtotal,
          discountTotal,
          taxTotal,
          total,
          notes: input.notes?.trim() || null,
          terms: input.terms?.trim() || null,
          documentTitle: input.documentTitle?.trim() || null,
          createdByUserId: actor.userId,
        },
      });

      for (const line of parsedLines) {
        await tx.quotationLine.create({
          data: {
            quotationId: q.id,
            lineNumber: line.lineNumber,
            itemDescription: line.itemDescription,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountAmount: line.discountAmount,
            taxRate: line.taxRate,
            taxAmount: line.taxAmount,
            lineTotal: line.lineTotal,
          },
        });
      }

      return q;
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'QUOTATION_CREATE',
      entity: 'Quotation',
      entityId: created.id,
      correlationId,
      details: { quotationNumber, total: AccountingMath.format(total) },
    });

    return this.getQuotationById(actor.companyId, created.id);
  }

  /**
   * Updates an existing Draft Quotation
   */
  static async updateQuotation(
    actor: AuthUser,
    id: string,
    input: UpdateQuotationRequest,
    correlationId?: string
  ): Promise<QuotationItem> {
    const existing = await prisma.quotation.findUnique({
      where: { id },
      include: { lines: true },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Quotation not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status !== 'DRAFT') {
      const err = new Error(`Only DRAFT quotations can be modified. Current status: ${existing.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const qDate = input.quotationDate ? new Date(input.quotationDate) : existing.quotationDate;
    const vDate = input.validUntilDate ? new Date(input.validUntilDate) : existing.validUntilDate;

    if (vDate < qDate) {
      const err = new Error('Validity date cannot be earlier than quotation date.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    await prisma.$transaction(async (tx) => {
      let subtotal = existing.subtotal;
      let discountTotal = existing.discountTotal;
      let taxTotal = existing.taxTotal;
      let total = existing.total;

      if (input.lines && input.lines.length > 0) {
        // Delete existing lines
        await tx.quotationLine.deleteMany({ where: { quotationId: id } });

        subtotal = new Decimal(0);
        discountTotal = new Decimal(0);
        taxTotal = new Decimal(0);

        for (let i = 0; i < input.lines.length; i++) {
          const line = input.lines[i];
          const qty = AccountingMath.from(line.quantity);
          const price = AccountingMath.from(line.unitPrice);
          const discount = AccountingMath.from(line.discountAmount || 0);
          const taxRate = AccountingMath.from(line.taxRate || 0);

          const baseAmount = qty.times(price);
          const afterDiscount = baseAmount.minus(discount);
          const taxAmount = afterDiscount.times(taxRate).dividedBy(100);
          const lineTotal = afterDiscount.plus(taxAmount);

          subtotal = subtotal.plus(baseAmount);
          discountTotal = discountTotal.plus(discount);
          taxTotal = taxTotal.plus(taxAmount);

          await tx.quotationLine.create({
            data: {
              quotationId: id,
              lineNumber: i + 1,
              itemDescription: line.itemDescription.trim(),
              quantity: qty,
              unitPrice: price,
              discountAmount: discount,
              taxRate,
              taxAmount,
              lineTotal,
            },
          });
        }
        total = subtotal.minus(discountTotal).plus(taxTotal);
      }

      await tx.quotation.update({
        where: { id },
        data: {
          customerId: input.customerId !== undefined ? input.customerId : existing.customerId,
          customerName: input.customerName?.trim() || existing.customerName,
          customerEmail: input.customerEmail !== undefined ? input.customerEmail : existing.customerEmail,
          customerPhone: input.customerPhone !== undefined ? input.customerPhone : existing.customerPhone,
          customerAddress: input.customerAddress !== undefined ? input.customerAddress : existing.customerAddress,
          quotationDate: qDate,
          validUntilDate: vDate,
          subtotal,
          discountTotal,
          taxTotal,
          total,
          notes: input.notes !== undefined ? input.notes : existing.notes,
          terms: input.terms !== undefined ? input.terms : existing.terms,
          documentTitle: input.documentTitle !== undefined ? input.documentTitle : existing.documentTitle,
          status: input.status || existing.status,
        },
      });
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'QUOTATION_UPDATE',
      entity: 'Quotation',
      entityId: id,
      correlationId,
      details: { status: input.status || existing.status },
    });

    return this.getQuotationById(actor.companyId, id);
  }

  /**
   * Updates status of quotation (e.g., DRAFT -> SENT -> ACCEPTED / REJECTED)
   */
  static async updateStatus(
    actor: AuthUser,
    id: string,
    newStatus: QuotationStatus,
    correlationId?: string
  ): Promise<QuotationItem> {
    const existing = await prisma.quotation.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Quotation not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status === 'CANCELLED' || existing.status === 'EXPIRED') {
      const err = new Error(`Cannot transition quotation from ${existing.status} status.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const updated = await prisma.quotation.update({
      where: { id },
      data: { status: newStatus },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'QUOTATION_STATUS_CHANGE',
      entity: 'Quotation',
      entityId: id,
      correlationId,
      details: { previousStatus: existing.status, newStatus },
    });

    return this.getQuotationById(actor.companyId, id);
  }
}
