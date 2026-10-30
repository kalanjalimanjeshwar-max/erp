import React, { ReactNode } from 'react';
import { Sidebar } from './Sidebar.tsx';
import { Header } from './Header.tsx';
import { ConnectionStatusBanner } from '../common/ConnectionStatusBanner.tsx';
import { SetupStatusResponse, DatabaseReadiness, AuthUser, CompanyProfile } from '../../../shared/types.ts';

interface AppLayoutProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
  currentUser: AuthUser | null;
  companyProfile: CompanyProfile | null;
  setupStatus: SetupStatusResponse | null;
  readiness: DatabaseReadiness | null;
  isHealthLoading: boolean;
  onRefreshHealth: () => void;
  onLogout?: () => void;
  onNavigateToLogin?: () => void;
  children: ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({
  currentTab,
  onTabChange,
  currentUser,
  companyProfile,
  setupStatus,
  readiness,
  isHealthLoading,
  onRefreshHealth,
  onLogout,
  onNavigateToLogin,
  children,
}) => {
  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onTabChange={onTabChange}
        currentUser={currentUser}
        companyProfile={companyProfile}
        isSetupRequired={setupStatus?.isSetupRequired !== false}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Dynamic Header */}
        <Header
          currentUser={currentUser}
          companyProfile={companyProfile}
          readiness={readiness}
          onLogout={onLogout}
          onNavigateToLogin={onNavigateToLogin}
          onNavigate={onTabChange}
        />

        {/* Temporary Preview Account Exploration Banner */}
        {currentUser?.isPreview && (
          <div className="bg-amber-950/95 border-b border-amber-700/80 px-6 py-2.5 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-lg">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
              <div>
                <span className="font-bold text-amber-100">
                  Temporary Preview Account — Not a Real Super Admin
                </span>
                <span className="text-amber-300/80 ml-2">
                  (UI Exploration Mode • PostgreSQL is offline in sandbox. Persistent mutations are disabled.)
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-900/60 border border-amber-700/60 text-amber-300">
                Read-Only Preview Session
              </span>
              {onLogout && (
                <button
                  onClick={onLogout}
                  className="text-[11px] underline text-amber-300 hover:text-white font-semibold cursor-pointer"
                >
                  Exit Preview
                </button>
              )}
            </div>
          </div>
        )}

        {/* Scrollable Body */}
        <main className="flex-1 p-6 md:p-8 max-w-7xl w-full mx-auto space-y-6">
          {/* PostgreSQL Connection Diagnostic Alert */}
          <ConnectionStatusBanner
            readiness={readiness}
            isLoading={isHealthLoading}
            onRefresh={onRefreshHealth}
          />

          {/* Child Pages */}
          {children}
        </main>
      </div>
    </div>
  );
};
