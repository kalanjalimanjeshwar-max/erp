import React from 'react';
import {
  ShieldAlert,
  Server,
  Layers,
  Database,
  Building2,
  Lock,
  ArrowRight,
  Clock,
  Coins,
  Cpu,
  Users,
  FileCheck,
  FileText,
  DollarSign,
  Briefcase,
  Building,
  UserPlus,
  CalendarCheck,
} from 'lucide-react';
import { SetupStatusResponse, DatabaseReadiness, AuthUser } from '../../shared/types.ts';

interface DashboardPageProps {
  setupStatus: SetupStatusResponse | null;
  readiness: DatabaseReadiness | null;
  currentUser: AuthUser | null;
  onNavigate: (tab: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  setupStatus,
  readiness,
  currentUser,
  onNavigate,
}) => {
  const isDbConnected = readiness?.status === 'connected';
  const isSetupRequired = setupStatus?.isSetupRequired !== false;
  const isPreviewMode = !currentUser;
  const role = currentUser?.role;
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const isAdmin = role === 'ADMIN';
  const isViceAdmin = role === 'VICE_ADMIN';
  const isEmployee = role === 'EMPLOYEE';

  return (
    <div className="space-y-6">
      {/* Page Title & Role Badge */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <span>
              {isPreviewMode
                ? 'CoreERP Enterprise Management Dashboard'
                : isEmployee
                ? 'Employee Self-Service Portal'
                : isSuperAdmin
                ? 'Super Administrator Control Plane'
                : isAdmin
                ? 'Company Administration & Operations'
                : 'Vice Administrator Operations Dashboard'}
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {isPreviewMode
              ? 'Architectural Overview • Clean Room Architecture • PostgreSQL Sole Persistent Storage'
              : isEmployee
              ? `Welcome back, ${currentUser?.fullName || 'Employee'}. View your profile, compensation, and attendance.`
              : 'Enterprise Resource Planning • PostgreSQL Sole Persistent Storage'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isPreviewMode ? (
            <span className="text-xs px-3 py-1 rounded-full font-mono font-medium border bg-slate-900 text-slate-300 border-slate-700 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              Preview Mode (Exploration)
            </span>
          ) : (
            <span
              className={`text-xs px-3 py-1 rounded-full font-mono font-semibold border ${
                isSuperAdmin
                  ? 'bg-amber-950/80 text-amber-300 border-amber-700/80'
                  : isAdmin
                  ? 'bg-indigo-950/80 text-indigo-300 border-indigo-700/80'
                  : isViceAdmin
                  ? 'bg-cyan-950/80 text-cyan-300 border-cyan-700/80'
                  : 'bg-emerald-950/80 text-emerald-300 border-emerald-700/80'
              }`}
            >
              Role: {role}
            </span>
          )}
        </div>
      </div>

      {/* Database Disconnected Preview Banner */}
      {!isDbConnected && (
        <div className="bg-gradient-to-r from-amber-950/70 via-slate-900 to-slate-900 border border-amber-800/60 rounded-xl p-5 shadow-lg">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-3 bg-amber-900/40 text-amber-400 rounded-xl border border-amber-800/50 shrink-0">
                <Database className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-slate-100">
                    AI Studio Preview • Database Disconnected
                  </h3>
                  <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-amber-950 text-amber-300 border border-amber-800">
                    Safe Mode
                  </span>
                </div>
                <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
                  PostgreSQL at <code className="text-slate-200">localhost:5432</code> is offline in the sandbox container.
                  The application shell, navigation, and Phase 1–6 architectural blueprints are loaded without simulated fallbacks
                  or fake records. Real ledger postings, invoices, and employee records require an active PostgreSQL instance.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => onNavigate('health')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold transition border border-slate-700 cursor-pointer"
              >
                <Server className="w-3.5 h-3.5 text-cyan-400" />
                <span>Diagnostics</span>
              </button>
              <button
                onClick={() => onNavigate('login')}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-md transition cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Sign In</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Setup Required Callout (if connected and unconfigured) */}
      {isDbConnected && isSetupRequired && (
        <div className="bg-gradient-to-r from-indigo-950/80 via-slate-900 to-slate-900 border border-indigo-700/60 rounded-xl p-5 shadow-lg">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-3 bg-indigo-600/30 text-indigo-400 rounded-xl border border-indigo-500/30 shrink-0">
                <Building2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  Initial Setup Required: Bootstrap First Company &amp; Super Admin
                </h3>
                <p className="text-xs text-slate-300 mt-1 max-w-xl leading-relaxed">
                  PostgreSQL multi-tenant architecture is ready. To secure the system and establish
                  data isolation, initialize your primary enterprise entity and root administrator.
                </p>
              </div>
            </div>

            <button
              onClick={() => onNavigate('setup')}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-md transition cursor-pointer shrink-0"
            >
              <span>Launch Setup Wizard</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Primary Architectural Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Card 1: PostgreSQL Sole Database Engine */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400">Database Engine</span>
            <div className={`p-2 rounded-lg ${isDbConnected ? 'bg-emerald-950/60 text-emerald-400' : 'bg-amber-950/60 text-amber-400'}`}>
              <Database className="w-4 h-4" />
            </div>
          </div>
          <div className="text-lg font-bold text-slate-100 flex items-center gap-2">
            PostgreSQL
            <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-medium ${isDbConnected ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50' : 'bg-amber-950/60 text-amber-300 border border-amber-800/50'}`}>
              {isDbConnected ? 'Operational' : 'Unreachable'}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            Sole persistent store. No JSON-file fallbacks or silent downgrades. Versioned Prisma migrations enabled.
          </p>
          <div className="mt-4 pt-3 border-t border-slate-700/60 flex items-center justify-between text-[11px] text-slate-400">
            <span>Latency</span>
            <span className="font-mono text-slate-300">{readiness?.latencyMs !== undefined ? `${readiness.latencyMs} ms` : 'N/A'}</span>
          </div>
        </div>

        {/* Card 2: Company Isolation & Multi-Tenant Model */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400">Tenant Architecture</span>
            <div className="p-2 rounded-lg bg-indigo-950/60 text-indigo-400">
              <Building2 className="w-4 h-4" />
            </div>
          </div>
          <div className="text-lg font-bold text-slate-100 flex items-center gap-2">
            {setupStatus?.companyInfo?.code ? setupStatus.companyInfo.code : 'Pending Provision'}
            <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-indigo-950/60 text-indigo-300 border border-indigo-800/50">
              Company-Scoped
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            All records strictly scoped to <code className="text-indigo-300">companyId</code> with composite unique constraints and foreign keys.
          </p>
          <div className="mt-4 pt-3 border-t border-slate-700/60 flex items-center justify-between text-[11px] text-slate-400">
            <span>Root Admin Status</span>
            <span className="text-slate-300 font-medium">
              {setupStatus?.hasSuperAdmin ? 'Configured' : 'Awaiting Setup'}
            </span>
          </div>
        </div>

        {/* Card 3: Financial Precision & Timezone Integrity */}
        <div className="bg-slate-800/80 border border-slate-700/80 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400">Integrity Controls</span>
            <div className="p-2 rounded-lg bg-violet-950/60 text-violet-400">
              <Coins className="w-4 h-4" />
            </div>
          </div>
          <div className="text-lg font-bold text-slate-100 flex items-center gap-2">
            Exact Decimal
            <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-violet-950/60 text-violet-300 border border-violet-800/50">
              (18, 6)
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            Zero floating-point rounding errors on currency/rate fields. Explicit UTC Timestamptz(6) timezone tracking.
          </p>
          <div className="mt-4 pt-3 border-t border-slate-700/60 flex items-center justify-between text-[11px] text-slate-400">
            <span>Timezone Standard</span>
            <span className="font-mono text-slate-300">Explicit TIMESTAMPTZ</span>
          </div>
        </div>
      </div>

      {/* User Management & Account Provisioning (when SUPER_ADMIN or ADMIN) */}
      {(isSuperAdmin || isAdmin) && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-800 gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Users className="w-4 h-4 text-indigo-400" />
                User Management / Create User
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Staff account provisioning, role delegation, employee login linking, and credential lifecycle
              </p>
            </div>
            <button
              onClick={() => onNavigate('users-create')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow transition cursor-pointer self-start sm:self-auto shrink-0"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Create New User</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div
              onClick={() => onNavigate('users-create')}
              className="p-4 bg-slate-950/70 hover:bg-slate-800/60 border border-indigo-900/40 hover:border-indigo-600/60 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-indigo-400 transition flex items-center gap-1.5">
                  <UserPlus className="w-3.5 h-3.5 text-indigo-400" />
                  Create New User
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Add staff accounts with full name, work email/username, password verification, role ceiling enforcement, and employee link.
              </p>
            </div>

            <div
              onClick={() => onNavigate('users')}
              className="p-4 bg-slate-950/70 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-indigo-400 transition flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-indigo-400" />
                  User Directory
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                View all company accounts, search by name/identifier, toggle active/inactive status, and reset staff credentials.
              </p>
            </div>

            <div
              onClick={() => onNavigate('permissions')}
              className="p-4 bg-slate-950/70 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-indigo-400 transition flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-indigo-400" />
                  Role Permissions Matrix
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Inspect role privileges for Super Admin, Admin, Vice Admin, and Employee roles with immutable security ceilings.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Super Administration Control Suite (when role === 'SUPER_ADMIN') */}
      {isSuperAdmin && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <div>
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                Root Super Administration Capabilities
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Privileged multi-tenant governance, company configuration, user directory, and security audit
              </p>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-amber-950 text-amber-300 border border-amber-800">
              Root Authority
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div
              onClick={() => onNavigate('company')}
              className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-amber-400 transition flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-amber-400" />
                  Company Settings
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-amber-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Tenant profile, legal name, tax ID, base currency, timezones, and logo branding.
              </p>
            </div>

            <div
              onClick={() => onNavigate('users')}
              className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-amber-400 transition flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-amber-400" />
                  User Directory
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-amber-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Provision administrators, vice admins, and employees. Manage activation &amp; credentials.
              </p>
            </div>

            <div
              onClick={() => onNavigate('permissions')}
              className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-amber-400 transition flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-amber-400" />
                  Permission Matrix
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-amber-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Role-based access ceilings and company-specific module authorization rules.
              </p>
            </div>

            <div
              onClick={() => onNavigate('audit')}
              className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-amber-400 transition flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                  Audit Trail
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-amber-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Immutable, append-only security logs with correlation IDs and IP tracking.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Employee Self-Service Hub (when role === 'EMPLOYEE') */}
      {isEmployee && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <Users className="w-5 h-5 text-emerald-400" />
                Employee Self-Service Navigation
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Quick access to your personal employee record, compensation structure, and diagnostics
              </p>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-emerald-950 text-emerald-300 border border-emerald-800">
              Self-Service Mode
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div
              onClick={() => onNavigate('my-profile')}
              className="p-4 bg-slate-950/80 hover:bg-slate-800/80 border border-slate-800 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-emerald-400 transition flex items-center gap-1.5">
                  <Briefcase className="w-4 h-4 text-emerald-400" />
                  My Profile &amp; Salary
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                View your personal employee profile, fixed salary structure, effective dates, and contact details.
              </p>
            </div>

            <div
              onClick={() => onNavigate('health')}
              className="p-4 bg-slate-950/80 hover:bg-slate-800/80 border border-slate-800 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-indigo-400 transition flex items-center gap-1.5">
                  <Server className="w-4 h-4 text-indigo-400" />
                  System Diagnostics
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Check database readiness, system health status, and backend connectivity diagnostics.
              </p>
            </div>

            <div
              onClick={() => onNavigate('modules')}
              className="p-4 bg-slate-950/80 hover:bg-slate-800/80 border border-slate-800 rounded-xl transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-cyan-400 transition flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-cyan-400" />
                  Modules &amp; Permissions
                </span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-cyan-400 group-hover:translate-x-1 transition" />
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Review available ERP modules, architectural boundaries, and employee self-service scope.
              </p>
            </div>
          </div>

          <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-[11px] text-slate-400 flex items-start gap-2.5">
            <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <strong className="text-slate-300">Role-Based Access Control Notice:</strong>
              <p className="mt-0.5">
                You are authenticated with an Employee account. Administrative directories, fiscal journals, invoices, and accounting books are strictly protected and restricted to authorized administration roles.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Administrative Operational Launchers (Phases 4-6) - Restricted for Employee */}
      {!isEmployee && (
        <>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <FileText className="w-4 h-4 text-emerald-400" />
                Sales, Billing &amp; Receipts System
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Quotations, customer accounts receivable, billing documents, and payment receipts with atomic general ledger posting
              </p>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-emerald-950 text-emerald-300 border border-emerald-800">
              Phase 5 Operational
            </span>
          </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div
            onClick={() => onNavigate('customers')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-emerald-400 transition flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-emerald-400" />
                Customers
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Customer directory, payment terms, contact profiles, and accounts receivable sub-ledger linkage.
            </p>
          </div>

          <div
            onClick={() => onNavigate('quotations')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-emerald-400 transition flex items-center gap-1.5">
                <FileCheck className="w-3.5 h-3.5 text-emerald-400" />
                Quotations
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Accounting-neutral price estimates with validity tracking, print view, and 1-click invoice conversion.
            </p>
          </div>

          <div
            onClick={() => onNavigate('invoices')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-emerald-400 transition flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-emerald-400" />
                Invoices &amp; Billing
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              AR invoicing with exact decimal tax calculation, status workflow, and atomic double-entry posting.
            </p>
          </div>

          <div
            onClick={() => onNavigate('receipts')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-emerald-400 transition flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                Customer Receipts
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Record inward payments, multi-invoice balance allocation, and automatic cash-to-AR ledger posting.
            </p>
          </div>
        </div>
      </div>

      {/* Human Capital & Employee Management Launchers (Phase 6) */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-cyan-400" />
              Human Resources, Shifts, Attendance &amp; Payroll Suite
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Employee profiles, shift scheduling, daily attendance, leave approvals, and double-entry payroll disbursement
            </p>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-cyan-950 text-cyan-300 border border-cyan-800">
            Phase 7 Operational
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div
            onClick={() => onNavigate('employees')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-cyan-400 transition flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-cyan-400" />
                Employee Management
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-cyan-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Staff directory, fixed gross salary, effective date revisions, ledger links, and credential provisioning.
            </p>
          </div>

          <div
            onClick={() => onNavigate('attendance')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-cyan-400 transition flex items-center gap-1.5">
                <CalendarCheck className="w-3.5 h-3.5 text-cyan-400" />
                Time &amp; Attendance Logs
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-cyan-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Daily punches, check-in/out stamps, overtime tracking, late tolerance, and shift definitions.
            </p>
          </div>

          <div
            onClick={() => onNavigate('leave')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-cyan-400 transition flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-cyan-400" />
                Leave Management
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-cyan-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Staff leave applications, approval workflows, paid allowances, and loss-of-pay tracking.
            </p>
          </div>

          <div
            onClick={() => onNavigate('payroll')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-cyan-400 transition flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5 text-cyan-400" />
                Payroll &amp; Compensation
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-cyan-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Batch payslip calculation, unpaid absence deductions, self-service slips, and General Ledger posting.
            </p>
          </div>

          <div
            onClick={() => onNavigate('departments')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-cyan-400 transition flex items-center gap-1.5">
                <Building className="w-3.5 h-3.5 text-cyan-400" />
                Departments &amp; Designations
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-cyan-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Corporate organization hierarchy, operational branch routing, and designation career tracks.
            </p>
          </div>
        </div>
      </div>

      {/* Core Accounting Module Launchers (Phase 4) */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-400" />
              Core Accounting System
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Production double-entry general ledger, hierarchical accounts, vouchers, and statements
            </p>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-indigo-950 text-indigo-300 border border-indigo-800">
            Phase 4 Operational
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div
            onClick={() => onNavigate('coa')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-indigo-400 transition">
                Chart of Accounts
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              5 root classifications (Assets, Liabilities, Equity, Income, Expenses), nested groups, and opening balances.
            </p>
          </div>

          <div
            onClick={() => onNavigate('journals')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-indigo-400 transition">
                General Journal Vouchers
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Create balanced double-entry vouchers with draft, posted, and reversed status audit trails.
            </p>
          </div>

          <div
            onClick={() => onNavigate('reports')}
            className="p-4 bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800 rounded-xl transition cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-200 group-hover:text-indigo-400 transition">
                Financial Statements
              </span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 group-hover:translate-x-1 transition" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Real-time Trial Balance, Profit &amp; Loss, Balance Sheet, and general ledger running statements.
            </p>
          </div>
        </div>
      </div>
      </>
      )}

      {/* Architectural Principles & Phase Boundary */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <Lock className="w-4 h-4 text-indigo-400" />
          Strict Phase 1 Architectural Safeguards
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-400">
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3.5 space-y-1.5">
            <div className="font-semibold text-slate-200 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-emerald-400" />
              Production Cleanliness Enforced
            </div>
            <p>
              No demo employees, mock attendance punches, or fake accounting transactions exist in the database. Production data starts completely clean.
            </p>
          </div>

          <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3.5 space-y-1.5">
            <div className="font-semibold text-slate-200 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-indigo-400" />
              Biometric Edge Isolation
            </div>
            <p>
              Separately deployable Node.js daemon architecture defined for LAN terminals (e.g. F22). Edge devices communicate via authenticated push tokens.
            </p>
          </div>

          <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3.5 space-y-1.5">
            <div className="font-semibold text-slate-200 flex items-center gap-2">
              <Clock className="w-4 h-4 text-cyan-400" />
              Non-Destructive Database Management
            </div>
            <p>
              Database schema uses explicit migrations (<code className="text-slate-300">prisma migrate deploy</code>). The application never resets or drops tables at boot.
            </p>
          </div>

          <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3.5 space-y-1.5">
            <div className="font-semibold text-slate-200 flex items-center gap-2">
              <Layers className="w-4 h-4 text-amber-400" />
              Docker Compose & Cross-Platform
            </div>
            <p>
              Deployment target: Ubuntu Linux with Docker Compose and persistent PostgreSQL volume. Development target: Windows with Docker Desktop or native Node.js.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
