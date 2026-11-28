/**
 * Shared Company Branding Asset Contracts & Visual Document Layout Coordinate Engine
 * Provides strict client/server validation rules, paper geometry, and aspect-ratio-preserving
 * drag/resize math for Logo, Seal, Signature, Header, Title, and Footer elements.
 */

export type BrandingAssetType = 'LOGO' | 'SEAL' | 'SIGNATURE' | 'PAYMENT_QR';

export type VisualElementKey =
  | 'logo'
  | 'companyName'
  | 'companyHeader'
  | 'documentTitle'
  | 'documentNumber'
  | 'customerDetails'
  | 'dates'
  | 'tableHeadings'
  | 'financialTotals'
  | 'termsAndConditions'
  | 'seal'
  | 'signature'
  | 'signatoryLabels'
  | 'footer';

export const ALL_VISUAL_ELEMENT_KEYS: VisualElementKey[] = [
  'logo',
  'companyName',
  'companyHeader',
  'documentTitle',
  'documentNumber',
  'customerDetails',
  'dates',
  'tableHeadings',
  'financialTotals',
  'termsAndConditions',
  'seal',
  'signature',
  'signatoryLabels',
  'footer',
];

export type VisualTextFontWeight = '400' | '500' | '600' | '700';
export type VisualTextFontFamily = 'sans' | 'serif' | 'mono' | 'noto-kannada';

export const MIN_TEXT_FONT_SIZE_PT = 6;
export const MAX_TEXT_FONT_SIZE_PT = 36;
export const MIN_TEXT_LINE_HEIGHT = 1.0;
export const MAX_TEXT_LINE_HEIGHT = 2.4;
export const MIN_TEXT_LETTER_SPACING = -1;
export const MAX_TEXT_LETTER_SPACING = 6;

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

export const ALLOWED_PAYMENT_QR_MIME_TYPES = ['image/png', 'image/jpeg'] as const;

export const ALLOWED_PAYMENT_QR_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

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
  fontSizePt?: number;
  fontWeight?: VisualTextFontWeight;
  fontFamily?: VisualTextFontFamily;
  lineHeight?: number;
  letterSpacing?: number; // in pt
}

export interface DocumentVisualElements {
  logo: VisualElementConfig;
  companyName: VisualElementConfig;
  companyHeader: VisualElementConfig;
  documentTitle: VisualElementConfig;
  documentNumber: VisualElementConfig;
  customerDetails: VisualElementConfig;
  dates: VisualElementConfig;
  tableHeadings: VisualElementConfig;
  financialTotals: VisualElementConfig;
  termsAndConditions: VisualElementConfig;
  seal: VisualElementConfig;
  signature: VisualElementConfig;
  signatoryLabels: VisualElementConfig;
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
  paymentQr?: CompanyBrandingAssetItem | null;
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

export function roundHalfPt(val: number): number {
  if (!Number.isFinite(val)) return 9;
  return Math.round(val * 2) / 2;
}

export function clampFontSizePt(val: unknown, fallback = 9): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return roundHalfPt(Math.min(MAX_TEXT_FONT_SIZE_PT, Math.max(MIN_TEXT_FONT_SIZE_PT, num)));
}

export function clampLineHeight(val: unknown, fallback = 1.35): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(Math.min(MAX_TEXT_LINE_HEIGHT, Math.max(MIN_TEXT_LINE_HEIGHT, num)) * 100) / 100;
}

export function clampLetterSpacing(val: unknown, fallback = 0): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(Math.min(MAX_TEXT_LETTER_SPACING, Math.max(MIN_TEXT_LETTER_SPACING, num)) * 10) / 10;
}

export function normalizeFontWeight(val: unknown, fallback: VisualTextFontWeight = '400'): VisualTextFontWeight {
  if (val === '400' || val === '500' || val === '600' || val === '700') return val;
  return fallback;
}

