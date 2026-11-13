-- AlterEnum
ALTER TYPE "DocumentNumberType" ADD VALUE 'EXPENSE_CLAIM';

-- CreateEnum
CREATE TYPE "ExpenseClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTS_APPROVED', 'PAID', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('TRAVEL', 'MEALS', 'LODGING', 'OFFICE_SUPPLIES', 'COMMUNICATION', 'SOFTWARE', 'TRAINING', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpensePaymentMethod" AS ENUM ('BANK_TRANSFER', 'CHEQUE', 'CASH');

-- CreateTable
CREATE TABLE "ExpenseClaim" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "claimNumber" VARCHAR(64) NOT NULL,
    "employeeId" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "originalExpenseDate" DATE NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "totalAmount" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "status" "ExpenseClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "managerId" UUID,
    "managerApprovedAt" TIMESTAMPTZ(6),
    "managerApprovedById" UUID,
    "accountsApprovedAt" TIMESTAMPTZ(6),
    "accountsApprovedById" UUID,
    "payableLedgerId" UUID,
    "journalEntryId" UUID,
    "paidAt" TIMESTAMPTZ(6),
    "paidById" UUID,
    "paymentJournalEntryId" UUID,
    "paymentReference" VARCHAR(128),
    "paymentMethod" "ExpensePaymentMethod",
    "bankAccountId" UUID,
    "bankLedgerId" UUID,
    "rejectionReason" TEXT,
    "returnReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ExpenseClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseClaimLine" (
    "id" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "category" "ExpenseCategory" NOT NULL DEFAULT 'OTHER',
    "description" VARCHAR(255) NOT NULL,
    "expenseDate" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "merchant" VARCHAR(128),
    "expenseLedgerId" UUID,
    "attachmentId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ExpenseClaimLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseClaimAttachment" (
    "id" UUID NOT NULL,
    "claimId" UUID,
    "companyId" UUID NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "storageKey" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(128) NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "sha256Hash" VARCHAR(64) NOT NULL,
    "uploadedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseClaimAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseClaimEvent" (
    "id" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "fromStatus" "ExpenseClaimStatus",
    "toStatus" "ExpenseClaimStatus" NOT NULL,
    "actorUserId" UUID NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseClaimEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpenseClaim_companyId_idx" ON "ExpenseClaim"("companyId");
CREATE INDEX "ExpenseClaim_employeeId_idx" ON "ExpenseClaim"("employeeId");
CREATE INDEX "ExpenseClaim_managerId_idx" ON "ExpenseClaim"("managerId");
CREATE INDEX "ExpenseClaim_status_idx" ON "ExpenseClaim"("status");
CREATE INDEX "ExpenseClaim_originalExpenseDate_idx" ON "ExpenseClaim"("originalExpenseDate");
CREATE UNIQUE INDEX "ExpenseClaim_companyId_claimNumber_key" ON "ExpenseClaim"("companyId", "claimNumber");

-- CreateIndex
CREATE INDEX "ExpenseClaimLine_claimId_idx" ON "ExpenseClaimLine"("claimId");
CREATE INDEX "ExpenseClaimLine_companyId_idx" ON "ExpenseClaimLine"("companyId");
CREATE INDEX "ExpenseClaimLine_expenseLedgerId_idx" ON "ExpenseClaimLine"("expenseLedgerId");
CREATE INDEX "ExpenseClaimLine_category_idx" ON "ExpenseClaimLine"("category");

-- CreateIndex
CREATE INDEX "ExpenseClaimAttachment_companyId_idx" ON "ExpenseClaimAttachment"("companyId");
CREATE INDEX "ExpenseClaimAttachment_claimId_idx" ON "ExpenseClaimAttachment"("claimId");
CREATE INDEX "ExpenseClaimAttachment_sha256Hash_idx" ON "ExpenseClaimAttachment"("sha256Hash");

-- CreateIndex
CREATE INDEX "ExpenseClaimEvent_claimId_idx" ON "ExpenseClaimEvent"("claimId");
CREATE INDEX "ExpenseClaimEvent_companyId_idx" ON "ExpenseClaimEvent"("companyId");
CREATE INDEX "ExpenseClaimEvent_actorUserId_idx" ON "ExpenseClaimEvent"("actorUserId");

-- AddForeignKey
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_managerApprovedById_fkey" FOREIGN KEY ("managerApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_accountsApprovedById_fkey" FOREIGN KEY ("accountsApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_payableLedgerId_fkey" FOREIGN KEY ("payableLedgerId") REFERENCES "AccountLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_paymentJournalEntryId_fkey" FOREIGN KEY ("paymentJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "CompanyBankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_bankLedgerId_fkey" FOREIGN KEY ("bankLedgerId") REFERENCES "AccountLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaimLine" ADD CONSTRAINT "ExpenseClaimLine_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExpenseClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaimLine" ADD CONSTRAINT "ExpenseClaimLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaimLine" ADD CONSTRAINT "ExpenseClaimLine_expenseLedgerId_fkey" FOREIGN KEY ("expenseLedgerId") REFERENCES "AccountLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaimLine" ADD CONSTRAINT "ExpenseClaimLine_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "ExpenseClaimAttachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaimAttachment" ADD CONSTRAINT "ExpenseClaimAttachment_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExpenseClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaimAttachment" ADD CONSTRAINT "ExpenseClaimAttachment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaimAttachment" ADD CONSTRAINT "ExpenseClaimAttachment_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaimEvent" ADD CONSTRAINT "ExpenseClaimEvent_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExpenseClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaimEvent" ADD CONSTRAINT "ExpenseClaimEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseClaimEvent" ADD CONSTRAINT "ExpenseClaimEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
