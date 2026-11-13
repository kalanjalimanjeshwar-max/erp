/**
 * Shared Type Definitions and API Contracts
 * Used across Frontend, Backend, and Test suites
 */

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'VICE_ADMIN' | 'EMPLOYEE';

export type AuditSeverity = 'INFO' | 'WARN' | 'CRITICAL';

export type FiscalPeriodStatus = 'OPEN' | 'CLOSED' | 'LOCKED';

export type AppModule =
  | 'COMPANY'
  | 'USER'
  | 'ROLE_PERMISSION'
  | 'AUDIT_LOG'
  | 'FISCAL_PERIOD'
  | 'CURRENCY'
  | 'ACCOUNTING'
  | 'QUOTATION'
  | 'CUSTOMER'
  | 'INVOICE'
  | 'RECEIPT'
  | 'EMPLOYEE'
  | 'DEPARTMENT'
  | 'DESIGNATION'
  | 'PAYROLL'
  | 'ATTENDANCE'
  | 'BIOMETRIC'
  | 'EXPENSE';

export type AppAction = 'VIEW' | 'CREATE' | 'EDIT' | 'APPROVE' | 'DEACTIVATE' | 'DELETE';

// Phase 4 Accounting Core Types
export type AccountRootType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type BalanceType = 'DEBIT' | 'CREDIT';
export type JournalStatus = 'DRAFT' | 'POSTED' | 'REVERSED';

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptimeSeconds: number;
  environment: string;
  version: string;
}

export interface DatabaseReadiness {
  status: 'connected' | 'disconnected' | 'unconfigured';
  database: 'PostgreSQL';
  latencyMs?: number;
  error?: string;
  category?:
    | 'authentication'
    | 'database_not_found'
    | 'network'
    | 'timeout'
    | 'ssl'
    | 'configuration'
    | 'query_failure'
    | 'unknown';
  code?: string;
  ssl?: boolean;
}

export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  timestamp: string;
  checks: {
    postgres: DatabaseReadiness;
    migrations?: {
      status: 'applied' | 'pending' | 'unknown';
    };
  };
  details?: string;
}

export interface SetupStatusResponse {
  isSetupRequired: boolean;
  hasCompany: boolean;
  hasSuperAdmin: boolean;
  databaseConnected: boolean;
  companyInfo?: {
    name: string;
    code: string;
    currency: string;
    timezone: string;
    logoUrl?: string | null;
  };
}

export interface InitialSetupRequest {
  company: {
    name: string;
    code: string;
    legalName?: string;
    taxId?: string;
    currency: string;
    timezone: string;
    logoUrl?: string;
    address?: string;
    phone?: string;
    email?: string;
    website?: string;
    appHeaderTitle?: string;
  };
  superAdmin: {
    email: string;
    fullName: string;
    password: string;
    confirmPassword: string;
  };
}

export interface InitialSetupResult {
  success: boolean;
  message: string;
  company: {
    id: string;
    name: string;
    code: string;
    currency: string;
  };
  superAdmin: {
    id: string;
    email: string;
    fullName: string;
    role: Role;
  };
}

export interface AuthUser {
  id: string;
  userId: string;
  companyId: string;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  lastLoginAt?: string | null;
  tokenVersion: number;
  isPreview?: boolean;
}

export interface CompanyBankDetails {
  accountHolderName: string;
  bankName: string;
  branch?: string | null;
  accountNumber: string;
  ifscCode?: string | null;
  swiftBicCode?: string | null;
  paymentInstructions?: string | null;
}

export type LogoSize = 'sm' | 'md' | 'lg';
export type LogoAlignment = 'left' | 'center' | 'right';

export interface DocumentBrandingSettings {
  logoSize: LogoSize;
  logoAlignment: LogoAlignment;
  signatureUrl?: string | null;
  signatureTitle?: string | null;
  signatoryName?: string | null;
  sealUrl?: string | null;
}

export interface BrandingAssetUploadResponse {
  assetUrl: string;
  assetType: 'logo' | 'signature' | 'seal';
  fileName: string;
  sizeBytes: number;
  mimeType: string;
}

export interface CompanyProfile {
  id: string;
  code: string;
  name: string;
  legalName?: string | null;
  taxId?: string | null;
  currency: string;
  timezone: string;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  appHeaderTitle?: string | null;
  bankDetails?: CompanyBankDetails | null;
  documentBranding?: DocumentBrandingSettings | null;
  signatureUrl?: string | null;
  sealUrl?: string | null;
  salesInvoiceEnabled?: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: AuthUser;
  company: CompanyProfile;
}

export interface PreviewLoginRequest {
  id: string;
  password: string;
}

export interface PreviewLoginResponse {
  isPreviewSession: true;
  user: AuthUser;
  company: CompanyProfile;
  message: string;
}

export interface UserListItem {
  id: string;
  companyId: string;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  lastLoginAt?: string | null;
  createdAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName?: string;
  } | null;
  isPreviewUser?: boolean;
  isDemoOnly?: boolean;
}

export interface CreateUserRequest {
  email: string;
  fullName: string;
  password: string;
  role: Role;
  isActive?: boolean;
  employeeId?: string;
}

export interface UpdateUserRoleRequest {
  role: Role;
}

export interface UpdateUserStatusRequest {
  isActive: boolean;
}

