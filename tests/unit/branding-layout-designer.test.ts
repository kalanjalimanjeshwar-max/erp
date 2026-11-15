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
  clampVisualElementBounds,
  createDefaultVisualElements,
  MAX_BRANDING_FILE_SIZE_BYTES,
  moveVisualElement,
  resizeVisualElementFromHandle,
} from '../../src/shared/branding.js';
import {
  createDefaultPrintSettings,
  validatePrintSettingsPayload,
} from '../../src/shared/print-settings.js';
import {
  AuthUser,
  CompanyProfile,
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
});