export function normalizeFontFamily(val: unknown, fallback: VisualTextFontFamily = 'sans'): VisualTextFontFamily {
  if (val === 'sans' || val === 'serif' || val === 'mono' || val === 'noto-kannada') return val;
  return fallback;
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
  const printableH = Math.max(100, heightMm - margins.topMm - margins.bottomMm);
  const headerTop = margins.topMm;
  const compactScale = printableH < 180;

  const logoH = compactScale ? 11 : 13;
  const nameY = headerTop + logoH + 2;
  const headerY = nameY + (compactScale ? 7 : 8);
  const bodyTop = headerTop + (compactScale ? 33 : 38);
  const partyH = compactScale ? 20 : 25;
  const tableTop = bodyTop + partyH + 4;
  const totalsTop = Math.min(heightMm - margins.bottomMm - 72, tableTop + (compactScale ? 26 : 38));
  const termsTop = Math.min(heightMm - margins.bottomMm - 50, totalsTop + (compactScale ? 26 : 34));
  const sigTop = Math.max(headerTop + 85, heightMm - margins.bottomMm - 36);
  const footerTop = Math.max(sigTop + 26, heightMm - margins.bottomMm - 8);

  const halfW = roundMm((contentW - 4) / 2);

  return {
    logo: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(headerTop),
      widthMm: compactScale ? 28 : 34,
      heightMm: logoH,
      aspectRatio: roundMm((compactScale ? 28 : 34) / logoH),
      lockAspectRatio: true,
      align: 'left',
      spacingMm: 2.5,
    },
    companyName: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(nameY),
      widthMm: roundMm(contentW * 0.56),
      heightMm: 7.5,
      aspectRatio: roundMm((contentW * 0.56) / 7.5),
      lockAspectRatio: false,
      align: 'left',
      spacingMm: 1.5,
      fontSizePt: compactScale ? 12 : 14,
      fontWeight: '700',
      fontFamily: 'sans',
      lineHeight: 1.2,
      letterSpacing: 0,
    },
    companyHeader: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(headerY),
      widthMm: roundMm(contentW * 0.56),
      heightMm: 14,
      aspectRatio: roundMm((contentW * 0.56) / 14),
      lockAspectRatio: false,
      align: 'left',
      spacingMm: 2.5,
      fontSizePt: compactScale ? 7.5 : 8.5,
      fontWeight: '400',
      fontFamily: 'sans',
      lineHeight: 1.35,
      letterSpacing: 0,
    },
    documentTitle: {
      visible: true,
      xMm: roundMm(margins.leftMm + contentW * 0.58),
      yMm: roundMm(headerTop),
      widthMm: roundMm(contentW * 0.42),
      heightMm: 11,
      aspectRatio: roundMm((contentW * 0.42) / 11),
      lockAspectRatio: false,
      align: 'right',
      spacingMm: 2,
      fontSizePt: compactScale ? 13 : 15,
      fontWeight: '700',
      fontFamily: 'sans',
      lineHeight: 1.2,
      letterSpacing: 0.3,
    },
    documentNumber: {
      visible: true,
      xMm: roundMm(margins.leftMm + contentW * 0.58),
      yMm: roundMm(headerTop + 12),
      widthMm: roundMm(contentW * 0.42),
      heightMm: 11,
      aspectRatio: roundMm((contentW * 0.42) / 11),
      lockAspectRatio: false,
      align: 'right',
      spacingMm: 2,
      fontSizePt: compactScale ? 8.5 : 9.5,
      fontWeight: '700',
      fontFamily: 'mono',
      lineHeight: 1.25,
      letterSpacing: 0,
    },
    customerDetails: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(bodyTop),
      widthMm: halfW,
      heightMm: partyH,
      aspectRatio: roundMm(halfW / partyH),
      lockAspectRatio: false,
      align: 'left',
      spacingMm: 3,
      fontSizePt: compactScale ? 8 : 8.5,
      fontWeight: '400',
      fontFamily: 'sans',
      lineHeight: 1.35,
      letterSpacing: 0,
    },
    dates: {
      visible: true,
      xMm: roundMm(margins.leftMm + halfW + 4),
      yMm: roundMm(bodyTop),
      widthMm: halfW,
      heightMm: partyH,
      aspectRatio: roundMm(halfW / partyH),
      lockAspectRatio: false,
      align: 'left',
      spacingMm: 3,
      fontSizePt: compactScale ? 8 : 8.5,
      fontWeight: '400',
      fontFamily: 'sans',
      lineHeight: 1.35,
      letterSpacing: 0,
    },
    tableHeadings: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(tableTop),
      widthMm: roundMm(contentW),
      heightMm: 9,
      aspectRatio: roundMm(contentW / 9),
      lockAspectRatio: false,
      align: 'left',
      spacingMm: 2,
      fontSizePt: compactScale ? 7 : 7.5,
      fontWeight: '700',
      fontFamily: 'sans',
      lineHeight: 1.25,
      letterSpacing: 0.2,
    },
    financialTotals: {
      visible: true,
      xMm: roundMm(margins.leftMm + contentW * 0.56),
      yMm: roundMm(totalsTop),
      widthMm: roundMm(contentW * 0.44),
      heightMm: 31,
      aspectRatio: roundMm((contentW * 0.44) / 31),
      lockAspectRatio: false,
      align: 'right',
      spacingMm: 3,
      fontSizePt: compactScale ? 8 : 8.5,
      fontWeight: '600',
      fontFamily: 'sans',
      lineHeight: 1.35,
      letterSpacing: 0,
    },
    termsAndConditions: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(termsTop),
      widthMm: roundMm(contentW),
      heightMm: 16,
      aspectRatio: roundMm(contentW / 16),
      lockAspectRatio: false,
      align: 'left',
      spacingMm: 3,
      fontSizePt: compactScale ? 7.5 : 8.5,
      fontWeight: '400',
      fontFamily: 'sans',
      lineHeight: 1.35,
      letterSpacing: 0,
    },
    seal: {
      visible: true,
      xMm: roundMm(widthMm - margins.rightMm - 72),
      yMm: roundMm(sigTop),
      widthMm: compactScale ? 16 : 20,
      heightMm: compactScale ? 16 : 20,
      aspectRatio: 1,
      lockAspectRatio: true,
      align: 'center',
      spacingMm: 3,
    },
    signature: {
      visible: true,
      xMm: roundMm(widthMm - margins.rightMm - 46),
      yMm: roundMm(sigTop),
      widthMm: compactScale ? 38 : 46,
      heightMm: compactScale ? 13 : 16,
      aspectRatio: roundMm((compactScale ? 38 : 46) / (compactScale ? 13 : 16)),
      lockAspectRatio: true,
      align: 'center',
      spacingMm: 1.5,
    },
    signatoryLabels: {
      visible: true,
      xMm: roundMm(widthMm - margins.rightMm - 46),
      yMm: roundMm(sigTop + (compactScale ? 14 : 17)),
      widthMm: compactScale ? 38 : 46,
      heightMm: 9,
      aspectRatio: roundMm((compactScale ? 38 : 46) / 9),
      lockAspectRatio: false,
      align: 'center',
      spacingMm: 2,
      fontSizePt: compactScale ? 7.5 : 8.5,
      fontWeight: '600',
      fontFamily: 'sans',
      lineHeight: 1.25,
      letterSpacing: 0,
    },
    footer: {
      visible: true,
      xMm: roundMm(margins.leftMm),
      yMm: roundMm(footerTop),
      widthMm: roundMm(contentW),
      heightMm: 7.5,
      aspectRatio: roundMm(contentW / 7.5),
      lockAspectRatio: false,
      align: 'left',
      spacingMm: 2,
      fontSizePt: compactScale ? 7 : 7.5,
      fontWeight: '400',
      fontFamily: 'sans',
      lineHeight: 1.3,
      letterSpacing: 0,
    },
  };
}

