import React, { useState, useEffect, useCallback } from 'react';
import { ErrorBoundary } from './client/components/common/ErrorBoundary.tsx';
import { AppLayout } from './client/components/layout/AppLayout.tsx';
import { LoginPage } from './client/pages/LoginPage.tsx';
import { DashboardPage } from './client/pages/DashboardPage.tsx';
import { SetupWizardPage } from './client/pages/SetupWizardPage.tsx';
import { DatabaseUnavailablePage } from './client/pages/DatabaseUnavailablePage.tsx';
import { SystemHealthPage } from './client/pages/SystemHealthPage.tsx';
import { ModulesOverviewPage } from './client/pages/ModulesOverviewPage.tsx';
import { UserAdminPage } from './client/pages/UserAdminPage.tsx';
import { CompanyAdminPage } from './client/pages/CompanyAdminPage.tsx';
import { PermissionMatrixPage } from './client/pages/PermissionMatrixPage.tsx';
import { AuditLogPage } from './client/pages/AuditLogPage.tsx';
import { ChartOfAccountsPage } from './client/pages/ChartOfAccountsPage.tsx';
import { ContraEntriesPage } from './client/pages/ContraEntriesPage.tsx';
import { JournalEntriesPage } from './client/pages/JournalEntriesPage.tsx';
import { FinancialReportsPage } from './client/pages/FinancialReportsPage.tsx';
import { CustomersPage } from './client/pages/CustomersPage.tsx';
import { QuotationsPage } from './client/pages/QuotationsPage.tsx';
import { InvoicesPage } from './client/pages/InvoicesPage.tsx';
import { ReceiptsPage } from './client/pages/ReceiptsPage.tsx';
import { EmployeesPage } from './client/pages/EmployeesPage.tsx';
import { DepartmentsPage } from './client/pages/DepartmentsPage.tsx';
import { AttendancePage } from './client/pages/AttendancePage.tsx';
import { BiometricDevicesPage } from './client/pages/BiometricDevicesPage.tsx';
import { LeavePage } from './client/pages/LeavePage.tsx';
import { PayrollPage } from './client/pages/PayrollPage.tsx';
import { EmployeeSelfServicePage } from './client/pages/EmployeeSelfServicePage.tsx';
import { AccessDenied } from './client/components/common/AccessDenied.tsx';
import { DatabaseDisconnectedNotice } from './client/components/common/DatabaseDisconnectedNotice.tsx';
import { LoadingSpinner } from './client/components/common/LoadingSpinner.tsx';
import { api, ApiError } from './client/services/api.ts';
import {
  SetupStatusResponse,
  DatabaseReadiness,
  AuthUser,
  CompanyProfile,
  LoginResponse,
  InvoiceItem,
} from './shared/types.ts';

