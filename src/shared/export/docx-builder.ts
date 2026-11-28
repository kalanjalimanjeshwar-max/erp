import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  CompanyBankAccountItem,
  CompanyProfile,
  CustomerReceiptItem,
  DocumentLanguage,
  DocumentPrintLayoutConfig,
  DocumentPrintType,
  InvoiceItem,
  QuotationItem,
  VisualElementKey,
  VisualTextFontFamily,
  VisualTextFontWeight,
} from '../types.ts';
import {
  getVisualElementTypography,
  normalizeDocumentVisualElements,
} from '../branding.ts';
import { PAPER_DIMENSIONS_MM } from '../print-settings.ts';
import { DocumentPrintLabelKey, getDocumentLabel } from '../print-translations.ts';
import { formatMoney, normalizeCurrencyCode } from '../currency.ts';
import { formatDateTimeInTimezone, getEffectiveTimeZone } from '../timezone.ts';
import {
  type ExportableDocumentPayload,
  type DocumentExportBrandingImages,
  type DocumentExportContext,
  resolveEffectivePrintLayout,
  resolveDocumentEffectiveBranding,
  buildExportFileName,
  formatCompanyAddressLines,
  resolveCompanyContactParts,
  resolveCompanyTaxId,
  formatCopyLabelText,
  shouldDisplayPaymentQr,
  resolvePaymentQrDisplaySizeMm,
} from './document-branding.ts';

export {
  type ExportableDocumentPayload,
  type DocumentExportBrandingImages,
  type DocumentExportContext,
  resolveEffectivePrintLayout,
  resolveDocumentEffectiveBranding,
  buildExportFileName,
  formatCompanyAddressLines,
  resolveCompanyContactParts,
  resolveCompanyTaxId,
  formatCopyLabelText,
  shouldDisplayPaymentQr,
  resolvePaymentQrDisplaySizeMm,
};

const MM_TO_TWIPS = 56.6929133858;
const FONT_LATIN = 'Noto Sans';
const FONT_KANNADA = 'Noto Sans Kannada';

function mmToTwips(mm: number): number {
  return Math.round(mm * MM_TO_TWIPS);
}

function hasKannada(text: string): boolean {
  return /[\u0C80-\u0CFF]/.test(text);
}

function formatLabelText(key: DocumentPrintLabelKey, language: DocumentLanguage): string {
  const entry = getDocumentLabel(key, language);
  return entry.secondary ? `${entry.primary} / ${entry.secondary}` : entry.primary;
}

function resolveDocxFontFamily(family?: VisualTextFontFamily): string {
  if (family === 'serif') return 'Georgia';
  if (family === 'mono') return 'Courier New';
  if (family === 'noto-kannada') return FONT_KANNADA;
  return FONT_LATIN;
}

function isBoldWeight(weight?: VisualTextFontWeight): boolean {
  return weight === '600' || weight === '700';
}

function makeTextRuns(
  text: string,
  options?: {
    bold?: boolean;
    size?: number; // half-points (20 = 10pt)
    color?: string;
    italics?: boolean;
    fontFamily?: VisualTextFontFamily;
    letterSpacingPt?: number;
  }
): TextRun[] {
  const segments = text.split(/([\u0C80-\u0CFF\s]+)/).filter(Boolean);
  const latinFont = resolveDocxFontFamily(options?.fontFamily);
  const charSpacing =
    typeof options?.letterSpacingPt === 'number' && options.letterSpacingPt !== 0
      ? Math.round(options.letterSpacingPt * 20)
      : undefined;
  if (segments.length === 0) {
    return [
      new TextRun({
        text: '',
        font: latinFont,
        bold: options?.bold,
        size: options?.size ?? 20,
        color: options?.color ?? '0F172A',
        italics: options?.italics,
        ...(charSpacing !== undefined ? { characterSpacing: charSpacing } : {}),
      }),
    ];
  }
  return segments.map((seg) => {
    const isKn = hasKannada(seg);
    return new TextRun({
      text: seg,
      font: isKn ? FONT_KANNADA : latinFont,
      bold: options?.bold,
      size: options?.size ?? 20,
      color: options?.color ?? '0F172A',
      italics: options?.italics,
      ...(charSpacing !== undefined ? { characterSpacing: charSpacing } : {}),
    });
  });
}

function cellBorders(color = 'CBD5E1') {
  return {
    top: { style: BorderStyle.SINGLE, size: 4, color },
    bottom: { style: BorderStyle.SINGLE, size: 4, color },
    left: { style: BorderStyle.SINGLE, size: 4, color },
    right: { style: BorderStyle.SINGLE, size: 4, color },
  };
}

function noBorders() {
  return {
    top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  };
}

function toDocxAlignment(align?: 'left' | 'center' | 'right'): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'right') return AlignmentType.RIGHT;
  return AlignmentType.LEFT;
}

function detectRasterImageType(data?: Uint8Array | Buffer | null): 'png' | 'jpg' | null {
  if (!data || data.length < 8) return null;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'png';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpg';
  }
  return null;
}

function createRasterImageRun(
  data: Uint8Array | Buffer | null | undefined,
  widthMm: number,
  heightMm: number,
  altName: string
): ImageRun | null {
  const type = detectRasterImageType(data);
  if (!type || !data) return null;
  const width = Math.max(16, Math.round((Math.max(6, widthMm) * 96) / 25.4));
  const height = Math.max(12, Math.round((Math.max(6, heightMm) * 96) / 25.4));
  return new ImageRun({
    type,
    data,
    transformation: { width, height },
    altText: {
      title: altName,
      description: altName,
      name: altName,
    },
  });
}

