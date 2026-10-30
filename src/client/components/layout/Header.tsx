import React, { useState } from 'react';
import { Building2, Database, Shield, LogOut, User, LogIn } from 'lucide-react';
import { DatabaseReadiness, AuthUser, CompanyProfile } from '../../../shared/types.ts';
import { AdminNotificationsDropdown } from '../notifications/AdminNotificationsDropdown.tsx';
import { WorkingHoursLogoutModal } from '../attendance/WorkingHoursLogoutModal.tsx';

interface HeaderProps {
  currentUser: AuthUser | null;
  companyProfile: CompanyProfile | null;
  readiness: DatabaseReadiness | null;
  onLogout?: () => void;
  onNavigateToLogin?: () => void;
  onNavigate?: (tab: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentUser,
  companyProfile,
  readiness,
  onLogout,
  onNavigateToLogin,
  onNavigate,
}) => {
  const [showLogoutModal, setShowLogoutModal] = useState<boolean>(false);
  const isDbConnected = readiness?.status === 'connected';
  const companyName = companyProfile?.name || 'CoreERP Enterprise';
  const companyCode = companyProfile?.code || 'UNSET';
  const headerTitle = companyProfile?.appHeaderTitle || companyName;

  const handleLogoutClick = () => {
    if (currentUser?.role === 'EMPLOYEE') {
      setShowLogoutModal(true);
    } else {
      onLogout?.();
    }
  };

  return (
    <header className="h-16 bg-slate-900 border-b border-slate-800 px-6 flex items-center justify-between shrink-0">
      {/* Dynamic Company Branding Placeholders */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 overflow-hidden">
          {companyProfile?.logoUrl ? (
            <img src={companyProfile.logoUrl} alt="Logo" className="w-full h-full object-cover" />
          ) : (
            <Building2 className="w-4 h-4 text-indigo-400" />
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-slate-100">{headerTitle}</h1>
            <span className="text-[10px] px-2 py-0.5 rounded font-mono font-medium border bg-slate-800 text-indigo-300 border-indigo-900/60">
              TENANT: {companyCode}
            </span>
          </div>
          <p className="text-[11px] text-slate-400">
            {companyProfile ? `${companyProfile.currency} • ${companyProfile.timezone}` : 'System Initialized'}
          </p>
        </div>
      </div>

      {/* Right side status indicators and User Profile */}
      <div className="flex items-center gap-3 text-xs">
        {/* PostgreSQL Database status badge */}
        <div
          className={`hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono ${
            isDbConnected
              ? 'bg-emerald-950/50 text-emerald-300 border-emerald-800/60'
              : 'bg-amber-950/60 text-amber-300 border-amber-800/60'
          }`}
          title={
            isDbConnected
              ? `PostgreSQL Connected (${readiness?.latencyMs}ms)`
              : 'PostgreSQL Unreachable'
          }
        >
          <Database className="w-3.5 h-3.5" />
          <span>DB: {isDbConnected ? 'ONLINE' : 'OFFLINE'}</span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isDbConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
            }`}
          />
        </div>

        {/* Admin Notifications Bell (for ADMIN, SUPER_ADMIN, VICE_ADMIN) */}
        {currentUser && ['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN'].includes(currentUser.role) && (
          <AdminNotificationsDropdown
            currentUser={currentUser}
            onNavigate={onNavigate}
          />
        )}

        {/* User Pill & Role Badge */}
        {currentUser && (
          <div className="flex items-center gap-2 bg-slate-800/80 border border-slate-700/80 pl-2 pr-3 py-1 rounded-xl">
            <div className="w-6 h-6 rounded-lg bg-indigo-950 border border-indigo-800/60 flex items-center justify-center text-indigo-300 font-bold text-[10px]">
              {currentUser.fullName.charAt(0).toUpperCase()}
            </div>
            <div className="text-left hidden sm:block">
              <div className="font-semibold text-slate-100 text-[11px] leading-tight">
                {currentUser.fullName}
              </div>
              <div className="text-[9px] text-indigo-400 font-mono leading-tight">
                {currentUser.role}
              </div>
            </div>

            {onLogout && (
              <button
                onClick={handleLogoutClick}
                className="ml-2 p-1 text-slate-400 hover:text-red-400 hover:bg-slate-700/60 rounded transition cursor-pointer"
                title="Sign out of CoreERP"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Unauthenticated / Preview Mode Controls */}
        {!currentUser && (
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-block text-[10px] px-2 py-0.5 rounded font-mono bg-slate-800 text-slate-400 border border-slate-700">
              Preview Mode
            </span>
            {onNavigateToLogin && (
              <button
                onClick={onNavigateToLogin}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm transition cursor-pointer"
                title="Sign in with your account credentials"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign In</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Pre-Logout Shift Working Hours Modal for Employees */}
      {showLogoutModal && currentUser && (
        <WorkingHoursLogoutModal
          isOpen={showLogoutModal}
          currentUser={currentUser}
          onClose={() => setShowLogoutModal(false)}
          onConfirmLogout={() => {
            setShowLogoutModal(false);
            onLogout?.();
          }}
          onNavigateToAttendance={() => {
            setShowLogoutModal(false);
            onNavigate?.('attendance');
          }}
        />
      )}
    </header>
  );
};
