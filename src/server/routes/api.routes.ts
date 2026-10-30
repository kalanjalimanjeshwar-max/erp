import { Router } from 'express';
import { HealthController } from '../controllers/health.controller.js';
import { SetupController } from '../controllers/setup.controller.js';
import { AuthController } from '../controllers/auth.controller.js';
import { PreviewAuthController } from '../controllers/preview-auth.controller.js';
import { UserController } from '../controllers/user.controller.js';
import { CompanyController } from '../controllers/company.controller.js';
import { PermissionController } from '../controllers/permission.controller.js';
import { AuditController } from '../controllers/audit.controller.js';
import { AccountingController } from '../controllers/accounting.controller.js';
import { ContraController } from '../controllers/contra.controller.js';
import { CustomerController } from '../controllers/customer.controller.js';
import { QuotationController } from '../controllers/quotation.controller.js';
import { BillingController } from '../controllers/billing.controller.js';
import { ReceiptController } from '../controllers/receipt.controller.js';
import { DepartmentController } from '../controllers/department.controller.js';
import { DesignationController } from '../controllers/designation.controller.js';
import { EmployeeController } from '../controllers/employee.controller.js';
import { ShiftController } from '../controllers/shift.controller.js';
import { AttendanceController } from '../controllers/attendance.controller.js';
import { LeaveController } from '../controllers/leave.controller.js';
import { PayrollController } from '../controllers/payroll.controller.js';
import { BiometricController } from '../controllers/biometric.controller.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';
import { requireDeviceAuth } from '../middleware/device-auth.middleware.js';

export const apiRouter = Router();

// 1. Health & Diagnostics Endpoints (Public)
apiRouter.get('/health', HealthController.getHealth);
apiRouter.get('/ready', HealthController.getReadiness);

// 2. Initial Setup & Bootstrap Endpoints
apiRouter.get('/setup/status', SetupController.getStatus);
apiRouter.post('/setup/bootstrap', SetupController.bootstrap);

// 3. Authentication Endpoints
apiRouter.post('/auth/login', AuthController.login);
apiRouter.post('/auth/logout', requireAuth, AuthController.logout);
apiRouter.get('/auth/me', requireAuth, AuthController.getMe);
apiRouter.post('/auth/preview-login', PreviewAuthController.login);
apiRouter.get('/auth/preview-status', PreviewAuthController.getStatus);

// 4. User Administration Endpoints (Server-enforced permissions)
apiRouter.get('/users', requireAuth, requirePermission('USER', 'VIEW'), UserController.list);
apiRouter.post('/users', requireAuth, requirePermission('USER', 'CREATE'), UserController.create);
apiRouter.patch('/users/:id/role', requireAuth, requirePermission('USER', 'EDIT'), UserController.updateRole);
apiRouter.patch('/users/:id/status', requireAuth, requirePermission('USER', 'DEACTIVATE'), UserController.updateStatus);
apiRouter.post('/users/:id/reset-password', requireAuth, requirePermission('USER', 'EDIT'), UserController.resetPassword);

// 5. Company Administration Endpoints
apiRouter.get('/company/profile', requireAuth, requirePermission('COMPANY', 'VIEW'), CompanyController.getProfile);
apiRouter.patch('/company/profile', requireAuth, requirePermission('COMPANY', 'EDIT'), CompanyController.updateProfile);

// 6. Permission Matrix Endpoints
apiRouter.get('/permissions/matrix', requireAuth, requirePermission('ROLE_PERMISSION', 'VIEW'), PermissionController.getMatrix);
apiRouter.patch('/permissions/override', requireAuth, requirePermission('ROLE_PERMISSION', 'EDIT'), PermissionController.setOverride);

// 7. Audit Trail Endpoints (Company-isolated)
apiRouter.get('/audit-logs', requireAuth, requirePermission('AUDIT_LOG', 'VIEW'), AuditController.list);

