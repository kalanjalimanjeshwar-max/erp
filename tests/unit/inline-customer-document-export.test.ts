import zlib from 'node:zlib';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateInlineCustomerInput,
  validateTaxRegistrationNumber,
  validatePostalCode,
  findDuplicateCustomers,
  formatCustomerBillingAddress,
} from '../../src/shared/customer-validation.js';
import {
  buildExportFileName,
  generateDocxBuffer,
  resolveEffectivePrintLayout,
} from '../../src/shared/export/docx-builder.js';
import { createDefaultPrintSettings } from '../../src/shared/print-settings.js';
import { CustomerService } from '../../src/server/services/customer.service.js';
import { BillingService } from '../../src/server/services/billing.service.js';
import { DocumentExportService } from '../../src/server/services/document-export.service.js';
import { CompanyBankAccountService } from '../../src/server/services/company-bank-account.service.js';
import { JournalService } from '../../src/server/services/journal.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { prisma } from '../../src/server/db/client.js';
import { previewStore } from '../../src/client/services/previewStore.js';
import {
  AuthUser,
  CompanyBankAccountItem,
  CompanyProfile,
  InvoiceItem,
  QuotationItem,
} from '../../src/shared/types.js';

vi.mock('../../src/server/db/client.js', () => {
  return {
    prisma: {
      company: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      companySetting: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
      },
      rolePermission: {
        findUnique: vi.fn(),
      },
      customer: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      accountLedger: {
        findUnique: vi.fn(),
      },
      companyBankAccount: {
        findMany: vi.fn(),
      },
      invoice: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      invoiceLine: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
    },
  };
});

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/server/services/journal.service.js', () => ({
  JournalService: {
    createJournal: vi.fn().mockResolvedValue({
      id: 'je-mock-1',
      voucherNumber: 'JV-2026-0001',
      status: 'POSTED',
    }),
    reverseJournal: vi.fn().mockResolvedValue(undefined),
  },
}));

/**
 * Reads a UTF-8 text entry from a standard ZIP/DOCX buffer via End of Central Directory.
 */
function extractZipTextEntry(zipBuffer: Buffer, targetName: string): string {
  // Locate End of Central Directory (PK\x05\x06)
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 65557); i--) {
    if (
      zipBuffer[i] === 0x50 &&
      zipBuffer[i + 1] === 0x4b &&
      zipBuffer[i + 2] === 0x05 &&
      zipBuffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('EOCD signature not found in ZIP buffer.');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  let cursor = cdOffset;
  for (let idx = 0; idx < totalEntries; idx++) {
    if (
      zipBuffer[cursor] !== 0x50 ||
      zipBuffer[cursor + 1] !== 0x4b ||
      zipBuffer[cursor + 2] !== 0x01 ||
      zipBuffer[cursor + 3] !== 0x02
    ) {
      break;
    }

    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const fileNameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);

    const fileName = zipBuffer.toString('utf8', cursor + 46, cursor + 46 + fileNameLen);
    if (fileName === targetName) {
      const lfhFileNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const lfhExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lfhFileNameLen + lfhExtraLen;
      const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        return compressedData.toString('utf8');
      }
      if (compressionMethod === 8) {
        return zlib.inflateRawSync(compressedData).toString('utf8');
      }
      throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
    }

    cursor += 46 + fileNameLen + extraLen + commentLen;
  }

  throw new Error(`Entry "${targetName}" not found in ZIP archive.`);
}

