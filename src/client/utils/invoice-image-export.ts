/**
 * Lazy-loaded zero-dependency Canvas 2D exporter for JPG & PNG document downloads.
 * Supports A4/A5/Letter, Portrait/Landscape, Standard (150 DPI) / High (300 DPI) quality,
 * optional ORIGINAL/DUPLICATE copy labels, dynamic Discount/Tax columns, full visual-layout
 * visibility controls, measured text wrapping & pagination with zero footer overlap,
 * uploaded UPI Payment QR images (exact aspect ratio, never auto-generated), and automatic
 * multi-page pagination packaged into a ZIP archive.
 */

import {
  getEffectivePaperDimensionsMm,
  normalizeDocumentVisualElements,
} from '../../shared/branding.ts';
import { formatMoney, normalizeCurrencyCode } from '../../shared/currency.ts';
import { getDocumentLabel, DocumentPrintLabelKey } from '../../shared/print-translations.ts';
import { formatDateTimeInTimezone, getEffectiveTimeZone } from '../../shared/timezone.ts';
import { DocumentLanguage, DocumentPrintLayoutConfig } from '../../shared/types.ts';
import {
  buildExportFileName,
  DocumentExportContext,
  formatCompanyAddressLines,
  formatCopyLabelText,
  resolveCompanyContactParts,
  resolveCompanyTaxId,
  resolveDocumentEffectiveBranding,
  resolvePaymentQrDisplaySizeMm,
  shouldDisplayPaymentQr,
} from '../../shared/export/document-branding.ts';
import { createZipArchive } from '../../shared/export/zip-writer.ts';

export type ImageExportFormat = 'jpg' | 'png';
export type ImageExportQuality = 'standard' | 'high';

export interface ImageExportOptions {
  format: ImageExportFormat;
  quality: ImageExportQuality;
}

export type ImageExportColumnKey = 'sn' | 'desc' | 'qty' | 'rate' | 'disc' | 'tax' | 'amt';

export interface ImageExportColumnSpec {
  key: ImageExportColumnKey;
  label: string;
  width: number;
  align: 'left' | 'right';
}

export interface ImageExportVisibility {
  showLogo: boolean;
  showCompanyName: boolean;
  showCompanyHeader: boolean;
  showDocumentTitle: boolean;
  showDocumentNumber: boolean;
  showCustomerDetails: boolean;
  showDates: boolean;
  showTableHeadings: boolean;
  showFinancialTotals: boolean;
  showTermsAndConditions: boolean;
  showSeal: boolean;
  showSignature: boolean;
  showSignatoryLabels: boolean;
  showSignatureBlock: boolean;
  showFooter: boolean;
}

export type TextMeasurerPt = (text: string, fontPt: number, bold?: boolean) => number;

export interface PlannedImagePage<TLine = unknown> {
  pageNumber: number;
  totalPages: number;
  lines: TLine[];
  includeSummaryAndFooter: boolean;
  includeBankAndTotals: boolean;
  notesHeading: boolean;
  notesLines: string[];
  termsHeading: boolean;
  termsLines: string[];
  includeQrAndSignature: boolean;
  maxContentBottomPt: number;
  footerTopPt: number;
}

export interface ImagePagePlan<TLine = unknown> {
  widthMm: number;
  heightMm: number;
  dpi: number;
  widthPx: number;
  heightPx: number;
  effectiveShowQr: boolean;
  qrReservedPt: number;
  visibility: ImageExportVisibility;
  columns: ImageExportColumnSpec[];
  pages: PlannedImagePage<TLine>[];
}

const MM_PER_INCH = 25.4;
const PT_PER_MM = 72 / MM_PER_INCH;

function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

function formatLabel(
  key: DocumentPrintLabelKey,
  lang: DocumentLanguage
): string {
  const entry = getDocumentLabel(key, lang);
  return entry.secondary ? `${entry.primary} / ${entry.secondary}` : entry.primary;
}

/**
 * Conservative fallback text width estimator (in points) used when planning without a DOM Canvas
 * (e.g., deterministic unit tests in Node). Slightly overestimates wide/non-Latin glyphs so
 * planned pagination never clips or overflows into the footer.
 */
export function defaultMeasureTextPt(text: string, fontPt: number, bold = false): number {
  if (!text) return 0;
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32) {
      units += 0.3;
    } else if (code >= 0x0c80 && code <= 0x0cff) {
      // Kannada glyphs tend to be wider than Latin glyphs
      units += 0.72;
    } else if (code > 127) {
      units += 0.68;
    } else if (code >= 65 && code <= 90) {
      units += 0.64;
    } else if ('ilI1.,:;|!'.includes(text[i])) {
      units += 0.32;
    } else if ('mwMW'.includes(text[i])) {
      units += 0.8;
    } else {
      units += 0.56;
    }
  }
  return units * fontPt * (bold ? 1.07 : 1.0);
}

/**
 * Resolves effective element visibility flags for JPG/PNG export, combining standard
 * layout toggles with Visual Designer element visibility when `visualLayoutEnabled` is active.
 */
export function resolveImageExportVisibility(
  layout: DocumentPrintLayoutConfig
): ImageExportVisibility {
  const useVisual = Boolean(layout.visualLayoutEnabled);
  const visual = normalizeDocumentVisualElements(
    layout.elements,
    layout.paperSize,
    layout.orientation,
    layout.margins
  );

  const showSeal = Boolean(layout.showSignatureSection && (!useVisual || visual.seal.visible));
  const showSignature = Boolean(
    layout.showSignatureSection && (!useVisual || visual.signature.visible)
  );
  const showSignatoryLabels = Boolean(
    layout.showSignatureSection && (!useVisual || visual.signatoryLabels.visible)
  );

  return {
    showLogo: Boolean(layout.showLogo && (!useVisual || visual.logo.visible)),
    showCompanyName: Boolean(layout.showCompanyName && (!useVisual || visual.companyName.visible)),
    showCompanyHeader: Boolean(!useVisual || visual.companyHeader.visible),
    showDocumentTitle: Boolean(!useVisual || visual.documentTitle.visible),
    showDocumentNumber: Boolean(!useVisual || visual.documentNumber.visible),
    showCustomerDetails: Boolean(!useVisual || visual.customerDetails.visible),
    showDates: Boolean(!useVisual || visual.dates.visible),
    showTableHeadings: Boolean(!useVisual || visual.tableHeadings.visible),
    showFinancialTotals: Boolean(
      layout.showTotalsSummary && (!useVisual || visual.financialTotals.visible)
    ),
    showTermsAndConditions: Boolean(
      layout.showTermsAndConditions && (!useVisual || visual.termsAndConditions.visible)
    ),
    showSeal,
    showSignature,
    showSignatoryLabels,
    showSignatureBlock: showSeal || showSignature || showSignatoryLabels,
    showFooter: Boolean(!useVisual || visual.footer.visible),
  };
}

/**
 * Builds the line-item table column definitions for Quotations/Invoices, dynamically
 * including Discount (`showDiscountColumn`) and Tax (`showTaxColumn`) columns and
 * normalizing widths to `contentWidth`.
 */