// 8. Core Accounting & Chart of Accounts Endpoints (Phase 4)
// Account Groups
apiRouter.get('/accounting/groups', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.listGroups);
apiRouter.post('/accounting/groups', requireAuth, requirePermission('ACCOUNTING', 'CREATE'), AccountingController.createGroup);

// Account Ledgers
apiRouter.get('/accounting/ledgers', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.listLedgers);
apiRouter.post('/accounting/ledgers', requireAuth, requirePermission('ACCOUNTING', 'CREATE'), AccountingController.createLedger);
apiRouter.patch('/accounting/ledgers/:id', requireAuth, requirePermission('ACCOUNTING', 'EDIT'), AccountingController.updateLedger);
apiRouter.patch('/accounting/ledgers/:id/status', requireAuth, requirePermission('ACCOUNTING', 'EDIT'), AccountingController.toggleLedgerStatus);

// Double-Entry Journals
apiRouter.get('/accounting/journals', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.listJournals);
apiRouter.post('/accounting/journals', requireAuth, requirePermission('ACCOUNTING', 'CREATE'), AccountingController.createJournal);
apiRouter.get('/accounting/journals/:id', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.getJournal);
apiRouter.post('/accounting/journals/:id/post', requireAuth, requirePermission('ACCOUNTING', 'APPROVE'), AccountingController.postJournal);
apiRouter.post('/accounting/journals/:id/reverse', requireAuth, requirePermission('ACCOUNTING', 'EDIT'), AccountingController.reverseJournal);

// Contra Entry Vouchers (Internal Cash & Bank Transfers)
apiRouter.get('/accounting/contra', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), ContraController.list);
apiRouter.get('/contra', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), ContraController.list);
apiRouter.get('/accounting/contra/:id', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), ContraController.getById);
apiRouter.get('/contra/:id', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), ContraController.getById);
apiRouter.post('/accounting/contra', requireAuth, requirePermission('ACCOUNTING', 'CREATE'), ContraController.create);
apiRouter.post('/contra', requireAuth, requirePermission('ACCOUNTING', 'CREATE'), ContraController.create);
apiRouter.post('/accounting/contra/:id/post', requireAuth, requirePermission('ACCOUNTING', 'APPROVE'), ContraController.post);
apiRouter.post('/contra/:id/post', requireAuth, requirePermission('ACCOUNTING', 'APPROVE'), ContraController.post);
apiRouter.post('/accounting/contra/:id/reverse', requireAuth, requirePermission('ACCOUNTING', 'EDIT'), ContraController.reverse);
apiRouter.post('/contra/:id/reverse', requireAuth, requirePermission('ACCOUNTING', 'EDIT'), ContraController.reverse);

// Accounting Reports & Opening Balances
apiRouter.get('/accounting/opening-balances/validate', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.validateOpeningBalances);
apiRouter.get('/accounting/reports/ledger-statement/:ledgerId', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.getLedgerStatement);
apiRouter.get('/accounting/reports/trial-balance', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.getTrialBalance);
apiRouter.get('/accounting/reports/profit-and-loss', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.getProfitAndLoss);
apiRouter.get('/accounting/reports/balance-sheet', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.getBalanceSheet);
apiRouter.get('/accounting/reports/cash-book', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.getCashBook);
apiRouter.get('/accounting/reports/bank-book', requireAuth, requirePermission('ACCOUNTING', 'VIEW'), AccountingController.getBankBook);

// 9. Customer Management Endpoints (Phase 5)
apiRouter.get('/customers', requireAuth, requirePermission('CUSTOMER', 'VIEW'), CustomerController.list);
apiRouter.get('/customers/:id', requireAuth, requirePermission('CUSTOMER', 'VIEW'), CustomerController.getById);
apiRouter.post('/customers', requireAuth, requirePermission('CUSTOMER', 'CREATE'), CustomerController.create);
apiRouter.patch('/customers/:id', requireAuth, requirePermission('CUSTOMER', 'EDIT'), CustomerController.update);

