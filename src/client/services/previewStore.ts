import {
  UserListItem,
  AuthUser,
  Role,
  AccountGroupItem,
  AccountLedgerItem,
  JournalEntryItem,
  ContraEntryItem,
  CreateContraEntryRequest,
  InvoiceItem,
  CustomerItem,
  PayrollPeriodItem,
  PayslipItem,
  BalanceType,
  TrialBalanceReport,
  TrialBalanceRow,
  LedgerStatementReport,
  LedgerStatementLine,
  ProfitAndLossReport,
  BalanceSheetReport,
  OpeningBalanceValidationResult,
  CashBankBookType,
  CashBankBookLine,
  CashBankBookEligibleLedger,
  CashBankBookReport,
  CustomerReceiptItem,
  CreateCustomerReceiptRequest,
  ReceiptStatus,
  QuotationItem,
  CreateQuotationRequest,
  QuotationStatus,
  CreateCustomerRequest,
  UpdateCustomerRequest,
  CreateInvoiceRequest,
  CreateJournalEntryRequest,
  CreateAccountGroupRequest,
  CreateAccountLedgerRequest,
  JournalStatus,
} from '../../shared/types.ts';

/**
 * In-memory store for temporary preview demo data.
 * 
 * IMPORTANT:
 * - IN-MEMORY ONLY. Never sent to PostgreSQL.
 * - Cleared on browser page reload.
 * - Does NOT store real passwords.
 * - Used exclusively for UI exploration and workflow verification in Google AI Studio Preview.
 */

