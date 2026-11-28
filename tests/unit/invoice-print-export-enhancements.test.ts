import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/server/db/client.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { BrandingAssetService } from '../../src/server/services/branding-asset.service.js';
import { CompanyBankAccountService } from '../../src/server/services/company-bank-account.service.js';
import { CompanyService } from '../../src/server/services/company.service.js';
import { DocumentExportService } from '../../src/server/services/document-export.service.js';
import { PermissionService } from '../../src/server/services/permission.service.js';
import {
  formatCompanyAddressLines,
  formatCompanyAddressText,
  mergeSnapshotIntoCompanyProfile,
  resolveCompanyContactParts,
  resolveCompanyTaxId,
  resolveDocumentEffectiveBranding,
  resolvePaymentQrDisplaySizeMm,
  shouldDisplayPaymentQr,
} from '../../src/shared/export/document-branding.js';
import { generateDocxBuffer } from '../../src/shared/export/docx-builder.js';
import {
  buildDocumentSpreadsheetRows,
  generateXlsxBytes,
} from '../../src/shared/export/xlsx-builder.js';
import { listZipEntryNames } from '../../src/shared/export/zip-writer.js';
import {
  packageRenderedImagePages,
  planImageExportPages,
  resolveImageExportColumns,
  resolveImageExportVisibility,
} from '../../src/client/utils/invoice-image-export.ts';
import {
  decodePreviewRasterDataUri,
  getDocumentPreviewResetKey,
} from '../../src/client/components/print/PrintableDocumentView.tsx';
import {
  createDefaultPrintSettings,
  mergeDocumentPrintSettings,
  validatePrintSettingsPayload,
} from '../../src/shared/print-settings.js';
import {
  MAX_BRANDING_FILE_SIZE_BYTES,
  normalizeDocumentVisualElements,
} from '../../src/shared/branding.js';
import {
  AuthUser,
  CompanyProfile,
  CustomerReceiptItem,
  DocumentBrandingSnapshot,
  InvoiceItem,
} from '../../src/shared/types.ts';

function makeValidPngBuffer(width: number, height: number, fillByte = 0x24): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }

  const crc32 = (buf: Buffer) => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };

  const makeChunk = (type: string, data: Buffer) => {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height, fillByte);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeMinimalJpegBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xc0;
  buf.writeUInt16BE(11, 4);
  buf[6] = 8;
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  buf[11] = 3;
  buf[22] = 0xff;
  buf[23] = 0xd9;
  return buf;
}

function makeMinimalWebpBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  buf[24] = wMinus1 & 0xff;
  buf[25] = (wMinus1 >> 8) & 0xff;
  buf[26] = (wMinus1 >> 16) & 0xff;
  buf[27] = hMinus1 & 0xff;
  buf[28] = (hMinus1 >> 8) & 0xff;
  buf[29] = (hMinus1 >> 16) & 0xff;
  return buf;
}

/**
 * Extracts a single entry payload (stored or deflated) from a ZIP buffer using the Central Directory,
 * supporting both standard ZIPs and JSZip/docx data-descriptor entries.
 */
