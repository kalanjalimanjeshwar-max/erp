/**
 * Shared Document Print Settings Schema, Defaults & Validation
 * Used by both Backend Persistence (CompanySetting key: DOCUMENT_PRINT_SETTINGS_V1)
 * and Frontend Print Settings UI + Unified Print Renderer.
 */

import { CurrencyDisplayMode } from './currency.js';
import { DocumentLanguage } from './print-translations.js';
import {
  ALL_VISUAL_ELEMENT_KEYS,
  clampVisualElementBounds,
  createDefaultVisualElements,
  DocumentVisualElements,
  getEffectivePaperDimensionsMm,
  isValidBrandingUrl,
  MAX_TEXT_FONT_SIZE_PT,
  MAX_TEXT_LETTER_SPACING,
  MAX_TEXT_LINE_HEIGHT,
  MIN_TEXT_FONT_SIZE_PT,
  MIN_TEXT_LETTER_SPACING,
  MIN_TEXT_LINE_HEIGHT,
  normalizeDocumentVisualElements,
  PAPER_SIZE_DIMENSIONS_MM,
  sanitizeBrandingUrl,
  VisualElementConfig,
  VisualElementKey,
} from './branding.js';

export type DocumentPrintType = 'QUOTATION' | 'INVOICE' | 'RECEIPT';
export type PaperSize = 'A4' | 'A5' | 'Letter';
export type PageOrientation = 'portrait' | 'landscape';
export type TitlePlacement = 'left' | 'center' | 'right' | 'split';
export type LogoPlacement = 'left' | 'center' | 'right';
export type LogoDisplaySize = 'sm' | 'md' | 'lg';
export type ServiceDescriptionLayout = 'detailed' | 'compact';
export type PaymentQrSize = 'sm' | 'md' | 'lg';
export type PaymentQrPosition = 'bottom-left' | 'bottom-right';
export type DocumentCopyLabel = 'ORIGINAL' | 'DUPLICATE';

export interface DocumentPrintMargins {
  topMm: number;
  rightMm: number;
  bottomMm: number;
  leftMm: number;
}

export interface DocumentPrintLayoutConfig {
  paperSize: PaperSize;
  orientation: PageOrientation;
  margins: DocumentPrintMargins;
  language: DocumentLanguage;

  // Header & Company Identity
  showLogo: boolean;
  logoSize: LogoDisplaySize;
  logoPosition: LogoPlacement;
  showCompanyName: boolean;
  showCompanyContact: boolean;
  showCompanyTaxId: boolean;
  headerText: string;
  footerText: string;

  // Document Title & Numbering Placement
  customDocumentTitle: string;
  titlePlacement: TitlePlacement;
  numberPlacement: 'header-right' | 'below-title' | 'meta-grid';

  // Customer & Service Layout
  showCustomerAddress: boolean;
  showCustomerContact: boolean;
  showCustomerTaxId: boolean;
  serviceLayout: ServiceDescriptionLayout;

  // Financial & Tax Presentation
  currencyDisplayMode: CurrencyDisplayMode;
  showDiscountColumn: boolean;
  showTaxColumn: boolean;
  showTaxBreakdown: boolean;
  showTotalsSummary: boolean;
  showBankDetails: boolean;

  // Terms & Signature Block
  showTermsAndConditions: boolean;
  defaultTermsText: string;
  showSignatureSection: boolean;
  signatureLabel: string;
  signatoryName: string;
  signatoryTitle: string;
  signatureUrl: string;
  sealUrl: string;
  showPrintedTimestamp: boolean;

  // Optional Uploaded UPI Payment QR Display (disabled by default)
  showPaymentQr?: boolean;
  paymentQrLabel?: string;
  paymentQrSize?: PaymentQrSize;
  paymentQrPosition?: PaymentQrPosition;
  paymentQrUrl?: string;

  // Visual Canvas Designer Elements
  visualLayoutEnabled: boolean;
  elements: DocumentVisualElements;
}

export interface DocumentPrintSettings {
  version: 1;
  layouts: Record<DocumentPrintType, DocumentPrintLayoutConfig>;
}

export const DOCUMENT_PRINT_SETTING_KEY = 'DOCUMENT_PRINT_SETTINGS_V1';

export const PAPER_DIMENSIONS_MM: Record<PaperSize, { width: number; height: number }> =
  PAPER_SIZE_DIMENSIONS_MM;

