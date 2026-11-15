/**
 * Shared Company Branding Asset Contracts & Visual Document Layout Coordinate Engine
 * Provides strict client/server validation rules, paper geometry, and aspect-ratio-preserving
 * drag/resize math for Logo, Seal, Signature, Header, Title, and Footer elements.
 */

export type BrandingAssetType = 'LOGO' | 'SEAL' | 'SIGNATURE';

export type VisualElementKey =
  | 'logo'
  | 'seal'
  | 'signature'
  | 'companyHeader'
  | 'documentTitle'
  | 'footer';

export type ResizeCornerHandle = 'nw' | 'ne' | 'sw' | 'se';

export type BrandingPaperSize = 'A4' | 'A5' | 'Letter';
export type BrandingPageOrientation = 'portrait' | 'landscape';

export const MAX_BRANDING_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB
export const MIN_BRANDING_IMAGE_DIM_PX = 16;
export const MAX_BRANDING_IMAGE_DIM_PX = 4096;

export const ALLOWED_BRANDING_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export const ALLOWED_BRANDING_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

export const BRANDING_ASSETS_SETTING_KEY = 'BRANDING_ASSETS_V1';
export const DOCUMENT_BRANDING_SNAPSHOT_PREFIX = 'DOC_BRANDING_SNAPSHOT:';

export const PAPER_SIZE_DIMENSIONS_MM: Record<BrandingPaperSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  Letter: { width: 215.9, height: 279.4 },
};

export interface VisualElementConfig {
  visible: boolean;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  aspectRatio: number; // width / height
  lockAspectRatio: boolean;
  align: 'left' | 'center' | 'right';
  spacingMm: number;
}

export interface DocumentVisualElements {
  logo: VisualElementConfig;
  seal: VisualElementConfig;
  signature: VisualElementConfig;
  companyHeader: VisualElementConfig;
  documentTitle: VisualElementConfig;
  footer: VisualElementConfig;
}

export interface CompanyBrandingAssetItem {
  id: string;
  companyId: string | null; // null only during pre-setup staging
  assetType: BrandingAssetType;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  widthPx: number;
  heightPx: number;
  aspectRatio: number;
  sha256Hash: string;
  url: string;
  status: 'STAGED' | 'ACTIVE' | 'PENDING_APPROVAL' | 'ARCHIVED';
  uploadedByUserId?: string | null;
  createdAt: string;
}

export interface CompanyBrandingAssetsState {
  version: 1;
  logo: CompanyBrandingAssetItem | null;
  seal: CompanyBrandingAssetItem | null;
  signature: CompanyBrandingAssetItem | null;
}

export interface BrandingMarginsMm {
  topMm: number;
  rightMm: number;
  bottomMm: number;
  leftMm: number;
}

export function roundMm(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.round(val * 10) / 10;
}

export function getEffectivePaperDimensionsMm(
  paperSize: BrandingPaperSize,
  orientation: BrandingPageOrientation
): { widthMm: number; heightMm: number } {
  const base = PAPER_SIZE_DIMENSIONS_MM[paperSize] || PAPER_SIZE_DIMENSIONS_MM.A4;
  return orientation === 'landscape'
    ? { widthMm: base.height, heightMm: base.width }
    : { widthMm: base.width, heightMm: base.height };
}

