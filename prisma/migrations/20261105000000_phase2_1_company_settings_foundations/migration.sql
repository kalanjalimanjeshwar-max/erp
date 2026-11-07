-- CoreERP Migration 12: Phase 2.1 Company Settings & Foundations
-- Introduces structured statutory and location fields to Company,
-- adds CompanyBankAccount (with active default support),
-- adds CompanySettingsChangeRequest (maker-checker approval workflow),
-- adds DocumentNumberSequence (concurrency-safe document numbering),
-- and defines SettingsChangeRequestStatus and DocumentNumberType enums.
-- STRICTLY ADDITIVE AND NON-DESTRUCTIVE: Preserves all existing columns and data.

-- Step 1: Create Enums if they do not exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SettingsChangeRequestStatus') THEN
        CREATE TYPE "SettingsChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentNumberType') THEN
        CREATE TYPE "DocumentNumberType" AS ENUM ('INVOICE', 'QUOTATION', 'RECEIPT', 'JOURNAL_VOUCHER');
    END IF;
END $$;

-- Step 2: Add Additive Columns to Company Table
ALTER TABLE "Company"
    ADD COLUMN IF NOT EXISTS "registrationNumber" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "taxRegistrationNumber" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "country" VARCHAR(64) NOT NULL DEFAULT 'US',
    ADD COLUMN IF NOT EXISTS "state" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "city" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "postalCode" VARCHAR(20),
    ADD COLUMN IF NOT EXISTS "addressLine1" VARCHAR(255),
    ADD COLUMN IF NOT EXISTS "addressLine2" VARCHAR(255),
    ADD COLUMN IF NOT EXISTS "fiscalYearStartMonth" SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS "defaultDocumentLanguage" VARCHAR(10) NOT NULL DEFAULT 'EN';

-- Step 3: Non-Destructive Data Preservation: Backfill addressLine1 from legacy address if null
UPDATE "Company"
SET "addressLine1" = "address"
WHERE "addressLine1" IS NULL AND "address" IS NOT NULL;

-- Step 4: Create CompanyBankAccount Table
CREATE TABLE IF NOT EXISTS "CompanyBankAccount" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "bankName" VARCHAR(128) NOT NULL,
    "accountHolderName" VARCHAR(128) NOT NULL,
    "accountNumber" VARCHAR(64) NOT NULL,
    "routingCode" VARCHAR(32),
    "branchName" VARCHAR(128),
    "swiftBic" VARCHAR(32),
    "iban" VARCHAR(64),
    "upiId" VARCHAR(64),
    "accountType" VARCHAR(32),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "showOnInvoices" BOOLEAN NOT NULL DEFAULT true,
    "showOnQuotations" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyBankAccount_pkey" PRIMARY KEY ("id")
);

-- Step 5: Create CompanySettingsChangeRequest Table
CREATE TABLE IF NOT EXISTS "CompanySettingsChangeRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SettingsChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(6),
    "appliedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanySettingsChangeRequest_pkey" PRIMARY KEY ("id")
);

-- Step 6: Create DocumentNumberSequence Table
CREATE TABLE IF NOT EXISTS "DocumentNumberSequence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "documentType" "DocumentNumberType" NOT NULL,
    "prefix" VARCHAR(32) NOT NULL,
    "fiscalYear" VARCHAR(16) NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentNumberSequence_pkey" PRIMARY KEY ("id")
);

-- Step 7: Create Indices and Unique Constraints
CREATE INDEX IF NOT EXISTS "CompanyBankAccount_companyId_idx" ON "CompanyBankAccount"("companyId");
CREATE INDEX IF NOT EXISTS "CompanyBankAccount_companyId_isActive_idx" ON "CompanyBankAccount"("companyId", "isActive");

-- Filtered unique index: at most one active default bank account per company
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyBankAccount_companyId_default_unique" 
ON "CompanyBankAccount"("companyId") 
WHERE "isDefault" = true AND "isActive" = true;

CREATE INDEX IF NOT EXISTS "CompanySettingsChangeRequest_companyId_idx" ON "CompanySettingsChangeRequest"("companyId");
CREATE INDEX IF NOT EXISTS "CompanySettingsChangeRequest_companyId_status_idx" ON "CompanySettingsChangeRequest"("companyId", "status");
CREATE INDEX IF NOT EXISTS "CompanySettingsChangeRequest_requestedById_idx" ON "CompanySettingsChangeRequest"("requestedById");
CREATE INDEX IF NOT EXISTS "CompanySettingsChangeRequest_reviewedById_idx" ON "CompanySettingsChangeRequest"("reviewedById");

CREATE UNIQUE INDEX IF NOT EXISTS "DocumentNumberSequence_companyId_documentType_prefix_fiscalYear_key" 
ON "DocumentNumberSequence"("companyId", "documentType", "prefix", "fiscalYear");
CREATE INDEX IF NOT EXISTS "DocumentNumberSequence_companyId_idx" ON "DocumentNumberSequence"("companyId");
CREATE INDEX IF NOT EXISTS "DocumentNumberSequence_companyId_documentType_idx" ON "DocumentNumberSequence"("companyId", "documentType");

-- Step 8: Add Foreign Key Constraints with ON DELETE RESTRICT
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CompanyBankAccount_companyId_fkey'
    ) THEN
        ALTER TABLE "CompanyBankAccount"
            ADD CONSTRAINT "CompanyBankAccount_companyId_fkey"
            FOREIGN KEY ("companyId")
            REFERENCES "Company"("id")
            ON DELETE RESTRICT
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CompanySettingsChangeRequest_companyId_fkey'
    ) THEN
        ALTER TABLE "CompanySettingsChangeRequest"
            ADD CONSTRAINT "CompanySettingsChangeRequest_companyId_fkey"
            FOREIGN KEY ("companyId")
            REFERENCES "Company"("id")
            ON DELETE RESTRICT
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CompanySettingsChangeRequest_requestedById_fkey'
    ) THEN
        ALTER TABLE "CompanySettingsChangeRequest"
            ADD CONSTRAINT "CompanySettingsChangeRequest_requestedById_fkey"
            FOREIGN KEY ("requestedById")
            REFERENCES "User"("id")
            ON DELETE RESTRICT
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CompanySettingsChangeRequest_reviewedById_fkey'
    ) THEN
        ALTER TABLE "CompanySettingsChangeRequest"
            ADD CONSTRAINT "CompanySettingsChangeRequest_reviewedById_fkey"
            FOREIGN KEY ("reviewedById")
            REFERENCES "User"("id")
            ON DELETE SET NULL
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'DocumentNumberSequence_companyId_fkey'
    ) THEN
        ALTER TABLE "DocumentNumberSequence"
            ADD CONSTRAINT "DocumentNumberSequence_companyId_fkey"
            FOREIGN KEY ("companyId")
            REFERENCES "Company"("id")
            ON DELETE RESTRICT
            ON UPDATE CASCADE;
    END IF;
END $$;
