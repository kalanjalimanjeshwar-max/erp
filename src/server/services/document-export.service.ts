import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import {
  AuthUser,
  CompanyBankAccountItem,
  CompanyProfile,
  DocumentPrintLayoutConfig,
  DocumentPrintType,
  VisualElementKey,
  VisualTextFontFamily,
  VisualTextFontWeight,
} from '../../shared/types.js';
import { PAPER_DIMENSIONS_MM } from '../../shared/print-settings.js';
import {
  getVisualElementTypography,
  normalizeDocumentVisualElements,
} from '../../shared/branding.js';
import { DocumentPrintLabelKey, getDocumentLabel } from '../../shared/print-translations.js';
import { formatMoney, normalizeCurrencyCode } from '../../shared/currency.js';
import { formatDateTimeInTimezone, getEffectiveTimeZone } from '../../shared/timezone.js';
import {
  DocumentExportBrandingImages,
  ExportableDocumentPayload,
  buildExportFileName,
  generateDocxBuffer,
  resolveEffectivePrintLayout,
} from '../../shared/export/docx-builder.js';
import { BrandingAssetService } from './branding-asset.service.js';
import { CompanyService } from './company.service.js';
import { CompanyBankAccountService } from './company-bank-account.service.js';
import { PermissionService } from './permission.service.js';
import { AuditService } from './audit.service.js';
import { prisma } from '../db/client.js';

export interface ExportDocumentRequest {
  document: ExportableDocumentPayload;
  layoutOverride?: DocumentPrintLayoutConfig;
  isDraftPreview?: boolean;
}

export interface ExportDocumentResult {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

const MM_TO_PT = 72 / 25.4;

function mmToPt(mm: number): number {
  return mm * MM_TO_PT;
}

/**
 * Converts a WOFF1 font buffer (used by @fontsource/noto-sans-kannada) into a standard SFNT/TTF buffer
 * that PDFKit / fontkit can embed directly into PDF streams.
 */
function woffToTtf(woff: Buffer): Buffer {
  const signature = woff.toString('ascii', 0, 4);
  if (signature !== 'wOFF') {
    throw new Error('Invalid WOFF font header.');
  }
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);

  let searchRange = 16;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) {
    searchRange *= 2;
    entrySelector += 1;
  }
  const rangeShift = numTables * 16 - searchRange;

  const tables: Array<{
    tag: string;
    checksum: number;
    data: Buffer;
    origLength: number;
  }> = [];

  for (let i = 0; i < numTables; i++) {
    const entryOffset = 44 + i * 20;
    const tag = woff.toString('ascii', entryOffset, entryOffset + 4);
    const offset = woff.readUInt32BE(entryOffset + 4);
    const compLength = woff.readUInt32BE(entryOffset + 8);
    const origLength = woff.readUInt32BE(entryOffset + 12);
    const checksum = woff.readUInt32BE(entryOffset + 16);

    const compressed = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? zlib.inflateSync(compressed) : Buffer.from(compressed);
    tables.push({ tag, checksum, data, origLength });
  }

  let currentOffset = 12 + numTables * 16;
  const header = Buffer.alloc(12 + numTables * 16);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(rangeShift, 10);

  const chunks: Buffer[] = [header];
  tables.forEach((t, idx) => {
    const recOffset = 12 + idx * 16;
    header.write(t.tag, recOffset, 4, 'ascii');
    header.writeUInt32BE(t.checksum, recOffset + 4);
    header.writeUInt32BE(currentOffset, recOffset + 8);
    header.writeUInt32BE(t.origLength, recOffset + 12);

    const paddedLen = (t.data.length + 3) & ~3;
    if (paddedLen > t.data.length) {
      const padded = Buffer.alloc(paddedLen);
      t.data.copy(padded);
      chunks.push(padded);
    } else {
      chunks.push(t.data);
    }
    currentOffset += paddedLen;
  });

  return Buffer.concat(chunks);
}

interface FontAssets {
  latinRegular: Buffer | null;
  latinBold: Buffer | null;
  serifRegular: Buffer | null;
  serifBold: Buffer | null;
  monoRegular: Buffer | null;
  monoBold: Buffer | null;
  kannadaRegular: Buffer | null;
  kannadaBold: Buffer | null;
}

let cachedFonts: FontAssets | null = null;

function loadFontAssets(): FontAssets {
  if (cachedFonts) return cachedFonts;

  const tryRead = (p: string): Buffer | null => {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p);
    } catch {
      // ignore
    }
    return null;
  };

  const tryReadWoffAsTtf = (p: string): Buffer | null => {
    const raw = tryRead(p);
    if (!raw) return null;
    try {
      return woffToTtf(raw);
    } catch {
      return null;
    }
  };

  const cwd = process.cwd();
  const latinRegular =
    tryRead('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf') ||
    tryRead('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf');
  const latinBold =
    tryRead('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf') ||
    tryRead('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf') ||
    latinRegular;

  const serifRegular =
    tryRead('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf') ||
    tryRead('/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf');
  const serifBold =
    tryRead('/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf') ||
    tryRead('/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf') ||
    serifRegular;

  const monoRegular =
    tryRead('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf') ||
    tryRead('/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf');
  const monoBold =
    tryRead('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf') ||
    tryRead('/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf') ||
    monoRegular;

  const kannadaRegular = tryReadWoffAsTtf(
    path.join(cwd, 'node_modules/@fontsource/noto-sans-kannada/files/noto-sans-kannada-kannada-400-normal.woff')
  );
  const kannadaBold =
    tryReadWoffAsTtf(
      path.join(cwd, 'node_modules/@fontsource/noto-sans-kannada/files/noto-sans-kannada-kannada-700-normal.woff')
    ) || kannadaRegular;

  cachedFonts = {
    latinRegular,
    latinBold,
    serifRegular,
    serifBold,
    monoRegular,
    monoBold,
    kannadaRegular,
    kannadaBold,
  };
  return cachedFonts;
}

function formatLabelText(key: DocumentPrintLabelKey, language: DocumentPrintLayoutConfig['language']): string {
  const entry = getDocumentLabel(key, language);
  return entry.secondary ? `${entry.primary} / ${entry.secondary}` : entry.primary;
}

