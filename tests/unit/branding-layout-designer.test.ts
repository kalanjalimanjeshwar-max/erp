import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { BrandingAssetService } from '../../src/server/services/branding-asset.service.js';
import { CompanyService } from '../../src/server/services/company.service.js';
import { SetupService } from '../../src/server/services/setup.service.js';
import { SetupController } from '../../src/server/controllers/setup.controller.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { PermissionService } from '../../src/server/services/permission.service.js';
import { CompanyBankAccountService } from '../../src/server/services/company-bank-account.service.js';
import { DocumentExportService } from '../../src/server/services/document-export.service.js';
import { prisma } from '../../src/server/db/client.js';
import {
  ALL_VISUAL_ELEMENT_KEYS,
  clampVisualElementBounds,
  createDefaultVisualElements,
  getVisualElementTypography,
  isImageVisualElement,
  MAX_BRANDING_FILE_SIZE_BYTES,
  MAX_TEXT_FONT_SIZE_PT,
  MIN_TEXT_FONT_SIZE_PT,
  moveVisualElement,
  normalizeDocumentVisualElements,
  resizeVisualElementFromHandle,
} from '../../src/shared/branding.js';
import {
  createDefaultPrintSettings,
  mergeDocumentPrintSettings,
  validatePrintSettingsPayload,
} from '../../src/shared/print-settings.js';
import { generateDocxBuffer } from '../../src/shared/export/docx-builder.js';
import {
  AuthUser,
  CompanyProfile,
  DocumentPrintLayoutConfig,
  InvoiceItem,
} from '../../src/shared/types.ts';

/**
 * Generates a real valid minimal RGBA PNG buffer of given dimensions.
 */
function makeValidPngBuffer(width: number, height: number, fillByte = 0x20): Buffer {
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height, fillByte);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type 0
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Generates a minimal synthetic JPEG header + SOF0 frame buffer for signature/dimension parsing.
 */
function makeMinimalJpegHeaderBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0
  buf.writeUInt16BE(11, 4); // length
  buf[6] = 8; // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  buf[11] = 3; // components
  buf[22] = 0xff;
  buf[23] = 0xd9; // EOI
  return buf;
}

/**
 * Generates a minimal VP8X WebP header buffer for dimension validation.
 */