export function isImageVisualElement(key: VisualElementKey): boolean {
  return key === 'logo' || key === 'seal' || key === 'signature';
}

export function getVisualElementTypography(
  el?: Partial<VisualElementConfig> | null,
  defaults?: Partial<VisualElementConfig> | null
): {
  fontSizePt: number;
  fontWeight: VisualTextFontWeight;
  fontFamily: VisualTextFontFamily;
  lineHeight: number;
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
} {
  return {
    fontSizePt: clampFontSizePt(el?.fontSizePt ?? defaults?.fontSizePt, 9),
    fontWeight: normalizeFontWeight(el?.fontWeight ?? defaults?.fontWeight, '400'),
    fontFamily: normalizeFontFamily(el?.fontFamily ?? defaults?.fontFamily, 'sans'),
    lineHeight: clampLineHeight(el?.lineHeight ?? defaults?.lineHeight, 1.35),
    letterSpacing: clampLetterSpacing(el?.letterSpacing ?? defaults?.letterSpacing, 0),
    align:
      el?.align === 'left' || el?.align === 'center' || el?.align === 'right'
        ? el.align
        : defaults?.align || 'left',
  };
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
    ...(el.fontSizePt !== undefined ? { fontSizePt: clampFontSizePt(el.fontSizePt) } : {}),
    ...(el.fontWeight !== undefined ? { fontWeight: normalizeFontWeight(el.fontWeight) } : {}),
    ...(el.fontFamily !== undefined ? { fontFamily: normalizeFontFamily(el.fontFamily) } : {}),
    ...(el.lineHeight !== undefined ? { lineHeight: clampLineHeight(el.lineHeight) } : {}),
    ...(el.letterSpacing !== undefined ? { letterSpacing: clampLetterSpacing(el.letterSpacing) } : {}),
  };
}

