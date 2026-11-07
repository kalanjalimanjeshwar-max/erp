import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Database Migration History & Integrity Tests', () => {
  const migrationsDir = path.resolve(import.meta.dirname, '../../prisma/migrations');

  it('should maintain migration_lock.toml targeting postgresql', () => {
    const lockPath = path.join(migrationsDir, 'migration_lock.toml');
    expect(fs.existsSync(lockPath)).toBe(true);

    const lockContent = fs.readFileSync(lockPath, 'utf-8');
    expect(lockContent).toContain('provider = "postgresql"');
  });

  it('should preserve existing initial migration (20261011000000_init)', () => {
    const initMigrationSql = path.join(migrationsDir, '20261011000000_init', 'migration.sql');
    expect(fs.existsSync(initMigrationSql)).toBe(true);

    const content = fs.readFileSync(initMigrationSql, 'utf-8');
    expect(content).toContain('CREATE TABLE "Company"');
    expect(content).toContain('CREATE TABLE "User"');
  });

  it('should include version-controlled Phase 2 migration (20261011120000_core_tenant_foundation)', () => {
    const phase2MigrationSql = path.join(
      migrationsDir,
      '20261011120000_core_tenant_foundation',
      'migration.sql'
    );
    expect(fs.existsSync(phase2MigrationSql)).toBe(true);

    const content = fs.readFileSync(phase2MigrationSql, 'utf-8');
    // Verifies non-destructive DDL
    expect(content).toContain('ALTER TYPE "Role" ADD VALUE IF NOT EXISTS \'VICE_ADMIN\'');
    expect(content).toContain('ALTER TYPE "Role" ADD VALUE IF NOT EXISTS \'EMPLOYEE\'');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "CurrencyConfig"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "FiscalPeriod"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "CompanySetting"');
    expect(content).toContain('ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "correlationId"');
  });

  it('should include version-controlled Phase 3 migration (20261011180000_auth_rbac_company_admin)', () => {
    const phase3MigrationSql = path.join(
      migrationsDir,
      '20261011180000_auth_rbac_company_admin',
      'migration.sql'
    );
    expect(fs.existsSync(phase3MigrationSql)).toBe(true);

    const content = fs.readFileSync(phase3MigrationSql, 'utf-8');
    expect(content).toContain('ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT \'EMPLOYEE\'');
    expect(content).toContain('ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "address"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "RolePermission"');
    expect(content).toContain('RolePermission_companyId_role_module_action_key');
  });

  it('should include version-controlled Phase 4 migration (20261012000000_core_accounting_engine)', () => {
    const phase4MigrationSql = path.join(
      migrationsDir,
      '20261012000000_core_accounting_engine',
      'migration.sql'
    );
    expect(fs.existsSync(phase4MigrationSql)).toBe(true);

    const content = fs.readFileSync(phase4MigrationSql, 'utf-8');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "AccountGroup"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "AccountLedger"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "JournalEntry"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "JournalLine"');
    expect(content).toContain('AccountGroup_companyId_code_key');
    expect(content).toContain('AccountLedger_companyId_name_key');
  });

  it('should include version-controlled Phase 5 migration (20261012120000_quotations_billing_receipts)', () => {
    const phase5MigrationSql = path.join(
      migrationsDir,
      '20261012120000_quotations_billing_receipts',
      'migration.sql'
    );
    expect(fs.existsSync(phase5MigrationSql)).toBe(true);

    const content = fs.readFileSync(phase5MigrationSql, 'utf-8');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Customer"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Quotation"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Invoice"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "CustomerReceipt"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "ReceiptAllocation"');
    expect(content).toContain('Invoice_companyId_invoiceNumber_key');
    expect(content).toContain('CustomerReceipt_companyId_receiptNumber_key');
  });

  it('should include version-controlled Phase 6 migration (20261012180000_employee_management_salary)', () => {
    const phase6MigrationSql = path.join(
      migrationsDir,
      '20261012180000_employee_management_salary',
      'migration.sql'
    );
    expect(fs.existsSync(phase6MigrationSql)).toBe(true);

    const content = fs.readFileSync(phase6MigrationSql, 'utf-8');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Department"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Designation"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Employee"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "SalaryRevision"');
    expect(content).toContain('Employee_companyId_employeeCode_key');
    expect(content).toContain('Employee_userId_key');
    expect(content).toContain('Employee_ledgerId_key');
  });

  it('should include version-controlled Phase 7.1 migration (20261013000000_attendance_shift_leave_payroll)', () => {
    const phase7MigrationSql = path.join(
      migrationsDir,
      '20261013000000_attendance_shift_leave_payroll',
      'migration.sql'
    );
    expect(fs.existsSync(phase7MigrationSql)).toBe(true);

    const content = fs.readFileSync(phase7MigrationSql, 'utf-8');
    expect(content).toContain('CREATE TYPE "AttendanceStatus"');
    expect(content).toContain('CREATE TYPE "AttendanceSource"');
    expect(content).toContain('CREATE TYPE "LeaveStatus"');
    expect(content).toContain('CREATE TYPE "PayrollStatus"');
    expect(content).toContain('CREATE TYPE "PayslipStatus"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Shift"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Attendance"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "LeaveType"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "LeaveRequest"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "PayrollPeriod"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Payslip"');
    expect(content).toContain('Shift_companyId_code_key');
    expect(content).toContain('Attendance_companyId_employeeId_workDate_key');
    expect(content).toContain('LeaveType_companyId_code_key');
    expect(content).toContain('PayrollPeriod_companyId_year_month_key');
    expect(content).toContain('Payslip_payrollPeriodId_employeeId_key');
  });

  it('should include version-controlled Phase 8.1 migration (20261019000000_biometric_terminals_and_raw_punches)', () => {
    const phase8MigrationSql = path.join(
      migrationsDir,
      '20261019000000_biometric_terminals_and_raw_punches',
      'migration.sql'
    );
    expect(fs.existsSync(phase8MigrationSql)).toBe(true);

    const content = fs.readFileSync(phase8MigrationSql, 'utf-8');
    expect(content).toContain('CREATE TYPE "BiometricTerminalStatus"');
    expect(content).toContain('CREATE TYPE "BiometricVerifyType"');
    expect(content).toContain('CREATE TYPE "PunchInOutMode"');
    expect(content).toContain('CREATE TYPE "PunchSyncStatus"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "BiometricTerminal"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "RawPunchLog"');
    expect(content).toContain('BiometricTerminal_companyId_deviceSerialNumber_key');
    expect(content).toContain('BiometricTerminal_apiKeyHash_key');
    expect(content).toContain('RawPunchLog_companyId_idempotencyKey_key');
  });

  it('should include version-controlled Stage 2.1 migration (20261030000000_persistent_admin_notifications)', () => {
    const stage21MigrationSql = path.join(
      migrationsDir,
      '20261030000000_persistent_admin_notifications',
      'migration.sql'
    );
    expect(fs.existsSync(stage21MigrationSql)).toBe(true);

    const content = fs.readFileSync(stage21MigrationSql, 'utf-8');
    expect(content).toContain('CREATE TYPE "NotificationSeverity"');
    expect(content).toContain('CREATE TYPE "NotificationEventStatus"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "Notification"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "NotificationUserState"');
    expect(content).toContain('Notification_companyId_dedupeKey_key');
    expect(content).toContain('Notification_id_companyId_key');
    expect(content).toContain('User_id_companyId_key');
    expect(content).toContain('NotificationUserState_notificationId_companyId_fkey');
    expect(content).toContain('NotificationUserState_userId_companyId_fkey');
  });

  it('should include version-controlled Migration 10 (20261031120000_role_enum_cleanup)', () => {
    const migration10Sql = path.join(
      migrationsDir,
      '20261031120000_role_enum_cleanup',
      'migration.sql'
    );
    expect(fs.existsSync(migration10Sql)).toBe(true);

    const content = fs.readFileSync(migration10Sql, 'utf-8');

    // 1. Both legacy-role safety checks exist
    expect(content).toMatch(/IF EXISTS \(\s*SELECT 1 FROM "User"\s*WHERE "role"::text IN \('MANAGER', 'USER'\)\s*\) THEN\s*RAISE EXCEPTION/);
    expect(content).toMatch(/IF EXISTS \(\s*SELECT 1 FROM "RolePermission"\s*WHERE "role"::text IN \('MANAGER', 'USER'\)\s*\) THEN\s*RAISE EXCEPTION/);

    // 2. The replacement enum contains exactly the four active roles
    expect(content).toContain('ALTER TYPE "Role" RENAME TO "Role_old";');
    expect(content).toContain("CREATE TYPE \"Role\" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE');");

    // 3. Both User.role and RolePermission.role conversions exist using text intermediate cast
    expect(content).toContain('ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;');
    expect(content).toMatch(/ALTER TABLE "User"[\s\S]*?ALTER COLUMN "role" TYPE "Role"[\s\S]*?USING \("role"::text::"Role"\);/);
    expect(content).toMatch(/ALTER TABLE "RolePermission"[\s\S]*?ALTER COLUMN "role" TYPE "Role"[\s\S]*?USING \("role"::text::"Role"\);/);

    // 4. User.role default is restored to EMPLOYEE
    expect(content).toContain("ALTER TABLE \"User\" ALTER COLUMN \"role\" SET DEFAULT 'EMPLOYEE';");

    // 5. DROP TYPE is used without CASCADE
    expect(content).toContain('DROP TYPE "Role_old";');
    expect(content).not.toMatch(/DROP\s+TYPE\s+.*CASCADE/i);

    // 6. No explicit BEGIN or COMMIT statements exist
    expect(content).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/m);
  });

  it('should include version-controlled Phase 1.3 migration (20261103000000_four_eyes_payroll_approval)', () => {
    const migration11Sql = path.join(
      migrationsDir,
      '20261103000000_four_eyes_payroll_approval',
      'migration.sql'
    );
    expect(fs.existsSync(migration11Sql)).toBe(true);

    const content = fs.readFileSync(migration11Sql, 'utf-8');

    // 1. Alter PayrollStatus enum to include ACCOUNTS_APPROVED
    expect(content).toContain("ALTER TYPE \"PayrollStatus\" ADD VALUE IF NOT EXISTS 'ACCOUNTS_APPROVED';");

    // 2. Adds accounts approval tracking columns
    expect(content).toContain('"accountsApprovedAt"');
    expect(content).toContain('"accountsApprovedByUserId"');
    expect(content).toContain('"accountsApprovalNotes"');

    // 3. Adds admin approval tracking columns
    expect(content).toContain('"adminApprovedAt"');
    expect(content).toContain('"adminApprovedByUserId"');

    // 4. Foreign key constraints to User table
    expect(content).toContain('FOREIGN KEY ("accountsApprovedByUserId")');
    expect(content).toContain('FOREIGN KEY ("adminApprovedByUserId")');
  });

  it('should verify migrations order sequentially', () => {
    const subdirs = fs
      .readdirSync(migrationsDir)
      .filter((file) => fs.statSync(path.join(migrationsDir, file)).isDirectory())
      .sort();

    expect(subdirs).toEqual([
      '20261011000000_init',
      '20261011120000_core_tenant_foundation',
      '20261011180000_auth_rbac_company_admin',
      '20261012000000_core_accounting_engine',
      '20261012120000_quotations_billing_receipts',
      '20261012180000_employee_management_salary',
      '20261013000000_attendance_shift_leave_payroll',
      '20261019000000_biometric_terminals_and_raw_punches',
      '20261030000000_persistent_admin_notifications',
      '20261031120000_role_enum_cleanup',
      '20261103000000_four_eyes_payroll_approval',
      '20261105000000_phase2_1_company_settings_foundations',
      '20261105120000_phase2_2_document_sequence_padding',
      '20261106000000_phase2_3_bank_account_encryption_capacity',
    ]);
  });

  it('should include version-controlled Phase 2.1 migration (20261105000000_phase2_1_company_settings_foundations)', () => {
    const migration12Dir = path.join(migrationsDir, '20261105000000_phase2_1_company_settings_foundations');
    expect(fs.existsSync(migration12Dir)).toBe(true);

    const migration12Sql = path.join(migration12Dir, 'migration.sql');
    expect(fs.existsSync(migration12Sql)).toBe(true);

    const content = fs.readFileSync(migration12Sql, 'utf-8');

    // 1. Create enums
    expect(content).toContain('"SettingsChangeRequestStatus"');
    expect(content).toContain('"DocumentNumberType"');

    // 2. Additive columns to Company
    expect(content).toContain('"registrationNumber"');
    expect(content).toContain('"taxRegistrationNumber"');
    expect(content).toContain('"country"');
    expect(content).toContain('"addressLine1"');
    expect(content).toContain('"fiscalYearStartMonth"');

    // 3. New foundation tables
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "CompanyBankAccount"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "CompanySettingsChangeRequest"');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "DocumentNumberSequence"');

    // 4. Default bank account uniqueness
    expect(content).toContain('"CompanyBankAccount_companyId_default_unique"');
  });

  it('should include version-controlled Phase 2.2 migration (20261105120000_phase2_2_document_sequence_padding)', () => {
    const migration13Dir = path.join(migrationsDir, '20261105120000_phase2_2_document_sequence_padding');
    expect(fs.existsSync(migration13Dir)).toBe(true);

    const migration13Sql = path.join(migration13Dir, 'migration.sql');
    expect(fs.existsSync(migration13Sql)).toBe(true);

    const content = fs.readFileSync(migration13Sql, 'utf-8');
    expect(content).toContain('ALTER TABLE "DocumentNumberSequence"');
    expect(content).toContain('ADD COLUMN IF NOT EXISTS "paddingZeros"');
    expect(content).toContain('DEFAULT 5');
  });

  it('should include version-controlled Phase 2.3 migration (20261106000000_phase2_3_bank_account_encryption_capacity)', () => {
    const migration14Dir = path.join(migrationsDir, '20261106000000_phase2_3_bank_account_encryption_capacity');
    expect(fs.existsSync(migration14Dir)).toBe(true);

    const migration14Sql = path.join(migration14Dir, 'migration.sql');
    expect(fs.existsSync(migration14Sql)).toBe(true);

    const content = fs.readFileSync(migration14Sql, 'utf-8');
    expect(content).toContain('SET LOCAL lock_timeout = \'3s\'');
    expect(content).toContain('ALTER TABLE "CompanyBankAccount"');
    expect(content).toContain('ALTER COLUMN "accountNumber" TYPE VARCHAR(255)');
    expect(content).toContain('ALTER COLUMN "routingCode" TYPE VARCHAR(255)');
    expect(content).toContain('ALTER COLUMN "swiftBic" TYPE VARCHAR(255)');
    expect(content).toContain('ALTER COLUMN "iban" TYPE VARCHAR(255)');
    expect(content).toContain('ALTER COLUMN "upiId" TYPE VARCHAR(255)');
  });
});


