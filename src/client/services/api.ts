import {
  HealthResponse,
  ReadinessResponse,
  SetupStatusResponse,
  InitialSetupRequest,
  InitialSetupResult,
  ApiErrorResponse,
  LoginRequest,
  LoginResponse,
  UserListItem,
  CreateUserRequest,
  UpdateCompanyProfileRequest,
  CompanyProfile,
  Role,
  AppModule,
  AppAction,
  AuditLogData,
  AccountRootType,
  JournalStatus,
  AccountGroupItem,
  CreateAccountGroupRequest,
  AccountLedgerItem,
  CreateAccountLedgerRequest,
  UpdateAccountLedgerRequest,
  JournalEntryItem,
  CreateJournalEntryRequest,
  ContraEntryItem,
  CreateContraEntryRequest,
  TrialBalanceReport,
  LedgerStatementReport,
  ProfitAndLossReport,
  BalanceSheetReport,
  OpeningBalanceValidationResult,
  CashBankBookReport,
  CustomerItem,
  CreateCustomerRequest,
  UpdateCustomerRequest,
  QuotationItem,
  QuotationStatus,
  CreateQuotationRequest,
  UpdateQuotationRequest,
  InvoiceItem,
  InvoiceStatus,
  CreateInvoiceRequest,
  UpdateInvoiceRequest,
  IssueInvoiceRequest,
  CustomerReceiptItem,
  ReceiptStatus,
  CreateCustomerReceiptRequest,
  DepartmentItem,
  CreateDepartmentRequest,
  UpdateDepartmentRequest,
  DesignationItem,
  CreateDesignationRequest,
  UpdateDesignationRequest,
  EmployeeItem,
  CreateEmployeeRequest,
  UpdateEmployeeRequest,
  CreateEmployeeLoginRequest,
  LinkEmployeeLedgerRequest,
  SalaryRevisionItem,
  CreateSalaryRevisionRequest,
  EmployeeStatus,
  PreviewLoginResponse,
  ShiftItem,
  CreateShiftRequest,
  UpdateShiftRequest,
  AttendanceItem,
  AttendanceStatus,
  CreateAttendanceRequest,
  UpdateAttendanceRequest,
  WorkingHoursSummary,
  AdminNotificationItem,
  LeaveTypeItem,
  CreateLeaveTypeRequest,
  UpdateLeaveTypeRequest,
  LeaveRequestItem,
  LeaveStatus,
  MonthlyLeaveSummary,
  CreateLeaveRequestInput,
  ReviewLeaveRequestInput,
  PayrollPeriodItem,
  PayrollStatus,
  CreatePayrollPeriodRequest,
  PayslipItem,
  PayslipStatus,
  PostPayrollRequest,
  BiometricTerminalItem,
  BiometricTerminalStatus,
  CreateBiometricTerminalRequest,
  CreateBiometricTerminalResponse,
  BatchPunchSubmissionRequest,
  BatchPunchSubmissionResponse,
  TerminalHeartbeatRequest,
  TerminalHeartbeatResponse,
  PunchSyncStatus,
  RawPunchLogItem,
  PunchReconciliationOptions,
  PunchReconciliationResponse,
  PunchSyncSummaryResponse,
} from '../../shared/types.ts';

export class ApiError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;

  constructor(message: string, statusCode: number, code: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'include', // Include HttpOnly session cookie
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      ...options,
    });
  } catch (err: unknown) {
    throw new ApiError(
      'Unable to connect to CoreERP backend server. Please check if the service is running.',
      0,
      'NETWORK_FAILURE',
      err
    );
  }

  if (!response.ok) {
    let errorData: ApiErrorResponse | null = null;
    try {
      errorData = (await response.json()) as ApiErrorResponse;
    } catch {
      // Non-JSON response
    }

    const code = errorData?.error?.code || `HTTP_${response.status}`;
    const message = errorData?.error?.message || response.statusText || 'An API error occurred';
    throw new ApiError(message, response.status, code, errorData?.error?.details);
  }

  return response.json() as Promise<T>;
}

