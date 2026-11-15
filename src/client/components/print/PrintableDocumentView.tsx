import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowLeft,
  Download,
  FileDown,
  FileText,
  Globe,
  Maximize2,
  Printer,
  X,
} from 'lucide-react';
import {
  AuthUser,
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
} from '../../../shared/types.ts';
import {
  getEffectivePaperDimensionsMm,
  getVisualElementTypography,
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
  DocumentExportBrandingImages,
  generateDocxBlob,
  resolveDocumentEffectiveBranding,
} from '../../../shared/export/docx-builder.ts';
import { api, ApiError } from '../../services/api.ts';

export type PrintableDocumentPayload =
  | { type: 'QUOTATION'; data: QuotationItem }
  | { type: 'INVOICE'; data: InvoiceItem }
  | { type: 'RECEIPT'; data: CustomerReceiptItem };

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
  const [exportingFormat, setExportingFormat] = useState<'pdf' | 'docx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

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

  // Allow temporary interactive language toggle in modal preview without mutating saved DB config
  const [previewLanguage, setPreviewLanguage] = useState<DocumentLanguage | null>(null);
  const layout: DocumentPrintLayoutConfig = useMemo(
    () => ({
      ...resolvedSavedLayout,
      language: previewLanguage || resolvedSavedLayout.language,
    }),
    [resolvedSavedLayout, previewLanguage]
  );

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
  const resolvedSignatoryName =
    layout.signatoryName || effectiveProfile?.documentBranding?.signatoryName || '';
  const resolvedSignatoryTitle =
    layout.signatoryTitle || effectiveProfile?.documentBranding?.signatureTitle || '';

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

  const handleExportPdf = async () => {
    setExportError(null);
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

  const fetchPreviewRasterBytes = async (url?: string | null): Promise<Uint8Array | null> => {
    if (!url || !url.startsWith('/')) return null;
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return null;
      const buf = new Uint8Array(await resp.arrayBuffer());
      return buf;
    } catch {
      return null;
    }
  };

  const handleExportDocx = async () => {
    setExportError(null);
    try {
      setExportingFormat('docx');
      if (currentUser?.isPreview) {
        const [logoBytes, sealBytes, signatureBytes] = await Promise.all([
          fetchPreviewRasterBytes(resolvedLogoUrl),
          fetchPreviewRasterBytes(resolvedSealUrl),
          fetchPreviewRasterBytes(resolvedSignatureUrl),
        ]);
        const brandingImages: DocumentExportBrandingImages = {
          logo: logoBytes,
          seal: sealBytes,
          signature: signatureBytes,
        };
        const blob = await generateDocxBlob({
          document,
          companyProfile: effectiveProfile,
          layoutOverride: layout,
          bankAccount: canDisplayBankDetails ? bankAccount : null,
          isDraftPreview,
          brandingImages,
        });
        triggerBlobDownload(blob, buildExportFileName(document, 'docx', isDraftPreview));
        return;
      }

      const { blob, fileName } = await api.exportDocumentDocx({
        document,
        layoutOverride: layout,
        isDraftPreview,
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
          <span className="uppercase tracking-wider font-medium">
            {getDocumentLabel('originalForRecipient', layout.language).primary}
          </span>
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
                  {effectiveProfile?.address && <div>{effectiveProfile.address}</div>}
                  {(effectiveProfile?.phone || effectiveProfile?.email || effectiveProfile?.website) && (
                    <div
                      className={`flex flex-wrap gap-x-2.5 gap-y-0.5 ${
                        visualElements.companyHeader.align === 'center'
                          ? 'justify-center'
                          : visualElements.companyHeader.align === 'right'
                          ? 'justify-end'
                          : 'justify-start'
                      }`}
                    >
                      {effectiveProfile.phone && <span>{effectiveProfile.phone}</span>}
                      {effectiveProfile.email && <span>{effectiveProfile.email}</span>}
                      {effectiveProfile.website && <span>{effectiveProfile.website}</span>}
                    </div>
                  )}
                </div>
              )}

              {layout.showCompanyTaxId && effectiveProfile?.taxId && (
                <div className="text-slate-700 font-medium mt-0.5">
                  <BilingualText labelKey="taxId" language={layout.language} inline />:{' '}
                  <span className="font-mono">{effectiveProfile.taxId}</span>
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

      {/* Authorized Signature & Seal */}
      {layout.showSignatureSection && (
        <div
          className={`print-avoid-break flex items-end gap-5 pt-2 pb-2 ${
            visualElements.signature.align === 'left'
              ? 'justify-start'
              : visualElements.signature.align === 'center'
              ? 'justify-center'
              : 'justify-end'
          }`}
        >
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

              <button
                type="button"
                onClick={handleExportDocx}
                disabled={exportingFormat !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{exportingFormat === 'docx' ? 'Exporting Word...' : 'Download Word (.docx)'}</span>
              </button>

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
