import React, { useState } from 'react';
import {
  Database,
  AlertTriangle,
  Server,
  RefreshCw,
  Terminal,
  ArrowRight,
  LogIn,
  Settings,
  ChevronDown,
  ChevronUp,
  Cloud,
  Laptop,
  CheckCircle2,
  ShieldCheck,
  ExternalLink,
} from 'lucide-react';
import { DatabaseReadiness } from '../../shared/types.ts';

interface DatabaseUnavailablePageProps {
  readiness: DatabaseReadiness | null;
  isRetrying: boolean;
  onRetry: () => void;
  onNavigateToLogin: () => void;
  onNavigateToSetup: () => void;
}

export const DatabaseUnavailablePage: React.FC<DatabaseUnavailablePageProps> = ({
  readiness,
  isRetrying,
  onRetry,
  onNavigateToLogin,
  onNavigateToSetup,
}) => {
  const [activeTab, setActiveTab] = useState<'ai_studio' | 'local_docker' | 'production'>('ai_studio');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const errorMessage =
    readiness?.error ||
    'Cannot establish a connection to PostgreSQL. No operational database was detected.';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-6 selection:bg-indigo-500 selection:text-white">
      <div className="max-w-3xl w-full space-y-6">
        {/* Brand & Status Header */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-amber-600 to-red-600 flex items-center justify-center font-bold text-white shadow-xl shadow-amber-900/30 mx-auto">
            <Database className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">
            Database Service Unavailable
          </h1>
          <p className="text-xs text-slate-400 max-w-lg mx-auto">
            PostgreSQL is the mandatory sole operational database engine for CoreERP. The web and API server is operational, but cannot reach a persistent PostgreSQL instance.
          </p>
        </div>

        {/* Diagnostic Status Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-semibold uppercase tracking-wider text-red-400">
                PostgreSQL Offline / Unreachable
              </span>
            </div>
            <span className="text-[11px] font-mono text-slate-400">
              Database: PostgreSQL 16+ • Versioned Prisma Migrations
            </span>
          </div>

          {/* Connection Diagnostic Message */}
          <div className="bg-red-950/40 border border-red-800/60 rounded-xl p-4 text-xs text-red-200 space-y-1.5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <strong className="font-semibold text-red-100">Active Connection Failure Diagnostic:</strong>
                <p className="font-mono text-[11px] text-red-300 break-words leading-relaxed">{errorMessage}</p>
              </div>
            </div>
          </div>

          {/* Environment Configuration Tabs */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Terminal className="w-4 h-4 text-indigo-400" />
                <span>Environment Deployment &amp; Database Setup Guides</span>
              </div>
              <span className="text-[10px] text-slate-400">Select your target:</span>
            </div>

            {/* Tab Buttons */}
            <div className="grid grid-cols-3 gap-2 p-1 bg-slate-950 rounded-xl border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab('ai_studio')}
                className={`px-3 py-2 rounded-lg font-medium transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  activeTab === 'ai_studio'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Cloud className="w-3.5 h-3.5" />
                <span>AI Studio Preview</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('local_docker')}
                className={`px-3 py-2 rounded-lg font-medium transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  activeTab === 'local_docker'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Laptop className="w-3.5 h-3.5" />
                <span>Local Docker (Dev)</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('production')}
                className={`px-3 py-2 rounded-lg font-medium transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  activeTab === 'production'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Server className="w-3.5 h-3.5" />
                <span>Production Server</span>
              </button>
            </div>

            {/* Tab 1: AI Studio Preview (External PostgreSQL) */}
            {activeTab === 'ai_studio' && (
              <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3 text-xs">
                <div className="flex items-start gap-2 text-indigo-300">
                  <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-indigo-400" />
                  <div>
                    <strong className="text-slate-200">Google AI Studio Sandbox Architecture:</strong>
                    <p className="text-slate-400 mt-0.5 leading-relaxed">
                      The AI Studio preview container runs Node.js/Express, but does not provide a local PostgreSQL daemon or Docker engine. To use real persistent storage in AI Studio, connect to an externally hosted PostgreSQL instance.
                    </p>
                  </div>
                </div>

                <div className="space-y-2 pt-1">
                  <div className="text-slate-300 font-semibold text-[11px] flex items-center gap-1.5">
                    <span>1. Supported External Providers:</span>
                  </div>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    Google Cloud SQL (PostgreSQL), Neon Serverless, Supabase, AWS RDS, Render, or any self-hosted PostgreSQL 15+ database accessible over the internet with SSL.
                  </p>

                  <div className="text-slate-300 font-semibold text-[11px] pt-1">
                    <span>2. Configure Environment Variable in <code className="text-indigo-300">.env</code>:</span>
                  </div>
                  <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 font-mono text-[11px] text-indigo-300 select-all overflow-x-auto">
                    DATABASE_URL="postgresql://USERNAME:PASSWORD@HOST:5432/DATABASE?sslmode=require"
                  </div>

                  <div className="text-slate-300 font-semibold text-[11px] pt-1">
                    <span>3. Verify &amp; Apply Migrations:</span>
                  </div>
                  <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 font-mono text-[11px] text-emerald-400 select-all">
                    npm run db:migrate
                  </div>
                  <p className="text-[10px] text-slate-400">
                    Once configured, click <strong>"Retry Database Connection"</strong> below. CoreERP will connect, verify schema, and unlock the Setup Wizard and Dashboard.
                  </p>
                </div>
              </div>
            )}

            {/* Tab 2: Local Windows/Linux Development */}
            {activeTab === 'local_docker' && (
              <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3 text-xs">
                <div className="flex items-start gap-2 text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                  <div>
                    <strong className="text-slate-200">Local Workstation with Docker Desktop:</strong>
                    <p className="text-slate-400 mt-0.5 leading-relaxed">
                      On your local machine (Windows, macOS, or Linux), use the pre-configured development Docker Compose configuration:
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>Verified Development Service Name: <strong className="text-indigo-300 font-mono">postgres</strong></span>
                    <span className="font-mono text-slate-500">Container: coreerp-postgres-dev</span>
                  </div>
                  <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 font-mono text-xs text-emerald-400 select-all">
                    docker compose -f docker-compose.dev.yml up -d postgres
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                    <span>Apply Migrations:</span>
                  </div>
                  <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 font-mono text-xs text-indigo-300 select-all">
                    npm run db:migrate
                  </div>

                  <div className="p-2.5 bg-slate-900 rounded-lg border border-slate-800/80 text-[11px] text-slate-400 font-mono">
                    Target: localhost:5432 • DB: core_erp • User: erp_user
                  </div>
                </div>
              </div>
            )}

            {/* Tab 3: Production Deployment */}
            {activeTab === 'production' && (
              <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3 text-xs">
                <div className="space-y-2">
                  <strong className="text-slate-200">Production Multi-Container Deployment:</strong>
                  <p className="text-slate-400 leading-relaxed">
                    Production orchestrates the application server together with a secured PostgreSQL container with persistent storage volume:
                  </p>

                  <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 font-mono text-xs text-emerald-400 select-all">
                    docker compose up -d postgres
                  </div>

                  <div className="text-slate-400 text-[11px] pt-1">
                    Apply migrations in production container:
                  </div>
                  <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 font-mono text-xs text-indigo-300 select-all">
                    npm run db:migrate:prod
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="pt-2 flex flex-col sm:flex-row items-center gap-3">
            <button
              type="button"
              onClick={onRetry}
              disabled={isRetrying}
              className="w-full sm:w-auto px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md shadow-indigo-600/20 flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
              <span>{isRetrying ? 'Probing PostgreSQL...' : 'Retry Database Connection'}</span>
            </button>

            <button
              type="button"
              onClick={onNavigateToLogin}
              className="w-full sm:w-auto px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-medium flex items-center justify-center gap-2 transition cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5 text-indigo-400" />
              <span>Go to Sign In Screen</span>
            </button>

            <button
              type="button"
              onClick={onNavigateToSetup}
              className="w-full sm:w-auto px-4 py-2.5 bg-slate-800/60 hover:bg-slate-700 text-slate-300 border border-slate-800 rounded-xl text-xs font-medium flex items-center justify-center gap-2 transition cursor-pointer"
            >
              <Settings className="w-3.5 h-3.5 text-slate-400" />
              <span>View Setup Wizard</span>
            </button>
          </div>

          {/* Collapsible Technical Diagnostics */}
          <div className="pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition cursor-pointer"
            >
              {showDiagnostics ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              <span>{showDiagnostics ? 'Hide Raw Diagnostic JSON' : 'Show Raw Diagnostic JSON (/api/ready)'}</span>
            </button>

            {showDiagnostics && (
              <pre className="mt-2.5 p-3 bg-slate-950 rounded-xl border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto">
                {JSON.stringify(readiness || { error: 'No response from health probe' }, null, 2)}
              </pre>
            )}
          </div>
        </div>

        {/* Footer info */}
        <div className="text-center text-[11px] text-slate-400 space-y-1">
          <div>CoreERP Architectural Constitution • State 1: Database Unavailable</div>
          <div>Strict PostgreSQL Exclusivity • No SQLite or in-memory data downgrades</div>
        </div>
      </div>
    </div>
  );
};