export const api = {
  // Diagnostics & Initial Bootstrap
  getHealth: () => request<HealthResponse>('/api/health'),
  getReadiness: () => request<ReadinessResponse>('/api/ready'),
  getSetupStatus: () => request<SetupStatusResponse>('/api/setup/status'),
  bootstrapSetup: (data: InitialSetupRequest) =>
    request<InitialSetupResult>('/api/setup/bootstrap', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Authentication
  login: (data: LoginRequest) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  previewLogin: (data: { id: string; password: string }) =>
    request<PreviewLoginResponse>('/api/auth/preview-login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  logout: () =>
    request<{ success: boolean; message: string }>('/api/auth/logout', {
      method: 'POST',
    }),
  getMe: () => request<LoginResponse>('/api/auth/me'),

  // User Administration
  listUsers: (params?: { search?: string; role?: Role; isActive?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.append('search', params.search);
    if (params?.role) searchParams.append('role', params.role);
    if (params?.isActive !== undefined) searchParams.append('isActive', String(params.isActive));
    const qs = searchParams.toString();
    return request<UserListItem[]>(`/api/users${qs ? `?${qs}` : ''}`);
  },
  createUser: (data: CreateUserRequest) =>
    request<UserListItem>('/api/users', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateUserRole: (userId: string, role: Role) =>
    request<{ success: boolean }>(`/api/users/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  updateUserStatus: (userId: string, isActive: boolean) =>
    request<{ success: boolean }>(`/api/users/${userId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    }),
  resetUserPassword: (userId: string, newPassword: string) =>
    request<{ success: boolean }>(`/api/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    }),

  // Company Administration
  getCompanyProfile: () => request<CompanyProfile>('/api/company/profile'),
  updateCompanyProfile: (data: UpdateCompanyProfileRequest) =>
    request<CompanyProfile>('/api/company/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Permission Matrix
  getPermissionMatrix: () =>
    request<Record<Role, Record<AppModule, Record<AppAction, boolean>>>>('/api/permissions/matrix'),
  setPermissionOverride: (data: {
    role: Role;
    module: AppModule;
    action: AppAction;
    isGranted: boolean;
  }) =>
    request<{ success: boolean }>('/api/permissions/override', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Audit Logs
  getAuditLogs: (params?: { limit?: number; offset?: number; entity?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.append('limit', String(params.limit));
    if (params?.offset) searchParams.append('offset', String(params.offset));
    if (params?.entity) searchParams.append('entity', params.entity);
    const qs = searchParams.toString();
    return request<AuditLogData[]>(`/api/audit-logs${qs ? `?${qs}` : ''}`);
  },

  // ==========================================
  // Phase 4 Accounting APIs
  // ==========================================

  // Chart of Accounts: Groups
  getAccountGroups: () => request<AccountGroupItem[]>('/api/accounting/groups'),
  createAccountGroup: (data: CreateAccountGroupRequest) =>
    request<AccountGroupItem>('/api/accounting/groups', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Chart of Accounts: Ledgers
  getAccountLedgers: (params?: {
    groupId?: string;
    rootType?: AccountRootType;
    isActive?: boolean;
    search?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.groupId) searchParams.append('groupId', params.groupId);
    if (params?.rootType) searchParams.append('rootType', params.rootType);
    if (params?.isActive !== undefined) searchParams.append('isActive', String(params.isActive));
    if (params?.search) searchParams.append('search', params.search);
    const qs = searchParams.toString();
    return request<AccountLedgerItem[]>(`/api/accounting/ledgers${qs ? `?${qs}` : ''}`);
  },
  getLedgers: (params?: {
    groupId?: string;
    rootType?: AccountRootType;
    isActive?: boolean;
    search?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.groupId) searchParams.append('groupId', params.groupId);
    if (params?.rootType) searchParams.append('rootType', params.rootType);
    if (params?.isActive !== undefined) searchParams.append('isActive', String(params.isActive));
    if (params?.search) searchParams.append('search', params.search);
    const qs = searchParams.toString();
    return request<AccountLedgerItem[]>(`/api/accounting/ledgers${qs ? `?${qs}` : ''}`);
  },
  createAccountLedger: (data: CreateAccountLedgerRequest) =>
    request<AccountLedgerItem>('/api/accounting/ledgers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateAccountLedger: (id: string, data: UpdateAccountLedgerRequest) =>
    request<AccountLedgerItem>(`/api/accounting/ledgers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  toggleAccountLedgerStatus: (id: string, isActive: boolean) =>
    request<{ success: boolean }>(`/api/accounting/ledgers/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    }),

  // Double-Entry Journals
  getJournals: (params?: {
    status?: JournalStatus;
    fromDate?: string;
    toDate?: string;
    ledgerId?: string;
    search?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    if (params?.ledgerId) searchParams.append('ledgerId', params.ledgerId);
    if (params?.search) searchParams.append('search', params.search);
    const qs = searchParams.toString();
    return request<JournalEntryItem[]>(`/api/accounting/journals${qs ? `?${qs}` : ''}`);
  },
  getJournal: (id: string) => request<JournalEntryItem>(`/api/accounting/journals/${id}`),
  createJournal: (data: CreateJournalEntryRequest) =>
    request<JournalEntryItem>('/api/accounting/journals', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  postJournal: (id: string) =>
    request<JournalEntryItem>(`/api/accounting/journals/${id}/post`, {
      method: 'POST',
    }),
  reverseJournal: (id: string, reason: string) =>
    request<{ original: JournalEntryItem; reversal: JournalEntryItem }>(
      `/api/accounting/journals/${id}/reverse`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }
    ),

  // Contra Entries (Cash & Bank Internal Transfers)
  getContraEntries: (params?: {
    status?: JournalStatus;
    fromDate?: string;
    toDate?: string;
    search?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    if (params?.search) searchParams.append('search', params.search);
    const qs = searchParams.toString();
    return request<ContraEntryItem[]>(`/api/accounting/contra${qs ? `?${qs}` : ''}`);
  },
  getContraEntry: (id: string) => request<ContraEntryItem>(`/api/accounting/contra/${id}`),
  createContraEntry: (data: CreateContraEntryRequest) =>
    request<ContraEntryItem>('/api/accounting/contra', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  postContraEntry: (id: string) =>
    request<ContraEntryItem>(`/api/accounting/contra/${id}/post`, {
      method: 'POST',
    }),
  reverseContraEntry: (id: string, reason: string) =>
    request<{ original: ContraEntryItem; reversal: ContraEntryItem }>(
      `/api/accounting/contra/${id}/reverse`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }
    ),

  // Opening Balance Validation & Reports
  validateOpeningBalances: () =>
    request<OpeningBalanceValidationResult>('/api/accounting/opening-balances/validate'),
  getLedgerStatement: (ledgerId: string, params?: { fromDate?: string; toDate?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    const qs = searchParams.toString();
    return request<LedgerStatementReport>(
      `/api/accounting/reports/ledger-statement/${ledgerId}${qs ? `?${qs}` : ''}`
    );
  },
  getTrialBalance: (params?: { fromDate?: string; toDate?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    const qs = searchParams.toString();
    return request<TrialBalanceReport>(
      `/api/accounting/reports/trial-balance${qs ? `?${qs}` : ''}`
    );
  },
  getProfitAndLoss: (params?: { fromDate?: string; toDate?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    const qs = searchParams.toString();
    return request<ProfitAndLossReport>(
      `/api/accounting/reports/profit-and-loss${qs ? `?${qs}` : ''}`
    );
  },
  getBalanceSheet: (params?: { asOfDate?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.asOfDate) searchParams.append('asOfDate', params.asOfDate);
    const qs = searchParams.toString();
    return request<BalanceSheetReport>(
      `/api/accounting/reports/balance-sheet${qs ? `?${qs}` : ''}`
    );
  },
  getCashBook: (params?: { ledgerId?: string; fromDate?: string; toDate?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.ledgerId) searchParams.append('ledgerId', params.ledgerId);
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    const qs = searchParams.toString();
    return request<CashBankBookReport>(
      `/api/accounting/reports/cash-book${qs ? `?${qs}` : ''}`
    );
  },
  getBankBook: (params?: { ledgerId?: string; fromDate?: string; toDate?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.ledgerId) searchParams.append('ledgerId', params.ledgerId);
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    const qs = searchParams.toString();
    return request<CashBankBookReport>(
      `/api/accounting/reports/bank-book${qs ? `?${qs}` : ''}`
    );
  },

  // ==========================================
  // Phase 5: Customers, Quotations, Invoices & Receipts
  // ==========================================

  // Customers
  getCustomers: (params?: { search?: string; isActive?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.append('search', params.search);
    if (params?.isActive !== undefined) searchParams.append('isActive', String(params.isActive));
    const qs = searchParams.toString();
    return request<CustomerItem[]>(`/api/customers${qs ? `?${qs}` : ''}`);
  },
  getCustomer: (id: string) => request<CustomerItem>(`/api/customers/${id}`),
  createCustomer: (data: CreateCustomerRequest) =>
    request<CustomerItem>('/api/customers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateCustomer: (id: string, data: UpdateCustomerRequest) =>
    request<CustomerItem>(`/api/customers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Quotations
  getQuotations: (params?: {
    status?: QuotationStatus;
    customerId?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.customerId) searchParams.append('customerId', params.customerId);
    if (params?.search) searchParams.append('search', params.search);
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    const qs = searchParams.toString();
    return request<QuotationItem[]>(`/api/quotations${qs ? `?${qs}` : ''}`);
  },
  getQuotation: (id: string) => request<QuotationItem>(`/api/quotations/${id}`),
  createQuotation: (data: CreateQuotationRequest) =>
    request<QuotationItem>('/api/quotations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateQuotation: (id: string, data: UpdateQuotationRequest) =>
    request<QuotationItem>(`/api/quotations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  updateQuotationStatus: (id: string, status: QuotationStatus) =>
    request<QuotationItem>(`/api/quotations/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  convertQuotationToInvoice: (id: string) =>
    request<InvoiceItem>(`/api/quotations/${id}/convert-to-invoice`, {
      method: 'POST',
    }),

  // Invoices & Billing
  getInvoices: (params?: {
    status?: InvoiceStatus;
    customerId?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.customerId) searchParams.append('customerId', params.customerId);
    if (params?.search) searchParams.append('search', params.search);
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    const qs = searchParams.toString();
    return request<InvoiceItem[]>(`/api/invoices${qs ? `?${qs}` : ''}`);
  },
  getInvoice: (id: string) => request<InvoiceItem>(`/api/invoices/${id}`),
  createInvoice: (data: CreateInvoiceRequest) =>
    request<InvoiceItem>('/api/invoices', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  issueInvoice: (id: string, data?: IssueInvoiceRequest) =>
    request<InvoiceItem>(`/api/invoices/${id}/issue`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),
  voidInvoice: (id: string, reason: string) =>
    request<InvoiceItem>(`/api/invoices/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // Customer Receipts
  getReceipts: (params?: {
    customerId?: string;
    status?: ReceiptStatus;
    fromDate?: string;
    toDate?: string;
    search?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.customerId) searchParams.append('customerId', params.customerId);
    if (params?.status) searchParams.append('status', params.status);
    if (params?.fromDate) searchParams.append('fromDate', params.fromDate);
    if (params?.toDate) searchParams.append('toDate', params.toDate);
    if (params?.search) searchParams.append('search', params.search);
    const qs = searchParams.toString();
    return request<CustomerReceiptItem[]>(`/api/receipts${qs ? `?${qs}` : ''}`);
  },
  getReceipt: (id: string) => request<CustomerReceiptItem>(`/api/receipts/${id}`),
  createReceipt: (data: CreateCustomerReceiptRequest) =>
    request<CustomerReceiptItem>('/api/receipts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  voidReceipt: (id: string, reason: string) =>
    request<CustomerReceiptItem>(`/api/receipts/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // Departments (Phase 6)
  getDepartments: (includeInactive = false) =>
    request<DepartmentItem[]>(`/api/departments${includeInactive ? '?includeInactive=true' : ''}`),
  getDepartment: (id: string) => request<DepartmentItem>(`/api/departments/${id}`),
  createDepartment: (data: CreateDepartmentRequest) =>
    request<DepartmentItem>('/api/departments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateDepartment: (id: string, data: UpdateDepartmentRequest) =>
    request<DepartmentItem>(`/api/departments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deactivateDepartment: (id: string) =>
    request<DepartmentItem>(`/api/departments/${id}/deactivate`, {
      method: 'POST',
    }),

  // Designations (Phase 6)
  getDesignations: (includeInactive = false) =>
    request<DesignationItem[]>(`/api/designations${includeInactive ? '?includeInactive=true' : ''}`),
  getDesignation: (id: string) => request<DesignationItem>(`/api/designations/${id}`),
  createDesignation: (data: CreateDesignationRequest) =>
    request<DesignationItem>('/api/designations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateDesignation: (id: string, data: UpdateDesignationRequest) =>
    request<DesignationItem>(`/api/designations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deactivateDesignation: (id: string) =>
    request<DesignationItem>(`/api/designations/${id}/deactivate`, {
      method: 'POST',
    }),

  // Employees (Phase 6)
  getEmployees: (params?: {
    departmentId?: string;
    designationId?: string;
    status?: EmployeeStatus;
    search?: string;
    fromJoiningDate?: string;
    toJoiningDate?: string;
    page?: number;
    limit?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.departmentId) searchParams.append('departmentId', params.departmentId);
    if (params?.designationId) searchParams.append('designationId', params.designationId);
    if (params?.status) searchParams.append('status', params.status);
    if (params?.search) searchParams.append('search', params.search);
    if (params?.fromJoiningDate) searchParams.append('fromJoiningDate', params.fromJoiningDate);
    if (params?.toJoiningDate) searchParams.append('toJoiningDate', params.toJoiningDate);
    if (params?.page) searchParams.append('page', params.page.toString());
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    const qs = searchParams.toString();
    return request<{ items: EmployeeItem[]; total: number; page: number; limit: number }>(
      `/api/employees${qs ? `?${qs}` : ''}`
    );
  },
  getEmployee: (id: string) => request<EmployeeItem>(`/api/employees/${id}`),
  getEmployeeSelf: () => request<EmployeeItem>('/api/employees/self'),
  createEmployee: (data: CreateEmployeeRequest) =>
    request<EmployeeItem>('/api/employees', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateEmployee: (id: string, data: UpdateEmployeeRequest) =>
    request<EmployeeItem>(`/api/employees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deactivateEmployee: (id: string) =>
    request<EmployeeItem>(`/api/employees/${id}/deactivate`, {
      method: 'POST',
    }),
  createEmployeeLogin: (id: string, data: CreateEmployeeLoginRequest) =>
    request<EmployeeItem>(`/api/employees/${id}/login`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  toggleEmployeeLoginStatus: (id: string, isActive: boolean) =>
    request<EmployeeItem>(`/api/employees/${id}/login/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    }),
  linkEmployeeLedger: (id: string, data: LinkEmployeeLedgerRequest) =>
    request<EmployeeItem>(`/api/employees/${id}/ledger`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getEmployeeSalaries: (id: string) =>
    request<SalaryRevisionItem[]>(`/api/employees/${id}/salaries`),
  createSalaryRevision: (id: string, data: CreateSalaryRevisionRequest) =>
    request<SalaryRevisionItem>(`/api/employees/${id}/salaries`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // ==========================================
  // Phase 7.1 Shifts & Attendance
  // ==========================================
  getShifts: (includeInactive = false) =>
    request<ShiftItem[]>(`/api/shifts${includeInactive ? '?includeInactive=true' : ''}`),
  getShift: (id: string) => request<ShiftItem>(`/api/shifts/${id}`),
  createShift: (data: CreateShiftRequest) =>
    request<ShiftItem>('/api/shifts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateShift: (id: string, data: UpdateShiftRequest) =>
    request<ShiftItem>(`/api/shifts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deactivateShift: (id: string) =>
    request<ShiftItem>(`/api/shifts/${id}/deactivate`, {
      method: 'POST',
    }),

  getAttendance: (params?: {
    employeeId?: string;
    status?: AttendanceStatus;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.employeeId) searchParams.append('employeeId', params.employeeId);
    if (params?.status) searchParams.append('status', params.status);
    if (params?.startDate) searchParams.append('startDate', params.startDate);
    if (params?.endDate) searchParams.append('endDate', params.endDate);
    if (params?.page) searchParams.append('page', params.page.toString());
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    const qs = searchParams.toString();
    return request<{ items: AttendanceItem[]; total: number; page: number; limit: number }>(
      `/api/attendance${qs ? `?${qs}` : ''}`
    );
  },
  getAttendanceById: (id: string) => request<AttendanceItem>(`/api/attendance/${id}`),
  createAttendance: (data: CreateAttendanceRequest) =>
    request<AttendanceItem>('/api/attendance', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateAttendance: (id: string, data: UpdateAttendanceRequest) =>
    request<AttendanceItem>(`/api/attendance/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  getLogoutSummary: (employeeId?: string) =>
    request<WorkingHoursSummary>(`/api/attendance/logout-summary${employeeId ? `?employeeId=${employeeId}` : ''}`),
  getAdminNotifications: () =>
    request<{ items: AdminNotificationItem[]; total: number }>('/api/attendance/admin-notifications'),

  // ==========================================
  // Phase 7.2 Leave Management
  // ==========================================
  getLeaveTypes: (includeInactive = false) =>
    request<LeaveTypeItem[]>(`/api/leave/types${includeInactive ? '?includeInactive=true' : ''}`),
  getLeaveType: (id: string) => request<LeaveTypeItem>(`/api/leave/types/${id}`),
  createLeaveType: (data: CreateLeaveTypeRequest) =>
    request<LeaveTypeItem>('/api/leave/types', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateLeaveType: (id: string, data: UpdateLeaveTypeRequest) =>
    request<LeaveTypeItem>(`/api/leave/types/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deactivateLeaveType: (id: string) =>
    request<LeaveTypeItem>(`/api/leave/types/${id}/deactivate`, {
      method: 'POST',
    }),

  getLeaveSummary: (params?: { employeeId?: string; year?: number; month?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.employeeId) searchParams.append("employeeId", params.employeeId);
    if (params?.year) searchParams.append("year", params.year.toString());
    if (params?.month) searchParams.append("month", params.month.toString());
    const qs = searchParams.toString();
    return request<MonthlyLeaveSummary>(`/api/leave/summary${qs ? `?${qs}` : ""}`);
  },
  getLeaveRequests: (params?: {
    employeeId?: string;
    leaveTypeId?: string;
    status?: LeaveStatus;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.employeeId) searchParams.append('employeeId', params.employeeId);
    if (params?.leaveTypeId) searchParams.append('leaveTypeId', params.leaveTypeId);
    if (params?.status) searchParams.append('status', params.status);
    if (params?.startDate) searchParams.append('startDate', params.startDate);
    if (params?.endDate) searchParams.append('endDate', params.endDate);
    if (params?.page) searchParams.append('page', params.page.toString());
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    const qs = searchParams.toString();
    return request<{ items: LeaveRequestItem[]; total: number; page: number; limit: number }>(
      `/api/leave/requests${qs ? `?${qs}` : ''}`
    );
  },
  getLeaveRequest: (id: string) => request<LeaveRequestItem>(`/api/leave/requests/${id}`),
  submitLeaveRequest: (data: CreateLeaveRequestInput) =>
    request<LeaveRequestItem>('/api/leave/requests', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  approveLeaveRequest: (id: string) =>
    request<LeaveRequestItem>(`/api/leave/requests/${id}/approve`, {
      method: 'POST',
    }),
  rejectLeaveRequest: (id: string, data?: ReviewLeaveRequestInput) =>
    request<LeaveRequestItem>(`/api/leave/requests/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),

  // ==========================================
  // Phase 7.3 & 7.3B Payroll Management & Self-Service
  // ==========================================
  getPayrollPeriods: (params?: { year?: number; status?: PayrollStatus }) => {
    const searchParams = new URLSearchParams();
    if (params?.year) searchParams.append('year', params.year.toString());
    if (params?.status) searchParams.append('status', params.status);
    const qs = searchParams.toString();
    return request<PayrollPeriodItem[]>(`/api/payroll/periods${qs ? `?${qs}` : ''}`);
  },
  getPayrollPeriod: (id: string) => request<PayrollPeriodItem>(`/api/payroll/periods/${id}`),
  createPayrollPeriod: (data: CreatePayrollPeriodRequest) =>
    request<PayrollPeriodItem>('/api/payroll/periods', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  processPayrollPeriod: (id: string) =>
    request<PayrollPeriodItem>(`/api/payroll/periods/${id}/process`, {
      method: 'POST',
    }),
  postPayrollPeriod: (id: string, data?: PostPayrollRequest) =>
    request<PayrollPeriodItem>(`/api/payroll/periods/${id}/post`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),
  cancelPayrollPeriod: (id: string) =>
    request<PayrollPeriodItem>(`/api/payroll/periods/${id}/cancel`, {
      method: 'POST',
    }),
  getPeriodPayslips: (periodId: string, params?: { employeeId?: string; status?: PayslipStatus }) => {
    const searchParams = new URLSearchParams();
    if (params?.employeeId) searchParams.append('employeeId', params.employeeId);
    if (params?.status) searchParams.append('status', params.status);
    const qs = searchParams.toString();
    return request<PayslipItem[]>(`/api/payroll/periods/${periodId}/payslips${qs ? `?${qs}` : ''}`);
  },
  getPayslip: (id: string) => request<PayslipItem>(`/api/payroll/payslips/${id}`),
  getMyPayslips: (params?: { year?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.year) searchParams.append('year', params.year.toString());
    const qs = searchParams.toString();
    return request<PayslipItem[]>(`/api/payroll/my-payslips${qs ? `?${qs}` : ''}`);
  },

  // ==========================================
  // Phase 8.1 Biometric LAN Bridge & Terminals
  // ==========================================
  getBiometricDevices: (params?: { status?: BiometricTerminalStatus; includeInactive?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.includeInactive) searchParams.append('includeInactive', 'true');
    const qs = searchParams.toString();
    return request<BiometricTerminalItem[]>(`/api/biometric/devices${qs ? `?${qs}` : ''}`);
  },
  createBiometricTerminal: (data: CreateBiometricTerminalRequest) =>
    request<CreateBiometricTerminalResponse>('/api/biometric/devices', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deactivateBiometricDevice: (id: string) =>
    request<{ success: boolean; terminal: BiometricTerminalItem }>(`/api/biometric/devices/${id}/deactivate`, {
      method: 'POST',
    }),
  rotateBiometricDeviceKey: (id: string) =>
    request<{ success: boolean; terminal: BiometricTerminalItem; apiKey: string }>(`/api/biometric/devices/${id}/rotate-key`, {
      method: 'POST',
    }),
  sendTerminalHeartbeat: (apiKey: string, data?: TerminalHeartbeatRequest) =>
    request<TerminalHeartbeatResponse>('/api/biometric/heartbeat', {
      method: 'POST',
      headers: {
        'X-Device-Api-Key': apiKey,
      },
      body: JSON.stringify(data || {}),
    }),
  submitBiometricPunches: (apiKey: string, data: BatchPunchSubmissionRequest) =>
    request<BatchPunchSubmissionResponse>('/api/biometric/punches', {
      method: 'POST',
      headers: {
        'X-Device-Api-Key': apiKey,
      },
      body: JSON.stringify(data),
    }),

  // Phase 8.2 & 8.3 Biometric Punch Reconciliation & Sync
  getBiometricPunches: (params?: {
    syncStatus?: PunchSyncStatus;
    terminalId?: string;
    matchedEmployeeId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.syncStatus) searchParams.append('syncStatus', params.syncStatus);
    if (params?.terminalId) searchParams.append('terminalId', params.terminalId);
    if (params?.matchedEmployeeId) searchParams.append('matchedEmployeeId', params.matchedEmployeeId);
    if (params?.startDate) searchParams.append('startDate', params.startDate);
    if (params?.endDate) searchParams.append('endDate', params.endDate);
    if (params?.page) searchParams.append('page', params.page.toString());
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    const qs = searchParams.toString();
    return request<{ items: RawPunchLogItem[]; total: number; page: number; limit: number }>(
      `/api/biometric/punches${qs ? `?${qs}` : ''}`
    );
  },
  triggerBiometricSync: (data?: PunchReconciliationOptions) =>
    request<PunchReconciliationResponse>('/api/biometric/sync', {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),
  getBiometricSyncSummary: () =>
    request<PunchSyncSummaryResponse>('/api/biometric/sync/summary'),
};