export function createWordDocument(context: DocumentExportContext): Document {
  const {
    document: docPayload,
    layoutOverride,
    bankAccount,
    isDraftPreview,
    brandingImages,
    copyLabel,
    includePaymentQr,
  } = context;
  const docType = docPayload.type;
  const { effectiveProfile: companyProfile, layout } = resolveDocumentEffectiveBranding(
    docPayload,
    context.companyProfile,
    layoutOverride,
    isDraftPreview
  );
  const visualElements = normalizeDocumentVisualElements(
    layout.elements,
    layout.paperSize,
    layout.orientation,
    layout.margins
  );
  const useVisual = Boolean(layout.visualLayoutEnabled);
  const typoFor = (key: VisualElementKey) => {
    const typo = getVisualElementTypography(visualElements[key]);
    return {
      ...typo,
      bold: isBoldWeight(typo.fontWeight),
      halfPt: Math.round(typo.fontSizePt * 2),
      lineTwips: Math.round(typo.lineHeight * 240),
      docxAlign: toDocxAlignment(typo.align),
    };
  };

  const paperDims = PAPER_DIMENSIONS_MM[layout.paperSize] || PAPER_DIMENSIONS_MM.A4;
  const isLandscape = layout.orientation === 'landscape';
  const pageWidthMm = isLandscape ? paperDims.height : paperDims.width;
  const pageHeightMm = isLandscape ? paperDims.width : paperDims.height;

  const companyName = companyProfile?.name || 'CoreERP Enterprise';
  const timezone = getEffectiveTimeZone(companyProfile?.timezone);
  const roundingPrecision = companyProfile?.roundingPrecision ?? 2;
  const documentCurrency = normalizeCurrencyCode(
    docPayload.data.currency || companyProfile?.currency,
    companyProfile?.currency || 'INR'
  );

  const fmt = (amount: string | number | null | undefined) =>
    formatMoney(amount, documentCurrency, {
      decimals: roundingPrecision,
      displayMode: layout.currencyDisplayMode,
    });

  const defaultTitleKey: DocumentPrintLabelKey =
    docType === 'QUOTATION' ? 'quotation' : docType === 'INVOICE' ? 'invoice' : 'receipt';
  const titleEntry = getDocumentLabel(defaultTitleKey, layout.language);
  const customLayoutTitle =
    layout.customDocumentTitle &&
    layout.customDocumentTitle.trim() &&
    layout.customDocumentTitle.trim().toUpperCase() !==
      (docType === 'QUOTATION'
        ? 'QUOTATION'
        : docType === 'INVOICE'
        ? 'TAX INVOICE'
        : 'PAYMENT RECEIPT')
      ? layout.customDocumentTitle.trim()
      : null;

  const defaultTitleStrings = new Set([
    'QUOTATION',
    'TAX INVOICE',
    'INVOICE',
    'COMMERCIAL SALES INVOICE',
    'PAYMENT RECEIPT',
  ]);
  const rawDocTitle =
    docPayload.type !== 'RECEIPT' && docPayload.data.documentTitle?.trim()
      ? docPayload.data.documentTitle.trim()
      : null;
  const documentSpecificTitle =
    rawDocTitle && !(layout.language !== 'EN' && defaultTitleStrings.has(rawDocTitle.toUpperCase()))
      ? rawDocTitle
      : null;

  const resolvedTitle =
    documentSpecificTitle ||
    customLayoutTitle ||
    (titleEntry.secondary ? `${titleEntry.primary} / ${titleEntry.secondary}` : titleEntry.primary);

  const docNumber =
    docPayload.type === 'QUOTATION'
      ? docPayload.data.quotationNumber
      : docPayload.type === 'INVOICE'
      ? docPayload.data.invoiceNumber
      : docPayload.data.receiptNumber;

  const docNumberLabelKey: DocumentPrintLabelKey =
    docType === 'QUOTATION'
      ? 'quotationNumber'
      : docType === 'INVOICE'
      ? 'invoiceNumber'
      : 'receiptNumber';

  const printedAtLabel = formatDateTimeInTimezone(new Date(), timezone, {
    includeZoneAbbr: true,
  });

  const children: Array<Paragraph | Table> = [];

  const resolvedCopyLabel = formatCopyLabelText(copyLabel);

  // Optional header text or explicit copy label
  if (layout.headerText || isDraftPreview || resolvedCopyLabel) {
    const parts = [
      layout.headerText,
      isDraftPreview ? 'DRAFT PREVIEW' : null,
      resolvedCopyLabel ||
        (layout.headerText || isDraftPreview
          ? getDocumentLabel('originalForRecipient', layout.language).primary
          : null),
    ].filter(Boolean);
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: makeTextRuns(parts.join('  |  '), { size: 16, color: '64748B' }),
      })
    );
  }

  // Header table: Company Details (left) + Document Title & Number (right)
  const companyLines: Paragraph[] = [];
  const logoVisual = visualElements.logo;
  const companyNameVisual = visualElements.companyName;
  const headerVisual = visualElements.companyHeader;
  const titleVisual = visualElements.documentTitle;
  const docNumVisual = visualElements.documentNumber;

  const nameTypo = typoFor('companyName');
  const headerTypo = typoFor('companyHeader');
  const titleTypo = typoFor('documentTitle');
  const docNumTypo = typoFor('documentNumber');

  const logoVisible = layout.showLogo && (!useVisual || logoVisual.visible);
  const logoImageRun = logoVisible
    ? createRasterImageRun(
        brandingImages?.logo,
        logoVisual.widthMm,
        logoVisual.heightMm,
        `${companyName} Logo`
      )
    : null;
  if (logoImageRun) {
    companyLines.push(
      new Paragraph({
        alignment: toDocxAlignment(logoVisual.align || layout.logoPosition),
        spacing: { after: Math.max(40, Math.round((logoVisual.spacingMm || 3) * 20)) },
        children: [logoImageRun],
      })
    );
  }

  const companyNameVisible = layout.showCompanyName && (!useVisual || companyNameVisual.visible);
  if (companyNameVisible) {
    companyLines.push(
      new Paragraph({
        alignment: nameTypo.docxAlign,
        spacing: {
          after: Math.max(30, Math.round((companyNameVisual.spacingMm || 1.5) * 20)),
          line: nameTypo.lineTwips,
        },
        children: makeTextRuns(companyName, {
          bold: nameTypo.bold,
          size: nameTypo.halfPt,
          color: '0F172A',
          fontFamily: nameTypo.fontFamily,
          letterSpacingPt: nameTypo.letterSpacing,
        }),
      })
    );
    if (companyProfile?.legalName && companyProfile.legalName !== companyName) {
      companyLines.push(
        new Paragraph({
          alignment: nameTypo.docxAlign,
          spacing: { after: 30, line: nameTypo.lineTwips },
          children: makeTextRuns(companyProfile.legalName, {
            size: Math.max(14, nameTypo.halfPt - 8),
            color: '475569',
            fontFamily: nameTypo.fontFamily,
          }),
        })
      );
    }
  }

  const companyHeaderVisible = !useVisual || headerVisual.visible;
  const headerAlign = headerTypo.docxAlign;

  if (companyHeaderVisible) {
    if (layout.showCompanyContact) {
      const addressLines = formatCompanyAddressLines(companyProfile);
      for (const addrLine of addressLines) {
        companyLines.push(
          new Paragraph({
            alignment: headerAlign,
            spacing: { after: 20, line: headerTypo.lineTwips },
            children: makeTextRuns(addrLine, {
              bold: headerTypo.bold,
              size: headerTypo.halfPt,
              color: '475569',
              fontFamily: headerTypo.fontFamily,
              letterSpacingPt: headerTypo.letterSpacing,
            }),
          })
        );
      }
      const contactParts = resolveCompanyContactParts(companyProfile);
      if (contactParts.length > 0) {
        companyLines.push(
          new Paragraph({
            alignment: headerAlign,
            spacing: { after: 20, line: headerTypo.lineTwips },
            children: makeTextRuns(contactParts.join('  •  '), {
              bold: headerTypo.bold,
              size: headerTypo.halfPt,
              color: '475569',
              fontFamily: headerTypo.fontFamily,
              letterSpacingPt: headerTypo.letterSpacing,
            }),
          })
        );
      }
    }
    const resolvedTaxId = resolveCompanyTaxId(companyProfile);
    if (layout.showCompanyTaxId && resolvedTaxId) {
      companyLines.push(
        new Paragraph({
          alignment: headerAlign,
          spacing: { after: 20, line: headerTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('taxId', layout.language)}: ${resolvedTaxId}`,
            {
              bold: true,
              size: headerTypo.halfPt,
              color: '334155',
              fontFamily: headerTypo.fontFamily,
              letterSpacingPt: headerTypo.letterSpacing,
            }
          ),
        })
      );
    }
  }
  if (companyLines.length === 0) {
    companyLines.push(new Paragraph({ children: [] }));
  }

  const resolvedTitleAlign =
    useVisual && titleVisual.align
      ? titleTypo.docxAlign
      : layout.titlePlacement === 'left'
      ? AlignmentType.LEFT
      : layout.titlePlacement === 'center'
      ? AlignmentType.CENTER
      : AlignmentType.RIGHT;

  const titleVisible = !useVisual || titleVisual.visible;
  const docNumVisible = !useVisual || docNumVisual.visible;
  const titleCellParagraphs: Paragraph[] = [];
  if (titleVisible) {
    titleCellParagraphs.push(
      new Paragraph({
        alignment: resolvedTitleAlign,
        spacing: {
          after: Math.max(40, Math.round((titleVisual.spacingMm || 2) * 20)),
          line: titleTypo.lineTwips,
        },
        children: makeTextRuns(resolvedTitle.toUpperCase(), {
          bold: titleTypo.bold,
          size: titleTypo.halfPt,
          color: '0F172A',
          fontFamily: titleTypo.fontFamily,
          letterSpacingPt: titleTypo.letterSpacing,
        }),
      })
    );
  }
  if (docNumVisible && layout.numberPlacement !== 'meta-grid') {
    titleCellParagraphs.push(
      new Paragraph({
        alignment: useVisual ? docNumTypo.docxAlign : resolvedTitleAlign,
        spacing: { line: docNumTypo.lineTwips },
        children: makeTextRuns(
          `${formatLabelText(docNumberLabelKey, layout.language)}: ${docNumber || 'DRAFT PREVIEW'}`,
          {
            bold: docNumTypo.bold,
            size: docNumTypo.halfPt,
            color: '1E293B',
            fontFamily: docNumTypo.fontFamily,
            letterSpacingPt: docNumTypo.letterSpacing,
          }
        ),
      })
    );
  }
  if (titleCellParagraphs.length === 0) {
    titleCellParagraphs.push(new Paragraph({ children: [] }));
  }

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: noBorders(),
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 58, type: WidthType.PERCENTAGE },
              borders: {
                ...noBorders(),
                bottom: { style: BorderStyle.SINGLE, size: 12, color: '0F172A' },
              },
              margins: { bottom: 140 },
              children: companyLines,
            }),
            new TableCell({
              width: { size: 42, type: WidthType.PERCENTAGE },
              borders: {
                ...noBorders(),
                bottom: { style: BorderStyle.SINGLE, size: 12, color: '0F172A' },
              },
              margins: { bottom: 140 },
              children: titleCellParagraphs,
            }),
          ],
        }),
      ],
    })
  );

  children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));

  // Party + Metadata 2-column table
  const partyLabelKey: DocumentPrintLabelKey =
    docType === 'QUOTATION'
      ? 'quotedFor'
      : docType === 'INVOICE'
      ? 'billedTo'
      : 'receivedFrom';

  const customerTypo = typoFor('customerDetails');
  const datesTypo = typoFor('dates');
  const customerVisible = !useVisual || visualElements.customerDetails.visible;
  const datesVisible = !useVisual || visualElements.dates.visible;

  const partyParagraphs: Paragraph[] = customerVisible
    ? [
        new Paragraph({
          alignment: customerTypo.docxAlign,
          spacing: { after: 40, line: customerTypo.lineTwips },
          children: makeTextRuns(formatLabelText(partyLabelKey, layout.language).toUpperCase(), {
            bold: true,
            size: Math.max(14, customerTypo.halfPt - 2),
            color: '64748B',
            fontFamily: customerTypo.fontFamily,
          }),
        }),
        new Paragraph({
          alignment: customerTypo.docxAlign,
          spacing: { after: 40, line: customerTypo.lineTwips },
          children: makeTextRuns(docPayload.data.customerName, {
            bold: true,
            size: Math.max(18, customerTypo.halfPt + 3),
            color: '0F172A',
            fontFamily: customerTypo.fontFamily,
            letterSpacingPt: customerTypo.letterSpacing,
          }),
        }),
      ]
    : [new Paragraph({ children: [] })];

  if (customerVisible && docPayload.type !== 'RECEIPT') {
    if (layout.showCustomerAddress && docPayload.data.customerAddress) {
      partyParagraphs.push(
        new Paragraph({
          alignment: customerTypo.docxAlign,
          spacing: { after: 30, line: customerTypo.lineTwips },
          children: makeTextRuns(docPayload.data.customerAddress, {
            bold: customerTypo.bold,
            size: customerTypo.halfPt,
            color: '475569',
            fontFamily: customerTypo.fontFamily,
            letterSpacingPt: customerTypo.letterSpacing,
          }),
        })
      );
    }
    if (
      layout.showCustomerContact &&
      (docPayload.data.customerEmail || docPayload.data.customerPhone)
    ) {
      partyParagraphs.push(
        new Paragraph({
          alignment: customerTypo.docxAlign,
          spacing: { after: 30, line: customerTypo.lineTwips },
          children: makeTextRuns(
            [docPayload.data.customerEmail, docPayload.data.customerPhone]
              .filter(Boolean)
              .join('  •  '),
            {
              bold: customerTypo.bold,
              size: customerTypo.halfPt,
              color: '475569',
              fontFamily: customerTypo.fontFamily,
              letterSpacingPt: customerTypo.letterSpacing,
            }
          ),
        })
      );
    }
    if (layout.showCustomerTaxId && docPayload.data.customerTaxId) {
      partyParagraphs.push(
        new Paragraph({
          alignment: customerTypo.docxAlign,
          spacing: { after: 20, line: customerTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('taxId', layout.language)}: ${docPayload.data.customerTaxId}`,
            {
              bold: customerTypo.bold,
              size: customerTypo.halfPt,
              color: '334155',
              fontFamily: customerTypo.fontFamily,
              letterSpacingPt: customerTypo.letterSpacing,
            }
          ),
        })
      );
    }
  }

  const metaParagraphs: Paragraph[] = [];
  const docDate =
    docPayload.type === 'QUOTATION'
      ? docPayload.data.quotationDate
      : docPayload.type === 'INVOICE'
      ? docPayload.data.invoiceDate
      : docPayload.data.receiptDate;

  if (datesVisible) {
    if (layout.numberPlacement === 'meta-grid' && docNumVisible) {
      metaParagraphs.push(
        new Paragraph({
          alignment: datesTypo.docxAlign,
          spacing: { after: 40, line: docNumTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText(docNumberLabelKey, layout.language)}: ${docNumber || 'DRAFT PREVIEW'}`,
            {
              bold: true,
              size: docNumTypo.halfPt,
              fontFamily: docNumTypo.fontFamily,
              letterSpacingPt: docNumTypo.letterSpacing,
            }
          ),
        })
      );
    }

    metaParagraphs.push(
      new Paragraph({
        alignment: datesTypo.docxAlign,
        spacing: { after: 40, line: datesTypo.lineTwips },
        children: makeTextRuns(`${formatLabelText('date', layout.language)}: ${docDate}`, {
          bold: datesTypo.bold,
          size: datesTypo.halfPt,
          fontFamily: datesTypo.fontFamily,
          letterSpacingPt: datesTypo.letterSpacing,
        }),
      })
    );

    if (docPayload.type === 'QUOTATION') {
      metaParagraphs.push(
        new Paragraph({
          alignment: datesTypo.docxAlign,
          spacing: { after: 40, line: datesTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('validUntil', layout.language)}: ${docPayload.data.validUntilDate}`,
            {
              bold: datesTypo.bold,
              size: datesTypo.halfPt,
              fontFamily: datesTypo.fontFamily,
              letterSpacingPt: datesTypo.letterSpacing,
            }
          ),
        })
      );
    } else if (docPayload.type === 'INVOICE') {
      metaParagraphs.push(
        new Paragraph({
          alignment: datesTypo.docxAlign,
          spacing: { after: 40, line: datesTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('dueDate', layout.language)}: ${docPayload.data.dueDate}`,
            {
              bold: datesTypo.bold,
              size: datesTypo.halfPt,
              fontFamily: datesTypo.fontFamily,
              letterSpacingPt: datesTypo.letterSpacing,
            }
          ),
        })
      );
    } else {
      metaParagraphs.push(
        new Paragraph({
          alignment: datesTypo.docxAlign,
          spacing: { after: 40, line: datesTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('paymentMethod', layout.language)}: ${docPayload.data.paymentMethod.replace(/_/g, ' ')}`,
            {
              bold: datesTypo.bold,
              size: datesTypo.halfPt,
              fontFamily: datesTypo.fontFamily,
              letterSpacingPt: datesTypo.letterSpacing,
            }
          ),
        })
      );
    }

    metaParagraphs.push(
      new Paragraph({
        alignment: datesTypo.docxAlign,
        spacing: { after: 40, line: datesTypo.lineTwips },
        children: makeTextRuns(`${formatLabelText('currency', layout.language)}: ${documentCurrency}`, {
          bold: datesTypo.bold,
          size: datesTypo.halfPt,
          fontFamily: datesTypo.fontFamily,
          letterSpacingPt: datesTypo.letterSpacing,
        }),
      }),
      new Paragraph({
        alignment: datesTypo.docxAlign,
        spacing: { line: datesTypo.lineTwips },
        children: makeTextRuns(
          `${formatLabelText('status', layout.language)}: ${docPayload.data.status}`,
          {
            bold: true,
            size: datesTypo.halfPt,
            fontFamily: datesTypo.fontFamily,
            letterSpacingPt: datesTypo.letterSpacing,
          }
        ),
      })
    );
  } else {
    metaParagraphs.push(new Paragraph({ children: [] }));
  }

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: cellBorders('E2E8F0'),
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 52, type: WidthType.PERCENTAGE },
              shading: { type: ShadingType.CLEAR, fill: 'F8FAFC' },
              margins: { top: 120, bottom: 120, left: 140, right: 140 },
              children: partyParagraphs,
            }),
            new TableCell({
              width: { size: 48, type: WidthType.PERCENTAGE },
              margins: { top: 120, bottom: 120, left: 140, right: 140 },
              children: metaParagraphs,
            }),
          ],
        }),
      ],
    })
  );

  children.push(new Paragraph({ spacing: { after: 180 }, children: [] }));

  // Service Line Items Table (Quotation & Invoice)
  const thTypo = typoFor('tableHeadings');
  const tableHeadingsVisible = !useVisual || visualElements.tableHeadings.visible;

  if (docPayload.type !== 'RECEIPT') {
    const headerCells: TableCell[] = [
      new TableCell({
        width: { size: 7, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.CLEAR, fill: '0F172A' },
        margins: { top: 90, bottom: 90, left: 80, right: 80 },
        children: [
          new Paragraph({
            spacing: { line: thTypo.lineTwips },
            children: makeTextRuns(formatLabelText('serialNo', layout.language), {
              bold: thTypo.bold,
              size: thTypo.halfPt,
              color: 'FFFFFF',
              fontFamily: thTypo.fontFamily,
              letterSpacingPt: thTypo.letterSpacing,
            }),
          }),
        ],
      }),
      new TableCell({
        width: {
          size: layout.showDiscountColumn && layout.showTaxColumn ? 35 : 49,
          type: WidthType.PERCENTAGE,
        },
        shading: { type: ShadingType.CLEAR, fill: '0F172A' },
        margins: { top: 90, bottom: 90, left: 80, right: 80 },
        children: [
          new Paragraph({
            spacing: { line: thTypo.lineTwips },
            children: makeTextRuns(formatLabelText('serviceDescription', layout.language), {
              bold: thTypo.bold,
              size: thTypo.halfPt,
              color: 'FFFFFF',
              fontFamily: thTypo.fontFamily,
              letterSpacingPt: thTypo.letterSpacing,
            }),
          }),
        ],
      }),
      new TableCell({
        width: { size: 11, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.CLEAR, fill: '0F172A' },
        margins: { top: 90, bottom: 90, left: 80, right: 80 },
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { line: thTypo.lineTwips },
            children: makeTextRuns(formatLabelText('qtyHours', layout.language), {
              bold: thTypo.bold,
              size: thTypo.halfPt,
              color: 'FFFFFF',
              fontFamily: thTypo.fontFamily,
              letterSpacingPt: thTypo.letterSpacing,
            }),
          }),
        ],
      }),
      new TableCell({
        width: { size: 14, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.CLEAR, fill: '0F172A' },
        margins: { top: 90, bottom: 90, left: 80, right: 80 },
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { line: thTypo.lineTwips },
            children: makeTextRuns(formatLabelText('rate', layout.language), {
              bold: thTypo.bold,
              size: thTypo.halfPt,
              color: 'FFFFFF',
              fontFamily: thTypo.fontFamily,
              letterSpacingPt: thTypo.letterSpacing,
            }),
          }),
        ],
      }),
    ];

    if (layout.showDiscountColumn) {
      headerCells.push(
        new TableCell({
          width: { size: 11, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.CLEAR, fill: '0F172A' },
          margins: { top: 90, bottom: 90, left: 80, right: 80 },
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              spacing: { line: thTypo.lineTwips },
              children: makeTextRuns(formatLabelText('discount', layout.language), {
                bold: thTypo.bold,
                size: thTypo.halfPt,
                color: 'FFFFFF',
                fontFamily: thTypo.fontFamily,
                letterSpacingPt: thTypo.letterSpacing,
              }),
            }),
          ],
        })
      );
    }

    if (layout.showTaxColumn) {
      headerCells.push(
        new TableCell({
          width: { size: 11, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.CLEAR, fill: '0F172A' },
          margins: { top: 90, bottom: 90, left: 80, right: 80 },
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              spacing: { line: thTypo.lineTwips },
              children: makeTextRuns(formatLabelText('tax', layout.language), {
                bold: thTypo.bold,
                size: thTypo.halfPt,
                color: 'FFFFFF',
                fontFamily: thTypo.fontFamily,
                letterSpacingPt: thTypo.letterSpacing,
              }),
            }),
          ],
        })
      );
    }

    headerCells.push(
      new TableCell({
        width: { size: 15, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.CLEAR, fill: '0F172A' },
        margins: { top: 90, bottom: 90, left: 80, right: 80 },
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { line: thTypo.lineTwips },
            children: makeTextRuns(formatLabelText('amount', layout.language), {
              bold: thTypo.bold,
              size: thTypo.halfPt,
              color: 'FFFFFF',
              fontFamily: thTypo.fontFamily,
              letterSpacingPt: thTypo.letterSpacing,
            }),
          }),
        ],
      })
    );

    const dataRows = docPayload.data.lines.map((line, idx) => {
      const fill = idx % 2 === 1 ? 'F8FAFC' : 'FFFFFF';
      const rowCells: TableCell[] = [
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 80, right: 80 },
          children: [
            new Paragraph({
              children: makeTextRuns(String(line.lineNumber || idx + 1), {
                size: 18,
                color: '64748B',
              }),
            }),
          ],
        }),
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 80, right: 80 },
          children: [
            new Paragraph({
              children: makeTextRuns(line.itemDescription, { size: 18, color: '0F172A' }),
            }),
          ],
        }),
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 80, right: 80 },
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: makeTextRuns(Number(line.quantity).toFixed(2), { size: 18 }),
            }),
          ],
        }),
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 80, right: 80 },
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: makeTextRuns(fmt(line.unitPrice), { size: 18 }),
            }),
          ],
        }),
      ];

      if (layout.showDiscountColumn) {
        rowCells.push(
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill },
            margins: { top: 80, bottom: 80, left: 80, right: 80 },
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: makeTextRuns(fmt(line.discountAmount), { size: 18 }),
              }),
            ],
          })
        );
      }

      if (layout.showTaxColumn) {
        const taxLabel =
          layout.serviceLayout === 'detailed'
            ? `${fmt(line.taxAmount)} (${Number(line.taxRate).toFixed(1)}%)`
            : fmt(line.taxAmount);
        rowCells.push(
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill },
            margins: { top: 80, bottom: 80, left: 80, right: 80 },
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: makeTextRuns(taxLabel, { size: 18 }),
              }),
            ],
          })
        );
      }

      rowCells.push(
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 80, right: 80 },
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: makeTextRuns(fmt(line.lineTotal), { bold: true, size: 18 }),
            }),
          ],
        })
      );

      return new TableRow({ cantSplit: true, children: rowCells });
    });

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: cellBorders('CBD5E1'),
        rows: [
          ...(tableHeadingsVisible
            ? [new TableRow({ tableHeader: true, cantSplit: true, children: headerCells })]
            : []),
          ...dataRows,
        ],
      })
    );
  } else {
    // Receipt Amount Banner
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: makeTextRuns(
          `${formatLabelText('amountReceived', layout.language)}: ${fmt(docPayload.data.amount)}`,
          { bold: true, size: 24, color: '0F172A' }
        ),
      })
    );
  }

  children.push(new Paragraph({ spacing: { after: 180 }, children: [] }));

  // Bank Details & Totals 2-column section
  const bankParagraphs: Paragraph[] = [];
  if (layout.showBankDetails && bankAccount) {
    bankParagraphs.push(
      new Paragraph({
        spacing: { after: 40 },
        children: makeTextRuns(formatLabelText('bankDetails', layout.language).toUpperCase(), {
          bold: true,
          size: 16,
          color: '475569',
        }),
      }),
      new Paragraph({
        spacing: { after: 30 },
        children: makeTextRuns(
          `${formatLabelText('bankName', layout.language)}: ${bankAccount.bankName}${
            bankAccount.branchName ? ` (${bankAccount.branchName})` : ''
          }`,
          { size: 18 }
        ),
      }),
      new Paragraph({
        spacing: { after: 30 },
        children: makeTextRuns(
          `${formatLabelText('accountHolder', layout.language)}: ${bankAccount.accountHolderName}`,
          { size: 18 }
        ),
      }),
      new Paragraph({
        spacing: { after: 30 },
        children: makeTextRuns(
          `${formatLabelText('accountNumber', layout.language)}: ${bankAccount.accountNumber}`,
          { size: 18 }
        ),
      })
    );
    if (bankAccount.routingCode) {
      bankParagraphs.push(
        new Paragraph({
          spacing: { after: 30 },
          children: makeTextRuns(
            `${formatLabelText('routingIfsc', layout.language)}: ${bankAccount.routingCode}`,
            { size: 18 }
          ),
        })
      );
    }
    if (bankAccount.upiId) {
      bankParagraphs.push(
        new Paragraph({
          children: makeTextRuns(
            `${formatLabelText('upiId', layout.language)}: ${bankAccount.upiId}`,
            { size: 18 }
          ),
        })
      );
    }
  } else {
    bankParagraphs.push(new Paragraph({ children: [] }));
  }

  const totalsTypo = typoFor('financialTotals');
  const totalsVisible = layout.showTotalsSummary && (!useVisual || visualElements.financialTotals.visible);
  const totalsAlign = useVisual ? totalsTypo.docxAlign : AlignmentType.RIGHT;

  const totalParagraphs: Paragraph[] = [];
  if (totalsVisible) {
    if (docPayload.type !== 'RECEIPT') {
      totalParagraphs.push(
        new Paragraph({
          alignment: totalsAlign,
          spacing: { after: 40, line: totalsTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('subtotal', layout.language)}: ${fmt(docPayload.data.subtotal)}`,
            {
              size: totalsTypo.halfPt,
              color: '475569',
              fontFamily: totalsTypo.fontFamily,
              letterSpacingPt: totalsTypo.letterSpacing,
            }
          ),
        }),
        new Paragraph({
          alignment: totalsAlign,
          spacing: { after: 40, line: totalsTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('totalDiscount', layout.language)}: -${fmt(docPayload.data.discountTotal)}`,
            {
              size: totalsTypo.halfPt,
              color: '475569',
              fontFamily: totalsTypo.fontFamily,
              letterSpacingPt: totalsTypo.letterSpacing,
            }
          ),
        })
      );
      if (layout.showTaxBreakdown) {
        totalParagraphs.push(
          new Paragraph({
            alignment: totalsAlign,
            spacing: { after: 40, line: totalsTypo.lineTwips },
            children: makeTextRuns(
              `${formatLabelText('totalTax', layout.language)}: ${fmt(docPayload.data.taxTotal)}`,
              {
                size: totalsTypo.halfPt,
                color: '475569',
                fontFamily: totalsTypo.fontFamily,
                letterSpacingPt: totalsTypo.letterSpacing,
              }
            ),
          })
        );
      }
      totalParagraphs.push(
        new Paragraph({
          alignment: totalsAlign,
          spacing: { before: 40, after: 40, line: totalsTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('grandTotal', layout.language)}: ${fmt(docPayload.data.total)}`,
            {
              bold: true,
              size: totalsTypo.halfPt + 3,
              color: '0F172A',
              fontFamily: totalsTypo.fontFamily,
              letterSpacingPt: totalsTypo.letterSpacing,
            }
          ),
        })
      );
      if (docPayload.type === 'INVOICE') {
        totalParagraphs.push(
          new Paragraph({
            alignment: totalsAlign,
            spacing: { after: 30, line: totalsTypo.lineTwips },
            children: makeTextRuns(
              `${formatLabelText('amountPaid', layout.language)}: ${fmt(docPayload.data.amountPaid)}`,
              {
                size: totalsTypo.halfPt,
                color: '475569',
                fontFamily: totalsTypo.fontFamily,
                letterSpacingPt: totalsTypo.letterSpacing,
              }
            ),
          }),
          new Paragraph({
            alignment: totalsAlign,
            spacing: { line: totalsTypo.lineTwips },
            children: makeTextRuns(
              `${formatLabelText('balanceDue', layout.language)}: ${fmt(docPayload.data.balanceDue)}`,
              {
                bold: true,
                size: totalsTypo.halfPt + 2,
                color: '0F172A',
                fontFamily: totalsTypo.fontFamily,
                letterSpacingPt: totalsTypo.letterSpacing,
              }
            ),
          })
        );
      }
    } else {
      totalParagraphs.push(
        new Paragraph({
          alignment: totalsAlign,
          spacing: { after: 40, line: totalsTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('amountReceived', layout.language)}: ${fmt(docPayload.data.amount)}`,
            {
              bold: true,
              size: totalsTypo.halfPt + 2,
              fontFamily: totalsTypo.fontFamily,
              letterSpacingPt: totalsTypo.letterSpacing,
            }
          ),
        }),
        new Paragraph({
          alignment: totalsAlign,
          spacing: { after: 40, line: totalsTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('allocatedTotal', layout.language)}: ${fmt(docPayload.data.allocatedTotal)}`,
            {
              size: totalsTypo.halfPt,
              fontFamily: totalsTypo.fontFamily,
              letterSpacingPt: totalsTypo.letterSpacing,
            }
          ),
        }),
        new Paragraph({
          alignment: totalsAlign,
          spacing: { line: totalsTypo.lineTwips },
          children: makeTextRuns(
            `${formatLabelText('unallocatedCredit', layout.language)}: ${fmt(docPayload.data.unallocatedAmount)}`,
            {
              size: totalsTypo.halfPt,
              fontFamily: totalsTypo.fontFamily,
              letterSpacingPt: totalsTypo.letterSpacing,
            }
          ),
        })
      );
    }
  } else {
    totalParagraphs.push(new Paragraph({ children: [] }));
  }

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: noBorders(),
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 54, type: WidthType.PERCENTAGE },
              borders: layout.showBankDetails && bankAccount ? cellBorders('E2E8F0') : noBorders(),
              shading:
                layout.showBankDetails && bankAccount
                  ? { type: ShadingType.CLEAR, fill: 'F8FAFC' }
                  : undefined,
              margins: { top: 100, bottom: 100, left: 120, right: 120 },
              children: bankParagraphs,
            }),
            new TableCell({
              width: { size: 46, type: WidthType.PERCENTAGE },
              borders: totalsVisible ? cellBorders('CBD5E1') : noBorders(),
              margins: { top: 100, bottom: 100, left: 120, right: 120 },
              children: totalParagraphs,
            }),
          ],
        }),
      ],
    })
  );

  // Notes & Terms
  const notesText = docPayload.data.notes;
  const termsText =
    (docPayload.type !== 'RECEIPT' ? docPayload.data.terms : null) || layout.defaultTermsText;
  const termsTypo = typoFor('termsAndConditions');
  const termsVisible =
    layout.showTermsAndConditions &&
    Boolean(termsText) &&
    (!useVisual || visualElements.termsAndConditions.visible);

  if (notesText) {
    children.push(
      new Paragraph({
        alignment: termsTypo.docxAlign,
        spacing: { before: 160, after: 40, line: termsTypo.lineTwips },
        children: makeTextRuns(formatLabelText('notes', layout.language).toUpperCase(), {
          bold: true,
          size: Math.max(14, termsTypo.halfPt - 1),
          color: '64748B',
          fontFamily: termsTypo.fontFamily,
        }),
      }),
      new Paragraph({
        alignment: termsTypo.docxAlign,
        spacing: { after: 80, line: termsTypo.lineTwips },
        children: makeTextRuns(notesText, {
          bold: termsTypo.bold,
          size: termsTypo.halfPt,
          color: '334155',
          fontFamily: termsTypo.fontFamily,
          letterSpacingPt: termsTypo.letterSpacing,
        }),
      })
    );
  }

  if (termsVisible && termsText) {
    children.push(
      new Paragraph({
        alignment: termsTypo.docxAlign,
        spacing: { before: 100, after: 40, line: termsTypo.lineTwips },
        children: makeTextRuns(
          formatLabelText('termsAndConditions', layout.language).toUpperCase(),
          {
            bold: true,
            size: Math.max(14, termsTypo.halfPt - 1),
            color: '64748B',
            fontFamily: termsTypo.fontFamily,
          }
        ),
      }),
      new Paragraph({
        alignment: termsTypo.docxAlign,
        spacing: { after: 120, line: termsTypo.lineTwips },
        children: makeTextRuns(termsText, {
          bold: termsTypo.bold,
          size: termsTypo.halfPt,
          color: '334155',
          fontFamily: termsTypo.fontFamily,
          letterSpacingPt: termsTypo.letterSpacing,
        }),
      })
    );
  }

  // Signature & Seal Section
  if (layout.showSignatureSection) {
    const signatoryName =
      layout.signatoryName ||
      companyProfile?.documentBranding?.signatoryName ||
      layout.signatureLabel ||
      formatLabelText('authorizedSignature', layout.language);
    const signatoryTitle =
      layout.signatoryTitle || companyProfile?.documentBranding?.signatureTitle || '';

    const sealVisual = visualElements.seal;
    const sigVisual = visualElements.signature;
    const sigLabelsVisual = visualElements.signatoryLabels;
    const sigLabelsTypo = typoFor('signatoryLabels');

    const sealVisible = !useVisual || sealVisual.visible;
    const sigVisible = !useVisual || sigVisual.visible;
    const sigLabelsVisible = !useVisual || sigLabelsVisual.visible;

    const sealImgRun = sealVisible
      ? createRasterImageRun(
          brandingImages?.seal,
          sealVisual.widthMm,
          sealVisual.heightMm,
          'Company Seal'
        )
      : null;
    const sigImgRun = sigVisible
      ? createRasterImageRun(
          brandingImages?.signature,
          sigVisual.widthMm,
          sigVisual.heightMm,
          'Authorized Signature'
        )
      : null;

    const sigAlign = toDocxAlignment(sigVisual.align || 'right');
    const sigLabelAlign = useVisual ? sigLabelsTypo.docxAlign : sigAlign;
    const sealAlign = toDocxAlignment(sealVisual.align || 'center');

    const showQr = shouldDisplayPaymentQr({
      document: docPayload,
      layout,
      qrSource: brandingImages?.paymentQr,
      includePaymentQrOverride: includePaymentQr,
    });
    const qrSizeMm = resolvePaymentQrDisplaySizeMm(layout.paymentQrSize);
    const qrLabel = (layout.paymentQrLabel || 'Scan to Pay').trim() || 'Scan to Pay';
    const qrPosition = layout.paymentQrPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right';
    const qrImgRun = showQr
      ? createRasterImageRun(brandingImages?.paymentQr, qrSizeMm, qrSizeMm, qrLabel)
      : null;

    const buildQrParagraphs = (align: (typeof AlignmentType)[keyof typeof AlignmentType]) =>
      qrImgRun
        ? [
            new Paragraph({
              alignment: align,
              spacing: { before: 40, after: 40 },
              children: [qrImgRun],
            }),
            new Paragraph({
              alignment: align,
              spacing: { after: 40 },
              children: makeTextRuns(qrLabel, {
                bold: true,
                size: 16,
                color: '334155',
              }),
            }),
          ]
        : [];

    if (qrImgRun && qrPosition === 'bottom-right') {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: noBorders(),
          rows: [
            new TableRow({
              cantSplit: true,
              children: [
                new TableCell({
                  width: { size: 62, type: WidthType.PERCENTAGE },
                  borders: noBorders(),
                  children: [new Paragraph({ children: [] })],
                }),
                new TableCell({
                  width: { size: 38, type: WidthType.PERCENTAGE },
                  borders: {
                    top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                    bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                    left: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                    right: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                  },
                  margins: { top: 80, bottom: 80, left: 100, right: 100 },
                  children: buildQrParagraphs(AlignmentType.CENTER),
                }),
              ],
            }),
          ],
        })
      );
    }

    const embedQrOnLeft = Boolean(qrImgRun && qrPosition === 'bottom-left');

    if (sealImgRun || sigImgRun || embedQrOnLeft) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: noBorders(),
          rows: [
            new TableRow({
              cantSplit: true,
              children: [
                new TableCell({
                  width: { size: 50, type: WidthType.PERCENTAGE },
                  borders: noBorders(),
                  margins: embedQrOnLeft ? { top: 80, bottom: 40, right: 120 } : undefined,
                  children: embedQrOnLeft
                    ? buildQrParagraphs(AlignmentType.LEFT)
                    : [new Paragraph({ children: [] })],
                }),
                new TableCell({
                  width: { size: 22, type: WidthType.PERCENTAGE },
                  borders: noBorders(),
                  margins: { top: 100, bottom: 40, right: 80 },
                  children: sealImgRun
                    ? [
                        new Paragraph({
                          alignment: sealAlign,
                          children: [sealImgRun],
                        }),
                      ]
                    : [new Paragraph({ children: [] })],
                }),
                new TableCell({
                  width: { size: 28, type: WidthType.PERCENTAGE },
                  borders: noBorders(),
                  margins: { top: 100, bottom: 40 },
                  children:
                    sigVisible || sigLabelsVisible
                      ? [
                          ...(sigImgRun
                            ? [
                                new Paragraph({
                                  alignment: sigAlign,
                                  spacing: { after: 30 },
                                  children: [sigImgRun],
                                }),
                              ]
                            : [
                                new Paragraph({
                                  alignment: sigAlign,
                                  spacing: { before: 120, after: 30 },
                                  children: [],
                                }),
                              ]),
                          ...(sigLabelsVisible
                            ? [
                                new Paragraph({
                                  alignment: sigLabelAlign,
                                  spacing: { after: 30, line: sigLabelsTypo.lineTwips },
                                  children: makeTextRuns('__________________________', {
                                    size: sigLabelsTypo.halfPt,
                                    color: '64748B',
                                    fontFamily: sigLabelsTypo.fontFamily,
                                  }),
                                }),
                                new Paragraph({
                                  alignment: sigLabelAlign,
                                  spacing: { after: 20, line: sigLabelsTypo.lineTwips },
                                  children: makeTextRuns(signatoryName, {
                                    bold: sigLabelsTypo.bold,
                                    size: sigLabelsTypo.halfPt,
                                    color: '0F172A',
                                    fontFamily: sigLabelsTypo.fontFamily,
                                    letterSpacingPt: sigLabelsTypo.letterSpacing,
                                  }),
                                }),
                                ...(signatoryTitle
                                  ? [
                                      new Paragraph({
                                        alignment: sigLabelAlign,
                                        spacing: { line: sigLabelsTypo.lineTwips },
                                        children: makeTextRuns(signatoryTitle, {
                                          size: Math.max(13, sigLabelsTypo.halfPt - 2),
                                          color: '64748B',
                                          fontFamily: sigLabelsTypo.fontFamily,
                                        }),
                                      }),
                                    ]
                                  : []),
                              ]
                            : []),
                        ]
                      : [new Paragraph({ children: [] })],
                }),
              ],
            }),
          ],
        })
      );
    } else if (sigLabelsVisible) {
      children.push(
        new Paragraph({
          alignment: sigLabelAlign,
          spacing: { before: 240, after: 40, line: sigLabelsTypo.lineTwips },
          children: makeTextRuns(`__________________________`, {
            size: sigLabelsTypo.halfPt,
            color: '64748B',
            fontFamily: sigLabelsTypo.fontFamily,
          }),
        }),
        new Paragraph({
          alignment: sigLabelAlign,
          spacing: { after: 20, line: sigLabelsTypo.lineTwips },
          children: makeTextRuns(signatoryName, {
            bold: sigLabelsTypo.bold,
            size: sigLabelsTypo.halfPt,
            color: '0F172A',
            fontFamily: sigLabelsTypo.fontFamily,
            letterSpacingPt: sigLabelsTypo.letterSpacing,
          }),
        })
      );
      if (signatoryTitle) {
        children.push(
          new Paragraph({
            alignment: sigLabelAlign,
            spacing: { after: 80, line: sigLabelsTypo.lineTwips },
            children: makeTextRuns(signatoryTitle, {
              size: Math.max(13, sigLabelsTypo.halfPt - 2),
              color: '64748B',
              fontFamily: sigLabelsTypo.fontFamily,
            }),
          })
        );
      }
    }
  } else {
    // Signature section hidden — still render Payment QR if explicitly enabled and available
    const showQrOnly = shouldDisplayPaymentQr({
      document: docPayload,
      layout,
      qrSource: brandingImages?.paymentQr,
      includePaymentQrOverride: includePaymentQr,
    });
    if (showQrOnly) {
      const qrSizeMm = resolvePaymentQrDisplaySizeMm(layout.paymentQrSize);
      const qrLabel = (layout.paymentQrLabel || 'Scan to Pay').trim() || 'Scan to Pay';
      const qrPosition = layout.paymentQrPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right';
      const qrImgRun = createRasterImageRun(
        brandingImages?.paymentQr,
        qrSizeMm,
        qrSizeMm,
        qrLabel
      );
      if (qrImgRun) {
        const align =
          qrPosition === 'bottom-left' ? AlignmentType.LEFT : AlignmentType.RIGHT;
        children.push(
          new Paragraph({
            alignment: align,
            spacing: { before: 120, after: 40 },
            children: [qrImgRun],
          }),
          new Paragraph({
            alignment: align,
            spacing: { after: 60 },
            children: makeTextRuns(qrLabel, {
              bold: true,
              size: 16,
              color: '334155',
            }),
          })
        );
      }
    }
  }

  // Footer & Timestamp
  const footerTypo = typoFor('footer');
  const footerVisible = !useVisual || visualElements.footer.visible;
  if (footerVisible && (layout.footerText || layout.showPrintedTimestamp)) {
    const footerParts = [
      layout.footerText || '',
      layout.showPrintedTimestamp
        ? `${formatLabelText('generatedOn', layout.language)}: ${printedAtLabel} (${timezone})`
        : '',
    ].filter(Boolean);
    children.push(
      new Paragraph({
        alignment: footerTypo.docxAlign,
        spacing: { before: 180, line: footerTypo.lineTwips },
        children: makeTextRuns(footerParts.join('  |  '), {
          bold: footerTypo.bold,
          size: footerTypo.halfPt,
          color: '64748B',
          fontFamily: footerTypo.fontFamily,
          letterSpacingPt: footerTypo.letterSpacing,
        }),
      })
    );
  }

  return new Document({
    creator: companyName,
    title: `${resolvedTitle} - ${docNumber || 'Draft Preview'}`,
    sections: [
      {
        properties: {
          page: {
            size: {
              width: mmToTwips(pageWidthMm),
              height: mmToTwips(pageHeightMm),
              orientation: isLandscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
            margin: {
              top: mmToTwips(layout.margins.topMm),
              right: mmToTwips(layout.margins.rightMm),
              bottom: mmToTwips(layout.margins.bottomMm),
              left: mmToTwips(layout.margins.leftMm),
            },
          },
        },
        children,
      },
    ],
  });
}

export async function generateDocxBuffer(context: DocumentExportContext): Promise<Buffer> {
  const doc = createWordDocument(context);
  return Packer.toBuffer(doc);
}

export async function generateDocxBlob(context: DocumentExportContext): Promise<Blob> {
  const doc = createWordDocument(context);
  return Packer.toBlob(doc);
}
