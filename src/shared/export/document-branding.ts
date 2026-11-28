import {
  CompanyBankAccountItem,
  CompanyProfile,
  CustomerReceiptItem,
  DocumentBrandingSnapshot,
  DocumentPrintLayoutConfig,
  DocumentPrintType,
  InvoiceItem,
  QuotationItem,
} from '../types.ts';
import {
  createDefaultPrintSettings,
  DocumentCopyLabel,
  PaymentQrSize,
} from '../print-settings.ts';

export type ExportableDocumentPayload =
  | { type: 'QUOTATION'; data: QuotationItem }
  | { type: 'INVOICE'; data: InvoiceItem }
  | { type: 'RECEIPT'; data: CustomerReceiptItem };

export interface DocumentExportBrandingImages {
  logo?: Uint8Array | Buffer | null;
  seal?: Uint8Array | Buffer | null;
  signature?: Uint8Array | Buffer | null;
  paymentQr?: Uint8Array | Buffer | null;
}

export interface DocumentExportContext {
  document: ExportableDocumentPayload;
  companyProfile?: CompanyProfile | null;
  layoutOverride?: DocumentPrintLayoutConfig;
  bankAccount?: CompanyBankAccountItem | null;
  isDraftPreview?: boolean;
  brandingImages?: DocumentExportBrandingImages;
  copyLabel?: DocumentCopyLabel | null;
  includePaymentQr?: boolean;
}

export type CompanyAddressFields = Pick<
  CompanyProfile,
  | 'address'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'country'
  | 'phone'
  | 'email'
  | 'website'
  | 'taxId'
  | 'taxRegistrationNumber'
>;

function cleanText(val?: string | null): string {
  return typeof val === 'string' ? val.trim() : '';
}

function normalizeForDedupe(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Formats company address lines consistently across Designer Preview, Browser Print, PDF, DOCX, JPG, PNG, and XLSX.
 * Supports both legacy free-text `address` and structured fields (`addressLine1`, `addressLine2`, `city`, `state`, `postalCode`, `country`),
 * deduplicating overlapping values and omitting empty lines.
 */
export function formatCompanyAddressLines(
  profile?: Partial<CompanyAddressFields> | null
): string[] {
  if (!profile) return [];

  const line1 = cleanText(profile.addressLine1);
  const line2 = cleanText(profile.addressLine2);
  const city = cleanText(profile.city);
  const state = cleanText(profile.state);
  const postalCode = cleanText(profile.postalCode);
  const country = cleanText(profile.country);
  const freeAddress = cleanText(profile.address);

  const structuredLines: string[] = [];
  if (line1) structuredLines.push(line1);
  if (line2) structuredLines.push(line2);

  const cityState = [city, state].filter(Boolean).join(', ');
  const localityLine =
    cityState && postalCode
      ? `${cityState} - ${postalCode}`
      : cityState || postalCode;
  if (localityLine) structuredLines.push(localityLine);
  if (country) structuredLines.push(country);

  const result: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    const norm = normalizeForDedupe(trimmed);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    result.push(trimmed);
  };

  if (structuredLines.length > 0) {
    // Include free-text address lines only if they contribute distinct non-duplicate street details
    if (freeAddress) {
      const structuredJoinedNorm = normalizeForDedupe(structuredLines.join(' '));
      const freeParts = freeAddress
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean);
      for (const part of freeParts) {
        const partNorm = normalizeForDedupe(part);
        if (
          partNorm &&
          !structuredJoinedNorm.includes(partNorm) &&
          !partNorm.includes(structuredJoinedNorm)
        ) {
          pushUnique(part);
        }
      }
    }
    for (const line of structuredLines) {
      pushUnique(line);
    }
    return result;
  }

  if (freeAddress) {
    for (const part of freeAddress.split(/\r?\n/)) {
      pushUnique(part);
    }
  }

  return result;
}

export function formatCompanyAddressText(
  profile?: Partial<CompanyAddressFields> | null,
  separator = ', '
): string {
  return formatCompanyAddressLines(profile).join(separator);
}

/**
 * Resolves the company's primary tax identifier (preferring GSTIN / taxRegistrationNumber or taxId without duplicating).
 */
export function resolveCompanyTaxId(
  profile?: Partial<Pick<CompanyProfile, 'taxId' | 'taxRegistrationNumber'>> | null
): string | null {
  if (!profile) return null;
  const reg = cleanText(profile.taxRegistrationNumber);
  const tax = cleanText(profile.taxId);
  if (reg && tax && reg.toLowerCase() !== tax.toLowerCase()) {
    return `${reg} / ${tax}`;
  }
  return reg || tax || null;
}