export interface ResetUserPasswordRequest {
  newPassword: string;
}

export interface UpdateCompanyProfileRequest {
  name: string;
  legalName?: string | null;
  taxId?: string | null;
  timezone: string;
  currency: string;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  appHeaderTitle?: string | null;
  salesInvoiceEnabled?: boolean;
}

export interface RolePermissionRule {
  id?: string;
  companyId: string;
  role: Role;
  module: AppModule;
  action: AppAction;
  isGranted: boolean;
}

export interface CurrencyConfigData {
  id: string;
  companyId: string;
  currencyCode: string;
  exchangeRate: string;
  roundingPrecision: number;
  isBaseCurrency: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FiscalPeriodData {
  id: string;
  companyId: string;
  periodName: string;
  fiscalYear: number;
  periodNumber: number;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  status: FiscalPeriodStatus;
  isLocked: boolean;
  closedAt?: string | null;
  closedByUserId?: string | null;
}

export interface AuditLogData {
  id: string;
  companyId?: string | null;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  severity: AuditSeverity;
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: string | null;
  createdAt: string;
  user?: {
    id: string;
    email: string;
    fullName: string;
    role: Role;
  } | null;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    timestamp: string;
  };
}

// ==========================================
// Phase 4 Accounting Specific Types
// ==========================================

export interface AccountGroupItem {
  id: string;
  companyId: string;
  code: string;
  name: string;
  rootType: AccountRootType;
  parentGroupId?: string | null;
  parentGroupName?: string | null;
  isSystem: boolean;
  createdAt: string;
}

export interface CreateAccountGroupRequest {
  code: string;
  name: string;
  rootType: AccountRootType;
  parentGroupId?: string | null;
}

export interface AccountLedgerItem {
  id: string;
  companyId: string;
  groupId: string;
  groupName?: string;
  rootType?: AccountRootType;
  code?: string | null;
  name: string;
  description?: string | null;
  currency: string;
  isActive: boolean;
  openingBalance: string;
  openingBalanceType: BalanceType;
  employeeId?: string | null;
  currentBalance?: string;
  currentBalanceType?: BalanceType;
  createdAt: string;
}

export interface CreateAccountLedgerRequest {
  groupId: string;
  code?: string | null;
  name: string;
  description?: string | null;
  currency?: string;
  openingBalance?: string;
  openingBalanceType?: BalanceType;
  employeeId?: string | null;
}

export interface UpdateAccountLedgerRequest {
  groupId?: string;
  code?: string | null;
  name?: string;
  description?: string | null;
  currency?: string;
  openingBalance?: string;
  openingBalanceType?: BalanceType;
}

export interface JournalLineItem {
  id?: string;
  ledgerId: string;
  ledgerCode?: string | null;
  ledgerName?: string;
  lineNumber: number;
  debit: string;
  credit: string;
  description?: string | null;
}

export interface JournalEntryItem {
  id: string;
  companyId: string;
  voucherNumber: string;
  idempotencyKey?: string | null;
  entryDate: string; // YYYY-MM-DD
  fiscalPeriodId?: string | null;
  narration: string;
  reference?: string | null;
  status: JournalStatus;
  totalDebit: string;
  totalCredit: string;
  postedAt?: string | null;
  postedByUserName?: string | null;
  reversedAt?: string | null;
  reversedByUserName?: string | null;
  reversalOfId?: string | null;
  createdByUserName?: string;
  createdAt: string;
  lines: JournalLineItem[];
}

export interface CreateJournalEntryRequest {
  entryDate: string; // YYYY-MM-DD
  fiscalPeriodId?: string | null;
  narration: string;
  reference?: string | null;
  idempotencyKey?: string | null;
  lines: Array<{
    ledgerId: string;
    debit: string;
    credit: string;
    description?: string | null;
  }>;
  autoPost?: boolean;
}

// ==========================================
// Phase 4.1 Contra Entry Specific Types
// ==========================================

export type ContraTransferType =
  | 'CASH_TO_BANK'
  | 'BANK_TO_CASH'
  | 'BANK_TO_BANK'
  | 'CASH_TO_CASH'
  | 'INTERNAL_TRANSFER';

export interface ContraEntryItem {
  id: string;
  companyId: string;
  voucherNumber: string; // CV-YYYY-XXXX
  idempotencyKey?: string | null;
  entryDate: string; // YYYY-MM-DD
  fiscalPeriodId?: string | null;
  contraType: ContraTransferType;
  sourceLedgerId: string;
  sourceLedgerName: string;
  sourceLedgerCode?: string | null;
  destinationLedgerId: string;
  destinationLedgerName: string;
  destinationLedgerCode?: string | null;
  amount: string; // formatted Decimal(18, 4)
  totalDebit?: string;
  totalCredit?: string;
  reference?: string | null;
  narration: string;
  status: JournalStatus; // DRAFT | POSTED | REVERSED
  postedAt?: string | null;
  postedByUserName?: string | null;
  reversedAt?: string | null;
  reversedByUserName?: string | null;
  reversalOfId?: string | null;
  createdByUserName?: string | null;
  createdAt: string;
  lines: JournalLineItem[];
}

export interface CreateContraEntryRequest {
  entryDate: string; // YYYY-MM-DD
  sourceLedgerId: string;
  destinationLedgerId: string;
  amount: string;
  contraType?: ContraTransferType;
  reference?: string | null;
  narration?: string | null;
  fiscalPeriodId?: string | null;
  autoPost?: boolean;
  idempotencyKey?: string | null;
}

