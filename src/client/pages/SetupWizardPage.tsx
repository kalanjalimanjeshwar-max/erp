import React, { useState } from 'react';
import {
  Building2,
  UserCheck,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  RefreshCw,
  Eye,
  EyeOff,
  LogIn,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { SetupStatusResponse, DatabaseReadiness } from '../../shared/types.ts';
import { SUPPORTED_CURRENCIES, COMMON_TIMEZONES } from '../../shared/constants.ts';

interface SetupWizardProps {
  setupStatus: SetupStatusResponse | null;
  readiness: DatabaseReadiness | null;
  onSetupSuccess: () => void;
  onNavigateToLogin?: () => void;
  onNavigateToDbStatus?: () => void;
}

export const SetupWizardPage: React.FC<SetupWizardProps> = ({
  setupStatus,
  readiness,
  onSetupSuccess,
  onNavigateToLogin,
  onNavigateToDbStatus,
}) => {
  const isDbConnected = readiness?.status === 'connected';
  const isAlreadySetup = setupStatus?.isSetupRequired === false;

  const [companyName, setCompanyName] = useState('');
  const [companyCode, setCompanyCode] = useState('');
  const [legalName, setLegalName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [timezone, setTimezone] = useState('UTC');
  const [logoUrl, setLogoUrl] = useState('');

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [successInfo, setSuccessInfo] = useState<{ companyName: string; adminEmail: string } | null>(null);

  if (isAlreadySetup) {
    return (
      <div className="max-w-2xl mx-auto bg-slate-900 border border-slate-800 rounded-xl p-8 text-center space-y-4">
        <div className="w-14 h-14 bg-emerald-950/80 border border-emerald-800/60 rounded-2xl flex items-center justify-center text-emerald-400 mx-auto">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-bold text-slate-100">Initial Setup Already Completed</h2>
        <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
          The primary company ({setupStatus?.companyInfo?.name}) and Super Admin have already been initialized in the database.
          To maintain security and prevent unauthorized takeover, the bootstrap wizard is locked.
        </p>
        <div className="p-4 bg-slate-950 rounded-lg border border-slate-800 text-xs font-mono text-slate-300 max-w-md mx-auto text-left space-y-1">
          <div><span className="text-slate-400">Company Name:</span> {setupStatus?.companyInfo?.name}</div>
          <div><span className="text-slate-400">Company Code:</span> {setupStatus?.companyInfo?.code}</div>
          <div><span className="text-slate-400">Currency:</span> {setupStatus?.companyInfo?.currency}</div>
          <div><span className="text-slate-400">Timezone:</span> {setupStatus?.companyInfo?.timezone}</div>
        </div>
        {onNavigateToLogin && (
          <div className="pt-2">
            <button
              type="button"
              onClick={onNavigateToLogin}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-md transition cursor-pointer inline-flex items-center gap-2"
            >
              <LogIn className="w-4 h-4" />
              <span>Proceed to Sign In</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    // Client-side quick checks
    if (!companyName.trim()) {
      setErrorMessage('Company Name is required.');
      return;
    }
    if (!companyCode.trim()) {
      setErrorMessage('Company Code is required.');
      return;
    }
    if (!email.trim() || !fullName.trim()) {
      setErrorMessage('Super Admin Full Name and Email are required.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }
    if (password.length < 10) {
      setErrorMessage('Password must be at least 10 characters long.');
      return;
    }

    if (!isDbConnected) {
      setErrorMessage('Cannot initialize company: PostgreSQL database is currently unreachable. Start PostgreSQL first.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await api.bootstrapSetup({
        company: {
          name: companyName.trim(),
          code: companyCode.trim().toUpperCase(),
          legalName: legalName.trim() || undefined,
          taxId: taxId.trim() || undefined,
          currency,
          timezone,
          logoUrl: logoUrl.trim() || undefined,
        },
        superAdmin: {
          fullName: fullName.trim(),
          email: email.trim(),
          password,
          confirmPassword,
        },
      });

      setSuccessInfo({
        companyName: response.company.name,
        adminEmail: response.superAdmin.email,
      });
      onSetupSuccess();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
        if (Array.isArray(err.details)) {
          const map: Record<string, string> = {};
          err.details.forEach((item: { field?: string; message?: string }) => {
            if (item.field && item.message) map[item.field] = item.message;
          });
          setFieldErrors(map);
        }
      } else {
        setErrorMessage('Failed to submit initial setup. Please check connection and try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (successInfo) {
    return (
      <div className="max-w-2xl mx-auto bg-slate-900 border border-emerald-800/60 rounded-xl p-8 text-center space-y-4">
        <div className="w-14 h-14 bg-emerald-950/80 border border-emerald-800/60 rounded-2xl flex items-center justify-center text-emerald-400 mx-auto">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-bold text-slate-100">Setup Successfully Initialized!</h2>
        <p className="text-xs text-slate-300 max-w-md mx-auto leading-relaxed">
          Company <strong className="text-emerald-400">{successInfo.companyName}</strong> and Super Admin{' '}
          <strong className="text-indigo-400">{successInfo.adminEmail}</strong> have been transactionally created in PostgreSQL.
        </p>
        <button
          onClick={onSetupSuccess}
          className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-md transition cursor-pointer"
        >
          Proceed to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <Building2 className="w-6 h-6 text-indigo-400" />
            Enterprise Initial Setup Wizard
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Configure your primary corporate entity and root Super Administrator. No hardcoded default credentials are used.
          </p>
        </div>
        {onNavigateToLogin && (
          <button
            type="button"
            onClick={onNavigateToLogin}
            className="self-start sm:self-auto px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold flex items-center gap-2 transition cursor-pointer"
          >
            <LogIn className="w-4 h-4 text-indigo-400" />
            <span>Already Setup? Sign In</span>
          </button>
        )}
      </div>

      {!isDbConnected && (
        <div className="bg-amber-950/60 border border-amber-800/60 rounded-xl p-4 text-xs text-amber-200 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <strong className="font-semibold text-amber-100">PostgreSQL is not reachable:</strong>
            <p className="mt-0.5">
              Setup cannot be saved until PostgreSQL is running. Run <code className="bg-slate-950 px-1.5 py-0.5 rounded text-amber-300">docker compose up -d postgres</code> to start the database container.
            </p>
            {onNavigateToDbStatus && (
              <button
                type="button"
                onClick={onNavigateToDbStatus}
                className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-300 hover:text-amber-100 underline cursor-pointer"
              >
                <span>View Full Database Startup Instructions</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-4 text-xs text-red-200 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <strong className="font-semibold text-red-100">Setup Validation Error:</strong>
            <p className="mt-0.5">{errorMessage}</p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Step 1: Corporate Entity Information */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-800 text-sm font-semibold text-slate-200">
            <Building2 className="w-4 h-4 text-indigo-400" />
            1. Primary Company Profile
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Company Display Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                required
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. Acme Manufacturing Corp"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
              {fieldErrors['company.name'] && (
                <p className="text-[11px] text-red-400 mt-1">{fieldErrors['company.name']}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Tenant Code (Uppercase Identifier) <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                required
                maxLength={16}
                value={companyCode}
                onChange={(e) => setCompanyCode(e.target.value.toUpperCase())}
                placeholder="e.g. ACME"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 uppercase font-mono focus:outline-none focus:border-indigo-500"
              />
              {fieldErrors['company.code'] && (
                <p className="text-[11px] text-red-400 mt-1">{fieldErrors['company.code']}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Legal Name (Optional)</label>
              <input
                type="text"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder="e.g. Acme Industrial Solutions Ltd."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Tax Registration / VAT ID</label>
              <input
                type="text"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
                placeholder="e.g. US-TAX-98765432"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Base Operating Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              >
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Operational Timezone</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Company Logo URL (Optional)</label>
              <input
                type="url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://example.com/logo.png"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        </div>

        {/* Step 2: Super Admin Credentials */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-800 text-sm font-semibold text-slate-200">
            <UserCheck className="w-4 h-4 text-indigo-400" />
            2. Root Super Administrator
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Full Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Sarah Jenkins"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
              {fieldErrors['superAdmin.fullName'] && (
                <p className="text-[11px] text-red-400 mt-1">{fieldErrors['superAdmin.fullName']}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Admin Work Email <span className="text-red-400">*</span>
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@yourcompany.com"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />
              {fieldErrors['superAdmin.email'] && (
                <p className="text-[11px] text-red-400 mt-1">{fieldErrors['superAdmin.email']}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Password <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 10 chars, uppercase, lowercase, number, symbol"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-3 pr-10 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-200 transition cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {fieldErrors['superAdmin.password'] && (
                <p className="text-[11px] text-red-400 mt-1">{fieldErrors['superAdmin.password']}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Confirm Password <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-3 pr-10 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  title={showConfirmPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-200 transition cursor-pointer"
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {fieldErrors['superAdmin.confirmPassword'] && (
                <p className="text-[11px] text-red-400 mt-1">{fieldErrors['superAdmin.confirmPassword']}</p>
              )}
            </div>
          </div>
        </div>

        {/* Security & Action Footer */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Credentials are hashed with Bcrypt (cost factor 12) inside PostgreSQL.</span>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            {onNavigateToLogin && (
              <button
                type="button"
                onClick={onNavigateToLogin}
                className="w-full sm:w-auto px-4 py-2.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-800 border border-slate-700 rounded-lg transition cursor-pointer text-center"
              >
                Go to Sign In
              </button>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className={`w-full sm:w-auto px-6 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition shadow-md cursor-pointer ${
                isSubmitting
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white'
              }`}
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Bootstrapping Database...</span>
                </>
              ) : (
                <>
                  <span>Provision Company & Admin</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
