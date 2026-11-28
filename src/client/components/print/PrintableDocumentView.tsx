import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  Download,
  FileDown,
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  Maximize2,
  Printer,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  AuthUser,
  CompanyBankAccountItem,
  CompanyProfile,
  CustomerReceiptItem,
  DocumentCopyLabel,
  DocumentLanguage,
  DocumentPrintLayoutConfig,
  DocumentPrintType,
  InvoiceItem,
  PageOrientation,
  PaperSize,
  QuotationItem,
  VisualElementKey,
  VisualTextFontFamily,
} from '../../../shared/types.ts';
import {
  getEffectivePaperDimensionsMm,
  getVisualElementTypography,
  MAX_BRANDING_FILE_SIZE_BYTES,
  normalizeDocumentVisualElements,
} from '../../../shared/branding.ts';
import {
  DocumentPrintLabelKey,
  getDocumentLabel,
} from '../../../shared/print-translations.ts';
import { formatMoney, normalizeCurrencyCode } from '../../../shared/currency.ts';
import { formatDateTimeInTimezone, getEffectiveTimeZone } from '../../../shared/timezone.ts';
import {
  buildExportFileName,
  type DocumentExportBrandingImages,
  formatCompanyAddressLines,
  formatCopyLabelText,
  resolveCompanyContactParts,
  resolveCompanyTaxId,
  resolveDocumentEffectiveBranding,
  resolvePaymentQrDisplaySizeMm,
  shouldDisplayPaymentQr,
} from '../../../shared/export/document-branding.ts';
import { api, ApiError } from '../../services/api.ts';

export type PrintableDocumentPayload =
  | { type: 'QUOTATION'; data: QuotationItem }
  | { type: 'INVOICE'; data: InvoiceItem }
  | { type: 'RECEIPT'; data: CustomerReceiptItem };

/**
 * Stable identity key used to reset per-document preview/export overrides
 * whenever the user switches to a different document or document type.
 */
export function getDocumentPreviewResetKey(document: PrintableDocumentPayload): string {
  const id = (document.data as { id?: string | null }).id || '';
  return `${document.type}:${id}`;
}

/**
 * Safely decodes a validated raster `data:image/(png|jpeg|jpg);base64,...` URI
 * for Preview Mode DOCX export. Validates strict MIME allowlist, size limit,
 * and actual PNG/JPEG magic bytes so SVG/HTML/arbitrary schemes are rejected.
 */
export function decodePreviewRasterDataUri(url: string): Uint8Array | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) return null;

  const declaredKind = match[1].toLowerCase();
  const base64Payload = match[2].replace(/\s+/g, '');
  if (!base64Payload) return null;

  // Quick pre-decode upper-bound guard against oversized payloads
  const estimatedBytes = Math.ceil((base64Payload.length * 3) / 4);
  if (estimatedBytes > MAX_BRANDING_FILE_SIZE_BYTES + 4) return null;

  let bytes: Uint8Array;
  try {
    if (typeof atob === 'function') {
      const binary = atob(base64Payload);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
    } else if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(base64Payload, 'base64');
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  if (bytes.length < 8 || bytes.length > MAX_BRANDING_FILE_SIZE_BYTES) return null;

  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

  if (declaredKind === 'png' && !isPng) return null;
  if ((declaredKind === 'jpeg' || declaredKind === 'jpg') && !isJpeg) return null;
  if (!isPng && !isJpeg) return null;

  return bytes;
}

interface PrintableDocumentViewProps {
  document: PrintableDocumentPayload;
  companyProfile?: CompanyProfile | null;
  layoutOverride?: DocumentPrintLayoutConfig;
  bankAccount?: CompanyBankAccountItem | null;
  currentUser?: AuthUser | null;
  isDraftPreview?: boolean;
  embedded?: boolean;
  onBackToEdit?: () => void;
  onClose?: () => void;
}

function resolveCssFontFamily(family: VisualTextFontFamily): string {
  if (family === 'serif') {
    return `'Georgia', 'Times New Roman', 'Noto Sans Kannada', serif`;
  }
  if (family === 'mono') {
    return `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Noto Sans Kannada', monospace`;
  }
  if (family === 'noto-kannada') {
    return `'Noto Sans Kannada', 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif`;
  }
  return `'Plus Jakarta Sans', 'Noto Sans Kannada', ui-sans-serif, system-ui, sans-serif`;
}

const BilingualText: React.FC<{
  labelKey: DocumentPrintLabelKey;
  language: DocumentLanguage;
  className?: string;
  secondaryClassName?: string;
  inline?: boolean;
}> = ({ labelKey, language, className = '', secondaryClassName = '', inline = false }) => {
  const { primary, secondary } = getDocumentLabel(labelKey, language);
  if (!secondary) {
    return <span className={className}>{primary}</span>;
  }
  if (inline) {
    return (
      <span className={className}>
        {primary}{' '}
        <span className={`font-kannada font-normal opacity-80 ${secondaryClassName}`}>
          / {secondary}
        </span>
      </span>
    );
  }
  return (
    <span className={`inline-flex flex-col ${className}`}>
      <span>{primary}</span>
      <span className={`font-kannada text-[0.85em] font-normal opacity-80 ${secondaryClassName}`}>
        {secondary}
      </span>
    </span>
  );
};