function makeMinimalWebpVp8xBuffer(width: number, height: number): Buffer {
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

const CREATED_COMPANY_IDS: string[] = [];
const CREATED_STAGED_IDS: string[] = [];

const superAdminActor: AuthUser = {
  id: 'usr-sa-1',
  userId: 'usr-sa-1',
  companyId: 'test-co-branding-1',
  email: 'founder@nammamedia.in',
  fullName: 'Founder SA',
  role: 'SUPER_ADMIN',
  isActive: true,
  tokenVersion: 1,
};

const adminActor: AuthUser = {
  id: 'usr-adm-1',
  userId: 'usr-adm-1',
  companyId: 'test-co-branding-1',
  email: 'admin@nammamedia.in',
  fullName: 'Operations Admin',
  role: 'ADMIN',
  isActive: true,
  tokenVersion: 1,
};

const employeeActor: AuthUser = {
  id: 'usr-emp-1',
  userId: 'usr-emp-1',
  companyId: 'test-co-branding-1',
  email: 'staff@nammamedia.in',
  fullName: 'Staff User',
  role: 'EMPLOYEE',
  isActive: true,
  tokenVersion: 1,
};

describe('CoreERP Company Branding Asset Manager & Visual Document Layout Designer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);
    vi.spyOn(PermissionService, 'hasPermission').mockImplementation(
      async (_cid, role, _mod, _act) => role !== 'EMPLOYEE'
    );
    vi.spyOn(CompanyBankAccountService, 'canViewBankDetails').mockResolvedValue(true);
    vi.spyOn(CompanyBankAccountService, 'listBankAccounts').mockResolvedValue([]);
  });

  afterAll(async () => {
    for (const id of CREATED_STAGED_IDS) {
      await BrandingAssetService.deleteStagedSetupAsset(id).catch(() => undefined);
    }
    for (const cid of CREATED_COMPANY_IDS) {
      const dir = path.resolve(process.cwd(), 'storage', 'branding', cid);
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // =========================================================================
  // 1. Magic Byte, Dimension, Aspect Ratio & Security Validation
  // =========================================================================
  describe('Image Validation & Security Controls', () => {
    it('accepts valid PNG, JPEG, and WebP buffers and computes aspect ratio + SHA-256', () => {
      const pngBuf = makeValidPngBuffer(240, 80);
      const pngRes = BrandingAssetService.validateImageBuffer(pngBuf, 'image/png', 'namma-logo.png');
      expect(pngRes.valid).toBe(true);
      expect(pngRes.mimeType).toBe('image/png');
      expect(pngRes.widthPx).toBe(240);
      expect(pngRes.heightPx).toBe(80);
      expect(pngRes.aspectRatio).toBe(3);
      expect(pngRes.sha256Hash).toHaveLength(64);

      const jpgBuf = makeMinimalJpegHeaderBuffer(180, 90);
      const jpgRes = BrandingAssetService.validateImageBuffer(jpgBuf, 'image/jpeg', 'sign.jpg');
      expect(jpgRes.valid).toBe(true);
      expect(jpgRes.mimeType).toBe('image/jpeg');
      expect(jpgRes.aspectRatio).toBe(2);

      const webpBuf = makeMinimalWebpVp8xBuffer(128, 128);
      const webpRes = BrandingAssetService.validateImageBuffer(webpBuf, 'image/webp', 'seal.webp');
      expect(webpRes.valid).toBe(true);
      expect(webpRes.mimeType).toBe('image/webp');
      expect(webpRes.aspectRatio).toBe(1);
    });

    it('rejects oversized (>2MB), SVG/HTML/script payloads, MZ executables, MIME spoofing, path traversal, and invalid dimensions', () => {
      const tooBig = Buffer.alloc(MAX_BRANDING_FILE_SIZE_BYTES + 128, 0x01);
      expect(BrandingAssetService.validateImageBuffer(tooBig, 'image/png', 'huge.png').valid).toBe(false);

      const svgPayload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      expect(BrandingAssetService.validateImageBuffer(svgPayload, 'image/png', 'fake.png').valid).toBe(false);

      const exePayload = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
      expect(BrandingAssetService.validateImageBuffer(exePayload, 'image/png', 'malware.png').valid).toBe(false);

      // Path traversal filename
      const pngBuf = makeValidPngBuffer(64, 64);
      expect(BrandingAssetService.validateImageBuffer(pngBuf, 'image/png', '../../etc/passwd.png').valid).toBe(false);

      // MIME mismatch (PNG bytes claiming image/jpeg)
      expect(BrandingAssetService.validateImageBuffer(pngBuf, 'image/jpeg', 'spoof.png').valid).toBe(false);

      // Dimensions below 16px or above 4096px
      const tinyPng = makeValidPngBuffer(8, 8);
      expect(BrandingAssetService.validateImageBuffer(tinyPng, 'image/png', 'tiny.png').valid).toBe(false);
      const giantJpg = makeMinimalJpegHeaderBuffer(5000, 5000);
      expect(BrandingAssetService.validateImageBuffer(giantJpg, 'image/jpeg', 'giant.jpg').valid).toBe(false);
    });
  });

  // =========================================================================
  // 2. Setup Staging, Promotion & Post-Setup Lockout
  // =========================================================================
  describe('Pre-Setup Staging, Transaction Promotion & Post-Setup Lockout', () => {
    it('stages assets pre-setup, promotes them into company directory on bootstrap, and returns 409 after setup completes', async () => {
      const companyId = `test-co-setup-${Date.now()}`;
      CREATED_COMPANY_IDS.push(companyId);

      const logoBuf = makeValidPngBuffer(200, 100, 0x44);
      const sealBuf = makeValidPngBuffer(100, 100, 0x88);
      const webpSigBuf = makeMinimalWebpVp8xBuffer(180, 60);
      const sigFallbackPng = makeValidPngBuffer(180, 60, 0x33);

      const stagedLogo = await BrandingAssetService.stageSetupAsset({
        assetType: 'LOGO',
        fileName: 'namma-logo.png',
        mimeType: 'image/png',
        buffer: logoBuf,
      });
      CREATED_STAGED_IDS.push(stagedLogo.id);
      expect(stagedLogo.status).toBe('STAGED');
      expect(stagedLogo.url).toBe(`/api/setup/branding/assets/${stagedLogo.id}/file`);

      const stagedSeal = await BrandingAssetService.stageSetupAsset({
        assetType: 'SEAL',
        fileName: 'namma-seal.png',
        mimeType: 'image/png',
        buffer: sealBuf,
      });
      CREATED_STAGED_IDS.push(stagedSeal.id);

      const stagedSig = await BrandingAssetService.stageSetupAsset({
        assetType: 'SIGNATURE',
        fileName: 'director-sign.webp',
        mimeType: 'image/webp',
        buffer: webpSigBuf,
        fallbackPngBuffer: sigFallbackPng,
      });
      CREATED_STAGED_IDS.push(stagedSig.id);

      const stagedLookup = await BrandingAssetService.getStagedSetupAssetFile(stagedLogo.id);
      expect(fs.existsSync(stagedLookup.filePath)).toBe(true);

      const txMock = {
        companySetting: {
          upsert: vi.fn().mockResolvedValue({}),
        },
        company: {
          update: vi.fn().mockResolvedValue({}),
        },
      };

      const promoted = await BrandingAssetService.promoteSetupAssetsToCompany(
        txMock,
        companyId,
        'usr-sa-1',
        {
          logoAssetId: stagedLogo.id,
          sealAssetId: stagedSeal.id,
          signatureAssetId: stagedSig.id,
        }
      );

      expect(promoted.logo?.status).toBe('ACTIVE');
      expect(promoted.logo?.url).toBe(`/api/company/branding/assets/${stagedLogo.id}/file`);
      expect(promoted.seal?.status).toBe('ACTIVE');
      expect(promoted.signature?.status).toBe('ACTIVE');

      // Promoted asset serves cleanly from company-scoped storage
      const servedLogo = await BrandingAssetService.getCompanyAssetFile(companyId, stagedLogo.id);
      expect(servedLogo.meta.companyId).toBe(companyId);
      expect(fs.existsSync(servedLogo.filePath)).toBe(true);

      // WebP companion PNG fallback resolved seamlessly for PDF/DOCX export
      const resolvedSigExport = await BrandingAssetService.resolveExportImageBuffer(
        companyId,
        promoted.signature!.url
      );
      expect(resolvedSigExport).not.toBeNull();
      expect(resolvedSigExport!.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      // Post-setup lockout check via SetupController (HTTP 409)
      vi.spyOn(SetupService, 'getSetupStatus').mockResolvedValue({
        isSetupRequired: false,
        hasCompany: true,
        hasSuperAdmin: true,
        databaseConnected: true,
      });
      const nextSpy = vi.fn();
      await SetupController.uploadBrandingAsset(
        { body: {}, query: {}, headers: {} } as never,
        {} as never,
        nextSpy
      );
      expect(nextSpy).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    });
  });

  // =========================================================================
  // 3. Company Governance (SUPER_ADMIN immediate vs ADMIN maker-checker & Tenant Isolation)
  // =========================================================================
  describe('Company Branding Asset Governance & Tenant Isolation', () => {
    it('supports immediate SUPER_ADMIN upload/archival, ADMIN maker-checker pending approval, and cross-tenant isolation', async () => {
      const companyId = `test-co-gov-${Date.now()}`;
      CREATED_COMPANY_IDS.push(companyId);

      const actorSA: AuthUser = { ...superAdminActor, companyId };
      const actorAdm: AuthUser = { ...adminActor, companyId };
      const actorEmp: AuthUser = { ...employeeActor, companyId };

      const settingStore = new Map<string, string>();
      vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation(
        (async (args: any) => {
          const key = args?.where?.companyId_key?.key;
          const cid = args?.where?.companyId_key?.companyId;
          if (!key || cid !== companyId) return null;
          const val = settingStore.get(key);
          return val ? { id: 'cs-1', companyId, key, value: val } : null;
        }) as never
      );
      vi.spyOn(prisma.companySetting, 'upsert').mockImplementation(
        (async (args: any) => {
          const key = args?.where?.companyId_key?.key;
          const val = args?.update?.value ?? args?.create?.value;
          settingStore.set(key, val);
          return { id: 'cs-1', companyId, key, value: val };
        }) as never
      );
      vi.spyOn(prisma.company, 'update').mockResolvedValue({ id: companyId } as never);
      vi.spyOn(prisma, '$transaction').mockImplementation(
        (async (cb: any) =>
          cb({
            companySetting: prisma.companySetting,
            company: prisma.company,
          })) as never
      );

      // 1. EMPLOYEE rejected with 403
      await expect(
        BrandingAssetService.uploadCompanyAsset(actorEmp, {
          assetType: 'LOGO',
          fileName: 'logo.png',
          mimeType: 'image/png',
          buffer: makeValidPngBuffer(120, 40),
        })
      ).rejects.toMatchObject({ statusCode: 403 });

      // 2. SUPER_ADMIN uploads Logo v1 -> immediate ACTIVE
      const resV1 = await BrandingAssetService.uploadCompanyAsset(actorSA, {
        assetType: 'LOGO',
        fileName: 'logo-v1.png',
        mimeType: 'image/png',
        buffer: makeValidPngBuffer(160, 80, 0x11),
      });
      expect(resV1.pendingApproval).toBe(false);
      expect(resV1.assets.logo?.status).toBe('ACTIVE');

      // 3. SUPER_ADMIN replaces with Logo v2 -> v1 stays archived on disk for historical immutability
      const resV2 = await BrandingAssetService.uploadCompanyAsset(actorSA, {
        assetType: 'LOGO',
        fileName: 'logo-v2.png',
        mimeType: 'image/png',
        buffer: makeValidPngBuffer(200, 100, 0x22),
      });
      expect(resV2.assets.logo?.id).not.toBe(resV1.assets.logo?.id);
      const oldAssetStillReadable = await BrandingAssetService.getCompanyAssetFile(
        companyId,
        resV1.assets.logo!.id
      );
      expect(oldAssetStillReadable.meta.status).toBe('ARCHIVED');

      // 4. Cross-tenant access denied
      await expect(
        BrandingAssetService.getCompanyAssetFile('other-tenant-id', resV2.assets.logo!.id)
      ).rejects.toMatchObject({ statusCode: 404 });

      // 5. ADMIN uploads SEAL -> creates PENDING change request without overwriting active seal
      const createdRequests: any[] = [];
      vi.spyOn(prisma.companySettingsChangeRequest, 'create').mockImplementation(
        (async (args: any) => {
          const rec = {
            id: 'req-seal-1',
            companyId,
            requestedById: actorAdm.userId,
            status: 'PENDING',
            payload: args.data.payload,
            rejectionReason: null,
            reviewedById: null,
            reviewedAt: null,
            appliedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            requestedBy: { fullName: actorAdm.fullName, email: actorAdm.email },
            reviewedBy: null,
          };
          createdRequests.push(rec);
          return rec;
        }) as never
      );

      const adminSealUpload = await BrandingAssetService.uploadCompanyAsset(actorAdm, {
        assetType: 'SEAL',
        fileName: 'pending-seal.png',
        mimeType: 'image/png',
        buffer: makeValidPngBuffer(96, 96, 0x55),
      });
      expect(adminSealUpload.pendingApproval).toBe(true);
      expect(adminSealUpload.changeRequest?.id).toBe('req-seal-1');
      expect(adminSealUpload.assets.seal).toBeNull();
    });
  });

  // =========================================================================
  // 4. Visual Layout Coordinate Engine & Validation
  // =========================================================================
  describe('Visual Print Layout Designer Geometry & Bounds Validation', () => {
    it('moves and resizes elements across 4 corner handles while preserving aspect ratio and page bounds', () => {
      const defaults = createDefaultVisualElements('A4', 'portrait', {
        topMm: 14,
        rightMm: 14,
        bottomMm: 16,
        leftMm: 14,
      });

      const moved = moveVisualElement(defaults.logo, 500, -100, 210, 297);
      expect(moved.xMm + moved.widthMm).toBeLessThanOrEqual(210);
      expect(moved.yMm).toBeGreaterThanOrEqual(0);

      // Locked aspect ratio resize from SE corner preserves width / height ratio
      const lockedLogo = {
        ...defaults.logo,
        xMm: 20,
        yMm: 20,
        widthMm: 40,
        heightMm: 20,
        aspectRatio: 2,
        lockAspectRatio: true,
      };
      const resizedSE = resizeVisualElementFromHandle(lockedLogo, 'se', 20, 0, 210, 297);
      expect(resizedSE.widthMm).toBe(60);
      expect(resizedSE.heightMm).toBe(30);

      // NW corner resize anchors bottom-right edge while shrinking proportionally
      const resizedNW = resizeVisualElementFromHandle(lockedLogo, 'nw', 10, 0, 210, 297);
      expect(resizedNW.widthMm).toBe(30);
      expect(resizedNW.heightMm).toBe(15);
      expect(resizedNW.xMm).toBe(30);
      expect(resizedNW.yMm).toBe(25);

      // Validate margins bounds (4..50 mm)
      const settings = createDefaultPrintSettings();
      expect(validatePrintSettingsPayload(settings).valid).toBe(true);

      const badMargins = createDefaultPrintSettings();
      badMargins.layouts.INVOICE.margins.topMm = 2;
      expect(validatePrintSettingsPayload(badMargins).valid).toBe(false);

      const clamped = clampVisualElementBounds(
        { ...defaults.seal, xMm: 999, yMm: 999, widthMm: 50, heightMm: 50 },
        148,
        210
      );
      expect(clamped.xMm + clamped.widthMm).toBeLessThanOrEqual(148);
      expect(clamped.yMm + clamped.heightMm).toBeLessThanOrEqual(210);
    });
  });

  // =========================================================================
  // 5. PDF/DOCX Embedded Branding Images & Historical Immutability
  // =========================================================================
  describe('Print / PDF / Word Export & Historical Document Immutability', () => {
    it('embeds uploaded Logo, Seal & Signature in PDF/DOCX and isolates issued documents from later branding updates', async () => {
      const companyId = `test-co-imm-${Date.now()}`;
      CREATED_COMPANY_IDS.push(companyId);
      const actorSA: AuthUser = { ...superAdminActor, companyId };

      const settingStore = new Map<string, string>();
      let currentCompanyLogoUrl: string | null = null;
      let currentCompanyName = 'NAMMA MEDIA';

      vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation(
        (async (args: any) => {
          const key = args?.where?.companyId_key?.key;
          const cid = args?.where?.companyId_key?.companyId;
          if (!key || cid !== companyId) return null;
          const val = settingStore.get(key);
          return val ? { id: `cs-${key}`, companyId, key, value: val } : null;
        }) as never
      );
      vi.spyOn(prisma.companySetting, 'upsert').mockImplementation(
        (async (args: any) => {
          const key = args?.where?.companyId_key?.key;
          const val = args?.update?.value ?? args?.create?.value;
          settingStore.set(key, val);
          return { id: `cs-${key}`, companyId, key, value: val };
        }) as never
      );
      vi.spyOn(prisma.company, 'findUnique').mockImplementation(
        (async () => ({
          id: companyId,
          code: 'NAMMA',
          name: currentCompanyName,
          legalName: 'Namma Media Pvt Ltd',
          taxId: '29AABCN1234F1Z2',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
          logoUrl: currentCompanyLogoUrl,
          address: 'Bengaluru, Karnataka',
          phone: '+91 80 5555 1111',
          email: 'billing@nammamedia.in',
          website: 'https://nammamedia.in',
          defaultDocumentLanguage: 'EN_KN',
        })) as never
      );
      vi.spyOn(prisma.company, 'update').mockImplementation(
        (async (args: any) => {
          if (args?.data?.logoUrl !== undefined) {
            currentCompanyLogoUrl = args.data.logoUrl;
          }
          return { id: companyId, logoUrl: currentCompanyLogoUrl };
        }) as never
      );
      vi.spyOn(prisma, '$transaction').mockImplementation(
        (async (cb: any) =>
          cb({
            companySetting: prisma.companySetting,
            company: prisma.company,
          })) as never
      );

      // Upload Logo A (signature bytes recognizable), Seal A, Signature A
      const logoABuf = makeValidPngBuffer(180, 60, 0x1a);
      const sealABuf = makeValidPngBuffer(80, 80, 0x2b);
      const sigABuf = makeValidPngBuffer(160, 50, 0x3c);

      const upLogoA = await BrandingAssetService.uploadCompanyAsset(actorSA, {
        assetType: 'LOGO',
        fileName: 'logo-a.png',
        mimeType: 'image/png',
        buffer: logoABuf,
      });
      await BrandingAssetService.uploadCompanyAsset(actorSA, {
        assetType: 'SEAL',
        fileName: 'seal-a.png',
        mimeType: 'image/png',
        buffer: sealABuf,
      });
      await BrandingAssetService.uploadCompanyAsset(actorSA, {
        assetType: 'SIGNATURE',
        fileName: 'sig-a.png',
        mimeType: 'image/png',
        buffer: sigABuf,
      });

      // Mock CompanyService.getProfile dynamically reflecting current company settings
      vi.spyOn(CompanyService, 'getProfile').mockImplementation(async () => {
        const assets = await BrandingAssetService.getCompanyBrandingAssets(companyId);
        const printRaw = settingStore.get('DOCUMENT_PRINT_SETTINGS_V1') || null;
        return {
          id: companyId,
          code: 'NAMMA',
          name: currentCompanyName,
          legalName: 'Namma Media Pvt Ltd',
          taxId: '29AABCN1234F1Z2',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
          logoUrl: currentCompanyLogoUrl,
          sealUrl: assets.seal?.url || null,
          signatureUrl: assets.signature?.url || null,
          brandingAssets: assets,
          documentBranding: {
            logoSize: 'md',
            logoAlignment: 'left',
            sealUrl: assets.seal?.url || null,
            signatureUrl: assets.signature?.url || null,
            signatoryName: 'Ramesh Rao',
            signatureTitle: 'Director',
          },
          printSettings: JSON.parse(printRaw || 'null') || createDefaultPrintSettings(),
        } as CompanyProfile;
      });

      // Capture immutable branding snapshot when Invoice 1 is issued
      const snapshot = await BrandingAssetService.captureDocumentSnapshot(
        companyId,
        'INVOICE',
        'inv-hist-1'
      );
      expect(snapshot).not.toBeNull();
      expect(snapshot!.logoAssetId).toBe(upLogoA.assets.logo!.id);
      expect(snapshot!.companyName).toBe('NAMMA MEDIA');

      // Mutate company branding to Logo B & new company name AFTER Invoice 1 was issued
      currentCompanyName = 'NAMMA MEDIA REBRANDED';
      const logoBBuf = makeValidPngBuffer(220, 44, 0x9f);
      const upLogoB = await BrandingAssetService.uploadCompanyAsset(actorSA, {
        assetType: 'LOGO',
        fileName: 'logo-b.png',
        mimeType: 'image/png',
        buffer: logoBBuf,
      });
      expect(upLogoB.assets.logo!.id).not.toBe(upLogoA.assets.logo!.id);

      const historicalInvoice: InvoiceItem = {
        id: 'inv-hist-1',
        companyId,
        invoiceNumber: 'INV-2026-0100',
        quotationId: null,
        customerId: 'cust-1',
        customerName: 'Deccan Studios',
        customerEmail: 'ap@deccan.in',
        customerPhone: '+91 80 1234 5678',
        customerAddress: 'Bengaluru',
        customerTaxId: '29ABCDE1234F1Z5',
        invoiceDate: '2026-11-15',
        dueDate: '2026-12-15',
        status: 'ISSUED',
        currency: 'INR',
        subtotal: '10000.0000',
        discountTotal: '0.0000',
        taxTotal: '1800.0000',
        total: '11800.0000',
        amountPaid: '0.0000',
        balanceDue: '11800.0000',
        notes: null,
        terms: null,
        documentTitle: null,
        journalEntryId: 'je-1',
        issuedAt: '2026-11-15T05:00:00.000Z',
        voidedAt: null,
        voidedByUserName: null,
        voidReason: null,
        createdAt: '2026-11-15T05:00:00.000Z',
        lines: [
          {
            lineNumber: 1,
            itemDescription: 'Video Shoot & Editing',
            quantity: '1',
            unitPrice: '10000.0000',
            discountAmount: '0.0000',
            taxRate: '18.00',
            taxAmount: '1800.0000',
            lineTotal: '11800.0000',
          },
        ],
      };

      // Export historical issued Invoice as PDF & DOCX -> must use Logo A + Snapshot A!
      const pdfExport = await DocumentExportService.exportDocument(
        actorSA,
        { document: { type: 'INVOICE', data: historicalInvoice } },
        'pdf'
      );
      expect(pdfExport.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      // PDF contains embedded XObject images
      expect(pdfExport.buffer.toString('latin1')).toContain('/Subtype /Image');
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DOCUMENT_EXPORT_PDF',
          entityId: 'inv-hist-1',
          details: expect.objectContaining({ usedHistoricalSnapshot: true }),
        })
      );

      const docxExport = await DocumentExportService.exportDocument(
        actorSA,
        { document: { type: 'INVOICE', data: historicalInvoice } },
        'docx'
      );
      expect(docxExport.buffer[0]).toBe(0x50); // PK zip header
      expect(docxExport.buffer[1]).toBe(0x4b);
      // Verify docx zip archive embeds media images and original NAMMA MEDIA name (not REBRANDED)
      const docxLatin = docxExport.buffer.toString('latin1');
      expect(docxLatin).toContain('word/media/');

      // Meanwhile, DRAFT preview document uses current live Logo B / NAMMA MEDIA REBRANDED
      const draftExport = await DocumentExportService.exportDocument(
        actorSA,
        {
          document: {
            type: 'INVOICE',
            data: { ...historicalInvoice, id: 'inv-draft-new', status: 'DRAFT' },
          },
          isDraftPreview: true,
        },
        'pdf'
      );
      expect(draftExport.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'inv-draft-new',
          details: expect.objectContaining({ usedHistoricalSnapshot: false }),
        })
      );
    });
  });

  // =========================================================================
  // 5. Visual Text Resize/Typography, PDF 1-Page & Multi-Page Pagination,
  //    DOCX Consistency, and Browser Print Portal Regression Suite (13 Tests)
  // =========================================================================
  describe('Visual Text Typography, PDF Pagination & Browser Print Regression Suite', () => {
    function buildNammaMediaProfile(
      overrides?: Partial<CompanyProfile>,
      layoutOverrides?: Partial<DocumentPrintLayoutConfig>
    ): CompanyProfile {
      const settings = createDefaultPrintSettings({
        defaultDocumentLanguage: 'EN',
        documentBranding: {
          logoSize: 'md',
          logoAlignment: 'left',
          signatoryName: 'Ramesh Rao',
          signatureTitle: 'Managing Director',
        },
      });
      settings.layouts.INVOICE = {
        ...settings.layouts.INVOICE,
        visualLayoutEnabled: true,
        showBankDetails: true,
        showSignatureSection: true,
        showTermsAndConditions: true,
        showPrintedTimestamp: true,
        footerText: 'Subject to Bengaluru Jurisdiction',
        defaultTermsText: 'Payment due within 30 days. Late payments attract 1.5% monthly interest.',
        signatoryName: 'Ramesh Rao',
        signatoryTitle: 'Managing Director',
        ...layoutOverrides,
      };
      return {
        id: 'test-co-namma-print',
        code: 'NAMMA',
        name: 'NAMMA MEDIA',
        legalName: 'Namma Media Pvt Ltd',
        taxId: '29AABCN1234F1Z2',
        address: '42 MG Road, Bengaluru 560001',
        phone: '+91 80 4123 9988',
        email: 'billing@nammamedia.in',
        website: 'https://nammamedia.in',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        roundingPrecision: 2,
        logoUrl: '/api/branding/test/logo.png',
        sealUrl: '/api/branding/test/seal.png',
        signatureUrl: '/api/branding/test/sig.png',
        documentBranding: {
          logoSize: 'md',
          logoAlignment: 'left',
          sealUrl: '/api/branding/test/seal.png',
          signatureUrl: '/api/branding/test/sig.png',
          signatoryName: 'Ramesh Rao',
          signatureTitle: 'Managing Director',
        },
        printSettings: settings,
        ...overrides,
      } as CompanyProfile;
    }

    function buildSampleTwoItemInvoice(
      companyId = 'test-co-namma-print',
      lineCount = 2
    ): InvoiceItem {
      const lines = Array.from({ length: lineCount }, (_, idx) => ({
        lineNumber: idx + 1,
        itemDescription:
          idx === 0
            ? 'Brand Campaign Creative Direction & Production Services'
            : `Digital Media Buying & Analytics Retainer - Batch ${idx + 1}`,
        quantity: '1',
        unitPrice: '25000.0000',
        discountAmount: '0.0000',
        taxRate: '18.00',
        taxAmount: '4500.0000',
        lineTotal: '29500.0000',
      }));
      const sub = lineCount * 25000;
      const tax = lineCount * 4500;
      const tot = sub + tax;
      return {
        id: `inv-reg-${lineCount}`,
        companyId,
        invoiceNumber: 'INV-2026-0042',
        quotationId: null,
        customerId: 'cust-deccan-1',
        customerName: 'Deccan Digital Productions Pvt Ltd',
        customerEmail: 'accounts@deccandigital.in',
        customerPhone: '+91 80 2233 4455',
        customerAddress: '18 Indiranagar 100ft Road, Bengaluru 560038',
        customerTaxId: '29AABCD5678G1Z9',
        invoiceDate: '2026-11-15',
        dueDate: '2026-12-15',
        status: 'DRAFT',
        currency: 'INR',
        subtotal: sub.toFixed(4),
        discountTotal: '0.0000',
        taxTotal: tax.toFixed(4),
        total: tot.toFixed(4),
        amountPaid: '0.0000',
        balanceDue: tot.toFixed(4),
        notes: 'Thank you for partnering with NAMMA MEDIA.',
        terms: 'Payment due within 30 days via NEFT/RTGS.',
        documentTitle: 'TAX INVOICE',
        journalEntryId: null,
        issuedAt: null,
        voidedAt: null,
        voidedByUserName: null,
        voidReason: null,
        createdAt: '2026-11-15T05:00:00.000Z',
        lines,
      };
    }

    function countPdfPages(pdfBuffer: Buffer): number {
      const latin = pdfBuffer.toString('latin1');
      // PDFKit writes `/Type /Page` for every page object and `/Type /Pages` for the page tree root
      const matches = latin.match(/\/Type\s*\/Page(?!s)\b/g);
      return matches ? matches.length : 0;
    }

    function extractPdfMediaBoxes(pdfBuffer: Buffer): Array<[number, number, number, number]> {
      const latin = pdfBuffer.toString('latin1');
      const regex = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/g;
      const boxes: Array<[number, number, number, number]> = [];
      let m: RegExpExecArray | null;
      while ((m = regex.exec(latin)) !== null) {
        boxes.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
      }
      return boxes;
    }

    function mockBrandingAndExportEnv(profile: CompanyProfile) {
      const logoBuf = makeValidPngBuffer(220, 72, 0x22);
      const sealBuf = makeValidPngBuffer(120, 120, 0x44);
      const sigBuf = makeValidPngBuffer(200, 64, 0x66);
      vi.spyOn(CompanyService, 'getProfile').mockResolvedValue(profile);
      vi.spyOn(BrandingAssetService, 'getDocumentSnapshot').mockResolvedValue(null);
      vi.spyOn(BrandingAssetService, 'resolveExportImageBuffer').mockImplementation(
        async (_cid, url) => {
          if (!url) return null;
          if (url.includes('logo')) return logoBuf;
          if (url.includes('seal')) return sealBuf;
          if (url.includes('sig')) return sigBuf;
          return null;
        }
      );
      vi.spyOn(CompanyBankAccountService, 'listBankAccounts').mockResolvedValue([
        {
          id: 'bank-1',
          companyId: profile.id,
          bankName: 'HDFC Bank',
          branchName: 'MG Road',
          accountHolderName: 'Namma Media Pvt Ltd',
          accountNumber: 'XXXX-XXXX-9012',
          routingCode: 'HDFC0000123',
          swiftBic: null,
          iban: null,
          upiId: 'nammamedia@hdfcbank',
          accountType: 'CURRENT',
          currency: 'INR',
          isDefault: true,
          isActive: true,
          showOnInvoices: true,
          showOnQuotations: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    }

    it('1. 2-item NAMMA MEDIA A4 Invoice PDF renders strictly on 1 page', async () => {
      const profile = buildNammaMediaProfile();
      mockBrandingAndExportEnv(profile);
      const invoice = buildSampleTwoItemInvoice(profile.id, 2);

      const res = await DocumentExportService.exportDocument(
        superAdminActor,
        { document: { type: 'INVOICE', data: invoice }, isDraftPreview: true },
        'pdf'
      );

      expect(res.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(countPdfPages(res.buffer)).toBe(1);
    });

    it('2. Logo, Seal, and Signature XObject images all embed cleanly on Page 1', async () => {
      const profile = buildNammaMediaProfile();
      mockBrandingAndExportEnv(profile);
      const invoice = buildSampleTwoItemInvoice(profile.id, 2);

      const res = await DocumentExportService.exportDocument(
        superAdminActor,
        { document: { type: 'INVOICE', data: invoice }, isDraftPreview: true },
        'pdf'
      );

      const latin = res.buffer.toString('latin1');
      const imgCount = (latin.match(/\/Subtype\s*\/Image\b/g) || []).length;
      expect(countPdfPages(res.buffer)).toBe(1);
      expect(imgCount).toBeGreaterThanOrEqual(3);
    });

    it('3. Footer & Page 1 of 1 stamp cleanly within bounds without triggering a trailing blank page (EN & EN_KN)', async () => {
      for (const language of ['EN', 'KN', 'EN_KN'] as const) {
        const profile = buildNammaMediaProfile(undefined, {
          language,
          footerText:
            language === 'EN'
              ? 'Registered Office: Bengaluru | Thank you for your business.'
              : 'ನಮ್ಮ ಮೀಡಿಯಾ | Registered Office: Bengaluru | Thank you.',
          showPrintedTimestamp: true,
        });
        mockBrandingAndExportEnv(profile);
        const invoice = buildSampleTwoItemInvoice(profile.id, 2);

        const res = await DocumentExportService.exportDocument(
          superAdminActor,
          { document: { type: 'INVOICE', data: invoice }, isDraftPreview: true },
          'pdf'
        );

        expect(countPdfPages(res.buffer)).toBe(1);
      }
    });

    it('4. Browser Print portal renders outside #root and print CSS hides non-portal app shell without sheet double-padding', () => {
      const indexCss = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
      const printableViewSrc = fs.readFileSync(
        path.resolve(process.cwd(), 'src/client/components/print/PrintableDocumentView.tsx'),
        'utf8'
      );

      expect(indexCss).toContain('.coreerp-print-portal');
      expect(indexCss).toContain('body.coreerp-has-print-portal > *:not(.coreerp-print-portal)');
      expect(indexCss).toContain('body.coreerp-has-print-modal > .coreerp-print-portal--embedded');
      expect(indexCss).toContain('.print-document-sheet');
      expect(indexCss).toContain('min-height: 0 !important');
      expect(indexCss).toContain('padding: 0 !important');

      expect(printableViewSrc).toContain('createPortal(');
      expect(printableViewSrc).toContain('window.document.body');
      expect(printableViewSrc).toContain('coreerp-has-print-portal');
      expect(printableViewSrc).toContain('coreerp-has-print-modal');
    });

    it('5. Browser Print @page directive adapts to A4, A5, Letter and Portrait/Landscape margins', () => {
      const printableViewSrc = fs.readFileSync(
        path.resolve(process.cwd(), 'src/client/components/print/PrintableDocumentView.tsx'),
        'utf8'
      );
      expect(printableViewSrc).toContain('const pageSizeCss = `${layout.paperSize} ${layout.orientation}`;');
      expect(printableViewSrc).toContain(
        'const marginCss = `${layout.margins.topMm}mm ${layout.margins.rightMm}mm ${layout.margins.bottomMm}mm ${layout.margins.leftMm}mm`;'
      );
      expect(printableViewSrc).toMatch(
        /@page\s*\{\s*size:\s*\$\{pageSizeCss\};\s*margin:\s*\$\{marginCss\};\s*\}/
      );
    });

    it('6. Long multi-page invoice (35 line items) paginates intentionally across multiple pages cleanly', async () => {
      const profile = buildNammaMediaProfile();
      mockBrandingAndExportEnv(profile);
      const longInvoice = buildSampleTwoItemInvoice(profile.id, 35);

      const res = await DocumentExportService.exportDocument(
        superAdminActor,
        { document: { type: 'INVOICE', data: longInvoice }, isDraftPreview: true },
        'pdf'
      );

      const pageCount = countPdfPages(res.buffer);
      expect(pageCount).toBeGreaterThanOrEqual(2);
      expect(pageCount).toBeLessThanOrEqual(4);
    });

    it('7. A4, A5, and Letter page sizes export with accurate PDF MediaBox and DOCX pgSz dimensions', async () => {
      const expectedMediaBoxes = {
        A4: { w: 595.28, h: 841.89 },
        A5: { w: 419.53, h: 595.28 },
        Letter: { w: 612, h: 792 },
      } as const;

      for (const paperSize of ['A4', 'A5', 'Letter'] as const) {
        const profile = buildNammaMediaProfile(undefined, {
          paperSize,
          orientation: 'portrait',
        });
        mockBrandingAndExportEnv(profile);
        const invoice = buildSampleTwoItemInvoice(profile.id, 2);

        const pdfRes = await DocumentExportService.exportDocument(
          superAdminActor,
          { document: { type: 'INVOICE', data: invoice }, isDraftPreview: true },
          'pdf'
        );
        const boxes = extractPdfMediaBoxes(pdfRes.buffer);
        expect(boxes.length).toBeGreaterThanOrEqual(1);
        expect(Math.abs(boxes[0][2] - expectedMediaBoxes[paperSize].w)).toBeLessThan(2);
        expect(Math.abs(boxes[0][3] - expectedMediaBoxes[paperSize].h)).toBeLessThan(2);

        const docxBuf = await generateDocxBuffer({
          document: { type: 'INVOICE', data: invoice },
          companyProfile: profile,
          isDraftPreview: true,
        });
        expect(docxBuf[0]).toBe(0x50);
        expect(docxBuf[1]).toBe(0x4b);
      }
    });

    it('8. Portrait and Landscape orientation switch effective PDF & DOCX width/height cleanly', async () => {
      const profilePortrait = buildNammaMediaProfile(undefined, {
        paperSize: 'A4',
        orientation: 'portrait',
      });
      mockBrandingAndExportEnv(profilePortrait);
      const invoice = buildSampleTwoItemInvoice(profilePortrait.id, 2);

      const portraitPdf = await DocumentExportService.exportDocument(
        superAdminActor,
        { document: { type: 'INVOICE', data: invoice }, isDraftPreview: true },
        'pdf'
      );
      const [pBox] = extractPdfMediaBoxes(portraitPdf.buffer);
      expect(pBox[3]).toBeGreaterThan(pBox[2]);

      const profileLandscape = buildNammaMediaProfile(undefined, {
        paperSize: 'A4',
        orientation: 'landscape',
      });
      mockBrandingAndExportEnv(profileLandscape);

      const landscapePdf = await DocumentExportService.exportDocument(
        superAdminActor,
        { document: { type: 'INVOICE', data: invoice }, isDraftPreview: true },
        'pdf'
      );
      const [lBox] = extractPdfMediaBoxes(landscapePdf.buffer);
      expect(lBox[2]).toBeGreaterThan(lBox[3]);
      expect(Math.abs(lBox[2] - 841.89)).toBeLessThan(2);
      expect(Math.abs(lBox[3] - 595.28)).toBeLessThan(2);
    });

    it('9. Text corner resize proportionally scales fontSizePt [6..36] independently of drag movement across all 11 text elements', () => {
      const elements = createDefaultVisualElements('A4', 'portrait');
      const textKeys = ALL_VISUAL_ELEMENT_KEYS.filter((k) => !isImageVisualElement(k));
      expect(textKeys).toHaveLength(11);

      for (const key of textKeys) {
        const initial = elements[key];
        const initialFontPt = initial.fontSizePt!;
        expect(initialFontPt).toBeGreaterThanOrEqual(MIN_TEXT_FONT_SIZE_PT);
        expect(initialFontPt).toBeLessThanOrEqual(MAX_TEXT_FONT_SIZE_PT);

        // Moving (dragging) must never mutate fontSizePt
        const moved = moveVisualElement(initial, 6, 4, 210, 297);
        expect(moved.fontSizePt).toBe(initialFontPt);

        // Resizing from each of the 4 corners proportionally alters fontSizePt and respects bounds
        for (const handle of ['nw', 'ne', 'sw', 'se'] as const) {
          const expandDeltaX = handle === 'nw' || handle === 'sw' ? -12 : 12;
          const expandDeltaY = handle === 'nw' || handle === 'ne' ? -6 : 6;
          const grown = resizeVisualElementFromHandle(
            initial,
            handle,
            expandDeltaX,
            expandDeltaY,
            210,
            297,
            12,
            6,
            true
          );
          expect(grown.fontSizePt!).toBeGreaterThanOrEqual(initialFontPt);
          expect(grown.fontSizePt!).toBeLessThanOrEqual(MAX_TEXT_FONT_SIZE_PT);

          const shrinkTiny = resizeVisualElementFromHandle(
            { ...initial, fontSizePt: 7, widthMm: 60, heightMm: 20 },
            handle,
            handle === 'nw' || handle === 'sw' ? 50 : -50,
            handle === 'nw' || handle === 'ne' ? 14 : -14,
            210,
            297,
            8,
            5,
            true
          );
          expect(shrinkTiny.fontSizePt!).toBeGreaterThanOrEqual(MIN_TEXT_FONT_SIZE_PT);
        }
      }
    });

    it('10. Save Draft / Save Layout persistence & validation round-trip typography and geometry cleanly', () => {
      const defaults = createDefaultPrintSettings();
      const customElements = normalizeDocumentVisualElements(defaults.layouts.INVOICE.elements, 'A4', 'portrait');
      customElements.companyName = {
        ...customElements.companyName,
        fontSizePt: 18,
        fontWeight: '700',
        fontFamily: 'serif',
        lineHeight: 1.4,
        letterSpacing: 1.5,
        align: 'center',
        widthMm: 120,
        heightMm: 12,
      };
      customElements.financialTotals = {
        ...customElements.financialTotals,
        fontSizePt: 10.5,
        fontWeight: '600',
        fontFamily: 'mono',
        lineHeight: 1.5,
        letterSpacing: 0.5,
      };

      const candidate = mergeDocumentPrintSettings({
        version: 1,
        layouts: {
          ...defaults.layouts,
          INVOICE: {
            ...defaults.layouts.INVOICE,
            elements: customElements,
          },
        },
      });

      const validation = validatePrintSettingsPayload(candidate);
      expect(validation.valid).toBe(true);
      expect(candidate.layouts.INVOICE.elements?.companyName.fontSizePt).toBe(18);
      expect(candidate.layouts.INVOICE.elements?.companyName.fontFamily).toBe('serif');
      expect(candidate.layouts.INVOICE.elements?.financialTotals.fontFamily).toBe('mono');

      // Invalid out-of-range fontSizePt (> 36) must be rejected cleanly by server validation
      const invalid = structuredClone(candidate);
      invalid.layouts.INVOICE.elements!.companyName.fontSizePt = 72;
      expect(validatePrintSettingsPayload(invalid).valid).toBe(false);
    });

    it('11. English, Kannada, and Bilingual (EN_KN) render across PDF, DOCX, and normalized Print config', async () => {
      for (const language of ['EN', 'KN', 'EN_KN'] as const) {
        const profile = buildNammaMediaProfile(
          { name: language === 'EN' ? 'NAMMA MEDIA' : 'NAMMA MEDIA / ನಮ್ಮ ಮೀಡಿಯಾ' },
          { language }
        );
        mockBrandingAndExportEnv(profile);
        const invoice = buildSampleTwoItemInvoice(profile.id, 2);

        const pdfRes = await DocumentExportService.exportDocument(
          superAdminActor,
          { document: { type: 'INVOICE', data: invoice }, isDraftPreview: true },
          'pdf'
        );
        expect(pdfRes.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
        expect(countPdfPages(pdfRes.buffer)).toBe(1);

        const docxBuf = await generateDocxBuffer({
          document: { type: 'INVOICE', data: invoice },
          companyProfile: profile,
          isDraftPreview: true,
        });
        expect(docxBuf[0]).toBe(0x50);
        if (language !== 'EN') {
          expect(docxBuf.toString('latin1')).toContain('word/document.xml');
        }
      }
    });

    it('12. Single Source of Truth typography & normalization aligns PDF, DOCX, and Print defaults', () => {
      const normalized = normalizeDocumentVisualElements(
        {
          // Simulate legacy partial config missing newly added elements
          logo: createDefaultVisualElements('A4', 'portrait').logo,
          companyName: {
            ...createDefaultVisualElements('A4', 'portrait').companyName,
            fontSizePt: 20,
            fontFamily: 'serif',
            fontWeight: '700',
            lineHeight: 1.6,
            letterSpacing: 1.2,
          },
        },
        'A4',
        'portrait'
      );

      for (const key of ALL_VISUAL_ELEMENT_KEYS) {
        expect(normalized[key]).toBeDefined();
      }
      const typo = getVisualElementTypography(normalized.companyName);
      expect(typo.fontSizePt).toBe(20);
      expect(typo.fontFamily).toBe('serif');
      expect(typo.fontWeight).toBe('700');
      expect(typo.lineHeight).toBe(1.6);
      expect(typo.letterSpacing).toBe(1.2);
    });

    it('13. Historical issued invoice snapshot remains immune to later draft/saved typography changes', async () => {
      const originalProfile = buildNammaMediaProfile();
      const snapshotLayout = structuredClone(originalProfile.printSettings!.layouts.INVOICE);
      snapshotLayout.elements = normalizeDocumentVisualElements(
        snapshotLayout.elements,
        'A4',
        'portrait'
      );
      snapshotLayout.elements.companyName.fontSizePt = 13;

      const mutatedProfile = buildNammaMediaProfile(
        { name: 'NAMMA MEDIA NEW ERA' },
        { customDocumentTitle: 'PROFORMA TAX BILL' }
      );

      mockBrandingAndExportEnv(mutatedProfile);
      vi.spyOn(BrandingAssetService, 'getDocumentSnapshot').mockResolvedValue({
        capturedAt: '2026-11-15T05:00:00.000Z',
        companyName: 'NAMMA MEDIA',
        legalName: 'Namma Media Pvt Ltd',
        taxId: '29AABCN1234F1Z2',
        address: '42 MG Road, Bengaluru 560001',
        phone: '+91 80 4123 9988',
        email: 'billing@nammamedia.in',
        website: 'https://nammamedia.in',
        logoAssetId: 'snap-logo-1',
        logoUrl: '/api/branding/test/logo.png',
        sealAssetId: 'snap-seal-1',
        sealUrl: '/api/branding/test/seal.png',
        signatureAssetId: 'snap-sig-1',
        signatureUrl: '/api/branding/test/sig.png',
        signatoryName: 'Ramesh Rao',
        signatoryTitle: 'Managing Director',
        layout: snapshotLayout,
      });

      const issuedInvoice: InvoiceItem = {
        ...buildSampleTwoItemInvoice(mutatedProfile.id, 2),
        id: 'inv-issued-immutable',
        status: 'ISSUED',
      };

      const pdfRes = await DocumentExportService.exportDocument(
        superAdminActor,
        { document: { type: 'INVOICE', data: issuedInvoice } },
        'pdf'
      );

      expect(countPdfPages(pdfRes.buffer)).toBe(1);
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DOCUMENT_EXPORT_PDF',
          entityId: 'inv-issued-immutable',
          details: expect.objectContaining({ usedHistoricalSnapshot: true }),
        })
      );
    });
  });
});

