-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'USER');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'WARN', 'CRITICAL');

-- CreateTable: Company
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "legalName" VARCHAR(255),
    "taxId" VARCHAR(64),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "logoUrl" VARCHAR(512),
    "isConfigured" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable: User
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "fullName" VARCHAR(128) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CompanyCurrency (Demonstrates exact Decimal precision)
CREATE TABLE "CompanyCurrency" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL,
    "exchangeRate" DECIMAL(18,6) NOT NULL DEFAULT 1.000000,
    "roundingPrecision" INTEGER NOT NULL DEFAULT 2,
    "isBaseCurrency" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CompanyCurrency_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SystemSetting
CREATE TABLE "SystemSetting" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "value" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AuditLog
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "userId" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entity" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(64),
    "severity" "AuditSeverity" NOT NULL DEFAULT 'INFO',
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(255),
    "details" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes
CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");
CREATE INDEX "Company_code_idx" ON "Company"("code");

CREATE INDEX "User_companyId_idx" ON "User"("companyId");
CREATE INDEX "User_email_idx" ON "User"("email");
CREATE UNIQUE INDEX "User_companyId_email_key" ON "User"("companyId", "email");

CREATE INDEX "CompanyCurrency_companyId_idx" ON "CompanyCurrency"("companyId");
CREATE UNIQUE INDEX "CompanyCurrency_companyId_currencyCode_key" ON "CompanyCurrency"("companyId", "currencyCode");

CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");
CREATE INDEX "SystemSetting_key_idx" ON "SystemSetting"("key");

CREATE INDEX "AuditLog_companyId_idx" ON "AuditLog"("companyId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- AddForeignKeys
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyCurrency" ADD CONSTRAINT "CompanyCurrency_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
