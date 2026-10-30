-- CoreERP Phase 8.1: Biometric Hardware LAN Bridge Database Foundation Migration
-- Non-destructively adds BiometricTerminal and RawPunchLog models with PostgreSQL enums and indexes

-- 1. Create Enums
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BiometricTerminalStatus') THEN
        CREATE TYPE "BiometricTerminalStatus" AS ENUM ('ONLINE', 'OFFLINE', 'ERROR', 'DEACTIVATED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BiometricVerifyType') THEN
        CREATE TYPE "BiometricVerifyType" AS ENUM ('FINGERPRINT', 'CARD', 'PASSWORD', 'FACE');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PunchInOutMode') THEN
        CREATE TYPE "PunchInOutMode" AS ENUM ('CHECK_IN', 'CHECK_OUT', 'BREAK_OUT', 'BREAK_IN');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PunchSyncStatus') THEN
        CREATE TYPE "PunchSyncStatus" AS ENUM ('PENDING', 'PROCESSED', 'IGNORED', 'ERROR');
    END IF;
END $$;

-- 2. Create Table: BiometricTerminal
CREATE TABLE IF NOT EXISTS "BiometricTerminal" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "deviceSerialNumber" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "terminalModel" VARCHAR(64) NOT NULL DEFAULT 'ZKTeco-F22',
    "ipAddress" VARCHAR(45),
    "port" INTEGER NOT NULL DEFAULT 4370,
    "location" VARCHAR(128),
    "apiKeyHash" VARCHAR(128) NOT NULL,
    "apiKeyPrefix" VARCHAR(16) NOT NULL,
    "status" "BiometricTerminalStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastHeartbeatAt" TIMESTAMPTZ(6),
    "lastSyncAt" TIMESTAMPTZ(6),
    "firmwareVersion" VARCHAR(64),
    "registeredByUserId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BiometricTerminal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BiometricTerminal_companyId_deviceSerialNumber_key" 
    ON "BiometricTerminal"("companyId", "deviceSerialNumber");

CREATE UNIQUE INDEX IF NOT EXISTS "BiometricTerminal_apiKeyHash_key" 
    ON "BiometricTerminal"("apiKeyHash");

CREATE INDEX IF NOT EXISTS "BiometricTerminal_companyId_idx" 
    ON "BiometricTerminal"("companyId");

CREATE INDEX IF NOT EXISTS "BiometricTerminal_status_idx" 
    ON "BiometricTerminal"("status");

CREATE INDEX IF NOT EXISTS "BiometricTerminal_isActive_idx" 
    ON "BiometricTerminal"("isActive");

ALTER TABLE "BiometricTerminal" DROP CONSTRAINT IF EXISTS "BiometricTerminal_companyId_fkey";
ALTER TABLE "BiometricTerminal" ADD CONSTRAINT "BiometricTerminal_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BiometricTerminal" DROP CONSTRAINT IF EXISTS "BiometricTerminal_registeredByUserId_fkey";
ALTER TABLE "BiometricTerminal" ADD CONSTRAINT "BiometricTerminal_registeredByUserId_fkey"
    FOREIGN KEY ("registeredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Create Table: RawPunchLog
CREATE TABLE IF NOT EXISTS "RawPunchLog" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "terminalId" UUID NOT NULL,
    "devicePunchId" VARCHAR(64),
    "userEnrollmentId" VARCHAR(64) NOT NULL,
    "punchTime" TIMESTAMPTZ(6) NOT NULL,
    "verifyType" "BiometricVerifyType" NOT NULL DEFAULT 'FINGERPRINT',
    "inOutMode" "PunchInOutMode" NOT NULL DEFAULT 'CHECK_IN',
    "syncStatus" "PunchSyncStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "rawPayload" TEXT,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "matchedEmployeeId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RawPunchLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RawPunchLog_companyId_idempotencyKey_key" 
    ON "RawPunchLog"("companyId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "RawPunchLog_companyId_idx" 
    ON "RawPunchLog"("companyId");

CREATE INDEX IF NOT EXISTS "RawPunchLog_terminalId_idx" 
    ON "RawPunchLog"("terminalId");

CREATE INDEX IF NOT EXISTS "RawPunchLog_userEnrollmentId_idx" 
    ON "RawPunchLog"("userEnrollmentId");

CREATE INDEX IF NOT EXISTS "RawPunchLog_punchTime_idx" 
    ON "RawPunchLog"("punchTime");

CREATE INDEX IF NOT EXISTS "RawPunchLog_syncStatus_idx" 
    ON "RawPunchLog"("syncStatus");

CREATE INDEX IF NOT EXISTS "RawPunchLog_matchedEmployeeId_idx" 
    ON "RawPunchLog"("matchedEmployeeId");

ALTER TABLE "RawPunchLog" DROP CONSTRAINT IF EXISTS "RawPunchLog_companyId_fkey";
ALTER TABLE "RawPunchLog" ADD CONSTRAINT "RawPunchLog_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RawPunchLog" DROP CONSTRAINT IF EXISTS "RawPunchLog_terminalId_fkey";
ALTER TABLE "RawPunchLog" ADD CONSTRAINT "RawPunchLog_terminalId_fkey"
    FOREIGN KEY ("terminalId") REFERENCES "BiometricTerminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RawPunchLog" DROP CONSTRAINT IF EXISTS "RawPunchLog_matchedEmployeeId_fkey";
ALTER TABLE "RawPunchLog" ADD CONSTRAINT "RawPunchLog_matchedEmployeeId_fkey"
    FOREIGN KEY ("matchedEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
