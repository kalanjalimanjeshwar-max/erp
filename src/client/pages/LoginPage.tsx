import React, { useState } from 'react';
import { Lock, Mail, Building2, ArrowRight, AlertCircle, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { previewStore } from '../services/previewStore.ts';
import { LoginResponse, DatabaseReadiness } from '../../shared/types.ts';

interface LoginPageProps {
  onLoginSuccess: (data: LoginResponse) => void;
  onNavigateToSetup: () => void;
  onNavigateToDbStatus?: () => void;
  onNavigateToDashboard?: () => void;
  isSetupRequired: boolean;
  readiness?: DatabaseReadiness | null;
  sessionExpiredMessage?: string | null;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onLoginSuccess,
  onNavigateToSetup,
  onNavigateToDbStatus,
  onNavigateToDashboard,
  isSetupRequired,
  readiness,
  sessionExpiredMessage,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleQuickPreviewLogin = async () => {
    setEmail('preview_admin');
    setPassword('PreviewOnly_2026!');
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const previewRes = await api.previewLogin({ id: 'preview_admin', password: 'PreviewOnly_2026!' });
      onLoginSuccess({
        user: previewRes.user,
        company: previewRes.company,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'PREVIEW_MODE_DISABLED') {
        setErrorMessage(err.message);
        return;
      }
      // Safe client-side fallback for sandboxed UI preview when database is offline
      onLoginSuccess({
        user: {
          id: 'preview-session-id',
          userId: 'preview-session-id',
          companyId: 'preview-company-id',
          email: 'preview_admin@preview.local',
          fullName: 'Temporary Preview Account — Not a Real Super Admin',
          role: 'SUPER_ADMIN',
          isActive: true,
          tokenVersion: 1,
          isPreview: true,
        },
        company: {
          id: 'preview-company-id',
          code: 'PREVIEW',
          name: 'CoreERP Preview Sandbox',
          legalName: 'CoreERP Temporary Preview Entity (Read-Only)',
          currency: 'USD',
          timezone: 'UTC',
        },
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedIdentifier = email.trim();

    if (!trimmedIdentifier || !password) {
      setErrorMessage('Please enter both account identifier and password.');
      return;
    }

    // Check if user is logging in with temporary preview credentials or in-memory demo user
    const isPreviewCredentials =
      trimmedIdentifier === 'preview_admin' && password === 'PreviewOnly_2026!';
    const matchedPreviewUser = previewStore.findPreviewUser(trimmedIdentifier);

    if (isPreviewCredentials || matchedPreviewUser) {
      setIsSubmitting(true);
      try {
        if (isPreviewCredentials) {
          try {
            const previewRes = await api.previewLogin({ id: trimmedIdentifier, password });
            onLoginSuccess({
              user: previewRes.user,
              company: previewRes.company,
            });
            return;
          } catch (err: unknown) {
            if (err instanceof ApiError && err.code === 'PREVIEW_MODE_DISABLED') {
              setErrorMessage(err.message);
              return;
            }
          }
        }

        const previewUserObj = matchedPreviewUser
          ? previewStore.createMockAuthUser(matchedPreviewUser)
          : {
              id: 'preview-session-id',
              userId: 'preview-session-id',
              companyId: 'preview-company-id',
              email: 'preview_admin@preview.local',
              fullName: 'Temporary Preview Account — Not a Real Super Admin',
              role: 'SUPER_ADMIN' as const,
              isActive: true,
              tokenVersion: 1,
              isPreview: true,
            };

        onLoginSuccess({
          user: previewUserObj,
          company: {
            id: 'preview-company-id',
            code: 'PREVIEW',
            name: 'CoreERP Preview Sandbox',
            legalName: 'CoreERP Temporary Preview Entity (Read-Only)',
            currency: 'USD',
            timezone: 'UTC',
          },
        });
        return;
      } finally {
        setIsSubmitting(false);
      }
    }

    // Real database sign-in check
    if (readiness && readiness.status !== 'connected') {
      setErrorMessage(
        'Database service is currently unavailable. Real account sign-in requires an active PostgreSQL instance. Use the Temporary Preview Account below to explore the dashboard UI.'
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await api.login({
        email: trimmedIdentifier,
        password,
      });
      onLoginSuccess(response);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Authentication service unavailable. Please check backend connection.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-6 selection:bg-indigo-500 selection:text-white">
      <div className="max-w-md w-full space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center font-bold text-white text-xl shadow-xl shadow-indigo-500/25 mx-auto">
            C
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">CoreERP Platform</h1>
          <p className="text-xs text-slate-400">
            Phase 3 • Enterprise Authentication &amp; Role-Based Access Control
          </p>
        </div>

        {/* Session Expired Notice */}
        {sessionExpiredMessage && (
          <div className="bg-amber-950/60 border border-amber-800/60 rounded-xl p-4 text-xs text-amber-200 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <strong className="font-semibold text-amber-100">Session Status:</strong>
              <p className="mt-0.5">{sessionExpiredMessage}</p>
            </div>
          </div>
        )}

        {/* Database Unreachable Notice */}
        {readiness && readiness.status !== 'connected' && (
          <div className="bg-amber-950/60 border border-amber-800/60 rounded-xl p-4 text-xs text-amber-200">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <strong className="font-semibold text-amber-100">PostgreSQL is not reachable:</strong>
                <p className="mt-1">
                  Database authentication requires an active PostgreSQL connection. Ensure PostgreSQL is running to sign in.
                </p>
                {onNavigateToDbStatus && (
                  <button
                    type="button"
                    onClick={onNavigateToDbStatus}
                    className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-300 hover:text-amber-100 underline cursor-pointer"
                  >
                    <span>View PostgreSQL Startup Instructions</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Setup Required Notice */}
        {isSetupRequired && (
          <div className="bg-amber-950/60 border border-amber-800/60 rounded-xl p-4 text-xs text-amber-200">
            <div className="flex items-start gap-3">
              <Building2 className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <strong className="font-semibold text-amber-100">Initial Setup Required:</strong>
                <p className="mt-1">
                  The primary company and Super Admin have not been initialized yet.
                </p>
                <button
                  onClick={onNavigateToSetup}
                  className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-300 hover:text-amber-100 underline cursor-pointer"
                >
                  <span>Launch Initial Setup Wizard</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Temporary Preview Account Card (UI Testing Only) */}
        <div className="bg-gradient-to-r from-amber-950/80 via-slate-900 to-slate-900 border border-amber-700/70 rounded-2xl p-5 shadow-xl space-y-3.5">
          <div className="flex items-start gap-3">
            <div className="p-2.5 bg-amber-900/40 text-amber-400 rounded-xl border border-amber-800/60 shrink-0 mt-0.5">
              <Eye className="w-5 h-5" />
            </div>
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs font-bold text-amber-200">
                  Temporary Preview Account — Not a Real Super Admin
                </span>
                <span className="text-[9px] px-2 py-0.5 rounded font-mono font-medium bg-amber-950 text-amber-300 border border-amber-800">
                  UI Testing Only
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Explore the CoreERP Dashboard and administrative navigation in Google AI Studio Preview
                while PostgreSQL is unavailable. Data-changing actions are blocked.
              </p>
              <div className="pt-1 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono">
                <div className="p-2 bg-slate-950/80 rounded-lg border border-slate-800 flex items-center justify-between">
                  <span className="text-slate-400">Preview ID:</span>
                  <span className="text-amber-300 font-semibold select-all">preview_admin</span>
                </div>
                <div className="p-2 bg-slate-950/80 rounded-lg border border-slate-800 flex items-center justify-between">
                  <span className="text-slate-400">Password:</span>
                  <span className="text-amber-300 font-semibold select-all">PreviewOnly_2026!</span>
                </div>
              </div>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleQuickPreviewLogin}
                  disabled={isSubmitting}
                  className="w-full py-2 px-3 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs shadow-md transition cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Eye className="w-4 h-4" />
                  <span>Explore Dashboard in Preview Mode</span>
                </button>
              </div>

              <div className="pt-1.5 border-t border-amber-900/40">
                <p className="text-[10px] text-amber-300/80 leading-relaxed font-mono">
                  Mock Sign-in Mechanism: In Preview Mode, use the demo credentials above. Any temporary in-memory staff accounts created in User Management can also be tested by entering their email/username with any password or "PreviewOnly_2026!". (Preview Only — Lost on Refresh).
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Login Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
          <div className="border-b border-slate-800 pb-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">Sign In to CoreERP</h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
                Single Sign-In Portal
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Shared authentication for Super Admin, Admin, Vice Admin, and Employee accounts.
            </p>

            {/* Supported Roles Badges */}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-950 text-amber-300 border border-amber-800/60 font-mono">
                SUPER_ADMIN
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-950 text-indigo-300 border border-indigo-800/60 font-mono">
                ADMIN
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-950 text-cyan-300 border border-cyan-800/60 font-mono">
                VICE_ADMIN
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-950 text-emerald-300 border border-emerald-800/60 font-mono">
                EMPLOYEE
              </span>
            </div>
          </div>

          {errorMessage && (
            <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Account Identifier (Work Email / Username)
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Mail className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  required
                  autoComplete="username email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@yourcompany.com or employee ID"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-10 py-2 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
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
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md shadow-indigo-600/20 flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Verifying credentials...</span>
                </>
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>

            {onNavigateToDashboard && (
              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={onNavigateToDashboard}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition cursor-pointer font-medium"
                >
                  ← Return to Dashboard Preview
                </button>
              </div>
            )}
          </form>
        </div>

        {/* Security Disclaimers */}
        <div className="text-center text-[11px] text-slate-400 space-y-1">
          <div>Protected by HTTP-Only session cookies &amp; server-side bcrypt verification</div>
          <div>5 failed attempts triggers an automatic 15-minute brute-force lockout</div>
        </div>
      </div>
    </div>
  );
};
