-- CoreERP Phase 5: Quotations, Billing, Customer Receipts & Accounting Integration Migration
-- Non-destructively adds Customer, Quotation, QuotationLine, Invoice, InvoiceLine, CustomerReceipt, and ReceiptAllocation

-- 1. Create Enums
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QuotationStatus') THEN
        CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InvoiceStatus') THEN
        CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentMethod') THEN
        CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'CREDIT_CARD', 'OTHER');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReceiptStatus') THEN
        CREATE TYPE "ReceiptStatus" AS ENUM ('POSTED', 'VOID');
    END IF;
END $$;

-- 2. Create Table: Customer
CREATE TABLE IF NOT EXISTS "Customer" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(32),
    "address" TEXT,
    "taxId" VARCHAR(64),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "receivableLedgerId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Customer_companyId_code_key" ON "Customer"("companyId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_companyId_name_key" ON "Customer"("companyId", "name");
CREATE INDEX IF NOT EXISTS "Customer_companyId_idx" ON "Customer"("companyId");
CREATE INDEX IF NOT EXISTS "Customer_isActive_idx" ON "Customer"("isActive");

ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_companyId_fkey";
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_receivableLedgerId_fkey";
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_receivableLedgerId_fkey"
    FOREIGN KEY ("receivableLedgerId") REFERENCES "AccountLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Create Table: Quotation
CREATE TABLE IF NOT EXISTS "Quotation" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "quotationNumber" VARCHAR(64) NOT NULL,
    "customerId" UUID,
    "customerName" VARCHAR(128) NOT NULL,
    "customerEmail" VARCHAR(255),
    "customerPhone" VARCHAR(32),
    "customerAddress" TEXT,
    "quotationDate" DATE NOT NULL,
    "validUntilDate" DATE NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "discountTotal" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "taxTotal" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "notes" TEXT,
    "terms" TEXT,
    "documentTitle" VARCHAR(64),
    "convertedToInvoiceId" UUID,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Quotation_companyId_quotationNumber_key" ON "Quotation"("companyId", "quotationNumber");
CREATE INDEX IF NOT EXISTS "Quotation_companyId_idx" ON "Quotation"("companyId");
CREATE INDEX IF NOT EXISTS "Quotation_status_idx" ON "Quotation"("status");
CREATE INDEX IF NOT EXISTS "Quotation_quotationDate_idx" ON "Quotation"("quotationDate");
CREATE INDEX IF NOT EXISTS "Quotation_customerId_idx" ON "Quotation"("customerId");

ALTER TABLE "Quotation" DROP CONSTRAINT IF EXISTS "Quotation_companyId_fkey";
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Quotation" DROP CONSTRAINT IF EXISTS "Quotation_customerId_fkey";
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Quotation" DROP CONSTRAINT IF EXISTS "Quotation_createdByUserId_fkey";
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Create Table: QuotationLine
CREATE TABLE IF NOT EXISTS "QuotationLine" (
    "id" UUID NOT NULL,
    "quotationId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "itemDescription" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1.0000,
    "unitPrice" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "taxRate" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "lineTotal" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuotationLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "QuotationLine_quotationId_lineNumber_key" ON "QuotationLine"("quotationId", "lineNumber");
CREATE INDEX IF NOT EXISTS "QuotationLine_quotationId_idx" ON "QuotationLine"("quotationId");

ALTER TABLE "QuotationLine" DROP CONSTRAINT IF EXISTS "QuotationLine_quotationId_fkey";
ALTER TABLE "QuotationLine" ADD CONSTRAINT "QuotationLine_quotationId_fkey"
    FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Create Table: Invoice
CREATE TABLE IF NOT EXISTS "Invoice" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "invoiceNumber" VARCHAR(64) NOT NULL,
    "quotationId" UUID,
    "customerId" UUID,
    "customerName" VARCHAR(128) NOT NULL,
    "customerEmail" VARCHAR(255),
    "customerPhone" VARCHAR(32),
    "customerAddress" TEXT,
    "customerTaxId" VARCHAR(64),
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "discountTotal" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "taxTotal" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "amountPaid" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "balanceDue" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "notes" TEXT,
    "terms" TEXT,
    "documentTitle" VARCHAR(64),
    "journalEntryId" UUID,
    "issuedAt" TIMESTAMPTZ(6),
    "issuedByUserId" UUID,
    "voidedAt" TIMESTAMPTZ(6),
    "voidedByUserId" UUID,
    "voidReason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_companyId_invoiceNumber_key" ON "Invoice"("companyId", "invoiceNumber");
CREATE INDEX IF NOT EXISTS "Invoice_companyId_idx" ON "Invoice"("companyId");
CREATE INDEX IF NOT EXISTS "Invoice_status_idx" ON "Invoice"("status");
CREATE INDEX IF NOT EXISTS "Invoice_invoiceDate_idx" ON "Invoice"("invoiceDate");
CREATE INDEX IF NOT EXISTS "Invoice_dueDate_idx" ON "Invoice"("dueDate");
CREATE INDEX IF NOT EXISTS "Invoice_customerId_idx" ON "Invoice"("customerId");
CREATE INDEX IF NOT EXISTS "Invoice_quotationId_idx" ON "Invoice"("quotationId");

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_companyId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_quotationId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_quotationId_fkey"
    FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_customerId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_journalEntryId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_journalEntryId_fkey"
    FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_issuedByUserId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_issuedByUserId_fkey"
    FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_voidedByUserId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_voidedByUserId_fkey"
    FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_createdByUserId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Create Table: InvoiceLine
CREATE TABLE IF NOT EXISTS "InvoiceLine" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "itemDescription" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1.0000,
    "unitPrice" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "taxRate" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "lineTotal" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "revenueLedgerId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceLine_invoiceId_lineNumber_key" ON "InvoiceLine"("invoiceId", "lineNumber");
CREATE INDEX IF NOT EXISTS "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");
CREATE INDEX IF NOT EXISTS "InvoiceLine_revenueLedgerId_idx" ON "InvoiceLine"("revenueLedgerId");

ALTER TABLE "InvoiceLine" DROP CONSTRAINT IF EXISTS "InvoiceLine_invoiceId_fkey";
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceLine" DROP CONSTRAINT IF EXISTS "InvoiceLine_revenueLedgerId_fkey";
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_revenueLedgerId_fkey"
    FOREIGN KEY ("revenueLedgerId") REFERENCES "AccountLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Create Table: CustomerReceipt
CREATE TABLE IF NOT EXISTS "CustomerReceipt" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "receiptNumber" VARCHAR(64) NOT NULL,
    "receiptDate" DATE NOT NULL,
    "customerId" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "allocatedTotal" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "unallocatedAmount" DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "referenceNumber" VARCHAR(128),
    "receivingLedgerId" UUID NOT NULL,
    "receivableLedgerId" UUID NOT NULL,
    "journalEntryId" UUID,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'POSTED',
    "notes" TEXT,
    "voidedAt" TIMESTAMPTZ(6),
    "voidedByUserId" UUID,
    "voidReason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CustomerReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerReceipt_companyId_receiptNumber_key" ON "CustomerReceipt"("companyId", "receiptNumber");
CREATE INDEX IF NOT EXISTS "CustomerReceipt_companyId_idx" ON "CustomerReceipt"("companyId");
CREATE INDEX IF NOT EXISTS "CustomerReceipt_customerId_idx" ON "CustomerReceipt"("customerId");
CREATE INDEX IF NOT EXISTS "CustomerReceipt_receiptDate_idx" ON "CustomerReceipt"("receiptDate");
CREATE INDEX IF NOT EXISTS "CustomerReceipt_status_idx" ON "CustomerReceipt"("status");

ALTER TABLE "CustomerReceipt" DROP CONSTRAINT IF EXISTS "CustomerReceipt_companyId_fkey";
ALTER TABLE "CustomerReceipt" ADD CONSTRAINT "CustomerReceipt_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerReceipt" DROP CONSTRAINT IF EXISTS "CustomerReceipt_customerId_fkey";
ALTER TABLE "CustomerReceipt" ADD CONSTRAINT "CustomerReceipt_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerReceipt" DROP CONSTRAINT IF EXISTS "CustomerReceipt_receivingLedgerId_fkey";
ALTER TABLE "CustomerReceipt" ADD CONSTRAINT "CustomerReceipt_receivingLedgerId_fkey"
    FOREIGN KEY ("receivingLedgerId") REFERENCES "AccountLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerReceipt" DROP CONSTRAINT IF EXISTS "CustomerReceipt_receivableLedgerId_fkey";
ALTER TABLE "CustomerReceipt" ADD CONSTRAINT "CustomerReceipt_receivableLedgerId_fkey"
    FOREIGN KEY ("receivableLedgerId") REFERENCES "AccountLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerReceipt" DROP CONSTRAINT IF EXISTS "CustomerReceipt_journalEntryId_fkey";
ALTER TABLE "CustomerReceipt" ADD CONSTRAINT "CustomerReceipt_journalEntryId_fkey"
    FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomerReceipt" DROP CONSTRAINT IF EXISTS "CustomerReceipt_voidedByUserId_fkey";
ALTER TABLE "CustomerReceipt" ADD CONSTRAINT "CustomerReceipt_voidedByUserId_fkey"
    FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomerReceipt" DROP CONSTRAINT IF EXISTS "CustomerReceipt_createdByUserId_fkey";
ALTER TABLE "CustomerReceipt" ADD CONSTRAINT "CustomerReceipt_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 8. Create Table: ReceiptAllocation
CREATE TABLE IF NOT EXISTS "ReceiptAllocation" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "allocatedAmount" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptAllocation_receiptId_invoiceId_key" ON "ReceiptAllocation"("receiptId", "invoiceId");
CREATE INDEX IF NOT EXISTS "ReceiptAllocation_receiptId_idx" ON "ReceiptAllocation"("receiptId");
CREATE INDEX IF NOT EXISTS "ReceiptAllocation_invoiceId_idx" ON "ReceiptAllocation"("invoiceId");
CREATE INDEX IF NOT EXISTS "ReceiptAllocation_companyId_idx" ON "ReceiptAllocation"("companyId");

ALTER TABLE "ReceiptAllocation" DROP CONSTRAINT IF EXISTS "ReceiptAllocation_companyId_fkey";
ALTER TABLE "ReceiptAllocation" ADD CONSTRAINT "ReceiptAllocation_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReceiptAllocation" DROP CONSTRAINT IF EXISTS "ReceiptAllocation_receiptId_fkey";
ALTER TABLE "ReceiptAllocation" ADD CONSTRAINT "ReceiptAllocation_receiptId_fkey"
    FOREIGN KEY ("receiptId") REFERENCES "CustomerReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReceiptAllocation" DROP CONSTRAINT IF EXISTS "ReceiptAllocation_invoiceId_fkey";
ALTER TABLE "ReceiptAllocation" ADD CONSTRAINT "ReceiptAllocation_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