export function createDefaultVisualElements(
  paperSize: BrandingPaperSize = 'A4',
  orientation: BrandingPageOrientation = 'portrait',
  margins: BrandingMarginsMm = { topMm: 14, rightMm: 14, bottomMm: 16, leftMm: 14 }
): DocumentVisualElements {
  const { widthMm, heightMm } = getEffectivePaperDimensionsMm(paperSize, orientation);
  const contentW = Math.max(80, widthMm - margins.leftMm - margins.rightMm);
  const headerTop = margins.topMm;
  const sigTop = Math.max(headerTop + 90, heightMm - margins.bottomMm - 42);
  const footerTop = Math.max(sigTop + 26, heightMm - margins.bottomMm - 10);

  return {
    logo: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(headerTop),
      widthMm: 36,
      heightMm: 14,
      aspectRatio: roundMm(36 / 14),
      lockAspectRatio: true,
      align: 'left',
      spacingMm: 3,
    },
    companyHeader: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(headerTop + 17),
      widthMm: roundMm(contentW * 0.56),
      heightMm: 22,
      aspectRatio: roundMm((contentW * 0.56) / 22),
      lockAspectRatio: false,
      align: 'left',
      spacingMm: 4,
    },
    documentTitle: {
      visible: true,
      xMm: roundMm(margins.leftMm + contentW * 0.58),
      yMm: roundMm(headerTop),
      widthMm: roundMm(contentW * 0.42),
      heightMm: 24,
      aspectRatio: roundMm((contentW * 0.42) / 24),
      lockAspectRatio: false,
      align: 'right',
      spacingMm: 4,
    },
    seal: {
      visible: true,
      xMm: roundMm(widthMm - margins.rightMm - 74),
      yMm: roundMm(sigTop),
      widthMm: 22,
      heightMm: 22,
      aspectRatio: 1,
      lockAspectRatio: true,
      align: 'center',
      spacingMm: 4,
    },
    signature: {
      visible: true,
      xMm: roundMm(widthMm - margins.rightMm - 48),
      yMm: roundMm(sigTop),
      widthMm: 48,
      heightMm: 22,
      aspectRatio: roundMm(48 / 22),
      lockAspectRatio: true,
      align: 'center',
      spacingMm: 2,
    },
    footer: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(footerTop),
      widthMm: roundMm(contentW),
      heightMm: 9,
      aspectRatio: roundMm(contentW / 9),
      lockAspectRatio: false,
      align: 'left',
      spacingMm: 3,
    },
  };
}

export function isImageVisualElement(key: VisualElementKey): boolean {
  return key === 'logo' || key === 'seal' || key === 'signature';
}

export function clampVisualElementBounds(
  el: VisualElementConfig,
  paperWidthMm: number,
  paperHeightMm: number,
  minWidthMm = 8,
  minHeightMm = 6
): VisualElementConfig {
  const safeMinW = Math.max(4, minWidthMm);
  const safeMinH = Math.max(4, minHeightMm);
  const maxW = Math.max(safeMinW, paperWidthMm - 4);
  const maxH = Math.max(safeMinH, paperHeightMm - 4);

  let widthMm = Number.isFinite(el.widthMm) ? Math.min(maxW, Math.max(safeMinW, el.widthMm)) : 30;
  let heightMm = Number.isFinite(el.heightMm) ? Math.min(maxH, Math.max(safeMinH, el.heightMm)) : 16;

  if (el.lockAspectRatio && Number.isFinite(el.aspectRatio) && el.aspectRatio > 0) {
    heightMm = widthMm / el.aspectRatio;
    if (heightMm < safeMinH) {
      heightMm = safeMinH;
      widthMm = Math.min(maxW, heightMm * el.aspectRatio);
    } else if (heightMm > maxH) {
      heightMm = maxH;
      widthMm = Math.min(maxW, heightMm * el.aspectRatio);
    }
  }

  const maxX = Math.max(0, paperWidthMm - widthMm);
  const maxY = Math.max(0, paperHeightMm - heightMm);
  const xMm = Number.isFinite(el.xMm) ? Math.min(maxX, Math.max(0, el.xMm)) : 0;
  const yMm = Number.isFinite(el.yMm) ? Math.min(maxY, Math.max(0, el.yMm)) : 0;

  return {
    ...el,
    xMm: roundMm(xMm),
    yMm: roundMm(yMm),
    widthMm: roundMm(widthMm),
    heightMm: roundMm(heightMm),
    aspectRatio:
      el.aspectRatio && Number.isFinite(el.aspectRatio) && el.aspectRatio > 0
        ? el.aspectRatio
        : Math.max(0.1, widthMm / Math.max(1, heightMm)),
    spacingMm: Number.isFinite(el.spacingMm) ? Math.min(30, Math.max(0, roundMm(el.spacingMm))) : 3,
  };
}

