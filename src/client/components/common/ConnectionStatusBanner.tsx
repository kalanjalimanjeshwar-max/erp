import React from 'react';
import { Database, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { DatabaseReadiness } from '../../../shared/types.ts';

interface ConnectionBannerProps {
  readiness: DatabaseReadiness | null;
  isLoading: boolean;
  onRefresh: () => void;
}

export const ConnectionStatusBanner: React.FC<ConnectionBannerProps> = ({
  readiness,
  isLoading,
  onRefresh,
}) => {
  if (isLoading) {
    return null;
  }

  const isConnected = readiness?.status === 'connected';

  if (isConnected) {
    return (
      <div className="bg-emerald-950/40 border border-emerald-800/50 rounded-xl p-3.5 flex items-center justify-between text-xs text-emerald-300">
        <div className="flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>
            <strong>PostgreSQL Connected</strong>: Sole operational database active (
            {readiness.latencyMs}ms latency).
          </span>
        </div>
        <button
          onClick={onRefresh}
          className="hover:text-emerald-200 flex items-center gap-1 font-medium cursor-pointer"
          title="Refresh database probe"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Re-check
        </button>
      </div>
    );
  }

  return (
    <div className="bg-amber-950/60 border border-amber-800/60 rounded-xl p-4 text-amber-200">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-amber-900/60 rounded-lg text-amber-300 shrink-0 mt-0.5">
            <AlertCircle className="w-5 h-5" />
          </div>
          <div>
            <h4 className="font-semibold text-sm text-amber-100 flex items-center gap-2">
              <Database className="w-4 h-4" />
              PostgreSQL Service Offline or Unreachable
            </h4>
            <p className="text-xs text-amber-300/90 mt-1 leading-relaxed">
              {readiness?.error || 'Unable to establish connection to PostgreSQL.'}
            </p>
            <div className="mt-2 text-xs bg-slate-950/80 p-2.5 rounded-lg border border-slate-800 font-mono text-slate-300">
              <p className="text-slate-400 mb-1"># Action: Start PostgreSQL via Docker Compose or verify DATABASE_URL:</p>
              <code>docker compose up -d postgres</code>
            </div>
          </div>
        </div>

        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="px-3 py-1.5 bg-amber-800/60 hover:bg-amber-800 text-amber-100 rounded-lg text-xs font-medium flex items-center gap-1.5 transition shrink-0 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Retry Connection
        </button>
      </div>
    </div>
  );
};
