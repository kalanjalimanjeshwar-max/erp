import {
  CompanyBankAccountItem,
  CompanyProfile,
  CustomerReceiptItem,
  DocumentPrintLayoutConfig,
  DocumentPrintType,
  InvoiceItem,
  QuotationItem,
} from '../types.ts';
import { createDefaultPrintSettings } from '../print-settings.ts';

export type ExportableDocumentPayload =
  | { type: 'QUOTATION'; data: QuotationItem }
  | { type: 'INVOICE'; data: InvoiceItem }
  | { type: 'RECEIPT'; data: CustomerReceiptItem };

export interface DocumentExportBrandingImages {
  logo?: Uint8Array | Buffer | null;
  seal?: Uint8Array | Buffer | null;
  signature?: Uint8Array | Buffer | null;
}

export interface DocumentExportContext {
  document: ExportableDocumentPayload;
  companyProfile?: CompanyProfile | null;
  layoutOverride?: DocumentPrintLayoutConfig;
  bankAccount?: CompanyBankAccountItem | null;
  isDraftPreview?: boolean;
  brandingImages?: DocumentExportBrandingImages;
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

  const baseProfile: CompanyProfile = companyProfile || {
    id: 'snapshot-company',
    code: 'SNAPSHOT',
    name: snapshot.companyName,
    currency: 'INR',
    timezone: 'Asia/Kolkata',
  };

  const effectiveProfile: CompanyProfile = {
    ...baseProfile,
    name: snapshot.companyName || baseProfile.name,
    legalName: snapshot.legalName !== undefined ? snapshot.legalName : baseProfile.legalName,
    taxId: snapshot.taxId !== undefined ? snapshot.taxId : baseProfile.taxId,
    address: snapshot.address !== undefined ? snapshot.address : baseProfile.address,
    phone: snapshot.phone !== undefined ? snapshot.phone : baseProfile.phone,
    email: snapshot.email !== undefined ? snapshot.email : baseProfile.email,
    website: snapshot.website !== undefined ? snapshot.website : baseProfile.website,
    logoUrl: snapshot.logoUrl !== undefined ? snapshot.logoUrl : baseProfile.logoUrl,
    sealUrl: snapshot.sealUrl !== undefined ? snapshot.sealUrl : baseProfile.sealUrl,
    signatureUrl:
      snapshot.signatureUrl !== undefined ? snapshot.signatureUrl : baseProfile.signatureUrl,
    documentBranding: {
      logoSize: snapshot.layout?.logoSize || baseProfile.documentBranding?.logoSize || 'md',
      logoAlignment:
        snapshot.layout?.logoPosition || baseProfile.documentBranding?.logoAlignment || 'left',
      sealUrl: snapshot.sealUrl ?? baseProfile.sealUrl ?? null,
      signatureUrl: snapshot.signatureUrl ?? baseProfile.signatureUrl ?? null,
      signatoryName: snapshot.signatoryName ?? baseProfile.documentBranding?.signatoryName ?? null,
      signatureTitle: snapshot.signatoryTitle ?? baseProfile.documentBranding?.signatureTitle ?? null,
    },
  };

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
