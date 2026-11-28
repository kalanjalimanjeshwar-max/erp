import React, { useState, useEffect, lazy, Suspense } from 'react';
import {
  Building2,
  Save,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Globe,
  Mail,
  Phone,
  MapPin,
  Clock,
  Coins,
  Layout,
  FileText,
  Printer,
  Image as ImageIcon,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { api, ApiError, BrandingUploadPayload } from '../services/api.ts';
import {
  AuthUser,
  BrandingAssetType,
  CompanyProfile,
  CompanySettingsChangeRequestItem,
} from '../../shared/types.ts';
import { SUPPORTED_CURRENCIES, COMMON_TIMEZONES } from '../../shared/constants.ts';
import { BrandingAssetCard } from '../components/company/BrandingAssetCard.tsx';
import { LoadingSpinner } from '../components/common/LoadingSpinner.tsx';

const DocumentPrintSettingsSection = lazy(() =>
  import('../components/company/DocumentPrintSettingsSection.tsx').then((m) => ({
    default: m.DocumentPrintSettingsSection,
  }))
);

export const STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS = [4, 5, 6] as const;

export function normalizePermittedMonthlyLeaveAllowances(raw?: number[] | null): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS];
  }
  const valid = Array.from(
    new Set(
      raw
        .map((v) => Number(v))
        .filter(
          (n) =>
            Number.isInteger(n) &&
            (STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS as readonly number[]).includes(n)
        )
    )
  ).sort((a, b) => a - b);
  return valid.length > 0 ? valid : [...STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS];
}

export function validatePermittedMonthlyLeaveAllowancesSelection(selected: number[]): string | null {
  if (!Array.isArray(selected) || selected.length === 0) {
    return 'Select at least one permitted monthly leave allowance option (4, 5, or 6 days).';
  }
  const hasInvalid = selected.some(
    (n) =>
      !Number.isInteger(n) ||
      !(STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS as readonly number[]).includes(n)
  );
  if (hasInvalid) {
    return 'Permitted monthly leave allowances may only include 4, 5, or 6 days.';
  }
  return null;
}

export interface PermittedMonthlyLeaveAllowancesCardProps {
  selectedAllowances: number[];
  isSuperAdmin: boolean;
  onToggle: (days: number) => void;
}

export const PermittedMonthlyLeaveAllowancesCard: React.FC<
  PermittedMonthlyLeaveAllowancesCardProps
> = ({ selectedAllowances, isSuperAdmin, onToggle }) => (
  <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="space-y-1">
        <div className="text-xs font-semibold text-slate-200">
          Permitted Monthly Leave Allowance Options (Days / Month)
        </div>
        <p className="text-[11px] text-slate-400 max-w-2xl">
          Select which monthly leave allowance options (4, 5, or 6 days) administrators can assign to employees. Defaults to 4, 5, and 6 days when unconfigured. Employee monthly leave allowance changes always take effect from the 1st day of the next company-local calendar month.
        </p>
      </div>
      <span className="text-[11px] text-slate-400">
        {isSuperAdmin
          ? 'Super Admin changes apply immediately'
          : 'Admin changes require Super Admin approval'}
      </span>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS.map((days) => {
        const isSelected = selectedAllowances.includes(days);
        return (
          <label
            key={days}
            className={`flex items-center justify-between gap-3 p-3 rounded-lg border text-xs cursor-pointer transition ${
              isSelected
                ? 'bg-indigo-950/40 border-indigo-600 text-slate-100'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
            }`}
          >
            <div>
              <div className="font-semibold">{days} Days / Month</div>
              <div className="text-[11px] text-slate-400">
                {isSelected ? 'Permitted for employee assignment' : 'Disabled for this company'}
              </div>
            </div>
            <input
              type="checkbox"
              aria-label={`Permit ${days} days monthly leave allowance`}
              checked={isSelected}
              onChange={() => onToggle(days)}
              className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
            />
          </label>
        );
      })}
    </div>

    {selectedAllowances.length === 0 && (
      <div className="text-[11px] text-rose-300">
        Select at least one permitted monthly leave allowance option (4, 5, or 6 days).
      </div>
    )}
  </div>
);

