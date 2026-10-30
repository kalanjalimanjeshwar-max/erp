import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { CompanyProfile, AuthUser } from '../../shared/types.ts';
import { SUPPORTED_CURRENCIES, COMMON_TIMEZONES } from '../../shared/constants.ts';

interface CompanyAdminPageProps {
  currentUser?: AuthUser | null;
  onProfileUpdated?: (updated: CompanyProfile) => void;
}

export const CompanyAdminPage: React.FC<CompanyAdminPageProps> = ({ currentUser, onProfileUpdated }) => {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [timezone, setTimezone] = useState('UTC');
  const [logoUrl, setLogoUrl] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [appHeaderTitle, setAppHeaderTitle] = useState('');
  const [salesInvoiceEnabled, setSalesInvoiceEnabled] = useState(false);

  useEffect(() => {
    const loadProfile = async () => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const data = await api.getCompanyProfile();
        setProfile(data);
        setName(data.name || '');
        setLegalName(data.legalName || '');
        setTaxId(data.taxId || '');
        setCurrency(data.currency || 'USD');
        setTimezone(data.timezone || 'UTC');
        setLogoUrl(data.logoUrl || '');
        setAddress(data.address || '');
        setPhone(data.phone || '');
        setEmail(data.email || '');
        setWebsite(data.website || '');
        setAppHeaderTitle(data.appHeaderTitle || '');
        setSalesInvoiceEnabled(Boolean(data.salesInvoiceEnabled));
      } catch (err: unknown) {
        if (currentUser?.isPreview) {
          setName('CoreERP Preview Sandbox');
          setLegalName('CoreERP Temporary Preview Entity');
          setCurrency('USD');
          setTimezone('UTC');
          setAppHeaderTitle('CoreERP Enterprise (Preview)');
          setSalesInvoiceEnabled(true);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!name.trim()) {
      setErrorMessage('Company display name is required.');
      return;
    }

    if (currentUser?.isPreview) {
      const mockUpdated: CompanyProfile = {
        id: 'preview-company-id',
        code: 'PREVIEW',
        name: name.trim(),
        legalName: legalName.trim() || null,
        taxId: taxId.trim() || null,
        currency,
        timezone,
        logoUrl: logoUrl.trim() || null,
        address: address.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        website: website.trim() || null,
        appHeaderTitle: appHeaderTitle.trim() || null,
        salesInvoiceEnabled,
      };
      setProfile(mockUpdated);
      setSuccessMessage('Preview Mode: Company feature settings and Sales Invoice policy updated in-memory for this UI exploration session.');
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
        currency,
        timezone,
        logoUrl: logoUrl.trim() || null,
        address: address.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        website: website.trim() || null,
        appHeaderTitle: appHeaderTitle.trim() || null,
        salesInvoiceEnabled,
      });

      setProfile(updated);
      setSuccessMessage('Company profile and settings updated successfully.');
      if (onProfileUpdated) {
        onProfileUpdated(updated);
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
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
          <Building2 className="w-6 h-6 text-indigo-400" />
          Company Profile &amp; Operational Settings
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Configure multi-tenant branding, operating currency, legal registration, and contact details
        </p>
      </div>

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
                placeholder="e.g. US-TAX-1234567"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
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
                Physical Headquarters Address
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="100 Main Street, Suite 400, New York, NY 10001"
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
                Secure Logo Asset URL
              </label>
              <input
                type="text"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://yourdomain.com/assets/logo.png"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[10px] text-slate-400 mt-1">
                Must be a secure HTTP/HTTPS URL or safe static asset path. Executable scripts rejected.
              </p>
            </div>
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
    </div>
  );
};
