import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanyService } from '../../src/server/services/company.service.js';
import { BillingService } from '../../src/server/services/billing.service.js';
import { AuthUser, CreateInvoiceRequest } from '../../src/shared/types.js';
import { prisma } from '../../src/server/db/client.js';

vi.mock('../../src/server/db/client.js', () => ({
  prisma: {
    company: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    companySetting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    invoice: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    quotation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

describe('Optional Sales Invoice Feature - Unit & Multi-Tenant Tests', () => {
  const companyAId = 'comp-a-disabled';
  const companyBId = 'comp-b-enabled';

  const userCompA: AuthUser = {
    id: 'user-a',
    userId: 'user-a',
    companyId: companyAId,
    email: 'admin@company-a.com',
    fullName: 'Admin Company A',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const userCompB: AuthUser = {
    id: 'user-b',
    userId: 'user-b',
    companyId: companyBId,
    email: 'admin@company-b.com',
    fullName: 'Admin Company B',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Safe Default and Company-Level Setting', () => {
    it('should default salesInvoiceEnabled to false when no companySetting exists', async () => {
      vi.mocked(prisma.companySetting.findUnique).mockResolvedValue(null);

      const isEnabled = await CompanyService.isSalesInvoiceEnabled('unconfigured-company');
      expect(isEnabled).toBe(false);
    });

    it('should return false when setting is explicitly "false"', async () => {
      vi.mocked(prisma.companySetting.findUnique).mockResolvedValue({
        id: 'set-1',
        companyId: companyAId,
        key: 'SALES_INVOICE_ENABLED',
        value: 'false',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const isEnabled = await CompanyService.isSalesInvoiceEnabled(companyAId);
      expect(isEnabled).toBe(false);
    });

    it('should return true when setting is explicitly "true"', async () => {
      vi.mocked(prisma.companySetting.findUnique).mockResolvedValue({
        id: 'set-2',
        companyId: companyBId,
        key: 'SALES_INVOICE_ENABLED',
        value: 'true',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const isEnabled = await CompanyService.isSalesInvoiceEnabled(companyBId);
      expect(isEnabled).toBe(true);
    });

    it('should isolate settings across tenants without leakage', async () => {
      (prisma.companySetting.findUnique as any).mockImplementation(async (args: any) => {
        if (args.where.companyId_key.companyId === companyAId) {
          return { id: '1', companyId: companyAId, key: 'SALES_INVOICE_ENABLED', value: 'false' } as any;
        }
        if (args.where.companyId_key.companyId === companyBId) {
          return { id: '2', companyId: companyBId, key: 'SALES_INVOICE_ENABLED', value: 'true' } as any;
        }
        return null;
      });

      const compAEnabled = await CompanyService.isSalesInvoiceEnabled(companyAId);
      const compBEnabled = await CompanyService.isSalesInvoiceEnabled(companyBId);

      expect(compAEnabled).toBe(false);
      expect(compBEnabled).toBe(true);
    });
  });

  describe('2. Backend Enforcement When Sales Invoice is Disabled', () => {
    beforeEach(() => {
      // Mock company A as disabled
      (prisma.companySetting.findUnique as any).mockImplementation(async (args: any) => {
        if (args.where.companyId_key.companyId === companyAId) {
          return { id: '1', companyId: companyAId, key: 'SALES_INVOICE_ENABLED', value: 'false' } as any;
        }
        return null;
      });
    });

    it('should block createInvoice with 403 Forbidden', async () => {
      const invoicePayload: CreateInvoiceRequest = {
        customerName: 'Test Client',
        invoiceDate: '2026-03-30',
        dueDate: '2026-04-30',
        lines: [
          {
            itemDescription: 'Consulting',
            quantity: '1',
            unitPrice: '1000.00',
            discountAmount: '0.00',
            taxRate: '0.00',
          },
        ],
      };

      await expect(BillingService.createInvoice(userCompA, invoicePayload)).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringContaining('Sales Invoice feature is disabled for this company'),
      });
    });

    it('should block issueInvoice with 403 Forbidden', async () => {
      await expect(BillingService.issueInvoice(userCompA, 'inv-draft-123')).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringContaining('Sales Invoice feature is disabled for this company'),
      });
    });

    it('should block convertQuotationToInvoice with 403 Forbidden', async () => {
      await expect(BillingService.convertQuotationToInvoice(userCompA, 'quot-123')).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringContaining('Sales Invoice feature is disabled for this company'),
      });
    });
  });

  describe('3. Historical Invoices Read-Only Preservation', () => {
    it('should allow listInvoices even when sales invoice feature is disabled', async () => {
      vi.mocked(prisma.companySetting.findUnique).mockResolvedValue({
        id: '1',
        companyId: companyAId,
        key: 'SALES_INVOICE_ENABLED',
        value: 'false',
      } as any);

      vi.mocked(prisma.invoice.findMany).mockResolvedValue([
        {
          id: 'hist-inv-1',
          companyId: companyAId,
          invoiceNumber: 'INV-2025-0001',
          status: 'ISSUED',
          customerName: 'Past Client',
          invoiceDate: new Date('2025-01-15'),
          dueDate: new Date('2025-02-15'),
          subtotal: 1000,
          totalDiscount: 0,
          taxTotal: 0,
          grandTotal: 1000,
          paidAmount: 1000,
          balanceDue: 0,
          currency: 'USD',
          lines: [],
          allocations: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ]);

      const invoices = await BillingService.listInvoices(companyAId);
      expect(Array.isArray(invoices)).toBe(true);
      expect(invoices.length).toBe(1);
      expect(invoices[0].invoiceNumber).toBe('INV-2025-0001');
    });

    it('should allow getInvoiceById for historical review even when feature is disabled', async () => {
      vi.mocked(prisma.invoice.findUnique).mockResolvedValue({
        id: 'hist-inv-1',
        companyId: companyAId,
        invoiceNumber: 'INV-2025-0001',
        status: 'ISSUED',
        customerName: 'Past Client',
        invoiceDate: new Date('2025-01-15'),
        dueDate: new Date('2025-02-15'),
        subtotal: 1000,
        totalDiscount: 0,
        taxTotal: 0,
        grandTotal: 1000,
        paidAmount: 1000,
        balanceDue: 0,
        currency: 'USD',
        lines: [],
        allocations: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const invoice = await BillingService.getInvoiceById(companyAId, 'hist-inv-1');
      expect(invoice.id).toBe('hist-inv-1');
      expect(invoice.invoiceNumber).toBe('INV-2025-0001');
    });
  });
});
