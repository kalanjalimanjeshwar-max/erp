-- CoreERP Stage 2.1: Persistent Admin Notifications Foundation Migration
-- Generated for review from prisma/schema.prisma
-- Non-destructive DDL: adds Notification and NotificationUserState models, enums, composite unique constraints, and composite tenant-integrity foreign keys

-- 1. Create Enums
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationSeverity') THEN
        CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARN', 'ERROR');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationEventStatus') THEN
        CREATE TYPE "NotificationEventStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'CANCELLED');
    END IF;
END $$;

-- 2. Prerequisite Composite Unique Index on existing User table for tenant-scoped foreign keys
CREATE UNIQUE INDEX IF NOT EXISTS "User_id_companyId_key" 
    ON "User"("id", "companyId");

-- 3. Create Table: Notification (Company-wide operational event alert)
CREATE TABLE IF NOT EXISTS "Notification" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "dedupeKey" VARCHAR(128) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'WARN',
    "title" VARCHAR(128) NOT NULL,
    "message" TEXT NOT NULL,
    "actionUrl" VARCHAR(255) NOT NULL,
    "status" "NotificationEventStatus" NOT NULL DEFAULT 'ACTIVE',
    "employeeId" UUID,
    "workDate" DATE,
    "metadata" JSONB,
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- Unique constraints and indexes for Notification
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_companyId_dedupeKey_key" 
    ON "Notification"("companyId", "dedupeKey");

CREATE UNIQUE INDEX IF NOT EXISTS "Notification_id_companyId_key" 
    ON "Notification"("id", "companyId");

CREATE INDEX IF NOT EXISTS "Notification_companyId_status_idx" 
    ON "Notification"("companyId", "status");

CREATE INDEX IF NOT EXISTS "Notification_companyId_createdAt_idx" 
    ON "Notification"("companyId", "createdAt");

CREATE INDEX IF NOT EXISTS "Notification_employeeId_idx" 
    ON "Notification"("employeeId");

-- Foreign Keys for Notification
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_companyId_fkey" 
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_employeeId_fkey" 
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Create Table: NotificationUserState (Independent per-admin read/dismissal state)
CREATE TABLE IF NOT EXISTS "NotificationUserState" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMPTZ(6),
    "isDismissed" BOOLEAN NOT NULL DEFAULT false,
    "dismissedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "NotificationUserState_pkey" PRIMARY KEY ("id")
);

-- Unique constraints and indexes for NotificationUserState
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationUserState_notificationId_userId_key" 
    ON "NotificationUserState"("notificationId", "userId");

CREATE INDEX IF NOT EXISTS "NotificationUserState_userId_companyId_isDismissed_isRead_idx" 
    ON "NotificationUserState"("userId", "companyId", "isDismissed", "isRead");

CREATE INDEX IF NOT EXISTS "NotificationUserState_companyId_idx" 
    ON "NotificationUserState"("companyId");

-- Foreign Keys for NotificationUserState
-- Standalone tenant protection foreign key
ALTER TABLE "NotificationUserState" ADD CONSTRAINT "NotificationUserState_companyId_fkey" 
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite tenant-integrity foreign key to Notification (enforces matching companyId)
ALTER TABLE "NotificationUserState" ADD CONSTRAINT "NotificationUserState_notificationId_companyId_fkey" 
    FOREIGN KEY ("notificationId", "companyId") REFERENCES "Notification"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite tenant-integrity foreign key to User (enforces matching companyId)
ALTER TABLE "NotificationUserState" ADD CONSTRAINT "NotificationUserState_userId_companyId_fkey" 
    FOREIGN KEY ("userId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
