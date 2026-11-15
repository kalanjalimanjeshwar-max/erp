import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  formatDateTimeInTimezone,
  formatTimeInTimezone,
  formatDateInTimezone,
  formatUtcTimestamp,
  getEffectiveTimeZone,
  getTimezoneShortName,
  isValidTimeZone,
} from '../../src/shared/timezone.js';
import {
  formatMoney,
  formatNumberForCurrency,
  getCurrencySymbol,
  normalizeCurrencyCode,
} from '../../src/shared/currency.js';
import {
  DOCUMENT_PRINT_SETTING_KEY,
  PAPER_DIMENSIONS_MM,
  createDefaultPrintSettings,
  mergeDocumentPrintSettings,
  validatePrintSettingsPayload,
} from '../../src/shared/print-settings.js';
import {
  DOCUMENT_PRINT_LABELS,
  getDocumentLabel,
} from '../../src/shared/print-translations.js';
import { CompanyService } from '../../src/server/services/company.service.js';
import { QuotationService } from '../../src/server/services/quotation.service.js';
import { BillingService } from '../../src/server/services/billing.service.js';
import { CustomerService } from '../../src/server/services/customer.service.js';
import { CoaService } from '../../src/server/services/coa.service.js';
import { CompanyBankAccountService } from '../../src/server/services/company-bank-account.service.js';
import { ExpenseClaimService } from '../../src/server/services/expense-claim.service.js';
import { EncryptionService } from '../../src/server/security/encryption.service.js';
import { JournalService } from '../../src/server/services/journal.service.js';
import { prisma } from '../../src/server/db/client.js';
import { AuthUser } from '../../src/shared/types.js';
import { Decimal } from '../../src/server/accounting/decimal-math.js';

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
      companySettingsChangeRequest: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
      currencyConfig: {
        findUnique: vi.fn(),
      },
      quotation: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      quotationLine: {
        create: vi.fn(),
      },
      invoice: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      invoiceLine: {
        create: vi.fn(),
      },
      customer: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      accountGroup: {
        findUnique: vi.fn(),
      },
      accountLedger: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      companyBankAccount: {
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      employee: {
        findFirst: vi.fn(),
      },
      fiscalPeriod: {
        findFirst: vi.fn(),
      },
      expenseClaim: {
        create: vi.fn(),
        findUnique: vi.fn(),
      },
      expenseClaimAttachment: {
        updateMany: vi.fn(),
      },
      expenseClaimEvent: {
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb) => cb(prisma)),
    },
  };
});

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/server/services/document-sequence.service.js', () => ({
  DocumentSequenceService: {
    allocateNextNumber: vi.fn(async (_companyId: string, docType: string) => ({
      formattedNumber: `${docType.slice(0, 3)}-2026-0001`,
      sequenceNumber: 1,
      prefix: docType.slice(0, 3),
      fiscalYear: '2026',
    })),
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

describe('CoreERP Timezone, Currency & Document Print Configuration Audit', () => {
  const companyId = 'company-namma-media-01';
  const testKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const superAdminActor: AuthUser = {
    id: 'user-sa-1',
    userId: 'user-sa-1',
    companyId,
    email: 'founder@nammamedia.in',
    fullName: 'Founder SuperAdmin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const adminActor: AuthUser = {
    id: 'user-adm-1',
    userId: 'user-adm-1',
    companyId,
    email: 'ops@nammamedia.in',
    fullName: 'Operations Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeActor: AuthUser = {
    id: 'user-emp-1',
    userId: 'user-emp-1',
    companyId,
    email: 'producer@nammamedia.in',
    fullName: 'Studio Producer',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    EncryptionService.resetKeyRingForTesting();
    EncryptionService.registerKey('k1', Buffer.from(testKeyHex, 'hex'), true);
    (prisma.$transaction as any).mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(prisma));
  });

  // =========================================================================
  // 1. Timezone Standardization (Asia/Kolkata + Multi-Timezone Flexibility)
  // =========================================================================
  describe('1. Timezone Standardization & Traceability', () => {
    it('formats UTC timestamps accurately in Asia/Kolkata (IST, UTC+5:30) without altering source UTC', () => {
      const utcIso = '2026-11-14T15:30:00.000Z';
      const formattedIst = formatDateTimeInTimezone(utcIso, 'Asia/Kolkata', {
        includeZoneAbbr: true,
      });

      expect(formattedIst).toBe('2026-11-14 21:00 IST');
      expect(formatDateTimeInTimezone(utcIso, 'Asia/Kolkata', { includeSeconds: true })).toBe(
        '2026-11-14 21:00:00'
      );
      expect(formatUtcTimestamp(utcIso)).toBe('2026-11-14 15:30:00 UTC');
      // Verify source string remains immutable
      expect(utcIso).toBe('2026-11-14T15:30:00.000Z');
    });

    it('handles midnight UTC date rollover cleanly in Asia/Kolkata', () => {
      const lateUtc = '2026-11-14T19:00:00.000Z'; // 00:30 IST next day (Nov 15)
      expect(formatDateInTimezone(lateUtc, 'Asia/Kolkata')).toBe('2026-11-15');
      expect(formatTimeInTimezone(lateUtc, 'Asia/Kolkata', { includeZoneAbbr: true })).toBe(
        '00:30 IST'
      );
    });

    it('supports multi-timezone companies dynamically (America/New_York, UTC)', () => {
      const winterUtc = '2026-01-15T18:00:00.000Z';
      expect(formatDateTimeInTimezone(winterUtc, 'UTC', { includeZoneAbbr: true })).toBe(
        '2026-01-15 18:00 UTC'
      );
      const nyFormatted = formatDateTimeInTimezone(winterUtc, 'America/New_York', {
        includeZoneAbbr: true,
      });
      expect(nyFormatted).toMatch(/^2026-01-15 13:00/);
      expect(getTimezoneShortName('Asia/Kolkata', new Date(winterUtc))).toBe('IST');
    });

    it('validates IANA timezones and falls back safely to UTC for invalid inputs', () => {
      expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
      expect(isValidTimeZone('America/New_York')).toBe(true);
      expect(isValidTimeZone('Invalid/Zone_XYZ')).toBe(false);
      expect(getEffectiveTimeZone('Invalid/Zone_XYZ')).toBe('UTC');
      expect(getEffectiveTimeZone(null)).toBe('UTC');
    });
  });

  // =========================================================================
  // 2. Currency Standardization (INR + Multi-Currency + Precision)
  // =========================================================================
  describe('2. Currency Standardization & Precision Formatting', () => {
    it('formats INR amounts with Indian grouping and symbol/code/both display modes', () => {
      expect(getCurrencySymbol('INR')).toBe('₹');
      expect(formatMoney(125000, 'INR')).toBe('₹1,25,000.00');
      expect(formatMoney(125000, 'INR', { displayMode: 'code' })).toBe('INR 1,25,000.00');
      expect(formatMoney(125000, 'INR', { displayMode: 'both' })).toBe('₹1,25,000.00 (INR)');
      expect(formatMoney(-500, 'INR')).toBe('-₹500.00');
    });

    it('respects configurable rounding precision (0, 2, 4 decimals) and multi-currency symbols', () => {
      expect(formatNumberForCurrency('1234.5678', 'INR', 0)).toBe('1,235');
      expect(formatNumberForCurrency('1234.5678', 'INR', 2)).toBe('1,234.57');
      expect(formatNumberForCurrency('1234.5678', 'INR', 4)).toBe('1,234.5678');
      expect(formatMoney(999.5, 'USD')).toBe('$999.50');
      expect(formatMoney(1000, 'JPY')).toBe('¥1,000');
      expect(formatMoney(500, 'AED')).toBe('AED 500.00');
      expect(normalizeCurrencyCode(' inr ')).toBe('INR');
    });
  });

  // =========================================================================
  // 3. Backend Service Base-Currency Defaults & Multi-Currency Preservation
  // =========================================================================
  describe('3. Backend Base Currency Resolution (INR Company)', () => {
    beforeEach(() => {
      (prisma.company.findUnique as any).mockResolvedValue({
        id: companyId,
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        defaultDocumentLanguage: 'EN_KN',
      });
    });

    it('CompanyService.getBaseCurrency resolves company configured currency (INR)', async () => {
      const currency = await CompanyService.getBaseCurrency(companyId);
      expect(currency).toBe('INR');
    });

    it('CustomerService.createCustomer defaults to INR when omitted, preserves explicit USD', async () => {
      (prisma.customer.findUnique as any).mockResolvedValue(null);
      (prisma.customer.create as any).mockImplementation(async ({ data }: any) => ({
        id: 'cust-1',
        ...data,
        createdAt: new Date('2026-11-14T10:00:00Z'),
        receivableLedger: null,
      }));

      const inrCust = await CustomerService.createCustomer(adminActor, {
        code: 'CUST-IN-01',
        name: 'Bengaluru Client',
      });
      expect(inrCust.currency).toBe('INR');

      const usdCust = await CustomerService.createCustomer(adminActor, {
        code: 'CUST-US-01',
        name: 'Austin Client',
        currency: 'USD',
      });
      expect(usdCust.currency).toBe('USD');
    });

    it('CoaService.createLedger defaults ledger currency to INR when omitted', async () => {
      (prisma.accountGroup.findUnique as any).mockResolvedValue({
        id: 'grp-inc-1',
        companyId,
        name: 'Operating Revenue',
        rootType: 'INCOME',
      });
      (prisma.accountLedger.findFirst as any).mockResolvedValue(null);
      (prisma.accountLedger.create as any).mockImplementation(async ({ data }: any) => ({
        id: 'led-1',
        ...data,
        openingBalance: new Decimal(data.openingBalance || 0),
        createdAt: new Date('2026-11-14T10:00:00Z'),
        group: { name: 'Operating Revenue', rootType: 'INCOME' },
      }));

      const ledger = await CoaService.createLedger(adminActor, {
        groupId: 'grp-inc-1',
        code: '4010',
        name: 'Media Production Revenue',
      });
      expect(ledger.currency).toBe('INR');
    });

    it('CompanyBankAccountService.createBankAccount defaults currency to INR when omitted', async () => {
      (prisma.companyBankAccount.create as any).mockImplementation(async ({ data }: any) => ({
        id: 'bank-1',
        ...data,
        createdAt: new Date('2026-11-14T10:00:00Z'),
        updatedAt: new Date('2026-11-14T10:00:00Z'),
      }));

      const bank = await CompanyBankAccountService.createBankAccount(adminActor, {
        bankName: 'HDFC Bank',
        accountHolderName: 'NAMMA MEDIA',
        accountNumber: '50200012345678',
      });
      expect(bank.currency).toBe('INR');
    });

    it('ExpenseClaimService.createClaim defaults claim currency to INR when omitted', async () => {
      (prisma.employee.findFirst as any).mockResolvedValue({
        id: 'emp-1',
        companyId,
        userId: employeeActor.userId,
        employeeCode: 'NM-001',
        fullName: 'Studio Producer',
      });

      let savedClaim: any = null;
      (prisma.expenseClaim.create as any).mockImplementation(async ({ data }: any) => {
        savedClaim = {
          id: 'exp-1',
          ...data,
          originalExpenseDate: new Date(data.originalExpenseDate),
          createdAt: new Date('2026-11-14T10:00:00Z'),
          updatedAt: new Date('2026-11-14T10:00:00Z'),
          submittedAt: null,
          managerApprovedAt: null,
          accountsApprovedAt: null,
          paidAt: null,
          rejectedAt: null,
          cancelledAt: null,
          employee: { id: 'emp-1', fullName: 'Studio Producer', employeeCode: 'NM-001', department: null },
          manager: null,
          managerApprovedBy: null,
          accountsApprovedBy: null,
          paidBy: null,
          expenseLedger: null,
          payableLedger: null,
          bankLedger: null,
          bankAccount: null,
          journalEntry: null,
          paymentJournalEntry: null,
          lines: [],
          attachments: [],
          events: [],
        };
        return savedClaim;
      });
      (prisma.expenseClaim.findUnique as any).mockImplementation(async () => savedClaim);

      const claim = await ExpenseClaimService.createClaim(employeeActor, {
        title: 'Studio Camera Rental',
        originalExpenseDate: '2026-11-14',
        lines: [
          {
            category: 'OTHER',
            description: 'Cinema lens rental',
            expenseDate: '2026-11-14',
            amount: 4500,
          },
        ],
      });

      expect(claim.currency).toBe('INR');
    });
  });

  // =========================================================================
  // 4. Document Print Settings Persistence & Validation
  // =========================================================================
  describe('4. Persistent Document Print Settings & Paper Geometry', () => {
    it('defines standard A4, A5, and Letter paper dimensions in millimeters', () => {
      expect(PAPER_DIMENSIONS_MM.A4).toEqual({ width: 210, height: 297 });
      expect(PAPER_DIMENSIONS_MM.A5).toEqual({ width: 148, height: 210 });
      expect(PAPER_DIMENSIONS_MM.Letter).toEqual({ width: 215.9, height: 279.4 });
    });

    it('creates independent per-document defaults for QUOTATION, INVOICE, and RECEIPT', () => {
      const defaults = createDefaultPrintSettings({ defaultDocumentLanguage: 'EN_KN' });
      expect(defaults.version).toBe(1);
      expect(defaults.layouts.QUOTATION.language).toBe('EN_KN');
      expect(defaults.layouts.INVOICE.showBankDetails).toBe(true);
      expect(defaults.layouts.QUOTATION.showBankDetails).toBe(false);
      expect(defaults.layouts.RECEIPT.showTaxColumn).toBe(false);
    });

    it('rejects invalid paperSize, orientation, language, margins, and XSS URLs', () => {
      expect(
        validatePrintSettingsPayload({
          layouts: { INVOICE: { paperSize: 'Tabloid' } },
        }).valid
      ).toBe(false);

      expect(
        validatePrintSettingsPayload({
          layouts: { QUOTATION: { orientation: 'diagonal' } },
        }).valid
      ).toBe(false);

      expect(
        validatePrintSettingsPayload({
          layouts: { RECEIPT: { language: 'FR' } },
        }).valid
      ).toBe(false);

      expect(
        validatePrintSettingsPayload({
          layouts: { INVOICE: { margins: { topMm: 2, rightMm: 14, bottomMm: 14, leftMm: 14 } } },
        }).valid
      ).toBe(false);

      expect(
        validatePrintSettingsPayload({
          layouts: { INVOICE: { signatureUrl: 'javascript:alert(1)' } },
        }).valid
      ).toBe(false);
    });

    it('persists and merges per-document settings under DOCUMENT_PRINT_SETTINGS_V1', async () => {
      const customLayout = createDefaultPrintSettings({ defaultDocumentLanguage: 'EN' });
      customLayout.layouts.INVOICE.paperSize = 'A5';
      customLayout.layouts.INVOICE.orientation = 'landscape';
      customLayout.layouts.INVOICE.language = 'EN_KN';
      customLayout.layouts.INVOICE.currencyDisplayMode = 'both';
      customLayout.layouts.INVOICE.margins = { topMm: 10, rightMm: 12, bottomMm: 10, leftMm: 12 };

      (prisma.company.findUnique as any).mockResolvedValue({
        id: companyId,
        defaultDocumentLanguage: 'EN',
      });
      (prisma.companySetting.findUnique as any).mockResolvedValueOnce(null);
      (prisma.companySetting.upsert as any).mockResolvedValue({
        companyId,
        key: DOCUMENT_PRINT_SETTING_KEY,
        value: JSON.stringify(customLayout),
      });

      const res = await CompanyService.updatePrintSettings(superAdminActor, customLayout);
      expect(res.pendingApproval).toBe(false);
      expect(res.printSettings.layouts.INVOICE.paperSize).toBe('A5');
      expect(res.printSettings.layouts.INVOICE.orientation).toBe('landscape');
      expect(res.printSettings.layouts.INVOICE.language).toBe('EN_KN');
      expect(prisma.companySetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            companyId_key: { companyId, key: DOCUMENT_PRINT_SETTING_KEY },
          },
        })
      );

      // Verify round-trip read merge
      const merged = mergeDocumentPrintSettings(JSON.stringify(customLayout));
      expect(merged.layouts.INVOICE.margins).toEqual({
        topMm: 10,
        rightMm: 12,
        bottomMm: 10,
        leftMm: 12,
      });
      expect(merged.layouts.QUOTATION.paperSize).toBe('A4');
    });
  });

  // =========================================================================
  // 5. Kannada (KN) & Bilingual (EN_KN) Translations
  // =========================================================================
  describe('5. Kannada (KN) & Bilingual (EN_KN) Document Labels', () => {
    it('returns English, Kannada, or dual EN+KN labels for every print translation key', () => {
      const keys = Object.keys(DOCUMENT_PRINT_LABELS) as Array<keyof typeof DOCUMENT_PRINT_LABELS>;
      expect(keys.length).toBeGreaterThan(20);

      const enInvoice = getDocumentLabel('invoice', 'EN');
      expect(enInvoice).toEqual({ primary: 'TAX INVOICE' });

      const knInvoice = getDocumentLabel('invoice', 'KN');
      expect(knInvoice.primary).toMatch(/[\u0C80-\u0CFF]/);
      expect(knInvoice.secondary).toBeUndefined();

      const dualQuotation = getDocumentLabel('quotation', 'EN_KN');
      expect(dualQuotation.primary).toBe('QUOTATION');
      expect(dualQuotation.secondary).toMatch(/[\u0C80-\u0CFF]/);

      for (const k of keys) {
        const kn = getDocumentLabel(k, 'KN');
        expect(kn.primary).toMatch(/[\u0C80-\u0CFF]/);
      }
    });
  });

  // =========================================================================
  // 6. RBAC & Maker-Checker Governance for Print Settings
  // =========================================================================
  describe('6. Security, RBAC & Maker-Checker Governance', () => {
    it('rejects EMPLOYEE role attempting to modify document print settings with HTTP 403', async () => {
      const payload = createDefaultPrintSettings();
      await expect(
        CompanyService.updatePrintSettings(employeeActor, payload)
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('routes ADMIN print settings update through PENDING CompanySettingsChangeRequest and applies on SUPER_ADMIN approval', async () => {
      const proposed = createDefaultPrintSettings();
      proposed.layouts.QUOTATION.language = 'KN';

      (prisma.company.findUnique as any).mockResolvedValue({
        id: companyId,
        code: 'NM',
        name: 'NAMMA MEDIA',
        legalName: 'Namma Media Pvt Ltd',
        taxId: '29ABCDE1234F1Z5',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        defaultDocumentLanguage: 'EN_KN',
      });
      (prisma.companySetting.findUnique as any).mockResolvedValue(null);
      (prisma.companySetting.findMany as any).mockResolvedValue([]);
      (prisma.currencyConfig.findUnique as any).mockResolvedValue({ roundingPrecision: 2 });

      let storedChangeRequest: any = null;
      (prisma.companySettingsChangeRequest.create as any).mockImplementation(async ({ data }: any) => {
        storedChangeRequest = {
          id: 'cr-print-1',
          ...data,
          rejectionReason: null,
          reviewedById: null,
          reviewedAt: null,
          appliedAt: null,
          createdAt: new Date('2026-11-14T10:00:00Z'),
          updatedAt: new Date('2026-11-14T10:00:00Z'),
          requestedBy: { fullName: adminActor.fullName, email: adminActor.email },
          reviewedBy: null,
        };
        return storedChangeRequest;
      });

      const adminResult = await CompanyService.updatePrintSettings(adminActor, proposed);
      expect(adminResult.pendingApproval).toBe(true);
      expect(adminResult.changeRequest?.status).toBe('PENDING');
      expect(prisma.companySetting.upsert).not.toHaveBeenCalled();

      // Now SUPER_ADMIN approves
      (prisma.companySettingsChangeRequest.findUnique as any).mockResolvedValue(storedChangeRequest);
      (prisma.companySettingsChangeRequest.update as any).mockResolvedValue({
        ...storedChangeRequest,
        status: 'APPROVED',
        reviewedById: superAdminActor.userId,
        reviewedAt: new Date('2026-11-14T10:05:00Z'),
        appliedAt: new Date('2026-11-14T10:05:00Z'),
        reviewedBy: { fullName: superAdminActor.fullName },
      });

      const approved = await CompanyService.approveChangeRequest(superAdminActor, 'cr-print-1');
      expect(approved.request.status).toBe('APPROVED');
      expect(prisma.companySetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId_key: { companyId, key: DOCUMENT_PRINT_SETTING_KEY } },
        })
      );
    });
  });

  // =========================================================================
  // 7. Service-Based Business Flow (NAMMA MEDIA: Quotation -> Invoice)
  // =========================================================================
  describe('7. Service-Based Quotation to Invoice & Journal Neutrality', () => {
    it('creates service quotation in INR with zero journal writes and preserves INR/service lines when converted to invoice', async () => {
      (prisma.company.findUnique as any).mockResolvedValue({
        id: companyId,
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      });
      (prisma.companySetting.findUnique as any).mockResolvedValue({
        companyId,
        key: 'SALES_INVOICE_ENABLED',
        value: 'true',
      });

      let storedQuotation: any = null;
      const quotationLines: any[] = [];
      (prisma.quotation.create as any).mockImplementation(async ({ data }: any) => {
        storedQuotation = {
          id: 'qtn-service-1',
          ...data,
          quotationDate: new Date(data.quotationDate),
          validUntilDate: new Date(data.validUntilDate),
          createdAt: new Date('2026-11-14T09:00:00Z'),
          createdByUser: { fullName: adminActor.fullName },
          lines: quotationLines,
        };
        return storedQuotation;
      });
      (prisma.quotationLine.create as any).mockImplementation(async ({ data }: any) => {
        const line = { id: `ql-${quotationLines.length + 1}`, ...data };
        quotationLines.push(line);
        return line;
      });
      (prisma.quotation.findUnique as any).mockImplementation(async () => storedQuotation);
      (prisma.quotation.update as any).mockImplementation(async ({ data }: any) => {
        storedQuotation = { ...storedQuotation, ...data };
        return storedQuotation;
      });

      // Step 1: Create service quotation for NAMMA MEDIA (hours/deliverables, no stock/inventory)
      const quotation = await QuotationService.createQuotation(adminActor, {
        customerName: 'Kannada Television Network',
        quotationDate: '2026-11-14',
        validUntilDate: '2026-11-30',
        documentTitle: 'SERVICE QUOTATION',
        lines: [
          {
            itemDescription: 'Post-Production Video Editing & Color Grading (40 hrs)',
            quantity: '40',
            unitPrice: '2500',
            discountAmount: '5000',
            taxRate: '18',
          },
          {
            itemDescription: 'Motion Graphics & Bilingual Kannada Title Package',
            quantity: '1',
            unitPrice: '35000',
            discountAmount: '0',
            taxRate: '18',
          },
        ],
      });

      expect(quotation.currency).toBe('INR');
      // Verify exact service math:
      // Line 1: 40 * 2500 = 100,000 - 5,000 = 95,000 + 18% (17,100) = 112,100
      // Line 2: 1 * 35,000 = 35,000 + 18% (6,300) = 41,300
      // Subtotal = 135,000; Discount = 5,000; Tax = 23,400; Total = 153,400
      expect(quotation.subtotal).toBe('135000.0000');
      expect(quotation.discountTotal).toBe('5000.0000');
      expect(quotation.taxTotal).toBe('23400.0000');
      expect(quotation.total).toBe('153400.0000');
      // Critical accounting rule: quotations create ZERO journal entries
      expect(JournalService.createJournal).not.toHaveBeenCalled();

      // Step 2: Convert Quotation to Draft Invoice and verify currency & lines preservation
      let storedInvoice: any = null;
      const invoiceLines: any[] = [];
      (prisma.invoice.create as any).mockImplementation(async ({ data }: any) => {
        storedInvoice = {
          id: 'inv-service-1',
          ...data,
          invoiceDate: new Date(data.invoiceDate),
          dueDate: new Date(data.dueDate),
          issuedAt: null,
          voidedAt: null,
          createdAt: new Date('2026-11-14T09:10:00Z'),
          createdByUser: { fullName: adminActor.fullName },
          issuedByUser: null,
          voidedByUser: null,
          journalEntry: null,
          customer: null,
          lines: invoiceLines,
          allocations: [],
        };
        return storedInvoice;
      });
      (prisma.invoiceLine.create as any).mockImplementation(async ({ data }: any) => {
        const line = { id: `il-${invoiceLines.length + 1}`, ...data, revenueLedger: null };
        invoiceLines.push(line);
        return line;
      });
      (prisma.invoice.findUnique as any).mockImplementation(async () => storedInvoice);

      const convertedInvoice = await BillingService.convertQuotationToInvoice(
        adminActor,
        quotation.id
      );
      expect(convertedInvoice.status).toBe('DRAFT');
      expect(convertedInvoice.currency).toBe('INR');
      expect(convertedInvoice.quotationId).toBe(quotation.id);
      expect(convertedInvoice.lines).toHaveLength(2);
      expect(convertedInvoice.lines[0].itemDescription).toContain('Post-Production Video Editing');
      expect(convertedInvoice.total).toBe('153400.0000');
      // Draft invoice also creates 0 journal entries until issued
      expect(JournalService.createJournal).not.toHaveBeenCalled();

      // Step 3: Issue Invoice -> posts balanced double-entry journal
      (prisma.companySetting.findUnique as any).mockImplementation(async ({ where }: any) => {
        const key = where?.companyId_key?.key;
        if (key === 'SALES_INVOICE_ENABLED') return { value: 'true' };
        if (key === 'DEFAULT_RECEIVABLES_LEDGER_ID') return { value: 'led-ar-1' };
        if (key === 'DEFAULT_REVENUE_LEDGER_ID') return { value: 'led-rev-1' };
        if (key === 'DEFAULT_TAX_PAYABLE_LEDGER_ID') return { value: 'led-gst-1' };
        return null;
      });
      (prisma.accountLedger.findUnique as any).mockImplementation(async ({ where }: any) => ({
        id: where.id,
        companyId,
        isActive: true,
      }));
      (prisma.invoice.update as any).mockImplementation(async ({ data }: any) => {
        storedInvoice = { ...storedInvoice, ...data };
        return storedInvoice;
      });

      const issued = await BillingService.issueInvoice(adminActor, convertedInvoice.id);
      expect(issued.status).toBe('ISSUED');
      expect(JournalService.createJournal).toHaveBeenCalledTimes(1);
      expect(JournalService.createJournal).toHaveBeenCalledWith(
        adminActor,
        expect.objectContaining({
          autoPost: true,
          lines: expect.arrayContaining([
            expect.objectContaining({ ledgerId: 'led-ar-1', debit: '153400.0000', credit: '0.0000' }),
            expect.objectContaining({ ledgerId: 'led-rev-1', debit: '0.0000', credit: '130000.0000' }),
            expect.objectContaining({ ledgerId: 'led-gst-1', debit: '0.0000', credit: '23400.0000' }),
          ]),
        }),
        undefined
      );
    });
  });
});