const DEFAULT_BASE_LAYOUT: DocumentPrintLayoutConfig = {
  paperSize: 'A4',
  orientation: 'portrait',
  margins: {
    topMm: 14,
    rightMm: 14,
    bottomMm: 16,
    leftMm: 14,
  },
  language: 'EN',
  showLogo: true,
  logoSize: 'md',
  logoPosition: 'left',
  showCompanyName: true,
  showCompanyContact: true,
  showCompanyTaxId: true,
  headerText: '',
  footerText: 'Thank you for your business.',
  customDocumentTitle: '',
  titlePlacement: 'split',
  numberPlacement: 'header-right',
  showCustomerAddress: true,
  showCustomerContact: true,
  showCustomerTaxId: true,
  serviceLayout: 'detailed',
  currencyDisplayMode: 'symbol',
  showDiscountColumn: true,
  showTaxColumn: true,
  showTaxBreakdown: true,
  showTotalsSummary: true,
  showBankDetails: true,
  showTermsAndConditions: true,
  defaultTermsText: '',
  showSignatureSection: true,
  signatureLabel: 'Authorized Signatory',
  signatoryName: '',
  signatoryTitle: '',
  signatureUrl: '',
  sealUrl: '',
  showPrintedTimestamp: true,
  showPaymentQr: false,
  paymentQrLabel: 'Scan to Pay',
  paymentQrSize: 'md',
  paymentQrPosition: 'bottom-right',
  paymentQrUrl: '',
  visualLayoutEnabled: true,
  elements: createDefaultVisualElements('A4', 'portrait', {
    topMm: 14,
    rightMm: 14,
    bottomMm: 16,
    leftMm: 14,
  }),
};

function normalizeLanguage(lang?: string | null): DocumentLanguage {
  if (lang === 'KN' || lang === 'EN_KN' || lang === 'EN') return lang;
  return 'EN';
}

export function createDefaultPrintSettings(company?: {
  defaultDocumentLanguage?: string | null;
  documentBranding?: {
    logoSize?: LogoDisplaySize;
    logoAlignment?: LogoPlacement;
    signatureUrl?: string | null;
    signatureTitle?: string | null;
    signatoryName?: string | null;
    sealUrl?: string | null;
    paymentQrUrl?: string | null;
  } | null;
}): DocumentPrintSettings {
  const defaultLanguage = normalizeLanguage(company?.defaultDocumentLanguage);
  const branding = company?.documentBranding;

  const sharedOverrides: Partial<DocumentPrintLayoutConfig> = {
    language: defaultLanguage,
    logoSize: branding?.logoSize || 'md',
    logoPosition: branding?.logoAlignment || 'left',
    signatoryName: branding?.signatoryName || '',
    signatoryTitle: branding?.signatureTitle || '',
    signatureUrl: branding?.signatureUrl || '',
    sealUrl: branding?.sealUrl || '',
    paymentQrUrl: branding?.paymentQrUrl || '',
  };

  const makeElements = () =>
    createDefaultVisualElements('A4', 'portrait', { ...DEFAULT_BASE_LAYOUT.margins });

  return {
    version: 1,
    layouts: {
      QUOTATION: {
        ...DEFAULT_BASE_LAYOUT,
        margins: { ...DEFAULT_BASE_LAYOUT.margins },
        elements: makeElements(),
        ...sharedOverrides,
        customDocumentTitle: 'QUOTATION',
        showBankDetails: false,
        defaultTermsText: 'Quotation valid until the stated expiry date. Prices inclusive/exclusive as specified.',
      },
      INVOICE: {
        ...DEFAULT_BASE_LAYOUT,
        margins: { ...DEFAULT_BASE_LAYOUT.margins },
        elements: makeElements(),
        ...sharedOverrides,
        customDocumentTitle: 'TAX INVOICE',
        showBankDetails: true,
        defaultTermsText: 'Please remit payment by the due date referencing the invoice number.',
      },
      RECEIPT: {
        ...DEFAULT_BASE_LAYOUT,
        margins: { ...DEFAULT_BASE_LAYOUT.margins },
        elements: makeElements(),
        ...sharedOverrides,
        customDocumentTitle: 'PAYMENT RECEIPT',
        showDiscountColumn: false,
        showTaxColumn: false,
        showTaxBreakdown: false,
        showBankDetails: false,
        defaultTermsText: 'This receipt acknowledges payment received against the listed invoice(s).',
      },
    },
  };
}

function clampMargin(val: unknown, fallback: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(50, Math.max(4, Math.round(num)));
}