export function resolveCompanyContactParts(
  profile?: Partial<Pick<CompanyProfile, 'phone' | 'email' | 'website'>> | null
): string[] {
  if (!profile) return [];
  return [cleanText(profile.phone), cleanText(profile.email), cleanText(profile.website)].filter(
    Boolean
  );
}

export function resolvePaymentQrDisplaySizeMm(size?: PaymentQrSize | null): number {
  if (size === 'sm') return 22;
  if (size === 'lg') return 36;
  return 28;
}

export function formatCopyLabelText(copyLabel?: DocumentCopyLabel | null): string | null {
  if (copyLabel === 'ORIGINAL') return 'ORIGINAL';
  if (copyLabel === 'DUPLICATE') return 'DUPLICATE';
  return null;
}

/**
 * Determines whether the uploaded UPI Payment QR image should be displayed on a document.
 * - Always false if no QR image source is available.
 * - Honors explicit `includePaymentQrOverride` (true/false) when provided by export options.
 * - Disabled by default (`layout.showPaymentQr` defaults to `false`).
 * - Hidden by default for fully paid invoices (`status === 'PAID'` or `balanceDue <= 0`).
 */
export function shouldDisplayPaymentQr(options: {
  document: ExportableDocumentPayload;
  layout: DocumentPrintLayoutConfig;
  qrSource?: unknown;
  includePaymentQrOverride?: boolean;
}): boolean {
  const { document, layout, qrSource, includePaymentQrOverride } = options;
  if (!qrSource) return false;
  if (typeof qrSource === 'string' && !qrSource.trim()) return false;

  if (includePaymentQrOverride !== undefined) {
    return Boolean(includePaymentQrOverride);
  }

  if (!layout.showPaymentQr) {
    return false;
  }

  if (document.type === 'INVOICE') {
    const balanceDue = Number(document.data.balanceDue);
    if (
      document.data.status === 'PAID' ||
      (Number.isFinite(balanceDue) && balanceDue <= 0)
    ) {
      return false;
    }
  }

  return true;
}

function hasSnapshotAddressData(snapshot: DocumentBrandingSnapshot): boolean {
  return Boolean(
    cleanText(snapshot.address) ||
      cleanText(snapshot.addressLine1) ||
      cleanText(snapshot.addressLine2) ||
      cleanText(snapshot.city) ||
      cleanText(snapshot.state) ||
      cleanText(snapshot.postalCode) ||
      cleanText(snapshot.country)
  );
}

/**
 * Merges a historical DocumentBrandingSnapshot onto a current CompanyProfile safely:
 * - Preserves explicitly stored historical snapshot values, including explicit `null` for branding assets
 *   (`logoUrl`, `sealUrl`, `signatureUrl`, `paymentQrUrl`) and contact fields (`phone`, `email`, `website`, `legalName`).
 * - Falls back to current CompanyProfile ONLY for the approved legacy address case (when a legacy snapshot
 *   has no address data) and for pre-enhancement legacy snapshots that did not record `taxRegistrationNumber`.
 * - Preserves intentionally hidden branding toggles stored on `snapshot.layout`.
 */
