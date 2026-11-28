/**
 * Zero-dependency pure-TypeScript OOXML SpreadsheetML (.xlsx) exporter.
 * Produces structured spreadsheet workbooks with real numeric cells using exact stored
 * CoreERP document figures (never recalculating accounting, tax, or payment values).
 */

import { normalizeDocumentVisualElements } from '../branding.ts';
import { normalizeCurrencyCode } from '../currency.ts';
import {
  DocumentExportContext,
  formatCompanyAddressLines,
  formatCopyLabelText,
  resolveCompanyContactParts,
  resolveCompanyTaxId,
  resolveDocumentEffectiveBranding,
} from './document-branding.ts';
import { createZipArchive } from './zip-writer.ts';

type CellValue =
  | { kind: 'text'; value: string; style?: number }
  | { kind: 'number'; value: number; style?: number }
  | { kind: 'empty'; style?: number };

// Style indices defined in xl/styles.xml
const STYLE_DEFAULT = 0;
const STYLE_TITLE = 1;
const STYLE_SECTION = 2;
const STYLE_TABLE_HEADER = 3;
const STYLE_LABEL_BOLD = 4;
const STYLE_NUMBER = 5;
const STYLE_NUMBER_BOLD = 6;
const STYLE_PERCENT = 7;

function escapeXml(raw: string): string {
  // Strip characters forbidden in XML 1.0 (control chars except TAB/LF/CR, plus U+FFFE/U+FFFF)
  const sanitized = String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnIndexToLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function toFiniteNumber(val: string | number | null | undefined): number {
  const n = Number(val ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function textCell(value: string | null | undefined, style = STYLE_DEFAULT): CellValue {
  return { kind: 'text', value: String(value ?? ''), style };
}

function numberCell(value: string | number | null | undefined, style = STYLE_NUMBER): CellValue {
  return { kind: 'number', value: toFiniteNumber(value), style };
}

function emptyCell(style = STYLE_DEFAULT): CellValue {
  return { kind: 'empty', style };
}

function buildWorksheetXml(rows: CellValue[][], colWidths: number[]): string {
  const colsXml = colWidths
    .map(
      (w, idx) =>
        `<col min="${idx + 1}" max="${idx + 1}" width="${w}" customWidth="1"/>`
    )
    .join('');

  const rowsXml = rows
    .map((cells, rIdx) => {
      const rowNum = rIdx + 1;
      const cellsXml = cells
        .map((cell, cIdx) => {
          const ref = `${columnIndexToLetter(cIdx)}${rowNum}`;
          const styleAttr = cell.style ? ` s="${cell.style}"` : '';
          if (cell.kind === 'empty') {
            return styleAttr ? `<c r="${ref}"${styleAttr}/>` : '';
          }
          if (cell.kind === 'number') {
            return `<c r="${ref}" t="n"${styleAttr}><v>${cell.value}</v></c>`;
          }
          // inlineStr stores literal text (immune to spreadsheet formula injection)
          return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`;
        })
        .filter(Boolean)
        .join('');
      return `<row r="${rowNum}">${cellsXml}</row>`;
    })
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cols>${colsXml}</cols>` +
    `<sheetData>${rowsXml}</sheetData>` +
    `</worksheet>`
  );
}

function buildStylesXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="2">` +
    `<numFmt numFmtId="164" formatCode="#,##0.00"/>` +
    `<numFmt numFmtId="165" formatCode="0.00&quot;%&quot;"/>` +
    `</numFmts>` +
    `<fonts count="4">` +
    `<font><sz val="10"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="14"/><color rgb="FF0F172A"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="10"/><color rgb="FF0F172A"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>` +
    `</fonts>` +
    `<fills count="4">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="2">` +
    `<border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border>` +
    `<left style="thin"><color rgb="FFCBD5E1"/></left>` +
    `<right style="thin"><color rgb="FFCBD5E1"/></right>` +
    `<top style="thin"><color rgb="FFCBD5E1"/></top>` +
    `<bottom style="thin"><color rgb="FFCBD5E1"/></bottom>` +
    `<diagonal/>` +
    `</border>` +
    `</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="8">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0"/>` +
    `<xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0"/>` +
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="164" fontId="2" fillId="2" borderId="1" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs>` +
    `</styleSheet>`
  );
}

/**
 * Generates structured spreadsheet rows for a Quotation, Invoice, or Receipt
 * directly from existing stored financial values (zero recalculation).
 */
export function buildDocumentSpreadsheetRows(context: DocumentExportContext): {
  sheetName: string;
  rows: CellValue[][];
  colWidths: number[];
} {
  const { document: docPayload, layoutOverride, bankAccount, isDraftPreview, copyLabel } = context;
  const { effectiveProfile: companyProfile, layout } = resolveDocumentEffectiveBranding(
    docPayload,
    context.companyProfile,
    layoutOverride,
    isDraftPreview
  );

  const companyName = companyProfile?.name || 'CoreERP Enterprise';
  const docCurrency = normalizeCurrencyCode(
    docPayload.data.currency || companyProfile?.currency,
    companyProfile?.currency || 'INR'
  );
  const docNumber =
    docPayload.type === 'QUOTATION'
      ? docPayload.data.quotationNumber
      : docPayload.type === 'INVOICE'
      ? docPayload.data.invoiceNumber
      : docPayload.data.receiptNumber;

  const docTypeLabel =
    docPayload.type === 'QUOTATION'
      ? 'QUOTATION'
      : docPayload.type === 'INVOICE'
      ? 'TAX INVOICE'
      : 'PAYMENT RECEIPT';

  const resolvedCopyLabel = formatCopyLabelText(copyLabel);
  const rows: CellValue[][] = [];

  // Title Row
  const titleSuffix = [
    resolvedCopyLabel,
    isDraftPreview ? 'DRAFT PREVIEW' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  rows.push([
    textCell(titleSuffix ? `${docTypeLabel} (${titleSuffix})` : docTypeLabel, STYLE_TITLE),
    emptyCell(),
    emptyCell(),
    emptyCell(),
    emptyCell(),
    emptyCell(),
    emptyCell(),
    emptyCell(),
  ]);
  rows.push([]);

  // Document & Company Details Section
  rows.push([
    textCell('Company Details', STYLE_SECTION),
    emptyCell(STYLE_SECTION),
    emptyCell(STYLE_SECTION),
    emptyCell(STYLE_SECTION),
    textCell('Document Information', STYLE_SECTION),
    emptyCell(STYLE_SECTION),
    emptyCell(STYLE_SECTION),
    emptyCell(STYLE_SECTION),
  ]);

  const useVisual = Boolean(layout.visualLayoutEnabled);
  const visualElements = normalizeDocumentVisualElements(
    layout.elements,
    layout.paperSize,
    layout.orientation,
    layout.margins
  );
  const showCompanyName = layout.showCompanyName && (!useVisual || visualElements.companyName.visible);
  const showCompanyHeader = !useVisual || visualElements.companyHeader.visible;
  const showTerms = layout.showTermsAndConditions && (!useVisual || visualElements.termsAndConditions.visible);

  const companyInfoRows: Array<[string, string]> = [];
  if (showCompanyName) {
    companyInfoRows.push(['Company Name', companyName]);
    if (companyProfile?.legalName && companyProfile.legalName !== companyName) {
      companyInfoRows.push(['Legal Name', companyProfile.legalName]);
    }
  }
  if (showCompanyHeader && layout.showCompanyContact) {
    const addrLines = formatCompanyAddressLines(companyProfile);
    if (addrLines.length > 0) {
      companyInfoRows.push(['Company Address', addrLines.join(', ')]);
    }
    const contactParts = resolveCompanyContactParts(companyProfile);
    if (contactParts.length > 0) {
      companyInfoRows.push(['Contact Details', contactParts.join(' | ')]);
    }
  }
  const taxId = resolveCompanyTaxId(companyProfile);
  if (showCompanyHeader && layout.showCompanyTaxId && taxId) {
    companyInfoRows.push(['GSTIN / Tax ID', taxId]);
  }

  const docMetaRows: Array<[string, string]> = [
    ['Document Number', docNumber || 'DRAFT PREVIEW'],
    ['Status', docPayload.data.status],
    ['Currency', docCurrency],
  ];
  if (docPayload.type === 'INVOICE') {
    docMetaRows.push(['Invoice Date', docPayload.data.invoiceDate]);
    docMetaRows.push(['Due Date', docPayload.data.dueDate]);
  } else if (docPayload.type === 'QUOTATION') {
    docMetaRows.push(['Quotation Date', docPayload.data.quotationDate]);
    docMetaRows.push(['Valid Until', docPayload.data.validUntilDate]);
  } else {
    docMetaRows.push(['Receipt Date', docPayload.data.receiptDate]);
    docMetaRows.push(['Payment Method', docPayload.data.paymentMethod.replace(/_/g, ' ')]);
    if (docPayload.data.referenceNumber) {
      docMetaRows.push(['Reference Number', docPayload.data.referenceNumber]);
    }
  }
  if (resolvedCopyLabel) {
    docMetaRows.push(['Copy Type', resolvedCopyLabel]);
  }

  const headerPairCount = Math.max(companyInfoRows.length, docMetaRows.length);
  for (let i = 0; i < headerPairCount; i++) {
    const left = companyInfoRows[i];
    const right = docMetaRows[i];
    rows.push([
      left ? textCell(left[0], STYLE_LABEL_BOLD) : emptyCell(),
      left ? textCell(left[1]) : emptyCell(),
      emptyCell(),
      emptyCell(),
      right ? textCell(right[0], STYLE_LABEL_BOLD) : emptyCell(),
      right ? textCell(right[1]) : emptyCell(),
    ]);
  }
  rows.push([]);

  // Customer Section
  rows.push([
    textCell('Customer Details', STYLE_SECTION),
    emptyCell(STYLE_SECTION),
    emptyCell(STYLE_SECTION),
    emptyCell(STYLE_SECTION),
  ]);
  rows.push([textCell('Customer Name', STYLE_LABEL_BOLD), textCell(docPayload.data.customerName)]);
  if (docPayload.type !== 'RECEIPT') {
    if (layout.showCustomerAddress && docPayload.data.customerAddress) {
      rows.push([
        textCell('Customer Address', STYLE_LABEL_BOLD),
        textCell(docPayload.data.customerAddress),
      ]);
    }
    if (layout.showCustomerContact) {
      const custContact = [docPayload.data.customerPhone, docPayload.data.customerEmail]
        .filter(Boolean)
        .join(' | ');
      if (custContact) {
        rows.push([textCell('Customer Contact', STYLE_LABEL_BOLD), textCell(custContact)]);
      }
    }
    if (layout.showCustomerTaxId && docPayload.data.customerTaxId) {
      rows.push([
        textCell('Customer Tax ID', STYLE_LABEL_BOLD),
        textCell(docPayload.data.customerTaxId),
      ]);
    }
  }
  rows.push([]);

  // Line Items / Receipt Allocations Table
  if (docPayload.type !== 'RECEIPT') {
    rows.push([
      textCell('#', STYLE_TABLE_HEADER),
      textCell('Description', STYLE_TABLE_HEADER),
      textCell('Qty / Hrs', STYLE_TABLE_HEADER),
      textCell(`Unit Rate (${docCurrency})`, STYLE_TABLE_HEADER),
      textCell(`Discount (${docCurrency})`, STYLE_TABLE_HEADER),
      textCell('Tax Rate (%)', STYLE_TABLE_HEADER),
      textCell(`Tax Amount (${docCurrency})`, STYLE_TABLE_HEADER),
      textCell(`Line Total (${docCurrency})`, STYLE_TABLE_HEADER),
    ]);

    docPayload.data.lines.forEach((line, idx) => {
      rows.push([
        numberCell(line.lineNumber || idx + 1, STYLE_DEFAULT),
        textCell(line.itemDescription),
        numberCell(line.quantity, STYLE_NUMBER),
        numberCell(line.unitPrice, STYLE_NUMBER),
        numberCell(line.discountAmount, STYLE_NUMBER),
        numberCell(line.taxRate, STYLE_PERCENT),
        numberCell(line.taxAmount, STYLE_NUMBER),
        numberCell(line.lineTotal, STYLE_NUMBER),
      ]);
    });

    rows.push([]);

    // Financial Summary (exact stored values; no independent recalculation)
    rows.push([
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      textCell('Financial Summary', STYLE_SECTION),
      emptyCell(STYLE_SECTION),
      emptyCell(STYLE_SECTION),
    ]);
    rows.push([
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      textCell('Subtotal', STYLE_LABEL_BOLD),
      emptyCell(),
      numberCell(docPayload.data.subtotal, STYLE_NUMBER),
    ]);
    rows.push([
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      textCell('Discount Total', STYLE_LABEL_BOLD),
      emptyCell(),
      numberCell(docPayload.data.discountTotal, STYLE_NUMBER),
    ]);
    rows.push([
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      textCell('Tax Total', STYLE_LABEL_BOLD),
      emptyCell(),
      numberCell(docPayload.data.taxTotal, STYLE_NUMBER),
    ]);
    rows.push([
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      emptyCell(),
      textCell(`Grand Total (${docCurrency})`, STYLE_LABEL_BOLD),
      emptyCell(),
      numberCell(docPayload.data.total, STYLE_NUMBER_BOLD),
    ]);

    if (docPayload.type === 'INVOICE') {
      rows.push([
        emptyCell(),
        emptyCell(),
        emptyCell(),
        emptyCell(),
        emptyCell(),
        textCell('Amount Paid', STYLE_LABEL_BOLD),
        emptyCell(),
        numberCell(docPayload.data.amountPaid, STYLE_NUMBER),
      ]);
      rows.push([
        emptyCell(),
        emptyCell(),
        emptyCell(),
        emptyCell(),
        emptyCell(),
        textCell(`Balance Due (${docCurrency})`, STYLE_LABEL_BOLD),
        emptyCell(),
        numberCell(docPayload.data.balanceDue, STYLE_NUMBER_BOLD),
      ]);
    }
  } else {
    rows.push([
      textCell('#', STYLE_TABLE_HEADER),
      textCell('Invoice Number', STYLE_TABLE_HEADER),
      textCell(`Invoice Total (${docCurrency})`, STYLE_TABLE_HEADER),
      textCell(`Allocated Amount (${docCurrency})`, STYLE_TABLE_HEADER),
    ]);
    (Array.isArray(docPayload.data.allocations) ? docPayload.data.allocations : []).forEach((alloc, idx) => {
      rows.push([
        numberCell(idx + 1, STYLE_DEFAULT),
        textCell(alloc.invoiceNumber),
        numberCell(alloc.invoiceTotal, STYLE_NUMBER),
        numberCell(alloc.allocatedAmount, STYLE_NUMBER),
      ]);
    });
    rows.push([]);
    rows.push([
      textCell('Amount Received', STYLE_LABEL_BOLD),
      numberCell(docPayload.data.amount, STYLE_NUMBER_BOLD),
    ]);
    rows.push([
      textCell('Allocated Total', STYLE_LABEL_BOLD),
      numberCell(docPayload.data.allocatedTotal, STYLE_NUMBER),
    ]);
    rows.push([
      textCell('Unallocated Credit', STYLE_LABEL_BOLD),
      numberCell(docPayload.data.unallocatedAmount, STYLE_NUMBER),
    ]);
  }

  // Bank Details (if enabled and authorized)
  if (layout.showBankDetails && bankAccount) {
    rows.push([]);
    rows.push([textCell('Bank Details', STYLE_SECTION), emptyCell(STYLE_SECTION)]);
    rows.push([textCell('Bank Name', STYLE_LABEL_BOLD), textCell(bankAccount.bankName)]);
    if (bankAccount.branchName) {
      rows.push([textCell('Branch', STYLE_LABEL_BOLD), textCell(bankAccount.branchName)]);
    }
    rows.push([
      textCell('Account Holder', STYLE_LABEL_BOLD),
      textCell(bankAccount.accountHolderName),
    ]);
    rows.push([
      textCell('Account Number', STYLE_LABEL_BOLD),
      textCell(bankAccount.accountNumber),
    ]);
    if (bankAccount.routingCode) {
      rows.push([textCell('IFSC / Routing', STYLE_LABEL_BOLD), textCell(bankAccount.routingCode)]);
    }
    if (bankAccount.upiId) {
      rows.push([textCell('UPI ID', STYLE_LABEL_BOLD), textCell(bankAccount.upiId)]);
    }
  }

  // Notes & Terms
  const notesText = docPayload.data.notes;
  const termsText =
    (docPayload.type !== 'RECEIPT' ? docPayload.data.terms : null) || layout.defaultTermsText;
  if (notesText) {
    rows.push([]);
    rows.push([textCell('Notes', STYLE_LABEL_BOLD), textCell(notesText)]);
  }
  if (showTerms && termsText) {
    rows.push([textCell('Terms & Conditions', STYLE_LABEL_BOLD), textCell(termsText)]);
  }

  const sheetName =
    docPayload.type === 'QUOTATION'
      ? 'Quotation'
      : docPayload.type === 'INVOICE'
      ? 'Invoice'
      : 'Receipt';

  return {
    sheetName,
    rows,
    colWidths: [18, 42, 14, 18, 18, 18, 18, 20],
  };
}

/**
 * Generates a valid binary `.xlsx` file (Uint8Array) using pure OOXML SpreadsheetML.
 */
export function generateXlsxBytes(context: DocumentExportContext): Uint8Array {
  const { sheetName, rows, colWidths } = buildDocumentSpreadsheetRows(context);
  const enc = new TextEncoder();

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;

  const workbookRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const stylesXml = buildStylesXml();
  const sheetXml = buildWorksheetXml(rows, colWidths);

  return createZipArchive([
    { name: '[Content_Types].xml', data: enc.encode(contentTypesXml) },
    { name: '_rels/.rels', data: enc.encode(rootRelsXml) },
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRelsXml) },
    { name: 'xl/styles.xml', data: enc.encode(stylesXml) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) },
  ]);
}

export function generateXlsxBlob(context: DocumentExportContext): Blob {
  const bytes = generateXlsxBytes(context);
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
