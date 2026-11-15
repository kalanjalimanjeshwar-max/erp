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
} from '../../shared/types.js';
import { PAPER_DIMENSIONS_MM } from '../../shared/print-settings.js';
import { createDefaultVisualElements } from '../../shared/branding.js';
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
    const visualElements =
      layout.elements ||
      createDefaultVisualElements(layout.paperSize, layout.orientation, layout.margins);

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
    const fontRegularKn = fonts.kannadaRegular ? 'KannadaRegular' : fontRegularLatin;
    const fontBoldKn = fonts.kannadaBold ? 'KannadaBold' : fontBoldLatin;

    if (fonts.latinRegular) doc.registerFont('LatinRegular', fonts.latinRegular);
    if (fonts.latinBold) doc.registerFont('LatinBold', fonts.latinBold);
    if (fonts.kannadaRegular) doc.registerFont('KannadaRegular', fonts.kannadaRegular);
    if (fonts.kannadaBold) doc.registerFont('KannadaBold', fonts.kannadaBold);

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    const completionPromise = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    // Helper for mixed Latin + Kannada text rendering
    const writeMixedText = (
      text: string,
      x: number,
      y: number,
      options?: {
        width?: number;
        align?: 'left' | 'center' | 'right';
        fontSize?: number;
        bold?: boolean;
        color?: string;
        lineGap?: number;
      }
    ): number => {
      const fontSize = options?.fontSize ?? 9.5;
      const bold = options?.bold ?? false;
      const color = options?.color ?? '#0f172a';
      const align = options?.align ?? 'left';
      const width = options?.width;
      const lineGap = options?.lineGap ?? 2;

      const cleanText = String(text ?? '');
      const segments = cleanText.split(/([\u0C80-\u0CFF]+)/).filter(Boolean);

      doc.fillColor(color).fontSize(fontSize);

      if (segments.length === 0) {
        return y;
      }

      if (segments.length === 1) {
        const isKn = /[\u0C80-\u0CFF]/.test(segments[0]);
        doc.font(isKn ? (bold ? fontBoldKn : fontRegularKn) : bold ? fontBoldLatin : fontRegularLatin);
        doc.text(segments[0], x, y, { width, align, lineGap });
        return doc.y;
      }

      segments.forEach((seg, idx) => {
        const isKn = /[\u0C80-\u0CFF]/.test(seg);
        doc.font(isKn ? (bold ? fontBoldKn : fontRegularKn) : bold ? fontBoldLatin : fontRegularLatin);
        const isFirst = idx === 0;
        const isLast = idx === segments.length - 1;
        if (isFirst) {
          doc.text(seg, x, y, { width, align, lineGap, continued: !isLast });
        } else {
          doc.text(seg, { width, align, lineGap, continued: !isLast });
        }
      });

      return doc.y;
    };

    const measureMixedHeight = (text: string, width: number, fontSize: number, bold = false): number => {
      const isKn = /[\u0C80-\u0CFF]/.test(text);
      doc.font(isKn ? (bold ? fontBoldKn : fontRegularKn) : bold ? fontBoldLatin : fontRegularLatin);
      doc.fontSize(fontSize);
      return doc.heightOfString(text || '', { width, lineGap: 2 });
    };

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentLeft = margins.left;
    const contentRight = pageW - margins.right;
    const contentWidth = contentRight - contentLeft;
    const bottomLimit = pageH - margins.bottom - 24;

    const ensurePageSpace = (neededPt: number) => {
      if (doc.y + neededPt > bottomLimit) {
        doc.addPage();
        doc.y = margins.top;
      }
    };

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
        fontSize: 8,
        color: '#64748b',
      });
      cursorY += 4;
      doc
        .moveTo(contentLeft, cursorY)
        .lineTo(contentRight, cursorY)
        .strokeColor('#cbd5e1')
        .lineWidth(0.5)
        .stroke();
      cursorY += 8;
    }

    // Header: Company Logo, Company Header Block, Document Title/Number using Visual Elements
    const headerStartY = cursorY;
    const headerBannerShift = Math.max(0, headerStartY - margins.top);

    const logoEl = visualElements.logo;
    const headerEl = visualElements.companyHeader;
    const titleEl = visualElements.documentTitle;

    const useVisual = Boolean(layout.visualLayoutEnabled);

    const logoX = useVisual ? Math.max(contentLeft, mmToPt(logoEl.xMm)) : contentLeft;
    const logoY = useVisual ? Math.max(headerStartY, mmToPt(logoEl.yMm) + headerBannerShift) : headerStartY;
    const logoW = useVisual ? Math.max(24, mmToPt(logoEl.widthMm)) : 102;
    const logoH = useVisual
      ? Math.max(16, mmToPt(logoEl.heightMm))
      : layout.logoSize === 'sm'
      ? 28
      : layout.logoSize === 'lg'
      ? 48
      : 36;

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
          logoBottomY = logoY + logoH + mmToPt(logoEl.spacingMm || 3);
        } catch {
          // ignore unreadable image
        }
      }
    }

    const headerX = useVisual ? Math.max(contentLeft, mmToPt(headerEl.xMm)) : contentLeft;
    const headerW = useVisual
      ? Math.max(80, Math.min(contentRight - headerX, mmToPt(headerEl.widthMm)))
      : contentWidth * 0.56;
    let leftY = useVisual
      ? Math.max(headerStartY, mmToPt(headerEl.yMm) + headerBannerShift)
      : logoBottomY;

    // Prevent vertical overlap if logo and company header sit in the same horizontal span
    const horizontalOverlap =
      logoVisible &&
      logoBottomY > headerStartY &&
      headerX < logoX + logoW &&
      headerX + headerW > logoX;
    if (horizontalOverlap && leftY < logoBottomY) {
      leftY = logoBottomY;
    }

    const headerAlign = useVisual ? headerEl.align : 'left';
    const headerVisible = !useVisual || headerEl.visible;

    if (headerVisible) {
      if (layout.showCompanyName) {
        leftY = writeMixedText(companyName, headerX, leftY, {
          width: headerW,
          align: headerAlign,
          fontSize: 15,
          bold: true,
          color: '#0f172a',
        });
        if (companyProfile?.legalName && companyProfile.legalName !== companyName) {
          leftY = writeMixedText(companyProfile.legalName, headerX, leftY + 1, {
            width: headerW,
            align: headerAlign,
            fontSize: 8.5,
            color: '#475569',
          });
        }
      }

      if (layout.showCompanyContact) {
        if (companyProfile?.address) {
          leftY = writeMixedText(companyProfile.address, headerX, leftY + 2, {
            width: headerW,
            align: headerAlign,
            fontSize: 8.5,
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
            fontSize: 8.5,
            color: '#475569',
          });
        }
      }

      if (layout.showCompanyTaxId && companyProfile?.taxId) {
        leftY = writeMixedText(
          `${formatLabelText('taxId', layout.language)}: ${companyProfile.taxId}`,
          headerX,
          leftY + 2,
          {
            width: headerW,
            align: headerAlign,
            fontSize: 8.5,
            bold: true,
            color: '#334155',
          }
        );
      }
      leftY += mmToPt(headerEl.spacingMm || 2);
    }

    const titleX = useVisual
      ? Math.max(contentLeft, mmToPt(titleEl.xMm))
      : contentLeft + contentWidth * 0.58;
    const titleW = useVisual
      ? Math.max(70, Math.min(contentRight - titleX, mmToPt(titleEl.widthMm)))
      : contentWidth * 0.42;
    let rightY = useVisual
      ? Math.max(headerStartY, mmToPt(titleEl.yMm) + headerBannerShift)
      : headerStartY;
    const titleAlign: 'left' | 'center' | 'right' = useVisual
      ? titleEl.align
      : layout.titlePlacement === 'left'
      ? 'left'
      : layout.titlePlacement === 'center'
      ? 'center'
      : 'right';

    if (!useVisual || titleEl.visible) {
      rightY = writeMixedText(resolvedTitle.toUpperCase(), titleX, rightY, {
        width: titleW,
        align: titleAlign,
        fontSize: 15,
        bold: true,
        color: '#0f172a',
      });

      rightY = writeMixedText(
        `${formatLabelText(docNumberLabelKey, layout.language)}: ${docNumber || 'DRAFT PREVIEW'}`,
        titleX,
        rightY + 4,
        {
          width: titleW,
          align: titleAlign,
          fontSize: 9.5,
          bold: true,
          color: '#1e293b',
        }
      );
      rightY += mmToPt(titleEl.spacingMm || 2);
    }

    cursorY = Math.max(logoBottomY, leftY, rightY) + 8;
    doc
      .moveTo(contentLeft, cursorY)
      .lineTo(contentRight, cursorY)
      .strokeColor('#0f172a')
      .lineWidth(1.4)
      .stroke();
    cursorY += 12;

    // Party + Metadata 2-Column Boxes
    const boxGap = 12;
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
        size: 7.5,
        bold: true,
        color: '#64748b',
      },
      {
        text: docPayload.data.customerName,
        size: 10.5,
        bold: true,
        color: '#0f172a',
      },
    ];

    if (docPayload.type !== 'RECEIPT') {
      if (layout.showCustomerAddress && docPayload.data.customerAddress) {
        partyLines.push({
          text: docPayload.data.customerAddress,
          size: 8.5,
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
          size: 8.5,
          color: '#475569',
        });
      }
      if (layout.showCustomerTaxId && docPayload.data.customerTaxId) {
        partyLines.push({
          text: `${formatLabelText('taxId', layout.language)}: ${docPayload.data.customerTaxId}`,
          size: 8.5,
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

    const metaRows: Array<{ label: string; value: string }> = [
      { label: formatLabelText('date', layout.language), value: docDate },
    ];
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

    const innerPad = 8;
    const partyInnerW = boxW - innerPad * 2;
    let estPartyH = innerPad * 2;
    for (const pl of partyLines) {
      estPartyH += measureMixedHeight(pl.text, partyInnerW, pl.size, pl.bold) + 3;
    }
    const estMetaH = innerPad * 2 + metaRows.length * 14;
    const boxH = Math.max(estPartyH, estMetaH, 68);

    // Draw Party Box
    doc
      .roundedRect(contentLeft, boxStartY, boxW, boxH, 4)
      .fillAndStroke('#f8fafc', '#cbd5e1');

    let py = boxStartY + innerPad;
    for (const pl of partyLines) {
      py = writeMixedText(pl.text, contentLeft + innerPad, py, {
        width: partyInnerW,
        fontSize: pl.size,
        bold: pl.bold,
        color: pl.color,
      });
      py += 2;
    }

    // Draw Metadata Box
    const metaX = contentLeft + boxW + boxGap;
    doc.roundedRect(metaX, boxStartY, boxW, boxH, 4).strokeColor('#cbd5e1').lineWidth(0.75).stroke();

    let my = boxStartY + innerPad;
    for (const row of metaRows) {
      writeMixedText(`${row.label}:`, metaX + innerPad, my, {
        width: boxW * 0.52,
        fontSize: 8.5,
        color: '#64748b',
      });
      writeMixedText(row.value, metaX + boxW * 0.5, my, {
        width: boxW * 0.5 - innerPad,
        align: 'right',
        fontSize: 8.5,
        bold: true,
        color: '#0f172a',
      });
      my += 14;
    }

    cursorY = boxStartY + boxH + 14;

    // Line Items Table (Quotation / Invoice) or Receipt Summary
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
        let headerH = 20;
        for (const col of cols) {
          headerH = Math.max(headerH, measureMixedHeight(col.label, col.widthPt - 8, 7.5, true) + 10);
        }
        doc.rect(contentLeft, y, contentWidth, headerH).fill('#0f172a');
        let cx = contentLeft;
        for (const col of cols) {
          writeMixedText(col.label, cx + 4, y + 5, {
            width: col.widthPt - 8,
            align: col.align,
            fontSize: 7.5,
            bold: true,
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

        const rowPadY = layout.serviceLayout === 'compact' ? 4 : 6;
        let rowH = layout.serviceLayout === 'compact' ? 18 : 22;
        for (const col of cols) {
          const val = cellValues[col.key] || '';
          const h = measureMixedHeight(val, col.widthPt - 8, 8.5, col.key === 'amt') + rowPadY * 2;
          if (h > rowH) rowH = h;
        }

        if (cursorY + rowH > bottomLimit) {
          doc.addPage();
          cursorY = margins.top;
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
      doc.roundedRect(contentLeft, cursorY, contentWidth, 34, 4).fillAndStroke('#f8fafc', '#cbd5e1');
      writeMixedText(formatLabelText('amountReceived', layout.language), contentLeft + 10, cursorY + 11, {
        width: contentWidth * 0.5,
        fontSize: 9.5,
        bold: true,
        color: '#475569',
      });
      writeMixedText(fmt(docPayload.data.amount), contentLeft + contentWidth * 0.5, cursorY + 10, {
        width: contentWidth * 0.5 - 10,
        align: 'right',
        fontSize: 12,
        bold: true,
        color: '#0f172a',
      });
      cursorY += 44;
    }

    cursorY += 12;
    doc.y = cursorY;
    ensurePageSpace(95);
    cursorY = doc.y;

    // Bank Details (left) + Totals Box (right)
    const summaryStartY = cursorY;
    const bankW = contentWidth * 0.52;
    const totalsW = contentWidth * 0.44;
    const totalsX = contentRight - totalsW;

    let bankEndY = summaryStartY;
    if (layout.showBankDetails && bankAccount) {
      const bankLines: string[] = [
        `${formatLabelText('bankName', layout.language)}: ${bankAccount.bankName}${
          bankAccount.branchName ? ` (${bankAccount.branchName})` : ''
        }`,
        `${formatLabelText('accountHolder', layout.language)}: ${bankAccount.accountHolderName}`,
        `${formatLabelText('accountNumber', layout.language)}: ${bankAccount.accountNumber}`,
      ];
      if (bankAccount.routingCode) {
        bankLines.push(`${formatLabelText('routingIfsc', layout.language)}: ${bankAccount.routingCode}`);
      }
      if (bankAccount.upiId) {
        bankLines.push(`${formatLabelText('upiId', layout.language)}: ${bankAccount.upiId}`);
      }

      const bankBoxH = 22 + bankLines.length * 13;
      doc.roundedRect(contentLeft, summaryStartY, bankW, bankBoxH, 4).fillAndStroke('#f8fafc', '#cbd5e1');

      let by = summaryStartY + 7;
      by = writeMixedText(formatLabelText('bankDetails', layout.language).toUpperCase(), contentLeft + 8, by, {
        width: bankW - 16,
        fontSize: 7.5,
        bold: true,
        color: '#475569',
      });
      by += 3;
      for (const line of bankLines) {
        by = writeMixedText(line, contentLeft + 8, by, {
          width: bankW - 16,
          fontSize: 8.2,
          color: '#0f172a',
        });
        by += 2;
      }
      bankEndY = summaryStartY + bankBoxH;
    }

    let totalsEndY = summaryStartY;
    if (layout.showTotalsSummary) {
      const totalRows: Array<{ label: string; value: string; bold?: boolean; topBorder?: boolean }> = [];
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

      const totalsBoxH = 14 + totalRows.length * 16;
      doc.roundedRect(totalsX, summaryStartY, totalsW, totalsBoxH, 4).strokeColor('#cbd5e1').lineWidth(0.75).stroke();

      let ty = summaryStartY + 8;
      for (const row of totalRows) {
        if (row.topBorder) {
          doc
            .moveTo(totalsX + 8, ty - 2)
            .lineTo(totalsX + totalsW - 8, ty - 2)
            .strokeColor('#cbd5e1')
            .lineWidth(0.5)
            .stroke();
        }
        writeMixedText(row.label, totalsX + 8, ty, {
          width: totalsW * 0.56,
          fontSize: row.bold ? 9.5 : 8.5,
          bold: row.bold,
          color: row.bold ? '#0f172a' : '#475569',
        });
        writeMixedText(row.value, totalsX + totalsW * 0.5, ty, {
          width: totalsW * 0.5 - 8,
          align: 'right',
          fontSize: row.bold ? 9.5 : 8.5,
          bold: row.bold,
          color: '#0f172a',
        });
        ty += 16;
      }
      totalsEndY = summaryStartY + totalsBoxH;
    }

    cursorY = Math.max(bankEndY, totalsEndY) + 14;
    doc.y = cursorY;

    // Notes & Terms
    const notesText = docPayload.data.notes;
    const termsText =
      (docPayload.type !== 'RECEIPT' ? docPayload.data.terms : null) || layout.defaultTermsText;

    if (notesText) {
      ensurePageSpace(40);
      cursorY = doc.y;
      cursorY = writeMixedText(formatLabelText('notes', layout.language).toUpperCase(), contentLeft, cursorY, {
        width: contentWidth,
        fontSize: 7.5,
        bold: true,
        color: '#64748b',
      });
      cursorY = writeMixedText(notesText, contentLeft, cursorY + 2, {
        width: contentWidth,
        fontSize: 8.5,
        color: '#334155',
      });
      cursorY += 8;
      doc.y = cursorY;
    }

    if (layout.showTermsAndConditions && termsText) {
      ensurePageSpace(40);
      cursorY = doc.y;
      cursorY = writeMixedText(
        formatLabelText('termsAndConditions', layout.language).toUpperCase(),
        contentLeft,
        cursorY,
        {
          width: contentWidth,
          fontSize: 7.5,
          bold: true,
          color: '#64748b',
        }
      );
      cursorY = writeMixedText(termsText, contentLeft, cursorY + 2, {
        width: contentWidth,
        fontSize: 8.5,
        color: '#334155',
      });
      cursorY += 10;
      doc.y = cursorY;
    }

    // Authorized Signature & Seal
    if (layout.showSignatureSection) {
      const sealEl = visualElements.seal;
      const sigEl = visualElements.signature;
      const useVisualSig = Boolean(layout.visualLayoutEnabled);

      const sealW = useVisualSig ? Math.max(24, mmToPt(sealEl.widthMm)) : 48;
      const sealH = useVisualSig ? Math.max(24, mmToPt(sealEl.heightMm)) : 42;
      const sigImgW = useVisualSig ? Math.max(40, mmToPt(sigEl.widthMm)) : 120;
      const sigImgH = useVisualSig ? Math.max(18, mmToPt(sigEl.heightMm)) : 32;
      const blockNeeded = Math.max(sealH, sigImgH) + 34;

      ensurePageSpace(blockNeeded);
      cursorY = Math.max(doc.y + 10, cursorY + 10);

      const sealX = useVisualSig
        ? Math.max(contentLeft, Math.min(contentRight - sealW, mmToPt(sealEl.xMm)))
        : contentRight - 220;
      const sigW = Math.max(130, sigImgW);
      const sigX = useVisualSig
        ? Math.max(contentLeft, Math.min(contentRight - sigW, mmToPt(sigEl.xMm)))
        : contentRight - 160;

      const sealImgSource = isSupportedPdfImageBuffer(brandingImages?.seal as Buffer | null | undefined)
        ? (brandingImages?.seal as Buffer)
        : resolveSafeLocalImagePath(
            layout.sealUrl || companyProfile?.documentBranding?.sealUrl || companyProfile?.sealUrl
          );

      if ((!useVisualSig || sealEl.visible) && sealImgSource) {
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

      const sigVisible = !useVisualSig || sigEl.visible;
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

      if (sigVisible) {
        const lineY = cursorY + Math.max(28, sigImgH + 4);
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

        let sy = writeMixedText(signatoryName, sigX, lineY + 4, {
          width: sigW,
          align: sigEl.align || 'center',
          fontSize: 8.5,
          bold: true,
          color: '#0f172a',
        });
        if (signatoryTitle) {
          sy = writeMixedText(signatoryTitle, sigX, sy + 1, {
            width: sigW,
            align: sigEl.align || 'center',
            fontSize: 7.5,
            color: '#64748b',
          });
        }
        cursorY = Math.max(sy + 10, cursorY + Math.max(sealH, sigImgH + 26));
      } else if (sealImgSource && (!useVisualSig || sealEl.visible)) {
        cursorY += sealH + 10;
      }
    }

    // Footer & Timestamp
    const footerEl = visualElements.footer;
    const footerVisible = !layout.visualLayoutEnabled || footerEl.visible;
    if (footerVisible && (layout.footerText || layout.showPrintedTimestamp)) {
      const printedAtLabel = formatDateTimeInTimezone(new Date(), timezone, {
        includeZoneAbbr: true,
      });
      const footerParts = [
        layout.footerText || '',
        layout.showPrintedTimestamp
          ? `${formatLabelText('generatedOn', layout.language)}: ${printedAtLabel} (${timezone})`
          : '',
      ].filter(Boolean);

      const footerX = layout.visualLayoutEnabled
        ? Math.max(contentLeft, mmToPt(footerEl.xMm))
        : contentLeft;
      const footerW = layout.visualLayoutEnabled
        ? Math.max(80, Math.min(contentRight - footerX, mmToPt(footerEl.widthMm)))
        : contentWidth;
      const footerY = Math.min(
        pageH - margins.bottom - 10,
        Math.max(cursorY + 8, pageH - margins.bottom - 14)
      );
      doc
        .moveTo(contentLeft, footerY - 4)
        .lineTo(contentRight, footerY - 4)
        .strokeColor('#e2e8f0')
        .lineWidth(0.5)
        .stroke();

      writeMixedText(footerParts.join('  |  '), footerX, footerY, {
        width: footerW,
        align: layout.visualLayoutEnabled ? footerEl.align : 'left',
        fontSize: 7.5,
        color: '#64748b',
      });
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
