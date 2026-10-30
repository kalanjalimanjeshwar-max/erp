import { prisma } from '../db/client.js';
import {
  AuthUser,
  CustomerItem,
  CreateCustomerRequest,
  UpdateCustomerRequest,
} from '../../shared/types.js';
import { AccountingMath, Decimal } from '../accounting/decimal-math.js';
import { AuditService } from './audit.service.js';

export class CustomerService {
  /**
   * Lists customers for the company with search and balance summaries
   */
  static async listCustomers(
    companyId: string,
    filters?: { search?: string; isActive?: boolean }
  ): Promise<CustomerItem[]> {
    const where: {
      companyId: string;
      isActive?: boolean;
      OR?: Array<{ code?: { contains: string; mode: 'insensitive' }; name?: { contains: string; mode: 'insensitive' }; email?: { contains: string; mode: 'insensitive' } }>;
    } = { companyId };

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    if (filters?.search && filters.search.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { code: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
      ];
    }

    const customers = await prisma.customer.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      include: {
        receivableLedger: { select: { name: true } },
        invoices: {
          where: { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } },
          select: { total: true, amountPaid: true, balanceDue: true },
        },
      },
    });

    return customers.map((c) => {
      let totalInvoiced = new Decimal(0);
      let totalPaid = new Decimal(0);
      let balanceDue = new Decimal(0);

      for (const inv of c.invoices) {
        totalInvoiced = totalInvoiced.plus(AccountingMath.from(inv.total));
        totalPaid = totalPaid.plus(AccountingMath.from(inv.amountPaid));
        balanceDue = balanceDue.plus(AccountingMath.from(inv.balanceDue));
      }

      return {
        id: c.id,
        companyId: c.companyId,
        code: c.code,
        name: c.name,
        email: c.email,
        phone: c.phone,
        address: c.address,
        taxId: c.taxId,
        currency: c.currency,
        paymentTermsDays: c.paymentTermsDays,
        receivableLedgerId: c.receivableLedgerId,
        receivableLedgerName: c.receivableLedger?.name || null,
        isActive: c.isActive,
        createdAt: c.createdAt.toISOString(),
        totalInvoiced: AccountingMath.format(totalInvoiced),
        totalPaid: AccountingMath.format(totalPaid),
        balanceDue: AccountingMath.format(balanceDue),
      };
    });
  }

  /**
   * Retrieves a single customer by ID
   */
  static async getCustomerById(companyId: string, id: string): Promise<CustomerItem> {
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        receivableLedger: { select: { name: true } },
        invoices: {
          where: { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } },
          select: { total: true, amountPaid: true, balanceDue: true },
        },
      },
    });

    if (!customer || customer.companyId !== companyId) {
      const err = new Error('Customer not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    let totalInvoiced = new Decimal(0);
    let totalPaid = new Decimal(0);
    let balanceDue = new Decimal(0);

    for (const inv of customer.invoices) {
      totalInvoiced = totalInvoiced.plus(AccountingMath.from(inv.total));
      totalPaid = totalPaid.plus(AccountingMath.from(inv.amountPaid));
      balanceDue = balanceDue.plus(AccountingMath.from(inv.balanceDue));
    }

    return {
      id: customer.id,
      companyId: customer.companyId,
      code: customer.code,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      address: customer.address,
      taxId: customer.taxId,
      currency: customer.currency,
      paymentTermsDays: customer.paymentTermsDays,
      receivableLedgerId: customer.receivableLedgerId,
      receivableLedgerName: customer.receivableLedger?.name || null,
      isActive: customer.isActive,
      createdAt: customer.createdAt.toISOString(),
      totalInvoiced: AccountingMath.format(totalInvoiced),
      totalPaid: AccountingMath.format(totalPaid),
      balanceDue: AccountingMath.format(balanceDue),
    };
  }

  /**
   * Creates a new customer with code and name uniqueness validation
   */
  static async createCustomer(
    actor: AuthUser,
    input: CreateCustomerRequest,
    correlationId?: string
  ): Promise<CustomerItem> {
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();

    if (!code || !name) {
      const err = new Error('Customer code and name are required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check code uniqueness
    const existingCode = await prisma.customer.findUnique({
      where: {
        companyId_code: { companyId: actor.companyId, code },
      },
    });
    if (existingCode) {
      const err = new Error(`Customer code "${code}" already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check name uniqueness
    const existingName = await prisma.customer.findUnique({
      where: {
        companyId_name: { companyId: actor.companyId, name },
      },
    });
    if (existingName) {
      const err = new Error(`Customer name "${name}" already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Validate optional ledger
    if (input.receivableLedgerId) {
      const ledger = await prisma.accountLedger.findUnique({
        where: { id: input.receivableLedgerId },
      });
      if (!ledger || ledger.companyId !== actor.companyId) {
        const err = new Error('Receivable ledger does not exist or belongs to another company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    const created = await prisma.customer.create({
      data: {
        companyId: actor.companyId,
        code,
        name,
        email: input.email?.trim() || null,
        phone: input.phone?.trim() || null,
        address: input.address?.trim() || null,
        taxId: input.taxId?.trim() || null,
        paymentTermsDays: input.paymentTermsDays || 30,
        receivableLedgerId: input.receivableLedgerId || null,
        isActive: true,
      },
      include: {
        receivableLedger: { select: { name: true } },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'CUSTOMER_CREATE',
      entity: 'Customer',
      entityId: created.id,
      correlationId,
      details: { code, name },
    });

    return {
      id: created.id,
      companyId: created.companyId,
      code: created.code,
      name: created.name,
      email: created.email,
      phone: created.phone,
      address: created.address,
      taxId: created.taxId,
      currency: created.currency,
      paymentTermsDays: created.paymentTermsDays,
      receivableLedgerId: created.receivableLedgerId,
      receivableLedgerName: created.receivableLedger?.name || null,
      isActive: created.isActive,
      createdAt: created.createdAt.toISOString(),
      totalInvoiced: '0.0000',
      totalPaid: '0.0000',
      balanceDue: '0.0000',
    };
  }

  /**
   * Updates an existing customer
   */
  static async updateCustomer(
    actor: AuthUser,
    id: string,
    input: UpdateCustomerRequest,
    correlationId?: string
  ): Promise<CustomerItem> {
    const existing = await prisma.customer.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Customer not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const data: {
      code?: string;
      name?: string;
      email?: string | null;
      phone?: string | null;
      address?: string | null;
      taxId?: string | null;
      paymentTermsDays?: number;
      receivableLedgerId?: string | null;
      isActive?: boolean;
    } = {};

    if (input.code && input.code.trim().toUpperCase() !== existing.code) {
      const newCode = input.code.trim().toUpperCase();
      const codeTaken = await prisma.customer.findUnique({
        where: { companyId_code: { companyId: actor.companyId, code: newCode } },
      });
      if (codeTaken) {
        const err = new Error(`Customer code "${newCode}" already in use.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      data.code = newCode;
    }

    if (input.name && input.name.trim() !== existing.name) {
      const newName = input.name.trim();
      const nameTaken = await prisma.customer.findUnique({
        where: { companyId_name: { companyId: actor.companyId, name: newName } },
      });
      if (nameTaken) {
        const err = new Error(`Customer name "${newName}" already in use.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      data.name = newName;
    }

    if (input.email !== undefined) data.email = input.email?.trim() || null;
    if (input.phone !== undefined) data.phone = input.phone?.trim() || null;
    if (input.address !== undefined) data.address = input.address?.trim() || null;
    if (input.taxId !== undefined) data.taxId = input.taxId?.trim() || null;
    if (input.paymentTermsDays !== undefined) data.paymentTermsDays = input.paymentTermsDays;
    if (input.receivableLedgerId !== undefined) data.receivableLedgerId = input.receivableLedgerId || null;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const updated = await prisma.customer.update({
      where: { id },
      data,
      include: {
        receivableLedger: { select: { name: true } },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'CUSTOMER_UPDATE',
      entity: 'Customer',
      entityId: id,
      correlationId,
      details: data,
    });

    return this.getCustomerById(actor.companyId, id);
  }
}
