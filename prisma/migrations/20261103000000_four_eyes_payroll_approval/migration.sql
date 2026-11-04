-- CoreERP Migration 11: Four-Eyes Dual Approval for Payroll Finalization (SEC-11-03)
-- Introduces ACCOUNTS_APPROVED lifecycle stage to PayrollStatus enum and adds
-- accountsApprovedAt, accountsApprovedByUserId, accountsApprovalNotes, adminApprovedAt,
-- and adminApprovedByUserId tracking fields to PayrollPeriod.

-- Step 1: Add ACCOUNTS_APPROVED value to PayrollStatus enum
ALTER TYPE "PayrollStatus" ADD VALUE IF NOT EXISTS 'ACCOUNTS_APPROVED';

-- Step 2: Add approval tracking columns to PayrollPeriod table
ALTER TABLE "PayrollPeriod" 
    ADD COLUMN IF NOT EXISTS "accountsApprovedAt" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "accountsApprovedByUserId" UUID,
    ADD COLUMN IF NOT EXISTS "accountsApprovalNotes" TEXT,
    ADD COLUMN IF NOT EXISTS "adminApprovedAt" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "adminApprovedByUserId" UUID;

-- Step 3: Create indices on approver foreign keys for performant join & audit resolution
CREATE INDEX IF NOT EXISTS "PayrollPeriod_accountsApprovedByUserId_idx" ON "PayrollPeriod"("accountsApprovedByUserId");
CREATE INDEX IF NOT EXISTS "PayrollPeriod_adminApprovedByUserId_idx" ON "PayrollPeriod"("adminApprovedByUserId");

-- Step 4: Add foreign key constraints linking to User table with RESTRICT on delete
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_accountsApprovedByUserId_fkey'
    ) THEN
        ALTER TABLE "PayrollPeriod" 
            ADD CONSTRAINT "PayrollPeriod_accountsApprovedByUserId_fkey" 
            FOREIGN KEY ("accountsApprovedByUserId") 
            REFERENCES "User"("id") 
            ON DELETE RESTRICT 
            ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_adminApprovedByUserId_fkey'
    ) THEN
        ALTER TABLE "PayrollPeriod" 
            ADD CONSTRAINT "PayrollPeriod_adminApprovedByUserId_fkey" 
            FOREIGN KEY ("adminApprovedByUserId") 
            REFERENCES "User"("id") 
            ON DELETE RESTRICT 
            ON UPDATE CASCADE;
    END IF;
END $$;