function mergeVisualElements(
  base: DocumentVisualElements,
  incoming: Partial<DocumentVisualElements> | undefined | null,
  paperSize: PaperSize,
  orientation: PageOrientation,
  margins = DEFAULT_BASE_LAYOUT.margins
): DocumentVisualElements {
  const normalizedBase = normalizeDocumentVisualElements(base, paperSize, orientation, margins);
  if (!incoming || typeof incoming !== 'object') {
    return normalizedBase;
  }
  const combined: Partial<DocumentVisualElements> = {};
  for (const key of ALL_VISUAL_ELEMENT_KEYS) {
    combined[key] = {
      ...normalizedBase[key],
      ...(incoming[key] || {}),
    };
  }
  return normalizeDocumentVisualElements(combined, paperSize, orientation, margins);
}

function mergeSingleLayout(
  base: DocumentPrintLayoutConfig,
  incoming?: Partial<DocumentPrintLayoutConfig> | null
): DocumentPrintLayoutConfig {
  if (!incoming || typeof incoming !== 'object') {
    return {
      ...base,
      margins: { ...base.margins },
      elements: mergeVisualElements(
        base.elements,
        undefined,
        base.paperSize,
        base.orientation,
        base.margins
      ),
    };
  }

  const paperSize: PaperSize =
    incoming.paperSize === 'A4' || incoming.paperSize === 'A5' || incoming.paperSize === 'Letter'
      ? incoming.paperSize
      : base.paperSize;

  const orientation: PageOrientation =
    incoming.orientation === 'portrait' || incoming.orientation === 'landscape'
      ? incoming.orientation
      : base.orientation;

  const language: DocumentLanguage =
    incoming.language === 'EN' || incoming.language === 'KN' || incoming.language === 'EN_KN'
      ? incoming.language
      : base.language;

  const logoSize: LogoDisplaySize =
    incoming.logoSize === 'sm' || incoming.logoSize === 'md' || incoming.logoSize === 'lg'
      ? incoming.logoSize
      : base.logoSize;

  const logoPosition: LogoPlacement =
    incoming.logoPosition === 'left' || incoming.logoPosition === 'center' || incoming.logoPosition === 'right'
      ? incoming.logoPosition
      : base.logoPosition;

  const titlePlacement: TitlePlacement =
    incoming.titlePlacement === 'left' ||
    incoming.titlePlacement === 'center' ||
    incoming.titlePlacement === 'right' ||
    incoming.titlePlacement === 'split'
      ? incoming.titlePlacement
      : base.titlePlacement;

  const numberPlacement =
    incoming.numberPlacement === 'header-right' ||
    incoming.numberPlacement === 'below-title' ||
    incoming.numberPlacement === 'meta-grid'
      ? incoming.numberPlacement
      : base.numberPlacement;

  const serviceLayout: ServiceDescriptionLayout =
    incoming.serviceLayout === 'detailed' || incoming.serviceLayout === 'compact'
      ? incoming.serviceLayout
      : base.serviceLayout;

  const currencyDisplayMode: CurrencyDisplayMode =
    incoming.currencyDisplayMode === 'symbol' ||
    incoming.currencyDisplayMode === 'code' ||
    incoming.currencyDisplayMode === 'both'
      ? incoming.currencyDisplayMode
      : base.currencyDisplayMode;

  const margins: DocumentPrintMargins = {
    topMm: clampMargin(incoming.margins?.topMm, base.margins.topMm),
    rightMm: clampMargin(incoming.margins?.rightMm, base.margins.rightMm),
    bottomMm: clampMargin(incoming.margins?.bottomMm, base.margins.bottomMm),
    leftMm: clampMargin(incoming.margins?.leftMm, base.margins.leftMm),
  };

  const defaultElementsForPaper = createDefaultVisualElements(paperSize, orientation, margins);
  const elements = mergeVisualElements(
    incoming.elements ? base.elements : defaultElementsForPaper,
    incoming.elements,
    paperSize,
    orientation,
    margins
  );

  return {
    paperSize,
    orientation,
    margins,
    language,
    showLogo: incoming.showLogo ?? base.showLogo,
    logoSize,
    logoPosition,
    showCompanyName: incoming.showCompanyName ?? base.showCompanyName,
    showCompanyContact: incoming.showCompanyContact ?? base.showCompanyContact,
    showCompanyTaxId: incoming.showCompanyTaxId ?? base.showCompanyTaxId,
    headerText: typeof incoming.headerText === 'string' ? incoming.headerText.slice(0, 300) : base.headerText,
    footerText: typeof incoming.footerText === 'string' ? incoming.footerText.slice(0, 300) : base.footerText,
    customDocumentTitle:
      typeof incoming.customDocumentTitle === 'string'
        ? incoming.customDocumentTitle.slice(0, 120)
        : base.customDocumentTitle,
    titlePlacement,
    numberPlacement,
    showCustomerAddress: incoming.showCustomerAddress ?? base.showCustomerAddress,
    showCustomerContact: incoming.showCustomerContact ?? base.showCustomerContact,
    showCustomerTaxId: incoming.showCustomerTaxId ?? base.showCustomerTaxId,
    serviceLayout,
    currencyDisplayMode,
    showDiscountColumn: incoming.showDiscountColumn ?? base.showDiscountColumn,
    showTaxColumn: incoming.showTaxColumn ?? base.showTaxColumn,
    showTaxBreakdown: incoming.showTaxBreakdown ?? base.showTaxBreakdown,
    showTotalsSummary: incoming.showTotalsSummary ?? base.showTotalsSummary,
    showBankDetails: incoming.showBankDetails ?? base.showBankDetails,
    showTermsAndConditions: incoming.showTermsAndConditions ?? base.showTermsAndConditions,
    defaultTermsText:
      typeof incoming.defaultTermsText === 'string'
        ? incoming.defaultTermsText.slice(0, 1500)
        : base.defaultTermsText,
    showSignatureSection: incoming.showSignatureSection ?? base.showSignatureSection,
    signatureLabel:
      typeof incoming.signatureLabel === 'string'
        ? incoming.signatureLabel.slice(0, 120)
        : base.signatureLabel,
    signatoryName:
      typeof incoming.signatoryName === 'string'
        ? incoming.signatoryName.slice(0, 120)
        : base.signatoryName,
    signatoryTitle:
      typeof incoming.signatoryTitle === 'string'
        ? incoming.signatoryTitle.slice(0, 120)
        : base.signatoryTitle,
    signatureUrl:
      incoming.signatureUrl !== undefined ? sanitizeBrandingUrl(incoming.signatureUrl) : base.signatureUrl,
    sealUrl: incoming.sealUrl !== undefined ? sanitizeBrandingUrl(incoming.sealUrl) : base.sealUrl,
    showPrintedTimestamp: incoming.showPrintedTimestamp ?? base.showPrintedTimestamp,
    showPaymentQr: incoming.showPaymentQr ?? base.showPaymentQr ?? false,
    paymentQrLabel:
      typeof incoming.paymentQrLabel === 'string'
        ? incoming.paymentQrLabel.slice(0, 80)
        : base.paymentQrLabel ?? 'Scan to Pay',
    paymentQrSize:
      incoming.paymentQrSize === 'sm' ||
      incoming.paymentQrSize === 'md' ||
      incoming.paymentQrSize === 'lg'
        ? incoming.paymentQrSize
        : base.paymentQrSize ?? 'md',
    paymentQrPosition:
      incoming.paymentQrPosition === 'bottom-left' ||
      incoming.paymentQrPosition === 'bottom-right'
        ? incoming.paymentQrPosition
        : base.paymentQrPosition ?? 'bottom-right',
    paymentQrUrl:
      incoming.paymentQrUrl !== undefined
        ? sanitizeBrandingUrl(incoming.paymentQrUrl)
        : base.paymentQrUrl ?? '',
    visualLayoutEnabled: incoming.visualLayoutEnabled ?? base.visualLayoutEnabled,
    elements,
  };
}

