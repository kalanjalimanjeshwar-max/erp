-- CoreERP Migration 10: Role Enum Modernization & Deprecated Values Cleanup
-- Safely replaces legacy 6-value Role enum with the 4 active enterprise roles:
-- ('SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE')

-- Step 1: Pre-flight Data Safety Assertions (fail safely without auto-mapping)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "User" 
        WHERE "role"::text IN ('MANAGER', 'USER')
    ) THEN
        RAISE EXCEPTION 'Migration 10 aborted: Found legacy role values (MANAGER or USER) in "User" table. Manual data remediation required.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM "RolePermission" 
        WHERE "role"::text IN ('MANAGER', 'USER')
    ) THEN
        RAISE EXCEPTION 'Migration 10 aborted: Found legacy role values (MANAGER or USER) in "RolePermission" table. Manual data remediation required.';
    END IF;
END $$;

-- Step 2: Rename legacy enum type
ALTER TYPE "Role" RENAME TO "Role_old";

-- Step 3: Create replacement enum type with exactly the 4 active roles
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE');

-- Step 4: Update Table "User"
-- Drop default bound to Role_old, convert column type with text intermediate cast, restore default bound to new Role
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "User" 
    ALTER COLUMN "role" TYPE "Role" 
    USING ("role"::text::"Role");

ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'EMPLOYEE';

-- Step 5: Update Table "RolePermission"
ALTER TABLE "RolePermission" 
    ALTER COLUMN "role" TYPE "Role" 
    USING ("role"::text::"Role");

-- Step 6: Drop legacy enum type without CASCADE
DROP TYPE "Role_old";