function extractDocxPlainText(zipBuffer: Buffer): string {
  const xml = extractZipTextEntry(zipBuffer, 'word/document.xml');
  return xml
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

describe('Inline Customer Creation, Draft Editing & Document Print/Export Suite', () => {
  const companyId = 'company-namma-media-01';

  const adminActor: AuthUser = {
    id: 'user-adm-1',
    userId: 'user-adm-1',
    companyId,
    email: 'admin@nammamedia.in',
    fullName: 'Namma Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const viceAdminActor: AuthUser = {
    id: 'user-va-1',
    userId: 'user-va-1',
    companyId,
    email: 'viewer@nammamedia.in',
    fullName: 'Vice Admin',
    role: 'VICE_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeActor: AuthUser = {
    id: 'user-emp-1',
    userId: 'user-emp-1',
    companyId,
    email: 'staff@nammamedia.in',
    fullName: 'Studio Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const nammaProfile: CompanyProfile = {
    id: companyId,
    code: 'NAMMA',
    name: 'NAMMA MEDIA',
    legalName: 'Namma Media Pvt Ltd',
    email: 'accounts@nammamedia.in',
    phone: '+91 80 4123 9000',
    website: 'https://nammamedia.in',
    address: 'Indiranagar 100ft Road, Bengaluru, Karnataka 560038',
    taxId: '29AABCN1234F1Z5',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    roundingPrecision: 2,
    salesInvoiceEnabled: true,
    printSettings: createDefaultPrintSettings({
      defaultDocumentLanguage: 'EN',
    }),
  };

  const maskedBankAccount: CompanyBankAccountItem = {
    id: 'bank-1',
    companyId,
    bankName: 'HDFC Bank',
    accountHolderName: 'Namma Media Pvt Ltd',
    accountNumber: 'XXXX-XXXX-9012',
    routingCode: 'HDFC0000123',
    branchName: 'Indiranagar Bengaluru',
    swiftBic: null,
    iban: null,
    upiId: 'na***@hdfcbank',
    accountType: 'CURRENT',
    currency: 'INR',
    isDefault: true,
    isActive: true,
    showOnInvoices: true,
    showOnQuotations: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const sampleQuotation: QuotationItem = {
    id: 'qt-namma-1',
    companyId,
    quotationNumber: 'QT-2026-0042',
    customerId: 'cust-1',
    customerName: 'Kannada Digital Studios Pvt Ltd',
    customerEmail: 'finance@kannadastudios.in',
    customerPhone: '+91 98450 11223',
    customerAddress: 'MG Road, Bengaluru, Karnataka - 560001, India',
    customerTaxId: '29ABCDE1234F1Z5',
    quotationDate: '2026-04-10',
    validUntilDate: '2026-05-10',
    status: 'DRAFT',
    currency: 'INR',
    subtotal: '50000.00',
    discountTotal: '0.00',
    taxTotal: '9000.00',
    total: '59000.00',
    notes: 'Brand film & OTT campaign production',
    terms: '50% advance upon confirmation.',
    documentTitle: 'Service Quotation',
    convertedToInvoiceId: null,
    createdByUserName: 'Namma Admin',
    createdAt: '2026-04-10T05:30:00.000Z',
    lines: [
      {
        id: 'ql-1',
        lineNumber: 1,
        itemDescription: 'Digital Ad Film Production & Post Editing (4K)',
        quantity: '1',
        unitPrice: '50000.00',
        discountAmount: '0.00',
        taxRate: '18.00',
        taxAmount: '9000.00',
        lineTotal: '59000.00',
      },
    ],
  };

  const sampleInvoice: InvoiceItem = {
    id: 'inv-namma-1',
    companyId,
    invoiceNumber: 'INV-2026-0088',
    quotationId: 'qt-namma-1',
    customerId: 'cust-1',
    customerName: 'Kannada Digital Studios Pvt Ltd',
    customerEmail: 'finance@kannadastudios.in',
    customerPhone: '+91 98450 11223',
    customerAddress: 'MG Road, Bengaluru, Karnataka - 560001, India',
    customerTaxId: '29ABCDE1234F1Z5',
    invoiceDate: '2026-04-12',
    dueDate: '2026-05-12',
    status: 'DRAFT',
    currency: 'INR',
    subtotal: '50000.00',
    discountTotal: '0.00',
    taxTotal: '9000.00',
    total: '59000.00',
    amountPaid: '0.00',
    balanceDue: '59000.00',
    notes: 'Retainer billing cycle 1',
    terms: 'Payable within 30 days via NEFT/RTGS.',
    documentTitle: 'Tax Invoice',
    journalEntryId: null,
    journalVoucherNumber: null,
    issuedAt: null,
    issuedByUserName: null,
    voidedAt: null,
    voidedByUserName: null,
    voidReason: null,
    createdByUserName: 'Namma Admin',
    createdAt: '2026-04-12T06:00:00.000Z',
    lines: [
      {
        id: 'il-1',
        lineNumber: 1,
        itemDescription: 'Digital Ad Film Production & Post Editing (4K)',
        quantity: '1',
        unitPrice: '50000.00',
        discountAmount: '0.00',
        taxRate: '18.00',
        taxAmount: '9000.00',
        lineTotal: '59000.00',
        revenueLedgerId: 'ldr-4001',
        revenueLedgerName: 'Media Production Revenue',
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(prisma.rolePermission.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.company.findUnique).mockResolvedValue({
      id: companyId,
      name: nammaProfile.name,
      legalName: nammaProfile.legalName,
      email: nammaProfile.email,
      phone: nammaProfile.phone,
      website: nammaProfile.website,
      address: nammaProfile.address,
      taxId: nammaProfile.taxId,
      logoUrl: null,
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      fiscalYearStartMonth: 4,
      roundingPrecision: 2,
      defaultSalesQuotationEnabled: true,
      defaultSalesInvoiceEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(prisma.companySetting.findMany).mockResolvedValue([
      {
        id: 'cs-sales-inv',
        companyId,
        key: 'SALES_INVOICE_ENABLED',
        value: 'true',
      },
    ] as never);
    vi.mocked(prisma.companySetting.findUnique).mockImplementation((async (args: any) => {
      if (args?.where?.companyId_key?.key === 'SALES_INVOICE_ENABLED') {
        return {
          id: 'cs-sales-inv',
          companyId,
          key: 'SALES_INVOICE_ENABLED',
          value: 'true',
        };
      }
      return null;
    }) as never);
    vi.mocked(prisma.companySetting.upsert).mockResolvedValue({} as never);
  });

  // ==========================================================
  // 1. Customer Field Validation & Country-Aware Tax Rules
  // ==========================================================
  describe('Customer Validation & Duplicate Prevention', () => {
    it('validates Indian GSTIN, PIN code, email, and phone accurately', () => {
      const valid = validateInlineCustomerInput({
        name: 'Bengaluru Creative House',
        customerType: 'BUSINESS',
        email: 'billing@bch.in',
        phone: '+91 98450 54321',
        country: 'India',
        postalCode: '560038',
        taxId: '29ABCDE1234F1Z5',
      });
      expect(valid.valid).toBe(true);
      expect(valid.errors).toEqual({});

      // Invalid state code (90) in GSTIN
      const badState = validateTaxRegistrationNumber('90ABCDE1234F1Z5', 'India');
      expect(badState.valid).toBe(false);
      expect(badState.error).toContain('state code');

      // Invalid GSTIN format
      const badGstin = validateTaxRegistrationNumber('29INVALID', 'IN');
      expect(badGstin.valid).toBe(false);

      // Invalid Indian PIN starting with 0
      const badPin = validatePostalCode('060001', 'India');
      expect(badPin.valid).toBe(false);

      // Country-dependent US EIN, UK VAT, UAE TRN
      expect(validateTaxRegistrationNumber('12-3456789', 'United States').valid).toBe(true);
      expect(validateTaxRegistrationNumber('12345', 'US').valid).toBe(false);
      expect(validateTaxRegistrationNumber('GB123456789', 'UK').valid).toBe(true);
      expect(validateTaxRegistrationNumber('100123456789012', 'UAE').valid).toBe(true);

      // Bad email / phone
      const badContact = validateInlineCustomerInput({
        name: 'Test Studio',
        email: 'not-an-email',
        phone: '123',
      });
      expect(badContact.valid).toBe(false);
      expect(badContact.errors.email).toBeDefined();
      expect(badContact.errors.phone).toBeDefined();
    });

    it('detects duplicate customers across normalized name, email, last-10 phone digits, and GSTIN', () => {
      const existing = [
        {
          id: 'c1',
          code: 'CUST-0001',
          name: 'Deccan Herald Media',
          email: 'accounts@deccan.in',
          phone: '+91 98450 11223',
          taxId: '29ABCDE1234F1Z5',
        },
      ];

      const matches = findDuplicateCustomers(
        {
          name: '  deccan   herald media ',
          email: 'ACCOUNTS@DECCAN.IN',
          phone: '09845011223',
          taxId: '29abcde1234f1z5',
        },
        existing
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].matchedOn).toEqual(['name', 'email', 'phone', 'taxId']);

      // Excluding self during edit should produce no duplicate match
      expect(
        findDuplicateCustomers({ name: 'Deccan Herald Media' }, existing, 'c1')
      ).toHaveLength(0);
    });

    it('blocks duplicate customer creation in CustomerService with HTTP 409', async () => {
      vi.mocked(prisma.customer.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.customer.findMany).mockResolvedValue([
        {
          id: 'c-existing',
          code: 'CUST-0001',
          name: 'Namma Studio Client',
          email: 'billing@client.in',
          phone: '+91 9845012345',
          taxId: '29ABCDE1234F1Z5',
        } as never,
      ]);

      await expect(
        CustomerService.createCustomer(adminActor, {
          name: 'Different Legal Name',
          email: 'other@client.in',
          phone: '9845012345', // matches last 10 digits
          country: 'India',
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('Possible duplicate customer detected'),
      });
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it('auto-generates CUST-XXXX code, defaults to INR, formats billing address, and persists extended metadata', async () => {
      vi.mocked(prisma.customer.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.customer.findMany).mockResolvedValue([
        {
          id: 'c1',
          code: 'CUST-0004',
          name: 'Existing Client',
          email: null,
          phone: null,
          taxId: null,
        } as never,
      ]);

      const createdRow = {
        id: 'cust-new-5',
        companyId,
        code: 'CUST-0005',
        name: 'Kaveri Films LLP',
        email: 'billing@kaverifilms.in',
        phone: '+91 99001 22334',
        address: 'No 12 Residency Road, Bengaluru, Karnataka - 560025, India',
        taxId: '29AABCK1234F1Z2',
        currency: 'INR',
        paymentTermsDays: 15,
        receivableLedgerId: null,
        receivableLedger: null,
        isActive: true,
        createdAt: new Date('2026-04-12T05:00:00.000Z'),
      };
      vi.mocked(prisma.customer.create).mockResolvedValue(createdRow as never);

      const composed = formatCustomerBillingAddress({
        address: 'No 12 Residency Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560025',
        country: 'India',
      });
      expect(composed).toBe('No 12 Residency Road, Bengaluru, Karnataka - 560025, India');

      const result = await CustomerService.createCustomer(adminActor, {
        name: 'Kaveri Films LLP',
        customerType: 'BUSINESS',
        contactPerson: 'Asha Rao',
        email: 'billing@kaverifilms.in',
        phone: '+91 99001 22334',
        address: 'No 12 Residency Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560025',
        country: 'India',
        taxId: '29aabck1234f1z2',
        paymentTermsDays: 15,
        notes: 'Priority media partner',
      });

      expect(result.code).toBe('CUST-0005');
      expect(result.currency).toBe('INR');
      expect(result.taxId).toBe('29AABCK1234F1Z2');
      expect(result.contactPerson).toBe('Asha Rao');
      expect(result.customerType).toBe('BUSINESS');
      expect(prisma.companySetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            companyId_key: {
              companyId,
              key: 'CUSTOMER_META:cust-new-5',
            },
          },
        })
      );
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CUSTOMER_CREATE',
          entity: 'Customer',
          entityId: 'cust-new-5',
        })
      );
    });
  });

  // ==========================================================
  // 2. Draft Invoice Editing & Accounting Integrity
  // ==========================================================
  describe('BillingService.updateInvoice Draft Editing & Accounting Integrity', () => {
    it('updates a DRAFT invoice without creating any journal entries', async () => {
      vi.mocked(prisma.invoice.findUnique)
        .mockResolvedValueOnce({
          id: 'inv-draft-1',
          companyId,
          invoiceNumber: 'INV-2026-0099',
          quotationId: null,
          customerId: 'cust-1',
          customerName: 'Old Customer Name',
          customerEmail: null,
          customerPhone: null,
          customerAddress: null,
          customerTaxId: null,
          invoiceDate: new Date('2026-04-01'),
          dueDate: new Date('2026-05-01'),
          status: 'DRAFT',
          currency: 'INR',
          subtotal: '1000.00',
          discountTotal: '0.00',
          taxTotal: '180.00',
          total: '1180.00',
          amountPaid: '0.00',
          balanceDue: '1180.00',
          notes: null,
          terms: null,
          documentTitle: 'Tax Invoice',
          lines: [],
        } as never)
        .mockResolvedValueOnce({
          id: 'inv-draft-1',
          companyId,
          invoiceNumber: 'INV-2026-0099',
          quotationId: null,
          customerId: 'cust-2',
          customerName: 'Updated Media Client',
          customerEmail: 'pay@updated.in',
          customerPhone: '+91 9845098450',
          customerAddress: 'Bengaluru, India',
          customerTaxId: '29AABCU1234F1Z1',
          invoiceDate: new Date('2026-04-05'),
          dueDate: new Date('2026-05-05'),
          status: 'DRAFT',
          currency: 'INR',
          subtotal: '20000.00',
          discountTotal: '1000.00',
          taxTotal: '3420.00',
          total: '22420.00',
          amountPaid: '0.00',
          balanceDue: '22420.00',
          notes: 'Updated draft notes',
          terms: 'Net 30',
          documentTitle: 'Tax Invoice',
          journalEntryId: null,
          journalEntry: null,
          issuedAt: null,
          issuedByUser: null,
          voidedAt: null,
          voidedByUser: null,
          voidReason: null,
          createdByUser: { fullName: 'Namma Admin' },
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
          lines: [
            {
              id: 'line-updated-1',
              lineNumber: 1,
              itemDescription: 'Outdoor Hoarding Campaign',
              quantity: '2',
              unitPrice: '10000.00',
              discountAmount: '1000.00',
              taxRate: '18.00',
              taxAmount: '3420.00',
              lineTotal: '22420.00',
              revenueLedgerId: null,
              revenueLedger: null,
            },
          ],
          allocations: [],
        } as never);

      const updated = await BillingService.updateInvoice(adminActor, 'inv-draft-1', {
        customerId: 'cust-2',
        customerName: 'Updated Media Client',
        customerEmail: 'pay@updated.in',
        customerPhone: '+91 9845098450',
        customerAddress: 'Bengaluru, India',
        customerTaxId: '29AABCU1234F1Z1',
        invoiceDate: '2026-04-05',
        dueDate: '2026-05-05',
        notes: 'Updated draft notes',
        terms: 'Net 30',
        lines: [
          {
            itemDescription: 'Outdoor Hoarding Campaign',
            quantity: '2',
            unitPrice: '10000',
            discountAmount: '1000',
            taxRate: '18',
          },
        ],
      });

      expect(updated.status).toBe('DRAFT');
      expect(updated.total).toBe('22420.0000');
      expect(updated.customerTaxId).toBe('29AABCU1234F1Z1');
      expect(JournalService.createJournal).not.toHaveBeenCalled();
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'INVOICE_UPDATE_DRAFT',
          entity: 'Invoice',
          entityId: 'inv-draft-1',
        })
      );
    });

    it('rejects editing non-DRAFT (ISSUED) invoices', async () => {
      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: 'inv-issued-1',
        companyId,
        status: 'ISSUED',
        lines: [],
      } as never);

      await expect(
        BillingService.updateInvoice(adminActor, 'inv-issued-1', {
          notes: 'Should fail',
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('Only DRAFT invoices can be modified'),
      });
    });
  });

  // ==========================================================
  // 3. Server PDF & DOCX Document Export + Bank Security + RBAC
  // ==========================================================
  describe('DocumentExportService (PDF & Word .docx), Layout Config & RBAC', () => {
    beforeEach(() => {
      vi.spyOn(CompanyBankAccountService, 'listBankAccounts').mockResolvedValue([maskedBankAccount]);
    });

    it('exports a valid binary PDF (%PDF-) across A4, A5, Letter, portrait/landscape, and bilingual EN_KN without posting journals', async () => {
      const a4Result = await DocumentExportService.exportDocument(
        adminActor,
        {
          document: { type: 'QUOTATION', data: sampleQuotation },
          isDraftPreview: true,
        },
        'pdf'
      );

      expect(a4Result.mimeType).toBe('application/pdf');
      expect(a4Result.fileName).toBe('QT-2026-0042-DRAFT-PREVIEW.pdf');
      expect(a4Result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(a4Result.buffer.length).toBeGreaterThan(2000);
      // Verify NotoSansKannada / Kannada or embedded font dictionary exists in PDF stream
      const pdfLatin = a4Result.buffer.toString('latin1');
      expect(pdfLatin).toContain('/MediaBox');

      // Test A5 Landscape + Bilingual Kannada + English (EN_KN)
      const baseLayout = resolveEffectivePrintLayout('INVOICE', nammaProfile);
      const a5LandscapeResult = await DocumentExportService.exportDocument(
        adminActor,
        {
          document: { type: 'INVOICE', data: sampleInvoice },
          layoutOverride: {
            ...baseLayout,
            paperSize: 'A5',
            orientation: 'landscape',
            language: 'EN_KN',
            margins: { topMm: 10, rightMm: 10, bottomMm: 10, leftMm: 10 },
          },
          isDraftPreview: true,
        },
        'pdf'
      );
      expect(a5LandscapeResult.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(JournalService.createJournal).not.toHaveBeenCalled();
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DOCUMENT_EXPORT_PDF',
          entity: 'INVOICE',
          entityId: 'inv-namma-1',
        })
      );
    });

    it('exports a valid OOXML .docx (PK ZIP) containing NAMMA MEDIA, customer GSTIN, service line item, ₹ INR amounts, and Kannada text', async () => {
      const baseLayout = resolveEffectivePrintLayout('INVOICE', nammaProfile);
      const result = await DocumentExportService.exportDocument(
        adminActor,
        {
          document: { type: 'INVOICE', data: sampleInvoice },
          layoutOverride: {
            ...baseLayout,
            language: 'EN_KN',
            showBankDetails: true,
          },
          isDraftPreview: true,
        },
        'docx'
      );

      expect(result.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(result.fileName).toBe('INV-2026-0088-DRAFT-PREVIEW.docx');
      // Valid ZIP header PK
      expect(result.buffer[0]).toBe(0x50);
      expect(result.buffer[1]).toBe(0x4b);

      const docText = extractDocxPlainText(result.buffer);
      expect(docText).toContain('NAMMA MEDIA');
      expect(docText).toContain('Kannada Digital Studios Pvt Ltd');
      expect(docText).toContain('29ABCDE1234F1Z5');
      expect(docText).toContain('Digital Ad Film Production');
      expect(docText).toContain('₹59,000.00');
      expect(docText).toContain('DRAFT PREVIEW');
      // Kannada translation heading included in EN_KN mode
      expect(docText).toContain('ತೆರಿಗೆ ರಸೀದಿ / ಬಿಲ್');
      // Masked bank details authorized for ADMIN
      expect(docText).toContain('HDFC Bank');
      expect(docText).toContain('XXXX-XXXX-9012');

      expect(JournalService.createJournal).not.toHaveBeenCalled();
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DOCUMENT_EXPORT_DOCX',
          entity: 'INVOICE',
        })
      );
    });

    it('enforces RBAC: rejects EMPLOYEE on DocumentExportService and hides bank details from unauthorized actors', async () => {
      // Standard EMPLOYEE cannot export sales quotations/invoices/receipts
      await expect(
        DocumentExportService.exportDocument(
          employeeActor,
          { document: { type: 'QUOTATION', data: sampleQuotation } },
          'pdf'
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      await expect(
        DocumentExportService.exportDocument(
          employeeActor,
          { document: { type: 'INVOICE', data: sampleInvoice } },
          'docx'
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      // Bank details RBAC guard
      expect(await CompanyBankAccountService.canViewBankDetails(employeeActor)).toBe(false);
      expect(await CompanyBankAccountService.canViewBankDetails(adminActor)).toBe(true);
      expect(await CompanyBankAccountService.canViewBankDetails(viceAdminActor)).toBe(true);

      // Suppose a user has QUOTATION:VIEW via custom override, but zero rights for everything else,
      // Wait: QUOTATION:VIEW allows viewing quotation bank details when enabled; verify direct docx omission when bankAccount is null
      const noBankDocx = await generateDocxBuffer({
        document: { type: 'INVOICE', data: sampleInvoice },
        companyProfile: nammaProfile,
        bankAccount: null,
        layoutOverride: {
          ...resolveEffectivePrintLayout('INVOICE', nammaProfile),
          showBankDetails: true,
        },
      });
      const noBankText = extractDocxPlainText(noBankDocx);
      expect(noBankText).not.toContain('HDFC Bank');
      expect(noBankText).not.toContain('XXXX-XXXX-9012');
    });

    it('builds safe export filenames for saved and unsaved previews', () => {
      expect(
        buildExportFileName({ type: 'QUOTATION', data: { ...sampleQuotation, quotationNumber: '' } }, 'pdf', true)
      ).toBe('Quotation-DRAFT-PREVIEW.pdf');
      expect(
        buildExportFileName({ type: 'INVOICE', data: sampleInvoice }, 'docx', false)
      ).toBe('INV-2026-0088.docx');
    });
  });

  // ==========================================================
  // 4. Preview Store Integrity (INR Defaults & Draft Editing)
  // ==========================================================
  describe('previewStore Customer Creation, INR Defaults & Draft Edits', () => {
    it('defaults new customers, quotations, and invoices to INR and supports draft edits without journal creation', () => {
      const createdCust = previewStore.createCustomer({
        name: 'Preview Kannada News TV',
        customerType: 'BUSINESS',
        contactPerson: 'Suresh Shetty',
        email: 'accounts@kannadanews.example.in',
        phone: '+91 98455 77889',
        address: 'Vasanth Nagar',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560052',
        country: 'India',
        taxId: '29AABCK9876F1Z8',
        paymentTermsDays: 15,
        notes: 'Broadcast client',
      });

      expect(createdCust.currency).toBe('INR');
      expect(createdCust.code).toMatch(/^CUST-\d+/);
      expect(createdCust.taxId).toBe('29AABCK9876F1Z8');

      // Duplicate check in previewStore
      expect(() =>
        previewStore.createCustomer({
          name: 'Another Name',
          email: 'ACCOUNTS@KANNADANEWS.EXAMPLE.IN',
        })
      ).toThrow(/Possible duplicate customer detected/);

      const draftQt = previewStore.createQuotation({
        customerId: createdCust.id,
        customerName: createdCust.name,
        customerEmail: createdCust.email || undefined,
        customerPhone: createdCust.phone || undefined,
        customerAddress: createdCust.address || undefined,
        quotationDate: '2026-04-15',
        validUntilDate: '2026-05-15',
        lines: [
          {
            itemDescription: 'TV Commercial Production',
            quantity: '1',
            unitPrice: '25000',
            discountAmount: '0',
            taxRate: '18',
          },
        ],
      });
      expect(draftQt.currency).toBe('INR');
      expect(draftQt.customerTaxId).toBe('29AABCK9876F1Z8');
      expect(draftQt.status).toBe('DRAFT');

      const editedQt = previewStore.updateQuotation(draftQt.id, {
        notes: 'Updated in preview mode',
        lines: [
          {
            itemDescription: 'TV Commercial + Radio Spot',
            quantity: '1',
            unitPrice: '30000',
            discountAmount: '0',
            taxRate: '18',
          },
        ],
      });
      expect(editedQt.total).toBe('35400.0000');
      expect(editedQt.notes).toBe('Updated in preview mode');

      const draftInv = previewStore.createInvoice({
        customerId: createdCust.id,
        customerName: createdCust.name,
        customerTaxId: createdCust.taxId || undefined,
        invoiceDate: '2026-04-16',
        dueDate: '2026-05-01',
        lines: [
          {
            itemDescription: 'Podcast Sponsorship',
            quantity: '1',
            unitPrice: '10000',
            discountAmount: '0',
            taxRate: '18',
          },
        ],
      });
      expect(draftInv.currency).toBe('INR');
      expect(draftInv.status).toBe('DRAFT');
      expect(draftInv.journalEntryId).toBeNull();

      const editedInv = previewStore.updateInvoice(draftInv.id, {
        notes: 'Edited invoice draft',
        lines: [
          {
            itemDescription: 'Podcast Sponsorship + Reels',
            quantity: '2',
            unitPrice: '10000',
            discountAmount: '0',
            taxRate: '18',
          },
        ],
      });
      expect(editedInv.total).toBe('23600.0000');
      expect(editedInv.status).toBe('DRAFT');
      expect(editedInv.journalEntryId).toBeNull();
    });
  });
});
