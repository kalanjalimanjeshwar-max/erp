-- CoreERP Phase 4: Core Accounting Engine & Chart of Accounts Migration
-- Non-destructively adds AccountGroup, AccountLedger, JournalEntry, and JournalLine models

-- 1. Create Enums
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AccountRootType') THEN
        CREATE TYPE "AccountRootType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BalanceType') THEN
        CREATE TYPE "BalanceType" AS ENUM ('DEBIT', 'CREDIT');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JournalStatus') THEN
        CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');
    END IF;
END $$;

-- 2. Create Table: AccountGroup
CREATE TABLE IF NOT EXISTS "AccountGroup" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "rootType" "AccountRootType" NOT NULL,
    "parentGroupId" UUID,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AccountGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AccountGroup_companyId_code_key" ON "AccountGroup"("companyId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "AccountGroup_companyId_name_key" ON "AccountGroup"("companyId", "name");
CREATE INDEX IF NOT EXISTS "AccountGroup_companyId_idx" ON "AccountGroup"("companyId");
CREATE INDEX IF NOT EXISTS "AccountGroup_rootType_idx" ON "AccountGroup"("rootType");
CREATE INDEX IF NOT EXISTS "AccountGroup_parentGroupId_idx" ON "AccountGroup"("parentGroupId");

ALTER TABLE "AccountGroup" DROP CONSTRAINT IF EXISTS "AccountGroup_companyId_fkey";
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_companyId_fkey" 
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccountGroup" DROP CONSTRAINT IF EXISTS "AccountGroup_parentGroupId_fkey";
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_parentGroupId_fkey" 
    FOREIGN KEY ("parentGroupId") REFERENCES "AccountGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Create Table: AccountLedger
CREATE TABLE IF NOT EXISTS "AccountLedger" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "code" VARCHAR(32),
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "openingBalance" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "openingBalanceType" "BalanceType" NOT NULL DEFAULT 'DEBIT',
    "employeeId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AccountLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AccountLedger_companyId_name_key" ON "AccountLedger"("companyId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "AccountLedger_companyId_code_key" ON "AccountLedger"("companyId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "AccountLedger_companyId_employeeId_key" ON "AccountLedger"("companyId", "employeeId");
CREATE INDEX IF NOT EXISTS "AccountLedger_companyId_idx" ON "AccountLedger"("companyId");
CREATE INDEX IF NOT EXISTS "AccountLedger_groupId_idx" ON "AccountLedger"("groupId");
CREATE INDEX IF NOT EXISTS "AccountLedger_isActive_idx" ON "AccountLedger"("isActive");

ALTER TABLE "AccountLedger" DROP CONSTRAINT IF EXISTS "AccountLedger_companyId_fkey";
ALTER TABLE "AccountLedger" ADD CONSTRAINT "AccountLedger_companyId_fkey" 
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccountLedger" DROP CONSTRAINT IF EXISTS "AccountLedger_groupId_fkey";
ALTER TABLE "AccountLedger" ADD CONSTRAINT "AccountLedger_groupId_fkey" 
    FOREIGN KEY ("groupId") REFERENCES "AccountGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Create Table: JournalEntry
CREATE TABLE IF NOT EXISTS "JournalEntry" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "voucherNumber" VARCHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(64),
    "entryDate" DATE NOT NULL,
    "fiscalPeriodId" UUID,
    "narration" TEXT NOT NULL,
    "reference" VARCHAR(128),
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "totalDebit" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "totalCredit" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "postedAt" TIMESTAMPTZ(6),
    "postedByUserId" UUID,
    "reversedAt" TIMESTAMPTZ(6),
    "reversedByUserId" UUID,
    "reversalOfId" UUID,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_companyId_voucherNumber_key" ON "JournalEntry"("companyId", "voucherNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_companyId_idempotencyKey_key" ON "JournalEntry"("companyId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "JournalEntry_companyId_idx" ON "JournalEntry"("companyId");
CREATE INDEX IF NOT EXISTS "JournalEntry_entryDate_idx" ON "JournalEntry"("entryDate");
CREATE INDEX IF NOT EXISTS "JournalEntry_status_idx" ON "JournalEntry"("status");
CREATE INDEX IF NOT EXISTS "JournalEntry_fiscalPeriodId_idx" ON "JournalEntry"("fiscalPeriodId");

ALTER TABLE "JournalEntry" DROP CONSTRAINT IF EXISTS "JournalEntry_companyId_fkey";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_companyId_fkey" 
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalEntry" DROP CONSTRAINT IF EXISTS "JournalEntry_fiscalPeriodId_fkey";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_fiscalPeriodId_fkey" 
    FOREIGN KEY ("fiscalPeriodId") REFERENCES "FiscalPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalEntry" DROP CONSTRAINT IF EXISTS "JournalEntry_postedByUserId_fkey";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_postedByUserId_fkey" 
    FOREIGN KEY ("postedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "JournalEntry" DROP CONSTRAINT IF EXISTS "JournalEntry_reversedByUserId_fkey";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversedByUserId_fkey" 
    FOREIGN KEY ("reversedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "JournalEntry" DROP CONSTRAINT IF EXISTS "JournalEntry_createdByUserId_fkey";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_createdByUserId_fkey" 
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Create Table: JournalLine
CREATE TABLE IF NOT EXISTS "JournalLine" (
    "id" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ledgerId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "debit" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "credit" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JournalLine_journalId_lineNumber_key" ON "JournalLine"("journalId", "lineNumber");
CREATE INDEX IF NOT EXISTS "JournalLine_journalId_idx" ON "JournalLine"("journalId");
CREATE INDEX IF NOT EXISTS "JournalLine_companyId_idx" ON "JournalLine"("companyId");
CREATE INDEX IF NOT EXISTS "JournalLine_ledgerId_idx" ON "JournalLine"("ledgerId");

ALTER TABLE "JournalLine" DROP CONSTRAINT IF EXISTS "JournalLine_journalId_fkey";
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_journalId_fkey" 
    FOREIGN KEY ("journalId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JournalLine" DROP CONSTRAINT IF EXISTS "JournalLine_companyId_fkey";
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_companyId_fkey" 
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalLine" DROP CONSTRAINT IF EXISTS "JournalLine_ledgerId_fkey";
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_ledgerId_fkey" 
    FOREIGN KEY ("ledgerId") REFERENCES "AccountLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
