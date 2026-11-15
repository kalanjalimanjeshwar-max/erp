import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db/client.js';
import {
  AuthUser,
  BrandingAssetMutationResponse,
  BrandingAssetType,
  CompanyBrandingAssetItem,
  CompanyBrandingAssetsState,
  CompanyProfile,
  DocumentBrandingSnapshot,
  DocumentPrintLayoutConfig,
  DocumentPrintType,
} from '../../shared/types.js';
import {
  ALLOWED_BRANDING_EXTENSIONS,
  BRANDING_ASSETS_SETTING_KEY,
  DOCUMENT_BRANDING_SNAPSHOT_PREFIX,
  MAX_BRANDING_FILE_SIZE_BYTES,
  MAX_BRANDING_IMAGE_DIM_PX,
  MIN_BRANDING_IMAGE_DIM_PX,
} from '../../shared/branding.js';
import {
  DOCUMENT_PRINT_SETTING_KEY,
  mergeDocumentPrintSettings,
} from '../../shared/print-settings.js';
import { AuditService } from './audit.service.js';

export interface ValidatedBrandingImage {
  valid: boolean;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  extension: 'png' | 'jpg' | 'webp';
  widthPx: number;
  heightPx: number;
  aspectRatio: number;
  sha256Hash: string;
  sanitizedFileName: string;
  error?: string;
}

interface StoredAssetMetaFile {
  id: string;
  companyId: string | null;
  assetType: BrandingAssetType;
  fileName: string;
  storageKey: string;
  fallbackPngKey?: string | null;
  mimeType: string;
  fileSizeBytes: number;
  widthPx: number;
  heightPx: number;
  aspectRatio: number;
  sha256Hash: string;
  status: 'STAGED' | 'ACTIVE' | 'PENDING_APPROVAL' | 'ARCHIVED';
  uploadedByUserId?: string | null;
  createdAt: string;
}

const VALID_ASSET_TYPES = new Set<BrandingAssetType>(['LOGO', 'SEAL', 'SIGNATURE']);

function normalizeMimeType(mime?: string | null): string {
  const clean = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (clean === 'image/jpg' || clean === 'image/pjpeg') return 'image/jpeg';
  return clean;
}

function getExtensionFromFileName(fileName: string): string {
  const base = path.basename(fileName || '');
  const idx = base.lastIndexOf('.');
  return idx >= 0 ? base.slice(idx).toLowerCase() : '';
}

function parsePngDimensions(buffer: Buffer): { widthPx: number; heightPx: number } | null {
  if (buffer.length < 24) return null;
  const sig =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (!sig) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const widthPx = buffer.readUInt32BE(16);
  const heightPx = buffer.readUInt32BE(20);
  if (widthPx <= 0 || heightPx <= 0) return null;
  return { widthPx, heightPx };
}

function parseJpegDimensions(buffer: Buffer): { widthPx: number; heightPx: number } | null {
  if (buffer.length < 12) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return null;

  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) break;

    const marker = buffer[offset];
    offset += 1;

    // Standalone markers (TEM, RST0..RST7, SOI, EOI)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      continue;
    }

    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;

    // SOF markers with frame dimensions (exclude DHT 0xC4, JPG 0xC8, DAC 0xCC)
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isSof && segmentLength >= 7) {
      const heightPx = buffer.readUInt16BE(offset + 3);
      const widthPx = buffer.readUInt16BE(offset + 5);
      if (widthPx > 0 && heightPx > 0) {
        return { widthPx, heightPx };
      }
      return null;
    }

    offset += segmentLength;
  }

  return null;
}