function readZipEntryText(zipBytes: Uint8Array, targetEntryName: string): string {
  const buf = Buffer.from(zipBytes);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP buffer: EOCD not found');
  }
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);

  let ptr = cdOffset;
  for (let i = 0; i < totalEntries && ptr + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const compressionMethod = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    if (name === targetEntryName) {
      const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const slice = buf.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === 0) return slice.toString('utf8');
      if (compressionMethod === 8) return zlib.inflateRawSync(slice).toString('utf8');
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP entry not found: ${targetEntryName}`);
}

const CREATED_COMPANY_IDS: string[] = [];

const COMPANY_A_ID = 'test-co-print-enh-a';
const COMPANY_B_ID = 'test-co-print-enh-b';

const superAdminA: AuthUser = {
  id: 'usr-sa-a',
  userId: 'usr-sa-a',
  companyId: COMPANY_A_ID,
  email: 'sa@acme-print.test',
  fullName: 'Super Admin A',
  role: 'SUPER_ADMIN',
  isActive: true,
  tokenVersion: 1,
};

const adminA: AuthUser = {
  id: 'usr-adm-a',
  userId: 'usr-adm-a',
  companyId: COMPANY_A_ID,
  email: 'admin@acme-print.test',
  fullName: 'Admin A',
  role: 'ADMIN',
  isActive: true,
  tokenVersion: 1,
};

const employeeA: AuthUser = {
  id: 'usr-emp-a',
  userId: 'usr-emp-a',
  companyId: COMPANY_A_ID,
  email: 'emp@acme-print.test',
  fullName: 'Employee A',
  role: 'EMPLOYEE',
  isActive: true,
  tokenVersion: 1,
};

function buildCompanyProfile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    id: COMPANY_A_ID,
    name: 'Acme Studio Systems',
    legalName: 'Acme Studio Systems Private Limited',
    code: 'ACME',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    roundingPrecision: 2,
    email: 'accounts@acmestudio.test',
    phone: '+91 80 4123 9988',
    website: 'https://acmestudio.test',
    taxId: '29AABCA1234F1Z5',
    taxRegistrationNumber: '29AABCA1234F1Z5',
    addressLine1: '42 MG Road, 3rd Floor',
    addressLine2: 'Indiranagar',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560038',
    country: 'India',
    address: '42 MG Road, 3rd Floor, Indiranagar, Bengaluru, Karnataka 560038, India',
    logoUrl: null,
    sealUrl: null,
    signatureUrl: null,
    paymentQrUrl: null,
    brandingAssets: {
      version: 1,
      logo: null,
      seal: null,
      signature: null,
      paymentQr: null,
    },
    documentBranding: {
      logoSize: 'md',
      logoAlignment: 'left',
      sealUrl: null,
      signatureUrl: null,
      paymentQrUrl: null,
      signatoryName: null,
      signatureTitle: null,
    },
    printSettings: createDefaultPrintSettings(),
    ...overrides,
  };
}

function buildSampleInvoice(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'inv-enh-0021',
    companyId: COMPANY_A_ID,
    invoiceNumber: 'INV-2026-0021',
    quotationId: null,
    documentTitle: 'TAX INVOICE',
    customerId: 'cust-1',
    customerName: 'Horizon Ventures LLP',
    customerAddress: '88 Residency Road, Bengaluru 560025',
    customerEmail: 'ap@horizon.test',
    customerPhone: '+91 98450 11223',
    customerTaxId: '29AABCH9988K1Z2',
    invoiceDate: '2026-03-10',
    dueDate: '2026-03-25',
    currency: 'INR',
    status: 'ISSUED',
    subtotal: '10000.00',
    discountTotal: '500.00',
    taxTotal: '1710.00',
    total: '11210.00',
    amountPaid: '2000.00',
    balanceDue: '9210.00',
    notes: 'Thank you for your business.',
    terms: 'Payment due within 15 days.',
    journalEntryId: null,
    issuedAt: '2026-03-10T10:00:00.000Z',
    voidedAt: null,
    voidReason: null,
    lines: [
      {
        id: 'line-1',
        lineNumber: 1,
        itemDescription: 'Creative Production Retainer',
        quantity: '2.00',
        unitPrice: '4000.00',
        discountAmount: '500.00',
        taxRate: '18.00',
        taxAmount: '1350.00',
        lineTotal: '8850.00',
      },
      {
        id: 'line-2',
        lineNumber: 2,
        itemDescription: 'Post-Production Audio Mastering',
        quantity: '1.00',
        unitPrice: '2000.00',
        discountAmount: '0.00',
        taxRate: '18.00',
        taxAmount: '360.00',
        lineTotal: '2360.00',
      },
    ],
    createdAt: '2026-03-10T10:00:00.000Z',
    ...overrides,
  };
}

describe('CoreERP Safe Invoice Print & Export Enhancements', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const cid of CREATED_COMPANY_IDS) {
      const dir = path.resolve(process.cwd(), 'storage', 'branding', cid);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe('Feature 1 — Company Address in Print Output & Snapshot Safety', () => {
    it('1. Legacy invoice snapshot with null address falls back to current Company Address while honoring structured address fields', () => {
      const currentProfile = buildCompanyProfile();
      const legacySnapshot: DocumentBrandingSnapshot = {
        capturedAt: '2025-12-01T00:00:00.000Z',
        companyName: 'Acme Studio Systems',
        legalName: 'Acme Studio Systems Private Limited',
        address: null,
        phone: '+91 80 4123 9988',
        email: 'accounts@acmestudio.test',
        website: null,
        taxId: null,
        logoAssetId: null,
        logoUrl: null,
        sealAssetId: null,
        sealUrl: null,
        signatureAssetId: null,
        signatureUrl: null,
      };
      const legacyInvoice = buildSampleInvoice({ brandingSnapshot: legacySnapshot });

      const resolved = resolveDocumentEffectiveBranding(
        { type: 'INVOICE', data: legacyInvoice },
        currentProfile,
        undefined,
        false
      );

      const addressLines = formatCompanyAddressLines(resolved.effectiveProfile);
      expect(addressLines.length).toBeGreaterThan(0);
      expect(formatCompanyAddressText(resolved.effectiveProfile)).toContain('42 MG Road, 3rd Floor');
      expect(formatCompanyAddressText(resolved.effectiveProfile)).toContain('Bengaluru');
      expect(formatCompanyAddressText(resolved.effectiveProfile)).toContain('560038');
      expect(resolveCompanyTaxId(resolved.effectiveProfile)).toBe('29AABCA1234F1Z5');
    });

    it('2. Explicit historical snapshot address is preserved and NOT overwritten by updated current profile; hidden toggles are respected', async () => {
      const updatedCurrentProfile = buildCompanyProfile({
        address: 'New HQ Tower, Whitefield, Bengaluru 560066',
        addressLine1: 'New HQ Tower',
        addressLine2: 'Whitefield',
        city: 'Bengaluru',
        postalCode: '560066',
        taxId: '29NEWGST9999K1Z1',
        taxRegistrationNumber: '29NEWGST9999K1Z1',
      });

      const historicalSnapshot: DocumentBrandingSnapshot = {
        capturedAt: '2026-01-15T00:00:00.000Z',
        companyName: 'Acme Legacy Division',
        legalName: 'Acme Legacy Division Pvt Ltd',
        address: '10 Old Airport Road, Bengaluru 560017',
        phone: '+91 80 2222 3333',
        email: 'legacy@acmestudio.test',
        website: 'https://legacy.acmestudio.test',
        taxId: '29OLDGST1111F1Z9',
        logoAssetId: null,
        logoUrl: null,
        sealAssetId: null,
        sealUrl: null,
        signatureAssetId: null,
        signatureUrl: null,
      };

      const merged = mergeSnapshotIntoCompanyProfile(updatedCurrentProfile, historicalSnapshot);
      expect(merged.address).toBe('10 Old Airport Road, Bengaluru 560017');
      expect(formatCompanyAddressText(merged)).toBe('10 Old Airport Road, Bengaluru 560017');
      expect(formatCompanyAddressText(merged)).not.toContain('New HQ Tower');
      expect(resolveCompanyTaxId(merged)).toBe('29OLDGST1111F1Z9');

      // Intentionally hidden branding flags must suppress address/contact/taxId in DOCX output
      const hiddenLayout = {
        ...createDefaultPrintSettings().layouts.INVOICE,
        showCompanyContact: false,
        showCompanyTaxId: false,
      };
      const invoice = buildSampleInvoice({ brandingSnapshot: historicalSnapshot });
      const docxBuf = await generateDocxBuffer({
        document: { type: 'INVOICE', data: invoice },
        companyProfile: updatedCurrentProfile,
        layoutOverride: hiddenLayout,
      });
      const docXml = readZipEntryText(new Uint8Array(docxBuf), 'word/document.xml');
      expect(docXml).not.toContain('10 Old Airport Road');
      expect(docXml).not.toContain('29OLDGST1111F1Z9');
    });

    it('3. Hardcoded sample designer preview values are removed from VisualLayoutCanvas.tsx', () => {
      const canvasSrc = fs.readFileSync(
        path.resolve(process.cwd(), 'src/client/components/company/VisualLayoutCanvas.tsx'),
        'utf8'
      );
      expect(canvasSrc).not.toContain("'NAMMA MEDIA'");
      expect(canvasSrc).not.toContain("'Bengaluru, Karnataka'");
      expect(canvasSrc).not.toContain("'billing@nammamedia.in'");
      expect(canvasSrc).toContain('formatCompanyAddressLines');
      expect(canvasSrc).toContain('resolveCompanyContactParts');
      expect(canvasSrc).toContain('resolveCompanyTaxId');
    });

    it('4. CompanyService.updateProfile persists structured address & taxRegistrationNumber backward-compatibly', async () => {
      const updateCalls: Array<Record<string, unknown>> = [];
      const companyRecord = {
        id: COMPANY_A_ID,
        name: 'Acme Studio Systems',
        legalName: 'Acme Studio Systems Private Limited',
        code: 'ACME',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        roundingPrecision: 2,
        fiscalYearStartMonth: 4,
        email: 'accounts@acmestudio.test',
        phone: '+91 80 4123 9988',
        website: 'https://acmestudio.test',
        taxRegistrationNumber: '29AABCA1234F1Z5',
        addressLine1: '42 MG Road',
        addressLine2: 'Indiranagar',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560038',
        country: 'India',
        logoUrl: null,
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      };

      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue(companyRecord as never);
      vi.spyOn(prisma.company, 'update').mockImplementation(((args: { data: Record<string, unknown> }) => {
        updateCalls.push(args.data);
        return Promise.resolve({ ...companyRecord, ...args.data });
      }) as never);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null as never);
      vi.spyOn(prisma.companySetting, 'upsert').mockResolvedValue({} as never);
      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);

      // Existing legacy client call without structured address fields: must NOT overwrite structured columns
      await CompanyService.updateProfile(superAdminA, {
        name: 'Acme Studio Systems',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        email: 'accounts@acmestudio.test',
      });
      expect(updateCalls[0]).not.toHaveProperty('addressLine1');
      expect(updateCalls[0]).not.toHaveProperty('city');
      expect(updateCalls[0]).not.toHaveProperty('taxRegistrationNumber');

      // New client call WITH structured address fields + taxRegistrationNumber
      await CompanyService.updateProfile(superAdminA, {
        name: 'Acme Studio Systems',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        addressLine1: '101 Brigade Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        country: 'India',
        taxRegistrationNumber: '29AABCA1234F1Z5',
      });
      expect(updateCalls[1]).toMatchObject({
        addressLine1: '101 Brigade Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        country: 'India',
        taxRegistrationNumber: '29AABCA1234F1Z5',
      });
    });

    it('5. Deduplicated contact parts avoid repeating values', () => {
      const parts = resolveCompanyContactParts(
        buildCompanyProfile({
          phone: '+91 80 4123 9988',
          email: 'accounts@acmestudio.test',
          website: 'https://acmestudio.test',
        })
      );
      expect(parts).toEqual([
        '+91 80 4123 9988',
        'accounts@acmestudio.test',
        'https://acmestudio.test',
      ]);
    });
  });

  describe('Feature 2 — Upload Existing UPI QR Image (Security, RBAC, Tenant Isolation & Maker-Checker)', () => {
    it('6. Strict PAYMENT_QR validation accepts PNG & JPEG and rejects WebP, SVG, HTML, scripts, executables, MIME spoofing, and oversized files', () => {
      const validPng = makeValidPngBuffer(240, 240);
      const validJpg = makeMinimalJpegBuffer(240, 240);
      const validWebp = makeMinimalWebpBuffer(240, 240);

      expect(
        BrandingAssetService.validateImageBuffer(validPng, 'image/png', 'upi-qr.png', 'PAYMENT_QR')
      ).toMatchObject({ valid: true, mimeType: 'image/png', extension: 'png', widthPx: 240, heightPx: 240 });

      expect(
        BrandingAssetService.validateImageBuffer(validJpg, 'image/jpeg', 'upi-qr.jpg', 'PAYMENT_QR')
      ).toMatchObject({ valid: true, mimeType: 'image/jpeg', extension: 'jpg', widthPx: 240, heightPx: 240 });

      // WebP rejected for PAYMENT_QR (allowed for LOGO/SEAL/SIGNATURE only)
      const webpRes = BrandingAssetService.validateImageBuffer(
        validWebp,
        'image/webp',
        'upi-qr.webp',
        'PAYMENT_QR'
      );
      expect(webpRes.valid).toBe(false);
      expect(webpRes.error).toMatch(/PNG, JPG, and JPEG/i);

      // SVG / HTML / script payloads rejected
      const svgPayload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      expect(
        BrandingAssetService.validateImageBuffer(svgPayload, 'image/svg+xml', 'qr.svg', 'PAYMENT_QR').valid
      ).toBe(false);

      const htmlSpoof = Buffer.from('<!DOCTYPE html><html><script>evil()</script></html>');
      expect(
        BrandingAssetService.validateImageBuffer(htmlSpoof, 'image/png', 'qr.png', 'PAYMENT_QR').valid
      ).toBe(false);

      // Executable magic bytes (MZ / ELF) rejected
      const mzExe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]);
      expect(
        BrandingAssetService.validateImageBuffer(mzExe, 'image/png', 'qr.png', 'PAYMENT_QR').valid
      ).toBe(false);

      const elfBin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(
        BrandingAssetService.validateImageBuffer(elfBin, 'image/jpeg', 'qr.jpg', 'PAYMENT_QR').valid
      ).toBe(false);

      // MIME spoofing: PNG bytes declared as image/jpeg
      const spoofRes = BrandingAssetService.validateImageBuffer(
        validPng,
        'image/jpeg',
        'qr.jpg',
        'PAYMENT_QR'
      );
      expect(spoofRes.valid).toBe(false);
      expect(spoofRes.error).toMatch(/does not match|mismatch/i);

      // Oversized payload rejected
      const oversized = Buffer.alloc(MAX_BRANDING_FILE_SIZE_BYTES + 16, 0x00);
      const sizeRes = BrandingAssetService.validateImageBuffer(
        oversized,
        'image/png',
        'huge.png',
        'PAYMENT_QR'
      );
      expect(sizeRes.valid).toBe(false);
      expect(sizeRes.error).toMatch(/exceeds.*limit/i);
    });

    it('7. Upload, exact byte preservation, replacement, retrieval, tenant isolation, RBAC (EMPLOYEE 403), and deletion', async () => {
      CREATED_COMPANY_IDS.push(COMPANY_A_ID);
      const settingsStore = new Map<string, unknown>();

      const mockFindUnique = (args: {
        where: { companyId_key: { companyId: string; key: string } };
      }) => {
        const k = `${args.where.companyId_key.companyId}:${args.where.companyId_key.key}`;
        const val = settingsStore.get(k);
        return Promise.resolve(val ? { value: val } : null);
      };

      const mockUpsert = (args: {
        where: { companyId_key: { companyId: string; key: string } };
        create: { value: unknown };
        update: { value: unknown };
      }) => {
        const k = `${args.where.companyId_key.companyId}:${args.where.companyId_key.key}`;
        settingsStore.set(k, args.update.value ?? args.create.value);
        return Promise.resolve({ value: settingsStore.get(k) });
      };

      vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation(mockFindUnique as never);
      vi.spyOn(prisma.companySetting, 'upsert').mockImplementation(mockUpsert as never);
      vi.spyOn(prisma.company, 'update').mockResolvedValue({} as never);
      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          companySetting: {
            findUnique: mockFindUnique,
            upsert: mockUpsert,
          },
          company: {
            update: vi.fn().mockResolvedValue({}),
          },
        })) as never);

      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);

      // EMPLOYEE cannot upload or delete QR (403)
      const qrPng1 = makeValidPngBuffer(180, 180, 0x11);
      await expect(
        BrandingAssetService.uploadCompanyAsset(employeeA, {
          assetType: 'PAYMENT_QR',
          fileName: 'upi-qr.png',
          mimeType: 'image/png',
          buffer: qrPng1,
        })
      ).rejects.toMatchObject({ statusCode: 403 });

      await expect(
        BrandingAssetService.removeCompanyAsset(employeeA, 'PAYMENT_QR')
      ).rejects.toMatchObject({ statusCode: 403 });

      // SUPER_ADMIN uploads QR -> immediate activation, exact byte preservation
      const upload1 = await BrandingAssetService.uploadCompanyAsset(superAdminA, {
        assetType: 'PAYMENT_QR',
        fileName: 'upi-qr-v1.png',
        mimeType: 'image/png',
        buffer: qrPng1,
      });
      expect(upload1.pendingApproval).toBe(false);
      expect(upload1.asset?.assetType).toBe('PAYMENT_QR');
      expect(upload1.asset?.mimeType).toBe('image/png');

      // Retrieve uploaded QR file and verify exact byte-for-byte preservation (zero re-encoding/regeneration)
      const fetched1 = await BrandingAssetService.getCompanyAssetFile(
        COMPANY_A_ID,
        upload1.asset!.id
      );
      const diskBytes1 = fs.readFileSync(fetched1.filePath);
      expect(diskBytes1.equals(qrPng1)).toBe(true);

      // Tenant isolation: Company B cannot retrieve Company A's QR file
      await expect(
        BrandingAssetService.getCompanyAssetFile(COMPANY_B_ID, upload1.asset!.id)
      ).rejects.toMatchObject({ statusCode: 404 });

      // Uploading a QR must NOT auto-enable showPaymentQr in print settings
      const printSettingsAfterUpload = settingsStore.get(
        `${COMPANY_A_ID}:DOCUMENT_PRINT_SETTINGS_V1`
      ) as { layouts?: { INVOICE?: { showPaymentQr?: boolean } } } | undefined;
      expect(Boolean(printSettingsAfterUpload?.layouts?.INVOICE?.showPaymentQr)).toBe(false);

      // Replace QR with a new JPEG file
      const qrJpg2 = makeMinimalJpegBuffer(200, 200);
      const upload2 = await BrandingAssetService.uploadCompanyAsset(superAdminA, {
        assetType: 'PAYMENT_QR',
        fileName: 'upi-qr-v2.jpg',
        mimeType: 'image/jpeg',
        buffer: qrJpg2,
      });
      expect(upload2.asset?.id).not.toBe(upload1.asset?.id);
      const fetched2 = await BrandingAssetService.getCompanyAssetFile(
        COMPANY_A_ID,
        upload2.asset!.id
      );
      expect(fs.readFileSync(fetched2.filePath).equals(qrJpg2)).toBe(true);

      // Delete QR
      const removed = await BrandingAssetService.removeCompanyAsset(superAdminA, 'PAYMENT_QR');
      expect(removed.pendingApproval).toBe(false);
      expect(removed.assets.paymentQr).toBeNull();
    });

    it('8. Maker-checker workflow preserved: ADMIN uploading PAYMENT_QR or updating taxRegistrationNumber creates PENDING change request', async () => {
      CREATED_COMPANY_IDS.push(COMPANY_A_ID);
      const createdRequests: Array<Record<string, unknown>> = [];

      vi.spyOn(prisma.companySettingsChangeRequest, 'create').mockImplementation(((args: {
        data: Record<string, unknown>;
      }) => {
        const rec = {
          id: `chg-${createdRequests.length + 1}`,
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
          requestedBy: { id: adminA.userId, fullName: adminA.fullName, email: adminA.email, role: adminA.role },
          reviewedBy: null,
        };
        createdRequests.push(rec);
        return Promise.resolve(rec);
      }) as never);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null as never);
      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);

      // ADMIN uploading PAYMENT_QR stages file and creates PENDING request (does not activate immediately)
      const qrPng = makeValidPngBuffer(160, 160);
      const adminUpload = await BrandingAssetService.uploadCompanyAsset(adminA, {
        assetType: 'PAYMENT_QR',
        fileName: 'pending-qr.png',
        mimeType: 'image/png',
        buffer: qrPng,
      });
      expect(adminUpload.pendingApproval).toBe(true);
      expect(adminUpload.changeRequest?.id).toBe('chg-1');
      expect(createdRequests[0]).toMatchObject({
        companyId: COMPANY_A_ID,
        requestedById: adminA.userId,
        status: 'PENDING',
      });

      // ADMIN updating taxRegistrationNumber triggers maker-checker pending approval
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({
        id: COMPANY_A_ID,
        name: 'Acme Studio Systems',
        legalName: 'Acme Studio Systems Private Limited',
        code: 'ACME',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        roundingPrecision: 2,
        fiscalYearStartMonth: 4,
        email: 'accounts@acmestudio.test',
        phone: '+91 80 4123 9988',
        website: 'https://acmestudio.test',
        taxRegistrationNumber: '29OLDGST1234F1Z5',
        addressLine1: '42 MG Road',
        addressLine2: null,
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560038',
        country: 'India',
        logoUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      const profileRes = await CompanyService.updateProfile(adminA, {
        name: 'Acme Studio Systems',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        taxRegistrationNumber: '29NEWGST9999K1Z2',
      });
      expect(profileRes.pendingApproval).toBe(true);
      expect(profileRes.changeRequest?.id).toBe('chg-2');
    });

    it('9. QR is disabled by default, legacy layouts stay unchanged, and paid invoices hide QR by default unless explicitly overridden', () => {
      const defaults = createDefaultPrintSettings();
      expect(defaults.layouts.INVOICE.showPaymentQr).toBe(false);
      expect(defaults.layouts.QUOTATION.showPaymentQr).toBe(false);
      expect(defaults.layouts.RECEIPT.showPaymentQr).toBe(false);

      // Merging legacy saved settings without QR fields keeps showPaymentQr=false
      const merged = mergeDocumentPrintSettings({
        layouts: {
          INVOICE: { paperSize: 'A4', orientation: 'portrait' },
        },
      });
      expect(merged.layouts.INVOICE.showPaymentQr).toBe(false);
      expect(merged.layouts.INVOICE.paymentQrSize).toBe('md');
      expect(merged.layouts.INVOICE.paymentQrPosition).toBe('bottom-right');

      // Validate invalid QR settings are rejected
      const badSize = validatePrintSettingsPayload({
        layouts: { INVOICE: { paymentQrSize: 'xl' } },
      });
      expect(badSize.valid).toBe(false);
      expect(badSize.error).toMatch(/paymentQrSize/i);

      const badPos = validatePrintSettingsPayload({
        layouts: { INVOICE: { paymentQrPosition: 'top-center' } },
      });
      expect(badPos.valid).toBe(false);
      expect(badPos.error).toMatch(/paymentQrPosition/i);

      const unpaidInvoice = buildSampleInvoice({ status: 'ISSUED', balanceDue: '9210.00' });
      const paidInvoice = buildSampleInvoice({ status: 'PAID', balanceDue: '0.00' });
      const qrEnabledLayout = { ...defaults.layouts.INVOICE, showPaymentQr: true };

      // Disabled by default -> false
      expect(
        shouldDisplayPaymentQr({
          layout: defaults.layouts.INVOICE,
          document: { type: 'INVOICE', data: unpaidInvoice },
          qrSource: '/api/company/branding/assets/qr-1/file',
        })
      ).toBe(false);

      // Enabled for unpaid invoice -> true
      expect(
        shouldDisplayPaymentQr({
          layout: qrEnabledLayout,
          document: { type: 'INVOICE', data: unpaidInvoice },
          qrSource: '/api/company/branding/assets/qr-1/file',
        })
      ).toBe(true);

      // Hidden by default for fully paid invoice even when layout.showPaymentQr is true
      expect(
        shouldDisplayPaymentQr({
          layout: qrEnabledLayout,
          document: { type: 'INVOICE', data: paidInvoice },
          qrSource: '/api/company/branding/assets/qr-1/file',
        })
      ).toBe(false);

      // Explicit override shows QR even on paid invoice if user consciously ticks it
      expect(
        shouldDisplayPaymentQr({
          layout: qrEnabledLayout,
          document: { type: 'INVOICE', data: paidInvoice },
          qrSource: '/api/company/branding/assets/qr-1/file',
          includePaymentQrOverride: true,
        })
      ).toBe(true);
    });
  });

  describe('Feature 3 — Additional Document Download Formats (PDF, DOCX, XLSX, JPG/PNG Multi-Page)', () => {
    it('10. DOCX and PDF exports include Company Address, optional Copy Label, and optional uploaded QR while remaining backward-compatible', async () => {
      const profile = buildCompanyProfile();
      const invoice = buildSampleInvoice();
      const qrPng = makeValidPngBuffer(180, 180, 0x33);

      // DOCX with address, ORIGINAL copy label, and Payment QR
      const docxWithOptions = await generateDocxBuffer({
        document: { type: 'INVOICE', data: invoice },
        companyProfile: profile,
        layoutOverride: {
          ...createDefaultPrintSettings().layouts.INVOICE,
          showPaymentQr: true,
          paymentQrLabel: 'Scan UPI to Pay',
          paymentQrPosition: 'bottom-left',
        },
        brandingImages: { paymentQr: qrPng },
        copyLabel: 'ORIGINAL',
      });

      const docXml = readZipEntryText(new Uint8Array(docxWithOptions), 'word/document.xml');
      const docText = docXml.replace(/<[^>]+>/g, '');
      expect(docText).toContain('42 MG Road, 3rd Floor');
      expect(docText).toContain('Bengaluru');
      expect(docText).toContain('29AABCA1234F1Z5');
      expect(docText).toContain('ORIGINAL');
      expect(docText).toContain('Scan UPI to Pay');
      expect(docXml).toContain('a:blip');

      // Server DocumentExportService backward-compatible call (without new optional fields)
      vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
      vi.spyOn(CompanyService, 'getProfile').mockResolvedValue(profile);
      vi.spyOn(CompanyBankAccountService, 'listBankAccounts').mockResolvedValue([]);
      vi.spyOn(BrandingAssetService, 'resolveExportImageBuffer').mockResolvedValue(null);
      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);

      const pdfResult = await DocumentExportService.exportDocument(
        superAdminA,
        { document: { type: 'INVOICE', data: invoice } },
        'pdf'
      );
      expect(pdfResult.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdfResult.fileName).toBe('INV-2026-0021.pdf');

      // Server DocumentExportService with optional copyLabel & includePaymentQr
      const pdfWithCopyAndQr = await DocumentExportService.exportDocument(
        superAdminA,
        {
          document: { type: 'INVOICE', data: invoice },
          copyLabel: 'DUPLICATE',
          includePaymentQr: true,
        },
        'pdf'
      );
      expect(pdfWithCopyAndQr.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('11. XLSX export produces valid OOXML workbook with company address, real numeric cells, exact stored totals (no recalculation), and formula-injection safety', () => {
      const profile = buildCompanyProfile();
      // Deliberately verify exact stored totals are preserved verbatim without recalculating
      const invoice = buildSampleInvoice({
        notes: '=HYPERLINK("http://evil.example","Click")',
        subtotal: '10000.00',
        discountTotal: '500.00',
        taxTotal: '1710.00',
        total: '11210.00',
        amountPaid: '2000.00',
        balanceDue: '9210.00',
      });

      const xlsxBytes = generateXlsxBytes({
        document: { type: 'INVOICE', data: invoice },
        companyProfile: profile,
        copyLabel: 'ORIGINAL',
      });

      const entries = listZipEntryNames(xlsxBytes);
      expect(entries).toContain('[Content_Types].xml');
      expect(entries).toContain('xl/workbook.xml');
      expect(entries).toContain('xl/styles.xml');
      expect(entries).toContain('xl/worksheets/sheet1.xml');

      const sheetXml = readZipEntryText(xlsxBytes, 'xl/worksheets/sheet1.xml');
      expect(sheetXml).toContain('Acme Studio Systems');
      expect(sheetXml).toContain('42 MG Road, 3rd Floor');
      expect(sheetXml).toContain('29AABCA1234F1Z5');
      expect(sheetXml).toContain('ORIGINAL');

      // Exact stored numeric totals stored as real numeric cells (t="n")
      expect(sheetXml).toMatch(/t="n"[^>]*><v>10000<\/v>/);
      expect(sheetXml).toMatch(/t="n"[^>]*><v>1710<\/v>/);
      expect(sheetXml).toMatch(/t="n"[^>]*><v>11210<\/v>/);
      expect(sheetXml).toMatch(/t="n"[^>]*><v>9210<\/v>/);

      // Formula injection safety: notes text stored as inlineStr, NEVER as <f> formula tag
      expect(sheetXml).not.toContain('<f>');
      expect(sheetXml).toContain('t="inlineStr"');

      // Structured row builder returns exact numeric figures
      const { rows } = buildDocumentSpreadsheetRows({
        document: { type: 'INVOICE', data: invoice },
        companyProfile: profile,
      });
      const flatNumbers = rows
        .flat()
        .filter((cell) => cell.kind === 'number')
        .map((cell) => (cell.kind === 'number' ? cell.value : null));
      expect(flatNumbers).toContain(11210);
      expect(flatNumbers).toContain(9210);
    });

    it('12. JPG/PNG image export planner handles single-page direct image and multi-page ZIP archive cleanly across A4/A5/Portrait/Landscape', () => {
      const profile = buildCompanyProfile();

      // Single-page invoice -> 1 page -> direct .png / .jpg output (NOT a ZIP)
      const shortInvoice = buildSampleInvoice();
      const shortPlan = planImageExportPages(
        { document: { type: 'INVOICE', data: shortInvoice }, companyProfile: profile },
        'standard'
      );
      expect(shortPlan.dpi).toBe(150);
      expect(shortPlan.pages.length).toBe(1);

      const singlePackaged = packageRenderedImagePages(
        { type: 'INVOICE', data: shortInvoice },
        [makeValidPngBuffer(100, 100)],
        'png',
        false
      );
      expect(singlePackaged.isZip).toBe(false);
      expect(singlePackaged.fileName).toBe('INV-2026-0021.png');
      expect(singlePackaged.mimeType).toBe('image/png');

      // High quality (300 DPI) + A5 Portrait multi-page invoice (30 lines) -> multiple pages -> ZIP archive
      const longLines = Array.from({ length: 30 }, (_, i) => ({
        id: `ln-${i + 1}`,
        lineNumber: i + 1,
        itemDescription: `Production Deliverable Line Item #${i + 1} with Extended Scope Description`,
        quantity: '1.00',
        unitPrice: '1000.00',
        discountAmount: '0.00',
        taxRate: '18.00',
        taxAmount: '180.00',
        lineTotal: '1180.00',
      }));
      const longInvoice = buildSampleInvoice({ lines: longLines });

      const multiPlan = planImageExportPages(
        {
          document: { type: 'INVOICE', data: longInvoice },
          companyProfile: profile,
          layoutOverride: {
            ...createDefaultPrintSettings().layouts.INVOICE,
            paperSize: 'A5',
            orientation: 'portrait',
          },
        },
        'high'
      );
      expect(multiPlan.dpi).toBe(300);
      expect(multiPlan.pages.length).toBeGreaterThan(1);
      expect(multiPlan.pages[multiPlan.pages.length - 1].includeSummaryAndFooter).toBe(true);
      expect(multiPlan.pages.reduce((sum, p) => sum + p.lines.length, 0)).toBe(30);

      // Package rendered pages into ZIP archive
      const fakePageBuffers = multiPlan.pages.map((_, idx) => makeMinimalJpegBuffer(100 + idx, 100));
      const zipPackaged = packageRenderedImagePages(
        { type: 'INVOICE', data: longInvoice },
        fakePageBuffers,
        'jpg',
        false
      );
      expect(zipPackaged.isZip).toBe(true);
      expect(zipPackaged.mimeType).toBe('application/zip');
      expect(zipPackaged.fileName).toBe('INV-2026-0021-jpg-pages.zip');
      const zipEntries = listZipEntryNames(zipPackaged.bytes);
      expect(zipEntries.length).toBe(multiPlan.pages.length);
      expect(zipEntries[0]).toBe('INV-2026-0021-page-1.jpg');
      expect(zipEntries[1]).toBe('INV-2026-0021-page-2.jpg');
    });

    it('13. PrintableDocumentView preserves lazy dynamic imports for DOCX, XLSX, and Image exporters (P1-P4 bundle safety)', () => {
      const printableSrc = fs.readFileSync(
        path.resolve(process.cwd(), 'src/client/components/print/PrintableDocumentView.tsx'),
        'utf8'
      );
      expect(printableSrc).not.toMatch(/^import\s+.*docx-builder/m);
      expect(printableSrc).not.toMatch(/^import\s+.*xlsx-builder/m);
      expect(printableSrc).not.toMatch(/^import\s+.*invoice-image-export/m);
      expect(printableSrc).toContain("import('../../../shared/export/docx-builder.ts')");
      expect(printableSrc).toContain("import('../../../shared/export/xlsx-builder.ts')");
      expect(printableSrc).toContain("import('../../utils/invoice-image-export.ts')");
    });
  });

  describe('Pre-Push Blocker Regressions — Security, Profile, Image Fidelity & Historical Integrity', () => {
    const superAdminB: AuthUser = {
      id: 'usr-sa-b',
      userId: 'usr-sa-b',
      companyId: COMPANY_B_ID,
      email: 'sa@company-b.test',
      fullName: 'Super Admin B',
      role: 'SUPER_ADMIN',
      isActive: true,
      tokenVersion: 1,
    };

    function createCompanyRecord(companyId: string) {
      return {
        id: companyId,
        name: 'Acme Studio Systems',
        legalName: 'Acme Studio Systems Private Limited',
        code: 'ACME',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        roundingPrecision: 2,
        fiscalYearStartMonth: 4,
        defaultDocumentLanguage: 'EN',
        email: 'accounts@acmestudio.test',
        phone: '+91 80 4123 9988',
        website: 'https://acmestudio.test',
        taxRegistrationNumber: '29AABCA1234F1Z5',
        addressLine1: '42 MG Road, 3rd Floor',
        addressLine2: 'Indiranagar',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560038',
        country: 'India',
        logoUrl: null,
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      };
    }

    it('14. P0 Security: PENDING_APPROVAL PAYMENT_QR cannot be retrieved or exported until SUPER_ADMIN approves, arbitrary/cross-tenant URLs are rejected (403), and approved QR flows through getProfile/getPrintSettings/PDF/DOCX', async () => {
      CREATED_COMPANY_IDS.push(COMPANY_A_ID, COMPANY_B_ID);
      const settingsStore = new Map<string, string>();
      const changeRequestStore = new Map<string, Record<string, unknown>>();
      const companyRecA = createCompanyRecord(COMPANY_A_ID);
      const companyRecB = createCompanyRecord(COMPANY_B_ID);

      const mockSettingFindUnique = (args: {
        where: { companyId_key: { companyId: string; key: string } };
      }) => {
        const k = `${args.where.companyId_key.companyId}:${args.where.companyId_key.key}`;
        const val = settingsStore.get(k);
        return Promise.resolve(val !== undefined ? { companyId: args.where.companyId_key.companyId, key: args.where.companyId_key.key, value: val } : null);
      };

      const mockSettingFindMany = (args: {
        where: { companyId: string; key?: string | { in: string[] } };
      }) => {
        const keys =
          typeof args.where.key === 'string'
            ? [args.where.key]
            : Array.isArray(args.where.key?.in)
            ? args.where.key.in
            : [];
        const rows: Array<{ companyId: string; key: string; value: string }> = [];
        for (const key of keys) {
          const val = settingsStore.get(`${args.where.companyId}:${key}`);
          if (val !== undefined) {
            rows.push({ companyId: args.where.companyId, key, value: val });
          }
        }
        return Promise.resolve(rows);
      };

      const mockSettingUpsert = (args: {
        where: { companyId_key: { companyId: string; key: string } };
        create: { value: string };
        update: { value: string };
      }) => {
        const k = `${args.where.companyId_key.companyId}:${args.where.companyId_key.key}`;
        const val = args.update.value ?? args.create.value;
        settingsStore.set(k, val);
        return Promise.resolve({ companyId: args.where.companyId_key.companyId, key: args.where.companyId_key.key, value: val });
      };

      vi.spyOn(prisma.company, 'findUnique').mockImplementation(((args: { where: { id: string } }) =>
        Promise.resolve(args.where.id === COMPANY_A_ID ? companyRecA : args.where.id === COMPANY_B_ID ? companyRecB : null)) as never);
      vi.spyOn(prisma.company, 'update').mockResolvedValue(companyRecA as never);
      vi.spyOn(prisma.currencyConfig, 'findUnique').mockResolvedValue(null as never);
      vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation(mockSettingFindUnique as never);
      vi.spyOn(prisma.companySetting, 'findMany').mockImplementation(mockSettingFindMany as never);
      vi.spyOn(prisma.companySetting, 'upsert').mockImplementation(mockSettingUpsert as never);
      vi.spyOn(prisma.companySettingsChangeRequest, 'create').mockImplementation(((args: {
        data: Record<string, unknown>;
      }) => {
        const id = `chg-p0-${changeRequestStore.size + 1}`;
        const rec = {
          id,
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
          requestedBy: { id: adminA.userId, fullName: adminA.fullName, email: adminA.email, role: adminA.role },
          reviewedBy: null,
        };
        changeRequestStore.set(id, rec);
        return Promise.resolve(rec);
      }) as never);
      vi.spyOn(prisma.companySettingsChangeRequest, 'findUnique').mockImplementation(((args: {
        where: { id: string };
      }) => Promise.resolve(changeRequestStore.get(args.where.id) || null)) as never);
      vi.spyOn(prisma.companySettingsChangeRequest, 'update').mockImplementation(((args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const prev = changeRequestStore.get(args.where.id)!;
        const next = { ...prev, ...args.data, reviewedBy: { fullName: superAdminA.fullName } };
        changeRequestStore.set(args.where.id, next);
        return Promise.resolve(next);
      }) as never);
      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          company: { update: vi.fn().mockResolvedValue(companyRecA) },
          companySetting: {
            findUnique: mockSettingFindUnique,
            findMany: mockSettingFindMany,
            upsert: mockSettingUpsert,
          },
          companySettingsChangeRequest: {
            update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
              const prev = changeRequestStore.get(args.where.id)!;
              const next = { ...prev, ...args.data, reviewedBy: { fullName: superAdminA.fullName } };
              changeRequestStore.set(args.where.id, next);
              return Promise.resolve(next);
            },
          },
        })) as never);
      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);
      vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
      vi.spyOn(CompanyBankAccountService, 'listBankAccounts').mockResolvedValue([]);

      // 1. ADMIN uploads PAYMENT_QR -> pending approval
      const qrPng = makeValidPngBuffer(220, 220, 0x44);
      const pendingUpload = await BrandingAssetService.uploadCompanyAsset(adminA, {
        assetType: 'PAYMENT_QR',
        fileName: 'pending-upi-qr.png',
        mimeType: 'image/png',
        buffer: qrPng,
      });
      expect(pendingUpload.pendingApproval).toBe(true);
      expect(pendingUpload.asset?.status).toBe('PENDING_APPROVAL');
      const pendingAssetId = pendingUpload.asset!.id;
      const pendingAssetUrl = pendingUpload.asset!.url;

      // 2. Pending asset MUST NOT be retrievable as active file (403)
      await expect(
        BrandingAssetService.getCompanyAssetFile(COMPANY_A_ID, pendingAssetId)
      ).rejects.toMatchObject({ statusCode: 403 });

      // 3. Pending asset MUST NOT resolve for export
      expect(
        await BrandingAssetService.resolveExportImageBuffer(COMPANY_A_ID, pendingAssetUrl, {
          allowedAssetTypes: ['PAYMENT_QR'],
          allowLocalFallback: false,
        })
      ).toBeNull();

      // 4. Pending asset MUST NOT be usable in PDF or DOCX export via layoutOverride.paymentQrUrl (403)
      const invoice = buildSampleInvoice();
      const baseLayout = createDefaultPrintSettings().layouts.INVOICE;
      await expect(
        DocumentExportService.exportDocument(
          superAdminA,
          {
            document: { type: 'INVOICE', data: invoice },
            layoutOverride: { ...baseLayout, showPaymentQr: true, paymentQrUrl: pendingAssetUrl },
          },
          'pdf'
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      await expect(
        DocumentExportService.exportDocument(
          superAdminA,
          {
            document: { type: 'INVOICE', data: invoice },
            layoutOverride: { ...baseLayout, showPaymentQr: true, paymentQrUrl: pendingAssetUrl },
          },
          'docx'
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      // Arbitrary external / local URLs in layoutOverride.paymentQrUrl MUST also be rejected (403)
      await expect(
        DocumentExportService.exportDocument(
          superAdminA,
          {
            document: { type: 'INVOICE', data: invoice },
            layoutOverride: { ...baseLayout, showPaymentQr: true, paymentQrUrl: '/public/evil.png' },
          },
          'pdf'
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      // 5. SUPER_ADMIN approves pending PAYMENT_QR change request
      const approved = await CompanyService.approveChangeRequest(
        superAdminA,
        pendingUpload.changeRequest!.id
      );

      // P1 verification: getProfile & getPrintSettings both return full paymentQr metadata & paymentQrUrl
      expect(approved.profile.brandingAssets?.paymentQr?.id).toBe(pendingAssetId);
      expect(approved.profile.brandingAssets?.paymentQr?.status).toBe('ACTIVE');
      expect(approved.profile.brandingAssets?.paymentQr?.url).toBe(pendingAssetUrl);
      expect(approved.profile.paymentQrUrl).toBe(pendingAssetUrl);
      expect(approved.profile.documentBranding?.paymentQrUrl).toBe(pendingAssetUrl);

      const printSettings = await CompanyService.getPrintSettings(COMPANY_A_ID);
      expect(printSettings.layouts.INVOICE.paymentQrUrl).toBe(pendingAssetUrl);
      expect(printSettings.layouts.INVOICE.showPaymentQr).toBe(false);

      // 6. After approval, file retrieval and PDF/DOCX export succeed for Company A
      const fetchedApproved = await BrandingAssetService.getCompanyAssetFile(
        COMPANY_A_ID,
        pendingAssetId
      );
      expect(fs.readFileSync(fetchedApproved.filePath).equals(qrPng)).toBe(true);

      const pdfExport = await DocumentExportService.exportDocument(
        superAdminA,
        {
          document: { type: 'INVOICE', data: invoice },
          layoutOverride: { ...baseLayout, showPaymentQr: true, paymentQrUrl: pendingAssetUrl },
        },
        'pdf'
      );
      expect(pdfExport.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

      const docxExport = await DocumentExportService.exportDocument(
        superAdminA,
        {
          document: { type: 'INVOICE', data: invoice },
          layoutOverride: {
            ...baseLayout,
            showPaymentQr: true,
            paymentQrUrl: pendingAssetUrl,
            paymentQrLabel: 'Approved UPI QR',
          },
        },
        'docx'
      );
      const docxXml = readZipEntryText(new Uint8Array(docxExport.buffer), 'word/document.xml');
      expect(docxXml).toContain('a:blip');
      expect(docxXml).toContain('Approved UPI QR');

      // 7. Cross-tenant isolation: Company B cannot retrieve or export Company A's approved QR
      await expect(
        BrandingAssetService.getCompanyAssetFile(COMPANY_B_ID, pendingAssetId)
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        DocumentExportService.exportDocument(
          superAdminB,
          {
            document: { type: 'INVOICE', data: { ...invoice, companyId: COMPANY_B_ID } },
            layoutOverride: { ...baseLayout, showPaymentQr: true, paymentQrUrl: pendingAssetUrl },
          },
          'pdf'
        )
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('15. P0 Security: Rejection marks PAYMENT_QR unusable, ADMIN replacement/deletion keep active QR until approved, and stageSetupAsset rejects WebP for PAYMENT_QR', async () => {
      CREATED_COMPANY_IDS.push(COMPANY_A_ID);
      const settingsStore = new Map<string, string>();
      const changeRequestStore = new Map<string, Record<string, unknown>>();
      const companyRecA = createCompanyRecord(COMPANY_A_ID);

      const mockSettingFindUnique = (args: {
        where: { companyId_key: { companyId: string; key: string } };
      }) => {
        const k = `${args.where.companyId_key.companyId}:${args.where.companyId_key.key}`;
        const val = settingsStore.get(k);
        return Promise.resolve(val !== undefined ? { companyId: args.where.companyId_key.companyId, key: args.where.companyId_key.key, value: val } : null);
      };
      const mockSettingFindMany = (args: {
        where: { companyId: string; key?: string | { in: string[] } };
      }) => {
        const keys =
          typeof args.where.key === 'string'
            ? [args.where.key]
            : Array.isArray(args.where.key?.in)
            ? args.where.key.in
            : [];
        return Promise.resolve(
          keys
            .map((key) => {
              const val = settingsStore.get(`${args.where.companyId}:${key}`);
              return val !== undefined ? { companyId: args.where.companyId, key, value: val } : null;
            })
            .filter(Boolean)
        );
      };
      const mockSettingUpsert = (args: {
        where: { companyId_key: { companyId: string; key: string } };
        create: { value: string };
        update: { value: string };
      }) => {
        const k = `${args.where.companyId_key.companyId}:${args.where.companyId_key.key}`;
        const val = args.update.value ?? args.create.value;
        settingsStore.set(k, val);
        return Promise.resolve({ value: val });
      };

      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue(companyRecA as never);
      vi.spyOn(prisma.company, 'update').mockResolvedValue(companyRecA as never);
      vi.spyOn(prisma.currencyConfig, 'findUnique').mockResolvedValue(null as never);
      vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation(mockSettingFindUnique as never);
      vi.spyOn(prisma.companySetting, 'findMany').mockImplementation(mockSettingFindMany as never);
      vi.spyOn(prisma.companySetting, 'upsert').mockImplementation(mockSettingUpsert as never);
      vi.spyOn(prisma.companySettingsChangeRequest, 'create').mockImplementation(((args: {
        data: Record<string, unknown>;
      }) => {
        const id = `chg-rej-${changeRequestStore.size + 1}`;
        const rec = {
          id,
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
          requestedBy: { id: adminA.userId, fullName: adminA.fullName, email: adminA.email, role: adminA.role },
          reviewedBy: null,
        };
        changeRequestStore.set(id, rec);
        return Promise.resolve(rec);
      }) as never);
      vi.spyOn(prisma.companySettingsChangeRequest, 'findUnique').mockImplementation(((args: {
        where: { id: string };
      }) => Promise.resolve(changeRequestStore.get(args.where.id) || null)) as never);
      vi.spyOn(prisma.companySettingsChangeRequest, 'update').mockImplementation(((args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const prev = changeRequestStore.get(args.where.id)!;
        const next = { ...prev, ...args.data, reviewedBy: { fullName: superAdminA.fullName } };
        changeRequestStore.set(args.where.id, next);
        return Promise.resolve(next);
      }) as never);
      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          company: { update: vi.fn().mockResolvedValue(companyRecA) },
          companySetting: {
            findUnique: mockSettingFindUnique,
            findMany: mockSettingFindMany,
            upsert: mockSettingUpsert,
          },
          companySettingsChangeRequest: {
            update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
              const prev = changeRequestStore.get(args.where.id)!;
              const next = { ...prev, ...args.data, reviewedBy: { fullName: superAdminA.fullName } };
              changeRequestStore.set(args.where.id, next);
              return Promise.resolve(next);
            },
          },
        })) as never);
      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);

      // 1. Rejection path marks asset REJECTED and keeps it blocked
      const rejectedUpload = await BrandingAssetService.uploadCompanyAsset(adminA, {
        assetType: 'PAYMENT_QR',
        fileName: 'reject-me.png',
        mimeType: 'image/png',
        buffer: makeValidPngBuffer(180, 180, 0x55),
      });
      await CompanyService.rejectChangeRequest(
        superAdminA,
        rejectedUpload.changeRequest!.id,
        'Wrong merchant QR'
      );
      await expect(
        BrandingAssetService.getCompanyAssetFile(COMPANY_A_ID, rejectedUpload.asset!.id)
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(
        await BrandingAssetService.resolveExportImageBuffer(
          COMPANY_A_ID,
          rejectedUpload.asset!.url,
          { allowedAssetTypes: ['PAYMENT_QR'], allowLocalFallback: false }
        )
      ).toBeNull();

      // 2. Replacement & deletion maker-checker semantics preserve active QR until approved
      const activeQr = await BrandingAssetService.uploadCompanyAsset(superAdminA, {
        assetType: 'PAYMENT_QR',
        fileName: 'active-v1.png',
        mimeType: 'image/png',
        buffer: makeValidPngBuffer(190, 190, 0x66),
      });
      const replaceReq = await BrandingAssetService.uploadCompanyAsset(adminA, {
        assetType: 'PAYMENT_QR',
        fileName: 'replace-v2.jpg',
        mimeType: 'image/jpeg',
        buffer: makeMinimalJpegBuffer(190, 190),
      });
      expect(replaceReq.pendingApproval).toBe(true);
      // Active QR is still v1 until approved, and v2 is blocked
      const profileBeforeReplace = await CompanyService.getProfile(COMPANY_A_ID);
      expect(profileBeforeReplace.brandingAssets?.paymentQr?.id).toBe(activeQr.asset!.id);
      await expect(
        BrandingAssetService.getCompanyAssetFile(COMPANY_A_ID, replaceReq.asset!.id)
      ).rejects.toMatchObject({ statusCode: 403 });

      // Approve replacement -> v2 active
      await CompanyService.approveChangeRequest(superAdminA, replaceReq.changeRequest!.id);
      const profileAfterReplace = await CompanyService.getProfile(COMPANY_A_ID);
      expect(profileAfterReplace.brandingAssets?.paymentQr?.id).toBe(replaceReq.asset!.id);

      // ADMIN requests deletion -> pending approval; v2 remains active until approved
      const deleteReq = await BrandingAssetService.removeCompanyAsset(adminA, 'PAYMENT_QR');
      expect(deleteReq.pendingApproval).toBe(true);
      const profileBeforeDelete = await CompanyService.getProfile(COMPANY_A_ID);
      expect(profileBeforeDelete.brandingAssets?.paymentQr?.id).toBe(replaceReq.asset!.id);

      await CompanyService.approveChangeRequest(superAdminA, deleteReq.changeRequest!.id);
      const profileAfterDelete = await CompanyService.getProfile(COMPANY_A_ID);
      expect(profileAfterDelete.brandingAssets?.paymentQr).toBeNull();

      // 3. stageSetupAsset rejects WebP for PAYMENT_QR
      await expect(
        BrandingAssetService.stageSetupAsset({
          assetType: 'PAYMENT_QR',
          fileName: 'qr.webp',
          mimeType: 'image/webp',
          buffer: makeMinimalWebpBuffer(200, 200),
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('16. Historical Document Integrity: Explicit null assets & contact fields in historical snapshot are preserved and never overwritten by current profile', async () => {
      const currentProfileWithAssets = buildCompanyProfile({
        legalName: 'Acme New Legal Name LLP',
        phone: '+91 80 9999 0000',
        email: 'new-billing@acmestudio.test',
        website: 'https://new-site.acmestudio.test',
        taxId: '29NEWGST9999K1Z1',
        taxRegistrationNumber: '29NEWGST9999K1Z1',
        logoUrl: '/api/company/branding/assets/current-logo/file',
        sealUrl: '/api/company/branding/assets/current-seal/file',
        signatureUrl: '/api/company/branding/assets/current-sig/file',
        paymentQrUrl: '/api/company/branding/assets/current-qr/file',
        brandingAssets: {
          version: 1,
          logo: {
            id: 'current-logo',
            companyId: COMPANY_A_ID,
            assetType: 'LOGO',
            url: '/api/company/branding/assets/current-logo/file',
            fileName: 'logo.png',
            mimeType: 'image/png',
            fileSizeBytes: 1000,
            widthPx: 200,
            heightPx: 80,
            aspectRatio: 2.5,
            sha256Hash: 'hash-logo',
            status: 'ACTIVE',
            createdAt: '2026-03-01T00:00:00.000Z',
          },
          seal: {
            id: 'current-seal',
            companyId: COMPANY_A_ID,
            assetType: 'SEAL',
            url: '/api/company/branding/assets/current-seal/file',
            fileName: 'seal.png',
            mimeType: 'image/png',
            fileSizeBytes: 1000,
            widthPx: 200,
            heightPx: 200,
            aspectRatio: 1,
            sha256Hash: 'hash-seal',
            status: 'ACTIVE',
            createdAt: '2026-03-01T00:00:00.000Z',
          },
          signature: {
            id: 'current-sig',
            companyId: COMPANY_A_ID,
            assetType: 'SIGNATURE',
            url: '/api/company/branding/assets/current-sig/file',
            fileName: 'sig.png',
            mimeType: 'image/png',
            fileSizeBytes: 1000,
            widthPx: 240,
            heightPx: 80,
            aspectRatio: 3,
            sha256Hash: 'hash-sig',
            status: 'ACTIVE',
            createdAt: '2026-03-01T00:00:00.000Z',
          },
          paymentQr: {
            id: 'current-qr',
            companyId: COMPANY_A_ID,
            assetType: 'PAYMENT_QR',
            url: '/api/company/branding/assets/current-qr/file',
            fileName: 'qr.png',
            mimeType: 'image/png',
            fileSizeBytes: 1000,
            widthPx: 200,
            heightPx: 200,
            aspectRatio: 1,
            sha256Hash: 'hash-qr',
            status: 'ACTIVE',
            createdAt: '2026-03-01T00:00:00.000Z',
          },
        },
        documentBranding: {
          logoSize: 'md',
          logoAlignment: 'left',
          sealUrl: '/api/company/branding/assets/current-seal/file',
          signatureUrl: '/api/company/branding/assets/current-sig/file',
          paymentQrUrl: '/api/company/branding/assets/current-qr/file',
          signatoryName: 'Current Director',
          signatureTitle: 'Managing Director',
        },
      });

      const historicalNullSnapshot: DocumentBrandingSnapshot = {
        capturedAt: '2026-02-01T00:00:00.000Z',
        companyName: 'Acme Historical Co',
        legalName: null,
        address: '15 Historic Street, Mysuru 570001',
        phone: null,
        email: null,
        website: null,
        taxId: null,
        taxRegistrationNumber: null,
        logoAssetId: null,
        logoUrl: null,
        sealAssetId: null,
        sealUrl: null,
        signatureAssetId: null,
        signatureUrl: null,
        paymentQrAssetId: null,
        paymentQrUrl: null,
        signatoryName: null,
        signatoryTitle: null,
      };

      const merged = mergeSnapshotIntoCompanyProfile(currentProfileWithAssets, historicalNullSnapshot);
      expect(merged.name).toBe('Acme Historical Co');
      expect(merged.legalName).toBeNull();
      expect(merged.phone).toBeNull();
      expect(merged.email).toBeNull();
      expect(merged.website).toBeNull();
      expect(merged.taxId).toBeNull();
      expect(merged.taxRegistrationNumber).toBeNull();
      expect(merged.logoUrl).toBeNull();
      expect(merged.sealUrl).toBeNull();
      expect(merged.signatureUrl).toBeNull();
      expect(merged.paymentQrUrl).toBeNull();
      expect(merged.brandingAssets?.logo).toBeNull();
      expect(merged.brandingAssets?.seal).toBeNull();
      expect(merged.brandingAssets?.signature).toBeNull();
      expect(merged.brandingAssets?.paymentQr).toBeNull();
      expect(merged.documentBranding?.sealUrl).toBeNull();
      expect(merged.documentBranding?.signatureUrl).toBeNull();
      expect(merged.documentBranding?.paymentQrUrl).toBeNull();
      expect(formatCompanyAddressText(merged)).toBe('15 Historic Street, Mysuru 570001');

      // Server export with historical snapshot recording paymentQrUrl: null must NOT inject current company QR
      vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
      vi.spyOn(CompanyService, 'getProfile').mockResolvedValue(currentProfileWithAssets);
      vi.spyOn(CompanyBankAccountService, 'listBankAccounts').mockResolvedValue([]);
      vi.spyOn(BrandingAssetService, 'getDocumentSnapshot').mockResolvedValue(historicalNullSnapshot);
      const resolveSpy = vi
        .spyOn(BrandingAssetService, 'resolveExportImageBuffer')
        .mockResolvedValue(null);
      vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);

      const historicalInvoice = buildSampleInvoice({ brandingSnapshot: historicalNullSnapshot });
      await DocumentExportService.exportDocument(
        superAdminA,
        { document: { type: 'INVOICE', data: historicalInvoice } },
        'docx'
      );
      expect(resolveSpy).not.toHaveBeenCalledWith(
        COMPANY_A_ID,
        '/api/company/branding/assets/current-qr/file',
        expect.anything()
      );
    });

    it('17. P1 JPG/PNG Export Fidelity: Dynamic Discount/Tax columns and all Visual-Layout visibility flags are respected', () => {
      const baseLayout = createDefaultPrintSettings().layouts.INVOICE;

      // Explicitly hide discount, show tax
      const noDiscountCols = resolveImageExportColumns(
        { ...baseLayout, showDiscountColumn: false, showTaxColumn: true },
        500
      );
      expect(noDiscountCols.map((c) => c.key)).toEqual(['sn', 'desc', 'qty', 'rate', 'tax', 'amt']);
      expect(noDiscountCols.reduce((s, c) => s + c.width, 0)).toBeCloseTo(500, 5);

      // Discount enabled + Tax shown
      const withDiscountCols = resolveImageExportColumns(
        { ...baseLayout, showDiscountColumn: true, showTaxColumn: true },
        500
      );
      expect(withDiscountCols.map((c) => c.key)).toEqual([
        'sn',
        'desc',
        'qty',
        'rate',
        'disc',
        'tax',
        'amt',
      ]);
      expect(withDiscountCols.reduce((s, c) => s + c.width, 0)).toBeCloseTo(500, 5);

      // Discount enabled + Tax hidden
      const noTaxCols = resolveImageExportColumns(
        { ...baseLayout, showDiscountColumn: true, showTaxColumn: false },
        500
      );
      expect(noTaxCols.map((c) => c.key)).toEqual(['sn', 'desc', 'qty', 'rate', 'disc', 'amt']);
      expect(noTaxCols.reduce((s, c) => s + c.width, 0)).toBeCloseTo(500, 5);

      // Visual layout visibility flags
      const elements = normalizeDocumentVisualElements(
        baseLayout.elements,
        baseLayout.paperSize,
        baseLayout.orientation,
        baseLayout.margins
      );
      const hiddenAllElements = {
        ...elements,
        logo: { ...elements.logo, visible: false },
        companyName: { ...elements.companyName, visible: false },
        companyHeader: { ...elements.companyHeader, visible: false },
        customerDetails: { ...elements.customerDetails, visible: false },
        dates: { ...elements.dates, visible: false },
        tableHeadings: { ...elements.tableHeadings, visible: false },
        financialTotals: { ...elements.financialTotals, visible: false },
        termsAndConditions: { ...elements.termsAndConditions, visible: false },
        seal: { ...elements.seal, visible: false },
        signature: { ...elements.signature, visible: false },
        signatoryLabels: { ...elements.signatoryLabels, visible: false },
        footer: { ...elements.footer, visible: false },
      };

      const vis = resolveImageExportVisibility({
        ...baseLayout,
        visualLayoutEnabled: true,
        elements: hiddenAllElements,
      });
      expect(vis.showLogo).toBe(false);
      expect(vis.showCompanyName).toBe(false);
      expect(vis.showCompanyHeader).toBe(false);
      expect(vis.showCustomerDetails).toBe(false);
      expect(vis.showDates).toBe(false);
      expect(vis.showTableHeadings).toBe(false);
      expect(vis.showFinancialTotals).toBe(false);
      expect(vis.showTermsAndConditions).toBe(false);
      expect(vis.showSeal).toBe(false);
      expect(vis.showSignature).toBe(false);
      expect(vis.showSignatoryLabels).toBe(false);
      expect(vis.showSignatureBlock).toBe(false);
      expect(vis.showFooter).toBe(false);
    });

    it('18. P1 JPG/PNG Export Fidelity: Measured wrapped text never overlaps footer, QR space reservation strictly follows shouldDisplayPaymentQr, and missing receipt allocations are safe', () => {
      const profile = buildCompanyProfile({
        paymentQrUrl: '/api/company/branding/assets/qr-1/file',
      });
      const baseLayout = createDefaultPrintSettings().layouts.INVOICE;

      // Stress-test heavy wrapped descriptions + long notes + long terms on A5
      const longParagraph = Array.from(
        { length: 28 },
        (_, i) => `Clause ${i + 1}: All deliverables remain subject to final client sign-off and reconciliation.`
      ).join(' ');
      const wrappedInvoice = buildSampleInvoice({
        lines: Array.from({ length: 12 }, (_, idx) => ({
          id: `wrap-${idx + 1}`,
          lineNumber: idx + 1,
          itemDescription: `Deliverable #${idx + 1}: Comprehensive multi-location production shoot, color grading, sound design, and archival mastering package for regional campaign rollout.`,
          quantity: '1.00',
          unitPrice: '5000.00',
          discountAmount: '250.00',
          taxRate: '18.00',
          taxAmount: '855.00',
          lineTotal: '5605.00',
        })),
        notes: longParagraph,
        terms: longParagraph,
      });

      const wrappedPlan = planImageExportPages(
        {
          document: { type: 'INVOICE', data: wrappedInvoice },
          companyProfile: profile,
          layoutOverride: {
            ...baseLayout,
            paperSize: 'A5',
            orientation: 'portrait',
            showDiscountColumn: true,
            showPaymentQr: true,
          },
        },
        'standard'
      );

      expect(wrappedPlan.pages.length).toBeGreaterThan(2);
      // Every single page must strictly stop at or above footerTopPt (zero footer overlap)
      for (const page of wrappedPlan.pages) {
        expect(page.maxContentBottomPt).toBeLessThanOrEqual(page.footerTopPt);
      }
      // Every line item must be accounted for
      expect(wrappedPlan.pages.reduce((sum, p) => sum + p.lines.length, 0)).toBe(12);
      expect(wrappedPlan.pages.some((p) => p.notesLines.length > 0)).toBe(true);
      expect(wrappedPlan.pages.some((p) => p.termsLines.length > 0)).toBe(true);
      expect(wrappedPlan.pages.some((p) => p.includeQrAndSignature)).toBe(true);

      // QR reservation checks
      const unpaidInvoice = buildSampleInvoice({ status: 'ISSUED', balanceDue: '9210.00' });
      const paidInvoice = buildSampleInvoice({ status: 'PAID', balanceDue: '0.00' });

      const disabledQrPlan = planImageExportPages({
        document: { type: 'INVOICE', data: unpaidInvoice },
        companyProfile: profile,
        layoutOverride: { ...baseLayout, showPaymentQr: false },
      });
      expect(disabledQrPlan.effectiveShowQr).toBe(false);
      expect(disabledQrPlan.qrReservedPt).toBe(0);

      const paidDefaultPlan = planImageExportPages({
        document: { type: 'INVOICE', data: paidInvoice },
        companyProfile: profile,
        layoutOverride: { ...baseLayout, showPaymentQr: true },
      });
      expect(paidDefaultPlan.effectiveShowQr).toBe(false);
      expect(paidDefaultPlan.qrReservedPt).toBe(0);

      const paidOverridePlan = planImageExportPages({
        document: { type: 'INVOICE', data: paidInvoice },
        companyProfile: profile,
        layoutOverride: { ...baseLayout, showPaymentQr: true },
        includePaymentQr: true,
      });
      expect(paidOverridePlan.effectiveShowQr).toBe(true);
      expect(paidOverridePlan.qrReservedPt).toBeGreaterThan(0);

      const explicitlyHiddenPlan = planImageExportPages({
        document: { type: 'INVOICE', data: unpaidInvoice },
        companyProfile: profile,
        layoutOverride: { ...baseLayout, showPaymentQr: true },
        includePaymentQr: false,
      });
      expect(explicitlyHiddenPlan.effectiveShowQr).toBe(false);
      expect(explicitlyHiddenPlan.qrReservedPt).toBe(0);

      // Defensive missing receipt allocations must not throw
      const receiptWithoutAllocations = {
        id: 'rcpt-missing-alloc',
        companyId: COMPANY_A_ID,
        receiptNumber: 'RCPT-2026-0009',
        customerId: 'cust-1',
        customerName: 'Horizon Ventures LLP',
        receiptDate: '2026-03-15',
        currency: 'INR',
        status: 'POSTED',
        paymentMethod: 'BANK_TRANSFER',
        amount: '5000.00',
        allocatedTotal: '0.00',
        unallocatedAmount: '5000.00',
        referenceNumber: 'UTR-12345',
        notes: 'Advance payment',
        allocations: undefined,
      } as unknown as CustomerReceiptItem;

      expect(() =>
        planImageExportPages({
          document: { type: 'RECEIPT', data: receiptWithoutAllocations },
          companyProfile: profile,
        })
      ).not.toThrow();
    });

    it('19. Additional Corrections: Preview data-URI decoding, document-switch reset key, XLSX XML 1.0 sanitization & receipt allocations guard, and QR size dropdown labels', async () => {
      // 1. Preview Mode data:image URI decoding (PNG & JPEG valid; SVG/HTML/spoofed/oversized rejected)
      const validPng = makeValidPngBuffer(120, 120, 0x22);
      const validJpeg = makeMinimalJpegBuffer(120, 120);
      const pngDataUri = `data:image/png;base64,${validPng.toString('base64')}`;
      const jpegDataUri = `data:image/jpeg;base64,${validJpeg.toString('base64')}`;

      const decodedPng = decodePreviewRasterDataUri(pngDataUri);
      expect(decodedPng).not.toBeNull();
      expect(Buffer.from(decodedPng!).equals(validPng)).toBe(true);

      const decodedJpeg = decodePreviewRasterDataUri(jpegDataUri);
      expect(decodedJpeg).not.toBeNull();
      expect(Buffer.from(decodedJpeg!).equals(validJpeg)).toBe(true);

      expect(
        decodePreviewRasterDataUri(
          `data:image/svg+xml;base64,${Buffer.from('<svg></svg>').toString('base64')}`
        )
      ).toBeNull();
      expect(
        decodePreviewRasterDataUri(
          `data:text/html;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`
        )
      ).toBeNull();
      // Spoofed MIME (PNG bytes labeled as JPEG)
      expect(
        decodePreviewRasterDataUri(`data:image/jpeg;base64,${validPng.toString('base64')}`)
      ).toBeNull();
      expect(decodePreviewRasterDataUri('https://example.com/qr.png')).toBeNull();

      // Preview DOCX with decoded data-URI QR embeds image cleanly
      const previewDocx = await generateDocxBuffer({
        document: { type: 'INVOICE', data: buildSampleInvoice() },
        companyProfile: buildCompanyProfile(),
        layoutOverride: {
          ...createDefaultPrintSettings().layouts.INVOICE,
          showPaymentQr: true,
        },
        brandingImages: { paymentQr: decodedPng },
      });
      const previewDocXml = readZipEntryText(new Uint8Array(previewDocx), 'word/document.xml');
      expect(previewDocXml).toContain('a:blip');

      // 2. Document-switch reset key & PrintableDocumentView effect wiring
      const inv1 = buildSampleInvoice({ id: 'inv-1' });
      const inv2 = buildSampleInvoice({ id: 'inv-2' });
      expect(getDocumentPreviewResetKey({ type: 'INVOICE', data: inv1 })).toBe('INVOICE:inv-1');
      expect(getDocumentPreviewResetKey({ type: 'INVOICE', data: inv2 })).toBe('INVOICE:inv-2');
      expect(getDocumentPreviewResetKey({ type: 'INVOICE', data: inv1 })).not.toBe(
        getDocumentPreviewResetKey({ type: 'INVOICE', data: inv2 })
      );

      const printableSrc = fs.readFileSync(
        path.resolve(process.cwd(), 'src/client/components/print/PrintableDocumentView.tsx'),
        'utf8'
      );
      expect(printableSrc).toContain('useEffect(() => {');
      expect(printableSrc).toContain('setCopyLabel(\'\');');
      expect(printableSrc).toContain('setIncludePaymentQrOverride(undefined);');
      expect(printableSrc).toContain('}, [documentResetKey]);');

      // 3. XLSX XML 1.0 control-char stripping, visual-layout companyHeader hiding, and missing receipt allocations guard
      const dirtyInvoice = buildSampleInvoice({
        notes: 'Valid note\u0000with\u0007control\u000Bchars\u001Fremoved',
      });
      const baseLayout = createDefaultPrintSettings().layouts.INVOICE;
      const elements = normalizeDocumentVisualElements(
        baseLayout.elements,
        baseLayout.paperSize,
        baseLayout.orientation,
        baseLayout.margins
      );
      const xlsxBytes = generateXlsxBytes({
        document: { type: 'INVOICE', data: dirtyInvoice },
        companyProfile: buildCompanyProfile(),
        layoutOverride: {
          ...baseLayout,
          visualLayoutEnabled: true,
          elements: {
            ...elements,
            companyHeader: { ...elements.companyHeader, visible: false },
          },
        },
      });
      const sheetXml = readZipEntryText(xlsxBytes, 'xl/worksheets/sheet1.xml');
      expect(sheetXml).toContain('Valid notewithcontrolcharsremoved');
      expect(sheetXml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/);
      expect(sheetXml).not.toContain('42 MG Road, 3rd Floor');

      const receiptMissingAlloc = {
        id: 'rcpt-xlsx-missing-alloc',
        companyId: COMPANY_A_ID,
        receiptNumber: 'RCPT-2026-0010',
        customerId: 'cust-1',
        customerName: 'Horizon Ventures LLP',
        receiptDate: '2026-03-15',
        currency: 'INR',
        status: 'POSTED',
        paymentMethod: 'UPI',
        amount: '2500.00',
        allocatedTotal: '0.00',
        unallocatedAmount: '2500.00',
        allocations: undefined,
      } as unknown as CustomerReceiptItem;
      expect(() =>
        generateXlsxBytes({
          document: { type: 'RECEIPT', data: receiptMissingAlloc },
          companyProfile: buildCompanyProfile(),
        })
      ).not.toThrow();

      // 4. QR size dropdown labels in DocumentPrintSettingsSection.tsx match resolvePaymentQrDisplaySizeMm()
      const settingsSectionSrc = fs.readFileSync(
        path.resolve(process.cwd(), 'src/client/components/company/DocumentPrintSettingsSection.tsx'),
        'utf8'
      );
      expect(settingsSectionSrc).toContain(`Small (${resolvePaymentQrDisplaySizeMm('sm')} mm)`);
      expect(settingsSectionSrc).toContain(`Medium (${resolvePaymentQrDisplaySizeMm('md')} mm)`);
      expect(settingsSectionSrc).toContain(`Large (${resolvePaymentQrDisplaySizeMm('lg')} mm)`);
    });
  });
});