export function mergeSnapshotIntoCompanyProfile(
  baseProfileInput: CompanyProfile | null | undefined,
  snapshot: DocumentBrandingSnapshot
): CompanyProfile {
  const baseProfile: CompanyProfile = baseProfileInput || {
    id: 'snapshot-company',
    code: 'SNAPSHOT',
    name: snapshot.companyName,
    currency: 'INR',
    timezone: 'Asia/Kolkata',
  };

  const snapshotHasAddress = hasSnapshotAddressData(snapshot);
  const snapshotHasTax = Boolean(
    cleanText(snapshot.taxId) || cleanText(snapshot.taxRegistrationNumber)
  );
  const isLegacyWithoutTaxRegField = snapshot.taxRegistrationNumber === undefined;

  const resolvedLogoUrl =
    snapshot.logoUrl !== undefined ? snapshot.logoUrl : baseProfile.logoUrl ?? null;
  const resolvedSealUrl =
    snapshot.sealUrl !== undefined ? snapshot.sealUrl : baseProfile.sealUrl ?? null;
  const resolvedSignatureUrl =
    snapshot.signatureUrl !== undefined ? snapshot.signatureUrl : baseProfile.signatureUrl ?? null;
  const resolvedPaymentQrUrl =
    snapshot.paymentQrUrl !== undefined
      ? snapshot.paymentQrUrl
      : baseProfile.paymentQrUrl ?? baseProfile.brandingAssets?.paymentQr?.url ?? null;

  return {
    ...baseProfile,
    name: cleanText(snapshot.companyName) ? snapshot.companyName : baseProfile.name,
    legalName: snapshot.legalName !== undefined ? snapshot.legalName : baseProfile.legalName,
    taxId: snapshotHasTax
      ? (snapshot.taxId ?? null)
      : snapshot.taxId !== undefined
      ? snapshot.taxId
      : baseProfile.taxId,
    taxRegistrationNumber: snapshotHasTax
      ? (snapshot.taxRegistrationNumber ?? null)
      : isLegacyWithoutTaxRegField && !snapshotHasAddress
      ? (baseProfile.taxRegistrationNumber ?? null)
      : snapshot.taxRegistrationNumber !== undefined
      ? snapshot.taxRegistrationNumber
      : null,
    address: snapshotHasAddress ? (snapshot.address ?? null) : baseProfile.address,
    addressLine1: snapshotHasAddress ? (snapshot.addressLine1 ?? null) : baseProfile.addressLine1,
    addressLine2: snapshotHasAddress ? (snapshot.addressLine2 ?? null) : baseProfile.addressLine2,
    city: snapshotHasAddress ? (snapshot.city ?? null) : baseProfile.city,
    state: snapshotHasAddress ? (snapshot.state ?? null) : baseProfile.state,
    postalCode: snapshotHasAddress ? (snapshot.postalCode ?? null) : baseProfile.postalCode,
    country: snapshotHasAddress ? (snapshot.country ?? null) : baseProfile.country,
    phone: snapshot.phone !== undefined ? snapshot.phone : baseProfile.phone,
    email: snapshot.email !== undefined ? snapshot.email : baseProfile.email,
    website: snapshot.website !== undefined ? snapshot.website : baseProfile.website,
    logoUrl: resolvedLogoUrl,
    sealUrl: resolvedSealUrl,
    signatureUrl: resolvedSignatureUrl,
    paymentQrUrl: resolvedPaymentQrUrl,
    brandingAssets: {
      version: 1,
      logo:
        resolvedLogoUrl && baseProfile.brandingAssets?.logo?.url === resolvedLogoUrl
          ? baseProfile.brandingAssets.logo
          : null,
      seal:
        resolvedSealUrl && baseProfile.brandingAssets?.seal?.url === resolvedSealUrl
          ? baseProfile.brandingAssets.seal
          : null,
      signature:
        resolvedSignatureUrl && baseProfile.brandingAssets?.signature?.url === resolvedSignatureUrl
          ? baseProfile.brandingAssets.signature
          : null,
      paymentQr:
        resolvedPaymentQrUrl && baseProfile.brandingAssets?.paymentQr?.url === resolvedPaymentQrUrl
          ? baseProfile.brandingAssets.paymentQr
          : null,
    },
    documentBranding: {
      logoSize: snapshot.layout?.logoSize || baseProfile.documentBranding?.logoSize || 'md',
      logoAlignment:
        snapshot.layout?.logoPosition || baseProfile.documentBranding?.logoAlignment || 'left',
      sealUrl: resolvedSealUrl,
      signatureUrl: resolvedSignatureUrl,
      paymentQrUrl: resolvedPaymentQrUrl,
      signatoryName:
        snapshot.signatoryName !== undefined
          ? snapshot.signatoryName
          : baseProfile.documentBranding?.signatoryName ?? null,
      signatureTitle:
        snapshot.signatoryTitle !== undefined
          ? snapshot.signatoryTitle
          : baseProfile.documentBranding?.signatureTitle ?? null,
    },
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

export function resolveDocumentEffectiveBranding(
  docPayload: ExportableDocumentPayload,
  companyProfile?: CompanyProfile | null,
  layoutOverride?: DocumentPrintLayoutConfig,
  isDraftPreview?: boolean
): {
  effectiveProfile: CompanyProfile | null;
  layout: DocumentPrintLayoutConfig;
} {
  const snapshot =
    !isDraftPreview && docPayload.data.status !== 'DRAFT'
      ? docPayload.data.brandingSnapshot || null
      : null;

  if (!snapshot) {
    return {
      effectiveProfile: companyProfile || null,
      layout: resolveEffectivePrintLayout(docPayload.type, companyProfile, layoutOverride),
    };
  }

  const effectiveProfile = mergeSnapshotIntoCompanyProfile(companyProfile, snapshot);

  const layout =
    layoutOverride ||
    snapshot.layout ||
    resolveEffectivePrintLayout(docPayload.type, effectiveProfile, undefined);

  return {
    effectiveProfile,
    layout,
  };
}

export function buildExportFileName(
  doc: ExportableDocumentPayload,
  extension: 'pdf' | 'docx' | 'xlsx' | 'jpg' | 'png' | 'zip',
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