function parseWebpDimensions(buffer: Buffer): { widthPx: number; heightPx: number } | null {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const chunkHeader = buffer.toString('ascii', 12, 16);
  if (chunkHeader === 'VP8 ') {
    // Lossy VP8 bitstream
    if (buffer.length < 30) return null;
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    const widthPx = buffer.readUInt16LE(26) & 0x3fff;
    const heightPx = buffer.readUInt16LE(28) & 0x3fff;
    return widthPx > 0 && heightPx > 0 ? { widthPx, heightPx } : null;
  }

  if (chunkHeader === 'VP8L') {
    // Lossless VP8L bitstream
    if (buffer.length < 25 || buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    const widthPx = (bits & 0x3fff) + 1;
    const heightPx = ((bits >> 14) & 0x3fff) + 1;
    return widthPx > 0 && heightPx > 0 ? { widthPx, heightPx } : null;
  }

  if (chunkHeader === 'VP8X') {
    // Extended WebP canvas size
    if (buffer.length < 30) return null;
    const widthPx = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const heightPx = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return widthPx > 0 && heightPx > 0 ? { widthPx, heightPx } : null;
  }

  return null;
}

function defaultEmptyAssetsState(): CompanyBrandingAssetsState {
  return {
    version: 1,
    logo: null,
    seal: null,
    signature: null,
  };
}

function assetTypeToSlot(assetType: BrandingAssetType): 'logo' | 'seal' | 'signature' {
  if (assetType === 'LOGO') return 'logo';
  if (assetType === 'SEAL') return 'seal';
  return 'signature';
}

export class BrandingAssetService {
  private static readonly STORAGE_ROOT = path.resolve(process.cwd(), 'storage', 'branding');

  private static getCompanyDir(companyId: string): string {
    const safeId = path.basename(companyId);
    if (!safeId || safeId !== companyId || safeId.includes('..') || safeId.startsWith('_')) {
      const err = new Error('Invalid company identifier for branding storage.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    const dir = path.resolve(this.STORAGE_ROOT, safeId);
    if (!dir.startsWith(this.STORAGE_ROOT + path.sep)) {
      const err = new Error('Invalid storage directory.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    return dir;
  }

  private static getSetupStagingDir(): string {
    return path.resolve(this.STORAGE_ROOT, '_setup');
  }

  private static ensureContainedFile(baseDir: string, fileName: string): string {
    const clean = path.basename(fileName);
    if (!clean || clean !== fileName || clean.includes('..')) {
      const err = new Error('Invalid asset path reference.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    const resolved = path.resolve(baseDir, clean);
    if (!resolved.startsWith(baseDir + path.sep)) {
      const err = new Error('Invalid asset storage containment check.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    return resolved;
  }

  static normalizeAssetType(raw: unknown): BrandingAssetType {
    const upper = String(raw || '').trim().toUpperCase();
    if (!VALID_ASSET_TYPES.has(upper as BrandingAssetType)) {
      const err = new Error('Invalid branding asset type. Allowed: LOGO, SEAL, SIGNATURE.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    return upper as BrandingAssetType;
  }

  /**
   * Validates image binary magic bytes, extension, MIME consistency, size (<= 2MB), and pixel dimensions.
   */
  static validateImageBuffer(
    buffer: Buffer,
    declaredMimeType?: string | null,
    fileName?: string | null
  ): ValidatedBrandingImage {
    const rawName = String(fileName || 'branding.png').trim();
    if (rawName.includes('..') || rawName.includes('/') || rawName.includes('\\')) {
      return {
        valid: false,
        mimeType: 'image/png',
        extension: 'png',
        widthPx: 0,
        heightPx: 0,
        aspectRatio: 1,
        sha256Hash: '',
        sanitizedFileName: 'branding.png',
        error: 'Invalid filename containing path traversal characters.',
      };
    }

    const sanitizedFileName =
      path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'branding.png';
    const ext = getExtensionFromFileName(sanitizedFileName);
    if (ext && !(ALLOWED_BRANDING_EXTENSIONS as readonly string[]).includes(ext)) {
      return {
        valid: false,
        mimeType: 'image/png',
        extension: 'png',
        widthPx: 0,
        heightPx: 0,
        aspectRatio: 1,
        sha256Hash: '',
        sanitizedFileName,
        error: `Unsupported file extension "${ext}". Only PNG, JPG, JPEG, and WebP images are permitted.`,
      };
    }

    if (!buffer || buffer.length < 12) {
      return {
        valid: false,
        mimeType: 'image/png',
        extension: 'png',
        widthPx: 0,
        heightPx: 0,
        aspectRatio: 1,
        sha256Hash: '',
        sanitizedFileName,
        error: 'Uploaded image is empty or corrupted.',
      };
    }

    if (buffer.length > MAX_BRANDING_FILE_SIZE_BYTES) {
      return {
        valid: false,
        mimeType: 'image/png',
        extension: 'png',
        widthPx: 0,
        heightPx: 0,
        aspectRatio: 1,
        sha256Hash: '',
        sanitizedFileName,
        error: `File size exceeds the 2 MB limit (uploaded ${(buffer.length / (1024 * 1024)).toFixed(2)} MB).`,
      };
    }

    // Reject script/SVG/HTML text payloads even if disguised
    const headSnippet = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').toLowerCase();
    if (
      headSnippet.includes('<svg') ||
      headSnippet.includes('<html') ||
      headSnippet.includes('<script') ||
      (buffer[0] === 0x4d && buffer[1] === 0x5a) || // MZ executable
      (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) // ELF
    ) {
      return {
        valid: false,
        mimeType: 'image/png',
        extension: 'png',
        widthPx: 0,
        heightPx: 0,
        aspectRatio: 1,
        sha256Hash: '',
        sanitizedFileName,
        error: 'Security policy rejected executable or SVG/HTML file content. Only raster PNG, JPG, JPEG, or WebP images are allowed.',
      };
    }

    let detectedMime: 'image/png' | 'image/jpeg' | 'image/webp' | null = null;
    let extension: 'png' | 'jpg' | 'webp' = 'png';
    let dims: { widthPx: number; heightPx: number } | null = null;

    const pngDims = parsePngDimensions(buffer);
    if (pngDims) {
      detectedMime = 'image/png';
      extension = 'png';
      dims = pngDims;
    } else {
      const jpgDims = parseJpegDimensions(buffer);
      if (jpgDims) {
        detectedMime = 'image/jpeg';
        extension = 'jpg';
        dims = jpgDims;
      } else {
        const webpDims = parseWebpDimensions(buffer);
        if (webpDims) {
          detectedMime = 'image/webp';
          extension = 'webp';
          dims = webpDims;
        }
      }
    }

    if (!detectedMime || !dims) {
      return {
        valid: false,
        mimeType: 'image/png',
        extension: 'png',
        widthPx: 0,
        heightPx: 0,
        aspectRatio: 1,
        sha256Hash: '',
        sanitizedFileName,
        error: 'Image signature or dimensions could not be verified. Upload a valid PNG, JPG, JPEG, or WebP image.',
      };
    }

    const normalizedDeclared = normalizeMimeType(declaredMimeType);
    if (
      normalizedDeclared &&
      normalizedDeclared !== 'application/octet-stream' &&
      normalizedDeclared !== detectedMime
    ) {
      return {
        valid: false,
        mimeType: detectedMime,
        extension,
        widthPx: dims.widthPx,
        heightPx: dims.heightPx,
        aspectRatio: 1,
        sha256Hash: '',
        sanitizedFileName,
        error: `MIME type mismatch: declared "${normalizedDeclared}" does not match actual "${detectedMime}" file content.`,
      };
    }

    if (
      dims.widthPx < MIN_BRANDING_IMAGE_DIM_PX ||
      dims.heightPx < MIN_BRANDING_IMAGE_DIM_PX ||
      dims.widthPx > MAX_BRANDING_IMAGE_DIM_PX ||
      dims.heightPx > MAX_BRANDING_IMAGE_DIM_PX
    ) {
      return {
        valid: false,
        mimeType: detectedMime,
        extension,
        widthPx: dims.widthPx,
        heightPx: dims.heightPx,
        aspectRatio: 1,
        sha256Hash: '',
        sanitizedFileName,
        error: `Image dimensions (${dims.widthPx}×${dims.heightPx}px) must be between ${MIN_BRANDING_IMAGE_DIM_PX}px and ${MAX_BRANDING_IMAGE_DIM_PX}px.`,
      };
    }

    const sha256Hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const aspectRatio = Number((dims.widthPx / dims.heightPx).toFixed(4));

    return {
      valid: true,
      mimeType: detectedMime,
      extension,
      widthPx: dims.widthPx,
      heightPx: dims.heightPx,
      aspectRatio,
      sha256Hash,
      sanitizedFileName,
    };
  }

  private static toPublicAssetItem(
    meta: StoredAssetMetaFile,
    urlPrefix: 'company' | 'setup'
  ): CompanyBrandingAssetItem {
    return {
      id: meta.id,
      companyId: meta.companyId,
      assetType: meta.assetType,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      fileSizeBytes: meta.fileSizeBytes,
      widthPx: meta.widthPx,
      heightPx: meta.heightPx,
      aspectRatio: meta.aspectRatio,
      sha256Hash: meta.sha256Hash,
      url:
        urlPrefix === 'setup'
          ? `/api/setup/branding/assets/${meta.id}/file`
          : `/api/company/branding/assets/${meta.id}/file`,
      status: meta.status,
      uploadedByUserId: meta.uploadedByUserId || null,
      createdAt: meta.createdAt,
    };
  }

  private static validateOptionalFallbackPng(fallbackBuffer?: Buffer | null): Buffer | null {
    if (!fallbackBuffer || fallbackBuffer.length === 0) return null;
    if (fallbackBuffer.length > MAX_BRANDING_FILE_SIZE_BYTES * 2) return null;
    const dims = parsePngDimensions(fallbackBuffer);
    if (!dims) return null;
    return fallbackBuffer;
  }

  /**
   * Stores a pre-setup staged branding asset ONLY when initial company setup is still incomplete.
   */
  static async stageSetupAsset(params: {
    assetType: BrandingAssetType;
    fileName: string;
    mimeType?: string;
    buffer: Buffer;
    fallbackPngBuffer?: Buffer | null;
  }): Promise<CompanyBrandingAssetItem> {
    const validated = this.validateImageBuffer(params.buffer, params.mimeType, params.fileName);
    if (!validated.valid) {
      const err = new Error(validated.error || 'Invalid branding image.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const stagingDir = this.getSetupStagingDir();
    await fs.promises.mkdir(stagingDir, { recursive: true });

    const assetId = crypto.randomUUID();
    const storageKey = `${assetId}.${validated.extension}`;
    const targetFile = this.ensureContainedFile(stagingDir, storageKey);

    let fallbackPngKey: string | null = null;
    const validFallback = this.validateOptionalFallbackPng(params.fallbackPngBuffer);
    if (validated.extension === 'webp' && validFallback) {
      fallbackPngKey = `${assetId}.fallback.png`;
    }

    const meta: StoredAssetMetaFile = {
      id: assetId,
      companyId: null,
      assetType: params.assetType,
      fileName: validated.sanitizedFileName,
      storageKey,
      fallbackPngKey,
      mimeType: validated.mimeType,
      fileSizeBytes: params.buffer.length,
      widthPx: validated.widthPx,
      heightPx: validated.heightPx,
      aspectRatio: validated.aspectRatio,
      sha256Hash: validated.sha256Hash,
      status: 'STAGED',
      uploadedByUserId: null,
      createdAt: new Date().toISOString(),
    };

    const metaFile = this.ensureContainedFile(stagingDir, `${assetId}.meta.json`);
    await fs.promises.writeFile(targetFile, params.buffer);
    if (fallbackPngKey && validFallback) {
      await fs.promises.writeFile(this.ensureContainedFile(stagingDir, fallbackPngKey), validFallback);
    }
    await fs.promises.writeFile(metaFile, JSON.stringify(meta, null, 2));

    return this.toPublicAssetItem(meta, 'setup');
  }

  /**
   * Reads a pre-setup staged branding asset file (blocked once setup completes).
   */
  static async getStagedSetupAssetFile(assetId: string): Promise<{
    filePath: string;
    meta: StoredAssetMetaFile;
  }> {
    const cleanId = path.basename(assetId).replace(/[^a-zA-Z0-9-]/g, '');
    if (!cleanId || cleanId !== assetId) {
      const err = new Error('Invalid staged branding asset identifier.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const stagingDir = this.getSetupStagingDir();
    const metaPath = this.ensureContainedFile(stagingDir, `${cleanId}.meta.json`);
    if (!fs.existsSync(metaPath)) {
      const err = new Error('Staged branding asset not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as StoredAssetMetaFile;
    const filePath = this.ensureContainedFile(stagingDir, meta.storageKey);
    if (!fs.existsSync(filePath)) {
      const err = new Error('Staged branding asset file missing.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }
    return { filePath, meta };
  }

  /**
   * Removes a pre-setup staged asset before bootstrap.
   */
  static async deleteStagedSetupAsset(assetId: string): Promise<void> {
    const cleanId = path.basename(assetId).replace(/[^a-zA-Z0-9-]/g, '');
    if (!cleanId || cleanId !== assetId) return;
    const stagingDir = this.getSetupStagingDir();
    const metaPath = this.ensureContainedFile(stagingDir, `${cleanId}.meta.json`);
    if (!fs.existsSync(metaPath)) return;
    try {
      const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as StoredAssetMetaFile;
      await fs.promises.unlink(this.ensureContainedFile(stagingDir, meta.storageKey)).catch(() => undefined);
      if (meta.fallbackPngKey) {
        await fs.promises.unlink(this.ensureContainedFile(stagingDir, meta.fallbackPngKey)).catch(() => undefined);
      }
      await fs.promises.unlink(metaPath).catch(() => undefined);
    } catch {
      // ignore cleanup failure
    }
  }

  /**
   * Promotes staged setup assets atomically into a newly created Company during initial bootstrap.
   */
  static async promoteSetupAssetsToCompany(
    tx: any,
    companyId: string,
    adminUserId: string,
    brandingAssetIds?: {
      logoAssetId?: string | null;
      sealAssetId?: string | null;
      signatureAssetId?: string | null;
    }
  ): Promise<CompanyBrandingAssetsState> {
    const state = defaultEmptyAssetsState();
    if (!brandingAssetIds) return state;

    const stagingDir = this.getSetupStagingDir();
    const companyDir = this.getCompanyDir(companyId);
    await fs.promises.mkdir(companyDir, { recursive: true });

    const mappings: Array<{ key: 'logo' | 'seal' | 'signature'; assetId?: string | null; expectedType: BrandingAssetType }> = [
      { key: 'logo', assetId: brandingAssetIds.logoAssetId, expectedType: 'LOGO' },
      { key: 'seal', assetId: brandingAssetIds.sealAssetId, expectedType: 'SEAL' },
      { key: 'signature', assetId: brandingAssetIds.signatureAssetId, expectedType: 'SIGNATURE' },
    ];

    for (const item of mappings) {
      if (!item.assetId) continue;
      const cleanId = path.basename(item.assetId).replace(/[^a-zA-Z0-9-]/g, '');
      if (!cleanId || cleanId !== item.assetId) continue;
      const stagedMetaPath = this.ensureContainedFile(stagingDir, `${cleanId}.meta.json`);
      if (!fs.existsSync(stagedMetaPath)) continue;

      const meta = JSON.parse(await fs.promises.readFile(stagedMetaPath, 'utf8')) as StoredAssetMetaFile;
      if (meta.assetType !== item.expectedType) continue;

      const stagedBinaryPath = this.ensureContainedFile(stagingDir, meta.storageKey);
      if (!fs.existsSync(stagedBinaryPath)) continue;

      const destBinaryPath = this.ensureContainedFile(companyDir, meta.storageKey);
      await fs.promises.copyFile(stagedBinaryPath, destBinaryPath);
      await fs.promises.unlink(stagedBinaryPath).catch(() => undefined);

      if (meta.fallbackPngKey) {
        const stagedFallback = this.ensureContainedFile(stagingDir, meta.fallbackPngKey);
        if (fs.existsSync(stagedFallback)) {
          await fs.promises.copyFile(
            stagedFallback,
            this.ensureContainedFile(companyDir, meta.fallbackPngKey)
          );
          await fs.promises.unlink(stagedFallback).catch(() => undefined);
        }
      }

      const promotedMeta: StoredAssetMetaFile = {
        ...meta,
        companyId,
        status: 'ACTIVE',
        uploadedByUserId: adminUserId,
      };
      await fs.promises.writeFile(
        this.ensureContainedFile(companyDir, `${meta.id}.meta.json`),
        JSON.stringify(promotedMeta, null, 2)
      );
      await fs.promises.unlink(stagedMetaPath).catch(() => undefined);

      state[item.key] = this.toPublicAssetItem(promotedMeta, 'company');
    }

    if (state.logo || state.seal || state.signature) {
      await tx.companySetting.upsert({
        where: {
          companyId_key: { companyId, key: BRANDING_ASSETS_SETTING_KEY },
        },
        create: {
          companyId,
          key: BRANDING_ASSETS_SETTING_KEY,
          value: JSON.stringify(state),
        },
        update: {
          value: JSON.stringify(state),
        },
      });

      if (state.logo) {
        await tx.company.update({
          where: { id: companyId },
          data: { logoUrl: state.logo.url },
        });
      }

      const defaults = mergeDocumentPrintSettings(null, {
        documentBranding: {
          logoSize: 'md',
          logoAlignment: 'left',
          sealUrl: state.seal?.url || '',
          signatureUrl: state.signature?.url || '',
        },
      });
      await tx.companySetting.upsert({
        where: {
          companyId_key: { companyId, key: DOCUMENT_PRINT_SETTING_KEY },
        },
        create: {
          companyId,
          key: DOCUMENT_PRINT_SETTING_KEY,
          value: JSON.stringify(defaults),
        },
        update: {
          value: JSON.stringify(defaults),
        },
      });
    }

    return state;
  }

  /**
   * Reads active CompanyBrandingAssetsState from CompanySetting cleanly.
   */
  static async getCompanyBrandingAssets(companyId: string): Promise<CompanyBrandingAssetsState> {
    try {
      const row = await prisma.companySetting.findUnique({
        where: {
          companyId_key: {
            companyId,
            key: BRANDING_ASSETS_SETTING_KEY,
          },
        },
      });
      if (!row?.value) return defaultEmptyAssetsState();
      const parsed = JSON.parse(row.value) as Partial<CompanyBrandingAssetsState>;
      return {
        version: 1,
        logo: parsed.logo || null,
        seal: parsed.seal || null,
        signature: parsed.signature || null,
      };
    } catch {
      return defaultEmptyAssetsState();
    }
  }

  /**
   * Uploads / replaces a company branding asset.
   * - SUPER_ADMIN: stores & activates immediately.
   * - ADMIN: stages pending asset & submits CompanySettingsChangeRequest for SUPER_ADMIN approval.
   * - Other roles: HTTP 403.
   */
  static async uploadCompanyAsset(
    actor: AuthUser,
    params: {
      assetType: BrandingAssetType;
      fileName: string;
      mimeType?: string;
      buffer: Buffer;
      fallbackPngBuffer?: Buffer | null;
    },
    correlationId?: string
  ): Promise<BrandingAssetMutationResponse> {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'ADMIN') {
      const err = new Error('Insufficient permissions to upload company branding assets.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const validated = this.validateImageBuffer(params.buffer, params.mimeType, params.fileName);
    if (!validated.valid) {
      const err = new Error(validated.error || 'Invalid branding asset image.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const companyDir = this.getCompanyDir(actor.companyId);
    await fs.promises.mkdir(companyDir, { recursive: true });

    const assetId = crypto.randomUUID();
    const storageKey = `${assetId}.${validated.extension}`;
    const targetFile = this.ensureContainedFile(companyDir, storageKey);

    let fallbackPngKey: string | null = null;
    const validFallback = this.validateOptionalFallbackPng(params.fallbackPngBuffer);
    if (validated.extension === 'webp' && validFallback) {
      fallbackPngKey = `${assetId}.fallback.png`;
    }

    const isSuperAdmin = actor.role === 'SUPER_ADMIN';
    const meta: StoredAssetMetaFile = {
      id: assetId,
      companyId: actor.companyId,
      assetType: params.assetType,
      fileName: validated.sanitizedFileName,
      storageKey,
      fallbackPngKey,
      mimeType: validated.mimeType,
      fileSizeBytes: params.buffer.length,
      widthPx: validated.widthPx,
      heightPx: validated.heightPx,
      aspectRatio: validated.aspectRatio,
      sha256Hash: validated.sha256Hash,
      status: isSuperAdmin ? 'ACTIVE' : 'PENDING_APPROVAL',
      uploadedByUserId: actor.userId || actor.id,
      createdAt: new Date().toISOString(),
    };

    const metaFile = this.ensureContainedFile(companyDir, `${assetId}.meta.json`);
    await fs.promises.writeFile(targetFile, params.buffer);
    if (fallbackPngKey && validFallback) {
      await fs.promises.writeFile(this.ensureContainedFile(companyDir, fallbackPngKey), validFallback);
    }
    await fs.promises.writeFile(metaFile, JSON.stringify(meta, null, 2));

    const publicAsset = this.toPublicAssetItem(meta, 'company');
    const currentAssets = await this.getCompanyBrandingAssets(actor.companyId);

    if (!isSuperAdmin) {
      const changeRequest = await prisma.companySettingsChangeRequest.create({
        data: {
          companyId: actor.companyId,
          requestedById: actor.userId,
          status: 'PENDING',
          payload: {
            type: 'COMPANY_BRANDING_ASSET',
            operation: 'UPLOAD',
            assetType: params.assetType,
            asset: publicAsset,
          } as object,
        },
        include: {
          requestedBy: { select: { fullName: true, email: true } },
          reviewedBy: { select: { fullName: true } },
        },
      });

      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'BRANDING_ASSET_CHANGE_REQUESTED',
        entity: 'CompanySettingsChangeRequest',
        entityId: changeRequest.id,
        severity: 'INFO',
        correlationId,
        metadata: {
          operation: 'UPLOAD',
          assetType: params.assetType,
          assetId: publicAsset.id,
          mimeType: publicAsset.mimeType,
          dimensions: `${publicAsset.widthPx}x${publicAsset.heightPx}`,
        },
      });

      return {
        asset: publicAsset,
        assets: currentAssets,
        pendingApproval: true,
        changeRequest: {
          id: changeRequest.id,
          companyId: changeRequest.companyId,
          requestedById: changeRequest.requestedById,
          requestedByName: changeRequest.requestedBy?.fullName || null,
          requestedByEmail: changeRequest.requestedBy?.email || null,
          payload: changeRequest.payload as Record<string, unknown>,
          status: changeRequest.status,
          rejectionReason: changeRequest.rejectionReason,
          reviewedById: changeRequest.reviewedById,
          reviewedByName: changeRequest.reviewedBy?.fullName || null,
          reviewedAt: changeRequest.reviewedAt ? changeRequest.reviewedAt.toISOString() : null,
          appliedAt: changeRequest.appliedAt ? changeRequest.appliedAt.toISOString() : null,
          createdAt: changeRequest.createdAt.toISOString(),
          updatedAt: changeRequest.updatedAt.toISOString(),
        },
      };
    }

    const updatedAssets = await prisma.$transaction(async (tx) => {
      return this.applyBrandingAssetMutation(tx, actor.companyId, {
        operation: 'UPLOAD',
        assetType: params.assetType,
        asset: publicAsset,
      });
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'BRANDING_ASSET_UPLOADED',
      entity: 'CompanySetting',
      entityId: actor.companyId,
      severity: 'INFO',
      correlationId,
      metadata: {
        assetType: params.assetType,
        assetId: publicAsset.id,
        mimeType: publicAsset.mimeType,
        dimensions: `${publicAsset.widthPx}x${publicAsset.heightPx}`,
        fileSizeBytes: publicAsset.fileSizeBytes,
      },
    });

    return {
      asset: publicAsset,
      assets: updatedAssets,
      pendingApproval: false,
    };
  }

  /**
   * Removes an active company branding asset (LOGO, SEAL, or SIGNATURE) from active configuration.
   * Preserves historical asset files on disk so past issued documents remain immutable.
   */
  static async removeCompanyAsset(
    actor: AuthUser,
    assetType: BrandingAssetType,
    correlationId?: string
  ): Promise<BrandingAssetMutationResponse> {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'ADMIN') {
      const err = new Error('Insufficient permissions to remove company branding assets.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const currentAssets = await this.getCompanyBrandingAssets(actor.companyId);

    if (actor.role === 'ADMIN') {
      const changeRequest = await prisma.companySettingsChangeRequest.create({
        data: {
          companyId: actor.companyId,
          requestedById: actor.userId,
          status: 'PENDING',
          payload: {
            type: 'COMPANY_BRANDING_ASSET',
            operation: 'REMOVE',
            assetType,
          } as object,
        },
        include: {
          requestedBy: { select: { fullName: true, email: true } },
          reviewedBy: { select: { fullName: true } },
        },
      });

      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'BRANDING_ASSET_CHANGE_REQUESTED',
        entity: 'CompanySettingsChangeRequest',
        entityId: changeRequest.id,
        severity: 'INFO',
        correlationId,
        metadata: {
          operation: 'REMOVE',
          assetType,
        },
      });

      return {
        asset: null,
        assets: currentAssets,
        pendingApproval: true,
        changeRequest: {
          id: changeRequest.id,
          companyId: changeRequest.companyId,
          requestedById: changeRequest.requestedById,
          requestedByName: changeRequest.requestedBy?.fullName || null,
          requestedByEmail: changeRequest.requestedBy?.email || null,
          payload: changeRequest.payload as Record<string, unknown>,
          status: changeRequest.status,
          rejectionReason: changeRequest.rejectionReason,
          reviewedById: changeRequest.reviewedById,
          reviewedByName: changeRequest.reviewedBy?.fullName || null,
          reviewedAt: changeRequest.reviewedAt ? changeRequest.reviewedAt.toISOString() : null,
          appliedAt: changeRequest.appliedAt ? changeRequest.appliedAt.toISOString() : null,
          createdAt: changeRequest.createdAt.toISOString(),
          updatedAt: changeRequest.updatedAt.toISOString(),
        },
      };
    }

    const updatedAssets = await prisma.$transaction(async (tx) => {
      return this.applyBrandingAssetMutation(tx, actor.companyId, {
        operation: 'REMOVE',
        assetType,
      });
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'BRANDING_ASSET_REMOVED',
      entity: 'CompanySetting',
      entityId: actor.companyId,
      severity: 'INFO',
      correlationId,
      metadata: {
        assetType,
      },
    });

    return {
      asset: null,
      assets: updatedAssets,
      pendingApproval: false,
    };
  }

  /**
   * Applies an upload or removal inside an existing Prisma transaction (used by direct SUPER_ADMIN and approval flow).
   */
  static async applyBrandingAssetMutation(
    tx: any,
    companyId: string,
    payload: {
      operation: 'UPLOAD' | 'REMOVE';
      assetType: BrandingAssetType;
      asset?: CompanyBrandingAssetItem | null;
    }
  ): Promise<CompanyBrandingAssetsState> {
    let current = defaultEmptyAssetsState();
    try {
      const existingRow = await tx.companySetting.findUnique({
        where: { companyId_key: { companyId, key: BRANDING_ASSETS_SETTING_KEY } },
      });
      if (existingRow?.value) {
        const parsed = JSON.parse(existingRow.value) as Partial<CompanyBrandingAssetsState>;
        current = {
          version: 1,
          logo: parsed.logo || null,
          seal: parsed.seal || null,
          signature: parsed.signature || null,
        };
      }
    } catch {
      // use empty state
    }

    const slot = assetTypeToSlot(payload.assetType);
    const previousAsset = current[slot];

    // Mark previously active asset metadata as ARCHIVED on disk without deleting binary (historical immutability)
    if (previousAsset?.id) {
      await this.updateStoredMetaStatus(companyId, previousAsset.id, 'ARCHIVED').catch(() => undefined);
    }

    let nextAsset: CompanyBrandingAssetItem | null = null;
    if (payload.operation === 'UPLOAD' && payload.asset) {
      nextAsset = { ...payload.asset, status: 'ACTIVE', companyId };
      await this.updateStoredMetaStatus(companyId, nextAsset.id, 'ACTIVE').catch(() => undefined);
    }

    const nextState: CompanyBrandingAssetsState = {
      ...current,
      [slot]: nextAsset,
    };

    await tx.companySetting.upsert({
      where: {
        companyId_key: { companyId, key: BRANDING_ASSETS_SETTING_KEY },
      },
      create: {
        companyId,
        key: BRANDING_ASSETS_SETTING_KEY,
        value: JSON.stringify(nextState),
      },
      update: {
        value: JSON.stringify(nextState),
      },
    });

    if (payload.assetType === 'LOGO') {
      await tx.company.update({
        where: { id: companyId },
        data: { logoUrl: nextAsset ? nextAsset.url : null },
      });
    }

    // Sync DOCUMENT_PRINT_SETTINGS_V1 default asset URLs and element aspect ratios
    try {
      const printRow = await tx.companySetting.findUnique({
        where: { companyId_key: { companyId, key: DOCUMENT_PRINT_SETTING_KEY } },
      });
      const settings = mergeDocumentPrintSettings(printRow?.value || null, undefined);
      const docTypes: DocumentPrintType[] = ['QUOTATION', 'INVOICE', 'RECEIPT'];
      for (const dt of docTypes) {
        const layout = settings.layouts[dt];
        if (payload.assetType === 'SEAL') {
          layout.sealUrl = nextAsset ? nextAsset.url : '';
          if (nextAsset?.aspectRatio) {
            layout.elements.seal.aspectRatio = nextAsset.aspectRatio;
            if (layout.elements.seal.lockAspectRatio) {
              layout.elements.seal.heightMm = Number(
                (layout.elements.seal.widthMm / nextAsset.aspectRatio).toFixed(1)
              );
            }
          }
        } else if (payload.assetType === 'SIGNATURE') {
          layout.signatureUrl = nextAsset ? nextAsset.url : '';
          if (nextAsset?.aspectRatio) {
            layout.elements.signature.aspectRatio = nextAsset.aspectRatio;
            if (layout.elements.signature.lockAspectRatio) {
              layout.elements.signature.heightMm = Number(
                (layout.elements.signature.widthMm / nextAsset.aspectRatio).toFixed(1)
              );
            }
          }
        } else if (payload.assetType === 'LOGO' && nextAsset?.aspectRatio) {
          layout.elements.logo.aspectRatio = nextAsset.aspectRatio;
          if (layout.elements.logo.lockAspectRatio) {
            layout.elements.logo.heightMm = Number(
              (layout.elements.logo.widthMm / nextAsset.aspectRatio).toFixed(1)
            );
          }
        }
      }

      await tx.companySetting.upsert({
        where: { companyId_key: { companyId, key: DOCUMENT_PRINT_SETTING_KEY } },
        create: {
          companyId,
          key: DOCUMENT_PRINT_SETTING_KEY,
          value: JSON.stringify(settings),
        },
        update: {
          value: JSON.stringify(settings),
        },
      });
    } catch {
      // gracefully tolerate partial mocks
    }

    return nextState;
  }

  private static async updateStoredMetaStatus(
    companyId: string,
    assetId: string,
    status: StoredAssetMetaFile['status']
  ): Promise<void> {
    const cleanId = path.basename(assetId).replace(/[^a-zA-Z0-9-]/g, '');
    if (!cleanId || cleanId !== assetId) return;
    const companyDir = this.getCompanyDir(companyId);
    const metaPath = this.ensureContainedFile(companyDir, `${cleanId}.meta.json`);
    if (!fs.existsSync(metaPath)) return;
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as StoredAssetMetaFile;
    meta.status = status;
    await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
  }

  /**
   * Resolves stored asset file path and metadata strictly scoped to the actor's company.
   * Never exposes OS filesystem paths in API responses.
   */
  static async getCompanyAssetFile(
    companyId: string,
    assetId: string
  ): Promise<{ filePath: string; fallbackPngPath: string | null; meta: StoredAssetMetaFile }> {
    const cleanId = path.basename(assetId).replace(/[^a-zA-Z0-9-]/g, '');
    if (!cleanId || cleanId !== assetId) {
      const err = new Error('Invalid branding asset identifier.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const companyDir = this.getCompanyDir(companyId);
    const metaPath = this.ensureContainedFile(companyDir, `${cleanId}.meta.json`);
    if (!fs.existsSync(metaPath)) {
      const err = new Error('Branding asset not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as StoredAssetMetaFile;
    if (meta.companyId !== companyId) {
      const err = new Error('Access denied to branding asset.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const filePath = this.ensureContainedFile(companyDir, meta.storageKey);
    if (!fs.existsSync(filePath)) {
      const err = new Error('Branding asset binary not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    let fallbackPngPath: string | null = null;
    if (meta.fallbackPngKey) {
      const candidate = this.ensureContainedFile(companyDir, meta.fallbackPngKey);
      if (fs.existsSync(candidate)) fallbackPngPath = candidate;
    }

    return { filePath, fallbackPngPath, meta };
  }

  /**
   * Resolves a PDFKit / DOCX compatible raster Buffer (PNG or JPEG) from a branding asset URL or ID.
   * Never reads arbitrary OS paths outside storage/branding/<companyId> or public/.
   */
  static async resolveExportImageBuffer(
    companyId: string,
    url?: string | null
  ): Promise<Buffer | null> {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed) return null;

    const apiMatch = trimmed.match(/^\/api\/company\/branding\/assets\/([a-zA-Z0-9-]+)\/file$/);
    if (apiMatch && apiMatch[1]) {
      try {
        const { filePath, fallbackPngPath, meta } = await this.getCompanyAssetFile(
          companyId,
          apiMatch[1]
        );
        if ((meta.mimeType === 'image/png' || meta.mimeType === 'image/jpeg') && fs.existsSync(filePath)) {
          return await fs.promises.readFile(filePath);
        }
        if (meta.mimeType === 'image/webp' && fallbackPngPath && fs.existsSync(fallbackPngPath)) {
          return await fs.promises.readFile(fallbackPngPath);
        }
        return null;
      } catch {
        return null;
      }
    }

    // Fallback: safe local workspace static asset under /public
    if (trimmed.startsWith('/') && !trimmed.includes('..') && !trimmed.includes('\\')) {
      const cleaned = trimmed.replace(/^\/+/, '');
      const publicRoot = path.resolve(process.cwd(), 'public');
      const candidate = path.resolve(publicRoot, cleaned);
      if (candidate.startsWith(publicRoot + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const buf = await fs.promises.readFile(candidate);
        if (parsePngDimensions(buf) || parseJpegDimensions(buf)) {
          return buf;
        }
      }
    }

    return null;
  }

  /**
   * Captures an immutable branding & print-layout snapshot for an issued/accepted/posted document.
   * Guarantees future logo/seal/signature/layout updates never silently alter historical issued documents.
   */
  static async captureDocumentSnapshot(
    companyId: string,
    docType: DocumentPrintType,
    docId: string,
    tx?: any
  ): Promise<DocumentBrandingSnapshot | null> {
    const db = tx || prisma;
    try {
      const snapshotKey = `${DOCUMENT_BRANDING_SNAPSHOT_PREFIX}${docType}:${docId}`;
      const existing = await db.companySetting?.findUnique?.({
        where: { companyId_key: { companyId, key: snapshotKey } },
      });
      if (existing?.value) {
        return JSON.parse(existing.value) as DocumentBrandingSnapshot;
      }

      const company = await db.company?.findUnique?.({
        where: { id: companyId },
      });
      if (!company) return null;

      let assets = defaultEmptyAssetsState();
      try {
        const assetsRow = await db.companySetting?.findUnique?.({
          where: { companyId_key: { companyId, key: BRANDING_ASSETS_SETTING_KEY } },
        });
        if (assetsRow?.value) {
          assets = JSON.parse(assetsRow.value) as CompanyBrandingAssetsState;
        }
      } catch {
        // fallback empty
      }

      let printRaw: unknown = null;
      try {
        const printRow = await db.companySetting?.findUnique?.({
          where: { companyId_key: { companyId, key: DOCUMENT_PRINT_SETTING_KEY } },
        });
        printRaw = printRow?.value || null;
      } catch {
        // fallback defaults
      }

      const printSettings = mergeDocumentPrintSettings(printRaw, {
        defaultDocumentLanguage: company.defaultDocumentLanguage,
        documentBranding: {
          logoSize: 'md',
          logoAlignment: 'left',
          sealUrl: assets.seal?.url || null,
          signatureUrl: assets.signature?.url || null,
        },
      });
      const layout: DocumentPrintLayoutConfig = printSettings.layouts[docType];

      const snapshot: DocumentBrandingSnapshot = {
        capturedAt: new Date().toISOString(),
        companyName: company.name,
        legalName: company.legalName || null,
        taxId: company.taxId || null,
        address: company.address || null,
        phone: company.phone || null,
        email: company.email || null,
        website: company.website || null,
        logoUrl: assets.logo?.url || company.logoUrl || null,
        sealUrl: assets.seal?.url || layout.sealUrl || null,
        signatureUrl: assets.signature?.url || layout.signatureUrl || null,
        logoAssetId: assets.logo?.id || null,
        sealAssetId: assets.seal?.id || null,
        signatureAssetId: assets.signature?.id || null,
        signatoryName: layout.signatoryName || null,
        signatoryTitle: layout.signatoryTitle || null,
        layout,
      };

      await db.companySetting?.upsert?.({
        where: { companyId_key: { companyId, key: snapshotKey } },
        create: {
          companyId,
          key: snapshotKey,
          value: JSON.stringify(snapshot),
        },
        update: {
          value: JSON.stringify(snapshot),
        },
      });

      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Retrieves an existing historical branding snapshot for a document if present.
   */
  static async getDocumentSnapshot(
    companyId: string,
    docType: DocumentPrintType,
    docId: string
  ): Promise<DocumentBrandingSnapshot | null> {
    if (!docId) return null;
    try {
      const snapshotKey = `${DOCUMENT_BRANDING_SNAPSHOT_PREFIX}${docType}:${docId}`;
      const row = await prisma.companySetting.findUnique({
        where: { companyId_key: { companyId, key: snapshotKey } },
      });
      if (!row?.value) return null;
      return JSON.parse(row.value) as DocumentBrandingSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Merges snapshot branding/company fields onto a CompanyProfile for exporting/rendering immutable documents.
   */
  static applySnapshotToCompanyProfile(
    profile: CompanyProfile | null,
    snapshot: DocumentBrandingSnapshot | null | undefined,
    docType: DocumentPrintType
  ): { effectiveProfile: CompanyProfile | null; effectiveLayout?: DocumentPrintLayoutConfig } {
    if (!snapshot) {
      return { effectiveProfile: profile };
    }

    const baseProfile: CompanyProfile = profile || {
      id: 'snapshot-company',
      code: 'SNAPSHOT',
      name: snapshot.companyName,
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    };

    const effectiveProfile: CompanyProfile = {
      ...baseProfile,
      name: snapshot.companyName || baseProfile.name,
      legalName: snapshot.legalName !== undefined ? snapshot.legalName : baseProfile.legalName,
      taxId: snapshot.taxId !== undefined ? snapshot.taxId : baseProfile.taxId,
      address: snapshot.address !== undefined ? snapshot.address : baseProfile.address,
      phone: snapshot.phone !== undefined ? snapshot.phone : baseProfile.phone,
      email: snapshot.email !== undefined ? snapshot.email : baseProfile.email,
      website: snapshot.website !== undefined ? snapshot.website : baseProfile.website,
      logoUrl: snapshot.logoUrl !== undefined ? snapshot.logoUrl : baseProfile.logoUrl,
      sealUrl: snapshot.sealUrl !== undefined ? snapshot.sealUrl : baseProfile.sealUrl,
      signatureUrl:
        snapshot.signatureUrl !== undefined ? snapshot.signatureUrl : baseProfile.signatureUrl,
      documentBranding: {
        logoSize: snapshot.layout?.logoSize || baseProfile.documentBranding?.logoSize || 'md',
        logoAlignment:
          snapshot.layout?.logoPosition || baseProfile.documentBranding?.logoAlignment || 'left',
        sealUrl: snapshot.sealUrl ?? baseProfile.sealUrl ?? null,
        signatureUrl: snapshot.signatureUrl ?? baseProfile.signatureUrl ?? null,
        signatoryName: snapshot.signatoryName ?? baseProfile.documentBranding?.signatoryName ?? null,
        signatureTitle: snapshot.signatoryTitle ?? baseProfile.documentBranding?.signatureTitle ?? null,
      },
      printSettings:
        snapshot.layout && baseProfile.printSettings
          ? {
              ...baseProfile.printSettings,
              layouts: {
                ...baseProfile.printSettings.layouts,
                [docType]: snapshot.layout,
              },
            }
          : baseProfile.printSettings,
    };

    return {
      effectiveProfile,
      effectiveLayout: snapshot.layout,
    };
  }
}
