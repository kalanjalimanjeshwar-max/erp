import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Phase 2.1 Company Settings & Schema Foundations Tests', () => {
  const schemaPath = path.resolve(import.meta.dirname, '../../prisma/schema.prisma');
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

  const migrationPath = path.resolve(
    import.meta.dirname,
    '../../prisma/migrations/20261105000000_phase2_1_company_settings_foundations/migration.sql'
  );
  const migrationContent = fs.readFileSync(migrationPath, 'utf-8');

  describe('1. Schema Foundations Definition', () => {
    it('should define all Phase 2.1 models and enums in Prisma schema', () => {
      expect(schemaContent).toContain('model CompanyBankAccount');
      expect(schemaContent).toContain('model CompanySettingsChangeRequest');
      expect(schemaContent).toContain('model DocumentNumberSequence');
      expect(schemaContent).toContain('enum SettingsChangeRequestStatus');
      expect(schemaContent).toContain('enum DocumentNumberType');
    });

    it('should contain all required SettingsChangeRequestStatus enum values', () => {
      const match = schemaContent.match(/enum SettingsChangeRequestStatus \{([\s\S]*?)\}/);
      expect(match).not.toBeNull();
      const body = match![1];
      expect(body).toContain('PENDING');
      expect(body).toContain('APPROVED');
      expect(body).toContain('REJECTED');
      expect(body).toContain('CANCELLED');
    });

    it('should contain all four approved DocumentNumberType enum values', () => {
      const match = schemaContent.match(/enum DocumentNumberType \{([\s\S]*?)\}/);
      expect(match).not.toBeNull();
      const body = match![1];
      expect(body).toContain('INVOICE');
      expect(body).toContain('QUOTATION');
      expect(body).toContain('RECEIPT');
      expect(body).toContain('JOURNAL_VOUCHER');
    });

    it('should define structured location and statutory fields on Company model', () => {
      const match = schemaContent.match(/model Company \{([\s\S]*?)\}/);
      expect(match).not.toBeNull();
      const body = match![1];

      // Statutory & Location foundations
      expect(body).toContain('registrationNumber');
      expect(body).toContain('taxRegistrationNumber');
      expect(body).toContain('country');
      expect(body).toContain('state');
      expect(body).toContain('city');
      expect(body).toContain('postalCode');
      expect(body).toContain('addressLine1');
      expect(body).toContain('addressLine2');
      expect(body).toContain('fiscalYearStartMonth');
      expect(body).toContain('defaultDocumentLanguage');

      // Preserve legacy address column
      expect(body).toContain('address');
    });
  });

  describe('2. Multi-Tenant Scoping & Referential Integrity', () => {
    it('should require companyId with UUID and onDelete: Restrict on all Phase 2.1 models', () => {
      const phase2Models = [
        'CompanyBankAccount',
        'CompanySettingsChangeRequest',
        'DocumentNumberSequence',
      ];

      for (const model of phase2Models) {
        const match = schemaContent.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\}`, 'm'));
        expect(match).not.toBeNull();
        const body = match![1];
        expect(body).toMatch(/companyId\s+String\s+@db\.Uuid/);
        expect(body).toMatch(
          /@relation\(fields:\s*\[companyId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/
        );
      }
    });

    it('should enforce unique compound constraint on DocumentNumberSequence', () => {
      expect(schemaContent).toMatch(
        /@@unique\(\[companyId,\s*documentType,\s*prefix,\s*fiscalYear\]\)/
      );
    });

    it('should link CompanySettingsChangeRequest to User for both requester and reviewer', () => {
      const match = schemaContent.match(/model CompanySettingsChangeRequest \{([\s\S]*?)\}/);
      expect(match).not.toBeNull();
      const body = match![1];

      expect(body).toMatch(
        /@relation\("SettingsChangeRequestCreatedByUser",\s*fields:\s*\[requestedById\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/
      );
      expect(body).toMatch(
        /@relation\("SettingsChangeRequestReviewedByUser",\s*fields:\s*\[reviewedById\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/
      );
    });
  });

  describe('3. Migration Safety and Data Preservation', () => {
    it('should be strictly additive and non-destructive in migration SQL', () => {
      // Must not drop any table, column, or enum
      expect(migrationContent).not.toMatch(/DROP\s+TABLE/i);
      expect(migrationContent).not.toMatch(/DROP\s+COLUMN/i);
      expect(migrationContent).not.toMatch(/DROP\s+TYPE/i);
    });

    it('should include non-destructive backfill from address to addressLine1', () => {
      expect(migrationContent).toContain('UPDATE "Company"');
      expect(migrationContent).toContain('SET "addressLine1" = "address"');
      expect(migrationContent).toContain('WHERE "addressLine1" IS NULL AND "address" IS NOT NULL');
    });

    it('should define partial unique index for active default bank account per company', () => {
      expect(migrationContent).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "CompanyBankAccount_companyId_default_unique"');
      expect(migrationContent).toContain('ON "CompanyBankAccount"("companyId")');
      expect(migrationContent).toContain('WHERE "isDefault" = true AND "isActive" = true');
    });

    it('should enforce ON DELETE RESTRICT on foreign key constraints', () => {
      expect(migrationContent).toContain('REFERENCES "Company"("id")');
      expect(migrationContent).toContain('ON DELETE RESTRICT');
      expect(migrationContent).toContain('REFERENCES "User"("id")');
    });
  });

  describe('4. Maker-Checker & Invariant Verification', () => {
    it('should support maker-checker segregation of duties in schema types', () => {
      // Verify requester and reviewer fields are distinct on CompanySettingsChangeRequest
      const match = schemaContent.match(/model CompanySettingsChangeRequest \{([\s\S]*?)\}/);
      expect(match).not.toBeNull();
      const body = match![1];

      expect(body).toContain('requestedById');
      expect(body).toContain('reviewedById');
      expect(body).toContain('rejectionReason');
      expect(body).toContain('status');
      expect(body).toContain('appliedAt');
    });

    it('should not hardcode country or currency to fixed regions as mandatory schema defaults', () => {
      const match = schemaContent.match(/model CompanyBankAccount \{([\s\S]*?)\}/);
      expect(match).not.toBeNull();
      const body = match![1];

      // routingCode is optional for international compatibility (widened to VarChar(255) in Phase 2.3 for encryption)
      expect(body).toMatch(/routingCode\s+String\?\s+@db\.VarChar\((32|255)\)/);
      // currency defaults to standard USD but is configurable String
      expect(body).toMatch(/currency\s+String\s+@default\("USD"\)\s+@db\.VarChar\(3\)/);
    });
  });
});