export const PrintableDocumentView: React.FC<PrintableDocumentViewProps> = ({
  document,
  companyProfile,
  layoutOverride,
  bankAccount,
  currentUser,
  isDraftPreview = false,
  embedded = false,
  onBackToEdit,
  onClose,
}) => {
  const docType: DocumentPrintType = document.type;
  const [exportingFormat, setExportingFormat] = useState<
    'pdf' | 'docx' | 'xlsx' | 'jpg' | 'png' | null
  >(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  const exportOptionsRef = useRef<HTMLDivElement | null>(null);

  const resolvedBranding = useMemo(
    () =>
      resolveDocumentEffectiveBranding(
        document,
        companyProfile,
        layoutOverride,
        isDraftPreview
      ),
    [document, companyProfile, layoutOverride, isDraftPreview]
  );

  const effectiveProfile = resolvedBranding.effectiveProfile;
  const resolvedSavedLayout = resolvedBranding.layout;

  // Temporary interactive preview & export overrides (never mutate saved DB config)
  const [previewLanguage, setPreviewLanguage] = useState<DocumentLanguage | null>(null);
  const [previewPaperSize, setPreviewPaperSize] = useState<PaperSize | null>(null);
  const [previewOrientation, setPreviewOrientation] = useState<PageOrientation | null>(null);
  const [imageQuality, setImageQuality] = useState<'standard' | 'high'>('standard');
  const [copyLabel, setCopyLabel] = useState<DocumentCopyLabel | ''>('');
  const [includePaymentQrOverride, setIncludePaymentQrOverride] = useState<boolean | undefined>(
    undefined
  );

  // Reset per-document temporary preview/export overrides whenever the active document changes
  const documentResetKey = getDocumentPreviewResetKey(document);
  useEffect(() => {
    setPreviewLanguage(null);
    setPreviewPaperSize(null);
    setPreviewOrientation(null);
    setImageQuality('standard');
    setCopyLabel('');
    setIncludePaymentQrOverride(undefined);
    setExportError(null);
  }, [documentResetKey]);

  const layout: DocumentPrintLayoutConfig = useMemo(
    () => ({
      ...resolvedSavedLayout,
      language: previewLanguage || resolvedSavedLayout.language,
      paperSize: previewPaperSize || resolvedSavedLayout.paperSize,
      orientation: previewOrientation || resolvedSavedLayout.orientation,
    }),
    [resolvedSavedLayout, previewLanguage, previewPaperSize, previewOrientation]
  );

  // Close dropdown menus when clicking outside
  useEffect(() => {
    if (!showDownloadMenu && !showExportOptions) return;
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        showDownloadMenu &&
        downloadMenuRef.current &&
        target &&
        !downloadMenuRef.current.contains(target)
      ) {
        setShowDownloadMenu(false);
      }
      if (
        showExportOptions &&
        exportOptionsRef.current &&
        target &&
        !exportOptionsRef.current.contains(target)
      ) {
        setShowExportOptions(false);
      }
    };
    window.document.addEventListener('mousedown', handleOutside);
    return () => window.document.removeEventListener('mousedown', handleOutside);
  }, [showDownloadMenu, showExportOptions]);

  const visualElements = useMemo(
    () =>
      normalizeDocumentVisualElements(
        layout.elements,
        layout.paperSize,
        layout.orientation,
        layout.margins
      ),
    [layout]
  );
  const useVisual = Boolean(layout.visualLayoutEnabled);

  const elStyle = (key: VisualElementKey): React.CSSProperties => {
    const el = visualElements[key];
    const typo = getVisualElementTypography(el);
    return {
      fontSize: `${typo.fontSizePt}pt`,
      fontWeight: typo.fontWeight,
      fontFamily: resolveCssFontFamily(typo.fontFamily),
      lineHeight: typo.lineHeight,
      letterSpacing: `${typo.letterSpacing}pt`,
      textAlign: typo.align,
      overflowWrap: 'break-word',
      wordBreak: 'break-word',
    };
  };

  // Coordinate body print portal flags cleanly on mount/unmount
  useEffect(() => {
    if (typeof window === 'undefined' || !window.document?.body) return;
    const body = window.document.body;
    body.classList.add('coreerp-has-print-portal');
    if (!embedded) {
      body.classList.add('coreerp-has-print-modal');
    }

    return () => {
      // Check remaining portals on next microtask after unmount
      window.setTimeout(() => {
        if (!window.document?.body) return;
        const anyPortals = window.document.body.querySelectorAll('.coreerp-print-portal').length > 0;
        const anyModals =
          window.document.body.querySelectorAll('.coreerp-print-portal--modal').length > 0;
        if (!anyPortals) {
          window.document.body.classList.remove('coreerp-has-print-portal');
        }
        if (!anyModals) {
          window.document.body.classList.remove('coreerp-has-print-modal');
        }
      }, 0);
    };
  }, [embedded]);

  const canDisplayBankDetails = Boolean(
    layout.showBankDetails && bankAccount && currentUser?.role !== 'EMPLOYEE'
  );

  const { widthMm: sheetWidthMm, heightMm: sheetMinHeightMm } = getEffectivePaperDimensionsMm(
    layout.paperSize,
    layout.orientation
  );

  const companyName = effectiveProfile?.name || 'CoreERP Enterprise';
  const timezone = getEffectiveTimeZone(effectiveProfile?.timezone);
  const roundingPrecision = effectiveProfile?.roundingPrecision ?? 2;

  const documentCurrency = normalizeCurrencyCode(
    document.data.currency || effectiveProfile?.currency,
    effectiveProfile?.currency || 'INR'
  );

  const fmt = (amount: string | number | null | undefined) =>
    formatMoney(amount, documentCurrency, {
      decimals: roundingPrecision,
      displayMode: layout.currencyDisplayMode,
    });

  const printedAtLabel = formatDateTimeInTimezone(new Date(), timezone, {
    includeZoneAbbr: true,
  });

  const defaultTitleKey: DocumentPrintLabelKey =
    docType === 'QUOTATION' ? 'quotation' : docType === 'INVOICE' ? 'invoice' : 'receipt';
  const defaultTitleEntry = getDocumentLabel(defaultTitleKey, layout.language);
  const effectiveCustomTitle =
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
    document.type !== 'RECEIPT' && document.data.documentTitle?.trim()
      ? document.data.documentTitle.trim()
      : null;
  const documentSpecificTitle =
    rawDocTitle && !(layout.language !== 'EN' && defaultTitleStrings.has(rawDocTitle.toUpperCase()))
      ? rawDocTitle
      : null;

  const docNumber =
    document.type === 'QUOTATION'
      ? document.data.quotationNumber
      : document.type === 'INVOICE'
      ? document.data.invoiceNumber
      : document.data.receiptNumber;

  const docNumberLabelKey: DocumentPrintLabelKey =
    docType === 'QUOTATION'
      ? 'quotationNumber'
      : docType === 'INVOICE'
      ? 'invoiceNumber'
      : 'receiptNumber';

  const logoSizeClass =
    layout.logoSize === 'sm' ? 'h-9' : layout.logoSize === 'lg' ? 'h-16' : 'h-12';

  const resolvedLogoUrl =
    effectiveProfile?.brandingAssets?.logo?.url || effectiveProfile?.logoUrl || '';
  const resolvedSignatureUrl =
    layout.signatureUrl ||
    effectiveProfile?.documentBranding?.signatureUrl ||
    effectiveProfile?.signatureUrl ||
    effectiveProfile?.brandingAssets?.signature?.url ||
    '';
  const resolvedSealUrl =
    layout.sealUrl ||
    effectiveProfile?.documentBranding?.sealUrl ||
    effectiveProfile?.sealUrl ||
    effectiveProfile?.brandingAssets?.seal?.url ||
    '';
  const resolvedPaymentQrUrl =
    layout.paymentQrUrl ||
    effectiveProfile?.documentBranding?.paymentQrUrl ||
    effectiveProfile?.paymentQrUrl ||
    effectiveProfile?.brandingAssets?.paymentQr?.url ||
    '';
  const resolvedSignatoryName =
    layout.signatoryName || effectiveProfile?.documentBranding?.signatoryName || '';
  const resolvedSignatoryTitle =
    layout.signatoryTitle || effectiveProfile?.documentBranding?.signatureTitle || '';

  const companyAddressLines = useMemo(
    () => formatCompanyAddressLines(effectiveProfile),
    [effectiveProfile]
  );
  const companyContactParts = useMemo(
    () => resolveCompanyContactParts(effectiveProfile),
    [effectiveProfile]
  );
  const resolvedCompanyTaxId = useMemo(
    () => resolveCompanyTaxId(effectiveProfile),
    [effectiveProfile]
  );
  const copyLabelBadgeText = formatCopyLabelText(copyLabel || undefined);
  const showPaymentQrOnSheet = shouldDisplayPaymentQr({
    layout,
    document,
    qrSource: resolvedPaymentQrUrl,
    includePaymentQrOverride,
  });
  const paymentQrSizeMm = resolvePaymentQrDisplaySizeMm(layout.paymentQrSize);
  const paymentQrPosition = layout.paymentQrPosition || 'bottom-right';
  const paymentQrLabel = (layout.paymentQrLabel || 'Scan to Pay').trim();

  const termsText =
    (document.type !== 'RECEIPT' ? document.data.terms : null) || layout.defaultTermsText;
  const notesText = document.data.notes;

  const pageSizeCss = `${layout.paperSize} ${layout.orientation}`;
  const marginCss = `${layout.margins.topMm}mm ${layout.margins.rightMm}mm ${layout.margins.bottomMm}mm ${layout.margins.leftMm}mm`;

  const triggerBlobDownload = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = fileName;
    window.document.body.appendChild(link);
    link.click();
    window.document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const fetchPreviewRasterBytes = async (url?: string | null): Promise<Uint8Array | null> => {
    if (!url) return null;
    if (url.startsWith('data:')) {
      return decodePreviewRasterDataUri(url);
    }
    if (!url.startsWith('/')) return null;
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return null;
      const buf = new Uint8Array(await resp.arrayBuffer());
      return buf;
    } catch {
      return null;
    }
  };

  const handleExportPdf = async () => {
    setExportError(null);
    setShowDownloadMenu(false);
    if (currentUser?.isPreview) {
      window.print();
      return;
    }
    try {
      setExportingFormat('pdf');
      const { blob, fileName } = await api.exportDocumentPdf({
        document,
        layoutOverride: layout,
        isDraftPreview,
        copyLabel: copyLabel || undefined,
        includePaymentQr: includePaymentQrOverride,
      });
      triggerBlobDownload(
        blob,
        fileName || buildExportFileName(document, 'pdf', isDraftPreview)
      );
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setExportError(err.message);
      } else {
        setExportError('Failed to export PDF document.');
      }
    } finally {
      setExportingFormat(null);
    }
  };

  const handleExportDocx = async () => {
    setExportError(null);
    setShowDownloadMenu(false);
    try {
      setExportingFormat('docx');
      if (currentUser?.isPreview) {
        const [logoBytes, sealBytes, signatureBytes, paymentQrBytes] = await Promise.all([
          fetchPreviewRasterBytes(resolvedLogoUrl),
          fetchPreviewRasterBytes(resolvedSealUrl),
          fetchPreviewRasterBytes(resolvedSignatureUrl),
          showPaymentQrOnSheet ? fetchPreviewRasterBytes(resolvedPaymentQrUrl) : Promise.resolve(null),
        ]);
        const brandingImages: DocumentExportBrandingImages = {
          logo: logoBytes,
          seal: sealBytes,
          signature: signatureBytes,
          paymentQr: paymentQrBytes,
        };
        const { generateDocxBlob } = await import('../../../shared/export/docx-builder.ts');
        const blob = await generateDocxBlob({
          document,
          companyProfile: effectiveProfile,
          layoutOverride: layout,
          bankAccount: canDisplayBankDetails ? bankAccount : null,
          isDraftPreview,
          brandingImages,
          copyLabel: copyLabel || undefined,
          includePaymentQr: includePaymentQrOverride,
        });
        triggerBlobDownload(blob, buildExportFileName(document, 'docx', isDraftPreview));
        return;
      }

      const { blob, fileName } = await api.exportDocumentDocx({
        document,
        layoutOverride: layout,
        isDraftPreview,
        copyLabel: copyLabel || undefined,
        includePaymentQr: includePaymentQrOverride,
      });
      triggerBlobDownload(
        blob,
        fileName || buildExportFileName(document, 'docx', isDraftPreview)
      );
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setExportError(err.message);
      } else {
        setExportError('Failed to export Word document.');
      }
    } finally {
      setExportingFormat(null);
    }
  };

  const handleExportXlsx = async () => {
    setExportError(null);
    setShowDownloadMenu(false);
    try {
      setExportingFormat('xlsx');
      const { generateXlsxBlob } = await import('../../../shared/export/xlsx-builder.ts');
      const blob = generateXlsxBlob({
        document,
        companyProfile: effectiveProfile,
        layoutOverride: layout,
        bankAccount: canDisplayBankDetails ? bankAccount : null,
        isDraftPreview,
        copyLabel: copyLabel || undefined,
        includePaymentQr: includePaymentQrOverride,
      });
      triggerBlobDownload(blob, buildExportFileName(document, 'xlsx', isDraftPreview));
    } catch (err: unknown) {
      setExportError(
        err instanceof Error ? err.message : 'Failed to export Excel spreadsheet.'
      );
    } finally {
      setExportingFormat(null);
    }
  };

  const handleExportImage = async (format: 'jpg' | 'png') => {
    setExportError(null);
    setShowDownloadMenu(false);
    try {
      setExportingFormat(format);
      const { generateDocumentImageExport } = await import('../../utils/invoice-image-export.ts');
      const result = await generateDocumentImageExport(
        {
          document,
          companyProfile: effectiveProfile,
          layoutOverride: layout,
          bankAccount: canDisplayBankDetails ? bankAccount : null,
          isDraftPreview,
          copyLabel: copyLabel || undefined,
          includePaymentQr: includePaymentQrOverride,
        },
        { format, quality: imageQuality }
      );
      triggerBlobDownload(result.blob, result.fileName);
    } catch (err: unknown) {
      setExportError(
        err instanceof Error
          ? err.message
          : `Failed to export ${format.toUpperCase()} image.`
      );
    } finally {
      setExportingFormat(null);
    }
  };

  const renderSheet = (forPrintPortal = false) => (
    <div
      className="print-document-sheet font-print-document bg-white text-slate-900 shadow-xl border border-slate-200 mx-auto"
      style={
        forPrintPortal
          ? {
              width: '100%',
              padding: 0,
            }
          : {
              width: embedded ? '100%' : `${sheetWidthMm}mm`,
              maxWidth: `${sheetWidthMm}mm`,
              minHeight: embedded ? undefined : `${sheetMinHeightMm}mm`,
              padding: embedded
                ? `${Math.max(12, layout.margins.topMm * 1.3)}px ${Math.max(14, layout.margins.rightMm * 1.3)}px`
                : `${layout.margins.topMm}mm ${layout.margins.rightMm}mm ${layout.margins.bottomMm}mm ${layout.margins.leftMm}mm`,
            }
      }
    >
      {/* Optional Custom Header Text */}
      {layout.headerText && (
        <div className="text-[9.5px] text-slate-500 border-b border-slate-200 pb-1 mb-2.5 flex items-center justify-between">
          <span>{layout.headerText}</span>
          {!copyLabelBadgeText && (
            <span className="uppercase tracking-wider font-medium">
              {getDocumentLabel('originalForRecipient', layout.language).primary}
            </span>
          )}
        </div>
      )}

      {/* Header: Company Branding + Document Title */}
      <div
        className={`print-avoid-break flex flex-wrap gap-3 border-b-2 border-slate-900 pb-3 mb-4 ${
          layout.titlePlacement === 'center'
            ? 'flex-col items-center text-center'
            : layout.titlePlacement === 'right'
            ? 'flex-row-reverse justify-between items-start'
            : 'justify-between items-start'
        }`}
      >
        {/* Company Info Block */}
        <div
          className="space-y-0.5"
          style={{
            maxWidth: useVisual ? `${Math.max(visualElements.companyHeader.widthMm, visualElements.companyName.widthMm)}mm` : '24rem',
          }}
        >
          {layout.showLogo && (!useVisual || visualElements.logo.visible) && resolvedLogoUrl && (
            <div
              className={`flex ${
                (useVisual ? visualElements.logo.align : layout.logoPosition) === 'center'
                  ? 'justify-center'
                  : (useVisual ? visualElements.logo.align : layout.logoPosition) === 'right'
                  ? 'justify-end'
                  : 'justify-start'
              }`}
              style={{
                marginBottom: `${visualElements.logo.spacingMm || 2.5}mm`,
              }}
            >
              <img
                src={resolvedLogoUrl}
                alt={companyName}
                className={useVisual ? 'object-contain' : `${logoSizeClass} w-auto object-contain`}
                style={
                  useVisual
                    ? {
                        width: `${visualElements.logo.widthMm}mm`,
                        height: `${visualElements.logo.heightMm}mm`,
                      }
                    : undefined
                }
              />
            </div>
          )}

          {(!useVisual || visualElements.companyName.visible) && layout.showCompanyName && (
            <div style={{ marginBottom: `${visualElements.companyName.spacingMm || 1}mm` }}>
              <div className="text-slate-900" style={elStyle('companyName')}>
                {companyName}
              </div>
              {effectiveProfile?.legalName && effectiveProfile.legalName !== companyName && (
                <div className="text-[10.5px] text-slate-600">{effectiveProfile.legalName}</div>
              )}
            </div>
          )}

          {(!useVisual || visualElements.companyHeader.visible) && (
            <div
              style={{
                ...elStyle('companyHeader'),
                marginBottom: `${visualElements.companyHeader.spacingMm || 2}mm`,
              }}
              className="text-slate-600"
            >
              {layout.showCompanyContact && (
                <div className="space-y-0.5">
                  {companyAddressLines.map((line, index) => (
                    <div key={`${line}-${index}`}>{line}</div>
                  ))}
                  {companyContactParts.length > 0 && (
                    <div
                      className={`flex flex-wrap gap-x-2.5 gap-y-0.5 ${
                        visualElements.companyHeader.align === 'center'
                          ? 'justify-center'
                          : visualElements.companyHeader.align === 'right'
                          ? 'justify-end'
                          : 'justify-start'
                      }`}
                    >
                      {companyContactParts.map((part, idx) => (
                        <span key={`${part}-${idx}`}>{part}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {layout.showCompanyTaxId && resolvedCompanyTaxId && (
                <div className="text-slate-700 font-medium mt-0.5">
                  <BilingualText labelKey="taxId" language={layout.language} inline />:{' '}
                  <span className="font-mono">{resolvedCompanyTaxId}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Document Title & Document Number */}
        <div
          style={{
            maxWidth: useVisual ? `${visualElements.documentTitle.widthMm}mm` : undefined,
          }}
        >
          {copyLabelBadgeText && (
            <div className="mb-1 flex justify-end">
              <span className="inline-block px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border border-slate-400 text-slate-700 rounded bg-slate-50">
                {copyLabelBadgeText}
              </span>
            </div>
          )}

          {(!useVisual || visualElements.documentTitle.visible) && (
            <div
              style={{
                ...elStyle('documentTitle'),
                marginBottom: `${visualElements.documentTitle.spacingMm || 1.5}mm`,
              }}
            >
              <h1 className="uppercase text-slate-900" style={elStyle('documentTitle')}>
                {documentSpecificTitle || effectiveCustomTitle || defaultTitleEntry.primary}
              </h1>
              {defaultTitleEntry.secondary && !documentSpecificTitle && !effectiveCustomTitle && (
                <div className="font-kannada text-xs font-semibold text-slate-700">
                  {defaultTitleEntry.secondary}
                </div>
              )}
            </div>
          )}

          {(!useVisual || visualElements.documentNumber.visible) && (
            <>
              {layout.numberPlacement === 'header-right' && (
                <div
                  className="mt-1.5 inline-block bg-slate-100 border border-slate-300 rounded px-2.5 py-1"
                  style={elStyle('documentNumber')}
                >
                  <div className="text-[9px] uppercase tracking-wider text-slate-500">
                    <BilingualText labelKey={docNumberLabelKey} language={layout.language} inline />
                  </div>
                  <div className="font-mono font-bold text-slate-900">{docNumber}</div>
                </div>
              )}

              {layout.numberPlacement === 'below-title' && (
                <div className="mt-1 font-bold text-slate-800" style={elStyle('documentNumber')}>
                  <BilingualText labelKey={docNumberLabelKey} language={layout.language} inline />:{' '}
                  {docNumber}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Party Details & Document Metadata Grid */}
      <div className="print-avoid-break grid grid-cols-2 gap-4 mb-4">
        {/* Customer / Recipient Box */}
        {(!useVisual || visualElements.customerDetails.visible) ? (
          <div
            className="border border-slate-200 rounded-md p-2.5 bg-slate-50/50"
            style={elStyle('customerDetails')}
          >
            <div className="text-[9.5px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">
              <BilingualText
                labelKey={
                  docType === 'QUOTATION'
                    ? 'quotedFor'
                    : docType === 'INVOICE'
                    ? 'billedTo'
                    : 'receivedFrom'
                }
                language={layout.language}
                inline
              />
            </div>
            <div className="font-bold text-slate-900">{document.data.customerName}</div>

            {document.type !== 'RECEIPT' && (
              <div className="text-slate-600 mt-0.5 space-y-0.5">
                {layout.showCustomerAddress && document.data.customerAddress && (
                  <div>{document.data.customerAddress}</div>
                )}
                {layout.showCustomerContact &&
                  (document.data.customerEmail || document.data.customerPhone) && (
                    <div>
                      {[document.data.customerEmail, document.data.customerPhone]
                        .filter(Boolean)
                        .join(' • ')}
                    </div>
                  )}
                {layout.showCustomerTaxId && document.data.customerTaxId && (
                  <div className="font-mono text-slate-700">
                    <BilingualText labelKey="taxId" language={layout.language} inline />:{' '}
                    {document.data.customerTaxId}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div />
        )}

        {/* Document Metadata / Dates Box */}
        {(!useVisual || visualElements.dates.visible) ? (
          <div
            className="border border-slate-200 rounded-md p-2.5 space-y-1"
            style={elStyle('dates')}
          >
            {layout.numberPlacement === 'meta-grid' &&
              (!useVisual || visualElements.documentNumber.visible) && (
                <div className="flex justify-between gap-2" style={elStyle('documentNumber')}>
                  <span className="text-slate-500">
                    <BilingualText labelKey={docNumberLabelKey} language={layout.language} inline />:
                  </span>
                  <span className="font-mono font-bold text-slate-900">{docNumber}</span>
                </div>
              )}

            <div className="flex justify-between gap-2">
              <span className="text-slate-500">
                <BilingualText labelKey="date" language={layout.language} inline />:
              </span>
              <span className="font-mono font-medium text-slate-900">
                {document.type === 'QUOTATION'
                  ? document.data.quotationDate
                  : document.type === 'INVOICE'
                  ? document.data.invoiceDate
                  : document.data.receiptDate}
              </span>
            </div>

            {document.type === 'QUOTATION' && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">
                  <BilingualText labelKey="validUntil" language={layout.language} inline />:
                </span>
                <span className="font-mono font-medium text-slate-900">
                  {document.data.validUntilDate}
                </span>
              </div>
            )}

            {document.type === 'INVOICE' && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">
                  <BilingualText labelKey="dueDate" language={layout.language} inline />:
                </span>
                <span className="font-mono font-medium text-slate-900">{document.data.dueDate}</span>
              </div>
            )}

            {document.type === 'RECEIPT' && (
              <>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">
                    <BilingualText labelKey="paymentMethod" language={layout.language} inline />:
                  </span>
                  <span className="font-medium text-slate-900">
                    {document.data.paymentMethod.replace(/_/g, ' ')}
                  </span>
                </div>
                {document.data.referenceNumber && (
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">
                      <BilingualText labelKey="referenceNumber" language={layout.language} inline />:
                    </span>
                    <span className="font-mono text-slate-900">{document.data.referenceNumber}</span>
                  </div>
                )}
              </>
            )}

            <div className="flex justify-between gap-2">
              <span className="text-slate-500">
                <BilingualText labelKey="currency" language={layout.language} inline />:
              </span>
              <span className="font-mono font-semibold text-slate-900">{documentCurrency}</span>
            </div>

            <div className="flex justify-between gap-2">
              <span className="text-slate-500">
                <BilingualText labelKey="status" language={layout.language} inline />:
              </span>
              <span className="font-semibold uppercase text-slate-900">{document.data.status}</span>
            </div>
          </div>
        ) : (
          <div />
        )}
      </div>

      {/* Service / Line Items Table (Quotation & Invoice) */}
      {document.type !== 'RECEIPT' && (
        <div className="mb-4">
          <table className="w-full border-collapse text-left">
            {(!useVisual || visualElements.tableHeadings.visible) && (
              <thead>
                <tr
                  className="bg-slate-900 text-white uppercase tracking-wider"
                  style={elStyle('tableHeadings')}
                >
                  <th className="py-1.5 px-2 w-9 text-left">
                    <BilingualText labelKey="serialNo" language={layout.language} />
                  </th>
                  <th className="py-1.5 px-2 text-left">
                    <BilingualText labelKey="serviceDescription" language={layout.language} />
                  </th>
                  <th className="py-1.5 px-2 text-right w-18">
                    <BilingualText labelKey="qtyHours" language={layout.language} />
                  </th>
                  <th className="py-1.5 px-2 text-right w-22">
                    <BilingualText labelKey="rate" language={layout.language} />
                  </th>
                  {layout.showDiscountColumn && (
                    <th className="py-1.5 px-2 text-right w-22">
                      <BilingualText labelKey="discount" language={layout.language} />
                    </th>
                  )}
                  {layout.showTaxColumn && (
                    <th className="py-1.5 px-2 text-right w-24">
                      <BilingualText labelKey="tax" language={layout.language} />
                    </th>
                  )}
                  <th className="py-1.5 px-2 text-right w-24">
                    <BilingualText labelKey="amount" language={layout.language} />
                  </th>
                </tr>
              </thead>
            )}
            <tbody className="divide-y divide-slate-200 text-[11px]">
              {document.data.lines.map((line, idx) => (
                <tr
                  key={line.id || idx}
                  className={idx % 2 === 1 ? 'bg-slate-50/60' : 'bg-white'}
                >
                  <td
                    className={`${
                      layout.serviceLayout === 'compact' ? 'py-1' : 'py-2'
                    } px-2 font-mono text-slate-500 align-top`}
                  >
                    {line.lineNumber || idx + 1}
                  </td>
                  <td
                    className={`${
                      layout.serviceLayout === 'compact' ? 'py-1' : 'py-2'
                    } px-2 text-slate-900 align-top`}
                  >
                    <div className="font-medium whitespace-pre-line">{line.itemDescription}</div>
                  </td>
                  <td
                    className={`${
                      layout.serviceLayout === 'compact' ? 'py-1' : 'py-2'
                    } px-2 text-right font-mono tabular-nums text-slate-800 align-top`}
                  >
                    {Number(line.quantity).toFixed(2)}
                  </td>
                  <td
                    className={`${
                      layout.serviceLayout === 'compact' ? 'py-1' : 'py-2'
                    } px-2 text-right font-mono tabular-nums text-slate-800 align-top`}
                  >
                    {fmt(line.unitPrice)}
                  </td>
                  {layout.showDiscountColumn && (
                    <td
                      className={`${
                        layout.serviceLayout === 'compact' ? 'py-1' : 'py-2'
                      } px-2 text-right font-mono tabular-nums text-slate-700 align-top`}
                    >
                      {fmt(line.discountAmount)}
                    </td>
                  )}
                  {layout.showTaxColumn && (
                    <td
                      className={`${
                        layout.serviceLayout === 'compact' ? 'py-1' : 'py-2'
                      } px-2 text-right font-mono tabular-nums text-slate-700 align-top`}
                    >
                      {layout.serviceLayout === 'detailed'
                        ? `${fmt(line.taxAmount)} (${Number(line.taxRate).toFixed(1)}%)`
                        : fmt(line.taxAmount)}
                    </td>
                  )}
                  <td
                    className={`${
                      layout.serviceLayout === 'compact' ? 'py-1' : 'py-2'
                    } px-2 text-right font-mono tabular-nums font-semibold text-slate-900 align-top`}
                  >
                    {fmt(line.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Receipt Allocations Table */}
      {document.type === 'RECEIPT' && (
        <div className="mb-4 space-y-3">
          <div className="print-avoid-break border border-slate-300 rounded-md p-3 bg-slate-50 flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                <BilingualText labelKey="amountReceived" language={layout.language} inline />
              </div>
              <div className="text-xs text-slate-600 mt-0.5">
                {document.data.receivingLedgerName || 'Cash / Bank Account'}
              </div>
            </div>
            <div className="text-lg font-mono font-bold tabular-nums text-slate-900">
              {fmt(document.data.amount)}
            </div>
          </div>

          {document.data.allocations && document.data.allocations.length > 0 && (
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                <BilingualText labelKey="invoiceAllocations" language={layout.language} inline />
              </div>
              <table className="w-full border-collapse text-left text-xs">
                {(!useVisual || visualElements.tableHeadings.visible) && (
                  <thead>
                    <tr
                      className="bg-slate-900 text-white uppercase tracking-wider"
                      style={elStyle('tableHeadings')}
                    >
                      <th className="py-1.5 px-2.5">
                        <BilingualText labelKey="invoiceNumber" language={layout.language} />
                      </th>
                      <th className="py-1.5 px-2.5 text-right">
                        <BilingualText labelKey="grandTotal" language={layout.language} />
                      </th>
                      <th className="py-1.5 px-2.5 text-right">
                        <BilingualText labelKey="amountPaid" language={layout.language} />
                      </th>
                    </tr>
                  </thead>
                )}
                <tbody className="divide-y divide-slate-200">
                  {document.data.allocations.map((alloc) => (
                    <tr key={alloc.id}>
                      <td className="py-1.5 px-2.5 font-mono font-semibold text-slate-900">
                        {alloc.invoiceNumber}
                      </td>
                      <td className="py-1.5 px-2.5 text-right font-mono tabular-nums text-slate-700">
                        {fmt(alloc.invoiceTotal)}
                      </td>
                      <td className="py-1.5 px-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {fmt(alloc.allocatedAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Totals Summary + Bank Details Row */}
      <div className="print-avoid-break grid grid-cols-2 gap-4 mb-4 items-start">
        <div>
          {canDisplayBankDetails && bankAccount && (
            <div className="border border-slate-200 rounded-md p-2.5 text-[10.5px] space-y-0.5 bg-slate-50/40">
              <div className="font-bold uppercase tracking-wider text-[9.5px] text-slate-600 mb-1">
                <BilingualText labelKey="bankDetails" language={layout.language} inline />
              </div>
              <div>
                <span className="text-slate-500">
                  <BilingualText labelKey="bankName" language={layout.language} inline />:
                </span>{' '}
                <span className="font-semibold text-slate-900">{bankAccount.bankName}</span>
                {bankAccount.branchName ? ` (${bankAccount.branchName})` : ''}
              </div>
              <div>
                <span className="text-slate-500">
                  <BilingualText labelKey="accountHolder" language={layout.language} inline />:
                </span>{' '}
                <span className="text-slate-900">{bankAccount.accountHolderName}</span>
              </div>
              <div>
                <span className="text-slate-500">
                  <BilingualText labelKey="accountNumber" language={layout.language} inline />:
                </span>{' '}
                <span className="font-mono text-slate-900">{bankAccount.accountNumber}</span>
              </div>
              {bankAccount.routingCode && (
                <div>
                  <span className="text-slate-500">
                    <BilingualText labelKey="routingIfsc" language={layout.language} inline />:
                  </span>{' '}
                  <span className="font-mono text-slate-900">{bankAccount.routingCode}</span>
                </div>
              )}
              {bankAccount.upiId && (
                <div>
                  <span className="text-slate-500">
                    <BilingualText labelKey="upiId" language={layout.language} inline />:
                  </span>{' '}
                  <span className="font-mono text-slate-900">{bankAccount.upiId}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Totals Box */}
        {layout.showTotalsSummary && (!useVisual || visualElements.financialTotals.visible) && (
          <div
            className="ml-auto w-full max-w-xs border border-slate-200 rounded-md p-2.5 space-y-1"
            style={elStyle('financialTotals')}
          >
            {document.type !== 'RECEIPT' ? (
              <>
                <div className="flex justify-between gap-2 text-slate-600 font-normal">
                  <BilingualText labelKey="subtotal" language={layout.language} inline />
                  <span className="font-mono tabular-nums">{fmt(document.data.subtotal)}</span>
                </div>
                <div className="flex justify-between gap-2 text-slate-600 font-normal">
                  <BilingualText labelKey="totalDiscount" language={layout.language} inline />
                  <span className="font-mono tabular-nums">
                    -{fmt(document.data.discountTotal)}
                  </span>
                </div>
                {layout.showTaxBreakdown && (
                  <div className="flex justify-between gap-2 text-slate-600 font-normal">
                    <BilingualText labelKey="totalTax" language={layout.language} inline />
                    <span className="font-mono tabular-nums">{fmt(document.data.taxTotal)}</span>
                  </div>
                )}
                <div className="flex justify-between gap-2 font-bold text-[1.12em] text-slate-900 border-t border-slate-300 pt-1.5">
                  <BilingualText labelKey="grandTotal" language={layout.language} inline />
                  <span className="font-mono tabular-nums">{fmt(document.data.total)}</span>
                </div>
                {document.type === 'INVOICE' && (
                  <>
                    <div className="flex justify-between gap-2 text-slate-600 font-normal pt-0.5">
                      <BilingualText labelKey="amountPaid" language={layout.language} inline />
                      <span className="font-mono tabular-nums">
                        {fmt(document.data.amountPaid)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2 font-bold text-slate-900 border-t border-slate-200 pt-1">
                      <BilingualText labelKey="balanceDue" language={layout.language} inline />
                      <span className="font-mono tabular-nums">
                        {fmt(document.data.balanceDue)}
                      </span>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="flex justify-between gap-2 text-slate-600 font-normal">
                  <BilingualText labelKey="amountReceived" language={layout.language} inline />
                  <span className="font-mono tabular-nums">{fmt(document.data.amount)}</span>
                </div>
                <div className="flex justify-between gap-2 text-slate-600 font-normal">
                  <BilingualText labelKey="allocatedTotal" language={layout.language} inline />
                  <span className="font-mono tabular-nums">
                    {fmt(document.data.allocatedTotal)}
                  </span>
                </div>
                <div className="flex justify-between gap-2 font-bold text-slate-900 border-t border-slate-300 pt-1.5">
                  <BilingualText labelKey="unallocatedCredit" language={layout.language} inline />
                  <span className="font-mono tabular-nums">
                    {fmt(document.data.unallocatedAmount)}
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Notes & Terms */}
      {(notesText || (layout.showTermsAndConditions && termsText && (!useVisual || visualElements.termsAndConditions.visible))) && (
        <div
          className="print-avoid-break border-t border-slate-200 pt-3 mb-4 space-y-2 text-slate-700"
          style={elStyle('termsAndConditions')}
        >
          {notesText && (
            <div>
              <div className="font-bold uppercase text-[0.88em] tracking-wider text-slate-500">
                <BilingualText labelKey="notes" language={layout.language} inline />
              </div>
              <div className="whitespace-pre-line mt-0.5">{notesText}</div>
            </div>
          )}
          {layout.showTermsAndConditions &&
            termsText &&
            (!useVisual || visualElements.termsAndConditions.visible) && (
              <div>
                <div className="font-bold uppercase text-[0.88em] tracking-wider text-slate-500">
                  <BilingualText labelKey="termsAndConditions" language={layout.language} inline />
                </div>
                <div className="whitespace-pre-line mt-0.5">{termsText}</div>
              </div>
            )}
        </div>
      )}

      {/* Optional Uploaded UPI Payment QR + Authorized Signature & Seal */}
      {(layout.showSignatureSection || showPaymentQrOnSheet) && (
        <div
          className={`print-avoid-break flex flex-wrap items-end gap-5 pt-2 pb-2 ${
            showPaymentQrOnSheet && layout.showSignatureSection
              ? paymentQrPosition === 'bottom-left'
                ? 'justify-between'
                : 'justify-end'
              : showPaymentQrOnSheet
              ? paymentQrPosition === 'bottom-left'
                ? 'justify-start'
                : 'justify-end'
              : visualElements.signature.align === 'left'
              ? 'justify-start'
              : visualElements.signature.align === 'center'
              ? 'justify-center'
              : 'justify-end'
          }`}
        >
          {showPaymentQrOnSheet && paymentQrPosition === 'bottom-left' && (
            <div className="border border-slate-200 rounded-md p-2 bg-white text-center shrink-0">
              <img
                src={resolvedPaymentQrUrl}
                alt={paymentQrLabel || 'UPI Payment QR Code'}
                className="object-contain mx-auto"
                style={{
                  width: `${paymentQrSizeMm}mm`,
                  height: `${paymentQrSizeMm}mm`,
                }}
              />
              {paymentQrLabel && (
                <div className="text-[9.5px] font-semibold text-slate-700 mt-1">
                  {paymentQrLabel}
                </div>
              )}
            </div>
          )}

          {layout.showSignatureSection && (
            <div className="flex items-end gap-5">
              {(!useVisual || visualElements.seal.visible) && resolvedSealUrl && (
                <img
                  src={resolvedSealUrl}
                  alt="Company Seal"
                  className={useVisual ? 'object-contain opacity-90' : 'h-14 w-14 object-contain opacity-85'}
                  style={
                    useVisual
                      ? {
                          width: `${visualElements.seal.widthMm}mm`,
                          height: `${visualElements.seal.heightMm}mm`,
                        }
                      : undefined
                  }
                />
              )}
              {(!useVisual || visualElements.signature.visible || visualElements.signatoryLabels.visible) && (
                <div className="text-center min-w-[165px]">
                  {(!useVisual || visualElements.signature.visible) &&
                    (resolvedSignatureUrl ? (
                      <img
                        src={resolvedSignatureUrl}
                        alt="Authorized Signature"
                        className={useVisual ? 'mx-auto object-contain mb-1' : 'h-11 mx-auto object-contain mb-1'}
                        style={
                          useVisual
                            ? {
                                width: `${visualElements.signature.widthMm}mm`,
                                height: `${visualElements.signature.heightMm}mm`,
                              }
                            : undefined
                        }
                      />
                    ) : (
                      <div className="h-8" />
                    ))}
                  {(!useVisual || visualElements.signatoryLabels.visible) && (
                    <div style={elStyle('signatoryLabels')}>
                      <div className="border-t border-slate-400 pt-1 text-slate-800">
                        {resolvedSignatoryName || (
                          <span>
                            {layout.signatureLabel ||
                              getDocumentLabel('authorizedSignature', layout.language).primary}
                          </span>
                        )}
                      </div>
                      {layout.language !== 'EN' && (
                        <div className="font-kannada text-[0.88em] font-normal text-slate-500">
                          {getDocumentLabel('authorizedSignature', layout.language).secondary ||
                            getDocumentLabel('authorizedSignature', layout.language).primary}
                        </div>
                      )}
                      {resolvedSignatoryTitle && (
                        <div className="text-[0.88em] font-normal text-slate-500">
                          {resolvedSignatoryTitle}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {showPaymentQrOnSheet && paymentQrPosition === 'bottom-right' && (
            <div className="border border-slate-200 rounded-md p-2 bg-white text-center shrink-0">
              <img
                src={resolvedPaymentQrUrl}
                alt={paymentQrLabel || 'UPI Payment QR Code'}
                className="object-contain mx-auto"
                style={{
                  width: `${paymentQrSizeMm}mm`,
                  height: `${paymentQrSizeMm}mm`,
                }}
              />
              {paymentQrLabel && (
                <div className="text-[9.5px] font-semibold text-slate-700 mt-1">
                  {paymentQrLabel}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      {(!useVisual || visualElements.footer.visible) &&
        (layout.footerText || layout.showPrintedTimestamp) && (
          <div
            className={`print-avoid-break border-t border-slate-200 pt-2 mt-3 flex flex-wrap items-center gap-2 text-slate-500 ${
              visualElements.footer.align === 'center'
                ? 'justify-center text-center'
                : visualElements.footer.align === 'right'
                ? 'justify-end text-right'
                : 'justify-between text-left'
            }`}
            style={elStyle('footer')}
          >
            <span>{layout.footerText}</span>
            {layout.showPrintedTimestamp && (
              <span className="font-mono">
                <BilingualText labelKey="generatedOn" language={layout.language} inline />:{' '}
                {printedAtLabel} ({timezone})
              </span>
            )}
          </div>
        )}
    </div>
  );

  const printPortal =
    typeof window !== 'undefined' && window.document?.body
      ? createPortal(
          <div
            className={`coreerp-print-portal ${
              embedded ? 'coreerp-print-portal--embedded' : 'coreerp-print-portal--modal'
            }`}
            data-testid={embedded ? 'print-portal-embedded' : 'print-portal-modal'}
          >
            <style>{`
              @media print {
                @page {
                  size: ${pageSizeCss};
                  margin: ${marginCss};
                }
              }
            `}</style>
            {renderSheet(true)}
          </div>,
          window.document.body
        )
      : null;

  if (embedded) {
    return (
      <>
        <div className="w-full overflow-auto">{renderSheet(false)}</div>
        {printPortal}
      </>
    );
  }

  return (
    <>
      <div className="print-modal-backdrop fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
        <div className="print-modal-frame bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">
          {/* Interactive Modal Toolbar (hidden during print) */}
          <div className="no-print px-5 py-3.5 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <FileText className="w-4 h-4 text-indigo-400 shrink-0" />
              <div>
                <h3 className="text-xs font-bold text-slate-100">
                  Print Preview — <span className="font-mono">{docNumber}</span>
                </h3>
                <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1">
                    <Maximize2 className="w-3 h-3" /> {layout.paperSize} {layout.orientation}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Currency: {documentCurrency}</span>
                  {isDraftPreview && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-amber-300 font-medium">Unsaved Draft Preview</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Language Switcher for Preview */}
              <div className="inline-flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-[11px]">
                <Globe className="w-3.5 h-3.5 text-slate-400 ml-1.5 shrink-0" />
                {(['EN', 'KN', 'EN_KN'] as DocumentLanguage[]).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => setPreviewLanguage(lang)}
                    className={`px-2 py-1 rounded-md font-semibold transition whitespace-nowrap shrink-0 cursor-pointer ${
                      layout.language === lang
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {lang === 'EN' ? 'EN' : lang === 'KN' ? 'KN (ಕನ್ನಡ)' : 'EN + KN'}
                  </button>
                ))}
              </div>

              {onBackToEdit && (
                <button
                  type="button"
                  onClick={onBackToEdit}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Edit</span>
                </button>
              )}

              {/* Export Options Popover */}
              <div className="relative" ref={exportOptionsRef}>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportOptions((prev) => !prev);
                    setShowDownloadMenu(false);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer border ${
                    showExportOptions
                      ? 'bg-slate-800 border-indigo-500 text-white'
                      : 'bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-200'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>Options</span>
                </button>

                {showExportOptions && (
                  <div className="absolute right-0 mt-2 w-72 bg-slate-950 border border-slate-700 rounded-xl shadow-2xl p-3.5 z-50 space-y-3 text-xs">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                      <span className="font-bold text-slate-200 uppercase tracking-wider text-[11px]">
                        Export &amp; Print Options
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setPreviewPaperSize(null);
                          setPreviewOrientation(null);
                          setImageQuality('standard');
                          setCopyLabel('');
                          setIncludePaymentQrOverride(undefined);
                        }}
                        className="text-[11px] text-indigo-400 hover:text-indigo-300 cursor-pointer"
                      >
                        Reset
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Paper Size</label>
                        <select
                          value={layout.paperSize}
                          onChange={(e) => setPreviewPaperSize(e.target.value as PaperSize)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100"
                        >
                          <option value="A4">A4</option>
                          <option value="A5">A5</option>
                          <option value="Letter">Letter</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Orientation</label>
                        <select
                          value={layout.orientation}
                          onChange={(e) =>
                            setPreviewOrientation(e.target.value as PageOrientation)
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100"
                        >
                          <option value="portrait">Portrait</option>
                          <option value="landscape">Landscape</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Image Quality</label>
                        <select
                          value={imageQuality}
                          onChange={(e) =>
                            setImageQuality(e.target.value as 'standard' | 'high')
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100"
                        >
                          <option value="standard">Standard (150 DPI)</option>
                          <option value="high">High (300 DPI)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Copy Label</label>
                        <select
                          value={copyLabel}
                          onChange={(e) =>
                            setCopyLabel(e.target.value as DocumentCopyLabel | '')
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100"
                        >
                          <option value="">None (Default)</option>
                          <option value="ORIGINAL">Original</option>
                          <option value="DUPLICATE">Duplicate</option>
                        </select>
                      </div>
                    </div>

                    {resolvedPaymentQrUrl && (
                      <label className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800 cursor-pointer">
                        <span className="text-[11px] text-slate-300">Include Payment QR</span>
                        <input
                          type="checkbox"
                          checked={showPaymentQrOnSheet}
                          onChange={(e) => setIncludePaymentQrOverride(e.target.checked)}
                          className="rounded border-slate-700 bg-slate-900 text-indigo-600"
                        />
                      </label>
                    )}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>Print</span>
              </button>

              <button
                type="button"
                onClick={handleExportPdf}
                disabled={exportingFormat !== null}
                title={
                  currentUser?.isPreview
                    ? 'Opens clean print-to-PDF dialog in Preview Mode'
                    : 'Download formatted PDF document'
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer"
              >
                <FileDown className="w-3.5 h-3.5" />
                <span>{exportingFormat === 'pdf' ? 'Exporting PDF...' : 'Save as PDF'}</span>
              </button>

              {/* Unified Download Menu (DOCX, JPG, PNG, XLSX, PDF, Browser Print) */}
              <div className="relative" ref={downloadMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setShowDownloadMenu((prev) => !prev);
                    setShowExportOptions(false);
                  }}
                  disabled={exportingFormat !== null}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>
                    {exportingFormat && exportingFormat !== 'pdf'
                      ? `Exporting ${exportingFormat.toUpperCase()}...`
                      : 'Download'}
                  </span>
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>

                {showDownloadMenu && (
                  <div className="absolute right-0 mt-2 w-56 bg-slate-950 border border-slate-700 rounded-xl shadow-2xl py-1.5 z-50 text-xs">
                    <button
                      type="button"
                      onClick={handleExportPdf}
                      className="w-full px-3.5 py-2 text-left text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 cursor-pointer"
                    >
                      <FileDown className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                      <span>PDF Document (.pdf)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportImage('jpg')}
                      className="w-full px-3.5 py-2 text-left text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 cursor-pointer"
                    >
                      <ImageIcon className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>JPG Image (.jpg)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportImage('png')}
                      className="w-full px-3.5 py-2 text-left text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 cursor-pointer"
                    >
                      <ImageIcon className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span>PNG Image (.png)</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportDocx}
                      className="w-full px-3.5 py-2 text-left text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>Word Document (.docx)</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportXlsx}
                      className="w-full px-3.5 py-2 text-left text-slate-200 hover:bg-slate-800 flex items-center gap-2.5 cursor-pointer"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                      <span>Excel Workbook (.xlsx)</span>
                    </button>
                    <div className="my-1 border-t border-slate-800" />
                    <button
                      type="button"
                      onClick={() => {
                        setShowDownloadMenu(false);
                        window.print();
                      }}
                      className="w-full px-3.5 py-2 text-left text-slate-300 hover:bg-slate-800 flex items-center gap-2.5 cursor-pointer"
                    >
                      <Printer className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span>Browser Print</span>
                    </button>
                  </div>
                )}
              </div>

              {onClose && !onBackToEdit && (
                <button
                  type="button"
                  onClick={onClose}
                  className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition shrink-0 cursor-pointer"
                  aria-label="Close Print Preview"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {exportError && (
            <div className="no-print px-5 py-2.5 bg-rose-950/60 border-b border-rose-800 text-xs text-rose-200 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{exportError}</span>
              </div>
              <button
                type="button"
                onClick={() => setExportError(null)}
                className="text-rose-400 hover:text-white cursor-pointer"
                aria-label="Dismiss Export Error"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Scrollable Paper Sheet Area */}
          <div className="no-print p-6 overflow-y-auto bg-slate-800/40">
            {renderSheet(false)}
          </div>
        </div>
      </div>
      {printPortal}
    </>
  );
};
