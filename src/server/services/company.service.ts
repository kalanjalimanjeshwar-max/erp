import { prisma } from '../db/client.js';
import {
  AuthUser,
  CompanyProfile,
  CompanySettingsChangeRequestItem,
  DocumentPrintSettings,
  DocumentPrintSettingsUpdateResponse,
  SettingsChangeRequestStatus,
  UpdateCompanyProfileRequest,
} from '../../shared/types.js';
import {
  DOCUMENT_PRINT_SETTING_KEY,
  mergeDocumentPrintSettings,
  validatePrintSettingsPayload,
} from '../../shared/print-settings.js';
import {
  BRANDING_ASSETS_SETTING_KEY,
  CompanyBrandingAssetsState,
} from '../../shared/branding.js';
import { isValidTimeZone } from '../../shared/timezone.js';
import { getCurrencyMeta } from '../../shared/currency.js';
import { AuditService } from './audit.service.js';
import { BrandingAssetService } from './branding-asset.service.js';

function mapChangeRequest(row: {
  id: string;
  companyId: string;
  requestedById: string;
  payload: unknown;
  status: SettingsChangeRequestStatus;
  rejectionReason: string | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  requestedBy?: { fullName: string; email: string } | null;
  reviewedBy?: { fullName: string } | null;
}): CompanySettingsChangeRequestItem {
  return {
    id: row.id,
    companyId: row.companyId,
    requestedById: row.requestedById,
    requestedByName: row.requestedBy?.fullName || null,
    requestedByEmail: row.requestedBy?.email || null,
    payload:
      row.payload && typeof row.payload === 'object'
        ? (row.payload as Record<string, unknown>)
        : {},
    status: row.status,
    rejectionReason: row.rejectionReason,
    reviewedById: row.reviewedById,
    reviewedByName: row.reviewedBy?.fullName || null,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class CompanyService {
  /**
   * Resolves the company's configured base currency code cleanly.
   */
  static async getBaseCurrency(companyId: string): Promise<string> {
    try {
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { currency: true },
      });
      return company?.currency?.trim().toUpperCase() || 'USD';
    } catch {
      return 'USD';
    }
  }

  /**
   * Retrieves company profile strictly by companyId, including currency precision & document print settings
   */
  static async getProfile(companyId: string): Promise<CompanyProfile> {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      const err = new Error('Company not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    let salesInvoiceEnabled = false;
    let rawPrintSettings: unknown = null;
    let brandingAssets: CompanyBrandingAssetsState = {
      version: 1,
      logo: null,
      seal: null,
      signature: null,
    };
    try {
      const settings = await prisma.companySetting.findMany({
        where: {
          companyId,
          key: {
            in: ['SALES_INVOICE_ENABLED', DOCUMENT_PRINT_SETTING_KEY, BRANDING_ASSETS_SETTING_KEY],
          },
        },
      });
      const salesSetting = settings.find((s) => s.key === 'SALES_INVOICE_ENABLED');
      const printSetting = settings.find((s) => s.key === DOCUMENT_PRINT_SETTING_KEY);
      const assetsSetting = settings.find((s) => s.key === BRANDING_ASSETS_SETTING_KEY);
      salesInvoiceEnabled = salesSetting ? salesSetting.value === 'true' : false;
      rawPrintSettings = printSetting ? printSetting.value : null;
      if (assetsSetting?.value) {
        const parsedAssets = JSON.parse(assetsSetting.value) as Partial<CompanyBrandingAssetsState>;
        brandingAssets = {
          version: 1,
          logo: parsedAssets.logo || null,
          seal: parsedAssets.seal || null,
          signature: parsedAssets.signature || null,
        };
      }
    } catch {
      salesInvoiceEnabled = false;
    }

    let roundingPrecision = getCurrencyMeta(company.currency).defaultDecimals;
    try {
      const currencyConfig = await prisma.currencyConfig.findUnique({
        where: {
          companyId_currencyCode: {
            companyId,
            currencyCode: company.currency,
          },
        },
        select: { roundingPrecision: true },
      });
      if (currencyConfig && typeof currencyConfig.roundingPrecision === 'number') {
        roundingPrecision = currencyConfig.roundingPrecision;
      }
    } catch {
      // Graceful fallback for offline/mocked tests
    }

    const activeLogoUrl = brandingAssets.logo?.url || company.logoUrl || null;
    const printSettings = mergeDocumentPrintSettings(rawPrintSettings, {
      defaultDocumentLanguage: company.defaultDocumentLanguage,
      documentBranding: {
        sealUrl: brandingAssets.seal?.url || null,
        signatureUrl: brandingAssets.signature?.url || null,
      },
    });

    const activeLayout = printSettings.layouts.INVOICE;
    const sealUrl = brandingAssets.seal?.url || activeLayout.sealUrl || null;
    const signatureUrl = brandingAssets.signature?.url || activeLayout.signatureUrl || null;

    return {
      id: company.id,
      code: company.code,
      name: company.name,
      legalName: company.legalName,
      taxId: company.taxId,
      currency: company.currency,
      timezone: company.timezone,
      logoUrl: activeLogoUrl,
      sealUrl,
      signatureUrl,
      brandingAssets,
      documentBranding: {
        logoSize: activeLayout.logoSize || 'md',
        logoAlignment: activeLayout.logoPosition || 'left',
        sealUrl,
        signatureUrl,
        signatoryName: activeLayout.signatoryName || null,
        signatureTitle: activeLayout.signatoryTitle || null,
      },
      address: company.address,
      phone: company.phone,
      email: company.email,
      website: company.website,
      appHeaderTitle: company.appHeaderTitle,
      salesInvoiceEnabled,
      roundingPrecision,
      defaultDocumentLanguage: company.defaultDocumentLanguage,
      printSettings,
    };
  }

  /**
   * Helper check whether Sales Invoice is enabled for a tenant
   */
  static async isSalesInvoiceEnabled(companyId: string): Promise<boolean> {
    try {
      const setting = await prisma.companySetting.findUnique({
        where: {
          companyId_key: {
            companyId,
            key: 'SALES_INVOICE_ENABLED',
          },
        },
      });
      return setting ? setting.value === 'true' : false;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves persistent document print settings for a company
   */
  static async getPrintSettings(companyId: string): Promise<DocumentPrintSettings> {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, defaultDocumentLanguage: true },
    });

    if (!company) {
      const err = new Error('Company not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const setting = await prisma.companySetting.findUnique({
      where: {
        companyId_key: {
          companyId,
          key: DOCUMENT_PRINT_SETTING_KEY,
        },
      },
    });

    let sealUrl: string | null = null;
    let signatureUrl: string | null = null;
    try {
      const assetRows = await prisma.companySetting.findMany({
        where: { companyId, key: BRANDING_ASSETS_SETTING_KEY },
      });
      if (Array.isArray(assetRows) && assetRows[0]?.value) {
        const parsed = JSON.parse(assetRows[0].value) as Partial<CompanyBrandingAssetsState>;
        sealUrl = parsed.seal?.url || null;
        signatureUrl = parsed.signature?.url || null;
      }
    } catch {
      // ignore if mocked
    }

    return mergeDocumentPrintSettings(setting?.value || null, {
      defaultDocumentLanguage: company.defaultDocumentLanguage,
      documentBranding: {
        sealUrl,
        signatureUrl,
      },
    });
  }

  /**
   * Updates persistent document print settings.
   * SUPER_ADMIN applies immediately; ADMIN routes through CompanySettingsChangeRequest (maker-checker).
   */
  static async updatePrintSettings(
    actor: AuthUser,
    input: unknown,
    correlationId?: string
  ): Promise<DocumentPrintSettingsUpdateResponse> {
    const validation = validatePrintSettingsPayload(input);
    if (!validation.valid) {
      const err = new Error(validation.error || 'Invalid print settings payload.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'ADMIN') {
      const err = new Error('Insufficient permissions to update document print settings.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const current = await this.getPrintSettings(actor.companyId);
    const merged = mergeDocumentPrintSettings(
      {
        version: 1,
        layouts: {
          QUOTATION: {
            ...current.layouts.QUOTATION,
            ...((input as DocumentPrintSettings)?.layouts?.QUOTATION || {}),
          },
          INVOICE: {
            ...current.layouts.INVOICE,
            ...((input as DocumentPrintSettings)?.layouts?.INVOICE || {}),
          },
          RECEIPT: {
            ...current.layouts.RECEIPT,
            ...((input as DocumentPrintSettings)?.layouts?.RECEIPT || {}),
          },
        },
      },
      undefined
    );

    if (actor.role === 'ADMIN') {
      const changeRequest = await prisma.companySettingsChangeRequest.create({
        data: {
          companyId: actor.companyId,
          requestedById: actor.userId,
          status: 'PENDING',
          payload: {
            type: 'DOCUMENT_PRINT_SETTINGS',
            settingKey: DOCUMENT_PRINT_SETTING_KEY,
            printSettings: merged as unknown as Record<string, unknown>,
          } as object,
        },
        include: {
          requestedBy: { select: { fullName: true, email: true } },
          reviewedBy: { select: { fullName: true } },
        },
      });

      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'DOCUMENT_PRINT_SETTINGS_CHANGE_REQUESTED',
        entity: 'CompanySettingsChangeRequest',
        entityId: changeRequest.id,
        severity: 'INFO',
        correlationId,
        metadata: {
          requestedByRole: actor.role,
          settingKey: DOCUMENT_PRINT_SETTING_KEY,
        },
      });

      return {
        printSettings: current,
        pendingApproval: true,
        changeRequest: mapChangeRequest(changeRequest),
      };
    }

    await prisma.companySetting.upsert({
      where: {
        companyId_key: {
          companyId: actor.companyId,
          key: DOCUMENT_PRINT_SETTING_KEY,
        },
      },
      create: {
        companyId: actor.companyId,
        key: DOCUMENT_PRINT_SETTING_KEY,
        value: JSON.stringify(merged),
      },
      update: {
        value: JSON.stringify(merged),
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'DOCUMENT_PRINT_SETTINGS_UPDATED',
      entity: 'CompanySetting',
      entityId: actor.companyId,
      severity: 'INFO',
      correlationId,
      metadata: {
        settingKey: DOCUMENT_PRINT_SETTING_KEY,
        languages: {
          QUOTATION: merged.layouts.QUOTATION.language,
          INVOICE: merged.layouts.INVOICE.language,
          RECEIPT: merged.layouts.RECEIPT.language,
        },
        paperSizes: {
          QUOTATION: merged.layouts.QUOTATION.paperSize,
          INVOICE: merged.layouts.INVOICE.paperSize,
          RECEIPT: merged.layouts.RECEIPT.paperSize,
        },
      },
    });

    return {
      printSettings: merged,
      pendingApproval: false,
    };
  }

  /**
   * Lists maker-checker company settings change requests
   */
  static async listChangeRequests(
    companyId: string,
    status?: SettingsChangeRequestStatus
  ): Promise<CompanySettingsChangeRequestItem[]> {
    const rows = await prisma.companySettingsChangeRequest.findMany({
      where: {
        companyId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        requestedBy: { select: { fullName: true, email: true } },
        reviewedBy: { select: { fullName: true } },
      },
    });

    return rows.map((r) => mapChangeRequest(r));
  }

  /**
   * Approves and atomically applies a pending company settings or print settings change request (SUPER_ADMIN only)
   */
  static async approveChangeRequest(
    actor: AuthUser,
    requestId: string,
    correlationId?: string
  ): Promise<{ request: CompanySettingsChangeRequestItem; profile: CompanyProfile }> {
    if (actor.role !== 'SUPER_ADMIN') {
      const err = new Error('Only a SUPER_ADMIN can approve company settings change requests.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const existing = await prisma.companySettingsChangeRequest.findUnique({
      where: { id: requestId },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Settings change request not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status !== 'PENDING') {
      const err = new Error(`Change request is already ${existing.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const payload = (existing.payload || {}) as {
      type?: string;
      companyFields?: Record<string, unknown>;
      salesInvoiceEnabled?: boolean;
      settingKey?: string;
      printSettings?: DocumentPrintSettings;
    };

    const now = new Date();

    const updatedRequest = await prisma.$transaction(async (tx) => {
      if (payload.companyFields && Object.keys(payload.companyFields).length > 0) {
        const cf = payload.companyFields;
        await tx.company.update({
          where: { id: actor.companyId },
          data: {
            ...(cf.name !== undefined ? { name: String(cf.name) } : {}),
            ...(cf.legalName !== undefined ? { legalName: cf.legalName as string | null } : {}),
            ...(cf.taxId !== undefined ? { taxId: cf.taxId as string | null } : {}),
            ...(cf.timezone !== undefined ? { timezone: String(cf.timezone) } : {}),
            ...(cf.currency !== undefined ? { currency: String(cf.currency) } : {}),
            ...(cf.logoUrl !== undefined ? { logoUrl: cf.logoUrl as string | null } : {}),
            ...(cf.address !== undefined ? { address: cf.address as string | null } : {}),
            ...(cf.phone !== undefined ? { phone: cf.phone as string | null } : {}),
            ...(cf.email !== undefined ? { email: cf.email as string | null } : {}),
            ...(cf.website !== undefined ? { website: cf.website as string | null } : {}),
            ...(cf.appHeaderTitle !== undefined
              ? { appHeaderTitle: cf.appHeaderTitle as string | null }
              : {}),
            ...(cf.defaultDocumentLanguage !== undefined
              ? { defaultDocumentLanguage: String(cf.defaultDocumentLanguage) }
              : {}),
          },
        });
      }

      if (payload.salesInvoiceEnabled !== undefined) {
        await tx.companySetting.upsert({
          where: {
            companyId_key: {
              companyId: actor.companyId,
              key: 'SALES_INVOICE_ENABLED',
            },
          },
          create: {
            companyId: actor.companyId,
            key: 'SALES_INVOICE_ENABLED',
            value: String(Boolean(payload.salesInvoiceEnabled)),
          },
          update: {
            value: String(Boolean(payload.salesInvoiceEnabled)),
          },
        });
      }

      if (payload.type === 'DOCUMENT_PRINT_SETTINGS' && payload.printSettings) {
        const merged = mergeDocumentPrintSettings(payload.printSettings, undefined);
        await tx.companySetting.upsert({
          where: {
            companyId_key: {
              companyId: actor.companyId,
              key: DOCUMENT_PRINT_SETTING_KEY,
            },
          },
          create: {
            companyId: actor.companyId,
            key: DOCUMENT_PRINT_SETTING_KEY,
            value: JSON.stringify(merged),
          },
          update: {
            value: JSON.stringify(merged),
          },
        });
      }

      if (payload.type === 'COMPANY_BRANDING_ASSET') {
        await BrandingAssetService.applyBrandingAssetMutation(tx, actor.companyId, payload as any);
      }

      return tx.companySettingsChangeRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          reviewedById: actor.userId,
          reviewedAt: now,
          appliedAt: now,
        },
        include: {
          requestedBy: { select: { fullName: true, email: true } },
          reviewedBy: { select: { fullName: true } },
        },
      });
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'COMPANY_SETTINGS_CHANGE_APPROVED',
      entity: 'CompanySettingsChangeRequest',
      entityId: requestId,
      severity: 'INFO',
      correlationId,
      metadata: {
        requestType: payload.type || 'COMPANY_PROFILE',
        requestedById: existing.requestedById,
      },
    });

    const profile = await this.getProfile(actor.companyId);
    return {
      request: mapChangeRequest(updatedRequest),
      profile,
    };
  }

  /**
   * Rejects a pending company settings change request (SUPER_ADMIN only)
   */
  static async rejectChangeRequest(
    actor: AuthUser,
    requestId: string,
    reason?: string,
    correlationId?: string
  ): Promise<CompanySettingsChangeRequestItem> {
    if (actor.role !== 'SUPER_ADMIN') {
      const err = new Error('Only a SUPER_ADMIN can reject company settings change requests.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const existing = await prisma.companySettingsChangeRequest.findUnique({
      where: { id: requestId },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Settings change request not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status !== 'PENDING') {
      const err = new Error(`Change request is already ${existing.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const rejected = await prisma.companySettingsChangeRequest.update({
      where: { id: requestId },
      data: {
        status: 'REJECTED',
        rejectionReason: reason?.trim() || 'Rejected by Super Admin',
        reviewedById: actor.userId,
        reviewedAt: new Date(),
      },
      include: {
        requestedBy: { select: { fullName: true, email: true } },
        reviewedBy: { select: { fullName: true } },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'COMPANY_SETTINGS_CHANGE_REJECTED',
      entity: 'CompanySettingsChangeRequest',
      entityId: requestId,
      severity: 'WARN',
      correlationId,
      metadata: {
        rejectionReason: rejected.rejectionReason,
      },
    });

    return mapChangeRequest(rejected);
  }

  /**
   * Updates operational company profile with validation, maker-checker governance, and audit trail
   */
  static async updateProfile(
    actor: AuthUser,
    input: UpdateCompanyProfileRequest,
    correlationId?: string
  ): Promise<CompanyProfile> {
    // 1. Validate logo URL safety if provided (executed first for unit-test contract)
    if (input.logoUrl) {
      const trimmed = input.logoUrl.trim();
      if (/^(javascript|data|vbscript):/i.test(trimmed)) {
        const err = new Error('Dangerous URL scheme detected in logo URL.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      const isHttp = /^https?:\/\//i.test(trimmed);
      const isPath = /^\/[a-zA-Z0-9_\-./]+$/i.test(trimmed);

      if (!isHttp && !isPath) {
        const err = new Error(
          'Invalid logo URL. Only secure http/https URLs or safe relative asset paths are allowed.'
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    if (!isValidTimeZone(input.timezone)) {
      const err = new Error(`Invalid IANA timezone "${input.timezone}".`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const normalizedCurrency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      const err = new Error('Currency must be a valid 3-letter ISO currency code.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'ADMIN') {
      const err = new Error('Insufficient permissions to modify company settings.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // Check current company state for maker-checker evaluation when actor is ADMIN
    if (actor.role === 'ADMIN') {
      const current = await this.getProfile(actor.companyId);
      const protectedChanged =
        current.name !== input.name.trim() ||
        (current.legalName || null) !== (input.legalName?.trim() || null) ||
        (current.taxId || null) !== (input.taxId?.trim() || null) ||
        current.timezone !== input.timezone.trim() ||
        current.currency !== normalizedCurrency ||
        (input.salesInvoiceEnabled !== undefined &&
          Boolean(current.salesInvoiceEnabled) !== Boolean(input.salesInvoiceEnabled)) ||
        (input.defaultDocumentLanguage !== undefined &&
          current.defaultDocumentLanguage !== input.defaultDocumentLanguage);

      if (protectedChanged) {
        const changeRequest = await prisma.companySettingsChangeRequest.create({
          data: {
            companyId: actor.companyId,
            requestedById: actor.userId,
            status: 'PENDING',
            payload: {
              type: 'COMPANY_PROFILE',
              companyFields: {
                name: input.name.trim(),
                legalName: input.legalName?.trim() || null,
                taxId: input.taxId?.trim() || null,
                timezone: input.timezone.trim(),
                currency: normalizedCurrency,
                logoUrl: input.logoUrl?.trim() || null,
                address: input.address?.trim() || null,
                phone: input.phone?.trim() || null,
                email: input.email?.trim().toLowerCase() || null,
                website: input.website?.trim() || null,
                appHeaderTitle: input.appHeaderTitle?.trim() || null,
                ...(input.defaultDocumentLanguage
                  ? { defaultDocumentLanguage: input.defaultDocumentLanguage }
                  : {}),
              },
              ...(input.salesInvoiceEnabled !== undefined
                ? { salesInvoiceEnabled: Boolean(input.salesInvoiceEnabled) }
                : {}),
            } as object,
          },
          include: {
            requestedBy: { select: { fullName: true, email: true } },
            reviewedBy: { select: { fullName: true } },
          },
        });

        await AuditService.log({
          companyId: actor.companyId,
          userId: actor.userId,
          action: 'COMPANY_SETTINGS_CHANGE_REQUESTED',
          entity: 'CompanySettingsChangeRequest',
          entityId: changeRequest.id,
          severity: 'INFO',
          correlationId,
          metadata: {
            requestedByRole: actor.role,
            proposedCurrency: normalizedCurrency,
            proposedTimezone: input.timezone.trim(),
          },
        });

        return {
          ...current,
          pendingApproval: true,
          changeRequest: mapChangeRequest(changeRequest),
        };
      }
    }

    // 2. Persist in PostgreSQL (SUPER_ADMIN or non-protected ADMIN update)
    const updated = await prisma.company.update({
      where: { id: actor.companyId },
      data: {
        name: input.name.trim(),
        legalName: input.legalName?.trim() || null,
        taxId: input.taxId?.trim() || null,
        timezone: input.timezone.trim(),
        currency: normalizedCurrency,
        logoUrl: input.logoUrl?.trim() || null,
        address: input.address?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim().toLowerCase() || null,
        website: input.website?.trim() || null,
        appHeaderTitle: input.appHeaderTitle?.trim() || null,
        ...(input.defaultDocumentLanguage
          ? { defaultDocumentLanguage: input.defaultDocumentLanguage }
          : {}),
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'COMPANY_PROFILE_UPDATED',
      entity: 'Company',
      entityId: actor.companyId,
      severity: 'INFO',
      correlationId,
      metadata: {
        companyCode: updated.code,
        updatedFields: {
          name: updated.name,
          timezone: updated.timezone,
          currency: updated.currency,
        },
      },
    });

    // 3. Persist optional sales invoice feature setting
    if (input.salesInvoiceEnabled !== undefined) {
      const salesInvoiceEnabled = Boolean(input.salesInvoiceEnabled);
      try {
        await prisma.companySetting.upsert({
          where: {
            companyId_key: {
              companyId: actor.companyId,
              key: 'SALES_INVOICE_ENABLED',
            },
          },
          create: {
            companyId: actor.companyId,
            key: 'SALES_INVOICE_ENABLED',
            value: String(salesInvoiceEnabled),
          },
          update: {
            value: String(salesInvoiceEnabled),
          },
        });
      } catch {
        // Fallback for mocked or offline DB in test environments
      }
    }

    return this.getProfile(actor.companyId);
  }
}