export function normalizeDocumentVisualElements(
  incoming?: Partial<DocumentVisualElements> | null,
  paperSize: BrandingPaperSize = 'A4',
  orientation: BrandingPageOrientation = 'portrait',
  margins: BrandingMarginsMm = { topMm: 14, rightMm: 14, bottomMm: 16, leftMm: 14 }
): DocumentVisualElements {
  const defaults = createDefaultVisualElements(paperSize, orientation, margins);
  const { widthMm, heightMm } = getEffectivePaperDimensionsMm(paperSize, orientation);
  const normalized = {} as DocumentVisualElements;

  for (const key of ALL_VISUAL_ELEMENT_KEYS) {
    const baseEl = defaults[key];
    const incEl = incoming?.[key] as Partial<VisualElementConfig> | undefined;
    const isText = !isImageVisualElement(key);
    const mergedRaw: VisualElementConfig = {
      visible: incEl?.visible ?? baseEl.visible,
      xMm: typeof incEl?.xMm === 'number' && Number.isFinite(incEl.xMm) ? incEl.xMm : baseEl.xMm,
      yMm: typeof incEl?.yMm === 'number' && Number.isFinite(incEl.yMm) ? incEl.yMm : baseEl.yMm,
      widthMm:
        typeof incEl?.widthMm === 'number' && Number.isFinite(incEl.widthMm)
          ? incEl.widthMm
          : baseEl.widthMm,
      heightMm:
        typeof incEl?.heightMm === 'number' && Number.isFinite(incEl.heightMm)
          ? incEl.heightMm
          : baseEl.heightMm,
      aspectRatio:
        typeof incEl?.aspectRatio === 'number' &&
        Number.isFinite(incEl.aspectRatio) &&
        incEl.aspectRatio > 0
          ? incEl.aspectRatio
          : baseEl.aspectRatio,
      lockAspectRatio: incEl?.lockAspectRatio ?? baseEl.lockAspectRatio,
      align:
        incEl?.align === 'left' || incEl?.align === 'center' || incEl?.align === 'right'
          ? incEl.align
          : baseEl.align,
      spacingMm:
        typeof incEl?.spacingMm === 'number' && Number.isFinite(incEl.spacingMm)
          ? incEl.spacingMm
          : baseEl.spacingMm,
      ...(isText
        ? {
            fontSizePt: clampFontSizePt(incEl?.fontSizePt ?? baseEl.fontSizePt, baseEl.fontSizePt ?? 9),
            fontWeight: normalizeFontWeight(incEl?.fontWeight ?? baseEl.fontWeight, baseEl.fontWeight ?? '400'),
            fontFamily: normalizeFontFamily(incEl?.fontFamily ?? baseEl.fontFamily, baseEl.fontFamily ?? 'sans'),
            lineHeight: clampLineHeight(incEl?.lineHeight ?? baseEl.lineHeight, baseEl.lineHeight ?? 1.35),
            letterSpacing: clampLetterSpacing(
              incEl?.letterSpacing ?? baseEl.letterSpacing,
              baseEl.letterSpacing ?? 0
            ),
          }
        : {}),
    };
    normalized[key] = clampVisualElementBounds(mergedRaw, widthMm, heightMm);
  }

  return normalized;
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
 * For text elements (`scaleFontWithResize = true`), proportionally scales `fontSizePt` within [6, 36] pt.
 */
export function resizeVisualElementFromHandle(
  el: VisualElementConfig,
  handle: ResizeCornerHandle,
  deltaXMm: number,
  deltaYMm: number,
  paperWidthMm: number,
  paperHeightMm: number,
  minWidthMm = 10,
  minHeightMm = 6,
  scaleFontWithResize = false
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
    nextWidth = Math.max(minWidthMm, Math.min(affectsWest ? right : paperWidthMm - el.xMm, rawWidth));
    nextHeight = Math.max(minHeightMm, Math.min(affectsNorth ? bottom : paperHeightMm - el.yMm, rawHeight));
    nextX = affectsWest ? right - nextWidth : el.xMm;
    nextY = affectsNorth ? bottom - nextHeight : el.yMm;
  }

  let nextFontSizePt = el.fontSizePt;
  if (scaleFontWithResize && el.fontSizePt !== undefined) {
    const wScale = nextWidth / Math.max(1, el.widthMm);
    const hScale = nextHeight / Math.max(1, el.heightMm);
    // Geometric scale proportionally reflects both corner width & height changes
    const geoScale = Math.sqrt(Math.max(0.1, wScale * hScale));
    nextFontSizePt = clampFontSizePt(el.fontSizePt * geoScale, el.fontSizePt);
  }

  return clampVisualElementBounds(
    {
      ...el,
      xMm: nextX,
      yMm: nextY,
      widthMm: nextWidth,
      heightMm: nextHeight,
      ...(nextFontSizePt !== undefined ? { fontSizePt: nextFontSizePt } : {}),
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
