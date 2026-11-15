import {
  AlignmentType,
  BorderStyle,
  Document,
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
} from '../types.ts';
import { createDefaultPrintSettings, PAPER_DIMENSIONS_MM } from '../print-settings.ts';
import { DocumentPrintLabelKey, getDocumentLabel } from '../print-translations.ts';
import { formatMoney, normalizeCurrencyCode } from '../currency.ts';
import { formatDateTimeInTimezone, getEffectiveTimeZone } from '../timezone.ts';

export type ExportableDocumentPayload =
  | { type: 'QUOTATION'; data: QuotationItem }
  | { type: 'INVOICE'; data: InvoiceItem }
  | { type: 'RECEIPT'; data: CustomerReceiptItem };

export interface DocumentExportContext {
  document: ExportableDocumentPayload;
  companyProfile?: CompanyProfile | null;
  layoutOverride?: DocumentPrintLayoutConfig;
  bankAccount?: CompanyBankAccountItem | null;
  isDraftPreview?: boolean;
}

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

function makeTextRuns(
  text: string,
  options?: {
    bold?: boolean;
    size?: number; // half-points (20 = 10pt)
    color?: string;
    italics?: boolean;
  }
): TextRun[] {
  const segments = text.split(/([\u0C80-\u0CFF\s]+)/).filter(Boolean);
  if (segments.length === 0) {
    return [new TextRun({ text: '', ...options })];
  }
  return segments.map((seg) => {
    const isKn = hasKannada(seg);
    return new TextRun({
      text: seg,
      font: isKn ? FONT_KANNADA : FONT_LATIN,
      bold: options?.bold,
      size: options?.size ?? 20,
      color: options?.color ?? '0F172A',
      italics: options?.italics,
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

export function resolveEffectivePrintLayout(
  docType: DocumentPrintType,
  companyProfile?: CompanyProfile | null,
  layoutOverride?: DocumentPrintLayoutConfig
): DocumentPrintLayoutConfig {
  if (layoutOverride) return layoutOverride;
  const saved = companyProfile?.printSettings?.layouts?.[docType];
  if (saved) return saved;
  return createDefaultPrintSettings(companyProfile || undefined).layouts[docType];
}

export function buildExportFileName(
  doc: ExportableDocumentPayload,
  extension: 'pdf' | 'docx',
  isDraftPreview?: boolean
): string {
  const rawNumber =
    doc.type === 'QUOTATION'
      ? doc.data.quotationNumber
      : doc.type === 'INVOICE'
      ? doc.data.invoiceNumber
      : doc.data.receiptNumber;
  const fallback =
    doc.type === 'QUOTATION' ? 'Quotation' : doc.type === 'INVOICE' ? 'Invoice' : 'Receipt';
  const safeBase = (rawNumber || fallback)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = isDraftPreview ? '-DRAFT-PREVIEW' : '';
  return `${safeBase || fallback}${suffix}.${extension}`;
}

export function createWordDocument(context: DocumentExportContext): Document {
  const { document: docPayload, companyProfile, layoutOverride, bankAccount, isDraftPreview } =
    context;
  const docType = docPayload.type;
  const layout = resolveEffectivePrintLayout(docType, companyProfile, layoutOverride);

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

  // Optional header text
  if (layout.headerText || isDraftPreview) {
    const parts = [
      layout.headerText,
      isDraftPreview ? 'DRAFT PREVIEW' : null,
      getDocumentLabel('originalForRecipient', layout.language).primary,
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
  if (layout.showCompanyName) {
    companyLines.push(
      new Paragraph({
        spacing: { after: 40 },
        children: makeTextRuns(companyName, { bold: true, size: 28, color: '0F172A' }),
      })
    );
    if (companyProfile?.legalName && companyProfile.legalName !== companyName) {
      companyLines.push(
        new Paragraph({
          spacing: { after: 30 },
          children: makeTextRuns(companyProfile.legalName, { size: 18, color: '475569' }),
        })
      );
    }
  }
  if (layout.showCompanyContact) {
    if (companyProfile?.address) {
      companyLines.push(
        new Paragraph({
          spacing: { after: 20 },
          children: makeTextRuns(companyProfile.address, { size: 18, color: '475569' }),
        })
      );
    }
    const contactParts = [
      companyProfile?.phone,
      companyProfile?.email,
      companyProfile?.website,
    ].filter(Boolean);
    if (contactParts.length > 0) {
      companyLines.push(
        new Paragraph({
          spacing: { after: 20 },
          children: makeTextRuns(contactParts.join('  •  '), { size: 18, color: '475569' }),
        })
      );
    }
  }
  if (layout.showCompanyTaxId && companyProfile?.taxId) {
    companyLines.push(
      new Paragraph({
        spacing: { after: 20 },
        children: makeTextRuns(
          `${formatLabelText('taxId', layout.language)}: ${companyProfile.taxId}`,
          { bold: true, size: 18, color: '334155' }
        ),
      })
    );
  }
  if (companyLines.length === 0) {
    companyLines.push(new Paragraph({ children: [] }));
  }

  const titleCellParagraphs: Paragraph[] = [
    new Paragraph({
      alignment:
        layout.titlePlacement === 'left'
          ? AlignmentType.LEFT
          : layout.titlePlacement === 'center'
          ? AlignmentType.CENTER
          : AlignmentType.RIGHT,
      spacing: { after: 60 },
      children: makeTextRuns(resolvedTitle.toUpperCase(), {
        bold: true,
        size: 30,
        color: '0F172A',
      }),
    }),
    new Paragraph({
      alignment:
        layout.titlePlacement === 'left'
          ? AlignmentType.LEFT
          : layout.titlePlacement === 'center'
          ? AlignmentType.CENTER
          : AlignmentType.RIGHT,
      children: makeTextRuns(
        `${formatLabelText(docNumberLabelKey, layout.language)}: ${docNumber || 'DRAFT PREVIEW'}`,
        { bold: true, size: 20, color: '1E293B' }
      ),
    }),
  ];

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

  const partyParagraphs: Paragraph[] = [
    new Paragraph({
      spacing: { after: 40 },
      children: makeTextRuns(formatLabelText(partyLabelKey, layout.language).toUpperCase(), {
        bold: true,
        size: 16,
        color: '64748B',
      }),
    }),
    new Paragraph({
      spacing: { after: 40 },
      children: makeTextRuns(docPayload.data.customerName, {
        bold: true,
        size: 22,
        color: '0F172A',
      }),
    }),
  ];

  if (docPayload.type !== 'RECEIPT') {
    if (layout.showCustomerAddress && docPayload.data.customerAddress) {
      partyParagraphs.push(
        new Paragraph({
          spacing: { after: 30 },
          children: makeTextRuns(docPayload.data.customerAddress, { size: 18, color: '475569' }),
        })
      );
    }
    if (
      layout.showCustomerContact &&
      (docPayload.data.customerEmail || docPayload.data.customerPhone)
    ) {
      partyParagraphs.push(
        new Paragraph({
          spacing: { after: 30 },
          children: makeTextRuns(
            [docPayload.data.customerEmail, docPayload.data.customerPhone]
              .filter(Boolean)
              .join('  •  '),
            { size: 18, color: '475569' }
          ),
        })
      );
    }
    if (layout.showCustomerTaxId && docPayload.data.customerTaxId) {
      partyParagraphs.push(
        new Paragraph({
          spacing: { after: 20 },
          children: makeTextRuns(
            `${formatLabelText('taxId', layout.language)}: ${docPayload.data.customerTaxId}`,
            { size: 18, color: '334155' }
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
  metaParagraphs.push(
    new Paragraph({
      spacing: { after: 40 },
      children: makeTextRuns(`${formatLabelText('date', layout.language)}: ${docDate}`, {
        size: 18,
      }),
    })
  );

  if (docPayload.type === 'QUOTATION') {
    metaParagraphs.push(
      new Paragraph({
        spacing: { after: 40 },
        children: makeTextRuns(
          `${formatLabelText('validUntil', layout.language)}: ${docPayload.data.validUntilDate}`,
          { size: 18 }
        ),
      })
    );
  } else if (docPayload.type === 'INVOICE') {
    metaParagraphs.push(
      new Paragraph({
        spacing: { after: 40 },
        children: makeTextRuns(
          `${formatLabelText('dueDate', layout.language)}: ${docPayload.data.dueDate}`,
          { size: 18 }
        ),
      })
    );
  } else {
    metaParagraphs.push(
      new Paragraph({
        spacing: { after: 40 },
        children: makeTextRuns(
          `${formatLabelText('paymentMethod', layout.language)}: ${docPayload.data.paymentMethod.replace(/_/g, ' ')}`,
          { size: 18 }
        ),
      })
    );
  }

  metaParagraphs.push(
    new Paragraph({
      spacing: { after: 40 },
      children: makeTextRuns(`${formatLabelText('currency', layout.language)}: ${documentCurrency}`, {
        size: 18,
      }),
    }),
    new Paragraph({
      children: makeTextRuns(
        `${formatLabelText('status', layout.language)}: ${docPayload.data.status}`,
        { bold: true, size: 18 }
      ),
    })
  );

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
  if (docPayload.type !== 'RECEIPT') {
    const headerCells: TableCell[] = [
      new TableCell({
        width: { size: 7, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.CLEAR, fill: '0F172A' },
        margins: { top: 90, bottom: 90, left: 80, right: 80 },
        children: [
          new Paragraph({
            children: makeTextRuns(formatLabelText('serialNo', layout.language), {
              bold: true,
              size: 17,
              color: 'FFFFFF',
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
            children: makeTextRuns(formatLabelText('serviceDescription', layout.language), {
              bold: true,
              size: 17,
              color: 'FFFFFF',
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
            children: makeTextRuns(formatLabelText('qtyHours', layout.language), {
              bold: true,
              size: 17,
              color: 'FFFFFF',
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
            children: makeTextRuns(formatLabelText('rate', layout.language), {
              bold: true,
              size: 17,
              color: 'FFFFFF',
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
              children: makeTextRuns(formatLabelText('discount', layout.language), {
                bold: true,
                size: 17,
                color: 'FFFFFF',
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
              children: makeTextRuns(formatLabelText('tax', layout.language), {
                bold: true,
                size: 17,
                color: 'FFFFFF',
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
            children: makeTextRuns(formatLabelText('amount', layout.language), {
              bold: true,
              size: 17,
              color: 'FFFFFF',
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

      return new TableRow({ children: rowCells });
    });

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: cellBorders('CBD5E1'),
        rows: [new TableRow({ children: headerCells }), ...dataRows],
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

  const totalParagraphs: Paragraph[] = [];
  if (layout.showTotalsSummary) {
    if (docPayload.type !== 'RECEIPT') {
      totalParagraphs.push(
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { after: 40 },
          children: makeTextRuns(
            `${formatLabelText('subtotal', layout.language)}: ${fmt(docPayload.data.subtotal)}`,
            { size: 19, color: '475569' }
          ),
        }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { after: 40 },
          children: makeTextRuns(
            `${formatLabelText('totalDiscount', layout.language)}: -${fmt(docPayload.data.discountTotal)}`,
            { size: 19, color: '475569' }
          ),
        })
      );
      if (layout.showTaxBreakdown) {
        totalParagraphs.push(
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { after: 40 },
            children: makeTextRuns(
              `${formatLabelText('totalTax', layout.language)}: ${fmt(docPayload.data.taxTotal)}`,
              { size: 19, color: '475569' }
            ),
          })
        );
      }
      totalParagraphs.push(
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { before: 40, after: 40 },
          children: makeTextRuns(
            `${formatLabelText('grandTotal', layout.language)}: ${fmt(docPayload.data.total)}`,
            { bold: true, size: 22, color: '0F172A' }
          ),
        })
      );
      if (docPayload.type === 'INVOICE') {
        totalParagraphs.push(
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { after: 30 },
            children: makeTextRuns(
              `${formatLabelText('amountPaid', layout.language)}: ${fmt(docPayload.data.amountPaid)}`,
              { size: 18, color: '475569' }
            ),
          }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: makeTextRuns(
              `${formatLabelText('balanceDue', layout.language)}: ${fmt(docPayload.data.balanceDue)}`,
              { bold: true, size: 20, color: '0F172A' }
            ),
          })
        );
      }
    } else {
      totalParagraphs.push(
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { after: 40 },
          children: makeTextRuns(
            `${formatLabelText('amountReceived', layout.language)}: ${fmt(docPayload.data.amount)}`,
            { bold: true, size: 20 }
          ),
        }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { after: 40 },
          children: makeTextRuns(
            `${formatLabelText('allocatedTotal', layout.language)}: ${fmt(docPayload.data.allocatedTotal)}`,
            { size: 18 }
          ),
        }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: makeTextRuns(
            `${formatLabelText('unallocatedCredit', layout.language)}: ${fmt(docPayload.data.unallocatedAmount)}`,
            { size: 18 }
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
              borders: layout.showTotalsSummary ? cellBorders('CBD5E1') : noBorders(),
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

  if (notesText) {
    children.push(
      new Paragraph({
        spacing: { before: 180, after: 40 },
        children: makeTextRuns(formatLabelText('notes', layout.language).toUpperCase(), {
          bold: true,
          size: 17,
          color: '64748B',
        }),
      }),
      new Paragraph({
        spacing: { after: 100 },
        children: makeTextRuns(notesText, { size: 18, color: '334155' }),
      })
    );
  }

  if (layout.showTermsAndConditions && termsText) {
    children.push(
      new Paragraph({
        spacing: { before: 120, after: 40 },
        children: makeTextRuns(
          formatLabelText('termsAndConditions', layout.language).toUpperCase(),
          { bold: true, size: 17, color: '64748B' }
        ),
      }),
      new Paragraph({
        spacing: { after: 140 },
        children: makeTextRuns(termsText, { size: 18, color: '334155' }),
      })
    );
  }

  // Signature Section
  if (layout.showSignatureSection) {
    const signatoryName =
      layout.signatoryName ||
      companyProfile?.documentBranding?.signatoryName ||
      layout.signatureLabel ||
      formatLabelText('authorizedSignature', layout.language);
    const signatoryTitle =
      layout.signatoryTitle || companyProfile?.documentBranding?.signatureTitle || '';

    children.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { before: 280, after: 40 },
        children: makeTextRuns(`__________________________`, { size: 18, color: '64748B' }),
      }),
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { after: 20 },
        children: makeTextRuns(signatoryName, { bold: true, size: 19, color: '0F172A' }),
      })
    );
    if (signatoryTitle) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { after: 80 },
          children: makeTextRuns(signatoryTitle, { size: 17, color: '64748B' }),
        })
      );
    }
  }

  // Footer & Timestamp
  if (layout.footerText || layout.showPrintedTimestamp) {
    const footerParts = [
      layout.footerText || '',
      layout.showPrintedTimestamp
        ? `${formatLabelText('generatedOn', layout.language)}: ${printedAtLabel} (${timezone})`
        : '',
    ].filter(Boolean);
    children.push(
      new Paragraph({
        spacing: { before: 200 },
        children: makeTextRuns(footerParts.join('  |  '), { size: 16, color: '64748B' }),
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