// 10. Quotations Endpoints (Accounting-Neutral, Phase 5)
apiRouter.get('/quotations', requireAuth, requirePermission('QUOTATION', 'VIEW'), QuotationController.list);
apiRouter.get('/quotations/:id', requireAuth, requirePermission('QUOTATION', 'VIEW'), QuotationController.getById);
apiRouter.post('/quotations', requireAuth, requirePermission('QUOTATION', 'CREATE'), QuotationController.create);
apiRouter.patch('/quotations/:id', requireAuth, requirePermission('QUOTATION', 'EDIT'), QuotationController.update);
apiRouter.patch('/quotations/:id/status', requireAuth, requirePermission('QUOTATION', 'EDIT'), QuotationController.updateStatus);
apiRouter.post('/quotations/:id/convert-to-invoice', requireAuth, requirePermission('INVOICE', 'CREATE'), QuotationController.convertToInvoice);

// 11. Invoices & Billing Endpoints (Accounting Integrated, Phase 5)
apiRouter.get('/invoices', requireAuth, requirePermission('INVOICE', 'VIEW'), BillingController.list);
apiRouter.get('/invoices/:id', requireAuth, requirePermission('INVOICE', 'VIEW'), BillingController.getById);
apiRouter.post('/invoices', requireAuth, requirePermission('INVOICE', 'CREATE'), BillingController.create);
apiRouter.post('/invoices/:id/issue', requireAuth, requirePermission('INVOICE', 'APPROVE'), BillingController.issue);
apiRouter.post('/invoices/:id/void', requireAuth, requirePermission('INVOICE', 'EDIT'), BillingController.void);

// 12. Customer Receipts Endpoints (Accounting Integrated, Phase 5)
apiRouter.get('/receipts', requireAuth, requirePermission('RECEIPT', 'VIEW'), ReceiptController.list);
apiRouter.get('/receipts/:id', requireAuth, requirePermission('RECEIPT', 'VIEW'), ReceiptController.getById);
apiRouter.post('/receipts', requireAuth, requirePermission('RECEIPT', 'CREATE'), ReceiptController.create);
apiRouter.post('/receipts/:id/void', requireAuth, requirePermission('RECEIPT', 'APPROVE'), ReceiptController.void);

// 13. Department Master Endpoints (Phase 6)
apiRouter.get('/departments', requireAuth, requirePermission('DEPARTMENT', 'VIEW'), DepartmentController.list);
apiRouter.get('/departments/:id', requireAuth, requirePermission('DEPARTMENT', 'VIEW'), DepartmentController.getById);
apiRouter.post('/departments', requireAuth, requirePermission('DEPARTMENT', 'CREATE'), DepartmentController.create);
apiRouter.patch('/departments/:id', requireAuth, requirePermission('DEPARTMENT', 'EDIT'), DepartmentController.update);
apiRouter.post('/departments/:id/deactivate', requireAuth, requirePermission('DEPARTMENT', 'DEACTIVATE'), DepartmentController.deactivate);

// 14. Designation Master Endpoints (Phase 6)
apiRouter.get('/designations', requireAuth, requirePermission('DESIGNATION', 'VIEW'), DesignationController.list);
apiRouter.get('/designations/:id', requireAuth, requirePermission('DESIGNATION', 'VIEW'), DesignationController.getById);
apiRouter.post('/designations', requireAuth, requirePermission('DESIGNATION', 'CREATE'), DesignationController.create);
apiRouter.patch('/designations/:id', requireAuth, requirePermission('DESIGNATION', 'EDIT'), DesignationController.update);
apiRouter.post('/designations/:id/deactivate', requireAuth, requirePermission('DESIGNATION', 'DEACTIVATE'), DesignationController.deactivate);