function resolveSafeLocalImagePath(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:image/')) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  // Only allow safe local assets within workspace /public or /uploads
  const cleaned = trimmed.replace(/^\/+/, '');
  if (cleaned.includes('..')) return null;
  const candidates = [
    path.resolve(process.cwd(), 'public', cleaned),
    path.resolve(process.cwd(), cleaned),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function isSupportedPdfImageBuffer(buf?: Buffer | null): buf is Buffer {
  if (!buf || buf.length < 8) return false;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  return isPng || isJpeg;
}

export class DocumentExportService {
  /**
   * Verifies module VIEW permission for the requested document type.
   */
  private static async assertCanExportDocument(
    actor: AuthUser,
    docType: DocumentPrintType
  ): Promise<void> {
    const moduleName =
      docType === 'QUOTATION' ? 'QUOTATION' : docType === 'INVOICE' ? 'INVOICE' : 'RECEIPT';

    const allowed = await PermissionService.hasPermission(
      actor.companyId,
      actor.role,
      moduleName,
      'VIEW'
    );
    if (!allowed) {
      const err = new Error(
        `Access denied: Your role (${actor.role}) does not have permission to view or export ${moduleName} documents.`
      );
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }
  }

  /**
   * Resolves masked bank account only when layout enables it AND the actor is authorized.
   */
  private static async resolveAuthorizedBankAccount(
    actor: AuthUser,
    docType: DocumentPrintType,
    layout: DocumentPrintLayoutConfig
  ): Promise<CompanyBankAccountItem | null> {
    if (!layout.showBankDetails) return null;

    const canSeeBank = await CompanyBankAccountService.canViewBankDetails(actor);
    if (!canSeeBank) return null;

    try {
      const accounts = await CompanyBankAccountService.listBankAccounts(actor, { isActive: true });
      const filtered = accounts.filter((acc) => {
        if (docType === 'INVOICE') return acc.showOnInvoices;
        if (docType === 'QUOTATION') return acc.showOnQuotations;
        return true;
      });
      return filtered.find((a) => a.isDefault) || filtered[0] || accounts.find((a) => a.isDefault) || accounts[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves company profile safely (with fallback if company is mocked or offline in unit tests).
   */
  private static async resolveCompanyProfile(companyId: string): Promise<CompanyProfile | null> {
    try {
      return await CompanyService.getProfile(companyId);
    } catch {
      return null;
    }
  }

  /**
   * Exports a Quotation, Invoice, or Receipt as PDF or Word (.docx) without altering accounting state.
   */
  static async exportDocument(
    actor: AuthUser,
    request: ExportDocumentRequest,
    format: 'pdf' | 'docx',
    correlationId?: string
  ): Promise<ExportDocumentResult> {
    if (!request?.document || !request.document.type || !request.document.data) {
      const err = new Error('Document payload is required for export.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const docPayload = request.document;
    await this.assertCanExportDocument(actor, docPayload.type);

    const rawCompanyProfile = await this.resolveCompanyProfile(actor.companyId);

    const snapshot =
      !request.isDraftPreview && docPayload.data.status !== 'DRAFT'
        ? docPayload.data.brandingSnapshot ||
          (docPayload.data.id
            ? await BrandingAssetService.getDocumentSnapshot(
                actor.companyId,
                docPayload.type,
                docPayload.data.id
              )
            : null)
        : null;

    const { effectiveProfile: companyProfile, effectiveLayout: snapshotLayout } =
      BrandingAssetService.applySnapshotToCompanyProfile(
        rawCompanyProfile,
        snapshot,
        docPayload.type
      );

    const layout =
      request.layoutOverride ||
      snapshotLayout ||
      resolveEffectivePrintLayout(docPayload.type, companyProfile, undefined);

    const bankAccount = await this.resolveAuthorizedBankAccount(actor, docPayload.type, layout);

    const resolvedLogoUrl =
      snapshot?.logoUrl ?? companyProfile?.brandingAssets?.logo?.url ?? companyProfile?.logoUrl ?? null;
    const resolvedSealUrl =
      snapshot?.sealUrl ??
      (layout.sealUrl ||
        companyProfile?.documentBranding?.sealUrl ||
        companyProfile?.sealUrl ||
        companyProfile?.brandingAssets?.seal?.url ||
        null);
    const resolvedSignatureUrl =
      snapshot?.signatureUrl ??
      (layout.signatureUrl ||
        companyProfile?.documentBranding?.signatureUrl ||
        companyProfile?.signatureUrl ||
        companyProfile?.brandingAssets?.signature?.url ||
        null);

    const [logoBuf, sealBuf, signatureBuf] = await Promise.all([
      BrandingAssetService.resolveExportImageBuffer(actor.companyId, resolvedLogoUrl),
      BrandingAssetService.resolveExportImageBuffer(actor.companyId, resolvedSealUrl),
      BrandingAssetService.resolveExportImageBuffer(actor.companyId, resolvedSignatureUrl),
    ]);

    const brandingImages: DocumentExportBrandingImages = {
      logo: logoBuf,
      seal: sealBuf,
      signature: signatureBuf,
    };

    const fileName = buildExportFileName(docPayload, format, request.isDraftPreview);

    let buffer: Buffer;
    let mimeType: string;

    if (format === 'docx') {
      buffer = await generateDocxBuffer({
        document: snapshot ? { ...docPayload, data: { ...docPayload.data, brandingSnapshot: snapshot } } as ExportableDocumentPayload : docPayload,
        companyProfile,
        layoutOverride: layout,
        bankAccount,
        isDraftPreview: request.isDraftPreview,
        brandingImages,
      });
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else {
      buffer = await this.renderPdfBuffer({
        document: docPayload,
        companyProfile,
        layout,
        bankAccount,
        isDraftPreview: request.isDraftPreview,
        brandingImages,
      });
      mimeType = 'application/pdf';
    }

    const docId = docPayload.data.id || 'unsaved-preview';
    const docNumber =
      docPayload.type === 'QUOTATION'
        ? docPayload.data.quotationNumber
        : docPayload.type === 'INVOICE'
        ? docPayload.data.invoiceNumber
        : docPayload.data.receiptNumber;

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: format === 'pdf' ? 'DOCUMENT_EXPORT_PDF' : 'DOCUMENT_EXPORT_DOCX',
      entity: docPayload.type,
      entityId: docId,
      correlationId,
      details: {
        documentType: docPayload.type,
        documentNumber: docNumber || 'DRAFT PREVIEW',
        paperSize: layout.paperSize,
        orientation: layout.orientation,
        language: layout.language,
        isDraftPreview: Boolean(request.isDraftPreview),
        includedBankDetails: Boolean(bankAccount),
        usedHistoricalSnapshot: Boolean(snapshot),
      },
    });

    return { buffer, fileName, mimeType };
  }

  /**
   * Generates a real, print-accurate binary PDF via PDFKit with embedded Kannada + Latin/₹ fonts.
   */
  private static async renderPdfBuffer(params: {
    document: ExportableDocumentPayload;
    companyProfile: CompanyProfile | null;
    layout: DocumentPrintLayoutConfig;
    bankAccount: CompanyBankAccountItem | null;
    isDraftPreview?: boolean;
    brandingImages?: DocumentExportBrandingImages;
  }): Promise<Buffer> {
    const {
      document: docPayload,
      companyProfile,
      layout,
      bankAccount,
      isDraftPreview,
      brandingImages,
    } = params;
    const docType = docPayload.type;
    const fonts = loadFontAssets();
    const visualElements = normalizeDocumentVisualElements(
      layout.elements,
      layout.paperSize,
      layout.orientation,
      layout.margins
    );
    const useVisual = Boolean(layout.visualLayoutEnabled);

    const dimsMm = PAPER_DIMENSIONS_MM[layout.paperSize] || PAPER_DIMENSIONS_MM.A4;
    const portraitWidthPt = mmToPt(dimsMm.width);
    const portraitHeightPt = mmToPt(dimsMm.height);

    const margins = {
      top: mmToPt(layout.margins.topMm),
      right: mmToPt(layout.margins.rightMm),
      bottom: mmToPt(layout.margins.bottomMm),
      left: mmToPt(layout.margins.leftMm),
    };

    const doc = new PDFDocument({
      size: [portraitWidthPt, portraitHeightPt],
      layout: layout.orientation,
      margins,
      bufferPages: true,
      info: {
        Title: `${docType} Export`,
        Author: companyProfile?.name || 'CoreERP',
        Creator: 'CoreERP Document Export Engine',
      },
    });

    const fontRegularLatin = fonts.latinRegular ? 'LatinRegular' : 'Helvetica';
    const fontBoldLatin = fonts.latinBold ? 'LatinBold' : 'Helvetica-Bold';
    const fontRegularSerif = fonts.serifRegular ? 'SerifRegular' : 'Times-Roman';
    const fontBoldSerif = fonts.serifBold ? 'SerifBold' : 'Times-Bold';
    const fontRegularMono = fonts.monoRegular ? 'MonoRegular' : 'Courier';
    const fontBoldMono = fonts.monoBold ? 'MonoBold' : 'Courier-Bold';
    const fontRegularKn = fonts.kannadaRegular ? 'KannadaRegular' : fontRegularLatin;
    const fontBoldKn = fonts.kannadaBold ? 'KannadaBold' : fontBoldLatin;

    if (fonts.latinRegular) doc.registerFont('LatinRegular', fonts.latinRegular);
    if (fonts.latinBold) doc.registerFont('LatinBold', fonts.latinBold);
    if (fonts.serifRegular) doc.registerFont('SerifRegular', fonts.serifRegular);
    if (fonts.serifBold) doc.registerFont('SerifBold', fonts.serifBold);
    if (fonts.monoRegular) doc.registerFont('MonoRegular', fonts.monoRegular);
    if (fonts.monoBold) doc.registerFont('MonoBold', fonts.monoBold);
    if (fonts.kannadaRegular) doc.registerFont('KannadaRegular', fonts.kannadaRegular);
    if (fonts.kannadaBold) doc.registerFont('KannadaBold', fonts.kannadaBold);

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    const completionPromise = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const isBoldWeight = (weight?: VisualTextFontWeight): boolean =>
      weight === '600' || weight === '700';

    const pickLatinFont = (family?: VisualTextFontFamily, bold = false): string => {
      if (family === 'serif') return bold ? fontBoldSerif : fontRegularSerif;
      if (family === 'mono') return bold ? fontBoldMono : fontRegularMono;
      return bold ? fontBoldLatin : fontRegularLatin;
    };

    const typoGap = (lineHeight: number, fontSizePt: number): number =>
      Math.max(0.5, Math.round((lineHeight - 1.15) * fontSizePt * 10) / 10);

    const typoFor = (key: VisualElementKey) => {
      const typo = getVisualElementTypography(visualElements[key]);
      return {
        ...typo,
        bold: isBoldWeight(typo.fontWeight),
        lineGap: typoGap(typo.lineHeight, typo.fontSizePt),
      };
    };

    // Helper for mixed Latin + Kannada text rendering with full typography controls
    const writeMixedText = (
      text: string,
      x: number,
      y: number,
      options?: {
        width?: number;
        align?: 'left' | 'center' | 'right';
        fontSize?: number;
        bold?: boolean;
        fontFamily?: VisualTextFontFamily;
        color?: string;
        lineGap?: number;
        characterSpacing?: number;
      }
    ): number => {
      const fontSize = options?.fontSize ?? 9;
      const bold = options?.bold ?? false;
      const fontFamily = options?.fontFamily;
      const color = options?.color ?? '#0f172a';
      const align = options?.align ?? 'left';
      const width = options?.width;
      const lineGap = options?.lineGap ?? 1.5;
      const characterSpacing = options?.characterSpacing ?? 0;

      const cleanText = String(text ?? '');
      const segments = cleanText.split(/([\u0C80-\u0CFF]+)/).filter(Boolean);

      doc.fillColor(color).fontSize(fontSize);

      if (segments.length === 0) {
        return y;
      }

      const textOpts = {
        width,
        align,
        lineGap,
        ...(characterSpacing !== 0 ? { characterSpacing } : {}),
      };

      if (segments.length === 1) {
        const isKn = /[\u0C80-\u0CFF]/.test(segments[0]);
        doc.font(isKn ? (bold ? fontBoldKn : fontRegularKn) : pickLatinFont(fontFamily, bold));
        doc.text(segments[0], x, y, textOpts);
        return doc.y;
      }

      segments.forEach((seg, idx) => {
        const isKn = /[\u0C80-\u0CFF]/.test(seg);
        doc.font(isKn ? (bold ? fontBoldKn : fontRegularKn) : pickLatinFont(fontFamily, bold));
        const isFirst = idx === 0;
        const isLast = idx === segments.length - 1;
        if (isFirst) {
          doc.text(seg, x, y, { ...textOpts, continued: !isLast });
        } else {
          doc.text(seg, { ...textOpts, continued: !isLast });
        }
      });

      return doc.y;
    };

    const measureMixedHeight = (
      text: string,
      width: number,
      fontSize: number,
      bold = false,
      fontFamily?: VisualTextFontFamily,
      lineGap = 1.5,
      characterSpacing = 0
    ): number => {
      const isKn = /[\u0C80-\u0CFF]/.test(text);
      doc.font(isKn ? (bold ? fontBoldKn : fontRegularKn) : pickLatinFont(fontFamily, bold));
      doc.fontSize(fontSize);
      return doc.heightOfString(text || '', {
        width: Math.max(10, width),
        lineGap,
        ...(characterSpacing !== 0 ? { characterSpacing } : {}),
      });
    };

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentLeft = margins.left;
    const contentRight = pageW - margins.right;
    const contentWidth = contentRight - contentLeft;

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

    // Pre-calculate exact footer height so body content reserves clean footer space without auto-pagination
    const footerEl = visualElements.footer;
    const footerTypo = typoFor('footer');
    const footerVisible = !useVisual || footerEl.visible;
    const printedAtLabel = formatDateTimeInTimezone(new Date(), timezone, {
      includeZoneAbbr: true,
    });
    const footerParts = [
      layout.footerText || '',
      layout.showPrintedTimestamp
        ? `${formatLabelText('generatedOn', layout.language)}: ${printedAtLabel} (${timezone})`
        : '',
    ].filter(Boolean);
    const footerJoined = footerParts.join('  |  ');
    const footerX = useVisual
      ? Math.max(contentLeft, Math.min(contentRight - 80, mmToPt(footerEl.xMm)))
      : contentLeft;
    const rawFooterW = useVisual
      ? Math.max(80, Math.min(contentRight - footerX, mmToPt(footerEl.widthMm)))
      : contentWidth;
    const pageNumReserveW = 58;
    const footerTextW =
      footerTypo.align === 'right'
        ? rawFooterW
        : Math.max(60, Math.min(rawFooterW, contentRight - pageNumReserveW - footerX));
    const measuredFooterH =
      footerVisible && footerJoined
        ? measureMixedHeight(
            footerJoined,
            footerTextW,
            footerTypo.fontSizePt,
            footerTypo.bold,
            footerTypo.fontFamily,
            footerTypo.lineGap,
            footerTypo.letterSpacing
          )
        : footerVisible
        ? footerTypo.fontSizePt * 1.3
        : 0;
    const footerReserve = footerVisible ? Math.max(22, Math.ceil(measuredFooterH) + 8) : 8;
    const bottomLimit = pageH - margins.bottom - footerReserve;

    const startContinuationPage = (): number => {
      doc.addPage();
      let contY = margins.top;
      contY = writeMixedText(
        `${companyName}  •  ${resolvedTitle.toUpperCase()}  •  ${docNumber || 'DRAFT PREVIEW'} (Continued)`,
        contentLeft,
        contY,
        {
          width: contentWidth,
          fontSize: 7.5,
          bold: true,
          color: '#64748b',
        }
      );
      contY += 3;
      doc
        .moveTo(contentLeft, contY)
        .lineTo(contentRight, contY)
        .strokeColor('#cbd5e1')
        .lineWidth(0.5)
        .stroke();
      contY += 6;
      doc.y = contY;
      return contY;
    };

    const ensurePageSpace = (neededPt: number): number => {
      if (doc.y + neededPt > bottomLimit) {
        return startContinuationPage();
      }
      return doc.y;
    };

    let cursorY = margins.top;

    // Optional top header bar
    if (layout.headerText || isDraftPreview) {
      const topParts = [
        layout.headerText || null,
        isDraftPreview ? 'DRAFT PREVIEW' : null,
        getDocumentLabel('originalForRecipient', layout.language).primary,
      ].filter(Boolean);
      cursorY = writeMixedText(topParts.join('  |  '), contentLeft, cursorY, {
        width: contentWidth,
        fontSize: 7.5,
        color: '#64748b',
      });
      cursorY += 3;
      doc
        .moveTo(contentLeft, cursorY)
        .lineTo(contentRight, cursorY)
        .strokeColor('#cbd5e1')
        .lineWidth(0.5)
        .stroke();
      cursorY += 6;
    }

    // Header: Logo, Company Name, Company Header, Document Title & Number using 14-Element Config
    const headerStartY = cursorY;
    const headerBannerShift = Math.max(0, headerStartY - margins.top);

    const logoEl = visualElements.logo;
    const companyNameEl = visualElements.companyName;
    const headerEl = visualElements.companyHeader;
    const titleEl = visualElements.documentTitle;
    const docNumEl = visualElements.documentNumber;

    const nameTypo = typoFor('companyName');
    const headerTypo = typoFor('companyHeader');
    const titleTypo = typoFor('documentTitle');
    const docNumTypo = typoFor('documentNumber');

    const logoX = useVisual
      ? Math.max(contentLeft, Math.min(contentRight - 24, mmToPt(logoEl.xMm)))
      : contentLeft;
    const logoY = useVisual ? Math.max(headerStartY, mmToPt(logoEl.yMm) + headerBannerShift) : headerStartY;
    const logoW = useVisual ? Math.max(24, Math.min(contentWidth * 0.65, mmToPt(logoEl.widthMm))) : 96;
    const logoH = useVisual
      ? Math.max(16, Math.min(54, mmToPt(logoEl.heightMm)))
      : layout.logoSize === 'sm'
      ? 26
      : layout.logoSize === 'lg'
      ? 44
      : 34;

    let logoBottomY = headerStartY;
    const logoVisible = layout.showLogo && (!useVisual || logoEl.visible);
    if (logoVisible) {
      const logoImgSource = isSupportedPdfImageBuffer(brandingImages?.logo as Buffer | null | undefined)
        ? (brandingImages?.logo as Buffer)
        : resolveSafeLocalImagePath(companyProfile?.logoUrl);

      if (logoImgSource) {
        try {
          const logoAlign = logoEl.align || layout.logoPosition;
          doc.image(logoImgSource, logoX, logoY, {
            fit: [logoW, logoH],
            ...(logoAlign === 'center' || logoAlign === 'right' ? { align: logoAlign } : {}),
          });
          logoBottomY = logoY + logoH + mmToPt(logoEl.spacingMm || 2);
        } catch {
          // ignore unreadable image
        }
      }
    }

    const nameVisible = layout.showCompanyName && (!useVisual || companyNameEl.visible);
    const nameX = useVisual
      ? Math.max(contentLeft, Math.min(contentRight - 60, mmToPt(companyNameEl.xMm)))
      : contentLeft;
    const nameW = useVisual
      ? Math.max(60, Math.min(contentRight - nameX, mmToPt(companyNameEl.widthMm)))
      : contentWidth * 0.56;
    let nameY = useVisual
      ? Math.max(headerStartY, mmToPt(companyNameEl.yMm) + headerBannerShift)
      : logoBottomY;

    const logoOverlapsNameHoriz =
      logoBottomY > headerStartY && nameX < logoX + logoW && nameX + nameW > logoX;
    if (logoOverlapsNameHoriz && nameY < logoBottomY) {
      nameY = logoBottomY;
    }

    let nameBottomY = nameY;
    if (nameVisible) {
      nameBottomY = writeMixedText(companyName, nameX, nameY, {
        width: nameW,
        align: nameTypo.align,
        fontSize: nameTypo.fontSizePt,
        bold: nameTypo.bold,
        fontFamily: nameTypo.fontFamily,
        lineGap: nameTypo.lineGap,
        characterSpacing: nameTypo.letterSpacing,
        color: '#0f172a',
      });
      if (companyProfile?.legalName && companyProfile.legalName !== companyName) {
        nameBottomY = writeMixedText(companyProfile.legalName, nameX, nameBottomY + 1, {
          width: nameW,
          align: nameTypo.align,
          fontSize: Math.max(7, nameTypo.fontSizePt - 4),
          fontFamily: nameTypo.fontFamily,
          color: '#475569',
        });
      }
      nameBottomY += mmToPt(companyNameEl.spacingMm || 1.5);
    }

    const headerX = useVisual
      ? Math.max(contentLeft, Math.min(contentRight - 60, mmToPt(headerEl.xMm)))
      : contentLeft;
    const headerW = useVisual
      ? Math.max(60, Math.min(contentRight - headerX, mmToPt(headerEl.widthMm)))
      : contentWidth * 0.56;
    let leftY = useVisual
      ? Math.max(headerStartY, mmToPt(headerEl.yMm) + headerBannerShift)
      : nameVisible
      ? nameBottomY
      : logoBottomY;

    const horizontalOverlapLogo =
      logoBottomY > headerStartY && headerX < logoX + logoW && headerX + headerW > logoX;
    if (horizontalOverlapLogo && leftY < logoBottomY) {
      leftY = logoBottomY;
    }
    const horizontalOverlapName =
      nameVisible && headerX < nameX + nameW && headerX + headerW > nameX;
    if (horizontalOverlapName && leftY < nameBottomY) {
      leftY = nameBottomY;
    }

    const headerAlign = useVisual ? headerTypo.align : 'left';
    const headerVisible = !useVisual || headerEl.visible;

    if (headerVisible) {
      if (layout.showCompanyContact) {
        if (companyProfile?.address) {
          leftY = writeMixedText(companyProfile.address, headerX, leftY, {
            width: headerW,
            align: headerAlign,
            fontSize: headerTypo.fontSizePt,
            bold: headerTypo.bold,
            fontFamily: headerTypo.fontFamily,
            lineGap: headerTypo.lineGap,
            characterSpacing: headerTypo.letterSpacing,
            color: '#475569',
          });
        }
        const contactLine = [companyProfile?.phone, companyProfile?.email, companyProfile?.website]
          .filter(Boolean)
          .join('  •  ');
        if (contactLine) {
          leftY = writeMixedText(contactLine, headerX, leftY + 1, {
            width: headerW,
            align: headerAlign,
            fontSize: headerTypo.fontSizePt,
            bold: headerTypo.bold,
            fontFamily: headerTypo.fontFamily,
            lineGap: headerTypo.lineGap,
            characterSpacing: headerTypo.letterSpacing,
            color: '#475569',
          });
        }
      }

      if (layout.showCompanyTaxId && companyProfile?.taxId) {
        leftY = writeMixedText(
          `${formatLabelText('taxId', layout.language)}: ${companyProfile.taxId}`,
          headerX,
          leftY + 1.5,
          {
            width: headerW,
            align: headerAlign,
            fontSize: headerTypo.fontSizePt,
            bold: true,
            fontFamily: headerTypo.fontFamily,
            lineGap: headerTypo.lineGap,
            characterSpacing: headerTypo.letterSpacing,
            color: '#334155',
          }
        );
      }
      leftY += mmToPt(headerEl.spacingMm || 2);
    }

    const titleX = useVisual
      ? Math.max(contentLeft, Math.min(contentRight - 60, mmToPt(titleEl.xMm)))
      : contentLeft + contentWidth * 0.58;
    const titleW = useVisual
      ? Math.max(60, Math.min(contentRight - titleX, mmToPt(titleEl.widthMm)))
      : contentWidth * 0.42;
    let rightY = useVisual
      ? Math.max(headerStartY, mmToPt(titleEl.yMm) + headerBannerShift)
      : headerStartY;
    const titleAlign: 'left' | 'center' | 'right' = useVisual
      ? titleTypo.align
      : layout.titlePlacement === 'left'
      ? 'left'
      : layout.titlePlacement === 'center'
      ? 'center'
      : 'right';

    const titleVisible = !useVisual || titleEl.visible;
    if (titleVisible) {
      rightY = writeMixedText(resolvedTitle.toUpperCase(), titleX, rightY, {
        width: titleW,
        align: titleAlign,
        fontSize: titleTypo.fontSizePt,
        bold: titleTypo.bold,
        fontFamily: titleTypo.fontFamily,
        lineGap: titleTypo.lineGap,
        characterSpacing: titleTypo.letterSpacing,
        color: '#0f172a',
      });
      rightY += mmToPt(titleEl.spacingMm || 1.5);
    }

    let docNumBottomY = rightY;
    const docNumVisible = !useVisual || docNumEl.visible;
    if (docNumVisible && layout.numberPlacement !== 'meta-grid') {
      const numX = useVisual
        ? Math.max(contentLeft, Math.min(contentRight - 60, mmToPt(docNumEl.xMm)))
        : titleX;
      const numW = useVisual
        ? Math.max(60, Math.min(contentRight - numX, mmToPt(docNumEl.widthMm)))
        : titleW;
      let numY = useVisual
        ? Math.max(headerStartY, mmToPt(docNumEl.yMm) + headerBannerShift)
        : rightY + 2;

      const titleOverlapsNum =
        titleVisible && numX < titleX + titleW && numX + numW > titleX;
      if (titleOverlapsNum && numY < rightY) {
        numY = rightY;
      }

      docNumBottomY = writeMixedText(
        `${formatLabelText(docNumberLabelKey, layout.language)}: ${docNumber || 'DRAFT PREVIEW'}`,
        numX,
        numY,
        {
          width: numW,
          align: useVisual ? docNumTypo.align : titleAlign,
          fontSize: docNumTypo.fontSizePt,
          bold: docNumTypo.bold,
          fontFamily: docNumTypo.fontFamily,
          lineGap: docNumTypo.lineGap,
          characterSpacing: docNumTypo.letterSpacing,
          color: '#1e293b',
        }
      );
      docNumBottomY += mmToPt(docNumEl.spacingMm || 1.5);
    }

    cursorY = Math.max(logoBottomY, nameBottomY, leftY, rightY, docNumBottomY) + 5;
    doc
      .moveTo(contentLeft, cursorY)
      .lineTo(contentRight, cursorY)
      .strokeColor('#0f172a')
      .lineWidth(1.2)
      .stroke();
    cursorY += 8;

    // Party + Metadata 2-Column Boxes
    const customerEl = visualElements.customerDetails;
    const datesEl = visualElements.dates;
    const customerTypo = typoFor('customerDetails');
    const datesTypo = typoFor('dates');
    const customerVisible = !useVisual || customerEl.visible;
    const datesVisible = !useVisual || datesEl.visible;

    const boxGap = 10;
    const boxW = (contentWidth - boxGap) / 2;
    const boxStartY = cursorY;

    const partyLabelKey: DocumentPrintLabelKey =
      docType === 'QUOTATION'
        ? 'quotedFor'
        : docType === 'INVOICE'
        ? 'billedTo'
        : 'receivedFrom';

    const partyLines: Array<{ text: string; size: number; bold?: boolean; color: string }> = [
      {
        text: formatLabelText(partyLabelKey, layout.language).toUpperCase(),
        size: Math.max(6.5, customerTypo.fontSizePt - 1),
        bold: true,
        color: '#64748b',
      },
      {
        text: docPayload.data.customerName,
        size: Math.max(9, customerTypo.fontSizePt + 1.5),
        bold: true,
        color: '#0f172a',
      },
    ];

    if (docPayload.type !== 'RECEIPT') {
      if (layout.showCustomerAddress && docPayload.data.customerAddress) {
        partyLines.push({
          text: docPayload.data.customerAddress,
          size: customerTypo.fontSizePt,
          bold: customerTypo.bold,
          color: '#475569',
        });
      }
      if (
        layout.showCustomerContact &&
        (docPayload.data.customerEmail || docPayload.data.customerPhone)
      ) {
        partyLines.push({
          text: [docPayload.data.customerEmail, docPayload.data.customerPhone]
            .filter(Boolean)
            .join('  •  '),
          size: customerTypo.fontSizePt,
          bold: customerTypo.bold,
          color: '#475569',
        });
      }
      if (layout.showCustomerTaxId && docPayload.data.customerTaxId) {
        partyLines.push({
          text: `${formatLabelText('taxId', layout.language)}: ${docPayload.data.customerTaxId}`,
          size: customerTypo.fontSizePt,
          bold: true,
          color: '#334155',
        });
      }
    }

    const docDate =
      docPayload.type === 'QUOTATION'
        ? docPayload.data.quotationDate
        : docPayload.type === 'INVOICE'
        ? docPayload.data.invoiceDate
        : docPayload.data.receiptDate;

    const metaRows: Array<{ label: string; value: string }> = [];
    if (layout.numberPlacement === 'meta-grid' && docNumVisible) {
      metaRows.push({
        label: formatLabelText(docNumberLabelKey, layout.language),
        value: docNumber || 'DRAFT PREVIEW',
      });
    }
    metaRows.push({ label: formatLabelText('date', layout.language), value: docDate });
    if (docPayload.type === 'QUOTATION') {
      metaRows.push({
        label: formatLabelText('validUntil', layout.language),
        value: docPayload.data.validUntilDate,
      });
    } else if (docPayload.type === 'INVOICE') {
      metaRows.push({
        label: formatLabelText('dueDate', layout.language),
        value: docPayload.data.dueDate,
      });
    } else {
      metaRows.push({
        label: formatLabelText('paymentMethod', layout.language),
        value: docPayload.data.paymentMethod.replace(/_/g, ' '),
      });
      if (docPayload.data.referenceNumber) {
        metaRows.push({
          label: formatLabelText('referenceNumber', layout.language),
          value: docPayload.data.referenceNumber,
        });
      }
    }
    metaRows.push(
      { label: formatLabelText('currency', layout.language), value: documentCurrency },
      { label: formatLabelText('status', layout.language), value: docPayload.data.status }
    );

    const innerPad = 7;
    const partyInnerW = boxW - innerPad * 2;
    let estPartyH = customerVisible ? innerPad * 2 : 0;
    if (customerVisible) {
      for (const pl of partyLines) {
        estPartyH +=
          measureMixedHeight(
            pl.text,
            partyInnerW,
            pl.size,
            pl.bold,
            customerTypo.fontFamily,
            customerTypo.lineGap,
            customerTypo.letterSpacing
          ) + 2;
      }
    }
    const metaRowStep = Math.max(12, Math.round(datesTypo.fontSizePt * datesTypo.lineHeight) + 2);
    const estMetaH = datesVisible ? innerPad * 2 + metaRows.length * metaRowStep : 0;
    const boxH =
      customerVisible || datesVisible ? Math.max(estPartyH, estMetaH, 54) : 0;

    if (customerVisible) {
      doc
        .roundedRect(contentLeft, boxStartY, boxW, boxH, 4)
        .fillAndStroke('#f8fafc', '#cbd5e1');

      let py = boxStartY + innerPad;
      for (const pl of partyLines) {
        py = writeMixedText(pl.text, contentLeft + innerPad, py, {
          width: partyInnerW,
          align: customerTypo.align,
          fontSize: pl.size,
          bold: pl.bold,
          fontFamily: customerTypo.fontFamily,
          lineGap: customerTypo.lineGap,
          characterSpacing: customerTypo.letterSpacing,
          color: pl.color,
        });
        py += 1.5;
      }
    }

    if (datesVisible) {
      const metaX = contentLeft + boxW + boxGap;
      doc.roundedRect(metaX, boxStartY, boxW, boxH, 4).strokeColor('#cbd5e1').lineWidth(0.75).stroke();

      let my = boxStartY + innerPad;
      for (const row of metaRows) {
        writeMixedText(`${row.label}:`, metaX + innerPad, my, {
          width: boxW * 0.52,
          fontSize: datesTypo.fontSizePt,
          bold: datesTypo.bold,
          fontFamily: datesTypo.fontFamily,
          lineGap: datesTypo.lineGap,
          characterSpacing: datesTypo.letterSpacing,
          color: '#64748b',
        });
        writeMixedText(row.value, metaX + boxW * 0.5, my, {
          width: boxW * 0.5 - innerPad,
          align: 'right',
          fontSize: datesTypo.fontSizePt,
          bold: true,
          fontFamily: datesTypo.fontFamily,
          lineGap: datesTypo.lineGap,
          characterSpacing: datesTypo.letterSpacing,
          color: '#0f172a',
        });
        my += metaRowStep;
      }
    }

    cursorY = boxStartY + boxH + (boxH > 0 ? 10 : 4);

    // Line Items Table (Quotation / Invoice) or Receipt Summary
    const thTypo = typoFor('tableHeadings');
    const tableHeadingsVisible = !useVisual || visualElements.tableHeadings.visible;

    if (docPayload.type !== 'RECEIPT') {
      const colDefs: Array<{
        key: string;
        label: string;
        widthWeight: number;
        align: 'left' | 'right';
      }> = [
        { key: 'sn', label: formatLabelText('serialNo', layout.language), widthWeight: 6, align: 'left' },
        {
          key: 'desc',
          label: formatLabelText('serviceDescription', layout.language),
          widthWeight:
            layout.showDiscountColumn && layout.showTaxColumn
              ? 36
              : layout.showDiscountColumn || layout.showTaxColumn
              ? 46
              : 56,
          align: 'left',
        },
        { key: 'qty', label: formatLabelText('qtyHours', layout.language), widthWeight: 10, align: 'right' },
        { key: 'rate', label: formatLabelText('rate', layout.language), widthWeight: 14, align: 'right' },
      ];
      if (layout.showDiscountColumn) {
        colDefs.push({
          key: 'disc',
          label: formatLabelText('discount', layout.language),
          widthWeight: 10,
          align: 'right',
        });
      }
      if (layout.showTaxColumn) {
        colDefs.push({
          key: 'tax',
          label: formatLabelText('tax', layout.language),
          widthWeight: 10,
          align: 'right',
        });
      }
      colDefs.push({
        key: 'amt',
        label: formatLabelText('amount', layout.language),
        widthWeight: 14,
        align: 'right',
      });

      const totalWeight = colDefs.reduce((s, c) => s + c.widthWeight, 0);
      const cols = colDefs.map((c) => ({
        ...c,
        widthPt: (c.widthWeight / totalWeight) * contentWidth,
      }));

      const drawTableHeader = (y: number): number => {
        if (!tableHeadingsVisible) return y;
        let headerH = 18;
        for (const col of cols) {
          headerH = Math.max(
            headerH,
            measureMixedHeight(
              col.label,
              col.widthPt - 8,
              thTypo.fontSizePt,
              thTypo.bold,
              thTypo.fontFamily,
              thTypo.lineGap,
              thTypo.letterSpacing
            ) + 8
          );
        }
        doc.rect(contentLeft, y, contentWidth, headerH).fill('#0f172a');
        let cx = contentLeft;
        for (const col of cols) {
          writeMixedText(col.label, cx + 4, y + 4, {
            width: col.widthPt - 8,
            align: col.align,
            fontSize: thTypo.fontSizePt,
            bold: thTypo.bold,
            fontFamily: thTypo.fontFamily,
            lineGap: thTypo.lineGap,
            characterSpacing: thTypo.letterSpacing,
            color: '#ffffff',
          });
          cx += col.widthPt;
        }
        return y + headerH;
      };

      doc.y = cursorY;
      cursorY = drawTableHeader(cursorY);

      docPayload.data.lines.forEach((line, idx) => {
        const cellValues: Record<string, string> = {
          sn: String(line.lineNumber || idx + 1),
          desc: line.itemDescription,
          qty: Number(line.quantity).toFixed(2),
          rate: fmt(line.unitPrice),
          disc: fmt(line.discountAmount),
          tax:
            layout.serviceLayout === 'detailed'
              ? `${fmt(line.taxAmount)} (${Number(line.taxRate).toFixed(1)}%)`
              : fmt(line.taxAmount),
          amt: fmt(line.lineTotal),
        };

        const rowPadY = layout.serviceLayout === 'compact' ? 3.5 : 5;
        let rowH = layout.serviceLayout === 'compact' ? 16 : 20;
        for (const col of cols) {
          const val = cellValues[col.key] || '';
          const h = measureMixedHeight(val, col.widthPt - 8, 8.5, col.key === 'amt') + rowPadY * 2;
          if (h > rowH) rowH = h;
        }

        if (cursorY + rowH > bottomLimit) {
          cursorY = startContinuationPage();
          cursorY = drawTableHeader(cursorY);
        }

        if (idx % 2 === 1) {
          doc.rect(contentLeft, cursorY, contentWidth, rowH).fill('#f8fafc');
        }
        doc
          .rect(contentLeft, cursorY, contentWidth, rowH)
          .strokeColor('#e2e8f0')
          .lineWidth(0.5)
          .stroke();

        let cx = contentLeft;
        for (const col of cols) {
          writeMixedText(cellValues[col.key] || '', cx + 4, cursorY + rowPadY, {
            width: col.widthPt - 8,
            align: col.align,
            fontSize: 8.5,
            bold: col.key === 'amt',
            color: col.key === 'sn' ? '#64748b' : '#0f172a',
          });
          cx += col.widthPt;
        }

        cursorY += rowH;
      });
    } else {
      // Receipt Amount Banner
      doc.roundedRect(contentLeft, cursorY, contentWidth, 32, 4).fillAndStroke('#f8fafc', '#cbd5e1');
      writeMixedText(formatLabelText('amountReceived', layout.language), contentLeft + 10, cursorY + 10, {
        width: contentWidth * 0.5,
        fontSize: 9.5,
        bold: true,
        color: '#475569',
      });
      writeMixedText(fmt(docPayload.data.amount), contentLeft + contentWidth * 0.5, cursorY + 9, {
        width: contentWidth * 0.5 - 10,
        align: 'right',
        fontSize: 12,
        bold: true,
        color: '#0f172a',
      });
      cursorY += 38;
    }

    // Bank Details (left) + Totals Box (right)
    const totalsTypo = typoFor('financialTotals');
    const totalsVisible =
      layout.showTotalsSummary && (!useVisual || visualElements.financialTotals.visible);

    const bankLines: string[] = [];
    if (layout.showBankDetails && bankAccount) {
      bankLines.push(
        `${formatLabelText('bankName', layout.language)}: ${bankAccount.bankName}${
          bankAccount.branchName ? ` (${bankAccount.branchName})` : ''
        }`,
        `${formatLabelText('accountHolder', layout.language)}: ${bankAccount.accountHolderName}`,
        `${formatLabelText('accountNumber', layout.language)}: ${bankAccount.accountNumber}`
      );
      if (bankAccount.routingCode) {
        bankLines.push(`${formatLabelText('routingIfsc', layout.language)}: ${bankAccount.routingCode}`);
      }
      if (bankAccount.upiId) {
        bankLines.push(`${formatLabelText('upiId', layout.language)}: ${bankAccount.upiId}`);
      }
    }
    const bankBoxH = bankLines.length > 0 ? 18 + bankLines.length * 11.5 : 0;

    const totalRows: Array<{ label: string; value: string; bold?: boolean; topBorder?: boolean }> = [];
    if (totalsVisible) {
      if (docPayload.type !== 'RECEIPT') {
        totalRows.push({
          label: formatLabelText('subtotal', layout.language),
          value: fmt(docPayload.data.subtotal),
        });
        totalRows.push({
          label: formatLabelText('totalDiscount', layout.language),
          value: `-${fmt(docPayload.data.discountTotal)}`,
        });
        if (layout.showTaxBreakdown) {
          totalRows.push({
            label: formatLabelText('totalTax', layout.language),
            value: fmt(docPayload.data.taxTotal),
          });
        }
        totalRows.push({
          label: formatLabelText('grandTotal', layout.language),
          value: fmt(docPayload.data.total),
          bold: true,
          topBorder: true,
        });
        if (docPayload.type === 'INVOICE') {
          totalRows.push({
            label: formatLabelText('amountPaid', layout.language),
            value: fmt(docPayload.data.amountPaid),
          });
          totalRows.push({
            label: formatLabelText('balanceDue', layout.language),
            value: fmt(docPayload.data.balanceDue),
            bold: true,
            topBorder: true,
          });
        }
      } else {
        totalRows.push(
          {
            label: formatLabelText('amountReceived', layout.language),
            value: fmt(docPayload.data.amount),
            bold: true,
          },
          {
            label: formatLabelText('allocatedTotal', layout.language),
            value: fmt(docPayload.data.allocatedTotal),
          },
          {
            label: formatLabelText('unallocatedCredit', layout.language),
            value: fmt(docPayload.data.unallocatedAmount),
            bold: true,
            topBorder: true,
          }
        );
      }
    }
    const totalRowStep = Math.max(13.5, Math.round(totalsTypo.fontSizePt * totalsTypo.lineHeight) + 2);
    const totalsBoxH = totalRows.length > 0 ? 12 + totalRows.length * totalRowStep : 0;
    const summaryNeeded = Math.max(bankBoxH, totalsBoxH);

    cursorY += 8;
    doc.y = cursorY;
    if (summaryNeeded > 0) {
      cursorY = ensurePageSpace(summaryNeeded + 4);
    }

    const summaryStartY = cursorY;
    const bankW = contentWidth * 0.52;
    const totalsW = contentWidth * 0.44;
    const totalsX = contentRight - totalsW;

    let bankEndY = summaryStartY;
    if (bankLines.length > 0) {
      doc.roundedRect(contentLeft, summaryStartY, bankW, bankBoxH, 4).fillAndStroke('#f8fafc', '#cbd5e1');

      let by = summaryStartY + 6;
      by = writeMixedText(formatLabelText('bankDetails', layout.language).toUpperCase(), contentLeft + 8, by, {
        width: bankW - 16,
        fontSize: 7.5,
        bold: true,
        color: '#475569',
      });
      by += 2;
      for (const line of bankLines) {
        by = writeMixedText(line, contentLeft + 8, by, {
          width: bankW - 16,
          fontSize: 8,
          color: '#0f172a',
        });
        by += 1;
      }
      bankEndY = summaryStartY + bankBoxH;
    }

    let totalsEndY = summaryStartY;
    if (totalRows.length > 0) {
      doc.roundedRect(totalsX, summaryStartY, totalsW, totalsBoxH, 4).strokeColor('#cbd5e1').lineWidth(0.75).stroke();

      let ty = summaryStartY + 6;
      for (const row of totalRows) {
        if (row.topBorder) {
          doc
            .moveTo(totalsX + 8, ty - 2)
            .lineTo(totalsX + totalsW - 8, ty - 2)
            .strokeColor('#cbd5e1')
            .lineWidth(0.5)
            .stroke();
        }
        const rowFontPt = row.bold ? totalsTypo.fontSizePt + 0.8 : totalsTypo.fontSizePt;
        writeMixedText(row.label, totalsX + 8, ty, {
          width: totalsW * 0.56,
          fontSize: rowFontPt,
          bold: row.bold || totalsTypo.bold,
          fontFamily: totalsTypo.fontFamily,
          lineGap: totalsTypo.lineGap,
          characterSpacing: totalsTypo.letterSpacing,
          color: row.bold ? '#0f172a' : '#475569',
        });
        writeMixedText(row.value, totalsX + totalsW * 0.5, ty, {
          width: totalsW * 0.5 - 8,
          align: 'right',
          fontSize: rowFontPt,
          bold: row.bold || totalsTypo.bold,
          fontFamily: totalsTypo.fontFamily,
          lineGap: totalsTypo.lineGap,
          characterSpacing: totalsTypo.letterSpacing,
          color: '#0f172a',
        });
        ty += totalRowStep;
      }
      totalsEndY = summaryStartY + totalsBoxH;
    }

    cursorY = Math.max(bankEndY, totalsEndY) + 8;
    doc.y = cursorY;

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
      const notesH =
        12 +
        measureMixedHeight(
          notesText,
          contentWidth,
          termsTypo.fontSizePt,
          termsTypo.bold,
          termsTypo.fontFamily,
          termsTypo.lineGap,
          termsTypo.letterSpacing
        );
      cursorY = ensurePageSpace(notesH + 4);
      cursorY = writeMixedText(formatLabelText('notes', layout.language).toUpperCase(), contentLeft, cursorY, {
        width: contentWidth,
        align: termsTypo.align,
        fontSize: Math.max(6.5, termsTypo.fontSizePt - 1),
        bold: true,
        fontFamily: termsTypo.fontFamily,
        color: '#64748b',
      });
      cursorY = writeMixedText(notesText, contentLeft, cursorY + 1.5, {
        width: contentWidth,
        align: termsTypo.align,
        fontSize: termsTypo.fontSizePt,
        bold: termsTypo.bold,
        fontFamily: termsTypo.fontFamily,
        lineGap: termsTypo.lineGap,
        characterSpacing: termsTypo.letterSpacing,
        color: '#334155',
      });
      cursorY += 5;
      doc.y = cursorY;
    }

    if (termsVisible && termsText) {
      const termsH =
        12 +
        measureMixedHeight(
          termsText,
          contentWidth,
          termsTypo.fontSizePt,
          termsTypo.bold,
          termsTypo.fontFamily,
          termsTypo.lineGap,
          termsTypo.letterSpacing
        );
      cursorY = ensurePageSpace(termsH + 4);
      cursorY = writeMixedText(
        formatLabelText('termsAndConditions', layout.language).toUpperCase(),
        contentLeft,
        cursorY,
        {
          width: contentWidth,
          align: termsTypo.align,
          fontSize: Math.max(6.5, termsTypo.fontSizePt - 1),
          bold: true,
          fontFamily: termsTypo.fontFamily,
          color: '#64748b',
        }
      );
      cursorY = writeMixedText(termsText, contentLeft, cursorY + 1.5, {
        width: contentWidth,
        align: termsTypo.align,
        fontSize: termsTypo.fontSizePt,
        bold: termsTypo.bold,
        fontFamily: termsTypo.fontFamily,
        lineGap: termsTypo.lineGap,
        characterSpacing: termsTypo.letterSpacing,
        color: '#334155',
      });
      cursorY += 6;
      doc.y = cursorY;
    }

    // Authorized Signature & Seal
    if (layout.showSignatureSection) {
      const sealEl = visualElements.seal;
      const sigEl = visualElements.signature;
      const sigLabelEl = visualElements.signatoryLabels;
      const sigLabelTypo = typoFor('signatoryLabels');

      const sealVisible = !useVisual || sealEl.visible;
      const sigVisible = !useVisual || sigEl.visible;
      const sigLabelsVisible = !useVisual || sigLabelEl.visible;

      const sealW = useVisual ? Math.max(22, mmToPt(sealEl.widthMm)) : 44;
      const sealH = useVisual ? Math.max(22, Math.min(60, mmToPt(sealEl.heightMm))) : 40;
      const sigImgW = useVisual ? Math.max(36, mmToPt(sigEl.widthMm)) : 112;
      const sigImgH = useVisual ? Math.max(16, Math.min(48, mmToPt(sigEl.heightMm))) : 28;
      const labelsNeeded = sigLabelsVisible ? 26 : 0;
      const blockNeeded = Math.max(sealVisible ? sealH : 0, (sigVisible ? sigImgH : 0) + labelsNeeded) + 4;

      cursorY = ensurePageSpace(blockNeeded + 4);
      cursorY = Math.max(doc.y + 4, cursorY + 4);

      const sealX = useVisual
        ? Math.max(contentLeft, Math.min(contentRight - sealW, mmToPt(sealEl.xMm)))
        : contentRight - 210;
      const sigW = Math.max(120, sigImgW);
      const sigX = useVisual
        ? Math.max(contentLeft, Math.min(contentRight - sigW, mmToPt(sigEl.xMm)))
        : contentRight - 150;

      const sealImgSource = isSupportedPdfImageBuffer(brandingImages?.seal as Buffer | null | undefined)
        ? (brandingImages?.seal as Buffer)
        : resolveSafeLocalImagePath(
            layout.sealUrl || companyProfile?.documentBranding?.sealUrl || companyProfile?.sealUrl
          );

      if (sealVisible && sealImgSource) {
        try {
          const sealAlign = sealEl.align || 'center';
          doc.image(sealImgSource, sealX, cursorY, {
            fit: [sealW, sealH],
            ...(sealAlign === 'center' || sealAlign === 'right' ? { align: sealAlign } : {}),
          });
        } catch {
          // ignore
        }
      }

      const sigImgSource = isSupportedPdfImageBuffer(
        brandingImages?.signature as Buffer | null | undefined
      )
        ? (brandingImages?.signature as Buffer)
        : resolveSafeLocalImagePath(
            layout.signatureUrl ||
              companyProfile?.documentBranding?.signatureUrl ||
              companyProfile?.signatureUrl
          );

      if (sigVisible && sigImgSource) {
        try {
          const sigAlign = sigEl.align || 'center';
          doc.image(sigImgSource, sigX, cursorY, {
            fit: [sigImgW, sigImgH],
            ...(sigAlign === 'center' || sigAlign === 'right' ? { align: sigAlign } : {}),
          });
        } catch {
          // ignore
        }
      }

      if (sigLabelsVisible) {
        const lineY = cursorY + (sigVisible ? Math.max(24, sigImgH + 3) : 14);
        doc
          .moveTo(sigX, lineY)
          .lineTo(sigX + sigW, lineY)
          .strokeColor('#94a3b8')
          .lineWidth(0.75)
          .stroke();

        const signatoryName =
          layout.signatoryName ||
          companyProfile?.documentBranding?.signatoryName ||
          layout.signatureLabel ||
          formatLabelText('authorizedSignature', layout.language);
        const signatoryTitle =
          layout.signatoryTitle || companyProfile?.documentBranding?.signatureTitle || '';

        let sy = writeMixedText(signatoryName, sigX, lineY + 3, {
          width: sigW,
          align: sigLabelTypo.align,
          fontSize: sigLabelTypo.fontSizePt,
          bold: sigLabelTypo.bold,
          fontFamily: sigLabelTypo.fontFamily,
          lineGap: sigLabelTypo.lineGap,
          characterSpacing: sigLabelTypo.letterSpacing,
          color: '#0f172a',
        });
        if (signatoryTitle) {
          sy = writeMixedText(signatoryTitle, sigX, sy + 1, {
            width: sigW,
            align: sigLabelTypo.align,
            fontSize: Math.max(6.5, sigLabelTypo.fontSizePt - 1),
            fontFamily: sigLabelTypo.fontFamily,
            color: '#64748b',
          });
        }
        cursorY = Math.max(sy + 4, cursorY + (sealVisible ? sealH : 0) + 4);
      } else if (sealVisible && sealImgSource) {
        cursorY += sealH + 4;
      }
      doc.y = cursorY;
    }

    // Stamp consistent Footer & Page X of Y across ALL buffered pages without triggering auto-pagination
    const range = doc.bufferedPageRange();
    if (footerVisible && (footerJoined || range.count > 1)) {
      const footerY = Math.max(
        bottomLimit + 6,
        Math.min(pageH - measuredFooterH - 6, pageH - margins.bottom - measuredFooterH)
      );
      for (let pageIdx = 0; pageIdx < range.count; pageIdx += 1) {
        doc.switchToPage(range.start + pageIdx);
        const savedBottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;

        doc
          .moveTo(contentLeft, footerY - 3)
          .lineTo(contentRight, footerY - 3)
          .strokeColor('#e2e8f0')
          .lineWidth(0.5)
          .stroke();

        const pageCounterText = `Page ${pageIdx + 1} of ${range.count}`;
        if (footerJoined && footerTypo.align === 'right') {
          writeMixedText(`${footerJoined}  |  ${pageCounterText}`, footerX, footerY, {
            width: rawFooterW,
            align: 'right',
            fontSize: footerTypo.fontSizePt,
            bold: footerTypo.bold,
            fontFamily: footerTypo.fontFamily,
            lineGap: footerTypo.lineGap,
            characterSpacing: footerTypo.letterSpacing,
            color: '#64748b',
          });
        } else {
          if (footerJoined) {
            writeMixedText(footerJoined, footerX, footerY, {
              width: footerTextW,
              align: footerTypo.align,
              fontSize: footerTypo.fontSizePt,
              bold: footerTypo.bold,
              fontFamily: footerTypo.fontFamily,
              lineGap: footerTypo.lineGap,
              characterSpacing: footerTypo.letterSpacing,
              color: '#64748b',
            });
          }
          writeMixedText(pageCounterText, contentRight - pageNumReserveW, footerY, {
            width: pageNumReserveW,
            align: 'right',
            fontSize: Math.max(7, footerTypo.fontSizePt),
            bold: false,
            fontFamily: footerTypo.fontFamily,
            color: '#64748b',
          });
        }

        doc.page.margins.bottom = savedBottomMargin;
      }
    }

    doc.end();
    return completionPromise;
  }

  /**
   * Exposed for verifying company profile / permission rules in unit tests.
   */
  static async isAuthorizedToViewBankDetails(actor: AuthUser): Promise<boolean> {
    return CompanyBankAccountService.canViewBankDetails(actor);
  }
}

export { prisma };
