import React from 'react';
import {
  LayoutDashboard,
  Building2,
  Activity,
  ShieldCheck,
  Calculator,
  Users,
  Fingerprint,
  CalendarCheck,
  ShieldAlert,
  Sliders,
  Settings,
  HelpCircle,
  BookOpen,
  FileCheck,
  FileText,
  DollarSign,
  UserPlus,
  ArrowLeftRight,
  UserCheck,
} from 'lucide-react';
import { AuthUser, CompanyProfile } from '../../../shared/types.ts';

interface SidebarProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
  currentUser: AuthUser | null;
  companyProfile?: CompanyProfile | null;
  isSetupRequired: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onTabChange,
  currentUser,
  companyProfile,
  isSetupRequired,
}) => {
  const isEmployee = currentUser?.role === 'EMPLOYEE';
  const canManageUsers = currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'ADMIN';

  const userNav = canManageUsers
    ? [
        { id: 'users', label: 'User Directory', icon: Users },
        { id: 'users-create', label: 'Create New User', icon: UserPlus },
        { id: 'permissions', label: 'Permission Matrix', icon: Sliders },
        { id: 'audit', label: 'Audit Trail', icon: ShieldAlert },
        { id: 'company', label: 'Company Settings', icon: Building2 },
      ]
    : !isEmployee
    ? [
        { id: 'users', label: 'User Directory', icon: Users },
        { id: 'permissions', label: 'Permission Matrix', icon: Sliders },
      ]
    : [];

  const primaryNav = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'health', label: 'Diagnostics & Health', icon: Activity },
    { id: 'modules', label: 'Module Registry', icon: ShieldCheck },
  ];

  const isSalesInvoiceEnabled = companyProfile?.salesInvoiceEnabled ?? false;

  const salesNav = [
    { id: 'customers', label: 'Customers', icon: Users },
    { id: 'quotations', label: 'Quotations', icon: FileCheck },
    ...(isSalesInvoiceEnabled
      ? [{ id: 'invoices', label: 'Invoices & Billing', icon: FileText }]
      : []),
    { id: 'receipts', label: 'Customer Receipts', icon: DollarSign },
  ];

  const hrNav = isEmployee
    ? [
        { id: 'self-service', label: 'Employee Self-Service (ESS)', icon: UserCheck },
        { id: 'my-profile', label: 'My Profile & Salary', icon: Users },
        { id: 'attendance', label: 'My Attendance Logs', icon: CalendarCheck },
        { id: 'leave', label: 'Leave Applications', icon: FileText },
        { id: 'payroll', label: 'My Payslips', icon: DollarSign },
      ]
    : [
        { id: 'self-service', label: 'My Self-Service (ESS)', icon: UserCheck },
        { id: 'employees', label: 'Employee Directory', icon: Users },
        { id: 'departments', label: 'Departments & Designations', icon: Building2 },
        { id: 'attendance', label: 'Time & Attendance', icon: CalendarCheck },
        { id: 'biometric', label: 'Biometric Terminals', icon: Fingerprint },
        { id: 'leave', label: 'Leave Management', icon: FileText },
        { id: 'payroll', label: 'Payroll & Compensation', icon: DollarSign },
      ];

  const accountingNav = [
    { id: 'coa', label: 'Chart of Accounts', icon: Calculator },
    { id: 'contra', label: 'Contra Entries', icon: ArrowLeftRight },
    { id: 'journals', label: 'Journal Entries', icon: BookOpen },
    { id: 'reports', label: 'Financial Reports', icon: ShieldCheck },
  ];

  const futureModules = [
    { label: 'Fixed Assets & Depreciation', icon: Building2, phase: 'Phase 9' },
  ];

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 min-h-screen">
      {/* Branding Header */}
      <div className="p-5 border-b border-slate-800 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
          C
        </div>
        <div>
          <div className="text-sm font-bold tracking-tight text-slate-100">CoreERP</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-violet-400">
            Phase 8 • Biometric Terminals &amp; Sync
          </div>
        </div>
      </div>

      {/* Navigation Sections */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {/* Core Navigation */}
        <div>
          <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Enterprise Navigation
          </div>
          <nav className="space-y-1">
            {primaryNav.map((item) => {
              const Icon = item.icon;
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onTabChange(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition cursor-pointer ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4 text-indigo-400" />
                    <span>{item.label}</span>
                  </div>
                </button>
              );
            })}
          </nav>
        </div>

        {/* User Management & Access Control Section */}
        {userNav.length > 0 && (
          <div>
            <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-indigo-400 flex items-center justify-between">
              <span>User Management</span>
              <span className="text-[9px] px-1.5 py-0.2 bg-indigo-950 text-indigo-300 border border-indigo-800 rounded font-semibold">
                Admin
              </span>
            </div>
            <nav className="space-y-1">
              {userNav.map((item) => {
                const Icon = item.icon;
                const isActive = currentTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onTabChange(item.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition cursor-pointer ${
                      isActive
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon className="w-4 h-4 text-indigo-400" />
                      <span>{item.label}</span>
                    </div>
                  </button>
                );
              })}
            </nav>
          </div>
        )}

        {/* Human Resources & Workplace Section */}
        {hrNav.length > 0 && (
          <div>
            <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-violet-400 flex items-center justify-between">
              <span>{isEmployee ? 'My Workplace' : 'HR & Payroll'}</span>
              <span className="text-[9px] px-1.5 py-0.2 bg-violet-950 text-violet-300 border border-violet-800 rounded">
                Live
              </span>
            </div>
            <nav className="space-y-1">
              {hrNav.map((item) => {
                const Icon = item.icon;
                const isActive = currentTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onTabChange(item.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition cursor-pointer ${
                      isActive
                        ? 'bg-violet-600 text-white shadow-sm'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon className="w-4 h-4 text-violet-400" />
                      <span>{item.label}</span>
                    </div>
                  </button>
                );
              })}
            </nav>
          </div>
        )}

        {/* Sales & Billing Section */}
        {!isEmployee && (
          <div>
            <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-400 flex items-center justify-between">
              <span>Sales & Billing</span>
              <span className="text-[9px] px-1.5 py-0.2 bg-emerald-950 text-emerald-300 border border-emerald-800 rounded">
                Live
              </span>
            </div>
            <nav className="space-y-1">
              {salesNav.map((item) => {
                const Icon = item.icon;
                const isActive = currentTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onTabChange(item.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition cursor-pointer ${
                      isActive
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon className="w-4 h-4 text-emerald-400" />
                      <span>{item.label}</span>
                    </div>
                  </button>
                );
              })}
            </nav>
          </div>
        )}

        {/* Accounting Core Section */}
        {!isEmployee && (
          <div>
            <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-indigo-400 flex items-center justify-between">
              <span>Core Accounting</span>
              <span className="text-[9px] px-1.5 py-0.2 bg-indigo-950 text-indigo-300 border border-indigo-800 rounded">
                Live
              </span>
            </div>
            <nav className="space-y-1">
              {accountingNav.map((item) => {
                const Icon = item.icon;
                const isActive = currentTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onTabChange(item.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition cursor-pointer ${
                      isActive
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon className="w-4 h-4 text-indigo-400" />
                      <span>{item.label}</span>
                    </div>
                  </button>
                );
              })}
            </nav>
          </div>
        )}

        {/* Future ERP Modules */}
        <div>
          <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center justify-between">
            <span>Planned Modules</span>
            <span className="text-[10px] text-slate-400 font-mono">Roadmap</span>
          </div>
          <div className="space-y-1 opacity-70">
            {futureModules.map((item, idx) => {
              const Icon = item.icon;
              return (
                <div
                  key={idx}
                  className="flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-300 transition"
                  title={`${item.label} is scheduled for implementation in ${item.phase}`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4 text-slate-400" />
                    <span>{item.label}</span>
                  </div>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-400 border border-slate-700/60 font-mono">
                    {item.phase}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div className="p-3 border-t border-slate-800 text-[11px] text-slate-400 space-y-1">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-slate-400">
            <Settings className="w-3.5 h-3.5" /> DB Engine
          </span>
          <span className="font-mono text-indigo-400 font-medium">PostgreSQL</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-slate-400">
            <HelpCircle className="w-3.5 h-3.5" /> Migration
          </span>
          <span className="font-mono text-slate-400">Prisma v6</span>
        </div>
      </div>
    </aside>
  );
};
