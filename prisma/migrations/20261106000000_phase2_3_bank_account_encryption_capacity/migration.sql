-- Phase 2.3: Expand CompanyBankAccount sensitive fields to accommodate AES-256-GCM ciphertext + IV + Tag
-- Strictly additive migration: widens existing VARCHAR columns to VARCHAR(255)
-- Enforces lock_timeout = '3s' to prevent lock queue starvation

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "CompanyBankAccount"
    ALTER COLUMN "accountNumber" TYPE VARCHAR(255),
    ALTER COLUMN "routingCode" TYPE VARCHAR(255),
    ALTER COLUMN "branchName" TYPE VARCHAR(255),
    ALTER COLUMN "swiftBic" TYPE VARCHAR(255),
    ALTER COLUMN "iban" TYPE VARCHAR(255),
    ALTER COLUMN "upiId" TYPE VARCHAR(255);

COMMIT;