export function resolveImageExportColumns(
  layout: DocumentPrintLayoutConfig,
  contentWidth: number
): ImageExportColumnSpec[] {
  const showDiscount = Boolean(layout.showDiscountColumn);
  const showTax = Boolean(layout.showTaxColumn);

  const raw: Array<{
    key: ImageExportColumnKey;
    label: string;
    weight: number;
    align: 'left' | 'right';
  }> = [
    { key: 'sn', label: '#', weight: 0.06, align: 'left' },
    {
      key: 'desc',
      label: formatLabel('serviceDescription', layout.language).toUpperCase(),
      weight: showDiscount && showTax ? 0.34 : showDiscount || showTax ? 0.42 : 0.52,
      align: 'left',
    },
    {
      key: 'qty',
      label: formatLabel('qtyHours', layout.language).toUpperCase(),
      weight: 0.1,
      align: 'right',
    },
    {
      key: 'rate',
      label: formatLabel('rate', layout.language).toUpperCase(),
      weight: 0.13,
      align: 'right',
    },
  ];

  if (showDiscount) {
    raw.push({
      key: 'disc',
      label: formatLabel('discount', layout.language).toUpperCase(),
      weight: 0.11,
      align: 'right',
    });
  }

  if (showTax) {
    raw.push({
      key: 'tax',
      label: formatLabel('tax', layout.language).toUpperCase(),
      weight: layout.serviceLayout === 'detailed' ? 0.14 : 0.12,
      align: 'right',
    });
  }

  raw.push({
    key: 'amt',
    label: formatLabel('amount', layout.language).toUpperCase(),
    weight: 0.14,
    align: 'right',
  });

  const totalWeight = raw.reduce((sum, c) => sum + c.weight, 0);
  return raw.map((c) => ({
    key: c.key,
    label: c.label,
    width: (c.weight / totalWeight) * contentWidth,
    align: c.align,
  }));
}

/**
 * Wraps multi-line text to fit within `maxWidthPt` using `measurePt`.
 * Safely breaks unbreakable long tokens (e.g., long URLs/codes) so no line overflows.
 */