export function moveVisualElement(
  el: VisualElementConfig,
  deltaXMm: number,
  deltaYMm: number,
  paperWidthMm: number,
  paperHeightMm: number
): VisualElementConfig {
  return clampVisualElementBounds(
    {
      ...el,
      xMm: el.xMm + deltaXMm,
      yMm: el.yMm + deltaYMm,
    },
    paperWidthMm,
    paperHeightMm
  );
}

/**
 * Resizes an element from one of its four corners.
 * Preserves aspect ratio by default when `el.lockAspectRatio` is enabled.
 */
export function resizeVisualElementFromHandle(
  el: VisualElementConfig,
  handle: ResizeCornerHandle,
  deltaXMm: number,
  deltaYMm: number,
  paperWidthMm: number,
  paperHeightMm: number,
  minWidthMm = 10,
  minHeightMm = 6
): VisualElementConfig {
  const ratio =
    el.aspectRatio && Number.isFinite(el.aspectRatio) && el.aspectRatio > 0
      ? el.aspectRatio
      : Math.max(0.1, el.widthMm / Math.max(1, el.heightMm));

  const right = el.xMm + el.widthMm;
  const bottom = el.yMm + el.heightMm;

  let nextWidth = el.widthMm;
  let nextHeight = el.heightMm;
  let nextX = el.xMm;
  let nextY = el.yMm;

  const affectsWest = handle === 'nw' || handle === 'sw';
  const affectsNorth = handle === 'nw' || handle === 'ne';

  const rawWidth = affectsWest ? el.widthMm - deltaXMm : el.widthMm + deltaXMm;
  const rawHeight = affectsNorth ? el.heightMm - deltaYMm : el.heightMm + deltaYMm;

  if (el.lockAspectRatio) {
    // Use dominant horizontal or vertical change scaled by aspect ratio
    const widthFromDeltaW = Math.max(minWidthMm, rawWidth);
    const widthFromDeltaH = Math.max(minWidthMm, rawHeight * ratio);
    nextWidth =
      Math.abs(deltaXMm) >= Math.abs(deltaYMm * ratio) ? widthFromDeltaW : widthFromDeltaH;
    nextHeight = nextWidth / ratio;

    if (nextHeight < minHeightMm) {
      nextHeight = minHeightMm;
      nextWidth = nextHeight * ratio;
    }

    // Clamp to max available inside paper relative to anchored edges
    const maxAvailW = affectsWest ? right : paperWidthMm - el.xMm;
    const maxAvailH = affectsNorth ? bottom : paperHeightMm - el.yMm;

    if (nextWidth > maxAvailW) {
      nextWidth = maxAvailW;
      nextHeight = nextWidth / ratio;
    }
    if (nextHeight > maxAvailH) {
      nextHeight = maxAvailH;
      nextWidth = nextHeight * ratio;
    }

    nextX = affectsWest ? right - nextWidth : el.xMm;
    nextY = affectsNorth ? bottom - nextHeight : el.yMm;
  } else {
    nextWidth = Math.max(minWidthMm, rawWidth);
    nextHeight = Math.max(minHeightMm, rawHeight);
    nextX = affectsWest ? right - nextWidth : el.xMm;
    nextY = affectsNorth ? bottom - nextHeight : el.yMm;
  }

  return clampVisualElementBounds(
    {
      ...el,
      xMm: nextX,
      yMm: nextY,
      widthMm: nextWidth,
      heightMm: nextHeight,
    },
    paperWidthMm,
    paperHeightMm,
    minWidthMm,
    minHeightMm
  );
}

/**
 * Validates that a branding URL is either HTTPS/HTTP or a safe server-managed API/static relative path.
 * Blocks javascript:, data:, vbscript:, traversal segments, and backslashes.
 */
export function isValidBrandingUrl(url?: string | null): boolean {
  if (!url) return true;
  const trimmed = url.trim();
  if (!trimmed) return true;
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return false;
  if (trimmed.includes('..') || trimmed.includes('\\')) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^\/[a-zA-Z0-9_\-./]+$/i.test(trimmed)) return true;
  return false;
}

export function sanitizeBrandingUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  return isValidBrandingUrl(trimmed) ? trimmed : '';
}

export function formatFileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