// 15. Employee Management & Salary Structure Endpoints (Phase 6)
apiRouter.get('/employees', requireAuth, requirePermission('EMPLOYEE', 'VIEW'), EmployeeController.list);
apiRouter.get('/employees/self', requireAuth, EmployeeController.getSelf);
apiRouter.get('/employees/:id', requireAuth, EmployeeController.getById);
apiRouter.post('/employees', requireAuth, requirePermission('EMPLOYEE', 'CREATE'), EmployeeController.create);
apiRouter.patch('/employees/:id', requireAuth, requirePermission('EMPLOYEE', 'EDIT'), EmployeeController.update);
apiRouter.post('/employees/:id/deactivate', requireAuth, requirePermission('EMPLOYEE', 'DEACTIVATE'), EmployeeController.deactivate);
apiRouter.post('/employees/:id/login', requireAuth, requirePermission('USER', 'CREATE'), EmployeeController.createLogin);
apiRouter.patch('/employees/:id/login/status', requireAuth, requirePermission('USER', 'EDIT'), EmployeeController.toggleLogin);
apiRouter.post('/employees/:id/ledger', requireAuth, requirePermission('ACCOUNTING', 'CREATE'), EmployeeController.linkLedger);
apiRouter.get('/employees/:id/salaries', requireAuth, EmployeeController.listSalaries);
apiRouter.post('/employees/:id/salaries', requireAuth, requirePermission('EMPLOYEE', 'EDIT'), EmployeeController.createSalaryRevision);

// 16. Shift Management Endpoints (Phase 7.2)
apiRouter.get('/shifts', requireAuth, requirePermission('ATTENDANCE', 'VIEW'), ShiftController.list);
apiRouter.get('/shifts/:id', requireAuth, requirePermission('ATTENDANCE', 'VIEW'), ShiftController.getById);
apiRouter.post('/shifts', requireAuth, requirePermission('ATTENDANCE', 'CREATE'), ShiftController.create);
apiRouter.patch('/shifts/:id', requireAuth, requirePermission('ATTENDANCE', 'EDIT'), ShiftController.update);
apiRouter.post('/shifts/:id/deactivate', requireAuth, requirePermission('ATTENDANCE', 'DEACTIVATE'), ShiftController.deactivate);

// 17. Attendance Management Endpoints (Phase 7.2 & Stage 1.4)
apiRouter.get('/attendance/logout-summary', requireAuth, AttendanceController.getWorkingHoursSummary);
apiRouter.get('/attendance/admin-notifications', requireAuth, AttendanceController.getAdminNotifications);
apiRouter.get('/attendance', requireAuth, requirePermission('ATTENDANCE', 'VIEW'), AttendanceController.list);
apiRouter.get('/attendance/:id', requireAuth, requirePermission('ATTENDANCE', 'VIEW'), AttendanceController.getById);
apiRouter.post('/attendance', requireAuth, requirePermission('ATTENDANCE', 'CREATE'), AttendanceController.create);
apiRouter.patch('/attendance/:id', requireAuth, requirePermission('ATTENDANCE', 'EDIT'), AttendanceController.update);

// 18. Leave Management Endpoints (Phase 7.2)
// Leave Types
apiRouter.get('/leave/types', requireAuth, requirePermission('ATTENDANCE', 'VIEW'), LeaveController.listTypes);
apiRouter.get('/leave/types/:id', requireAuth, requirePermission('ATTENDANCE', 'VIEW'), LeaveController.getTypeById);
apiRouter.post('/leave/types', requireAuth, requirePermission('ATTENDANCE', 'CREATE'), LeaveController.createType);
apiRouter.patch('/leave/types/:id', requireAuth, requirePermission('ATTENDANCE', 'EDIT'), LeaveController.updateType);
apiRouter.post('/leave/types/:id/deactivate', requireAuth, requirePermission('ATTENDANCE', 'DEACTIVATE'), LeaveController.deactivateType);

