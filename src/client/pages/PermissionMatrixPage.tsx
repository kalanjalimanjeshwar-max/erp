import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Check,
  X,
  AlertCircle,
  RefreshCw,
  Info,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { Role, AppModule, AppAction, AuthUser } from '../../shared/types.ts';

interface PermissionMatrixPageProps {
  currentUser: AuthUser;
}

const ROLES: Role[] = ['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE'];

const MODULES: { id: AppModule; label: string; desc: string }[] = [
  { id: 'COMPANY', label: 'Company Settings', desc: 'Corporate profile, branding, contacts' },
  { id: 'USER', label: 'User Directory', desc: 'Staff creation, role assignment, status' },
  { id: 'ROLE_PERMISSION', label: 'Permission Matrix', desc: 'RBAC module and action configuration' },
  { id: 'AUDIT_LOG', label: 'Audit Trail', desc: 'Tamper-evident system activity logs' },
  { id: 'FISCAL_PERIOD', label: 'Fiscal Periods', desc: 'Financial period locks and dates' },
  { id: 'CURRENCY', label: 'Currency Config', desc: 'Multi-currency rates and decimal precision' },
  { id: 'ACCOUNTING', label: 'Accounting', desc: 'General ledger, charts of accounts, and vouchers' },
  { id: 'QUOTATION', label: 'Quotations', desc: 'Sales quotes and customer estimates' },
  { id: 'CUSTOMER', label: 'Customer Directory', desc: 'Customer accounts, tax details, and contacts' },
  { id: 'INVOICE', label: 'Sales Invoices', desc: 'Customer billing, invoicing, and revenue posting' },
  { id: 'RECEIPT', label: 'Customer Receipts', desc: 'Payment receipt allocation and settlement' },
  { id: 'EMPLOYEE', label: 'Employee Master', desc: 'Staff records, salary revisions, and user linking' },
  { id: 'DEPARTMENT', label: 'Departments', desc: 'Organizational departments and hierarchy' },
  { id: 'DESIGNATION', label: 'Designations', desc: 'Job titles, ranks, and operational levels' },
  { id: 'PAYROLL', label: 'Payroll', desc: 'Salary batches, calculation, and payslips' },
  { id: 'ATTENDANCE', label: 'Attendance', desc: 'Shifts, daily logs, and leave requests' },
  { id: 'BIOMETRIC', label: 'Biometrics', desc: 'Hardware terminal LAN bridge and sync' },
  { id: 'EXPENSE', label: 'Expense Claims', desc: 'Employee claims, multi-level approvals, and reimbursements' },
];

const ACTIONS: AppAction[] = ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'];

