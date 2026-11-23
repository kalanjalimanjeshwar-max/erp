import type {
  AuthUser,
  CompanyProfile,
  DatabaseReadiness,
  LoginResponse,
  SetupStatusResponse,
} from '../../shared/types.ts';

export const OPERATIONAL_TABS = new Set<string>([
  'dashboard',
  'users',
  'users-create',
  'company',
  'permissions',
  'customers',
  'quotations',
  'invoices',
  'receipts',
  'employees',
  'departments',
  'my-profile',
  'self-service',
  'attendance',
  'biometric',
  'leave',
  'payroll',
  'expenses',
  'coa',
  'contra',
  'journals',
  'reports',
  'audit',
  'health',
  'modules',
]);

export function isOperationalTab(tab: string | null | undefined): tab is string {
  return typeof tab === 'string' && OPERATIONAL_TABS.has(tab);
}

export function parseTabFromHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const cleaned = hash.replace(/^#\/?/, '').replace(/\/+$/, '').trim();
  return isOperationalTab(cleaned) ? cleaned : null;
}

export function formatHashForTab(tab: string): string {
  return isOperationalTab(tab) ? `#/${tab}` : '';
}

export type InitialAuthProbeResult =
  | { ok: true; user: AuthUser; company: CompanyProfile | null }
  | { ok: false; errorCode?: string; errorMessage?: string };

export interface ResolvedSessionState {
  currentUser: AuthUser | null;
  companyProfile: CompanyProfile | null;
  dbReadiness: DatabaseReadiness;
  activeTab: string;
  sessionExpiredMessage: string | null;
}

export function resolveInitialSessionState(params: {
  auth: InitialAuthProbeResult;
  readiness: DatabaseReadiness | null;
  setupStatus: SetupStatusResponse | null;
  requestedTab: string | null;
}): ResolvedSessionState {
  const { auth, readiness, setupStatus, requestedTab } = params;

  const fallbackDisconnected: DatabaseReadiness = {
    status: 'disconnected',
    database: 'PostgreSQL',
    error: 'Backend API or database probe did not return a valid response.',
  };

  if (auth.ok) {
    const resolvedReadiness: DatabaseReadiness =
      readiness?.status === 'connected'
        ? readiness
        : !auth.user.isPreview
        ? { status: 'connected', database: 'PostgreSQL' }
        : readiness || fallbackDisconnected;

    const activeTab = isOperationalTab(requestedTab) ? requestedTab : 'dashboard';

    return {
      currentUser: auth.user,
      companyProfile: auth.company,
      dbReadiness: resolvedReadiness,
      activeTab,
      sessionExpiredMessage: null,
    };
  }

  const resolvedReadiness = readiness || fallbackDisconnected;
  const errorCode = !auth.ok && 'errorCode' in auth ? auth.errorCode : undefined;
  const errorMessage = !auth.ok && 'errorMessage' in auth ? auth.errorMessage : undefined;
  const isExpiredOrRevoked =
    errorCode === 'SESSION_EXPIRED' || errorCode === 'ACCOUNT_INACTIVE_OR_REVOKED';
  const sessionExpiredMessage = isExpiredOrRevoked
    ? errorMessage || 'Your session has expired. Please sign in again.'
    : null;

  let activeTab = 'dashboard';
  if (setupStatus?.databaseConnected && setupStatus.isSetupRequired) {
    activeTab = requestedTab === 'login' ? 'login' : 'setup';
  } else if (setupStatus?.databaseConnected && !setupStatus.isSetupRequired) {
    activeTab = 'login';
  } else if (
    requestedTab === 'login' ||
    requestedTab === 'setup' ||
    requestedTab === 'db_status'
  ) {
    activeTab = requestedTab;
  }

  return {
    currentUser: null,
    companyProfile: null,
    dbReadiness: resolvedReadiness,
    activeTab,
    sessionExpiredMessage,
  };
}

export function resolvePostLoginState(params: {
  data: LoginResponse;
  currentReadiness: DatabaseReadiness | null;
  requestedTab: string | null;
}): {
  currentUser: AuthUser;
  companyProfile: CompanyProfile | null;
  dbReadiness: DatabaseReadiness | null;
  activeTab: string;
  sessionExpiredMessage: null;
} {
  const { data, currentReadiness, requestedTab } = params;
  const dbReadiness =
    !data.user.isPreview && currentReadiness?.status !== 'connected'
      ? { status: 'connected' as const, database: 'PostgreSQL' as const }
      : currentReadiness;

  return {
    currentUser: data.user,
    companyProfile: data.company,
    dbReadiness,
    activeTab: isOperationalTab(requestedTab) ? requestedTab : 'dashboard',
    sessionExpiredMessage: null,
  };
}

export function resolvePostLogoutState(): {
  currentUser: null;
  companyProfile: null;
  activeTab: 'login';
  sessionExpiredMessage: null;
} {
  return {
    currentUser: null,
    companyProfile: null,
    activeTab: 'login',
    sessionExpiredMessage: null,
  };
}