export interface TrialBalanceRow {
  ledgerId: string;
  code: string;
  name: string;
  rootType: AccountRootType;
  groupName: string;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceReport {
  companyId: string;
  fromDate: string;
  toDate: string;
  rows: TrialBalanceRow[];
  totalOpeningDebit: string;
  totalOpeningCredit: string;
  totalPeriodDebit: string;
  totalPeriodCredit: string;
  totalClosingDebit: string;
  totalClosingCredit: string;
  isBalanced: boolean;
  reconciliationStatus: 'BALANCED' | 'DISCREPANCY';
  imbalanceAmount: string;
}

export interface LedgerStatementLine {
  journalId: string;
  voucherNumber: string;
  entryDate: string;
  narration: string;
  reference?: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
  runningBalanceType: BalanceType;
}

export interface LedgerStatementReport {
  ledger: AccountLedgerItem;
  fromDate: string;
  toDate: string;
  openingBalance: string;
  openingBalanceType: BalanceType;
  lines: LedgerStatementLine[];
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  closingBalanceType: BalanceType;
}

export interface ProfitAndLossReport {
  companyId: string;
  fromDate: string;
  toDate: string;
  incomeGroups: Array<{
    groupName: string;
    ledgers: Array<{ name: string; code?: string | null; amount: string }>;
    subtotal: string;
  }>;
  totalIncome: string;
  expenseGroups: Array<{
    groupName: string;
    ledgers: Array<{ name: string; code?: string | null; amount: string }>;
    subtotal: string;
  }>;
  totalExpense: string;
  netProfit: string;
  isProfitable: boolean;
}

export interface BalanceSheetReport {
  companyId: string;
  asOfDate: string;
  assetGroups: Array<{
    groupName: string;
    ledgers: Array<{ name: string; code?: string | null; amount: string }>;
    subtotal: string;
  }>;
  totalAssets: string;
  liabilityGroups: Array<{
    groupName: string;
    ledgers: Array<{ name: string; code?: string | null; amount: string }>;
    subtotal: string;
  }>;
  totalLiabilities: string;
  equityGroups: Array<{
    groupName: string;
    ledgers: Array<{ name: string; code?: string | null; amount: string }>;
    subtotal: string;
  }>;
  currentPeriodProfit: string;
  totalEquity: string;
  totalLiabilitiesAndEquity: string;
  isBalanced: boolean;
  discrepancy: string;
}

export interface OpeningBalanceValidationResult {
  isBalanced: boolean;
  totalOpeningDebit: string;
  totalOpeningCredit: string;
  discrepancy: string;
  unbalancedLedgersCount: number;
}

// ==========================================
// Phase 4.2 Cash Book & Bank Book Types
// ==========================================

export type CashBankBookType = 'CASH' | 'BANK';

export interface CashBankBookLine {
  id?: string;
  journalId: string;
  voucherNumber: string;
  entryDate: string; // YYYY-MM-DD
  reference?: string | null;
  narration: string;
  counterpartyAccount: string;
  counterpartyLedgerId?: string | null;
  debit: string; // Receipts (Cash Book) or Deposits (Bank Book)
  credit: string; // Payments (Cash Book) or Withdrawals (Bank Book)
  runningBalance: string;
  runningBalanceType: BalanceType;
}

export interface CashBankBookEligibleLedger {
  id: string;
  name: string;
  code: string | null;
  currency: string;
  category: 'CASH' | 'BANK';
  currentBalance?: string;
  currentBalanceType?: BalanceType;
}

export interface CashBankBookReport {
  companyId: string;
  bookType: CashBankBookType;
  ledger: AccountLedgerItem | null;
  eligibleLedgers: CashBankBookEligibleLedger[];
  fromDate: string;
  toDate: string;
  openingBalance: string;
  openingBalanceType: BalanceType;
  lines: CashBankBookLine[];
  totalDebit: string; // Total Receipts / Total Deposits
  totalCredit: string; // Total Payments / Total Withdrawals
  closingBalance: string;
  closingBalanceType: BalanceType;
}

// ==========================================
// Phase 5: Billing, Quotations & Receipts Types
// ==========================================

export type QuotationStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID';
export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'CREDIT_CARD' | 'OTHER';
export type ReceiptStatus = 'POSTED' | 'VOID';

export interface CustomerItem {
  id: string;
  companyId: string;
  code: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxId: string | null;
  currency: string;
  paymentTermsDays: number;
  receivableLedgerId: string | null;
  receivableLedgerName?: string | null;
  isActive: boolean;
  createdAt: string;
  totalInvoiced?: string;
  totalPaid?: string;
  balanceDue?: string;
}

export interface CreateCustomerRequest {
  code: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  taxId?: string | null;
  paymentTermsDays?: number;
  receivableLedgerId?: string | null;
}

export interface UpdateCustomerRequest {
  code?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  taxId?: string | null;
  paymentTermsDays?: number;
  receivableLedgerId?: string | null;
  isActive?: boolean;
}

export interface QuotationLineItem {
  id?: string;
  lineNumber: number;
  itemDescription: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
}

export interface QuotationItem {
  id: string;
  companyId: string;
  quotationNumber: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  quotationDate: string; // YYYY-MM-DD
  validUntilDate: string; // YYYY-MM-DD
  status: QuotationStatus;
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  notes: string | null;
  terms: string | null;
  documentTitle: string | null;
  convertedToInvoiceId: string | null;
  createdByUserName?: string | null;
  createdAt: string;
  lines: QuotationLineItem[];
}

export interface CreateQuotationRequest {
  customerId?: string | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  quotationDate: string; // YYYY-MM-DD
  validUntilDate: string; // YYYY-MM-DD
  notes?: string | null;
  terms?: string | null;
  documentTitle?: string | null;
  lines: Array<{
    itemDescription: string;
    quantity: string | number;
    unitPrice: string | number;
    discountAmount?: string | number;
    taxRate?: string | number;
  }>;
}

export interface UpdateQuotationRequest {
  customerId?: string | null;
  customerName?: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  quotationDate?: string;
  validUntilDate?: string;
  notes?: string | null;
  terms?: string | null;
  documentTitle?: string | null;
  status?: QuotationStatus;
  lines?: Array<{
    itemDescription: string;
    quantity: string | number;
    unitPrice: string | number;
    discountAmount?: string | number;
    taxRate?: string | number;
  }>;
}

export interface InvoiceLineItem {
  id?: string;
  lineNumber: number;
  itemDescription: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  revenueLedgerId?: string | null;
  revenueLedgerName?: string | null;
}

export interface InvoiceItem {
  id: string;
  companyId: string;
  invoiceNumber: string;
  quotationId: string | null;
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  customerTaxId: string | null;
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string;     // YYYY-MM-DD
  status: InvoiceStatus;
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  notes: string | null;
  terms: string | null;
  documentTitle: string | null;
  journalEntryId: string | null;
  journalVoucherNumber?: string | null;
  issuedAt: string | null;
  issuedByUserName?: string | null;
  voidedAt: string | null;
  voidedByUserName?: string | null;
  voidReason: string | null;
  createdByUserName?: string | null;
  createdAt: string;
  lines: InvoiceLineItem[];
  allocations?: Array<{
    receiptId: string;
    receiptNumber: string;
    receiptDate: string;
    allocatedAmount: string;
  }>;
}

export interface CreateInvoiceRequest {
  quotationId?: string | null;
  customerId?: string | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  customerTaxId?: string | null;
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string;     // YYYY-MM-DD
  notes?: string | null;
  terms?: string | null;
  documentTitle?: string | null;
  lines: Array<{
    itemDescription: string;
    quantity: string | number;
    unitPrice: string | number;
    discountAmount?: string | number;
    taxRate?: string | number;
    revenueLedgerId?: string | null;
  }>;
}

export interface UpdateInvoiceRequest {
  customerId?: string | null;
  customerName?: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  customerTaxId?: string | null;
  invoiceDate?: string;
  dueDate?: string;
  notes?: string | null;
  terms?: string | null;
  documentTitle?: string | null;
  lines?: Array<{
    itemDescription: string;
    quantity: string | number;
    unitPrice: string | number;
    discountAmount?: string | number;
    taxRate?: string | number;
    revenueLedgerId?: string | null;
  }>;
}

export interface IssueInvoiceRequest {
  receivablesLedgerId?: string;
  revenueLedgerId?: string;
  taxPayableLedgerId?: string;
  idempotencyKey?: string;
}

export interface ReceiptAllocationItem {
  id: string;
  receiptId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceTotal: string;
  allocatedAmount: string;
}

export interface CustomerReceiptItem {
  id: string;
  companyId: string;
  receiptNumber: string;
  receiptDate: string; // YYYY-MM-DD
  customerId: string;
  customerName: string;
  amount: string;
  allocatedTotal: string;
  unallocatedAmount: string;
  paymentMethod: PaymentMethod;
  referenceNumber: string | null;
  receivingLedgerId: string;
  receivingLedgerName?: string | null;
  receivableLedgerId: string;
  receivableLedgerName?: string | null;
  journalEntryId: string | null;
  journalVoucherNumber?: string | null;
  status: ReceiptStatus;
  notes: string | null;
  voidedAt: string | null;
  voidedByUserName?: string | null;
  voidReason: string | null;
  createdByUserName?: string | null;
  createdAt: string;
  allocations: ReceiptAllocationItem[];
}

export interface CreateCustomerReceiptRequest {
  receiptDate: string; // YYYY-MM-DD
  customerId: string;
  amount: string | number;
  paymentMethod: PaymentMethod;
  referenceNumber?: string | null;
  receivingLedgerId: string; // Cash / Bank Account Ledger
  receivableLedgerId?: string; // Optional: derived or default
  notes?: string | null;
  idempotencyKey?: string;
  allocations: Array<{
    invoiceId: string;
    amount: string | number;
  }>;
}

// ============================================================================
// PHASE 6: EMPLOYEE MANAGEMENT, DEPARTMENTS, DESIGNATIONS & SALARY STRUCTURE
// ============================================================================

export type EmployeeStatus = 'ACTIVE' | 'INACTIVE' | 'EXITED';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERN';

export interface DepartmentItem {
  id: string;
  companyId: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  employeeCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDepartmentRequest {
  code: string;
  name: string;
  description?: string | null;
}

export interface UpdateDepartmentRequest {
  code?: string;
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

export interface DesignationItem {
  id: string;
  companyId: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  employeeCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDesignationRequest {
  code: string;
  name: string;
  description?: string | null;
}

export interface UpdateDesignationRequest {
  code?: string;
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

export interface SalaryRevisionItem {
  id: string;
  companyId: string;
  employeeId: string;
  fixedSalary: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD
  revisionReason: string | null;
  notes: string | null;
  createdByUserId: string;
  createdByUserName?: string | null;
  createdAt: string;
}

export interface CreateSalaryRevisionRequest {
  fixedSalary: string | number;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo?: string | null; // YYYY-MM-DD
  revisionReason?: string | null;
  notes?: string | null;
}

export interface EmployeeItem {
  id: string;
  companyId: string;
  employeeCode: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  photoUrl: string | null;
  dateOfBirth: string | null; // YYYY-MM-DD
  dateOfJoining: string; // YYYY-MM-DD
  departmentId: string | null;
  departmentName?: string | null;
  designationId: string | null;
  designationName?: string | null;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  notes: string | null;
  biometricDeviceId: string | null;
  userId: string | null;
  userEmail?: string | null;
  userActive?: boolean;
  ledgerId: string | null;
  ledgerCode?: string | null;
  ledgerName?: string | null;
  currentSalary?: string | null;
  salaryRevisionsCount?: number;
  shiftId?: string | null;
  shiftName?: string | null;
  shiftStartTime?: string | null;
  shiftEndTime?: string | null;
  shiftIsOvernight?: boolean | null;
  configuredDailyWorkingHours?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEmployeeRequest {
  employeeCode: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  photoUrl?: string | null;
  dateOfBirth?: string | null;
  dateOfJoining: string;
  departmentId?: string | null;
  designationId?: string | null;
  employmentType?: EmploymentType;
  notes?: string | null;
  biometricDeviceId?: string | null;
  initialSalary?: string | number;
  shiftId?: string | null;
}

export interface UpdateEmployeeRequest {
  employeeCode?: string;
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  photoUrl?: string | null;
  dateOfBirth?: string | null;
  dateOfJoining?: string;
  departmentId?: string | null;
  designationId?: string | null;
  employmentType?: EmploymentType;
  status?: EmployeeStatus;
  notes?: string | null;
  biometricDeviceId?: string | null;
  shiftId?: string | null;
}

export interface CreateEmployeeLoginRequest {
  email: string;
  password: string;
  role?: Role;
}

export interface LinkEmployeeLedgerRequest {
  ledgerId?: string; // Link existing ledger
  createLedger?: boolean; // Or automatically create ledger under Payroll/Employee group
  groupId?: string; // If creating new, optional group ID
}

// ============================================================================
// PHASE 7: ATTENDANCE, SHIFTS, LEAVE MANAGEMENT & PAYROLL TYPES
// ============================================================================

export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'HALF_DAY' | 'LATE' | 'ON_LEAVE';
export type AttendanceSource = 'MANUAL' | 'BIOMETRIC';
export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type PayrollStatus = 'DRAFT' | 'PROCESSED' | 'ACCOUNTS_APPROVED' | 'POSTED' | 'CANCELLED';
export type PayslipStatus = 'DRAFT' | 'APPROVED' | 'PAID' | 'CANCELLED';

// Shift Types
export interface ShiftItem {
  id: string;
  companyId: string;
  code: string;
  name: string;
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
  isOvernight: boolean;
  graceMinutes: number;
  halfDayMinutes: number;
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateShiftRequest {
  code: string;
  name: string;
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
  isOvernight?: boolean;
  graceMinutes?: number;
  halfDayMinutes?: number;
  description?: string | null;
}

export interface UpdateShiftRequest {
  code?: string;
  name?: string;
  startTime?: string;
  endTime?: string;
  isOvernight?: boolean;
  graceMinutes?: number;
  halfDayMinutes?: number;
  description?: string | null;
  isActive?: boolean;
}

// Attendance Types
export interface AttendanceItem {
  id: string;
  companyId: string;
  employeeId: string;
  employeeCode?: string;
  employeeName?: string;
  shiftId: string | null;
  shiftName?: string | null;
  workDate: string; // YYYY-MM-DD
  checkIn: string | null; // ISO
  checkOut: string | null; // ISO
  status: AttendanceStatus;
  lateMinutes: number;
  overtimeMinutes: number;
  source: AttendanceSource;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAttendanceRequest {
  employeeId: string;
  workDate: string; // YYYY-MM-DD
  checkIn?: string | null;
  checkOut?: string | null;
  shiftId?: string | null;
  status?: AttendanceStatus;
  source?: AttendanceSource;
  notes?: string | null;
}

export interface UpdateAttendanceRequest {
  checkIn?: string | null;
  checkOut?: string | null;
  shiftId?: string | null;
  status?: AttendanceStatus;
  notes?: string | null;
}

// Leave Types
export interface LeaveTypeItem {
  id: string;
  companyId: string;
  code: string;
  name: string;
  description: string | null;
  isPaid: boolean;
  defaultAllowance: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLeaveTypeRequest {
  code: string;
  name: string;
  description?: string | null;
  isPaid?: boolean;
  defaultAllowance?: number;
}

export interface UpdateLeaveTypeRequest {
  code?: string;
  name?: string;
  description?: string | null;
  isPaid?: boolean;
  defaultAllowance?: number;
  isActive?: boolean;
}

// Leave Request Types
export interface LeaveRequestItem {
  id: string;
  companyId: string;
  employeeId: string;
  employeeCode?: string;
  employeeName?: string;
  leaveTypeId: string;
  leaveTypeCode?: string;
  leaveTypeName?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  totalDays: number;
  reason: string | null;
  status: LeaveStatus;
  reviewedByUserId: string | null;
  reviewedByUserName?: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLeaveRequestInput {
  employeeId?: string;
  leaveTypeId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  totalDays?: number;
  reason?: string | null;
}

export interface ReviewLeaveRequestInput {
  rejectionReason?: string;
}

export interface MonthlyLeaveSummaryByType {
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  isPaid: boolean;
  annualAllowance: number;
  monthRequestedDays: number;
  monthApprovedDays: number;
  monthPendingDays: number;
  annualUsedDays: number;
  annualRemainingDays: number;
}

export interface MonthlyLeaveSummary {
  year: number;
  month: number;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  totalRequestedDays: number;
  approvedDays: number;
  pendingDays: number;
  rejectedDays: number;
  rejectedCount: number;
  pendingCount: number;
  approvedCount: number;
  totalAnnualEntitlement: number;
  annualUsedDays: number;
  annualRemainingBalance: number;
  excessLeaveDays: number;
  monthlyLeaveAllowance: number;
  monthApprovedDays: number;
  monthRemainingLeave: number;
  monthlyExcessLeaveDays: number;
  monthlySalary: string | null;
  dailySalaryRate: string | null;
  hourlySalaryRate: string | null;
  configuredDailyWorkingHours: number | null;
  shiftSchedule: string | null;
  deductibleShortHours: number;
  incompleteAttendanceCount: number;
  excessLeaveDeduction: string;
  shortHoursDeduction: string;
  totalSalaryDeductions: string;
  overlappingApprovedDays?: number;
  warnings?: string[];
  byType: MonthlyLeaveSummaryByType[];
}

// ============================================================================
// PHASE 7.3: PAYROLL BACKEND & CALCULATION ENGINE TYPES
// ============================================================================

export interface PayrollPeriodItem {
  id: string;
  companyId: string;
  month: number;
  year: number;
  name: string | null;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  status: PayrollStatus;
  processedAt: string | null;
  accountsApprovedAt?: string | null;
  accountsApprovedByUserId?: string | null;
  accountsApprovedByUserName?: string | null;
  accountsApprovalNotes?: string | null;
  adminApprovedAt?: string | null;
  adminApprovedByUserId?: string | null;
  adminApprovedByUserName?: string | null;
  postedAt: string | null;
  createdByUserId: string;
  createdByUserName?: string | null;
  totalGross?: string;
  totalDeductions?: string;
  totalNet?: string;
  payslipsCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovePayrollAccountsRequest {
  notes?: string | null;
}

export interface CreatePayrollPeriodRequest {
  month: number; // 1-12
  year: number;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  name?: string | null;
}

export interface PayslipItem {
  id: string;
  companyId: string;
  payrollPeriodId: string;
  payrollPeriodName?: string | null;
  payrollPeriodMonth?: number;
  payrollPeriodYear?: number;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  basicSalary: string;
  allowances: string;
  overtimePay: string;
  grossSalary: string;
  deductions: string;
  lossOfPayDeduction: string;
  netSalary: string;
  status: PayslipStatus;
  paymentMethod: string | null;
  paymentDate: string | null;
  ledgerId: string | null;
  ledgerName?: string | null;
  journalEntryId: string | null;
  journalVoucherNumber?: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessPayrollRequest {
  employeeIds?: string[];
}

export interface PostPayrollRequest {
  payrollExpenseLedgerId?: string;
  payrollPayableLedgerId?: string;
  deductionsLedgerId?: string;
}

// ============================================================================
// PHASE 8: BIOMETRIC HARDWARE LAN BRIDGE & AUDITABLE PUNCH INGESTION
// ============================================================================

export type BiometricTerminalStatus = 'ONLINE' | 'OFFLINE' | 'ERROR' | 'DEACTIVATED';
export type BiometricVerifyType = 'FINGERPRINT' | 'CARD' | 'PASSWORD' | 'FACE';
export type PunchInOutMode = 'CHECK_IN' | 'CHECK_OUT' | 'BREAK_OUT' | 'BREAK_IN';
export type PunchSyncStatus = 'PENDING' | 'PROCESSED' | 'IGNORED' | 'ERROR';

export interface BiometricTerminalItem {
  id: string;
  companyId: string;
  deviceSerialNumber: string;
  name: string;
  terminalModel: string;
  ipAddress: string | null;
  port: number;
  location: string | null;
  apiKeyPrefix: string;
  status: BiometricTerminalStatus;
  lastHeartbeatAt: string | null;
  lastSyncAt: string | null;
  firmwareVersion: string | null;
  registeredByUserId: string;
  registeredByUserName?: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBiometricTerminalRequest {
  deviceSerialNumber: string;
  name: string;
  terminalModel?: string;
  ipAddress?: string | null;
  port?: number;
  location?: string | null;
  notes?: string | null;
}

export interface CreateBiometricTerminalResponse {
  terminal: BiometricTerminalItem;
  apiKey: string; // Plaintext token returned ONCE upon creation
}

export interface RotateBiometricKeyResponse {
  success: boolean;
  terminal: BiometricTerminalItem;
  apiKey: string; // Plaintext token returned ONCE upon key rotation
}

export interface DeactivateBiometricTerminalResponse {
  success: boolean;
  terminal: BiometricTerminalItem;
}

export interface RawPunchEventInput {
  devicePunchId?: string | null;
  userEnrollmentId: string;
  punchTime: string; // ISO 8601 UTC timestamp
  verifyType?: BiometricVerifyType;
  inOutMode?: PunchInOutMode;
}

export interface BatchPunchSubmissionRequest {
  punches: RawPunchEventInput[];
}

export interface BatchPunchSubmissionResponse {
  success: boolean;
  totalReceived: number;
  inserted: number;
  duplicates: number;
  unmappedEmployees: number;
  terminalId: string;
  terminalName: string;
}

export interface TerminalHeartbeatRequest {
  firmwareVersion?: string;
  monitoredDevicesCount?: number;
  onlineDevicesCount?: number;
  timestamp?: string;
}

export interface TerminalHeartbeatResponse {
  success: boolean;
  serverTime: string;
  terminalId: string;
  terminalName: string;
  status: BiometricTerminalStatus;
}

// ============================================================================
// PHASE 8.2: PUNCH RECONCILIATION & SYNC SERVICE TYPES
// ============================================================================

export interface RawPunchLogItem {
  id: string;
  companyId: string;
  terminalId: string;
  terminalName?: string | null;
  deviceSerialNumber?: string | null;
  devicePunchId: string | null;
  userEnrollmentId: string;
  punchTime: string;
  verifyType: BiometricVerifyType;
  inOutMode: PunchInOutMode;
  syncStatus: PunchSyncStatus;
  errorMessage: string | null;
  idempotencyKey: string;
  matchedEmployeeId: string | null;
  matchedEmployeeCode?: string | null;
  matchedEmployeeName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PunchReconciliationOptions {
  terminalId?: string;
  batchSize?: number;
  retryErrors?: boolean;
}

export interface PunchReconciliationItemResult {
  punchId: string;
  userEnrollmentId: string;
  matchedEmployeeId: string | null;
  workDate: string | null;
  status: PunchSyncStatus;
  message?: string | null;
}

export interface PunchReconciliationResponse {
  success: boolean;
  totalEvaluated: number;
  processed: number;
  ignored: number;
  errors: number;
  results: PunchReconciliationItemResult[];
}

export interface PunchSyncSummaryResponse {
  pendingCount: number;
  processedCount: number;
  ignoredCount: number;
  errorCount: number;
  totalCount: number;
  lastSyncAt: string | null;
}

// ============================================================================
// STAGE 1.4: WORKING HOURS LOGOUT SUMMARY & ADMIN NOTIFICATIONS
// ============================================================================

export type WorkingHoursStatus =
  | 'HOURS_COMPLETED'
  | 'SHORT_HOURS'
  | 'OVERTIME'
  | 'INCOMPLETE_ATTENDANCE'
  | 'MISSING_CHECK_IN'
  | 'NO_SHIFT_ASSIGNED'
  | 'DATA_REQUIRES_REVIEW';

export interface WorkingHoursSummary {
  workDate: string;
  timezone: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  shiftId: string | null;
  shiftName: string | null;
  shiftSchedule: string | null;
  expectedDurationHours: number | null;
  checkIn: string | null;
  checkOut: string | null;
  workedDurationHours: number | null;
  shortDurationMinutes: number;
  overtimeDurationMinutes: number;
  status: WorkingHoursStatus;
  statusMessage: string;
  requiresAttendanceAction: boolean;
}

export type AdminNotificationType =
  | 'HOURS_COMPLETED'
  | 'SHORT_HOURS'
  | 'INCOMPLETE_PUNCH'
  | 'NO_SHIFT_ASSIGNED'
  | 'ATTENDANCE_REVIEW_REQUIRED';

export interface AdminNotificationItem {
  id: string;
  companyId: string;
  type: AdminNotificationType;
  severity: 'INFO' | 'WARN' | 'ERROR';
  title: string;
  message: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  workDate: string;
  actionUrl: string;
  createdAt: string;
}

// ============================================================================
// Phase 2.3: Company Bank Accounts (Masked at API Boundary)
// ============================================================================

export interface CompanyBankAccountItem {
  id: string;
  companyId: string;
  bankName: string;
  accountHolderName: string;
  accountNumber: string; // Masked e.g. "•••• •••• 1234"
  routingCode: string | null; // Masked e.g. "•••••5678"
  branchName: string | null;
  swiftBic: string | null;
  iban: string | null; // Masked e.g. "GB•• •••• •••• 1234"
  upiId: string | null; // Masked e.g. "ac•••@icici"
  accountType: string | null;
  currency: string;
  isDefault: boolean;
  isActive: boolean;
  showOnInvoices: boolean;
  showOnQuotations: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCompanyBankAccountRequest {
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  routingCode?: string | null;
  branchName?: string | null;
  swiftBic?: string | null;
  iban?: string | null;
  upiId?: string | null;
  accountType?: string | null;
  currency?: string;
  isDefault?: boolean;
  showOnInvoices?: boolean;
  showOnQuotations?: boolean;
}

export interface UpdateCompanyBankAccountRequest {
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  routingCode?: string | null;
  branchName?: string | null;
  swiftBic?: string | null;
  iban?: string | null;
  upiId?: string | null;
  accountType?: string | null;
  currency?: string;
  isDefault?: boolean;
  showOnInvoices?: boolean;
  showOnQuotations?: boolean;
}

// ============================================================================
// EMPLOYEE EXPENSE CLAIMS & REIMBURSEMENTS TYPES
// ============================================================================

export type ExpenseClaimStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'MANAGER_APPROVED'
  | 'ACCOUNTS_APPROVED'
  | 'PAID'
  | 'REJECTED'
  | 'CANCELLED';

export type ExpenseCategory =
  | 'TRAVEL'
  | 'MEALS'
  | 'LODGING'
  | 'OFFICE_SUPPLIES'
  | 'COMMUNICATION'
  | 'SOFTWARE'
  | 'TRAINING'
  | 'OTHER';

export type ExpensePaymentMethod = 'BANK_TRANSFER' | 'CHEQUE' | 'CASH';

export interface ExpenseClaimAttachmentItem {
  id: string;
  claimId?: string | null;
  companyId: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256Hash: string;
  uploadedByUserId: string;
  createdAt: string;
}

export interface ExpenseClaimLineItem {
  id: string;
  claimId: string;
  companyId: string;
  category: ExpenseCategory;
  description: string;
  expenseDate: string;
  amount: number;
  merchant?: string | null;
  expenseLedgerId?: string | null;
  expenseLedgerName?: string | null;
  attachmentId?: string | null;
  attachment?: ExpenseClaimAttachmentItem | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseClaimEventItem {
  id: string;
  claimId: string;
  companyId: string;
  action: string;
  fromStatus?: ExpenseClaimStatus | null;
  toStatus: ExpenseClaimStatus;
  actorUserId: string;
  actorName?: string;
  notes?: string | null;
  createdAt: string;
}

export interface ExpenseClaimItem {
  id: string;
  companyId: string;
  claimNumber: string;
  employeeId: string;
  employeeName?: string;
  employeeCode?: string;
  departmentName?: string;
  title: string;
  description?: string | null;
  originalExpenseDate: string;
  currency: string;
  totalAmount: number;
  status: ExpenseClaimStatus;
  managerId?: string | null;
  managerName?: string | null;
  managerApprovedAt?: string | null;
  managerApprovedById?: string | null;
  managerApprovedByName?: string | null;
  accountsApprovedAt?: string | null;
  accountsApprovedById?: string | null;
  accountsApprovedByName?: string | null;
  payableLedgerId?: string | null;
  payableLedgerName?: string | null;
  journalEntryId?: string | null;
  journalVoucherNumber?: string | null;
  paidAt?: string | null;
  paidById?: string | null;
  paidByName?: string | null;
  paymentJournalEntryId?: string | null;
  paymentJournalVoucherNumber?: string | null;
  paymentReference?: string | null;
  paymentMethod?: ExpensePaymentMethod | null;
  bankAccountId?: string | null;
  rejectionReason?: string | null;
  returnReason?: string | null;
  lines: ExpenseClaimLineItem[];
  attachments: ExpenseClaimAttachmentItem[];
  events: ExpenseClaimEventItem[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateExpenseClaimLineInput {
  category: ExpenseCategory;
  description: string;
  expenseDate: string;
  amount: number;
  merchant?: string | null;
  expenseLedgerId?: string | null;
  attachmentId?: string | null;
}

export interface CreateExpenseClaimRequest {
  title: string;
  description?: string | null;
  originalExpenseDate: string;
  currency?: string;
  managerId?: string | null;
  lines: CreateExpenseClaimLineInput[];
  submitImmediately?: boolean;
}

export interface UpdateExpenseClaimRequest {
  title?: string;
  description?: string | null;
  originalExpenseDate?: string;
  managerId?: string | null;
  lines?: CreateExpenseClaimLineInput[];
}

export interface ReviewExpenseClaimRequest {
  decision: 'APPROVE' | 'REJECT' | 'RETURN';
  reason?: string;
  payableLedgerId?: string; // For accounts review
  expenseLedgerId?: string; // Fallback default expense ledger if not per-line
}

export interface PayExpenseClaimRequest {
  bankAccountId?: string;
  bankLedgerId?: string;
  paymentMethod: ExpensePaymentMethod;
  paymentReference?: string;
  paymentDate?: string;
}

export interface ExpenseSummaryReport {
  totalClaimsCount: number;
  draftCount: number;
  submittedCount: number;
  managerApprovedCount: number;
  accountsApprovedCount: number;
  paidCount: number;
  rejectedCount: number;
  totalPendingAmount: number;
  totalApprovedUnpaidAmount: number;
  totalReimbursedAmount: number;
  byCategory: Array<{ category: ExpenseCategory; amount: number; count: number }>;
  byDepartment: Array<{ departmentId: string; departmentName: string; amount: number; count: number }>;
}

export interface ExpenseCapabilitiesResponse {
  canManagerApprove: boolean;
  canAccountsApprove: boolean;
  canViewAccounting: boolean;
  canViewCompanyBankAccounts: boolean;
  canViewEmployees: boolean;
  currentEmployeeId: string | null;
}


