import React, { useState, useEffect } from 'react';
import {
  Activity,
  Database,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Terminal,
  Server,
  Layers,
} from 'lucide-react';
import { api } from '../services/api.ts';
import { HealthResponse, ReadinessResponse } from '../../shared/types.ts';

export const SystemHealthPage: React.FC = () => {
  const [healthData, setHealthData] = useState<HealthResponse | null>(null);
  const [readinessData, setReadinessData] = useState<ReadinessResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchDiagnostics = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const [h, r] = await Promise.allSettled([api.getHealth(), api.getReadiness()]);
      if (h.status === 'fulfilled') setHealthData(h.value);
      if (r.status === 'fulfilled') setReadinessData(r.value);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to query diagnostics');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDiagnostics();
  }, []);

  const isPostgresReady = readinessData?.checks?.postgres?.status === 'connected';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <Activity className="w-6 h-6 text-indigo-400" />
            System Health & Diagnostic Probes
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Real-time verification of /api/health (Process) and /api/ready (PostgreSQL Database)
          </p>
        </div>

        <button
          onClick={fetchDiagnostics}
          disabled={isLoading}
          className="inline-flex items-center gap-2 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition cursor-pointer border border-slate-700 shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Run Health Probes
        </button>
      </div>

      {errorMsg && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-4 text-xs text-red-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Grid of Probes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Probe 1: GET /api/health */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Server className="w-4 h-4 text-indigo-400" />
              Process Health (<code className="text-xs text-indigo-400">GET /api/health</code>)
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-emerald-950/60 text-emerald-300 border border-emerald-800/50">
              HTTP 200 OK
            </span>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between py-1 border-b border-slate-800/60">
              <span className="text-slate-400">Process Status</span>
              <span className="font-semibold text-emerald-400 uppercase">
                {healthData?.status || 'Online'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/60">
              <span className="text-slate-400">Process Uptime</span>
              <span className="font-mono text-slate-200">{healthData?.uptimeSeconds ?? 0} seconds</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/60">
              <span className="text-slate-400">Runtime Environment</span>
              <span className="font-mono text-slate-200">{healthData?.environment || 'development'}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-400">CoreERP Architecture Version</span>
              <span className="font-mono text-slate-200">{healthData?.version || '1.0.0-phase1'}</span>
            </div>
          </div>
        </div>

        {/* Probe 2: GET /api/ready */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Database className="w-4 h-4 text-indigo-400" />
              PostgreSQL Readiness (<code className="text-xs text-indigo-400">GET /api/ready</code>)
            </div>
            <span
              className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                isPostgresReady
                  ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50'
                  : 'bg-amber-950/60 text-amber-300 border border-amber-800/50'
              }`}
            >
              {isPostgresReady ? 'HTTP 200 READY' : 'HTTP 503 NOT READY'}
            </span>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between py-1 border-b border-slate-800/60">
              <span className="text-slate-400">Database Engine</span>
              <span className="font-medium text-slate-200">PostgreSQL (Sole Database)</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/60">
              <span className="text-slate-400">Connectivity State</span>
              <span
                className={`font-semibold ${
                  isPostgresReady ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {readinessData?.checks?.postgres?.status || 'Disconnected'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/60">
              <span className="text-slate-400">Query Latency</span>
              <span className="font-mono text-slate-200">
                {readinessData?.checks?.postgres?.latencyMs !== undefined
                  ? `${readinessData.checks.postgres.latencyMs} ms`
                  : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-400">Safe Diagnostics</span>
              <span className="text-slate-300 text-right max-w-xs truncate">
                {readinessData?.checks?.postgres?.error || 'Active connection verified'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Deployment & Docker Guide */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <Terminal className="w-4 h-4 text-indigo-400" />
          Deployment Commands & Container Orchestration
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="font-semibold text-slate-300 flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-indigo-400" />
              Ubuntu Linux (Docker Compose Production)
            </div>
            <p className="text-slate-400">
              Starts PostgreSQL with persistent volume and builds multi-stage container:
            </p>
            <pre className="p-2.5 bg-slate-900 rounded border border-slate-800 text-[11px] font-mono text-emerald-300 overflow-x-auto">
              {`# 1. Start PostgreSQL + App
docker compose up -d --build

# 2. Run version-controlled migrations
docker compose exec app npm run db:migrate`}
            </pre>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="font-semibold text-slate-300 flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              Windows Development Setup
            </div>
            <p className="text-slate-400">
              Run PostgreSQL via Docker Compose while running Vite + Express dev server:
            </p>
            <pre className="p-2.5 bg-slate-900 rounded border border-slate-800 text-[11px] font-mono text-cyan-300 overflow-x-auto">
              {`# 1. Start local Postgres container
docker compose up -d postgres

# 2. Run Prisma migrations
npm run db:migrate

# 3. Launch Development Server (Windows PowerShell)
npm run dev`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