export function mergeDocumentPrintSettings(
  raw?: unknown,
  company?: Parameters<typeof createDefaultPrintSettings>[0]
): DocumentPrintSettings {
  const defaults = createDefaultPrintSettings(company);
  if (!raw || (typeof raw !== 'object' && typeof raw !== 'string')) {
    return defaults;
  }

  let parsed: Partial<DocumentPrintSettings> | null = null;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as Partial<DocumentPrintSettings>;
    } catch {
      return defaults;
    }
  } else {
    parsed = raw as Partial<DocumentPrintSettings>;
  }

  return {
    version: 1,
    layouts: {
      QUOTATION: mergeSingleLayout(defaults.layouts.QUOTATION, parsed?.layouts?.QUOTATION),
      INVOICE: mergeSingleLayout(defaults.layouts.INVOICE, parsed?.layouts?.INVOICE),
      RECEIPT: mergeSingleLayout(defaults.layouts.RECEIPT, parsed?.layouts?.RECEIPT),
    },
  };
}

export function validatePrintSettingsPayload(payload: unknown): {
  valid: boolean;
  error?: string;
} {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Print settings payload must be an object.' };
  }
  const obj = payload as Partial<DocumentPrintSettings>;
  if (!obj.layouts || typeof obj.layouts !== 'object') {
    return { valid: false, error: 'Print settings payload must include layouts object.' };
  }

  const docTypes: DocumentPrintType[] = ['QUOTATION', 'INVOICE', 'RECEIPT'];
  for (const docType of docTypes) {
    const layout = obj.layouts[docType];
    if (!layout) continue;
    if (layout.paperSize && !['A4', 'A5', 'Letter'].includes(layout.paperSize)) {
      return { valid: false, error: `Invalid paperSize for ${docType}. Allowed: A4, A5, Letter.` };
    }
    if (layout.orientation && !['portrait', 'landscape'].includes(layout.orientation)) {
      return { valid: false, error: `Invalid orientation for ${docType}.` };
    }
    if (layout.language && !['EN', 'KN', 'EN_KN'].includes(layout.language)) {
      return { valid: false, error: `Invalid language for ${docType}. Allowed: EN, KN, EN_KN.` };
    }
    for (const urlField of [layout.signatureUrl, layout.sealUrl, layout.paymentQrUrl]) {
      if (urlField && !isValidBrandingUrl(urlField)) {
        return { valid: false, error: `Unsafe URL scheme detected in ${docType} branding.` };
      }
    }
    if (layout.paymentQrSize && !['sm', 'md', 'lg'].includes(layout.paymentQrSize)) {
      return { valid: false, error: `Invalid paymentQrSize for ${docType}. Allowed: sm, md, lg.` };
    }
    if (
      layout.paymentQrPosition &&
      !['bottom-left', 'bottom-right'].includes(layout.paymentQrPosition)
    ) {
      return {
        valid: false,
        error: `Invalid paymentQrPosition for ${docType}. Allowed: bottom-left, bottom-right.`,
      };
    }
    if (layout.margins) {
      for (const m of [
        layout.margins.topMm,
        layout.margins.rightMm,
        layout.margins.bottomMm,
        layout.margins.leftMm,
      ]) {
        if (m !== undefined && (!Number.isFinite(Number(m)) || Number(m) < 4 || Number(m) > 50)) {
          return {
            valid: false,
            error: `Margins for ${docType} must be between 4 mm and 50 mm.`,
          };
        }
      }
    }
    if (layout.elements && typeof layout.elements === 'object') {
      for (const k of ALL_VISUAL_ELEMENT_KEYS) {
        const el = layout.elements[k];
        if (!el) continue;
        for (const numField of [el.xMm, el.yMm, el.widthMm, el.heightMm]) {
          if (numField !== undefined && (!Number.isFinite(Number(numField)) || Number(numField) < 0 || Number(numField) > 500)) {
            return {
              valid: false,
              error: `Invalid visual coordinate or dimension on ${k} in ${docType}.`,
            };
          }
        }
        if (
          el.fontSizePt !== undefined &&
          (!Number.isFinite(Number(el.fontSizePt)) ||
            Number(el.fontSizePt) < MIN_TEXT_FONT_SIZE_PT ||
            Number(el.fontSizePt) > MAX_TEXT_FONT_SIZE_PT)
        ) {
          return {
            valid: false,
            error: `Font size for ${k} in ${docType} must be between ${MIN_TEXT_FONT_SIZE_PT} pt and ${MAX_TEXT_FONT_SIZE_PT} pt.`,
          };
        }
        if (
          el.lineHeight !== undefined &&
          (!Number.isFinite(Number(el.lineHeight)) ||
            Number(el.lineHeight) < MIN_TEXT_LINE_HEIGHT ||
            Number(el.lineHeight) > MAX_TEXT_LINE_HEIGHT)
        ) {
          return {
            valid: false,
            error: `Line height for ${k} in ${docType} must be between ${MIN_TEXT_LINE_HEIGHT} and ${MAX_TEXT_LINE_HEIGHT}.`,
          };
        }
        if (
          el.letterSpacing !== undefined &&
          (!Number.isFinite(Number(el.letterSpacing)) ||
            Number(el.letterSpacing) < MIN_TEXT_LETTER_SPACING ||
            Number(el.letterSpacing) > MAX_TEXT_LETTER_SPACING)
        ) {
          return {
            valid: false,
            error: `Letter spacing for ${k} in ${docType} must be between ${MIN_TEXT_LETTER_SPACING} pt and ${MAX_TEXT_LETTER_SPACING} pt.`,
          };
        }
      }
    }
  }

  return { valid: true };
}

