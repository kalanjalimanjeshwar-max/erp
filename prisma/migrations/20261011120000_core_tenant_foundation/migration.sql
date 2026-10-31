-- CoreERP Phase 2: Core Tenant Foundation Migration
-- Preserves existing initial schema and adds Tenant models, relations, constraints, and audit extensions

-- 1. Extend Role Enum with VICE_ADMIN and EMPLOYEE
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'VICE_ADMIN';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'EMPLOYEE';

-- 2. Create FiscalPeriodStatus Enum
CREATE TYPE "FiscalPeriodStatus" AS ENUM ('OPEN', 'CLOSED', 'LOCKED');

-- 3. Enhance User Model with secure session controls & role defaults
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginIp" VARCHAR(45);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMPTZ(6);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "User_role_idx" ON "User"("role");

-- 4. Create CurrencyConfig (replacing prototype CompanyCurrency with Restrict deletion policy)
CREATE TABLE IF NOT EXISTS "CurrencyConfig" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL,
    "exchangeRate" DECIMAL(18,6) NOT NULL DEFAULT 1.000000,
    "roundingPrecision" INTEGER NOT NULL DEFAULT 2,
    "isBaseCurrency" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CurrencyConfig_pkey" PRIMARY KEY ("id")
);

-- Copy any data from prototype CompanyCurrency table if present
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'CompanyCurrency') THEN
        INSERT INTO "CurrencyConfig" ("id", "companyId", "currencyCode", "exchangeRate", "roundingPrecision", "isBaseCurrency", "createdAt", "updatedAt")
        SELECT "id", "companyId", "currencyCode", "exchangeRate", "roundingPrecision", "isBaseCurrency", CURRENT_TIMESTAMP, "updatedAt"
        FROM "CompanyCurrency"
        ON CONFLICT DO NOTHING;
        DROP TABLE IF EXISTS "CompanyCurrency" CASCADE;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "CurrencyConfig_companyId_currencyCode_key" ON "CurrencyConfig"("companyId", "currencyCode");
CREATE INDEX IF NOT EXISTS "CurrencyConfig_companyId_idx" ON "CurrencyConfig"("companyId");
CREATE INDEX IF NOT EXISTS "CurrencyConfig_currencyCode_idx" ON "CurrencyConfig"("currencyCode");

ALTER TABLE "CurrencyConfig" DROP CONSTRAINT IF EXISTS "CurrencyConfig_companyId_fkey";
ALTER TABLE "CurrencyConfig" ADD CONSTRAINT "CurrencyConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Create FiscalPeriod Table with explicit Date calendar types
CREATE TABLE IF NOT EXISTS "FiscalPeriod" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "periodName" VARCHAR(64) NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "periodNumber" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "FiscalPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMPTZ(6),
    "closedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FiscalPeriod_companyId_fiscalYear_periodNumber_key" ON "FiscalPeriod"("companyId", "fiscalYear", "periodNumber");
CREATE INDEX IF NOT EXISTS "FiscalPeriod_companyId_idx" ON "FiscalPeriod"("companyId");
CREATE INDEX IF NOT EXISTS "FiscalPeriod_fiscalYear_idx" ON "FiscalPeriod"("fiscalYear");
CREATE INDEX IF NOT EXISTS "FiscalPeriod_status_idx" ON "FiscalPeriod"("status");

ALTER TABLE "FiscalPeriod" DROP CONSTRAINT IF EXISTS "FiscalPeriod_companyId_fkey";
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FiscalPeriod" DROP CONSTRAINT IF EXISTS "FiscalPeriod_closedByUserId_fkey";
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Create CompanySetting Table
CREATE TABLE IF NOT EXISTS "CompanySetting" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CompanySetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CompanySetting_companyId_key_key" ON "CompanySetting"("companyId", "key");
CREATE INDEX IF NOT EXISTS "CompanySetting_companyId_idx" ON "CompanySetting"("companyId");
CREATE INDEX IF NOT EXISTS "CompanySetting_key_idx" ON "CompanySetting"("key");

ALTER TABLE "CompanySetting" DROP CONSTRAINT IF EXISTS "CompanySetting_companyId_fkey";
ALTER TABLE "CompanySetting" ADD CONSTRAINT "CompanySetting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Enhance AuditLog with correlationId and composite indexes
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "correlationId" VARCHAR(64);

CREATE INDEX IF NOT EXISTS "AuditLog_correlationId_idx" ON "AuditLog"("correlationId");
CREATE INDEX IF NOT EXISTS "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- Harden deletion policy to RESTRICT for audit logs
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_companyId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