export function wrapTextByWidth(
  text: string,
  maxWidthPt: number,
  measurePt: (s: string) => number
): string[] {
  const safeMax = Math.max(24, maxWidthPt);
  const paragraphs = String(text || '').split(/\r?\n/);
  const lines: string[] = [];

  const pushWrappedWord = (word: string): string => {
    if (measurePt(word) <= safeMax) return word;
    let chunk = '';
    for (let i = 0; i < word.length; i++) {
      const next = chunk + word[i];
      if (chunk && measurePt(next) > safeMax) {
        lines.push(chunk);
        chunk = word[i];
      } else {
        chunk = next;
      }
    }
    return chunk;
  };

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = pushWrappedWord(words[0]);
    for (let i = 1; i < words.length; i++) {
      const next = `${current} ${words[i]}`;
      if (measurePt(next) <= safeMax) {
        current = next;
      } else {
        if (current) lines.push(current);
        current = pushWrappedWord(words[i]);
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function resolveQrSourceFromContext(
  context: DocumentExportContext,
  layout: DocumentPrintLayoutConfig,
  effectiveProfile: ReturnType<typeof resolveDocumentEffectiveBranding>['effectiveProfile']
): string {
  const url =
    layout.paymentQrUrl ||
    effectiveProfile?.documentBranding?.paymentQrUrl ||
    effectiveProfile?.paymentQrUrl ||
    effectiveProfile?.brandingAssets?.paymentQr?.url ||
    '';
  if (url) return url;
  if (context.brandingImages?.paymentQr && context.brandingImages.paymentQr.length > 0) {
    return 'buffer';
  }
  return '';
}

/**
 * Deterministically plans single-page or multi-page pagination geometry for JPG/PNG rendering
 * using real measured text heights (or conservative fallback measurements in Node tests).
 * Guarantees that every page satisfies `maxContentBottomPt <= footerTopPt` (zero footer overlap)
 * and reserves QR space strictly according to `shouldDisplayPaymentQr(...)`.
 */
export function planImageExportPages(
  context: DocumentExportContext,
  quality: ImageExportQuality = 'standard',
  options?: { measureTextPt?: TextMeasurerPt }
): ImagePagePlan {
  const {
    document: docPayload,
    layoutOverride,
    bankAccount,
    isDraftPreview,
    copyLabel,
    includePaymentQr,
  } = context;
  const { effectiveProfile, layout } = resolveDocumentEffectiveBranding(
    docPayload,
    context.companyProfile,
    layoutOverride,
    isDraftPreview
  );

  const measurePt: TextMeasurerPt = options?.measureTextPt || defaultMeasureTextPt;
  const visibility = resolveImageExportVisibility(layout);

  const { widthMm, heightMm } = getEffectivePaperDimensionsMm(
    layout.paperSize,
    layout.orientation
  );
  const dpi = quality === 'high' ? 300 : 150;
  const widthPx = mmToPx(widthMm, dpi);
  const heightPx = mmToPx(heightMm, dpi);

  const pageWidthPt = mmToPt(widthMm);
  const pageHeightPt = mmToPt(heightMm);
  const leftPt = mmToPt(layout.margins.leftMm);
  const rightPt = pageWidthPt - mmToPt(layout.margins.rightMm);
  const topPt = mmToPt(layout.margins.topMm);
  const bottomPt = pageHeightPt - mmToPt(layout.margins.bottomMm);
  const contentWidthPt = Math.max(120, rightPt - leftPt);

  // Reserve clean separation above the footer separator line so content never touches or clips it
  const footerReservePt = visibility.showFooter ? 24 : 4;
  const footerTopPt = Math.max(topPt + 60, bottomPt - footerReservePt);

  const columns =
    docPayload.type === 'RECEIPT'
      ? []
      : resolveImageExportColumns(layout, contentWidthPt);
  const descColWidthPt =
    columns.find((c) => c.key === 'desc')?.width || contentWidthPt * 0.42;

  const companyName = effectiveProfile?.name || 'CoreERP Enterprise';
  const resolvedCopyLabel = formatCopyLabelText(copyLabel);
  const resolvedLogoUrl =
    effectiveProfile?.brandingAssets?.logo?.url || effectiveProfile?.logoUrl || '';
  const hasLogo = Boolean(
    visibility.showLogo &&
      (resolvedLogoUrl || (context.brandingImages?.logo && context.brandingImages.logo.length > 0))
  );
  const resolvedSealUrl =
    layout.sealUrl ||
    effectiveProfile?.documentBranding?.sealUrl ||
    effectiveProfile?.sealUrl ||
    effectiveProfile?.brandingAssets?.seal?.url ||
    '';
  const hasSeal = Boolean(
    visibility.showSeal &&
      (resolvedSealUrl || (context.brandingImages?.seal && context.brandingImages.seal.length > 0))
  );
  const resolvedSigUrl =
    layout.signatureUrl ||
    effectiveProfile?.documentBranding?.signatureUrl ||
    effectiveProfile?.signatureUrl ||
    effectiveProfile?.brandingAssets?.signature?.url ||
    '';
  const hasSigImage = Boolean(
    visibility.showSignature &&
      (resolvedSigUrl ||
        (context.brandingImages?.signature && context.brandingImages.signature.length > 0))
  );

  // Compute exact Page 1 header & party box height in points
  let page1StartY = topPt;
  if (layout.headerText || isDraftPreview || resolvedCopyLabel) {
    page1StartY += 20;
  }

  const leftColW = contentWidthPt * 0.58;
  let leftHeaderY = page1StartY;
  if (hasLogo) {
    const logoH = layout.logoSize === 'sm' ? 28 : layout.logoSize === 'lg' ? 48 : 36;
    leftHeaderY += logoH + 5;
  }
  if (visibility.showCompanyName) {
    const nameLines = wrapTextByWidth(companyName, leftColW, (s) => measurePt(s, 14, true));
    leftHeaderY += Math.max(1, nameLines.length) * 17;
    if (effectiveProfile?.legalName && effectiveProfile.legalName !== companyName) {
      const legalLines = wrapTextByWidth(effectiveProfile.legalName, leftColW, (s) =>
        measurePt(s, 9, false)
      );
      leftHeaderY += Math.max(1, legalLines.length) * 12;
    }
  }
  if (visibility.showCompanyHeader) {
    if (layout.showCompanyContact) {
      for (const addrLine of formatCompanyAddressLines(effectiveProfile)) {
        const wrapped = wrapTextByWidth(addrLine, leftColW, (s) => measurePt(s, 8.5, false));
        leftHeaderY += Math.max(1, wrapped.length) * 11.5;
      }
      const contactLine = resolveCompanyContactParts(effectiveProfile).join('  •  ');
      if (contactLine) {
        const wrapped = wrapTextByWidth(contactLine, leftColW, (s) => measurePt(s, 8.5, false));
        leftHeaderY += Math.max(1, wrapped.length) * 11.5;
      }
    }
    const resolvedTaxId = resolveCompanyTaxId(effectiveProfile);
    if (layout.showCompanyTaxId && resolvedTaxId) {
      leftHeaderY += 12;
    }
  }

  let rightHeaderY = page1StartY;
  if (visibility.showDocumentTitle) {
    rightHeaderY += 20;
  }
  if (visibility.showDocumentNumber) {
    rightHeaderY += 14;
  }

  page1StartY = Math.max(leftHeaderY, rightHeaderY) + 16;

  // Party & Metadata boxes height (if either box is visible)
  if (visibility.showCustomerDetails || visibility.showDates) {
    const boxGap = 10;
    const boxW = (contentWidthPt - boxGap) / 2;
    let partyBoxH = 0;
    if (visibility.showCustomerDetails) {
      const partyLines: string[] = [docPayload.data.customerName || ''];
      if (docPayload.type !== 'RECEIPT') {
        if (layout.showCustomerAddress && docPayload.data.customerAddress) {
          partyLines.push(docPayload.data.customerAddress);
        }
        if (layout.showCustomerContact) {
          const cLine = [docPayload.data.customerEmail, docPayload.data.customerPhone]
            .filter(Boolean)
            .join(' • ');
          if (cLine) partyLines.push(cLine);
        }
        if (layout.showCustomerTaxId && docPayload.data.customerTaxId) {
          partyLines.push(`Tax ID: ${docPayload.data.customerTaxId}`);
        }
      }
      const wrappedParty = partyLines.flatMap((l) =>
        wrapTextByWidth(l, boxW - 14, (s) => measurePt(s, 8.5, false))
      );
      partyBoxH = 22 + Math.max(1, wrappedParty.length) * 11.5;
    }

    let metaBoxH = 0;
    if (visibility.showDates) {
      const metaRowCount =
        docPayload.type === 'RECEIPT'
          ? 4 + (docPayload.data.referenceNumber ? 1 : 0)
          : 4;
      metaBoxH = 16 + metaRowCount * 13;
    }

    page1StartY += Math.max(partyBoxH, metaBoxH) + 12;
  }

  const continuationStartY = topPt + 23;
  const tableHeaderH = visibility.showTableHeadings ? 20 : 0;
  const rowPadPt = layout.serviceLayout === 'compact' ? 4 : 6;

  // Measure every line / receipt allocation row height
  const allItems: unknown[] =
    docPayload.type === 'RECEIPT'
      ? Array.isArray(docPayload.data.allocations)
        ? docPayload.data.allocations
        : []
      : Array.isArray(docPayload.data.lines)
      ? docPayload.data.lines
      : [];

  const rowHeightsPt = allItems.map((rawItem) => {
    if (docPayload.type === 'RECEIPT') {
      return 20;
    }
    const line = rawItem as (typeof docPayload.data.lines)[number];
    const descLines = wrapTextByWidth(
      line.itemDescription || '',
      Math.max(40, descColWidthPt - 10),
      (s) => measurePt(s, 8.5, false)
    );
    return Math.max(18, Math.max(1, descLines.length) * 11 + rowPadPt * 2);
  });

  // Compute summary sub-blocks (Bank + Totals, Notes, Terms, QR + Signature)
  const bankW = contentWidthPt * 0.5;
  let bankBoxH = 0;
  if (layout.showBankDetails && bankAccount) {
    const bankRawLines = [
      `Bank: ${bankAccount.bankName}${bankAccount.branchName ? ` (${bankAccount.branchName})` : ''}`,
      `A/C Holder: ${bankAccount.accountHolderName}`,
      `A/C No.: ${bankAccount.accountNumber}`,
      bankAccount.routingCode ? `IFSC / Routing: ${bankAccount.routingCode}` : null,
      bankAccount.upiId ? `UPI ID: ${bankAccount.upiId}` : null,
    ].filter(Boolean) as string[];
    const wrappedBankCount = bankRawLines.reduce(
      (sum, l) => sum + Math.max(1, wrapTextByWidth(l, bankW - 14, (s) => measurePt(s, 8, false)).length),
      0
    );
    bankBoxH = 22 + wrappedBankCount * 11.5;
  }

  let totalsBoxH = 0;
  if (visibility.showFinancialTotals) {
    const totalRowCount =
      docPayload.type === 'RECEIPT'
        ? 3
        : 2 + (layout.showTaxBreakdown ? 1 : 0) + 1 + (docPayload.type === 'INVOICE' ? 2 : 0);
    totalsBoxH = 12 + totalRowCount * 14;
  }
  const bankAndTotalsH = Math.max(bankBoxH, totalsBoxH) > 0 ? Math.max(bankBoxH, totalsBoxH) + 12 : 0;

  const notesText = docPayload.data.notes?.trim() || '';
  const notesWrappedLines = notesText
    ? wrapTextByWidth(notesText, contentWidthPt, (s) => measurePt(s, 8, false))
    : [];

  const termsText =
    ((docPayload.type !== 'RECEIPT' ? docPayload.data.terms : null) || layout.defaultTermsText || '').trim();
  const termsWrappedLines =
    visibility.showTermsAndConditions && termsText
      ? wrapTextByWidth(termsText, contentWidthPt, (s) => measurePt(s, 8, false))
      : [];

  // QR visibility & space reservation strictly honors shouldDisplayPaymentQr(...)
  const qrSource = resolveQrSourceFromContext(context, layout, effectiveProfile);
  const effectiveShowQr = shouldDisplayPaymentQr({
    document: docPayload,
    layout,
    qrSource,
    includePaymentQrOverride: includePaymentQr,
  });
  const qrSizePt = mmToPt(resolvePaymentQrDisplaySizeMm(layout.paymentQrSize));
  const qrBoxH = effectiveShowQr ? qrSizePt + 12 + 14 : 0;
  const qrPos = layout.paymentQrPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right';

  const sigTitle =
    layout.signatoryTitle || effectiveProfile?.documentBranding?.signatureTitle || '';
  let sigBlockH = 0;
  if (visibility.showSignatureBlock) {
    let sy = hasSigImage ? 33 : 24;
    if (visibility.showSignatoryLabels) {
      sy += 4 + 11 + (sigTitle ? 10 : 0);
    }
    sigBlockH = Math.max(sy, hasSeal ? 48 : 0);
  }

  const qrReservedPt = effectiveShowQr
    ? qrPos === 'bottom-right' && visibility.showSignatureBlock
      ? qrBoxH + 10
      : qrBoxH
    : 0;

  let qrAndSigBlockH = 0;
  if (effectiveShowQr && visibility.showSignatureBlock) {
    qrAndSigBlockH =
      qrPos === 'bottom-right'
        ? qrBoxH + 10 + sigBlockH + 8
        : Math.max(qrBoxH, sigBlockH) + 8;
  } else if (effectiveShowQr) {
    qrAndSigBlockH = qrBoxH + 8;
  } else if (visibility.showSignatureBlock) {
    qrAndSigBlockH = sigBlockH + 8;
  }

  interface MutablePage {
    lines: unknown[];
    includeBankAndTotals: boolean;
    notesHeading: boolean;
    notesLines: string[];
    termsHeading: boolean;
    termsLines: string[];
    includeQrAndSignature: boolean;
    cursorPt: number;
  }

  const makePage = (isFirst: boolean): MutablePage => ({
    lines: [],
    includeBankAndTotals: false,
    notesHeading: false,
    notesLines: [],
    termsHeading: false,
    termsLines: [],
    includeQrAndSignature: false,
    cursorPt: isFirst ? page1StartY : continuationStartY,
  });

  const pages: MutablePage[] = [makePage(true)];
  let activePage = pages[0];

  // 1. Place table rows with exact measured heights
  if (allItems.length > 0) {
    // Ensure page 1 can fit table header + first row; otherwise break cleanly
    if (activePage.cursorPt + tableHeaderH + rowHeightsPt[0] > footerTopPt && pages.length === 1) {
      // If page 1 header is huge, move table to page 2 only when page 1 has meaningful content
      if (activePage.cursorPt > topPt + 40) {
        activePage = makePage(false);
        pages.push(activePage);
      }
    }

    let tableOpenOnPage = false;
    for (let i = 0; i < allItems.length; i++) {
      const rowH = rowHeightsPt[i];
      const neededH = (tableOpenOnPage ? 0 : tableHeaderH) + rowH;
      if (activePage.cursorPt + neededH > footerTopPt && (activePage.lines.length > 0 || pages.length > 1 || activePage.cursorPt > continuationStartY)) {
        // Close table spacing on previous page if it had rows
        if (activePage.lines.length > 0) {
          activePage.cursorPt = Math.min(footerTopPt, activePage.cursorPt + 8);
        }
        activePage = makePage(false);
        pages.push(activePage);
        tableOpenOnPage = false;
      }

      if (!tableOpenOnPage) {
        activePage.cursorPt += tableHeaderH;
        tableOpenOnPage = true;
      }
      activePage.lines.push(allItems[i]);
      activePage.cursorPt += rowH;
    }

    // Spacing after the table
    if (activePage.lines.length > 0) {
      activePage.cursorPt = Math.min(footerTopPt, activePage.cursorPt + 12);
    }
  }

  const ensureSpaceOrNewPage = (requiredPt: number) => {
    if (requiredPt <= 0) return;
    if (activePage.cursorPt + requiredPt > footerTopPt) {
      const pageHasContent =
        activePage.lines.length > 0 ||
        activePage.includeBankAndTotals ||
        activePage.notesLines.length > 0 ||
        activePage.termsLines.length > 0 ||
        activePage.includeQrAndSignature ||
        pages.length === 1;
      if (pageHasContent && activePage.cursorPt > continuationStartY) {
        activePage = makePage(false);
        pages.push(activePage);
      }
    }
  };

  // 2. Place Bank Details & Financial Totals
  if (bankAndTotalsH > 0) {
    ensureSpaceOrNewPage(bankAndTotalsH);
    activePage.includeBankAndTotals = true;
    activePage.cursorPt += bankAndTotalsH;
  }

  // 3. Place Notes (paginating line-by-line if long)
  if (notesWrappedLines.length > 0) {
    const lineH = 10.5;
    let idx = 0;
    while (idx < notesWrappedLines.length) {
      const headingH = idx === 0 ? 10 : 10;
      if (activePage.cursorPt + headingH + lineH > footerTopPt) {
        activePage = makePage(false);
        pages.push(activePage);
      }
      activePage.notesHeading = true;
      activePage.cursorPt += headingH;
      while (idx < notesWrappedLines.length && activePage.cursorPt + lineH <= footerTopPt) {
        activePage.notesLines.push(notesWrappedLines[idx]);
        activePage.cursorPt += lineH;
        idx++;
      }
      if (idx >= notesWrappedLines.length) {
        activePage.cursorPt = Math.min(footerTopPt, activePage.cursorPt + 5);
      }
    }
  }

  // 4. Place Terms & Conditions (paginating line-by-line if long)
  if (termsWrappedLines.length > 0) {
    const lineH = 10.5;
    let idx = 0;
    while (idx < termsWrappedLines.length) {
      const headingH = 10;
      if (activePage.cursorPt + headingH + lineH > footerTopPt) {
        activePage = makePage(false);
        pages.push(activePage);
      }
      activePage.termsHeading = true;
      activePage.cursorPt += headingH;
      while (idx < termsWrappedLines.length && activePage.cursorPt + lineH <= footerTopPt) {
        activePage.termsLines.push(termsWrappedLines[idx]);
        activePage.cursorPt += lineH;
        idx++;
      }
      if (idx >= termsWrappedLines.length) {
        activePage.cursorPt = Math.min(footerTopPt, activePage.cursorPt + 8);
      }
    }
  }

  // 5. Place Payment QR & Signature/Seal Block
  if (qrAndSigBlockH > 0) {
    ensureSpaceOrNewPage(qrAndSigBlockH);
    activePage.includeQrAndSignature = true;
    activePage.cursorPt += qrAndSigBlockH;
  }

  const totalPages = pages.length;
  return {
    widthMm,
    heightMm,
    dpi,
    widthPx,
    heightPx,
    effectiveShowQr,
    qrReservedPt,
    visibility,
    columns,
    pages: pages.map((p, idx) => ({
      pageNumber: idx + 1,
      totalPages,
      lines: p.lines,
      includeSummaryAndFooter:
        p.includeBankAndTotals ||
        p.notesLines.length > 0 ||
        p.termsLines.length > 0 ||
        p.includeQrAndSignature ||
        idx === totalPages - 1,
      includeBankAndTotals: p.includeBankAndTotals,
      notesHeading: p.notesHeading,
      notesLines: p.notesLines,
      termsHeading: p.termsHeading,
      termsLines: p.termsLines,
      includeQrAndSignature: p.includeQrAndSignature,
      maxContentBottomPt: Math.min(p.cursorPt, footerTopPt),
      footerTopPt,
    })),
  };
}

/**
 * Packages rendered page buffers into either a single image payload or a multi-page ZIP archive.
 */
export function packageRenderedImagePages(
  docPayload: DocumentExportContext['document'],
  pageBuffers: Uint8Array[],
  format: ImageExportFormat,
  isDraftPreview?: boolean
): {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  pageCount: number;
  isZip: boolean;
} {
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const ext = format === 'png' ? 'png' : 'jpg';

  if (pageBuffers.length <= 1) {
    return {
      bytes: pageBuffers[0] || new Uint8Array(0),
      fileName: buildExportFileName(docPayload, ext, isDraftPreview),
      mimeType,
      pageCount: Math.max(1, pageBuffers.length),
      isZip: false,
    };
  }

  const baseFileName = buildExportFileName(docPayload, ext, isDraftPreview).replace(
    new RegExp(`\\.${ext}$`),
    ''
  );
  const zipEntries = pageBuffers.map((data, idx) => ({
    name: `${baseFileName}-page-${idx + 1}.${ext}`,
    data,
  }));

  return {
    bytes: createZipArchive(zipEntries),
    fileName: `${baseFileName}-${ext}-pages.zip`,
    mimeType: 'application/zip',
    pageCount: pageBuffers.length,
    isZip: true,
  };
}

async function loadImageBitmap(src?: string | null): Promise<HTMLImageElement | null> {
  if (!src || typeof window === 'undefined') return null;
  try {
    let objectUrl: string | null = null;
    let imgSrc = src;

    if (src.startsWith('/')) {
      const resp = await fetch(src, { credentials: 'include' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      objectUrl = URL.createObjectURL(blob);
      imgSrc = objectUrl;
    }

    return await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        resolve(img);
      };
      img.onerror = () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      img.src = imgSrc;
    });
  } catch {
    return null;
  }
}

function drawContainedImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  align: 'left' | 'center' | 'right' = 'left'
) {
  const ratio = img.naturalWidth / Math.max(1, img.naturalHeight);
  let drawW = boxW;
  let drawH = drawW / ratio;
  if (drawH > boxH) {
    drawH = boxH;
    drawW = drawH * ratio;
  }
  const x =
    align === 'center'
      ? boxX + (boxW - drawW) / 2
      : align === 'right'
      ? boxX + (boxW - drawW)
      : boxX;
  const y = boxY + (boxH - drawH) / 2;
  ctx.drawImage(img, x, y, drawW, drawH);
}

/**
 * Renders the document to crisp single-page JPG/PNG or a multi-page ZIP archive of page images.
 */
export async function generateDocumentImageExport(
  context: DocumentExportContext,
  options: ImageExportOptions
): Promise<{
  blob: Blob;
  fileName: string;
  pageCount: number;
  isZip: boolean;
}> {
  if (typeof document === 'undefined') {
    throw new Error('Image export requires a browser Canvas context.');
  }

  const {
    document: docPayload,
    layoutOverride,
    bankAccount,
    isDraftPreview,
    copyLabel,
    includePaymentQr,
  } = context;
  const { effectiveProfile, layout } = resolveDocumentEffectiveBranding(
    docPayload,
    context.companyProfile,
    layoutOverride,
    isDraftPreview
  );

  const dpi = options.quality === 'high' ? 300 : 150;
  const scale = dpi / 72; // 1pt -> px at chosen DPI
  const pt = (v: number) => v * scale;
  const mm = (v: number) => mmToPx(v, dpi);
  const sansFont = `'Plus Jakarta Sans', 'Noto Sans Kannada', Arial, sans-serif`;

  // Use a real Canvas 2D context for exact font measurement during pagination planning
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const canvasMeasurePt: TextMeasurerPt = measureCtx
    ? (text: string, fontPt: number, bold = false) => {
        measureCtx.font = `${bold ? 700 : 400} ${pt(fontPt)}px ${sansFont}`;
        return measureCtx.measureText(text).width / scale;
      }
    : defaultMeasureTextPt;

  const plan = planImageExportPages(context, options.quality, {
    measureTextPt: canvasMeasurePt,
  });
  const visibility = plan.visibility;

  const resolvedLogoUrl =
    effectiveProfile?.brandingAssets?.logo?.url || effectiveProfile?.logoUrl || '';
  const resolvedSealUrl =
    layout.sealUrl ||
    effectiveProfile?.documentBranding?.sealUrl ||
    effectiveProfile?.sealUrl ||
    effectiveProfile?.brandingAssets?.seal?.url ||
    '';
  const resolvedSignatureUrl =
    layout.signatureUrl ||
    effectiveProfile?.documentBranding?.signatureUrl ||
    effectiveProfile?.signatureUrl ||
    effectiveProfile?.brandingAssets?.signature?.url ||
    '';
  const resolvedPaymentQrUrl =
    layout.paymentQrUrl ||
    effectiveProfile?.documentBranding?.paymentQrUrl ||
    effectiveProfile?.paymentQrUrl ||
    effectiveProfile?.brandingAssets?.paymentQr?.url ||
    '';

  const showQr = shouldDisplayPaymentQr({
    document: docPayload,
    layout,
    qrSource: resolvedPaymentQrUrl,
    includePaymentQrOverride: includePaymentQr,
  });

  const [logoImg, sealImg, sigImg, qrImg] = await Promise.all([
    visibility.showLogo ? loadImageBitmap(resolvedLogoUrl) : Promise.resolve(null),
    visibility.showSeal ? loadImageBitmap(resolvedSealUrl) : Promise.resolve(null),
    visibility.showSignature ? loadImageBitmap(resolvedSignatureUrl) : Promise.resolve(null),
    showQr ? loadImageBitmap(resolvedPaymentQrUrl) : Promise.resolve(null),
  ]);

  const companyName = effectiveProfile?.name || 'CoreERP Enterprise';
  const timezone = getEffectiveTimeZone(effectiveProfile?.timezone);
  const roundingPrecision = effectiveProfile?.roundingPrecision ?? 2;
  const docCurrency = normalizeCurrencyCode(
    docPayload.data.currency || effectiveProfile?.currency,
    effectiveProfile?.currency || 'INR'
  );
  const fmt = (val: string | number | null | undefined) =>
    formatMoney(val, docCurrency, {
      decimals: roundingPrecision,
      displayMode: layout.currencyDisplayMode,
    });
  const docNumber =
    docPayload.type === 'QUOTATION'
      ? docPayload.data.quotationNumber
      : docPayload.type === 'INVOICE'
      ? docPayload.data.invoiceNumber
      : docPayload.data.receiptNumber;
  const defaultTitleKey: DocumentPrintLabelKey =
    docPayload.type === 'QUOTATION'
      ? 'quotation'
      : docPayload.type === 'INVOICE'
      ? 'invoice'
      : 'receipt';
  const resolvedTitle =
    (docPayload.type !== 'RECEIPT' && docPayload.data.documentTitle?.trim()) ||
    layout.customDocumentTitle?.trim() ||
    formatLabel(defaultTitleKey, layout.language);
  const resolvedCopyLabel = formatCopyLabelText(copyLabel);
  const printedAtLabel = formatDateTimeInTimezone(new Date(), timezone, { includeZoneAbbr: true });

  const pageBuffers: Uint8Array[] = [];
  const mimeType = options.format === 'png' ? 'image/png' : 'image/jpeg';
  const jpegQuality = options.quality === 'high' ? 0.94 : 0.85;

  for (const page of plan.pages) {
    const canvas = document.createElement('canvas');
    canvas.width = plan.widthPx;
    canvas.height = plan.heightPx;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to initialize 2D canvas context.');

    const wrapForCtx = (text: string, maxWidthPx: number, fontPt: number, bold = false): string[] => {
      ctx.font = `${bold ? 700 : 400} ${pt(fontPt)}px ${sansFont}`;
      return wrapTextByWidth(text, maxWidthPx / scale, (s) => ctx.measureText(s).width / scale);
    };

    // Crisp white paper background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const left = mm(layout.margins.leftMm);
    const right = canvas.width - mm(layout.margins.rightMm);
    const top = mm(layout.margins.topMm);
    const bottom = canvas.height - mm(layout.margins.bottomMm);
    const contentW = right - left;
    const footerTopPx = pt(page.footerTopPt);
    let y = top;

    // Optional top banner / copy label
    if (page.pageNumber === 1 && (layout.headerText || isDraftPreview || resolvedCopyLabel)) {
      ctx.font = `600 ${pt(8)}px ${sansFont}`;
      ctx.fillStyle = '#475569';
      ctx.textBaseline = 'top';
      const parts = [
        layout.headerText || null,
        isDraftPreview ? 'DRAFT PREVIEW' : null,
        resolvedCopyLabel,
      ].filter(Boolean);
      ctx.fillText(parts.join('  |  '), left, y);
      y += pt(13);
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = Math.max(1, pt(0.5));
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      y += pt(7);
    }

    if (page.pageNumber === 1) {
      // Full Header: Company Left + Title/DocNo Right
      const headerStartY = y;
      const leftColW = contentW * 0.58;
      let leftY = headerStartY;

      if (logoImg && visibility.showLogo) {
        const logoH = layout.logoSize === 'sm' ? pt(28) : layout.logoSize === 'lg' ? pt(48) : pt(36);
        const logoW = pt(120);
        drawContainedImage(ctx, logoImg, left, leftY, logoW, logoH, layout.logoPosition);
        leftY += logoH + pt(5);
      }

      if (visibility.showCompanyName) {
        ctx.fillStyle = '#0f172a';
        ctx.textBaseline = 'top';
        for (const wrappedName of wrapForCtx(companyName, leftColW, 14, true)) {
          ctx.font = `700 ${pt(14)}px ${sansFont}`;
          ctx.fillText(wrappedName, left, leftY);
          leftY += pt(17);
        }
        if (effectiveProfile?.legalName && effectiveProfile.legalName !== companyName) {
          ctx.fillStyle = '#475569';
          for (const wrappedLegal of wrapForCtx(effectiveProfile.legalName, leftColW, 9, false)) {
            ctx.font = `400 ${pt(9)}px ${sansFont}`;
            ctx.fillText(wrappedLegal, left, leftY);
            leftY += pt(12);
          }
        }
      }

      if (visibility.showCompanyHeader) {
        if (layout.showCompanyContact) {
          ctx.fillStyle = '#475569';
          for (const addrLine of formatCompanyAddressLines(effectiveProfile)) {
            for (const wrapped of wrapForCtx(addrLine, leftColW, 8.5, false)) {
              ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
              ctx.fillText(wrapped, left, leftY);
              leftY += pt(11.5);
            }
          }
          const contactLine = resolveCompanyContactParts(effectiveProfile).join('  •  ');
          if (contactLine) {
            for (const wrapped of wrapForCtx(contactLine, leftColW, 8.5, false)) {
              ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
              ctx.fillText(wrapped, left, leftY);
              leftY += pt(11.5);
            }
          }
        }

        const resolvedTaxId = resolveCompanyTaxId(effectiveProfile);
        if (layout.showCompanyTaxId && resolvedTaxId) {
          ctx.font = `600 ${pt(8.5)}px ${sansFont}`;
          ctx.fillStyle = '#334155';
          ctx.fillText(
            `${formatLabel('taxId', layout.language)}: ${resolvedTaxId}`,
            left,
            leftY
          );
          leftY += pt(12);
        }
      }

      // Right column: Document Title & Number
      let rightY = headerStartY;
      ctx.textAlign = 'right';
      if (visibility.showDocumentTitle) {
        ctx.font = `700 ${pt(15)}px ${sansFont}`;
        ctx.fillStyle = '#0f172a';
        ctx.fillText(resolvedTitle.toUpperCase(), right, rightY);
        rightY += pt(20);
      }

      if (visibility.showDocumentNumber) {
        ctx.font = `700 ${pt(9.5)}px ${sansFont}`;
        ctx.fillStyle = '#1e293b';
        const numLabelKey: DocumentPrintLabelKey =
          docPayload.type === 'QUOTATION'
            ? 'quotationNumber'
            : docPayload.type === 'INVOICE'
            ? 'invoiceNumber'
            : 'receiptNumber';
        ctx.fillText(
          `${formatLabel(numLabelKey, layout.language)}: ${docNumber || 'DRAFT PREVIEW'}`,
          right,
          rightY
        );
        rightY += pt(14);
      }
      ctx.textAlign = 'left';

      y = Math.max(leftY, rightY) + pt(6);
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = Math.max(1.5, pt(1.2));
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      y += pt(10);

      // Customer + Metadata Boxes
      if (visibility.showCustomerDetails || visibility.showDates) {
        const boxGap = pt(10);
        const boxW = (contentW - boxGap) / 2;
        const boxStartY = y;

        const partyLines: string[] = [docPayload.data.customerName];
        if (docPayload.type !== 'RECEIPT') {
          if (layout.showCustomerAddress && docPayload.data.customerAddress) {
            partyLines.push(docPayload.data.customerAddress);
          }
          if (layout.showCustomerContact) {
            const cLine = [docPayload.data.customerEmail, docPayload.data.customerPhone]
              .filter(Boolean)
              .join(' • ');
            if (cLine) partyLines.push(cLine);
          }
          if (layout.showCustomerTaxId && docPayload.data.customerTaxId) {
            partyLines.push(`Tax ID: ${docPayload.data.customerTaxId}`);
          }
        }

        const metaRows: Array<[string, string]> = [
          [
            formatLabel('date', layout.language),
            docPayload.type === 'QUOTATION'
              ? docPayload.data.quotationDate
              : docPayload.type === 'INVOICE'
              ? docPayload.data.invoiceDate
              : docPayload.data.receiptDate,
          ],
        ];
        if (docPayload.type === 'INVOICE') {
          metaRows.push([formatLabel('dueDate', layout.language), docPayload.data.dueDate]);
        } else if (docPayload.type === 'QUOTATION') {
          metaRows.push([formatLabel('validUntil', layout.language), docPayload.data.validUntilDate]);
        } else {
          metaRows.push([
            formatLabel('paymentMethod', layout.language),
            docPayload.data.paymentMethod.replace(/_/g, ' '),
          ]);
          if (docPayload.data.referenceNumber) {
            metaRows.push([
              formatLabel('referenceNumber', layout.language),
              docPayload.data.referenceNumber,
            ]);
          }
        }
        metaRows.push([formatLabel('currency', layout.language), docCurrency]);
        metaRows.push([formatLabel('status', layout.language), docPayload.data.status]);

        const wrappedPartyLines = visibility.showCustomerDetails
          ? partyLines.flatMap((l) => wrapForCtx(l, boxW - pt(14), 8.5, false))
          : [];
        const partyBoxH = visibility.showCustomerDetails
          ? pt(22) + Math.max(1, wrappedPartyLines.length) * pt(11.5)
          : 0;
        const metaBoxH = visibility.showDates ? pt(16) + metaRows.length * pt(13) : 0;
        const boxH = Math.max(partyBoxH, metaBoxH);

        if (visibility.showCustomerDetails) {
          ctx.fillStyle = '#f8fafc';
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = Math.max(1, pt(0.75));
          ctx.fillRect(left, boxStartY, boxW, boxH);
          ctx.strokeRect(left, boxStartY, boxW, boxH);

          let py = boxStartY + pt(6);
          ctx.font = `700 ${pt(7.5)}px ${sansFont}`;
          ctx.fillStyle = '#64748b';
          const partyHeadingKey: DocumentPrintLabelKey =
            docPayload.type === 'QUOTATION'
              ? 'quotedFor'
              : docPayload.type === 'INVOICE'
              ? 'billedTo'
              : 'receivedFrom';
          ctx.fillText(formatLabel(partyHeadingKey, layout.language).toUpperCase(), left + pt(7), py);
          py += pt(11);

          wrappedPartyLines.forEach((line, idx) => {
            ctx.font = idx === 0 ? `700 ${pt(9.5)}px ${sansFont}` : `400 ${pt(8.5)}px ${sansFont}`;
            ctx.fillStyle = idx === 0 ? '#0f172a' : '#475569';
            ctx.fillText(line, left + pt(7), py);
            py += pt(11.5);
          });
        }

        if (visibility.showDates) {
          const metaX = left + boxW + boxGap;
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = Math.max(1, pt(0.75));
          ctx.strokeRect(metaX, boxStartY, boxW, boxH);
          let my = boxStartY + pt(7);
          for (const [k, v] of metaRows) {
            ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
            ctx.fillStyle = '#64748b';
            ctx.fillText(`${k}:`, metaX + pt(7), my);
            ctx.textAlign = 'right';
            ctx.font = `600 ${pt(8.5)}px ${sansFont}`;
            ctx.fillStyle = '#0f172a';
            ctx.fillText(v, metaX + boxW - pt(7), my);
            ctx.textAlign = 'left';
            my += pt(13);
          }
        }

        y = boxStartY + boxH + pt(12);
      }
    } else {
      // Continuation page compact header
      ctx.font = `700 ${pt(8)}px ${sansFont}`;
      ctx.fillStyle = '#64748b';
      ctx.textBaseline = 'top';
      ctx.fillText(
        `${companyName}  •  ${resolvedTitle.toUpperCase()}  •  ${docNumber || 'DRAFT PREVIEW'} (Page ${page.pageNumber} of ${page.totalPages})`,
        left,
        y
      );
      y += pt(13);
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = Math.max(1, pt(0.5));
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      y += pt(10);
    }

    // Table Section (when page has lines)
    if (page.lines.length > 0) {
      const headerH = pt(20);

      if (docPayload.type !== 'RECEIPT') {
        const cols = resolveImageExportColumns(layout, contentW);

        if (visibility.showTableHeadings) {
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(left, y, contentW, headerH);
          ctx.fillStyle = '#ffffff';
          ctx.font = `700 ${pt(7.5)}px ${sansFont}`;
          ctx.textBaseline = 'middle';

          let cx = left;
          for (const col of cols) {
            ctx.textAlign = col.align;
            const tx = col.align === 'right' ? cx + col.width - pt(5) : cx + pt(5);
            ctx.fillText(col.label, tx, y + headerH / 2);
            cx += col.width;
          }
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          y += headerH;
        }

        const descCol = cols.find((c) => c.key === 'desc') || cols[1];
        const rowPad = layout.serviceLayout === 'compact' ? pt(4) : pt(6);

        page.lines.forEach((rawLine, idx) => {
          const line = rawLine as (typeof docPayload.data.lines)[number];
          const descLines = wrapForCtx(
            line.itemDescription || '',
            Math.max(pt(40), descCol.width - pt(10)),
            8.5,
            false
          );
          const rowH = Math.max(pt(18), Math.max(1, descLines.length) * pt(11) + rowPad * 2);

          if (idx % 2 === 1) {
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(left, y, contentW, rowH);
          }

          ctx.fillStyle = '#0f172a';
          ctx.textBaseline = 'top';
          let colX = left;
          for (const col of cols) {
            if (col.key === 'sn') {
              ctx.textAlign = 'left';
              ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
              ctx.fillText(String(line.lineNumber || idx + 1), colX + pt(5), y + rowPad);
            } else if (col.key === 'desc') {
              ctx.textAlign = 'left';
              ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
              descLines.forEach((dl, di) => {
                ctx.fillText(dl, colX + pt(5), y + rowPad + di * pt(11));
              });
            } else if (col.key === 'qty') {
              ctx.textAlign = 'right';
              ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
              ctx.fillText(String(line.quantity), colX + col.width - pt(5), y + rowPad);
            } else if (col.key === 'rate') {
              ctx.textAlign = 'right';
              ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
              ctx.fillText(fmt(line.unitPrice), colX + col.width - pt(5), y + rowPad);
            } else if (col.key === 'disc') {
              ctx.textAlign = 'right';
              ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
              ctx.fillText(fmt(line.discountAmount), colX + col.width - pt(5), y + rowPad);
            } else if (col.key === 'tax') {
              ctx.textAlign = 'right';
              ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
              const taxText =
                layout.serviceLayout === 'detailed'
                  ? `${fmt(line.taxAmount)} (${Number(line.taxRate).toFixed(1)}%)`
                  : fmt(line.taxAmount);
              ctx.fillText(taxText, colX + col.width - pt(5), y + rowPad);
            } else if (col.key === 'amt') {
              ctx.textAlign = 'right';
              ctx.font = `600 ${pt(8.5)}px ${sansFont}`;
              ctx.fillText(fmt(line.lineTotal), colX + col.width - pt(5), y + rowPad);
            }
            colX += col.width;
          }
          ctx.textAlign = 'left';

          y += rowH;
          ctx.strokeStyle = '#e2e8f0';
          ctx.lineWidth = Math.max(1, pt(0.5));
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();
        });
      } else {
        const cols = [
          { label: '#', width: contentW * 0.08, align: 'left' as const },
          {
            label: formatLabel('invoiceNumber', layout.language).toUpperCase(),
            width: contentW * 0.42,
            align: 'left' as const,
          },
          {
            label: formatLabel('grandTotal', layout.language).toUpperCase(),
            width: contentW * 0.25,
            align: 'right' as const,
          },
          {
            label: formatLabel('amountPaid', layout.language).toUpperCase(),
            width: contentW * 0.25,
            align: 'right' as const,
          },
        ];

        if (visibility.showTableHeadings) {
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(left, y, contentW, headerH);
          ctx.fillStyle = '#ffffff';
          ctx.font = `700 ${pt(7.5)}px ${sansFont}`;
          ctx.textBaseline = 'middle';

          let cx = left;
          for (const col of cols) {
            ctx.textAlign = col.align;
            ctx.fillText(
              col.label,
              col.align === 'right' ? cx + col.width - pt(5) : cx + pt(5),
              y + headerH / 2
            );
            cx += col.width;
          }
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          y += headerH;
        }

        page.lines.forEach((rawAlloc, idx) => {
          const alloc = rawAlloc as (typeof docPayload.data.allocations)[number];
          const rowH = pt(20);
          if (idx % 2 === 1) {
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(left, y, contentW, rowH);
          }
          ctx.font = `400 ${pt(8.5)}px ${sansFont}`;
          ctx.fillStyle = '#0f172a';
          ctx.fillText(String(idx + 1), left + pt(5), y + pt(5));
          ctx.fillText(alloc.invoiceNumber, left + cols[0].width + pt(5), y + pt(5));
          ctx.textAlign = 'right';
          ctx.fillText(
            fmt(alloc.invoiceTotal),
            left + cols[0].width + cols[1].width + cols[2].width - pt(5),
            y + pt(5)
          );
          ctx.font = `600 ${pt(8.5)}px ${sansFont}`;
          ctx.fillText(fmt(alloc.allocatedAmount), right - pt(5), y + pt(5));
          ctx.textAlign = 'left';
          y += rowH;
        });
      }

      y = Math.min(footerTopPx, y + pt(12));
    }

    // Bank Details & Financial Totals (planned page placement)
    if (page.includeBankAndTotals) {
      const summaryY = y;
      const bankW = contentW * 0.5;
      const totalsW = contentW * 0.45;
      const totalsX = right - totalsW;

      let bankEndY = summaryY;
      if (layout.showBankDetails && bankAccount) {
        const bankRawLines = [
          `Bank: ${bankAccount.bankName}${bankAccount.branchName ? ` (${bankAccount.branchName})` : ''}`,
          `A/C Holder: ${bankAccount.accountHolderName}`,
          `A/C No.: ${bankAccount.accountNumber}`,
          bankAccount.routingCode ? `IFSC / Routing: ${bankAccount.routingCode}` : null,
          bankAccount.upiId ? `UPI ID: ${bankAccount.upiId}` : null,
        ].filter(Boolean) as string[];
        const wrappedBankLines = bankRawLines.flatMap((bl) =>
          wrapForCtx(bl, bankW - pt(14), 8, false)
        );
        const bankH = pt(22) + wrappedBankLines.length * pt(11.5);
        ctx.fillStyle = '#f8fafc';
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = Math.max(1, pt(0.75));
        ctx.fillRect(left, summaryY, bankW, bankH);
        ctx.strokeRect(left, summaryY, bankW, bankH);

        let by = summaryY + pt(6);
        ctx.font = `700 ${pt(7.5)}px ${sansFont}`;
        ctx.fillStyle = '#475569';
        ctx.fillText(formatLabel('bankDetails', layout.language).toUpperCase(), left + pt(7), by);
        by += pt(12);
        ctx.font = `400 ${pt(8)}px ${sansFont}`;
        ctx.fillStyle = '#0f172a';
        for (const bl of wrappedBankLines) {
          ctx.fillText(bl, left + pt(7), by);
          by += pt(11.5);
        }
        bankEndY = summaryY + bankH;
      }

      let totalsEndY = summaryY;
      if (visibility.showFinancialTotals) {
        const totalRows: Array<{ label: string; value: string; bold?: boolean }> =
          docPayload.type === 'RECEIPT'
            ? [
                {
                  label: formatLabel('amountReceived', layout.language),
                  value: fmt(docPayload.data.amount),
                  bold: true,
                },
                {
                  label: formatLabel('allocatedTotal', layout.language),
                  value: fmt(docPayload.data.allocatedTotal),
                },
                {
                  label: formatLabel('unallocatedCredit', layout.language),
                  value: fmt(docPayload.data.unallocatedAmount),
                },
              ]
            : [
                { label: formatLabel('subtotal', layout.language), value: fmt(docPayload.data.subtotal) },
                {
                  label: formatLabel('totalDiscount', layout.language),
                  value: `-${fmt(docPayload.data.discountTotal)}`,
                },
                ...(layout.showTaxBreakdown
                  ? [
                      {
                        label: formatLabel('totalTax', layout.language),
                        value: fmt(docPayload.data.taxTotal),
                      },
                    ]
                  : []),
                {
                  label: formatLabel('grandTotal', layout.language),
                  value: fmt(docPayload.data.total),
                  bold: true,
                },
                ...(docPayload.type === 'INVOICE'
                  ? [
                      {
                        label: formatLabel('amountPaid', layout.language),
                        value: fmt(docPayload.data.amountPaid),
                      },
                      {
                        label: formatLabel('balanceDue', layout.language),
                        value: fmt(docPayload.data.balanceDue),
                        bold: true,
                      },
                    ]
                  : []),
              ];

        const totalsH = pt(12) + totalRows.length * pt(14);
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = Math.max(1, pt(0.75));
        ctx.strokeRect(totalsX, summaryY, totalsW, totalsH);
        let ty = summaryY + pt(7);
        for (const tr of totalRows) {
          ctx.font = tr.bold ? `700 ${pt(9)}px ${sansFont}` : `400 ${pt(8.5)}px ${sansFont}`;
          ctx.fillStyle = tr.bold ? '#0f172a' : '#475569';
          ctx.fillText(tr.label, totalsX + pt(7), ty);
          ctx.textAlign = 'right';
          ctx.fillStyle = '#0f172a';
          ctx.fillText(tr.value, totalsX + totalsW - pt(7), ty);
          ctx.textAlign = 'left';
          ty += pt(14);
        }
        totalsEndY = summaryY + totalsH;
      }

      y = Math.min(footerTopPx, Math.max(bankEndY, totalsEndY) + pt(12));
    }

    // Notes Slice (paginated cleanly above footerTopPx)
    if (page.notesLines.length > 0) {
      if (page.notesHeading) {
        ctx.font = `700 ${pt(7.5)}px ${sansFont}`;
        ctx.fillStyle = '#64748b';
        ctx.fillText(formatLabel('notes', layout.language).toUpperCase(), left, y);
        y += pt(10);
      }
      ctx.font = `400 ${pt(8)}px ${sansFont}`;
      ctx.fillStyle = '#334155';
      for (const nl of page.notesLines) {
        if (y + pt(10.5) > footerTopPx) break;
        ctx.fillText(nl, left, y);
        y += pt(10.5);
      }
      y = Math.min(footerTopPx, y + pt(5));
    }

    // Terms & Conditions Slice (paginated cleanly above footerTopPx)
    if (visibility.showTermsAndConditions && page.termsLines.length > 0) {
      if (page.termsHeading) {
        ctx.font = `700 ${pt(7.5)}px ${sansFont}`;
        ctx.fillStyle = '#64748b';
        ctx.fillText(formatLabel('termsAndConditions', layout.language).toUpperCase(), left, y);
        y += pt(10);
      }
      ctx.font = `400 ${pt(8)}px ${sansFont}`;
      ctx.fillStyle = '#334155';
      for (const tl of page.termsLines) {
        if (y + pt(10.5) > footerTopPx) break;
        ctx.fillText(tl, left, y);
        y += pt(10.5);
      }
      y = Math.min(footerTopPx, y + pt(8));
    }

    // Payment QR + Signature & Seal Row (strictly non-overlapping)
    if (page.includeQrAndSignature) {
      const qrSizePx = mm(resolvePaymentQrDisplaySizeMm(layout.paymentQrSize));
      const qrBoxPad = pt(6);
      const qrBoxW = Math.max(qrSizePx + qrBoxPad * 2, pt(76));
      const qrBoxH = qrSizePx + qrBoxPad * 2 + pt(14);
      const qrLabelText = (layout.paymentQrLabel || 'Scan to Pay').trim() || 'Scan to Pay';
      const qrPos = layout.paymentQrPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right';

      const drawQrBlock = (qx: number, qy: number) => {
        if (!qrImg) return qy;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = Math.max(1, pt(0.75));
        ctx.fillRect(qx, qy, qrBoxW, qrBoxH);
        ctx.strokeRect(qx, qy, qrBoxW, qrBoxH);
        drawContainedImage(
          ctx,
          qrImg,
          qx + (qrBoxW - qrSizePx) / 2,
          qy + qrBoxPad,
          qrSizePx,
          qrSizePx,
          'center'
        );
        ctx.font = `700 ${pt(7.5)}px ${sansFont}`;
        ctx.fillStyle = '#334155';
        ctx.textAlign = 'center';
        ctx.fillText(qrLabelText, qx + qrBoxW / 2, qy + qrBoxPad + qrSizePx + pt(3));
        ctx.textAlign = 'left';
        return qy + qrBoxH;
      };

      if (showQr && qrImg && qrPos === 'bottom-right' && visibility.showSignatureBlock) {
        y = drawQrBlock(right - qrBoxW, y) + pt(10);
      }

      const rowStartY = y;
      let leftBlockEndY = rowStartY;
      if (showQr && qrImg && (qrPos === 'bottom-left' || !visibility.showSignatureBlock)) {
        const qx = qrPos === 'bottom-left' ? left : right - qrBoxW;
        leftBlockEndY = drawQrBlock(qx, rowStartY);
      }

      let rightBlockEndY = rowStartY;
      if (visibility.showSignatureBlock) {
        const sigBoxW = pt(130);
        const sigX = right - sigBoxW;
        let sy = rowStartY;

        if (sealImg && visibility.showSeal) {
          drawContainedImage(ctx, sealImg, sigX - pt(56), sy, pt(46), pt(46), 'center');
        }
        if (sigImg && visibility.showSignature) {
          drawContainedImage(ctx, sigImg, sigX, sy, sigBoxW, pt(30), 'center');
          sy += pt(33);
        } else {
          sy += pt(24);
        }

        if (visibility.showSignatoryLabels) {
          ctx.strokeStyle = '#94a3b8';
          ctx.lineWidth = Math.max(1, pt(0.75));
          ctx.beginPath();
          ctx.moveTo(sigX, sy);
          ctx.lineTo(sigX + sigBoxW, sy);
          ctx.stroke();
          sy += pt(4);

          const sigName =
            layout.signatoryName ||
            effectiveProfile?.documentBranding?.signatoryName ||
            layout.signatureLabel ||
            formatLabel('authorizedSignature', layout.language);
          const sigTitle =
            layout.signatoryTitle || effectiveProfile?.documentBranding?.signatureTitle || '';

          ctx.textAlign = 'center';
          ctx.font = `600 ${pt(8.5)}px ${sansFont}`;
          ctx.fillStyle = '#0f172a';
          ctx.fillText(sigName, sigX + sigBoxW / 2, sy);
          sy += pt(11);
          if (sigTitle) {
            ctx.font = `400 ${pt(7.5)}px ${sansFont}`;
            ctx.fillStyle = '#64748b';
            ctx.fillText(sigTitle, sigX + sigBoxW / 2, sy);
            sy += pt(10);
          }
          ctx.textAlign = 'left';
        }
        rightBlockEndY = Math.max(sy, rowStartY + (sealImg && visibility.showSeal ? pt(48) : 0));
      }

      y = Math.max(leftBlockEndY, rightBlockEndY) + pt(8);
    }

    // Footer & Page Counter (strictly respects visibility.showFooter)
    if (visibility.showFooter) {
      const footerY = bottom - pt(12);
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = Math.max(1, pt(0.5));
      ctx.beginPath();
      ctx.moveTo(left, footerY - pt(4));
      ctx.lineTo(right, footerY - pt(4));
      ctx.stroke();

      ctx.font = `400 ${pt(7.5)}px ${sansFont}`;
      ctx.fillStyle = '#64748b';
      ctx.textBaseline = 'top';
      const footerParts = [
        layout.footerText || '',
        layout.showPrintedTimestamp
          ? `${formatLabel('generatedOn', layout.language)}: ${printedAtLabel} (${timezone})`
          : '',
      ].filter(Boolean);
      if (footerParts.length > 0) {
        ctx.fillText(footerParts.join('  |  '), left, footerY);
      }
      ctx.textAlign = 'right';
      ctx.fillText(`Page ${page.pageNumber} of ${page.totalPages}`, right, footerY);
      ctx.textAlign = 'left';
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) =>
          b ? resolve(b) : reject(new Error(`Failed to encode ${options.format.toUpperCase()} image.`)),
        mimeType,
        options.format === 'jpg' ? jpegQuality : undefined
      );
    });
    pageBuffers.push(new Uint8Array(await blob.arrayBuffer()));
  }

  const packaged = packageRenderedImagePages(
    docPayload,
    pageBuffers,
    options.format,
    isDraftPreview
  );
  return {
    blob: new Blob([packaged.bytes.buffer as ArrayBuffer], { type: packaged.mimeType }),
    fileName: packaged.fileName,
    pageCount: packaged.pageCount,
    isZip: packaged.isZip,
  };
}