export const PREVIEW_ACCOUNT_GROUPS: AccountGroupItem[] = [
  {
    id: 'preview-grp-1000',
    companyId: 'preview-company-id',
    code: '1000',
    name: 'Assets',
    rootType: 'ASSET',
    parentGroupId: null,
    parentGroupName: null,
    isSystem: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-grp-2000',
    companyId: 'preview-company-id',
    code: '2000',
    name: 'Liabilities',
    rootType: 'LIABILITY',
    parentGroupId: null,
    parentGroupName: null,
    isSystem: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-grp-3000',
    companyId: 'preview-company-id',
    code: '3000',
    name: 'Equity',
    rootType: 'EQUITY',
    parentGroupId: null,
    parentGroupName: null,
    isSystem: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-grp-4000',
    companyId: 'preview-company-id',
    code: '4000',
    name: 'Income',
    rootType: 'INCOME',
    parentGroupId: null,
    parentGroupName: null,
    isSystem: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-grp-5000',
    companyId: 'preview-company-id',
    code: '5000',
    name: 'Expenses',
    rootType: 'EXPENSE',
    parentGroupId: null,
    parentGroupName: null,
    isSystem: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

export const PREVIEW_ACCOUNT_LEDGERS: AccountLedgerItem[] = [
  {
    id: 'preview-ldr-1010',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-1000',
    groupName: 'Assets',
    rootType: 'ASSET',
    code: '1010',
    name: 'Cash on Hand (Vault)',
    description: 'Petty cash and liquid currency reserves',
    currency: 'USD',
    isActive: true,
    openingBalance: '15000.0000',
    openingBalanceType: 'DEBIT',
    currentBalance: '15000.0000',
    currentBalanceType: 'DEBIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-1015',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-1000',
    groupName: 'Assets',
    rootType: 'ASSET',
    code: '1015',
    name: 'Petty Cash Register (Front Desk Till)',
    description: 'Front desk cash till and minor expense replenishment',
    currency: 'USD',
    isActive: true,
    openingBalance: '2500.0000',
    openingBalanceType: 'DEBIT',
    currentBalance: '2500.0000',
    currentBalanceType: 'DEBIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-1020',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-1000',
    groupName: 'Assets',
    rootType: 'ASSET',
    code: '1020',
    name: 'Operating Bank Account (JPMorgan)',
    description: 'Main commercial checking account',
    currency: 'USD',
    isActive: true,
    openingBalance: '125000.0000',
    openingBalanceType: 'DEBIT',
    currentBalance: '125000.0000',
    currentBalanceType: 'DEBIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-1025',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-1000',
    groupName: 'Assets',
    rootType: 'ASSET',
    code: '1025',
    name: 'Payroll Operating Bank (Silicon Valley Bank)',
    description: 'Dedicated compensation and statutory payroll clearing account',
    currency: 'USD',
    isActive: true,
    openingBalance: '50000.0000',
    openingBalanceType: 'DEBIT',
    currentBalance: '50000.0000',
    currentBalanceType: 'DEBIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-1030',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-1000',
    groupName: 'Assets',
    rootType: 'ASSET',
    code: '1030',
    name: 'Accounts Receivable (Trade Debtors)',
    description: 'Unsettled customer sales invoices',
    currency: 'USD',
    isActive: true,
    openingBalance: '48500.0000',
    openingBalanceType: 'DEBIT',
    currentBalance: '48500.0000',
    currentBalanceType: 'DEBIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-2010',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-2000',
    groupName: 'Liabilities',
    rootType: 'LIABILITY',
    code: '2010',
    name: 'Accounts Payable (Trade Creditors)',
    description: 'Vendor payables and supplier invoices',
    currency: 'USD',
    isActive: true,
    openingBalance: '26400.0000',
    openingBalanceType: 'CREDIT',
    currentBalance: '26400.0000',
    currentBalanceType: 'CREDIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-2020',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-2000',
    groupName: 'Liabilities',
    rootType: 'LIABILITY',
    code: '2020',
    name: 'Accrued Payroll & Salaries Payable',
    description: 'Withheld and accrued compensation payable',
    currency: 'USD',
    isActive: true,
    openingBalance: '32000.0000',
    openingBalanceType: 'CREDIT',
    currentBalance: '32000.0000',
    currentBalanceType: 'CREDIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-3010',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-3000',
    groupName: 'Equity',
    rootType: 'EQUITY',
    code: '3010',
    name: 'Shareholder Common Equity',
    description: 'Issued equity and founder contributions',
    currency: 'USD',
    isActive: true,
    openingBalance: '152500.0000',
    openingBalanceType: 'CREDIT',
    currentBalance: '152500.0000',
    currentBalanceType: 'CREDIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-4010',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-4000',
    groupName: 'Income',
    rootType: 'INCOME',
    code: '4010',
    name: 'Enterprise Software & Service Revenue',
    description: 'B2B recurring contract and milestone revenue',
    currency: 'USD',
    isActive: true,
    openingBalance: '68500.0000',
    openingBalanceType: 'CREDIT',
    currentBalance: '68500.0000',
    currentBalanceType: 'CREDIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-5010',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-5000',
    groupName: 'Expenses',
    rootType: 'EXPENSE',
    code: '5010',
    name: 'Staff Wages & Payroll Expenses',
    description: 'Monthly direct employee compensation',
    currency: 'USD',
    isActive: true,
    openingBalance: '32000.0000',
    openingBalanceType: 'DEBIT',
    currentBalance: '32000.0000',
    currentBalanceType: 'DEBIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'preview-ldr-5020',
    companyId: 'preview-company-id',
    groupId: 'preview-grp-5000',
    groupName: 'Expenses',
    rootType: 'EXPENSE',
    code: '5020',
    name: 'Cloud Infrastructure & Hosting',
    description: 'Production hosting, compute and storage',
    currency: 'USD',
    isActive: true,
    openingBalance: '6400.0000',
    openingBalanceType: 'DEBIT',
    currentBalance: '6400.0000',
    currentBalanceType: 'DEBIT',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

export const PREVIEW_JOURNALS: JournalEntryItem[] = [
  {
    id: 'preview-jrn-1',
    companyId: 'preview-company-id',
    voucherNumber: 'JV-2026-0001',
    entryDate: '2026-01-15',
    narration: 'Opening balance capital contribution by founders',
    reference: 'REF-FOUNDERS-CAPITAL',
    status: 'POSTED',
    totalDebit: '100000.0000',
    totalCredit: '100000.0000',
    postedAt: '2026-01-15T10:00:00.000Z',
    postedByUserName: 'Preview Super Admin',
    createdAt: '2026-01-15T09:30:00.000Z',
    lines: [
      {
        id: 'line-1',
        ledgerId: 'preview-ldr-1020',
        ledgerCode: '1020',
        ledgerName: 'Operating Bank Account (JPMorgan)',
        lineNumber: 1,
        debit: '100000.0000',
        credit: '0.0000',
        description: 'Capital deposit into operating account',
      },
      {
        id: 'line-2',
        ledgerId: 'preview-ldr-3010',
        ledgerCode: '3010',
        ledgerName: 'Shareholder Common Equity',
        lineNumber: 2,
        debit: '0.0000',
        credit: '100000.0000',
        description: 'Initial common stock issue',
      },
    ],
  },
  {
    id: 'preview-jrn-2',
    companyId: 'preview-company-id',
    voucherNumber: 'JV-2026-0002',
    entryDate: '2026-01-31',
    narration: 'Monthly payroll expense accrual for January',
    reference: 'PAYROLL-JAN-2026',
    status: 'POSTED',
    totalDebit: '32000.0000',
    totalCredit: '32000.0000',
    postedAt: '2026-01-31T17:00:00.000Z',
    postedByUserName: 'Preview Super Admin',
    createdAt: '2026-01-31T16:00:00.000Z',
    lines: [
      {
        id: 'line-3',
        ledgerId: 'preview-ldr-5010',
        ledgerCode: '5010',
        ledgerName: 'Staff Wages & Payroll Expenses',
        lineNumber: 1,
        debit: '32000.0000',
        credit: '0.0000',
        description: 'Direct compensation expense accrual',
      },
      {
        id: 'line-4',
        ledgerId: 'preview-ldr-2020',
        ledgerCode: '2020',
        ledgerName: 'Accrued Payroll & Salaries Payable',
        lineNumber: 2,
        debit: '0.0000',
        credit: '32000.0000',
        description: 'Gross payroll obligations payable',
      },
    ],
  },
];

export const PREVIEW_CUSTOMERS: CustomerItem[] = [
  {
    id: 'preview-cust-1',
    companyId: 'preview-company-id',
    code: 'CUST-001',
    name: 'Apex Industrial Dynamics',
    email: 'billing@apexindustrial.example.com',
    phone: '+1 555-019-2831',
    address: '100 Enterprise Way, Industrial Park, Suite 400',
    taxId: 'US-EIN-987654321',
    currency: 'USD',
    paymentTermsDays: 30,
    receivableLedgerId: 'preview-ldr-1030',
    receivableLedgerName: 'Accounts Receivable (Trade Debtors)',
    isActive: true,
    createdAt: '2026-01-05T08:00:00.000Z',
    totalInvoiced: '34500.0000',
    totalPaid: '20000.0000',
    balanceDue: '14500.0000',
  },
  {
    id: 'preview-cust-2',
    companyId: 'preview-company-id',
    code: 'CUST-002',
    name: 'Global Logistics & Supply Co.',
    email: 'accounts@globallogistics.example.com',
    phone: '+1 555-014-9988',
    address: '742 Commerce Blvd, Bayview Logistics Hub',
    taxId: 'US-EIN-456789123',
    currency: 'USD',
    paymentTermsDays: 15,
    receivableLedgerId: 'preview-ldr-1030',
    receivableLedgerName: 'Accounts Receivable (Trade Debtors)',
    isActive: true,
    createdAt: '2026-01-10T09:00:00.000Z',
    totalInvoiced: '18000.0000',
    totalPaid: '18000.0000',
    balanceDue: '0.0000',
  },
];

export const PREVIEW_INVOICES: InvoiceItem[] = [
  {
    id: 'preview-inv-1',
    companyId: 'preview-company-id',
    invoiceNumber: 'INV-2026-0001',
    quotationId: null,
    customerId: 'preview-cust-1',
    customerName: 'Apex Industrial Dynamics',
    customerEmail: 'billing@apexindustrial.example.com',
    customerPhone: '+1 555-019-2831',
    customerAddress: '100 Enterprise Way, Industrial Park, Suite 400',
    customerTaxId: 'US-EIN-987654321',
    invoiceDate: '2026-02-01',
    dueDate: '2026-03-03',
    status: 'ISSUED',
    currency: 'USD',
    subtotal: '13500.0000',
    discountTotal: '0.0000',
    taxTotal: '1000.0000',
    total: '14500.0000',
    amountPaid: '0.0000',
    balanceDue: '14500.0000',
    notes: 'Standard enterprise billing terms apply.',
    terms: 'Payment is due within 30 days of invoice date.',
    documentTitle: 'Commercial Sales Invoice',
    journalEntryId: 'preview-jrn-inv-1',
    journalVoucherNumber: 'JV-2026-0003',
    issuedAt: '2026-02-01T10:00:00.000Z',
    issuedByUserName: 'Preview Super Admin',
    voidedAt: null,
    voidedByUserName: null,
    voidReason: null,
    createdByUserName: 'Preview Super Admin',
    createdAt: '2026-02-01T09:00:00.000Z',
    lines: [
      {
        id: 'line-inv-1',
        lineNumber: 1,
        itemDescription: 'CoreERP Enterprise License (Q1 2026)',
        quantity: '1',
        unitPrice: '13500.0000',
        discountAmount: '0.0000',
        taxRate: '7.4074',
        taxAmount: '1000.0000',
        lineTotal: '14500.0000',
        revenueLedgerId: 'preview-ldr-4010',
        revenueLedgerName: 'Enterprise Software & Service Revenue',
      },
    ],
  },
];

export const PREVIEW_RECEIPTS: CustomerReceiptItem[] = [
  {
    id: 'preview-rct-1',
    companyId: 'preview-company-id',
    receiptNumber: 'CR-2026-0001',
    receiptDate: '2026-01-20',
    customerId: 'preview-cust-1',
    customerName: 'Apex Industrial Dynamics',
    amount: '20000.0000',
    allocatedTotal: '20000.0000',
    unallocatedAmount: '0.0000',
    paymentMethod: 'BANK_TRANSFER',
    referenceNumber: 'WIRE-APEX-991',
    receivingLedgerId: 'preview-ldr-1020',
    receivingLedgerName: 'Operating Bank Account (JPMorgan)',
    receivableLedgerId: 'preview-ldr-1030',
    receivableLedgerName: 'Accounts Receivable (Trade Debtors)',
    journalEntryId: 'preview-jrn-rct-1',
    journalVoucherNumber: 'JV-2026-0004',
    status: 'POSTED',
    notes: 'Advance settlement of initial hardware invoice',
    voidedAt: null,
    voidedByUserName: null,
    voidReason: null,
    createdByUserName: 'Preview Super Admin',
    createdAt: '2026-01-20T11:00:00.000Z',
    allocations: [],
  },
];

export const PREVIEW_QUOTATIONS: QuotationItem[] = [
  {
    id: 'preview-qt-1',
    companyId: 'preview-company-id',
    quotationNumber: 'QT-2026-0001',
    customerId: 'preview-cust-1',
    customerName: 'Apex Industrial Dynamics',
    customerEmail: 'billing@apexindustrial.example.com',
    customerPhone: '+1 555-019-2831',
    customerAddress: '100 Enterprise Way, Industrial Park, Suite 400',
    quotationDate: '2026-01-15',
    validUntilDate: '2026-02-15',
    status: 'ACCEPTED',
    currency: 'USD',
    subtotal: '13500.0000',
    discountTotal: '0.0000',
    taxTotal: '1000.0000',
    total: '14500.0000',
    notes: 'Standard enterprise package proposal',
    terms: 'Valid for 30 days.',
    documentTitle: 'Commercial Proposal',
    convertedToInvoiceId: 'preview-inv-1',
    createdByUserName: 'Preview Super Admin',
    createdAt: '2026-01-15T09:30:00.000Z',
    lines: [
      {
        id: 'line-qt-1',
        lineNumber: 1,
        itemDescription: 'CoreERP Enterprise License (Q1 2026)',
        quantity: '1',
        unitPrice: '13500.0000',
        discountAmount: '0.0000',
        taxRate: '7.4074',
        taxAmount: '1000.0000',
        lineTotal: '14500.0000',
      },
    ],
  },
  {
    id: 'preview-qt-2',
    companyId: 'preview-company-id',
    quotationNumber: 'QT-2026-0002',
    customerId: 'preview-cust-2',
    customerName: 'Global Logistics & Supply Co.',
    customerEmail: 'accounts@globallogistics.example.com',
    customerPhone: '+1 555-014-9988',
    customerAddress: '742 Commerce Blvd, Bayview Logistics Hub',
    quotationDate: '2026-02-05',
    validUntilDate: '2026-03-05',
    status: 'DRAFT',
    currency: 'USD',
    subtotal: '8500.0000',
    discountTotal: '500.0000',
    taxTotal: '640.0000',
    total: '8640.0000',
    notes: 'Annual fleet and supply chain tracking module renewal',
    terms: 'Net 30 upon invoice.',
    documentTitle: 'Quotation',
    convertedToInvoiceId: null,
    createdByUserName: 'Preview Super Admin',
    createdAt: '2026-02-05T14:15:00.000Z',
    lines: [
      {
        id: 'line-qt-2',
        lineNumber: 1,
        itemDescription: 'Supply Chain Sync Extension',
        quantity: '1',
        unitPrice: '8500.0000',
        discountAmount: '500.0000',
        taxRate: '8.0000',
        taxAmount: '640.0000',
        lineTotal: '8640.0000',
      },
    ],
  },
];

export const PREVIEW_PAYROLL_PERIODS: PayrollPeriodItem[] = [
  {
    id: 'preview-pay-period-1',
    companyId: 'preview-company-id',
    month: 1,
    year: 2026,
    name: 'January 2026',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    status: 'POSTED',
    processedAt: '2026-01-31T15:00:00.000Z',
    postedAt: '2026-01-31T17:00:00.000Z',
    createdByUserId: 'preview-session-id',
    createdByUserName: 'Preview Super Admin',
    totalGross: '32000.0000',
    totalDeductions: '4800.0000',
    totalNet: '27200.0000',
    payslipsCount: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-31T17:00:00.000Z',
  },
  {
    id: 'preview-pay-period-2',
    companyId: 'preview-company-id',
    month: 2,
    year: 2026,
    name: 'February 2026',
    startDate: '2026-02-01',
    endDate: '2026-02-28',
    status: 'DRAFT',
    processedAt: null,
    postedAt: null,
    createdByUserId: 'preview-session-id',
    createdByUserName: 'Preview Super Admin',
    totalGross: '32000.0000',
    totalDeductions: '4800.0000',
    totalNet: '27200.0000',
    payslipsCount: 4,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  },
];

export const PREVIEW_PAYSLIPS: PayslipItem[] = [
  {
    id: 'preview-ps-1',
    companyId: 'preview-company-id',
    payrollPeriodId: 'preview-pay-period-1',
    payrollPeriodName: 'January 2026',
    payrollPeriodMonth: 1,
    payrollPeriodYear: 2026,
    employeeId: 'preview-emp-1',
    employeeCode: 'EMP-001',
    employeeName: 'Sarah Jenkins',
    basicSalary: '6500.0000',
    allowances: '1000.0000',
    overtimePay: '0.0000',
    grossSalary: '7500.0000',
    deductions: '1125.0000',
    lossOfPayDeduction: '0.0000',
    netSalary: '6375.0000',
    status: 'PAID',
    paymentMethod: 'DIRECT_DEPOSIT',
    paymentDate: '2026-01-31',
    ledgerId: 'preview-ldr-5010',
    ledgerName: 'Staff Wages & Payroll Expenses',
    journalEntryId: 'preview-jrn-2',
    journalVoucherNumber: 'JV-2026-0002',
    notes: 'Regular January compensation',
    createdAt: '2026-01-31T15:00:00.000Z',
    updatedAt: '2026-01-31T17:00:00.000Z',
  },
];

const INITIAL_PREVIEW_ADMIN: UserListItem = {
  id: 'preview-session-id',
  companyId: 'preview-company-id',
  email: 'preview_admin@preview.local',
  fullName: 'Temporary Preview Account — Not a Real Super Admin',
  role: 'SUPER_ADMIN',
  isActive: true,
  lastLoginAt: new Date().toISOString(),
  createdAt: '2026-01-01T00:00:00.000Z',
  isPreviewUser: true,
  isDemoOnly: true,
};

export const INITIAL_PREVIEW_CONTRA_ENTRIES: ContraEntryItem[] = [
  {
    id: 'preview-contra-1',
    companyId: 'preview-company-id',
    voucherNumber: 'CV-2026-0001',
    idempotencyKey: null,
    entryDate: '2026-01-15',
    fiscalPeriodId: null,
    contraType: 'CASH_TO_BANK',
    sourceLedgerId: 'preview-ldr-1010',
    sourceLedgerName: 'Cash on Hand (Vault)',
    sourceLedgerCode: '1010',
    destinationLedgerId: 'preview-ldr-1020',
    destinationLedgerName: 'Operating Bank Account (JPMorgan)',
    destinationLedgerCode: '1020',
    amount: '5000.0000',
    reference: 'DEP-2026-004',
    narration: 'Deposit surplus vault cash into main operating checking account',
    status: 'POSTED',
    postedAt: '2026-01-15T14:30:00.000Z',
    postedByUserName: 'Preview Admin',
    reversedAt: null,
    reversedByUserName: null,
    reversalOfId: null,
    createdByUserName: 'Preview Admin',
    createdAt: '2026-01-15T14:30:00.000Z',
    lines: [
      {
        id: 'cv1-l1',
        ledgerId: 'preview-ldr-1020',
        ledgerName: 'Operating Bank Account (JPMorgan)',
        ledgerCode: '1020',
        lineNumber: 1,
        debit: '5000.0000',
        credit: '0.0000',
        description: 'Contra Transfer To: Operating Bank Account (JPMorgan)',
      },
      {
        id: 'cv1-l2',
        ledgerId: 'preview-ldr-1010',
        ledgerName: 'Cash on Hand (Vault)',
        ledgerCode: '1010',
        lineNumber: 2,
        debit: '0.0000',
        credit: '5000.0000',
        description: 'Contra Transfer From: Cash on Hand (Vault)',
      },
    ],
  },
  {
    id: 'preview-contra-2',
    companyId: 'preview-company-id',
    voucherNumber: 'CV-2026-0002',
    idempotencyKey: null,
    entryDate: '2026-01-22',
    fiscalPeriodId: null,
    contraType: 'BANK_TO_CASH',
    sourceLedgerId: 'preview-ldr-1020',
    sourceLedgerName: 'Operating Bank Account (JPMorgan)',
    sourceLedgerCode: '1020',
    destinationLedgerId: 'preview-ldr-1015',
    destinationLedgerName: 'Petty Cash Register (Front Desk Till)',
    destinationLedgerCode: '1015',
    amount: '750.0000',
    reference: 'CHK-88021',
    narration: 'Withdrawal from JPMorgan checking to replenish front desk petty cash',
    status: 'POSTED',
    postedAt: '2026-01-22T10:15:00.000Z',
    postedByUserName: 'Preview Admin',
    reversedAt: null,
    reversedByUserName: null,
    reversalOfId: null,
    createdByUserName: 'Preview Admin',
    createdAt: '2026-01-22T10:15:00.000Z',
    lines: [
      {
        id: 'cv2-l1',
        ledgerId: 'preview-ldr-1015',
        ledgerName: 'Petty Cash Register (Front Desk Till)',
        ledgerCode: '1015',
        lineNumber: 1,
        debit: '750.0000',
        credit: '0.0000',
        description: 'Contra Transfer To: Petty Cash Register (Front Desk Till)',
      },
      {
        id: 'cv2-l2',
        ledgerId: 'preview-ldr-1020',
        ledgerName: 'Operating Bank Account (JPMorgan)',
        ledgerCode: '1020',
        lineNumber: 2,
        debit: '0.0000',
        credit: '750.0000',
        description: 'Contra Transfer From: Operating Bank Account (JPMorgan)',
      },
    ],
  },
  {
    id: 'preview-contra-3',
    companyId: 'preview-company-id',
    voucherNumber: 'CV-2026-0003',
    idempotencyKey: null,
    entryDate: '2026-02-01',
    fiscalPeriodId: null,
    contraType: 'BANK_TO_BANK',
    sourceLedgerId: 'preview-ldr-1020',
    sourceLedgerName: 'Operating Bank Account (JPMorgan)',
    sourceLedgerCode: '1020',
    destinationLedgerId: 'preview-ldr-1025',
    destinationLedgerName: 'Payroll Operating Bank (Silicon Valley Bank)',
    destinationLedgerCode: '1025',
    amount: '25000.0000',
    reference: 'WIRE-99214',
    narration: 'Internal wire transfer to fund upcoming mid-month payroll',
    status: 'DRAFT',
    postedAt: null,
    postedByUserName: null,
    reversedAt: null,
    reversedByUserName: null,
    reversalOfId: null,
    createdByUserName: 'Preview Admin',
    createdAt: '2026-02-01T09:00:00.000Z',
    lines: [
      {
        id: 'cv3-l1',
        ledgerId: 'preview-ldr-1025',
        ledgerName: 'Payroll Operating Bank (Silicon Valley Bank)',
        ledgerCode: '1025',
        lineNumber: 1,
        debit: '25000.0000',
        credit: '0.0000',
        description: 'Contra Transfer To: Payroll Operating Bank (Silicon Valley Bank)',
      },
      {
        id: 'cv3-l2',
        ledgerId: 'preview-ldr-1020',
        ledgerName: 'Operating Bank Account (JPMorgan)',
        ledgerCode: '1020',
        lineNumber: 2,
        debit: '0.0000',
        credit: '25000.0000',
        description: 'Contra Transfer From: Operating Bank Account (JPMorgan)',
      },
    ],
  },
];

class PreviewUserStore {
  private users: UserListItem[] = [{ ...INITIAL_PREVIEW_ADMIN }];

  /**
   * Retrieves preview users with optional search and role filtering.
   */
  getPreviewUsers(filter?: { search?: string; role?: Role | '' }): UserListItem[] {
    let result = [...this.users];

    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      result = result.filter(
        (u) =>
          u.fullName.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q)
      );
    }

    if (filter?.role) {
      result = result.filter((u) => u.role === filter.role);
    }

    return result;
  }

  /**
   * Creates an in-memory preview demo user.
   * Never calls the real backend user creation API.
   * Does NOT store real passwords.
   */
  createPreviewUser(input: {
    fullName: string;
    email: string;
    role: Role;
    isActive?: boolean;
    employeeId?: string;
  }): UserListItem {
    const trimmedEmail = input.email.trim().toLowerCase();
    const trimmedName = input.fullName.trim();

    // Check duplicate within preview store
    const existing = this.users.find(
      (u) =>
        u.email.toLowerCase() === trimmedEmail ||
        u.email.toLowerCase() === `${trimmedEmail}@preview.local`
    );

    if (existing) {
      const err = new Error(`A preview demo account with identifier "${trimmedEmail}" already exists in memory.`);
      throw err;
    }

    const newUser: UserListItem = {
      id: `preview-user-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      companyId: 'preview-company-id',
      email: trimmedEmail,
      fullName: trimmedName,
      role: input.role,
      isActive: input.isActive !== undefined ? input.isActive : true,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
      isPreviewUser: true,
      isDemoOnly: true,
    };

    // Prepend after root preview admin
    this.users = [this.users[0], newUser, ...this.users.slice(1)];
    return newUser;
  }

  /**
   * Updates a preview user's role in memory
   */
  updatePreviewUserRole(id: string, role: Role): UserListItem | null {
    const idx = this.users.findIndex((u) => u.id === id);
    if (idx === -1) return null;

    const updated = { ...this.users[idx], role };
    this.users[idx] = updated;
    return updated;
  }

  /**
   * Updates a preview user's active status in memory
   */
  updatePreviewUserStatus(id: string, isActive: boolean): UserListItem | null {
    const idx = this.users.findIndex((u) => u.id === id);
    if (idx === -1) return null;

    const updated = { ...this.users[idx], isActive };
    this.users[idx] = updated;
    return updated;
  }

  /**
   * Finds a preview user by username, email, or ID
   */
  findPreviewUser(identifier: string): UserListItem | undefined {
    const clean = identifier.trim().toLowerCase();
    return this.users.find(
      (u) =>
        u.id === clean ||
        u.email.toLowerCase() === clean ||
        u.email.toLowerCase().split('@')[0] === clean
    );
  }

  /**
   * Generates a restricted mock AuthUser object for preview exploration.
   * Always sets isPreview: true to enforce read-only exploration.
   */
  createMockAuthUser(previewUser: UserListItem): AuthUser {
    return {
      id: previewUser.id,
      userId: previewUser.id,
      companyId: previewUser.companyId,
      email: previewUser.email,
      fullName: `${previewUser.fullName} (Preview Demo Account)`,
      role: previewUser.role,
      isActive: previewUser.isActive,
      tokenVersion: 1,
      isPreview: true,
    };
  }

  private companySettings = {
    salesInvoiceEnabled: true,
  };

  /**
   * Retrieves preview company settings in memory
   */
  getCompanySettings(): { salesInvoiceEnabled: boolean } {
    return { ...this.companySettings };
  }

  /**
   * Sets sales invoice enabled toggle in preview mode memory
   */
  setSalesInvoiceEnabled(enabled: boolean): void {
    this.companySettings.salesInvoiceEnabled = enabled;
  }

  setCompanySettings(settings: Partial<{ salesInvoiceEnabled: boolean }>): void {
    this.companySettings = { ...this.companySettings, ...settings };
  }

  private contraEntries: ContraEntryItem[] = [...INITIAL_PREVIEW_CONTRA_ENTRIES];
  private journals: JournalEntryItem[] = [...PREVIEW_JOURNALS];
  private customers: CustomerItem[] = [...PREVIEW_CUSTOMERS];
  private invoices: InvoiceItem[] = [...PREVIEW_INVOICES];
  private receipts: CustomerReceiptItem[] = [...PREVIEW_RECEIPTS];
  private quotations: QuotationItem[] = [...PREVIEW_QUOTATIONS];
  private accountGroups: AccountGroupItem[] = [...PREVIEW_ACCOUNT_GROUPS];
  private accountLedgers: AccountLedgerItem[] = [...PREVIEW_ACCOUNT_LEDGERS];

  getContraEntries(filters?: {
    status?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
  }): ContraEntryItem[] {
    let result = [...this.contraEntries];
    if (filters?.status && filters.status !== 'ALL') {
      result = result.filter((c) => c.status === filters.status);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase().trim();
      result = result.filter(
        (c) =>
          c.voucherNumber.toLowerCase().includes(q) ||
          c.narration.toLowerCase().includes(q) ||
          (c.reference && c.reference.toLowerCase().includes(q))
      );
    }
    return result;
  }

  getContraEntryById(id: string): ContraEntryItem | undefined {
    return this.contraEntries.find((c) => c.id === id);
  }

  createContraEntry(input: CreateContraEntryRequest, user?: AuthUser | null): ContraEntryItem {
    const seq = (this.contraEntries.length + 1).toString().padStart(4, '0');
    const year = new Date(input.entryDate).getFullYear() || 2026;
    const voucherNumber = `CV-${year}-${seq}`;

    const sourceLedger = PREVIEW_ACCOUNT_LEDGERS.find((l) => l.id === input.sourceLedgerId);
    const destLedger = PREVIEW_ACCOUNT_LEDGERS.find((l) => l.id === input.destinationLedgerId);

    const amountNum = parseFloat(input.amount || '0').toFixed(4);
    const now = new Date().toISOString();
    const shouldAutoPost = Boolean(input.autoPost);

    const newEntry: ContraEntryItem = {
      id: `preview-contra-${Date.now()}`,
      companyId: 'preview-company-id',
      voucherNumber,
      idempotencyKey: input.idempotencyKey || null,
      entryDate: input.entryDate,
      fiscalPeriodId: input.fiscalPeriodId || null,
      contraType: input.contraType || 'INTERNAL_TRANSFER',
      sourceLedgerId: input.sourceLedgerId,
      sourceLedgerName: sourceLedger?.name || 'Cash/Bank Source',
      sourceLedgerCode: sourceLedger?.code || null,
      destinationLedgerId: input.destinationLedgerId,
      destinationLedgerName: destLedger?.name || 'Cash/Bank Destination',
      destinationLedgerCode: destLedger?.code || null,
      amount: amountNum,
      reference: input.reference || null,
      narration:
        input.narration ||
        `Internal transfer from ${sourceLedger?.name || 'source'} to ${destLedger?.name || 'destination'}`,
      status: shouldAutoPost ? 'POSTED' : 'DRAFT',
      postedAt: shouldAutoPost ? now : null,
      postedByUserName: shouldAutoPost ? (user?.fullName || 'Preview Admin') : null,
      reversedAt: null,
      reversedByUserName: null,
      reversalOfId: null,
      createdByUserName: user?.fullName || 'Preview Admin',
      createdAt: now,
      lines: [
        {
          id: `line-${Date.now()}-1`,
          ledgerId: input.destinationLedgerId,
          ledgerName: destLedger?.name || 'Destination',
          ledgerCode: destLedger?.code || null,
          lineNumber: 1,
          debit: amountNum,
          credit: '0.0000',
          description: `Contra Transfer To: ${destLedger?.name || 'Destination'}`,
        },
        {
          id: `line-${Date.now()}-2`,
          ledgerId: input.sourceLedgerId,
          ledgerName: sourceLedger?.name || 'Source',
          ledgerCode: sourceLedger?.code || null,
          lineNumber: 2,
          debit: '0.0000',
          credit: amountNum,
          description: `Contra Transfer From: ${sourceLedger?.name || 'Source'}`,
        },
      ],
    };

    this.contraEntries = [newEntry, ...this.contraEntries];
    return newEntry;
  }

  postContraEntry(id: string, user?: AuthUser | null): ContraEntryItem | null {
    const idx = this.contraEntries.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const now = new Date().toISOString();
    const updated = {
      ...this.contraEntries[idx],
      status: 'POSTED' as const,
      postedAt: now,
      postedByUserName: user?.fullName || 'Preview Admin',
    };
    this.contraEntries[idx] = updated;
    return updated;
  }

  reverseContraEntry(
    id: string,
    reason: string,
    user?: AuthUser | null
  ): { original: ContraEntryItem; reversal: ContraEntryItem } | null {
    const idx = this.contraEntries.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const original = this.contraEntries[idx];
    const now = new Date().toISOString();
    const year = new Date().getFullYear();
    const seq = (this.contraEntries.length + 1).toString().padStart(4, '0');
    const reversalVoucherNumber = `CV-${year}-${seq}`;

    const reversal: ContraEntryItem = {
      id: `preview-contra-${Date.now()}`,
      companyId: 'preview-company-id',
      voucherNumber: reversalVoucherNumber,
      idempotencyKey: null,
      entryDate: now.split('T')[0],
      fiscalPeriodId: original.fiscalPeriodId,
      contraType: original.contraType,
      sourceLedgerId: original.destinationLedgerId,
      sourceLedgerName: original.destinationLedgerName,
      sourceLedgerCode: original.destinationLedgerCode,
      destinationLedgerId: original.sourceLedgerId,
      destinationLedgerName: original.sourceLedgerName,
      destinationLedgerCode: original.sourceLedgerCode,
      amount: original.amount,
      reference: `REV-${original.voucherNumber}`,
      narration: `Reversal of Contra Voucher ${original.voucherNumber}. Reason: ${reason}`,
      status: 'POSTED',
      postedAt: now,
      postedByUserName: user?.fullName || 'Preview Admin',
      reversedAt: null,
      reversedByUserName: null,
      reversalOfId: original.id,
      createdByUserName: user?.fullName || 'Preview Admin',
      createdAt: now,
      lines: [
        {
          id: `rev-line-1`,
          ledgerId: original.sourceLedgerId,
          ledgerName: original.sourceLedgerName,
          ledgerCode: original.sourceLedgerCode,
          lineNumber: 1,
          debit: original.amount,
          credit: '0.0000',
          description: `Reversal Debit: ${original.sourceLedgerName}`,
        },
        {
          id: `rev-line-2`,
          ledgerId: original.destinationLedgerId,
          ledgerName: original.destinationLedgerName,
          ledgerCode: original.destinationLedgerCode,
          lineNumber: 2,
          debit: '0.0000',
          credit: original.amount,
          description: `Reversal Credit: ${original.destinationLedgerName}`,
        },
      ],
    };

    const updatedOriginal = {
      ...original,
      status: 'REVERSED' as const,
      reversedAt: now,
      reversedByUserName: user?.fullName || 'Preview Admin',
    };

    this.contraEntries[idx] = updatedOriginal;
    this.contraEntries = [reversal, ...this.contraEntries];
    return { original: updatedOriginal, reversal };
  }

  // ==========================================
  // In-Memory Chart of Accounts (Preview Exploration)
  // ==========================================

  getAccountGroups(): AccountGroupItem[] {
    return [...this.accountGroups];
  }

  createAccountGroup(input: CreateAccountGroupRequest): AccountGroupItem {
    const parentGroup = input.parentGroupId
      ? this.accountGroups.find((g) => g.id === input.parentGroupId)
      : null;
    const newGroup: AccountGroupItem = {
      id: `preview-grp-${Date.now()}`,
      companyId: 'preview-company-id',
      code: input.code.trim(),
      name: input.name.trim(),
      rootType: input.rootType,
      parentGroupId: input.parentGroupId || null,
      parentGroupName: parentGroup ? parentGroup.name : null,
      isSystem: false,
      createdAt: new Date().toISOString(),
    };
    this.accountGroups = [...this.accountGroups, newGroup];
    return newGroup;
  }

  getAccountLedgers(filter?: {
    rootType?: string;
    isActive?: boolean;
    search?: string;
  }): AccountLedgerItem[] {
    let result = [...this.accountLedgers];
    if (filter?.rootType) {
      result = result.filter((l) => l.rootType === filter.rootType);
    }
    if (filter?.isActive !== undefined) {
      result = result.filter((l) => l.isActive === filter.isActive);
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      result = result.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          (l.code && l.code.toLowerCase().includes(q))
      );
    }
    return result;
  }

  createAccountLedger(input: CreateAccountLedgerRequest): AccountLedgerItem {
    const grp = this.accountGroups.find((g) => g.id === input.groupId);
    const ob = parseFloat(input.openingBalance || '0').toFixed(4);
    const obType =
      input.openingBalanceType ||
      (grp?.rootType === 'LIABILITY' ||
      grp?.rootType === 'EQUITY' ||
      grp?.rootType === 'INCOME'
        ? 'CREDIT'
        : 'DEBIT');
    const newLedger: AccountLedgerItem = {
      id: `preview-ldr-${Date.now()}`,
      companyId: 'preview-company-id',
      groupId: input.groupId,
      groupName: grp?.name || 'General',
      rootType: grp?.rootType || 'ASSET',
      code: input.code ? input.code.trim() : null,
      name: input.name.trim(),
      description: input.description ? input.description.trim() : null,
      currency: input.currency || 'USD',
      isActive: true,
      openingBalance: ob,
      openingBalanceType: obType,
      currentBalance: ob,
      currentBalanceType: obType,
      createdAt: new Date().toISOString(),
    };
    this.accountLedgers = [...this.accountLedgers, newLedger];
    return newLedger;
  }

  // ==========================================
  // In-Memory Journal Entries (Preview Exploration)
  // ==========================================

  getJournals(filters?: {
    status?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
  }): JournalEntryItem[] {
    let result = [...this.journals];
    if (filters?.status && filters.status !== 'ALL') {
      result = result.filter((j) => j.status === filters.status);
    }
    if (filters?.fromDate) {
      result = result.filter((j) => j.entryDate >= filters.fromDate!);
    }
    if (filters?.toDate) {
      result = result.filter((j) => j.entryDate <= filters.toDate!);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase().trim();
      result = result.filter(
        (j) =>
          j.voucherNumber.toLowerCase().includes(q) ||
          j.narration.toLowerCase().includes(q) ||
          (j.reference && j.reference.toLowerCase().includes(q))
      );
    }
    return result;
  }

  createJournal(
    input: CreateJournalEntryRequest,
    user?: AuthUser | null
  ): JournalEntryItem {
    const seq = (this.journals.length + 1).toString().padStart(4, '0');
    const year = new Date(input.entryDate).getFullYear() || 2026;
    const voucherNumber = `JV-${year}-${seq}`;
    const now = new Date().toISOString();
    const shouldAutoPost = Boolean(input.autoPost);

    let totDebit = 0;
    let totCredit = 0;
    const lines = input.lines.map((l, idx) => {
      const d = parseFloat(l.debit || '0');
      const c = parseFloat(l.credit || '0');
      totDebit += d;
      totCredit += c;
      const targetLedger = this.accountLedgers.find((al) => al.id === l.ledgerId);
      return {
        id: `line-${Date.now()}-${idx + 1}`,
        ledgerId: l.ledgerId,
        ledgerCode: targetLedger?.code || null,
        ledgerName: targetLedger?.name || 'Ledger',
        lineNumber: idx + 1,
        debit: d.toFixed(4),
        credit: c.toFixed(4),
        description: l.description || null,
      };
    });

    const newJournal: JournalEntryItem = {
      id: `preview-jrn-${Date.now()}`,
      companyId: 'preview-company-id',
      voucherNumber,
      idempotencyKey: input.idempotencyKey || null,
      entryDate: input.entryDate,
      fiscalPeriodId: input.fiscalPeriodId || null,
      narration: input.narration.trim(),
      reference: input.reference ? input.reference.trim() : null,
      status: shouldAutoPost ? 'POSTED' : 'DRAFT',
      totalDebit: totDebit.toFixed(4),
      totalCredit: totCredit.toFixed(4),
      postedAt: shouldAutoPost ? now : null,
      postedByUserName: shouldAutoPost ? user?.fullName || 'Preview Admin' : null,
      reversedAt: null,
      reversedByUserName: null,
      reversalOfId: null,
      createdByUserName: user?.fullName || 'Preview Admin',
      createdAt: now,
      lines,
    };

    this.journals = [newJournal, ...this.journals];
    return newJournal;
  }

  postJournal(id: string, user?: AuthUser | null): JournalEntryItem {
    const idx = this.journals.findIndex((j) => j.id === id);
    if (idx === -1) {
      throw new Error(`Journal voucher with id "${id}" not found.`);
    }
    const now = new Date().toISOString();
    const updated = {
      ...this.journals[idx],
      status: 'POSTED' as JournalStatus,
      postedAt: now,
      postedByUserName: user?.fullName || 'Preview Admin',
    };
    this.journals[idx] = updated;
    return updated;
  }

  reverseJournal(
    id: string,
    reason: string,
    user?: AuthUser | null
  ): { original: JournalEntryItem; reversal: JournalEntryItem } {
    const idx = this.journals.findIndex((j) => j.id === id);
    if (idx === -1) {
      throw new Error(`Journal voucher with id "${id}" not found.`);
    }
    const original = this.journals[idx];
    if (original.status !== 'POSTED') {
      throw new Error('Only posted journal vouchers can be reversed.');
    }
    const now = new Date().toISOString();
    const year = new Date().getFullYear();
    const seq = (this.journals.length + 1).toString().padStart(4, '0');
    const reversalVoucherNumber = `JV-${year}-${seq}`;

    const reversalLines = original.lines.map((l) => ({
      id: `rev-line-${Date.now()}-${l.lineNumber}`,
      ledgerId: l.ledgerId,
      ledgerCode: l.ledgerCode,
      ledgerName: l.ledgerName,
      lineNumber: l.lineNumber,
      debit: l.credit,
      credit: l.debit,
      description: `Reversal of line ${l.lineNumber}: ${l.description || original.narration}`,
    }));

    const reversal: JournalEntryItem = {
      id: `preview-jrn-${Date.now()}`,
      companyId: 'preview-company-id',
      voucherNumber: reversalVoucherNumber,
      idempotencyKey: null,
      entryDate: now.split('T')[0],
      fiscalPeriodId: original.fiscalPeriodId,
      narration: `Reversal of ${original.voucherNumber}. Reason: ${reason}`,
      reference: `REV-${original.voucherNumber}`,
      status: 'POSTED',
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
      postedAt: now,
      postedByUserName: user?.fullName || 'Preview Admin',
      reversedAt: null,
      reversedByUserName: null,
      reversalOfId: original.id,
      createdByUserName: user?.fullName || 'Preview Admin',
      createdAt: now,
      lines: reversalLines,
    };

    const updatedOriginal = {
      ...original,
      status: 'REVERSED' as JournalStatus,
      reversedAt: now,
      reversedByUserName: user?.fullName || 'Preview Admin',
    };

    this.journals[idx] = updatedOriginal;
    this.journals = [reversal, ...this.journals];
    return { original: updatedOriginal, reversal };
  }

  // ==========================================
  // In-Memory Customers (Preview Exploration)
  // ==========================================

  getCustomers(filter?: { search?: string; isActive?: boolean }): CustomerItem[] {
    let result = [...this.customers];
    if (filter?.isActive !== undefined) {
      result = result.filter((c) => c.isActive === filter.isActive);
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.code.toLowerCase().includes(q) ||
          (c.email && c.email.toLowerCase().includes(q))
      );
    }
    return result;
  }

  createCustomer(input: CreateCustomerRequest): CustomerItem {
    const arLedger = input.receivableLedgerId
      ? this.accountLedgers.find((l) => l.id === input.receivableLedgerId)
      : this.accountLedgers.find((l) => l.name.toLowerCase().includes('receivable'));

    const newCustomer: CustomerItem = {
      id: `preview-cust-${Date.now()}`,
      companyId: 'preview-company-id',
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      email: input.email ? input.email.trim() : null,
      phone: input.phone ? input.phone.trim() : null,
      address: input.address ? input.address.trim() : null,
      taxId: input.taxId ? input.taxId.trim() : null,
      currency: 'USD',
      paymentTermsDays: input.paymentTermsDays || 30,
      receivableLedgerId: arLedger ? arLedger.id : null,
      receivableLedgerName: arLedger ? arLedger.name : null,
      isActive: true,
      createdAt: new Date().toISOString(),
      totalInvoiced: '0.0000',
      totalPaid: '0.0000',
      balanceDue: '0.0000',
    };
    this.customers = [...this.customers, newCustomer];
    return newCustomer;
  }

  updateCustomer(id: string, input: UpdateCustomerRequest): CustomerItem {
    const idx = this.customers.findIndex((c) => c.id === id);
    if (idx === -1) {
      throw new Error(`Customer with id "${id}" not found.`);
    }
    const current = this.customers[idx];
    const arLedger = input.receivableLedgerId
      ? this.accountLedgers.find((l) => l.id === input.receivableLedgerId)
      : this.accountLedgers.find((l) => l.id === current.receivableLedgerId);

    const updated: CustomerItem = {
      ...current,
      code: input.code ? input.code.trim().toUpperCase() : current.code,
      name: input.name !== undefined ? input.name.trim() : current.name,
      email: input.email !== undefined ? (input.email ? input.email.trim() : null) : current.email,
      phone: input.phone !== undefined ? (input.phone ? input.phone.trim() : null) : current.phone,
      address: input.address !== undefined ? (input.address ? input.address.trim() : null) : current.address,
      taxId: input.taxId !== undefined ? (input.taxId ? input.taxId.trim() : null) : current.taxId,
      paymentTermsDays:
        input.paymentTermsDays !== undefined ? input.paymentTermsDays : current.paymentTermsDays,
      receivableLedgerId: arLedger ? arLedger.id : null,
      receivableLedgerName: arLedger ? arLedger.name : null,
      isActive: input.isActive !== undefined ? input.isActive : current.isActive,
    };
    this.customers[idx] = updated;
    return updated;
  }

  // ==========================================
  // In-Memory Quotations (Preview Exploration)
  // ==========================================

  getQuotations(filters?: {
    status?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
  }): QuotationItem[] {
    let result = [...this.quotations];
    if (filters?.status && filters.status !== 'ALL') {
      result = result.filter((q) => q.status === filters.status);
    }
    if (filters?.fromDate) {
      result = result.filter((q) => q.quotationDate >= filters.fromDate!);
    }
    if (filters?.toDate) {
      result = result.filter((q) => q.quotationDate <= filters.toDate!);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase().trim();
      result = result.filter(
        (item) =>
          item.quotationNumber.toLowerCase().includes(q) ||
          item.customerName.toLowerCase().includes(q) ||
          (item.documentTitle && item.documentTitle.toLowerCase().includes(q))
      );
    }
    return result;
  }

  createQuotation(input: CreateQuotationRequest, user?: AuthUser | null): QuotationItem {
    const seq = (this.quotations.length + 1).toString().padStart(4, '0');
    const voucherNumber = `QT-${new Date().getFullYear()}-${seq}`;
    let subtotalNum = 0;
    let discNum = 0;
    let taxNum = 0;

    const lines = input.lines.map((l, idx) => {
      const qty = parseFloat(String(l.quantity) || '0');
      const unit = parseFloat(String(l.unitPrice) || '0');
      const disc = parseFloat(String(l.discountAmount) || '0');
      const rate = parseFloat(String(l.taxRate) || '0');
      const base = Math.max(0, qty * unit - disc);
      const tax = base * (rate / 100);
      const lineTot = base + tax;

      subtotalNum += qty * unit;
      discNum += disc;
      taxNum += tax;

      return {
        id: `qt-line-${Date.now()}-${idx + 1}`,
        lineNumber: idx + 1,
        itemDescription: l.itemDescription.trim(),
        quantity: qty.toFixed(4),
        unitPrice: unit.toFixed(4),
        discountAmount: disc.toFixed(4),
        taxRate: rate.toFixed(4),
        taxAmount: tax.toFixed(4),
        lineTotal: lineTot.toFixed(4),
      };
    });

    const totalNum = subtotalNum - discNum + taxNum;

    const newQuotation: QuotationItem = {
      id: `preview-qt-${Date.now()}`,
      companyId: 'preview-company-id',
      quotationNumber: voucherNumber,
      customerId: input.customerId || null,
      customerName: input.customerName.trim(),
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      customerAddress: input.customerAddress || null,
      quotationDate: input.quotationDate,
      validUntilDate: input.validUntilDate,
      status: 'DRAFT',
      currency: 'USD',
      subtotal: subtotalNum.toFixed(4),
      discountTotal: discNum.toFixed(4),
      taxTotal: taxNum.toFixed(4),
      total: totalNum.toFixed(4),
      notes: input.notes || null,
      terms: input.terms || null,
      documentTitle: input.documentTitle || 'Quotation',
      convertedToInvoiceId: null,
      createdByUserName: user?.fullName || 'Preview Admin',
      createdAt: new Date().toISOString(),
      lines,
    };

    this.quotations = [newQuotation, ...this.quotations];
    return newQuotation;
  }

  updateQuotationStatus(id: string, status: QuotationStatus): QuotationItem {
    const idx = this.quotations.findIndex((q) => q.id === id);
    if (idx === -1) {
      throw new Error(`Quotation with id "${id}" not found.`);
    }
    const updated = { ...this.quotations[idx], status };
    this.quotations[idx] = updated;
    return updated;
  }

  convertQuotationToInvoice(id: string, user?: AuthUser | null): InvoiceItem {
    const qIdx = this.quotations.findIndex((q) => q.id === id);
    if (qIdx === -1) {
      throw new Error(`Quotation with id "${id}" not found.`);
    }
    const q = this.quotations[qIdx];
    const seq = (this.invoices.length + 1).toString().padStart(4, '0');
    const invoiceNumber = `INV-${new Date().getFullYear()}-${seq}`;
    const now = new Date().toISOString();
    const today = now.split('T')[0];
    const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const lines = q.lines.map((l, idx) => ({
      id: `line-inv-${Date.now()}-${idx + 1}`,
      lineNumber: idx + 1,
      itemDescription: l.itemDescription,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountAmount: l.discountAmount,
      taxRate: l.taxRate,
      taxAmount: l.taxAmount,
      lineTotal: l.lineTotal,
      revenueLedgerId: 'preview-ldr-4010',
      revenueLedgerName: 'Enterprise Software & Service Revenue',
    }));

    const newInvoice: InvoiceItem = {
      id: `preview-inv-${Date.now()}`,
      companyId: 'preview-company-id',
      invoiceNumber,
      quotationId: q.id,
      customerId: q.customerId,
      customerName: q.customerName,
      customerEmail: q.customerEmail,
      customerPhone: q.customerPhone,
      customerAddress: q.customerAddress,
      customerTaxId: null,
      invoiceDate: today,
      dueDate,
      status: 'DRAFT',
      currency: 'USD',
      subtotal: q.subtotal,
      discountTotal: q.discountTotal,
      taxTotal: q.taxTotal,
      total: q.total,
      amountPaid: '0.0000',
      balanceDue: q.total,
      notes: q.notes,
      terms: q.terms,
      documentTitle: 'Commercial Sales Invoice',
      journalEntryId: null,
      journalVoucherNumber: null,
      issuedAt: null,
      issuedByUserName: null,
      voidedAt: null,
      voidedByUserName: null,
      voidReason: null,
      createdByUserName: user?.fullName || 'Preview Admin',
      createdAt: now,
      lines,
    };

    this.invoices = [newInvoice, ...this.invoices];
    this.quotations[qIdx] = {
      ...q,
      status: 'ACCEPTED',
      convertedToInvoiceId: newInvoice.id,
    };
    return newInvoice;
  }

  // ==========================================
  // In-Memory Invoices (Preview Exploration)
  // ==========================================

  getInvoices(filters?: {
    status?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
    customerId?: string;
  }): InvoiceItem[] {
    let result = [...this.invoices];
    if (filters?.customerId) {
      result = result.filter((i) => i.customerId === filters.customerId);
    }
    if (filters?.status && filters.status !== 'ALL') {
      result = result.filter((i) => i.status === filters.status);
    }
    if (filters?.fromDate) {
      result = result.filter((i) => i.invoiceDate >= filters.fromDate!);
    }
    if (filters?.toDate) {
      result = result.filter((i) => i.invoiceDate <= filters.toDate!);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase().trim();
      result = result.filter(
        (item) =>
          item.invoiceNumber.toLowerCase().includes(q) ||
          item.customerName.toLowerCase().includes(q) ||
          (item.documentTitle && item.documentTitle.toLowerCase().includes(q))
      );
    }
    return result;
  }

  createInvoice(input: CreateInvoiceRequest, user?: AuthUser | null): InvoiceItem {
    const seq = (this.invoices.length + 1).toString().padStart(4, '0');
    const invoiceNumber = `INV-${new Date().getFullYear()}-${seq}`;
    let subtotalNum = 0;
    let discNum = 0;
    let taxNum = 0;

    const lines = input.lines.map((l, idx) => {
      const qty = parseFloat(String(l.quantity) || '0');
      const unit = parseFloat(String(l.unitPrice) || '0');
      const disc = parseFloat(String(l.discountAmount) || '0');
      const rate = parseFloat(String(l.taxRate) || '0');
      const base = Math.max(0, qty * unit - disc);
      const tax = base * (rate / 100);
      const lineTot = base + tax;

      subtotalNum += qty * unit;
      discNum += disc;
      taxNum += tax;

      const revLedger = l.revenueLedgerId
        ? this.accountLedgers.find((al) => al.id === l.revenueLedgerId)
        : this.accountLedgers.find((al) => al.rootType === 'INCOME');

      return {
        id: `line-inv-${Date.now()}-${idx + 1}`,
        lineNumber: idx + 1,
        itemDescription: l.itemDescription.trim(),
        quantity: qty.toFixed(4),
        unitPrice: unit.toFixed(4),
        discountAmount: disc.toFixed(4),
        taxRate: rate.toFixed(4),
        taxAmount: tax.toFixed(4),
        lineTotal: lineTot.toFixed(4),
        revenueLedgerId: revLedger ? revLedger.id : null,
        revenueLedgerName: revLedger ? revLedger.name : null,
      };
    });

    const totalNum = subtotalNum - discNum + taxNum;
    const now = new Date().toISOString();

    const newInvoice: InvoiceItem = {
      id: `preview-inv-${Date.now()}`,
      companyId: 'preview-company-id',
      invoiceNumber,
      quotationId: input.quotationId || null,
      customerId: input.customerId || null,
      customerName: input.customerName.trim(),
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      customerAddress: input.customerAddress || null,
      customerTaxId: input.customerTaxId || null,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      status: 'DRAFT',
      currency: 'USD',
      subtotal: subtotalNum.toFixed(4),
      discountTotal: discNum.toFixed(4),
      taxTotal: taxNum.toFixed(4),
      total: totalNum.toFixed(4),
      amountPaid: '0.0000',
      balanceDue: totalNum.toFixed(4),
      notes: input.notes || null,
      terms: input.terms || null,
      documentTitle: input.documentTitle || 'Commercial Sales Invoice',
      journalEntryId: null,
      journalVoucherNumber: null,
      issuedAt: null,
      issuedByUserName: null,
      voidedAt: null,
      voidedByUserName: null,
      voidReason: null,
      createdByUserName: user?.fullName || 'Preview Admin',
      createdAt: now,
      lines,
    };

    this.invoices = [newInvoice, ...this.invoices];
    return newInvoice;
  }

  issueInvoice(
    id: string,
    options?: {
      receivablesLedgerId?: string;
      revenueLedgerId?: string;
      taxPayableLedgerId?: string;
    },
    user?: AuthUser | null
  ): InvoiceItem {
    const idx = this.invoices.findIndex((inv) => inv.id === id);
    if (idx === -1) {
      throw new Error(`Invoice with id "${id}" not found.`);
    }
    const invoice = this.invoices[idx];
    const now = new Date().toISOString();

    const arLedger =
      (options?.receivablesLedgerId
        ? this.accountLedgers.find((l) => l.id === options.receivablesLedgerId)
        : this.accountLedgers.find((l) => l.name.toLowerCase().includes('receivable'))) ||
      this.accountLedgers[0] ||
      PREVIEW_ACCOUNT_LEDGERS[4];

    const revLedger =
      (options?.revenueLedgerId
        ? this.accountLedgers.find((l) => l.id === options.revenueLedgerId)
        : this.accountLedgers.find((l) => l.rootType === 'INCOME')) ||
      this.accountLedgers[0] ||
      PREVIEW_ACCOUNT_LEDGERS[9];

    // Create posted journal entry for invoice
    const jVoucher = this.createJournal(
      {
        entryDate: invoice.invoiceDate,
        narration: `Sales Invoice ${invoice.invoiceNumber} to ${invoice.customerName}`,
        reference: invoice.invoiceNumber,
        lines: [
          {
            ledgerId: arLedger.id,
            debit: invoice.total,
            credit: '0.0000',
            description: `Trade receivable for ${invoice.invoiceNumber}`,
          },
          {
            ledgerId: revLedger.id,
            debit: '0.0000',
            credit: invoice.total,
            description: `Revenue from invoice ${invoice.invoiceNumber}`,
          },
        ],
        autoPost: true,
      },
      user
    );

    const updated: InvoiceItem = {
      ...invoice,
      status: 'ISSUED',
      issuedAt: now,
      issuedByUserName: user?.fullName || 'Preview Admin',
      journalEntryId: jVoucher.id,
      journalVoucherNumber: jVoucher.voucherNumber,
    };
    this.invoices[idx] = updated;
    return updated;
  }

  voidInvoice(id: string, reason?: string, user?: AuthUser | null): InvoiceItem {
    const idx = this.invoices.findIndex((inv) => inv.id === id);
    if (idx === -1) {
      throw new Error(`Invoice with id "${id}" not found.`);
    }
    const invoice = this.invoices[idx];
    const now = new Date().toISOString();

    if (invoice.journalEntryId) {
      try {
        this.reverseJournal(
          invoice.journalEntryId,
          reason || 'Invoice voided in preview mode',
          user
        );
      } catch {
        // journal might already be reversed
      }
    }

    const updated: InvoiceItem = {
      ...invoice,
      status: 'VOID',
      voidedAt: now,
      voidedByUserName: user?.fullName || 'Preview Admin',
      voidReason: reason || 'Voided in preview demo',
    };
    this.invoices[idx] = updated;
    return updated;
  }

  // ==========================================
  // In-Memory Customer Receipts (Preview Exploration)
  // ==========================================

  getReceipts(filters?: {
    status?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
  }): CustomerReceiptItem[] {
    let result = [...this.receipts];
    if (filters?.status && filters.status !== 'ALL') {
      result = result.filter((r) => r.status === filters.status);
    }
    if (filters?.fromDate) {
      result = result.filter((r) => r.receiptDate >= filters.fromDate!);
    }
    if (filters?.toDate) {
      result = result.filter((r) => r.receiptDate <= filters.toDate!);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase().trim();
      result = result.filter(
        (r) =>
          r.receiptNumber.toLowerCase().includes(q) ||
          r.customerName.toLowerCase().includes(q) ||
          (r.referenceNumber && r.referenceNumber.toLowerCase().includes(q))
      );
    }
    return result;
  }

  createReceipt(
    input: CreateCustomerReceiptRequest,
    user?: AuthUser | null
  ): CustomerReceiptItem {
    const seq = (this.receipts.length + 1).toString().padStart(4, '0');
    const receiptNumber = `CR-${new Date().getFullYear()}-${seq}`;
    const now = new Date().toISOString();

    const customer = this.customers.find((c) => c.id === input.customerId);
    const recLedger = this.accountLedgers.find((l) => l.id === input.receivingLedgerId);
    const arLedger =
      (input.receivableLedgerId
        ? this.accountLedgers.find((l) => l.id === input.receivableLedgerId)
        : customer?.receivableLedgerId
          ? this.accountLedgers.find((l) => l.id === customer.receivableLedgerId)
          : this.accountLedgers.find((l) =>
              l.name.toLowerCase().includes('receivable')
            )) ||
      this.accountLedgers[0] ||
      PREVIEW_ACCOUNT_LEDGERS[4];

    const amountNum = parseFloat(String(input.amount) || '0');
    let totalAlloc = 0;

    const allocations = (input.allocations || []).map((a, idx) => {
      const allocAmt = parseFloat(String(a.amount) || '0');
      totalAlloc += allocAmt;
      const targetInv = this.invoices.find((i) => i.id === a.invoiceId);
      if (targetInv) {
        const curPaid = parseFloat(targetInv.amountPaid || '0') + allocAmt;
        const curBal = Math.max(0, parseFloat(targetInv.balanceDue || '0') - allocAmt);
        targetInv.amountPaid = curPaid.toFixed(4);
        targetInv.balanceDue = curBal.toFixed(4);
        targetInv.status = curBal <= 0.0001 ? 'PAID' : 'PARTIALLY_PAID';
      }
      return {
        id: `alloc-${Date.now()}-${idx + 1}`,
        receiptId: '',
        invoiceId: a.invoiceId,
        invoiceNumber: targetInv?.invoiceNumber || '',
        invoiceTotal: targetInv?.total || '0.0000',
        allocatedAmount: allocAmt.toFixed(4),
      };
    });

    const unallocAmt = Math.max(0, amountNum - totalAlloc);

    // Auto-create and post journal voucher for receipt
    const jVoucher = this.createJournal(
      {
        entryDate: input.receiptDate,
        narration: `Customer payment received from ${customer?.name || 'Customer'}. Ref: ${input.referenceNumber || receiptNumber}`,
        reference: input.referenceNumber || receiptNumber,
        lines: [
          {
            ledgerId: recLedger?.id || this.accountLedgers[0].id,
            debit: amountNum.toFixed(4),
            credit: '0.0000',
            description: `Payment received in ${recLedger?.name || 'Bank/Cash'}`,
          },
          {
            ledgerId: arLedger.id,
            debit: '0.0000',
            credit: amountNum.toFixed(4),
            description: `Accounts receivable settlement for ${customer?.name || 'Customer'}`,
          },
        ],
        autoPost: true,
      },
      user
    );

    const newReceipt: CustomerReceiptItem = {
      id: `preview-rct-${Date.now()}`,
      companyId: 'preview-company-id',
      receiptNumber,
      receiptDate: input.receiptDate,
      customerId: input.customerId,
      customerName: customer?.name || 'Customer',
      amount: amountNum.toFixed(4),
      allocatedTotal: totalAlloc.toFixed(4),
      unallocatedAmount: unallocAmt.toFixed(4),
      paymentMethod: input.paymentMethod,
      referenceNumber: input.referenceNumber || null,
      receivingLedgerId: input.receivingLedgerId,
      receivingLedgerName: recLedger?.name || 'Cash/Bank',
      receivableLedgerId: arLedger.id,
      receivableLedgerName: arLedger.name,
      journalEntryId: jVoucher.id,
      journalVoucherNumber: jVoucher.voucherNumber,
      status: 'POSTED',
      notes: input.notes || null,
      voidedAt: null,
      voidedByUserName: null,
      voidReason: null,
      createdByUserName: user?.fullName || 'Preview Admin',
      createdAt: now,
      allocations: allocations.map((a) => ({
        ...a,
        receiptId: `preview-rct-${Date.now()}`,
      })),
    };

    this.receipts = [newReceipt, ...this.receipts];
    return newReceipt;
  }

  voidReceipt(
    id: string,
    reason?: string,
    user?: AuthUser | null
  ): CustomerReceiptItem {
    const idx = this.receipts.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new Error(`Receipt with id "${id}" not found.`);
    }
    const receipt = this.receipts[idx];
    const now = new Date().toISOString();

    // Restore invoice balances
    for (const alloc of receipt.allocations) {
      const inv = this.invoices.find((i) => i.id === alloc.invoiceId);
      if (inv) {
        const allocNum = parseFloat(alloc.allocatedAmount || '0');
        const curPaid = Math.max(0, parseFloat(inv.amountPaid || '0') - allocNum);
        const curBal = parseFloat(inv.balanceDue || '0') + allocNum;
        inv.amountPaid = curPaid.toFixed(4);
        inv.balanceDue = curBal.toFixed(4);
        inv.status = 'ISSUED';
      }
    }

    // Reverse journal voucher if present
    if (receipt.journalEntryId) {
      try {
        this.reverseJournal(
          receipt.journalEntryId,
          reason || 'Receipt voided in preview mode',
          user
        );
      } catch {
        // journal might already be reversed
      }
    }

    const updated: CustomerReceiptItem = {
      ...receipt,
      status: 'VOID',
      voidedAt: now,
      voidedByUserName: user?.fullName || 'Preview Admin',
      voidReason: reason || 'Voided in preview demo',
    };
    this.receipts[idx] = updated;
    return updated;
  }

  // ==========================================
  // In-Memory Financial Reports (Deterministic Preview)
  // ==========================================

  private classifyPreviewAccount(name: string, groupName?: string): 'CASH' | 'BANK' | 'OTHER' {
    const text = `${name} ${groupName || ''}`.toLowerCase();
    if (
      /\b(receivable|debtor|inventory|stock|equipment|machinery|building|furniture|vehicle|asset\s*clearing|fixed\s*asset|payable|creditor)\b/i.test(
        text
      )
    ) {
      return 'OTHER';
    }
    if (/\b(cash|vault|till|drawer|petty)\b/i.test(text)) {
      return 'CASH';
    }
    if (
      /\b(bank|checking|savings|deposit|current account|treasury|wire|jpmorgan|chase|bofa|citi|wells|barclays|hsbc|svb)\b/i.test(
        text
      )
    ) {
      return 'BANK';
    }
    return 'OTHER';
  }

  private getAllPostedEntries(): Array<{
    id: string;
    voucherNumber: string;
    entryDate: string;
    narration: string;
    reference?: string | null;
    lines: Array<{
      id?: string;
      ledgerId: string;
      ledgerName?: string;
      ledgerCode?: string | null;
      lineNumber: number;
      debit: string;
      credit: string;
      description?: string | null;
    }>;
  }> {
    const jList = this.journals.filter((j) => j.status === 'POSTED' || j.status === 'REVERSED');
    const cList = this.contraEntries
      .filter((c) => c.status === 'POSTED' || c.status === 'REVERSED')
      .map((c) => ({
        id: c.id,
        voucherNumber: c.voucherNumber,
        entryDate: c.entryDate,
        narration: c.narration,
        reference: c.reference,
        lines: c.lines,
      }));
    return [...jList, ...cList];
  }

  getCashOrBankBook(
    bookType: CashBankBookType,
    options?: { ledgerId?: string; fromDate?: string; toDate?: string }
  ): CashBankBookReport {
    const fromDate = options?.fromDate || '1970-01-01';
    const toDate = options?.toDate || '2099-12-31';

    const eligible: CashBankBookEligibleLedger[] = [];
    for (const l of this.accountLedgers) {
      if (l.rootType === 'ASSET') {
        const cat = this.classifyPreviewAccount(l.name, l.groupName);
        if (cat !== 'OTHER') {
          eligible.push({
            id: l.id,
            name: l.name,
            code: l.code ?? null,
            currency: l.currency,
            category: cat,
            currentBalance: l.currentBalance || l.openingBalance,
            currentBalanceType: l.currentBalanceType || l.openingBalanceType,
          });
        }
      }
    }

    let targetLedger: AccountLedgerItem | undefined;
    if (options?.ledgerId) {
      targetLedger = this.accountLedgers.find((l) => l.id === options.ledgerId);
    } else {
      const matchEligible = eligible.find((e) => e.category === bookType);
      if (matchEligible) {
        targetLedger = this.accountLedgers.find((l) => l.id === matchEligible.id);
      } else {
        targetLedger = this.accountLedgers.find((l) => l.rootType === 'ASSET');
      }
    }

    if (!targetLedger) {
      return {
        companyId: 'preview-company-id',
        bookType,
        ledger: null,
        eligibleLedgers: eligible,
        fromDate,
        toDate,
        openingBalance: '0.0000',
        openingBalanceType: 'DEBIT',
        lines: [],
        totalDebit: '0.0000',
        totalCredit: '0.0000',
        closingBalance: '0.0000',
        closingBalanceType: 'DEBIT',
      };
    }

    const allPosted = this.getAllPostedEntries();

    // Opening balance calculation: configured opening balance + transactions before fromDate
    let initialDebit =
      targetLedger.openingBalanceType === 'DEBIT' ? parseFloat(targetLedger.openingBalance) : 0;
    let initialCredit =
      targetLedger.openingBalanceType === 'CREDIT' ? parseFloat(targetLedger.openingBalance) : 0;

    const periodPostings: Array<{
      journalId: string;
      voucherNumber: string;
      entryDate: string;
      reference?: string | null;
      narration: string;
      counterpartyAccount: string;
      counterpartyLedgerId?: string | null;
      debit: number;
      credit: number;
      lineNumber: number;
    }> = [];

    for (const entry of allPosted) {
      const targetLines = entry.lines.filter((l) => l.ledgerId === targetLedger!.id);
      for (const line of targetLines) {
        const d = parseFloat(line.debit || '0');
        const c = parseFloat(line.credit || '0');

        if (entry.entryDate < fromDate) {
          initialDebit += d;
          initialCredit += c;
        } else if (entry.entryDate <= toDate) {
          const opposing = entry.lines.filter((l) => l.ledgerId !== targetLedger!.id);
          let counterpartyAccount = '';
          let counterpartyLedgerId: string | null = null;
          if (opposing.length === 1) {
            counterpartyAccount = opposing[0].ledgerName || 'Opposing Account';
            counterpartyLedgerId = opposing[0].ledgerId;
          } else if (opposing.length > 1) {
            counterpartyAccount = opposing.map((o) => o.ledgerName || 'Account').join(', ');
          } else {
            counterpartyAccount = line.description || entry.narration || targetLedger.name;
          }

          periodPostings.push({
            journalId: entry.id,
            voucherNumber: entry.voucherNumber,
            entryDate: entry.entryDate,
            reference: entry.reference,
            narration: line.description || entry.narration,
            counterpartyAccount,
            counterpartyLedgerId,
            debit: d,
            credit: c,
            lineNumber: line.lineNumber,
          });
        }
      }
    }

    // Sort chronologically
    periodPostings.sort((a, b) => {
      if (a.entryDate !== b.entryDate) return a.entryDate.localeCompare(b.entryDate);
      if (a.voucherNumber !== b.voucherNumber) return a.voucherNumber.localeCompare(b.voucherNumber);
      return a.lineNumber - b.lineNumber;
    });

    const netStart = initialDebit - initialCredit;
    const startingBalance = Math.abs(netStart).toFixed(4);
    const startingBalanceType: BalanceType = netStart >= 0 ? 'DEBIT' : 'CREDIT';

    let currentNetDebit = initialDebit;
    let currentNetCredit = initialCredit;
    let periodTotalDebit = 0;
    let periodTotalCredit = 0;

    const reportLines: CashBankBookLine[] = [];

    for (const post of periodPostings) {
      periodTotalDebit += post.debit;
      periodTotalCredit += post.credit;

      currentNetDebit += post.debit;
      currentNetCredit += post.credit;

      const net = currentNetDebit - currentNetCredit;
      const runningBalance = Math.abs(net).toFixed(4);
      const runningBalanceType: BalanceType = net >= 0 ? 'DEBIT' : 'CREDIT';

      reportLines.push({
        journalId: post.journalId,
        voucherNumber: post.voucherNumber,
        entryDate: post.entryDate,
        reference: post.reference,
        narration: post.narration,
        counterpartyAccount: post.counterpartyAccount,
        counterpartyLedgerId: post.counterpartyLedgerId,
        debit: post.debit.toFixed(4),
        credit: post.credit.toFixed(4),
        runningBalance,
        runningBalanceType,
      });
    }

    const finalNet = currentNetDebit - currentNetCredit;
    const closingBalance = Math.abs(finalNet).toFixed(4);
    const closingBalanceType: BalanceType = finalNet >= 0 ? 'DEBIT' : 'CREDIT';

    return {
      companyId: 'preview-company-id',
      bookType,
      ledger: targetLedger,
      eligibleLedgers: eligible,
      fromDate,
      toDate,
      openingBalance: startingBalance,
      openingBalanceType: startingBalanceType,
      lines: reportLines,
      totalDebit: periodTotalDebit.toFixed(4),
      totalCredit: periodTotalCredit.toFixed(4),
      closingBalance,
      closingBalanceType,
    };
  }

  getCashBook(options?: { ledgerId?: string; fromDate?: string; toDate?: string }): CashBankBookReport {
    return this.getCashOrBankBook('CASH', options);
  }

  getBankBook(options?: { ledgerId?: string; fromDate?: string; toDate?: string }): CashBankBookReport {
    return this.getCashOrBankBook('BANK', options);
  }

  getLedgerStatement(
    ledgerId: string,
    options?: { fromDate?: string; toDate?: string }
  ): LedgerStatementReport {
    const fromDate = options?.fromDate || '1970-01-01';
    const toDate = options?.toDate || '2099-12-31';
    const ledger = this.accountLedgers.find((l) => l.id === ledgerId) || this.accountLedgers[0];
    const isAssetOrExpense = ledger.rootType === 'ASSET' || ledger.rootType === 'EXPENSE';

    let initialDebit =
      ledger.openingBalanceType === 'DEBIT' ? parseFloat(ledger.openingBalance) : 0;
    let initialCredit =
      ledger.openingBalanceType === 'CREDIT' ? parseFloat(ledger.openingBalance) : 0;

    const allPosted = this.getAllPostedEntries();
    const periodLines: Array<{
      journalId: string;
      voucherNumber: string;
      entryDate: string;
      reference?: string | null;
      narration: string;
      debit: number;
      credit: number;
      lineNumber: number;
    }> = [];

    for (const entry of allPosted) {
      const matchLines = entry.lines.filter((l) => l.ledgerId === ledger.id);
      for (const line of matchLines) {
        const d = parseFloat(line.debit || '0');
        const c = parseFloat(line.credit || '0');
        if (entry.entryDate < fromDate) {
          initialDebit += d;
          initialCredit += c;
        } else if (entry.entryDate <= toDate) {
          periodLines.push({
            journalId: entry.id,
            voucherNumber: entry.voucherNumber,
            entryDate: entry.entryDate,
            reference: entry.reference,
            narration: line.description || entry.narration,
            debit: d,
            credit: c,
            lineNumber: line.lineNumber,
          });
        }
      }
    }

    periodLines.sort((a, b) => {
      if (a.entryDate !== b.entryDate) return a.entryDate.localeCompare(b.entryDate);
      if (a.voucherNumber !== b.voucherNumber) return a.voucherNumber.localeCompare(b.voucherNumber);
      return a.lineNumber - b.lineNumber;
    });

    const netStart = isAssetOrExpense ? initialDebit - initialCredit : initialCredit - initialDebit;
    const startBalType: BalanceType = netStart >= 0 ? (isAssetOrExpense ? 'DEBIT' : 'CREDIT') : isAssetOrExpense ? 'CREDIT' : 'DEBIT';

    let curDebit = initialDebit;
    let curCredit = initialCredit;
    let periodD = 0;
    let periodC = 0;

    const statementLines: LedgerStatementLine[] = [];
    for (const p of periodLines) {
      periodD += p.debit;
      periodC += p.credit;
      curDebit += p.debit;
      curCredit += p.credit;

      const net = isAssetOrExpense ? curDebit - curCredit : curCredit - curDebit;
      const runningBalanceType: BalanceType = net >= 0 ? (isAssetOrExpense ? 'DEBIT' : 'CREDIT') : isAssetOrExpense ? 'CREDIT' : 'DEBIT';

      statementLines.push({
        journalId: p.journalId,
        voucherNumber: p.voucherNumber,
        entryDate: p.entryDate,
        narration: p.narration,
        reference: p.reference,
        debit: p.debit.toFixed(4),
        credit: p.credit.toFixed(4),
        runningBalance: Math.abs(net).toFixed(4),
        runningBalanceType,
      });
    }

    const finalNet = isAssetOrExpense ? curDebit - curCredit : curCredit - curDebit;
    const closeType: BalanceType = finalNet >= 0 ? (isAssetOrExpense ? 'DEBIT' : 'CREDIT') : isAssetOrExpense ? 'CREDIT' : 'DEBIT';

    return {
      ledger,
      fromDate,
      toDate,
      openingBalance: Math.abs(netStart).toFixed(4),
      openingBalanceType: startBalType,
      lines: statementLines,
      totalDebit: periodD.toFixed(4),
      totalCredit: periodC.toFixed(4),
      closingBalance: Math.abs(finalNet).toFixed(4),
      closingBalanceType: closeType,
    };
  }

  getTrialBalance(options?: { fromDate?: string; toDate?: string }): TrialBalanceReport {
    const fromDate = options?.fromDate || '1970-01-01';
    const toDate = options?.toDate || '2099-12-31';
    const allPosted = this.getAllPostedEntries();

    let grandOpenD = 0;
    let grandOpenC = 0;
    let grandPeriodD = 0;
    let grandPeriodC = 0;
    let grandCloseD = 0;
    let grandCloseC = 0;

    const rows: TrialBalanceRow[] = [];

    for (const ledger of this.accountLedgers) {
      const isDebitNature = ledger.rootType === 'ASSET' || ledger.rootType === 'EXPENSE';
      let opD = ledger.openingBalanceType === 'DEBIT' ? parseFloat(ledger.openingBalance) : 0;
      let opC = ledger.openingBalanceType === 'CREDIT' ? parseFloat(ledger.openingBalance) : 0;
      let pD = 0;
      let pC = 0;

      for (const entry of allPosted) {
        if (entry.entryDate > toDate) continue;
        const matchingLines = entry.lines.filter((l) => l.ledgerId === ledger.id);
        for (const line of matchingLines) {
          const d = parseFloat(line.debit || '0');
          const c = parseFloat(line.credit || '0');
          if (entry.entryDate < fromDate) {
            opD += d;
            opC += c;
          } else {
            pD += d;
            pC += c;
          }
        }
      }

      const totalD = opD + pD;
      const totalC = opC + pC;

      let closeD = 0;
      let closeC = 0;
      if (isDebitNature) {
        const net = totalD - totalC;
        if (net >= 0) closeD = net;
        else closeC = Math.abs(net);
      } else {
        const net = totalC - totalD;
        if (net >= 0) closeC = net;
        else closeD = Math.abs(net);
      }

      grandOpenD += opD;
      grandOpenC += opC;
      grandPeriodD += pD;
      grandPeriodC += pC;
      grandCloseD += closeD;
      grandCloseC += closeC;

      rows.push({
        ledgerId: ledger.id,
        code: ledger.code || '',
        name: ledger.name,
        rootType: ledger.rootType || 'ASSET',
        groupName: ledger.groupName || 'Assets',
        openingDebit: opD.toFixed(4),
        openingCredit: opC.toFixed(4),
        periodDebit: pD.toFixed(4),
        periodCredit: pC.toFixed(4),
        closingDebit: closeD.toFixed(4),
        closingCredit: closeC.toFixed(4),
      });
    }

    const isBalanced =
      Math.abs(grandPeriodD - grandPeriodC) < 0.0001 && Math.abs(grandCloseD - grandCloseC) < 0.0001;

    return {
      companyId: 'preview-company-id',
      fromDate,
      toDate,
      rows,
      totalOpeningDebit: grandOpenD.toFixed(4),
      totalOpeningCredit: grandOpenC.toFixed(4),
      totalPeriodDebit: grandPeriodD.toFixed(4),
      totalPeriodCredit: grandPeriodC.toFixed(4),
      totalClosingDebit: grandCloseD.toFixed(4),
      totalClosingCredit: grandCloseC.toFixed(4),
      isBalanced,
      reconciliationStatus: isBalanced ? 'BALANCED' : 'DISCREPANCY',
      imbalanceAmount: Math.abs(grandCloseD - grandCloseC).toFixed(4),
    };
  }

  getProfitAndLoss(options?: { fromDate?: string; toDate?: string }): ProfitAndLossReport {
    const tb = this.getTrialBalance(options);
    const incomeRows = tb.rows.filter((r) => r.rootType === 'INCOME');
    const expenseRows = tb.rows.filter((r) => r.rootType === 'EXPENSE');

    let totalIncomeNum = 0;
    const incomeGroups = [
      {
        groupName: 'Operating Revenue',
        ledgers: incomeRows.map((r) => {
          const amt = parseFloat(r.closingCredit) - parseFloat(r.closingDebit);
          totalIncomeNum += amt;
          return { name: r.name, code: r.code, amount: amt.toFixed(4) };
        }),
        subtotal: totalIncomeNum.toFixed(4),
      },
    ];

    let totalExpenseNum = 0;
    const expenseGroups = [
      {
        groupName: 'Operating Expenses',
        ledgers: expenseRows.map((r) => {
          const amt = parseFloat(r.closingDebit) - parseFloat(r.closingCredit);
          totalExpenseNum += amt;
          return { name: r.name, code: r.code, amount: amt.toFixed(4) };
        }),
        subtotal: totalExpenseNum.toFixed(4),
      },
    ];

    const netProfitNum = totalIncomeNum - totalExpenseNum;

    return {
      companyId: 'preview-company-id',
      fromDate: tb.fromDate,
      toDate: tb.toDate,
      incomeGroups,
      totalIncome: totalIncomeNum.toFixed(4),
      expenseGroups,
      totalExpense: totalExpenseNum.toFixed(4),
      netProfit: netProfitNum.toFixed(4),
      isProfitable: netProfitNum >= 0,
    };
  }

  getBalanceSheet(options?: { asOfDate?: string }): BalanceSheetReport {
    const asOfDate = options?.asOfDate || new Date().toISOString().split('T')[0];
    const tb = this.getTrialBalance({ toDate: asOfDate });
    const pnl = this.getProfitAndLoss({ toDate: asOfDate });

    const assetRows = tb.rows.filter((r) => r.rootType === 'ASSET');
    const liabilityRows = tb.rows.filter((r) => r.rootType === 'LIABILITY');
    const equityRows = tb.rows.filter((r) => r.rootType === 'EQUITY');

    let totalAssetsNum = 0;
    const assetGroups = [
      {
        groupName: 'Current Assets',
        ledgers: assetRows.map((r) => {
          const amt = parseFloat(r.closingDebit) - parseFloat(r.closingCredit);
          totalAssetsNum += amt;
          return { name: r.name, code: r.code, amount: amt.toFixed(4) };
        }),
        subtotal: totalAssetsNum.toFixed(4),
      },
    ];

    let totalLiabilitiesNum = 0;
    const liabilityGroups = [
      {
        groupName: 'Current Liabilities',
        ledgers: liabilityRows.map((r) => {
          const amt = parseFloat(r.closingCredit) - parseFloat(r.closingDebit);
          totalLiabilitiesNum += amt;
          return { name: r.name, code: r.code, amount: amt.toFixed(4) };
        }),
        subtotal: totalLiabilitiesNum.toFixed(4),
      },
    ];

    let baseEquityNum = 0;
    const equityGroups = [
      {
        groupName: 'Owner Equity',
        ledgers: equityRows.map((r) => {
          const amt = parseFloat(r.closingCredit) - parseFloat(r.closingDebit);
          baseEquityNum += amt;
          return { name: r.name, code: r.code, amount: amt.toFixed(4) };
        }),
        subtotal: baseEquityNum.toFixed(4),
      },
    ];

    const currentPeriodProfit = parseFloat(pnl.netProfit);
    const totalEquity = baseEquityNum + currentPeriodProfit;
    const totalLiabilitiesAndEquity = totalLiabilitiesNum + totalEquity;
    const isBalanced = Math.abs(totalAssetsNum - totalLiabilitiesAndEquity) < 0.0001;

    return {
      companyId: 'preview-company-id',
      asOfDate,
      assetGroups,
      totalAssets: totalAssetsNum.toFixed(4),
      liabilityGroups,
      totalLiabilities: totalLiabilitiesNum.toFixed(4),
      equityGroups,
      currentPeriodProfit: currentPeriodProfit.toFixed(4),
      totalEquity: totalEquity.toFixed(4),
      totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toFixed(4),
      isBalanced,
      discrepancy: Math.abs(totalAssetsNum - totalLiabilitiesAndEquity).toFixed(4),
    };
  }

  validateOpeningBalances(): OpeningBalanceValidationResult {
    let sumD = 0;
    let sumC = 0;
    let count = 0;
    for (const l of this.accountLedgers) {
      const val = parseFloat(l.openingBalance);
      if (val > 0) {
        count++;
        if (l.openingBalanceType === 'DEBIT') sumD += val;
        else sumC += val;
      }
    }
    const diff = Math.abs(sumD - sumC);
    return {
      isBalanced: diff < 0.0001,
      totalOpeningDebit: sumD.toFixed(4),
      totalOpeningCredit: sumC.toFixed(4),
      discrepancy: diff.toFixed(4),
      unbalancedLedgersCount: count,
    };
  }

  /**
   * Reset store to initial state (useful for test isolation)
   */
  reset(): void {
    this.users = [{ ...INITIAL_PREVIEW_ADMIN }];
    this.companySettings = { salesInvoiceEnabled: true };
    this.contraEntries = [...INITIAL_PREVIEW_CONTRA_ENTRIES];
    this.journals = [...PREVIEW_JOURNALS];
    this.customers = [...PREVIEW_CUSTOMERS];
    this.invoices = [...PREVIEW_INVOICES];
    this.receipts = [...PREVIEW_RECEIPTS];
    this.quotations = [...PREVIEW_QUOTATIONS];
    this.accountGroups = [...PREVIEW_ACCOUNT_GROUPS];
    this.accountLedgers = [...PREVIEW_ACCOUNT_LEDGERS];
  }
}

export const previewStore = new PreviewUserStore();
