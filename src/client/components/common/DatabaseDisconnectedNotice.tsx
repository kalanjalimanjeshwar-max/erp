import React from 'react';
import {
  Database,
  Lock,
  ArrowLeft,
  Activity,
  LogIn,
  AlertTriangle,
  Server,
  Layers,
  CheckCircle2,
} from 'lucide-react';
import { DatabaseReadiness } from '../../../shared/types.ts';

interface DatabaseDisconnectedNoticeProps {
  moduleName: string;
  phaseTag: string;
  readiness?: DatabaseReadiness | null;
  isAuthenticated: boolean;
  onBackToDashboard: () => void;
  onNavigateToDiagnostics: () => void;
  onNavigateToLogin: () => void;
  onNavigateToSetup?: () => void;
}

export const DatabaseDisconnectedNotice: React.FC<DatabaseDisconnectedNoticeProps> = ({
  moduleName,
  phaseTag,
  readiness,
  isAuthenticated,
  onBackToDashboard,
  onNavigateToDiagnostics,
  onNavigateToLogin,
}) => {
  const isConnected = readiness?.status === 'connected';
  const isAuthRequiredOnly = isConnected && !isAuthenticated;

  return (
    <div className="max-w-3xl mx-auto my-8 space-y-6">
      {/* Module Title & Status Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                isAuthRequiredOnly
                  ? 'bg-indigo-950/80 border-indigo-800/80 text-indigo-400'
                  : 'bg-amber-950/80 border-amber-800/80 text-amber-400'
              }`}
            >
              {isAuthRequiredOnly ? <Lock className="w-5 h-5" /> : <Database className="w-5 h-5" />}
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <span>{moduleName}</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {isAuthRequiredOnly
                  ? 'Protected ERP Module • Active Sign-In Session Required'
                  : 'PostgreSQL Sole Persistent Operational Store • Strict Architectural Guard'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] px-2.5 py-1 rounded font-mono font-medium bg-indigo-950/80 text-indigo-300 border border-indigo-800">
              {phaseTag}
            </span>
            {isConnected ? (
              <span className="text-[10px] px-2.5 py-1 rounded font-mono font-medium bg-emerald-950/80 text-emerald-300 border border-emerald-800">
                DB: ONLINE
              </span>
            ) : (
              <span className="text-[10px] px-2.5 py-1 rounded font-mono font-medium bg-amber-950/80 text-amber-300 border border-amber-800">
                DB: OFFLINE
              </span>
            )}
          </div>
        </div>

        {/* Informative Explanation */}
        {isAuthRequiredOnly ? (
          <div className="bg-indigo-950/40 border border-indigo-800/50 rounded-xl p-4 text-xs text-indigo-200 space-y-2">
            <div className="flex items-start gap-2.5">
              <Lock className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <strong className="text-indigo-100 font-semibold">
                  Authentication Required
                </strong>
                <p className="text-indigo-200/90 leading-relaxed">
                  PostgreSQL is connected and ready. Sign in with an authorized CoreERP account to view
                  and manage live company-scoped data in {moduleName}.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-amber-950/40 border border-amber-800/50 rounded-xl p-4 text-xs text-amber-200 space-y-2">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <strong className="text-amber-100 font-semibold">
                  Live Data Operations Disabled in Disconnected Mode
                </strong>
                <p className="text-amber-200/90 leading-relaxed">
                  This operational ERP module executes strict double-entry ledger postings, foreign key validations,
                  and company-scoped transactional queries against PostgreSQL. To prevent phantom states, data corruption,
                  or simulated fallbacks, live queries and data-modifying operations are blocked until a persistent
                  PostgreSQL database is connected.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Current State Diagnostic Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div className="p-4 bg-slate-950/70 border border-slate-800/80 rounded-xl space-y-2">
            <div className="font-semibold text-slate-200 flex items-center gap-2">
              {isConnected ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              ) : (
                <Server className="w-4 h-4 text-cyan-400" />
              )}
              {isConnected ? 'PostgreSQL Connected' : 'Database Connectivity'}
            </div>
            <p className="text-slate-400 leading-relaxed text-[11px]">
              {isConnected ? (
                'PostgreSQL is online and responding normally. Operational records will load as soon as you sign in.'
              ) : (
                <>
                  PostgreSQL is currently unreachable. Verify your PostgreSQL service is running and check{' '}
                  <code className="text-slate-300">DATABASE_URL</code> in <code className="text-slate-300">.env</code> to
                  activate live persistence.
                </>
              )}
            </p>
          </div>

          <div className="p-4 bg-slate-950/70 border border-slate-800/80 rounded-xl space-y-2">
            <div className="font-semibold text-slate-200 flex items-center gap-2">
              <Lock className="w-4 h-4 text-indigo-400" />
              Authentication &amp; RBAC
            </div>
            <p className="text-slate-400 leading-relaxed text-[11px]">
              {isAuthenticated
                ? 'Session verified. Real business data will load automatically upon PostgreSQL reconnection.'
                : isConnected
                ? 'No active session detected. Sign in with your account credentials to load your tenant workspace.'
                : 'Unauthenticated preview mode. Normal authentication and role ceilings are preserved.'}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800">
          <button
            onClick={onBackToDashboard}
            className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition cursor-pointer border border-slate-700"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Return to Dashboard</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onNavigateToDiagnostics}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-800/80 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-medium transition cursor-pointer border border-slate-700"
            >
              <Activity className="w-3.5 h-3.5 text-cyan-400" />
              <span>Diagnostics</span>
            </button>

            {!isAuthenticated && (
              <button
                onClick={onNavigateToLogin}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition shadow-md cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Go to Sign In</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
