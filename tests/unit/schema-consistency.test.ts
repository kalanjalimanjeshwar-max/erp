import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import fs from 'fs';
import path from 'path';

describe('Phase 2 Schema and Relation Consistency Tests', () => {
  const schemaPath = path.resolve(import.meta.dirname, '../../prisma/schema.prisma');
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

  it('should define all required Core Tenant models in Prisma schema', () => {
    const requiredModels = [
      'model Company',
      'model User',
      'model CurrencyConfig',
      'model FiscalPeriod',
      'model CompanySetting',
      'model SystemSetting',
      'model AuditLog',
      'model RolePermission',
    ];

    for (const modelDef of requiredModels) {
      expect(schemaContent).toContain(modelDef);
    }
  });

  it('should enforce consistent Role enum values across the application', () => {
    // Roles requested: SUPER_ADMIN, ADMIN, VICE_ADMIN, EMPLOYEE
    expect(schemaContent).toContain('enum Role {');
    expect(schemaContent).toContain('SUPER_ADMIN');
    expect(schemaContent).toContain('ADMIN');
    expect(schemaContent).toContain('VICE_ADMIN');
    expect(schemaContent).toContain('EMPLOYEE');
  });

  it('should require companyId with UUID on all company-owned records', () => {
    const companyOwnedModels = [
      'User',
      'CurrencyConfig',
      'FiscalPeriod',
      'CompanySetting',
    ];

    for (const model of companyOwnedModels) {
      const modelRegex = new RegExp(`model ${model} \\{[\\s\\S]*?\\}`, 'm');
      const match = schemaContent.match(modelRegex);
      expect(match).not.toBeNull();
      const modelBody = match![0];

      // Must have companyId String @db.Uuid
      expect(modelBody).toMatch(/companyId\s+String\s+@db\.Uuid/);
      // Must have foreign key relation with onDelete: Restrict for tenant safety
      expect(modelBody).toMatch(/@relation\(fields:\s*\[companyId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/);
    }
  });

  it('should enforce company-scoped unique constraints to prevent cross-tenant collisions', () => {
    // User uniqueness scoped to company
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*email\]\)/);

    // Currency uniqueness scoped to company
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*currencyCode\]\)/);

    // Fiscal period uniqueness scoped to company and fiscal year/period
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*fiscalYear,\s*periodNumber\]\)/);

    // Company setting uniqueness scoped to company and key
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*key\]\)/);
  });

  it('should enforce exact Decimal(18, 6) precision for exchange rates', () => {
    expect(schemaContent).toMatch(/exchangeRate\s+Decimal\s+@default\(1\.000000\)\s+@db\.Decimal\(18,\s*6\)/);
  });

  it('should use explicit calendar Date types for fiscal periods', () => {
    expect(schemaContent).toMatch(/startDate\s+DateTime\s+@db\.Date/);
    expect(schemaContent).toMatch(/endDate\s+DateTime\s+@db\.Date/);
  });

  it('should include secure session management fields on User model', () => {
    const userMatch = schemaContent.match(/model User \{[\s\S]*?\}/);
    expect(userMatch).not.toBeNull();
    const userBody = userMatch![0];

    expect(userBody).toContain('tokenVersion');
    expect(userBody).toContain('lastLoginAt');
    expect(userBody).toContain('lastLoginIp');
    expect(userBody).toContain('failedLoginAttempts');
    expect(userBody).toContain('lockedUntil');
    expect(userBody).toContain('passwordChangedAt');
  });

  it('should include request correlationId and composite indexes on AuditLog', () => {
    const auditMatch = schemaContent.match(/model AuditLog \{[\s\S]*?\}/);
    expect(auditMatch).not.toBeNull();
    const auditBody = auditMatch![0];

    expect(auditBody).toContain('correlationId');
    expect(auditBody).toContain('@@index([correlationId])');
    expect(auditBody).toContain('@@index([entity, entityId])');
  });

  it('should define all Phase 4 Core Accounting models and enums in Prisma schema', () => {
    expect(schemaContent).toContain('enum AccountRootType');
    expect(schemaContent).toContain('enum BalanceType');
    expect(schemaContent).toContain('enum JournalStatus');

    expect(schemaContent).toContain('model AccountGroup');
    expect(schemaContent).toContain('model AccountLedger');
    expect(schemaContent).toContain('model JournalEntry');
    expect(schemaContent).toContain('model JournalLine');
  });

  it('should enforce company scoping and ON DELETE RESTRICT on all accounting models', () => {
    const accountingModels = ['AccountGroup', 'AccountLedger', 'JournalEntry', 'JournalLine'];

    for (const model of accountingModels) {
      const modelRegex = new RegExp(`model ${model} \\{[\\s\\S]*?\\}`, 'm');
      const match = schemaContent.match(modelRegex);
      expect(match).not.toBeNull();
      const modelBody = match![0];

      expect(modelBody).toMatch(/companyId\s+String\s+@db\.Uuid/);
      expect(modelBody).toMatch(/@relation\(fields:\s*\[companyId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/);
    }
  });

  it('should enforce Decimal(18, 4) exact precision on accounting monetary columns', () => {
    // AccountLedger openingBalance
    expect(schemaContent).toMatch(/openingBalance\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);

    // JournalEntry totals
    expect(schemaContent).toMatch(/totalDebit\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(schemaContent).toMatch(/totalCredit\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);

    // JournalLine debit and credit
    expect(schemaContent).toMatch(/debit\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(schemaContent).toMatch(/credit\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
  });

  it('should safeguard employee accounting linkage with company-scoped unique constraint', () => {
    // Section 2: Prevent the same employee from being linked to conflicting accounting ledgers
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*employeeId\]\)/);
  });

  it('should define all Phase 5 Quotation, Billing, Customer, and Receipt models and enums in Prisma schema', () => {
    expect(schemaContent).toContain('enum QuotationStatus');
    expect(schemaContent).toContain('enum InvoiceStatus');
    expect(schemaContent).toContain('enum ReceiptStatus');
    expect(schemaContent).toContain('enum PaymentMethod');

    expect(schemaContent).toContain('model Customer');
    expect(schemaContent).toContain('model Quotation');
    expect(schemaContent).toContain('model QuotationLine');
    expect(schemaContent).toContain('model Invoice');
    expect(schemaContent).toContain('model InvoiceLine');
    expect(schemaContent).toContain('model CustomerReceipt');
    expect(schemaContent).toContain('model ReceiptAllocation');
  });

  it('should enforce company scoping and unique numbering on Phase 5 models', () => {
    // Unique sequential numbers scoped to company
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*quotationNumber\]\)/);
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*invoiceNumber\]\)/);
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*receiptNumber\]\)/);

    // Foreign keys to company with OnDelete: Restrict
    const models = ['Customer', 'Quotation', 'Invoice', 'CustomerReceipt'];
    for (const m of models) {
      const match = schemaContent.match(new RegExp(`model ${m} \\{[\\s\\S]*?\\}`, 'm'));
      expect(match).not.toBeNull();
      const body = match![0];
      expect(body).toMatch(/companyId\s+String\s+@db\.Uuid/);
      expect(body).toMatch(/@relation\(fields:\s*\[companyId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/);
    }
  });

  it('should enforce Decimal(18, 4) exact precision on Phase 5 monetary columns', () => {
    // Invoice monetary columns
    expect(schemaContent).toMatch(/subtotal\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(schemaContent).toMatch(/discountTotal\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(schemaContent).toMatch(/taxTotal\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(schemaContent).toMatch(/total\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(schemaContent).toMatch(/balanceDue\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
  });

  it('should define all Phase 6 Employee, Department, Designation, and SalaryRevision models and enums in Prisma schema', () => {
    expect(schemaContent).toContain('enum EmployeeStatus');
    expect(schemaContent).toContain('enum EmploymentType');

    expect(schemaContent).toContain('model Department');
    expect(schemaContent).toContain('model Designation');
    expect(schemaContent).toContain('model Employee');
    expect(schemaContent).toContain('model SalaryRevision');
  });

  it('should enforce company scoping and unique constraints on Phase 6 Employee models', () => {
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*employeeCode\]\)/);
    expect(schemaContent).toMatch(/@@unique\(\[companyId,\s*code\]\)/);

    const phase6Models = ['Department', 'Designation', 'Employee', 'SalaryRevision'];
    for (const m of phase6Models) {
      const match = schemaContent.match(new RegExp(`model ${m} \\{[\\s\\S]*?\\}`, 'm'));
      expect(match).not.toBeNull();
      const body = match![0];
      expect(body).toMatch(/companyId\s+String\s+@db\.Uuid/);
      expect(body).toMatch(/@relation\(fields:\s*\[companyId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/);
    }
  });

  it('should enforce Decimal(18, 4) exact precision on employee fixed salary column', () => {
    expect(schemaContent).toMatch(/fixedSalary\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
  });
});