interface CompanyAdminPageProps {
  currentUser?: AuthUser | null;
  onProfileUpdated?: (updated: CompanyProfile) => void;
}

export const CompanyAdminPage: React.FC<CompanyAdminPageProps> = ({ currentUser, onProfileUpdated }) => {
  const [activeTab, setActiveTab] = useState<'PROFILE' | 'PRINT_SETTINGS'>('PROFILE');
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [taxRegistrationNumber, setTaxRegistrationNumber] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [timezone, setTimezone] = useState('UTC');
  const [logoUrl, setLogoUrl] = useState('');
  const [address, setAddress] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [appHeaderTitle, setAppHeaderTitle] = useState('');
  const [salesInvoiceEnabled, setSalesInvoiceEnabled] = useState(false);
  const [permittedMonthlyLeaveAllowances, setPermittedMonthlyLeaveAllowances] = useState<number[]>([
    ...STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS,
  ]);
  const [changeRequests, setChangeRequests] = useState<CompanySettingsChangeRequestItem[]>([]);

  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  const canEditBranding = currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'ADMIN';

  const applyLoadedProfile = (data: CompanyProfile) => {
    setProfile(data);
    setName(data.name || '');
    setLegalName(data.legalName || '');
    setTaxId(data.taxId || '');
    setTaxRegistrationNumber(data.taxRegistrationNumber || '');
    setCurrency(data.currency || 'USD');
    setTimezone(data.timezone || 'UTC');
    setLogoUrl(data.logoUrl || '');
    setAddress(data.address || '');
    setAddressLine1(data.addressLine1 || '');
    setAddressLine2(data.addressLine2 || '');
    setCity(data.city || '');
    setStateRegion(data.state || '');
    setPostalCode(data.postalCode || '');
    setCountry(data.country || '');
    setPhone(data.phone || '');
    setEmail(data.email || '');
    setWebsite(data.website || '');
    setAppHeaderTitle(data.appHeaderTitle || '');
    setSalesInvoiceEnabled(Boolean(data.salesInvoiceEnabled));
    setPermittedMonthlyLeaveAllowances(
      normalizePermittedMonthlyLeaveAllowances(data.permittedMonthlyLeaveAllowances)
    );
  };

  useEffect(() => {
    const loadProfile = async () => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [data, pendingReqs] = await Promise.all([
          api.getCompanyProfile(),
          api.getCompanySettingsChangeRequests('PENDING').catch(() => []),
        ]);
        applyLoadedProfile(data);
        setChangeRequests(pendingReqs);
      } catch (err: unknown) {
        if (currentUser?.isPreview) {
          setName('CoreERP Preview Sandbox');
          setLegalName('CoreERP Temporary Preview Entity');
          setCurrency('USD');
          setTimezone('UTC');
          setAppHeaderTitle('CoreERP Enterprise (Preview)');
          setSalesInvoiceEnabled(true);
          setPermittedMonthlyLeaveAllowances([...STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS]);
        } else if (err instanceof ApiError) {
          setErrorMessage(err.message);
        } else {
          setErrorMessage('Failed to load company profile.');
        }
      } finally {
        setIsLoading(false);
      }
    };

    loadProfile();
  }, []);

  const handleUploadBrandingAsset = async (
    assetType: BrandingAssetType,
    payload: BrandingUploadPayload
  ) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setPendingMessage(null);

    if (currentUser?.isPreview) {
      const slot =
        assetType === 'LOGO'
          ? 'logo'
          : assetType === 'SEAL'
          ? 'seal'
          : assetType === 'PAYMENT_QR'
          ? 'paymentQr'
          : 'signature';
      const previewAsset = {
        id: `preview-${slot}`,
        companyId: profile?.id || 'preview-company-id',
        assetType,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        fileSizeBytes: payload.dataBase64.length,
        widthPx: payload.widthPx,
        heightPx: payload.heightPx,
        aspectRatio: Number((payload.widthPx / Math.max(1, payload.heightPx)).toFixed(4)),
        sha256Hash: 'preview',
        url: payload.dataBase64,
        status: 'ACTIVE' as const,
        createdAt: new Date().toISOString(),
      };
      const base = profile || {
        id: 'preview-company-id',
        code: 'PREVIEW',
        name: name || 'CoreERP Preview Sandbox',
        currency,
        timezone,
      };
      const nextProfile: CompanyProfile = {
        ...base,
        logoUrl: assetType === 'LOGO' ? payload.dataBase64 : base.logoUrl,
        sealUrl: assetType === 'SEAL' ? payload.dataBase64 : base.sealUrl,
        signatureUrl: assetType === 'SIGNATURE' ? payload.dataBase64 : base.signatureUrl,
        paymentQrUrl: assetType === 'PAYMENT_QR' ? payload.dataBase64 : base.paymentQrUrl,
        brandingAssets: {
          version: 1,
          logo: assetType === 'LOGO' ? previewAsset : base.brandingAssets?.logo || null,
          seal: assetType === 'SEAL' ? previewAsset : base.brandingAssets?.seal || null,
          signature:
            assetType === 'SIGNATURE' ? previewAsset : base.brandingAssets?.signature || null,
          paymentQr:
            assetType === 'PAYMENT_QR' ? previewAsset : base.brandingAssets?.paymentQr || null,
        },
      };
      applyLoadedProfile(nextProfile);
      setSuccessMessage(`Preview Mode: ${assetType} branding updated in-memory.`);
      onProfileUpdated?.(nextProfile);
      return;
    }

    const res = await api.uploadCompanyBrandingAsset(assetType, {
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      dataBase64: payload.dataBase64,
      fallbackPngBase64: payload.fallbackPngBase64,
    });

    if (res.pendingApproval) {
      setPendingMessage(
        `${assetType} branding upload submitted for Super Admin maker-checker approval.`
      );
      const reqs = await api.getCompanySettingsChangeRequests('PENDING').catch(() => []);
      setChangeRequests(reqs);
    } else if (res.profile) {
      applyLoadedProfile(res.profile);
      setSuccessMessage(`${assetType} branding asset uploaded and activated.`);
      onProfileUpdated?.(res.profile);
    }
  };

  const handleRemoveBrandingAsset = async (assetType: BrandingAssetType) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setPendingMessage(null);

    if (currentUser?.isPreview) {
      const slot =
        assetType === 'LOGO'
          ? 'logo'
          : assetType === 'SEAL'
          ? 'seal'
          : assetType === 'PAYMENT_QR'
          ? 'paymentQr'
          : 'signature';
      const base = profile || {
        id: 'preview-company-id',
        code: 'PREVIEW',
        name: name || 'CoreERP Preview Sandbox',
        currency,
        timezone,
      };
      const nextProfile: CompanyProfile = {
        ...base,
        logoUrl: assetType === 'LOGO' ? null : base.logoUrl,
        sealUrl: assetType === 'SEAL' ? null : base.sealUrl,
        signatureUrl: assetType === 'SIGNATURE' ? null : base.signatureUrl,
        paymentQrUrl: assetType === 'PAYMENT_QR' ? null : base.paymentQrUrl,
        brandingAssets: {
          version: 1,
          logo: slot === 'logo' ? null : base.brandingAssets?.logo || null,
          seal: slot === 'seal' ? null : base.brandingAssets?.seal || null,
          signature: slot === 'signature' ? null : base.brandingAssets?.signature || null,
          paymentQr: slot === 'paymentQr' ? null : base.brandingAssets?.paymentQr || null,
        },
      };
      applyLoadedProfile(nextProfile);
      setSuccessMessage(`Preview Mode: ${assetType} removed.`);
      onProfileUpdated?.(nextProfile);
      return;
    }

    const res = await api.removeCompanyBrandingAsset(assetType);
    if (res.pendingApproval) {
      setPendingMessage(
        `${assetType} removal request submitted for Super Admin maker-checker approval.`
      );
      const reqs = await api.getCompanySettingsChangeRequests('PENDING').catch(() => []);
      setChangeRequests(reqs);
    } else if (res.profile) {
      applyLoadedProfile(res.profile);
      setSuccessMessage(`${assetType} removed from active company branding.`);
      onProfileUpdated?.(res.profile);
    }
  };

  const handleApproveChangeRequest = async (reqId: string) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await api.approveCompanySettingsChangeRequest(reqId);
      applyLoadedProfile(res.profile);
      onProfileUpdated?.(res.profile);
      setSuccessMessage('Settings change request approved and applied.');
      const reqs = await api.getCompanySettingsChangeRequests('PENDING').catch(() => []);
      setChangeRequests(reqs);
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Approval failed.');
    }
  };

  const handleRejectChangeRequest = async (reqId: string) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await api.rejectCompanySettingsChangeRequest(reqId, 'Rejected during admin review.');
      setSuccessMessage('Settings change request rejected.');
      const reqs = await api.getCompanySettingsChangeRequests('PENDING').catch(() => []);
      setChangeRequests(reqs);
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Rejection failed.');
    }
  };

  const handleTogglePermittedAllowance = (days: number) => {
    setPermittedMonthlyLeaveAllowances((prev) => {
      const next = prev.includes(days) ? prev.filter((item) => item !== days) : [...prev, days];
      return next.sort((a, b) => a - b);
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setPendingMessage(null);

    if (!name.trim()) {
      setErrorMessage('Company display name is required.');
      return;
    }

    const allowanceValidationError = validatePermittedMonthlyLeaveAllowancesSelection(
      permittedMonthlyLeaveAllowances
    );
    if (allowanceValidationError) {
      setErrorMessage(allowanceValidationError);
      return;
    }

    const sortedAllowances = [...permittedMonthlyLeaveAllowances].sort((a, b) => a - b);

    if (currentUser?.isPreview) {
      const mockUpdated: CompanyProfile = {
        ...profile,
        id: profile?.id || 'preview-company-id',
        code: profile?.code || 'PREVIEW',
        name: name.trim(),
        legalName: legalName.trim() || null,
        taxId: taxId.trim() || null,
        taxRegistrationNumber: taxRegistrationNumber.trim() || null,
        currency,
        timezone,
        logoUrl: logoUrl.trim() || null,
        address: address.trim() || null,
        addressLine1: addressLine1.trim() || null,
        addressLine2: addressLine2.trim() || null,
        city: city.trim() || null,
        state: stateRegion.trim() || null,
        postalCode: postalCode.trim() || null,
        country: country.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        website: website.trim() || null,
        appHeaderTitle: appHeaderTitle.trim() || null,
        salesInvoiceEnabled,
        permittedMonthlyLeaveAllowances: sortedAllowances,
      };
      setProfile(mockUpdated);
      setSuccessMessage('Preview Mode: Company feature settings and leave allowance policy updated in-memory for this UI exploration session.');
      if (onProfileUpdated) {
        onProfileUpdated(mockUpdated);
      }
      return;
    }

    setIsSaving(true);
    try {
      const updated = await api.updateCompanyProfile({
        name: name.trim(),
        legalName: legalName.trim() || null,
        taxId: taxId.trim() || null,
        taxRegistrationNumber: taxRegistrationNumber.trim() || null,
        currency,
        timezone,
        logoUrl: logoUrl.trim() || null,
        address: address.trim() || null,
        addressLine1: addressLine1.trim() || null,
        addressLine2: addressLine2.trim() || null,
        city: city.trim() || null,
        state: stateRegion.trim() || null,
        postalCode: postalCode.trim() || null,
        country: country.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        website: website.trim() || null,
        appHeaderTitle: appHeaderTitle.trim() || null,
        salesInvoiceEnabled,
        permittedMonthlyLeaveAllowances: sortedAllowances,
      });

      applyLoadedProfile(updated);
      if (updated.pendingApproval) {
        setPendingMessage(
          'Protected company settings changes were submitted for Super Admin approval (Maker-Checker).'
        );
        const reqs = await api.getCompanySettingsChangeRequests('PENDING').catch(() => []);
        setChangeRequests(reqs);
      } else {
        setSuccessMessage('Company profile and settings updated successfully.');
        if (onProfileUpdated) {
          onProfileUpdated(updated);
        }
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to save company settings.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-slate-400">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-500 mb-3" />
        <p className="text-xs">Loading company configuration...</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <Building2 className="w-6 h-6 text-indigo-400" />
            Company Profile &amp; Operational Settings
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Configure multi-tenant branding, operating currency, timezone, and document print templates
          </p>
        </div>

        <div className="inline-flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1">
          <button
            type="button"
            onClick={() => setActiveTab('PROFILE')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
              activeTab === 'PROFILE'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Company Profile</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('PRINT_SETTINGS')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
              activeTab === 'PRINT_SETTINGS'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Document Print Settings</span>
          </button>
        </div>
      </div>

      {activeTab === 'PRINT_SETTINGS' ? (
        <Suspense fallback={<LoadingSpinner message="Loading document print settings..." size="md" />}>
          <DocumentPrintSettingsSection
            companyProfile={profile}
            currentUser={currentUser}
            onProfileUpdated={(updated) => {
              setProfile(updated);
              if (onProfileUpdated) onProfileUpdated(updated);
            }}
          />
        </Suspense>
      ) : (
        <>
          {errorMessage && (
            <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="bg-emerald-950/60 border border-emerald-800/60 rounded-xl p-3.5 text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          {pendingMessage && (
            <div className="bg-amber-950/60 border border-amber-700/60 rounded-xl p-3.5 text-xs text-amber-200 flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-400 shrink-0" />
              <span>{pendingMessage}</span>
            </div>
          )}

          {changeRequests.length > 0 && (
            <div className="bg-slate-900 border border-amber-800/50 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Pending Governance Approvals ({changeRequests.length})</span>
                </div>
                {!isSuperAdmin && (
                  <span className="text-[11px] text-slate-400">
                    Maker-checker review by Super Admin required
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {changeRequests.map((req) => {
                  const payloadObj = req.payload as {
                    type?: string;
                    operation?: string;
                    assetType?: string;
                    permittedMonthlyLeaveAllowances?: number[];
                  };
                  const label =
                    payloadObj?.type === 'COMPANY_BRANDING_ASSET'
                      ? `Branding ${payloadObj.operation || 'UPDATE'} (${payloadObj.assetType || 'ASSET'})`
                      : String(payloadObj?.type || 'COMPANY_PROFILE').replace(/_/g, ' ');
                  return (
                    <div
                      key={req.id}
                      className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-xs"
                    >
                      <div>
                        <span className="font-semibold text-slate-100">{label}</span>
                        <span className="text-slate-400 ml-2">
                          requested by {req.requestedByName || req.requestedByEmail || 'Admin'}
                        </span>
                        {Array.isArray(payloadObj?.permittedMonthlyLeaveAllowances) &&
                          payloadObj.permittedMonthlyLeaveAllowances.length > 0 && (
                            <div className="text-[11px] text-amber-300 mt-0.5">
                              Permitted monthly leave allowances:{' '}
                              {payloadObj.permittedMonthlyLeaveAllowances.join(', ')} days
                            </div>
                          )}
                      </div>
                      {isSuperAdmin && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleApproveChangeRequest(req.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold cursor-pointer whitespace-nowrap shrink-0"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Approve</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRejectChangeRequest(req.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-red-900/70 hover:bg-red-800 text-red-100 text-[11px] font-semibold cursor-pointer whitespace-nowrap shrink-0"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Reject</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
        {/* Section 1: Core Corporate Identity */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="text-sm font-semibold text-slate-200 pb-2 border-b border-slate-800 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-indigo-400" />
            Corporate Identity &amp; Tenant Code
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Tenant Code (Immutable Identifier)
              </label>
              <input
                type="text"
                disabled
                value={profile?.code || ''}
                className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-400 cursor-not-allowed"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Company Display Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Industrial Corp"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Legal Registered Entity Name
              </label>
              <input
                type="text"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder="e.g. Acme Industrial Corporation LLC"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Tax Identification / VAT Number
              </label>
              <input
                type="text"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
                placeholder="e.g. 29AABCD1234E1Z5"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                GSTIN / Tax Registration Number (Optional)
              </label>
              <input
                type="text"
                value={taxRegistrationNumber}
                onChange={(e) => setTaxRegistrationNumber(e.target.value)}
                placeholder="e.g. 29AABCD1234E1Z5 (displayed on invoices if configured)"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        </div>

        {/* Section 2: Regional & System Standards */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="text-sm font-semibold text-slate-200 pb-2 border-b border-slate-800 flex items-center gap-2">
            <Clock className="w-4 h-4 text-violet-400" />
            Regional &amp; Currency Standards
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Coins className="w-3.5 h-3.5 text-amber-400" />
                Default Base Currency
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              >
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-cyan-400" />
                Operating Timezone
              </label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Layout className="w-3.5 h-3.5 text-indigo-400" />
                Application Header Title Override (Optional)
              </label>
              <input
                type="text"
                value={appHeaderTitle}
                onChange={(e) => setAppHeaderTitle(e.target.value)}
                placeholder="e.g. Acme Enterprise ERP"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        </div>

        {/* Section 3: Contact & Brand Assets */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="text-sm font-semibold text-slate-200 pb-2 border-b border-slate-800 flex items-center gap-2">
            <Globe className="w-4 h-4 text-cyan-400" />
            Contact Information &amp; Branding Assets
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5 text-slate-400" />
                General Contact Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="contact@yourcompany.com"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5 text-slate-400" />
                Business Phone Number
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 (555) 000-1234"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-slate-400" />
                Physical Headquarters Address (Summary / Legacy Line)
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="100 Main Street, Suite 400, Bengaluru, Karnataka 560001"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Address Line 1
              </label>
              <input
                type="text"
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                placeholder="Building / Street / Floor"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Address Line 2
              </label>
              <input
                type="text"
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
                placeholder="Area / Landmark (Optional)"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Bengaluru"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                State / Province
              </label>
              <input
                type="text"
                value={stateRegion}
                onChange={(e) => setStateRegion(e.target.value)}
                placeholder="e.g. Karnataka"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Postal / PIN Code
              </label>
              <input
                type="text"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                placeholder="e.g. 560001"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Country</label>
              <input
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="e.g. India"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-slate-400" />
                Corporate Website
              </label>
              <input
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://yourcompany.com"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Logo Asset Reference URL
              </label>
              <input
                type="text"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="/api/company/branding/assets/.../file or https://..."
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[10px] text-slate-400 mt-1">
                Updated automatically when you upload a Company Logo file below, or specify a safe HTTPS/relative asset path.
              </p>
            </div>
          </div>
        </div>

        {/* Section 3b: Branding & Document Identity Asset Manager */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800">
            <div className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-indigo-400" />
              <span>Branding &amp; Document Identity Assets</span>
            </div>
            <span className="text-[11px] text-slate-400">
              {isSuperAdmin
                ? 'Super Admin changes activate immediately · Past issued documents stay immutable'
                : 'Admin uploads require Super Admin maker-checker approval'}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <BrandingAssetCard
              assetType="LOGO"
              title="Company Logo"
              description="Appears in print headers, PDF exports, Word exports, and ERP branding."
              recommendedHint="PNG, JPG, or WebP · preserves aspect ratio"
              asset={profile?.brandingAssets?.logo || null}
              fallbackUrl={profile?.logoUrl}
              pendingNote={
                changeRequests.some(
                  (r) =>
                    (r.payload as { type?: string; assetType?: string })?.type ===
                      'COMPANY_BRANDING_ASSET' &&
                    (r.payload as { assetType?: string })?.assetType === 'LOGO'
                )
                  ? 'A logo update is currently awaiting Super Admin approval.'
                  : null
              }
              disabled={!canEditBranding}
              onUpload={handleUploadBrandingAsset}
              onRemove={handleRemoveBrandingAsset}
            />

            <BrandingAssetCard
              assetType="SEAL"
              title="Official Company Seal / Stamp"
              description="Rendered near authorized signatory on official quotations, invoices, and receipts."
              recommendedHint="Square transparent PNG or WebP stamp"
              asset={profile?.brandingAssets?.seal || null}
              fallbackUrl={profile?.sealUrl || profile?.documentBranding?.sealUrl}
              pendingNote={
                changeRequests.some(
                  (r) =>
                    (r.payload as { type?: string; assetType?: string })?.type ===
                      'COMPANY_BRANDING_ASSET' &&
                    (r.payload as { assetType?: string })?.assetType === 'SEAL'
                )
                  ? 'A company seal update is currently awaiting Super Admin approval.'
                  : null
              }
              disabled={!canEditBranding}
              onUpload={handleUploadBrandingAsset}
              onRemove={handleRemoveBrandingAsset}
            />

            <BrandingAssetCard
              assetType="SIGNATURE"
              title="Authorized Signature"
              description="Embedded cleanly above the Authorized Signatory block on documents."
              recommendedHint="Horizontal transparent PNG signature"
              asset={profile?.brandingAssets?.signature || null}
              fallbackUrl={profile?.signatureUrl || profile?.documentBranding?.signatureUrl}
              pendingNote={
                changeRequests.some(
                  (r) =>
                    (r.payload as { type?: string; assetType?: string })?.type ===
                      'COMPANY_BRANDING_ASSET' &&
                    (r.payload as { assetType?: string })?.assetType === 'SIGNATURE'
                )
                  ? 'A signature update is currently awaiting Super Admin approval.'
                  : null
              }
              disabled={!canEditBranding}
              onUpload={handleUploadBrandingAsset}
              onRemove={handleRemoveBrandingAsset}
            />

            <BrandingAssetCard
              assetType="PAYMENT_QR"
              title="UPI Payment QR Code"
              description="Upload your existing UPI QR image (PNG/JPG). Displayed on invoices only when enabled in Print Settings."
              recommendedHint="Square PNG, JPG, or JPEG · kept unmodified"
              asset={profile?.brandingAssets?.paymentQr || null}
              fallbackUrl={profile?.paymentQrUrl || profile?.documentBranding?.paymentQrUrl}
              pendingNote={
                changeRequests.some(
                  (r) =>
                    (r.payload as { type?: string; assetType?: string })?.type ===
                      'COMPANY_BRANDING_ASSET' &&
                    (r.payload as { assetType?: string })?.assetType === 'PAYMENT_QR'
                )
                  ? 'A Payment QR update is currently awaiting Super Admin approval.'
                  : null
              }
              disabled={!canEditBranding}
              onUpload={handleUploadBrandingAsset}
              onRemove={handleRemoveBrandingAsset}
            />
          </div>
        </div>

        {/* Section 4: Business Modules & Workflow Features */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="text-sm font-semibold text-slate-200 pb-2 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-400" />
              <span>Business Modules &amp; Feature Activation</span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono">Company Policy</span>
          </div>

          <div className="flex items-start justify-between gap-4 p-4 rounded-xl bg-slate-950 border border-slate-800">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-200">Sales Invoices &amp; Customer Billing</span>
                <span
                  className={`text-[9px] px-2 py-0.5 rounded font-mono font-bold uppercase ${
                    salesInvoiceEnabled
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                      : 'bg-slate-800 text-slate-400 border border-slate-700'
                  }`}
                >
                  {salesInvoiceEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 max-w-xl">
                When enabled, authorized users can create, issue, and print sales invoices with atomic double-entry General Ledger integration. When disabled, sales invoices cannot be drafted or issued, and the invoice navigation is hidden. Other accounting workflows (Quotations, Customer Receipts, Contra entries, and Journal Vouchers) remain fully accessible.
              </p>
            </div>

            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={salesInvoiceEnabled}
                onChange={(e) => setSalesInvoiceEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
            </label>
          </div>

          <PermittedMonthlyLeaveAllowancesCard
            selectedAllowances={permittedMonthlyLeaveAllowances}
            isSuperAdmin={isSuperAdmin}
            onToggle={handleTogglePermittedAllowance}
          />
        </div>

        {/* Save Button */}
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={isSaving}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md transition cursor-pointer disabled:opacity-50"
          >
            {isSaving ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Saving Changes...</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                <span>Save Company Settings</span>
              </>
            )}
          </button>
        </div>
          </form>
        </>
      )}
    </div>
  );
};