// Leave Requests
apiRouter.get('/leave/summary', requireAuth, requirePermission('ATTENDANCE', 'VIEW'), LeaveController.getSummary);
apiRouter.get('/leave/requests', requireAuth, requirePermission('ATTENDANCE', 'VIEW'), LeaveController.listRequests);
apiRouter.get('/leave/requests/:id', requireAuth, requirePermission('ATTENDANCE', 'VIEW'), LeaveController.getRequestById);
apiRouter.post('/leave/requests', requireAuth, requirePermission('ATTENDANCE', 'CREATE'), LeaveController.submitRequest);
apiRouter.post('/leave/requests/:id/approve', requireAuth, requirePermission('ATTENDANCE', 'APPROVE'), LeaveController.approveRequest);
apiRouter.post('/leave/requests/:id/reject', requireAuth, requirePermission('ATTENDANCE', 'APPROVE'), LeaveController.rejectRequest);

// 19. Payroll Management & Calculation Endpoints (Phase 7.3)
apiRouter.get('/payroll/periods', requireAuth, requirePermission('PAYROLL', 'VIEW'), PayrollController.listPeriods);
apiRouter.get('/payroll/periods/:id', requireAuth, requirePermission('PAYROLL', 'VIEW'), PayrollController.getPeriodById);
apiRouter.post('/payroll/periods', requireAuth, requirePermission('PAYROLL', 'CREATE'), PayrollController.createPeriod);
apiRouter.post('/payroll/periods/:id/process', requireAuth, requirePermission('PAYROLL', 'EDIT'), PayrollController.processPeriod);
apiRouter.post('/payroll/periods/:id/post', requireAuth, requirePermission('PAYROLL', 'APPROVE'), PayrollController.postPeriod);
apiRouter.post('/payroll/periods/:id/cancel', requireAuth, requirePermission('PAYROLL', 'EDIT'), PayrollController.cancelPeriod);
apiRouter.get('/payroll/periods/:id/payslips', requireAuth, requirePermission('PAYROLL', 'VIEW'), PayrollController.listPayslips);
apiRouter.get('/payroll/payslips/:id', requireAuth, requirePermission('PAYROLL', 'VIEW'), PayrollController.getPayslipById);

// 20. Employee Self-Service Payroll Endpoint (Phase 7.3B)
apiRouter.get('/payroll/my-payslips', requireAuth, PayrollController.listMyPayslips);

// 21. Biometric Hardware LAN Bridge & Terminal Management Endpoints (Phase 8.1)
apiRouter.get('/biometric/devices', requireAuth, requirePermission('BIOMETRIC', 'VIEW'), BiometricController.list);
apiRouter.post('/biometric/devices', requireAuth, requirePermission('BIOMETRIC', 'CREATE'), BiometricController.create);
apiRouter.post('/biometric/devices/:id/deactivate', requireAuth, requirePermission('BIOMETRIC', 'DEACTIVATE'), BiometricController.deactivate);
apiRouter.post('/biometric/devices/:id/rotate-key', requireAuth, requirePermission('BIOMETRIC', 'EDIT'), BiometricController.rotateKey);
apiRouter.post('/biometric/heartbeat', requireDeviceAuth, BiometricController.heartbeat);
apiRouter.post('/biometric/punches', requireDeviceAuth, BiometricController.ingestPunches);

// 22. Biometric Punch Reconciliation & Sync Endpoints (Phase 8.2)
apiRouter.get('/biometric/punches', requireAuth, requirePermission('BIOMETRIC', 'VIEW'), BiometricController.listPunches);
apiRouter.post('/biometric/sync', requireAuth, requirePermission('BIOMETRIC', 'EDIT'), BiometricController.triggerSync);
apiRouter.get('/biometric/sync/summary', requireAuth, requirePermission('BIOMETRIC', 'VIEW'), BiometricController.getSummary);

