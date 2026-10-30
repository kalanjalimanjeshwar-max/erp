import React, { useState, useEffect } from 'react';
import {
  ShieldAlert,
  AlertCircle,
  RefreshCw,
  Search,
  Clock,
  Terminal,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { AuditLogData } from '../../shared/types.ts';

export const AuditLogPage: React.FC = () => {
  const [logs, setLogs] = useState<AuditLogData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState('');

  const fetchLogs = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const data = await api.getAuditLogs({
        entity: entityFilter.trim() || undefined,
        limit: 100,
      });
      setLogs(data);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load audit trail.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [entityFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-indigo-400" />
            Security &amp; Administrative Audit Trail
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Tamper-evident system activity logs scoped to your tenant. All secrets are cryptographically redacted.
          </p>
        </div>

        <button
          onClick={fetchLogs}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition cursor-pointer self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh Audit Logs</span>
        </button>
      </div>

      {errorMessage && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Filter */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
            placeholder="Filter by entity (e.g. User, Company, RolePermission)..."
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                <th className="px-5 py-3">Timestamp (UTC)</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Entity &amp; Target ID</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Correlation ID</th>
                <th className="px-4 py-3">Severity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300 font-mono text-[11px]">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-slate-400 font-sans">
                    {isLoading ? 'Loading audit events...' : 'No audit records found.'}
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/40 transition">
                    <td className="px-5 py-3 text-slate-400 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-slate-400" />
                        <span>{new Date(log.createdAt).toISOString().replace('T', ' ').substring(0, 19)}</span>
                      </div>
                    </td>

                    <td className="px-4 py-3 font-semibold text-slate-100">
                      {log.action}
                    </td>

                    <td className="px-4 py-3 text-slate-300">
                      <span className="text-indigo-400 font-medium">{log.entity}</span>
                      {log.entityId && (
                        <span className="text-slate-400 text-[10px] block truncate max-w-[120px]">
                          {log.entityId}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3 font-sans text-xs">
                      {log.user ? (
                        <div>
                          <div className="text-slate-200 font-medium">{log.user.fullName}</div>
                          <div className="text-slate-400 text-[10px]">{log.user.email}</div>
                        </div>
                      ) : (
                        <span className="text-slate-400 italic font-mono text-[10px]">System / Anonymous</span>
                      )}
                    </td>

                    <td className="px-4 py-3 text-slate-400 text-[10px] truncate max-w-[140px]">
                      {log.correlationId || 'N/A'}
                    </td>

                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                          log.severity === 'CRITICAL'
                            ? 'bg-red-950/80 text-red-300 border border-red-800/50'
                            : log.severity === 'WARN'
                            ? 'bg-amber-950/80 text-amber-300 border border-amber-800/50'
                            : 'bg-slate-800 text-slate-300 border border-slate-700'
                        }`}
                      >
                        {log.severity}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