export const PermissionMatrixPage: React.FC<PermissionMatrixPageProps> = ({ currentUser }) => {
  const [matrix, setMatrix] = useState<Record<Role, Record<AppModule, Record<AppAction, boolean>>> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role>('ADMIN');

  const fetchMatrix = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const data = await api.getPermissionMatrix();
      setMatrix(data);
    } catch (err: unknown) {
      if (currentUser.isPreview) {
        // Construct default preview matrix so administrators can explore RBAC ceilings
        const previewMatrix: any = {};
        for (const r of ROLES) {
          previewMatrix[r] = {};
          for (const m of MODULES) {
            previewMatrix[r][m.id] = {};
            for (const a of ACTIONS) {
              previewMatrix[r][m.id][a] = r === 'SUPER_ADMIN' || (r === 'ADMIN' && a !== 'DELETE');
            }
          }
        }
        setMatrix(previewMatrix);
      } else if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to query permission matrix.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMatrix();
  }, []);

  const handleToggle = async (module: AppModule, action: AppAction, currentValue: boolean) => {
    if (currentUser.isPreview) {
      setErrorMessage('Action Disabled in Preview Mode: Role permissions cannot be modified while PostgreSQL is offline.');
      return;
    }

    // Only SUPER_ADMIN can configure custom overrides, or ADMIN for non-super roles
    if (currentUser.role !== 'SUPER_ADMIN' && currentUser.role !== 'ADMIN') {
      setErrorMessage('Only authorized administrators can modify permissions.');
      return;
    }

    if (selectedRole === 'SUPER_ADMIN') {
      setErrorMessage('Super Admin permissions are fixed by system policy.');
      return;
    }

    try {
      await api.setPermissionOverride({
        role: selectedRole,
        module,
        action,
        isGranted: !currentValue,
      });

      // Optimistic local update
      if (matrix) {
        setMatrix({
          ...matrix,
          [selectedRole]: {
            ...matrix[selectedRole],
            [module]: {
              ...matrix[selectedRole][module],
              [action]: !currentValue,
            },
          },
        });
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to update permission override.');
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-indigo-400" />
            Role Permission Matrix &amp; Access Controls
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Explicit module and action-level authorization rules strictly enforced on every API request
          </p>
        </div>

        <button
          onClick={fetchMatrix}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition cursor-pointer self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Reload Matrix</span>
        </button>
      </div>

      {errorMessage && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Role Selector Tabs */}
      <div className="flex gap-2 border-b border-slate-800 pb-3">
        {ROLES.map((r) => {
          const isSelected = selectedRole === r;
          return (
            <button
              key={r}
              onClick={() => setSelectedRole(r)}
              className={`px-4 py-2 rounded-xl text-xs font-semibold font-mono transition cursor-pointer flex items-center gap-2 ${
                isSelected
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                  : 'bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800'
              }`}
            >
              <span>{r}</span>
              {r === 'SUPER_ADMIN' && (
                <span className="text-[9px] px-1.5 py-0.2 rounded bg-indigo-950 text-indigo-200">
                  Root
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Matrix Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                <th className="px-5 py-3">Module</th>
                {ACTIONS.map((a) => (
                  <th key={a} className="px-3 py-3 text-center">
                    {a}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {MODULES.map((m) => {
                const isSuperAdminTab = selectedRole === 'SUPER_ADMIN';
                const canEditOverride =
                  (currentUser.role === 'SUPER_ADMIN' || currentUser.role === 'ADMIN') &&
                  !isSuperAdminTab;

                return (
                  <tr key={m.id} className="hover:bg-slate-800/30 transition">
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-slate-100">{m.label}</div>
                      <div className="text-[11px] text-slate-400">{m.desc}</div>
                    </td>

                    {ACTIONS.map((a) => {
                      const isGranted = matrix?.[selectedRole]?.[m.id]?.[a] ?? false;

                      return (
                        <td key={a} className="px-3 py-3.5 text-center">
                          <button
                            disabled={!canEditOverride}
                            onClick={() => handleToggle(m.id, a, isGranted)}
                            title={
                              canEditOverride
                                ? `Click to ${isGranted ? 'revoke' : 'grant'} ${a} on ${m.id} for ${selectedRole}`
                                : 'Permission is fixed or immutable'
                            }
                            className={`inline-flex items-center justify-center w-7 h-7 rounded-lg border transition ${
                              canEditOverride ? 'cursor-pointer hover:scale-105' : 'cursor-default'
                            } ${
                              isGranted
                                ? 'bg-emerald-950/50 border-emerald-800/50 text-emerald-400'
                                : 'bg-slate-950/50 border-slate-800 text-slate-400'
                            }`}
                          >
                            {isGranted ? <Check className="w-4 h-4" /> : <X className="w-3.5 h-3.5" />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-start gap-3 text-xs text-slate-400">
        <Info className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <strong className="text-slate-200">Server-Side Authorization Guarantee:</strong>
          <p>
            All permissions above are enforced directly by the backend middleware (<code>requirePermission</code>).
            Hiding buttons in the frontend is purely ergonomic; unpermitted direct API calls will fail with HTTP 403 Forbidden.
          </p>
        </div>
      </div>
    </div>
  );
};