export default function App() {
  const [currentTab, setCurrentTab] = useState<string>('dashboard');
  const [statementLedgerId, setStatementLedgerId] = useState<string | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [receiptTargetInvoice, setReceiptTargetInvoice] = useState<InvoiceItem | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [dbReadiness, setDbReadiness] = useState<DatabaseReadiness | null>(null);
  const [isInitializing, setIsInitializing] = useState<boolean>(true);
  const [isHealthLoading, setIsHealthLoading] = useState<boolean>(false);
  const [isRetryingConnection, setIsRetryingConnection] = useState<boolean>(false);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  // Initial session restoration and system bootstrap probe
  const initializeApp = useCallback(async () => {
    setIsInitializing(true);
    try {
      const [readinessRes, setupRes, authRes] = await Promise.allSettled([
        api.getReadiness(),
        api.getSetupStatus(),
        api.getMe(),
      ]);

      if (readinessRes.status === 'fulfilled') {
        setDbReadiness(readinessRes.value.checks.postgres);
      } else {
        setDbReadiness({
          status: 'disconnected',
          database: 'PostgreSQL',
          error: 'Backend API or database probe did not return a valid response.',
        });
      }

      let hasAuthenticatedUser = false;
      if (authRes.status === 'fulfilled') {
        setCurrentUser(authRes.value.user);
        setCompanyProfile(authRes.value.company);
        setSessionExpiredMessage(null);
        hasAuthenticatedUser = true;
      } else {
        setCurrentUser(null);
      }

      if (setupRes.status === 'fulfilled') {
        setSetupStatus(setupRes.value);
        if (setupRes.value.databaseConnected && setupRes.value.isSetupRequired) {
          setCurrentTab((prev) => (prev === 'login' ? 'login' : 'setup'));
        } else if (setupRes.value.databaseConnected && !setupRes.value.isSetupRequired && !hasAuthenticatedUser) {
          setCurrentTab('login');
        }
      }
    } finally {
      setIsInitializing(false);
    }
  }, []);

  useEffect(() => {
    initializeApp();
  }, [initializeApp]);

  const handleRetryConnection = async () => {
    setIsRetryingConnection(true);
    await initializeApp();
    setIsRetryingConnection(false);
  };

  const refreshDiagnostics = async () => {
    setIsHealthLoading(true);
    try {
      const [readinessRes, setupRes] = await Promise.allSettled([
        api.getReadiness(),
        api.getSetupStatus(),
      ]);
      if (readinessRes.status === 'fulfilled') {
        setDbReadiness(readinessRes.value.checks.postgres);
      }
      if (setupRes.status === 'fulfilled') {
        setSetupStatus(setupRes.value);
      }
    } finally {
      setIsHealthLoading(false);
    }
  };

  const handleLoginSuccess = (data: LoginResponse) => {
    setCurrentUser(data.user);
    setCompanyProfile(data.company);
    setSessionExpiredMessage(null);
    setCurrentTab('dashboard');
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // Safe exit
    } finally {
      setCurrentUser(null);
      setSessionExpiredMessage(null);
      setCurrentTab('login');
    }
  };

  const handleSetupSuccess = () => {
    initializeApp();
    setCurrentTab('dashboard');
  };

  // State 0: Initial bootloader
  if (isInitializing) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <LoadingSpinner message="Resolving CoreERP security session and system state..." size="lg" />
      </div>
    );
  }

  // State 1: Database readiness & connection indicator
  const isDbOffline = dbReadiness?.status !== 'connected';
  const isPreviewMode = Boolean(currentUser?.isPreview);
  const showOfflineNotice = isDbOffline && !isPreviewMode;

  // Explicit View: Database Diagnostics & Status
  if (currentTab === 'db_status') {
    return (
      <ErrorBoundary>
        <DatabaseUnavailablePage
          readiness={dbReadiness}
          isRetrying={isRetryingConnection}
          onRetry={handleRetryConnection}
          onNavigateToLogin={() => setCurrentTab('login')}
          onNavigateToSetup={() => setCurrentTab('setup')}
        />
      </ErrorBoundary>
    );
  }

  // Explicit View: First-time company setup wizard
  if (currentTab === 'setup') {
    return (
      <ErrorBoundary>
        <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12">
          <SetupWizardPage
            setupStatus={setupStatus}
            readiness={dbReadiness}
            onSetupSuccess={handleSetupSuccess}
            onNavigateToLogin={() => setCurrentTab('login')}
            onNavigateToDbStatus={() => setCurrentTab('db_status')}
          />
        </div>
      </ErrorBoundary>
    );
  }

  // Explicit View: Login Page
  if (currentTab === 'login') {
    return (
      <ErrorBoundary>
        <LoginPage
          onLoginSuccess={handleLoginSuccess}
          onNavigateToSetup={() => setCurrentTab('setup')}
          onNavigateToDbStatus={() => setCurrentTab('db_status')}
          onNavigateToDashboard={() => setCurrentTab('dashboard')}
          isSetupRequired={setupStatus?.isSetupRequired || false}
          readiness={dbReadiness}
          sessionExpiredMessage={sessionExpiredMessage}
        />
      </ErrorBoundary>
    );
  }

  // Helper check for role restrictions (safe when currentUser is null)
  const isEmployee = currentUser?.role === 'EMPLOYEE';

  return (
    <ErrorBoundary>
      <AppLayout
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        currentUser={currentUser}
        companyProfile={companyProfile}
        setupStatus={setupStatus}
        readiness={dbReadiness}
        isHealthLoading={isHealthLoading}
        onRefreshHealth={refreshDiagnostics}
        onLogout={handleLogout}
        onNavigateToLogin={() => setCurrentTab('login')}
      >
        {currentTab === 'dashboard' && (
          <DashboardPage
            setupStatus={setupStatus}
            readiness={dbReadiness}
            currentUser={currentUser}
            onNavigate={setCurrentTab}
          />
        )}

        {(currentTab === 'users' || currentTab === 'users-create') &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="User Administration Directory"
              phaseTag="Phase 2 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : isEmployee ? (
            <AccessDenied onBackToDashboard={() => setCurrentTab('dashboard')} requiredRole="ADMIN" />
          ) : (
            <UserAdminPage
              currentUser={currentUser}
              initialOpenCreate={currentTab === 'users-create'}
              onSwitchPreviewUser={setCurrentUser}
            />
          ))}

        {currentTab === 'company' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Company Settings & Tenant Profile"
              phaseTag="Phase 2 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : isEmployee ? (
            <AccessDenied onBackToDashboard={() => setCurrentTab('dashboard')} requiredRole="ADMIN" />
          ) : (
            <CompanyAdminPage currentUser={currentUser} onProfileUpdated={(p) => setCompanyProfile(p)} />
          ))}

        {currentTab === 'permissions' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Permission Matrix & Access Ceilings"
              phaseTag="Phase 3 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : isEmployee ? (
            <AccessDenied onBackToDashboard={() => setCurrentTab('dashboard')} requiredRole="ADMIN" />
          ) : (
            <PermissionMatrixPage currentUser={currentUser} />
          ))}

        {currentTab === 'customers' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Customer Accounts Receivable Directory"
              phaseTag="Phase 5 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <CustomersPage
              currentUser={currentUser!}
              onNavigateToInvoice={(_customerId) => {
                setCurrentTab('invoices');
              }}
            />
          ))}

        {currentTab === 'quotations' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Price Quotations & Billing Estimates"
              phaseTag="Phase 5 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <QuotationsPage
              currentUser={currentUser!}
              companyProfile={companyProfile}
              onNavigateToInvoice={(invId) => {
                setSelectedInvoiceId(invId);
                setCurrentTab('invoices');
              }}
            />
          ))}

        {currentTab === 'invoices' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Invoices & Customer Billing"
              phaseTag="Phase 5 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <InvoicesPage
              currentUser={currentUser!}
              companyProfile={companyProfile}
              initialInvoiceId={selectedInvoiceId}
              onRecordPayment={(invoice) => {
                setReceiptTargetInvoice(invoice);
                setCurrentTab('receipts');
              }}
              onViewJournal={(_voucherNumber) => {
                setCurrentTab('journals');
              }}
            />
          ))}

        {currentTab === 'receipts' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Customer Payment Receipts & Allocation"
              phaseTag="Phase 5 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <ReceiptsPage
              currentUser={currentUser!}
              companyProfile={companyProfile}
              preselectedInvoice={receiptTargetInvoice}
              onViewJournal={(_voucherNumber) => {
                setCurrentTab('journals');
              }}
            />
          ))}

        {currentTab === 'employees' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Employee Management & Salary Structure"
              phaseTag="Phase 6 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : isEmployee ? (
            <AccessDenied onBackToDashboard={() => setCurrentTab('dashboard')} requiredRole="ADMIN" />
          ) : (
            <EmployeesPage currentUser={currentUser!} />
          ))}

        {currentTab === 'departments' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Departments & Designations Hierarchy"
              phaseTag="Phase 6 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : isEmployee ? (
            <AccessDenied onBackToDashboard={() => setCurrentTab('dashboard')} requiredRole="ADMIN" />
          ) : (
            <DepartmentsPage currentUser={currentUser!} />
          ))}

        {currentTab === 'my-profile' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Employee Profile & Salary Self-Service"
              phaseTag="Phase 6 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <EmployeesPage currentUser={currentUser!} isSelfServiceOnly={true} />
          ))}

        {currentTab === 'self-service' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Employee Self-Service (ESS)"
              phaseTag="Phase 7 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <EmployeeSelfServicePage currentUser={currentUser!} />
          ))}

        {currentTab === 'attendance' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Time & Attendance Tracking"
              phaseTag="Phase 7 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <AttendancePage currentUser={currentUser!} />
          ))}

        {currentTab === 'biometric' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Biometric Terminals & LAN Hardware Bridge"
              phaseTag="Phase 8 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : isEmployee ? (
            <AccessDenied onBackToDashboard={() => setCurrentTab('dashboard')} requiredRole="ADMIN" />
          ) : (
            <BiometricDevicesPage currentUser={currentUser!} />
          ))}

        {currentTab === 'leave' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Leave Applications & Approval"
              phaseTag="Phase 7 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <LeavePage currentUser={currentUser!} />
          ))}

        {currentTab === 'payroll' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Payroll Management & Self-Service"
              phaseTag="Phase 7 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <PayrollPage
              currentUser={currentUser!}
              onNavigateToJournals={() => setCurrentTab('journals')}
            />
          ))}

        {currentTab === 'coa' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Chart of Accounts (General Ledger)"
              phaseTag="Phase 4 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <ChartOfAccountsPage
              currentUser={currentUser}
              onViewStatement={(ledgerId) => {
                setStatementLedgerId(ledgerId);
                setCurrentTab('reports');
              }}
            />
          ))}

        {currentTab === 'contra' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Contra Entry Internal Transfers"
              phaseTag="Phase 4 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <ContraEntriesPage
              currentUser={currentUser}
              companyProfile={companyProfile}
              onNavigateToLedger={(ledgerId) => {
                setStatementLedgerId(ledgerId);
                setCurrentTab('reports');
              }}
            />
          ))}

        {currentTab === 'journals' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="General Journal Double-Entry Vouchers"
              phaseTag="Phase 4 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <JournalEntriesPage currentUser={currentUser} />
          ))}

        {currentTab === 'reports' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Financial Statements & Running Ledgers"
              phaseTag="Phase 4 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : (
            <FinancialReportsPage
              currentUser={currentUser}
              initialLedgerId={statementLedgerId}
            />
          ))}

        {currentTab === 'audit' &&
          (showOfflineNotice || !currentUser ? (
            <DatabaseDisconnectedNotice
              moduleName="Security Audit Trail"
              phaseTag="Phase 3 Operational"
              readiness={dbReadiness}
              isAuthenticated={!!currentUser}
              onBackToDashboard={() => setCurrentTab('dashboard')}
              onNavigateToDiagnostics={() => setCurrentTab('health')}
              onNavigateToLogin={() => setCurrentTab('login')}
            />
          ) : isEmployee ? (
            <AccessDenied onBackToDashboard={() => setCurrentTab('dashboard')} requiredRole="ADMIN" />
          ) : (
            <AuditLogPage />
          ))}

        {currentTab === 'health' && <SystemHealthPage />}

        {currentTab === 'modules' && <ModulesOverviewPage />}
      </AppLayout>
    </ErrorBoundary>
  );
}
