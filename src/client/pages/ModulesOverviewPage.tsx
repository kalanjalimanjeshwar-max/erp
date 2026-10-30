import React from 'react';
import {
  ShieldCheck,
  Calculator,
  Users,
  CalendarCheck,
  Fingerprint,
  CheckCircle2,
  Clock,
  Sparkles,
} from 'lucide-react';

export const ModulesOverviewPage: React.FC = () => {
  const modules = [
    {
      id: 'foundation',
      name: 'Core Tenant Foundation & Data Isolation',
      phase: 'Phase 2 (Completed)',
      status: 'IMPLEMENTED',
      icon: ShieldCheck,
      color: 'text-emerald-400 bg-emerald-950/60 border-emerald-800/60',
      description:
        'Multi-tenant data isolation, RBAC hierarchy (Super Admin, Admin, Vice Admin, Employee), CurrencyConfig exact decimals, FiscalPeriod calendar dates, CompanySetting, and tamper-evident AuditLog.',
      tables: ['Company', 'User', 'CurrencyConfig', 'FiscalPeriod', 'CompanySetting', 'SystemSetting', 'AuditLog'],
    },
    {
      id: 'accounting',
      name: 'Financial Accounting & General Ledger',
      phase: 'Phase 2',
      status: 'PLANNED',
      icon: Calculator,
      color: 'text-indigo-400 bg-indigo-950/60 border-indigo-800/60',
      description:
        'Double-entry chart of accounts, fiscal years, journal vouchers, and ledger postings with exact decimal math. Strictly deferred until Phase 2.',
      tables: ['Account', 'JournalEntry', 'FiscalYear', 'CostCenter'],
    },
    {
      id: 'attendance',
      name: 'Time, Attendance & Shift Scheduling',
      phase: 'Phase 7',
      status: 'ACTIVE',
      icon: CalendarCheck,
      color: 'text-cyan-400 bg-cyan-950/60 border-cyan-800/60',
      description:
        'Shift schedules, daily attendance calculation, overtime tracking, and leave management.',
      tables: ['Shift', 'Attendance', 'LeaveType', 'LeaveRequest'],
    },
    {
      id: 'payroll',
      name: 'Payroll & Salary Disbursement',
      phase: 'Phase 7',
      status: 'ACTIVE',
      icon: Users,
      color: 'text-violet-400 bg-violet-950/60 border-violet-800/60',
      description:
        'Salary revision proration, deduplicated loss-of-pay deductions, payslip calculation engine, and General Ledger posting.',
      tables: ['SalaryRevision', 'PayrollPeriod', 'Payslip', 'AccountLedger'],
    },
    {
      id: 'biometric',
      name: 'Biometric Hardware LAN Bridge & Terminal Management',
      phase: 'Phase 8',
      status: 'OPERATIONAL',
      icon: Fingerprint,
      color: 'text-violet-400 bg-violet-950/60 border-violet-800/60',
      description:
        'LAN bridge integration with physical ZKTeco F22 biometric terminals, raw punch ingestion, and automated punch-to-attendance reconciliation engine.',
      tables: ['BiometricTerminal', 'RawPunchLog'],
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-indigo-400" />
          Enterprise Module Registry & Architecture Roadmap
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Strict Phase 1 containment: Core schema and foundation established. Business logic deferred to designated phases.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {modules.map((mod) => {
          const Icon = mod.icon;
          const isDone = mod.status === 'IMPLEMENTED';

          return (
            <div
              key={mod.id}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4 hover:border-slate-700 transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-xl border ${mod.color}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-200">{mod.name}</h3>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-indigo-400 font-mono font-medium">
                        {mod.phase}
                      </span>
                    </div>
                  </div>
                </div>

                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold border ${
                    isDone
                      ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60'
                      : 'bg-slate-800 text-slate-400 border-slate-700/60'
                  }`}
                >
                  {isDone ? 'PHASE 1 COMPLETE' : 'SCHEDULED'}
                </span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">{mod.description}</p>

              <div className="pt-3 border-t border-slate-800/80">
                <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Database Schema Scope:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {mod.tables.map((tbl) => (
                    <span
                      key={tbl}
                      className={`text-[11px] px-2 py-0.5 rounded font-mono ${
                        isDone
                          ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/40'
                          : 'bg-slate-950 text-slate-400 border border-slate-800'
                      }`}
                    >
                      {tbl}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
