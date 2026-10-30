-- CoreERP Phase 3: Authentication, RBAC, and Company Administration Migration
-- Non-destructive addition of company contact/branding fields and RolePermission matrix

-- 1. Extend Company with operational profile and header branding fields
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "address" VARCHAR(255);
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "phone" VARCHAR(32);
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "email" VARCHAR(255);
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "website" VARCHAR(255);
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "appHeaderTitle" VARCHAR(128);

-- 2. Create RolePermission Table for explicit module and action permissions
CREATE TABLE IF NOT EXISTS "RolePermission" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "module" VARCHAR(64) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "isGranted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- 3. Composite Uniqueness and Performance Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "RolePermission_companyId_role_module_action_key" 
    ON "RolePermission"("companyId", "role", "module", "action");

CREATE INDEX IF NOT EXISTS "RolePermission_companyId_role_idx" 
    ON "RolePermission"("companyId", "role");

CREATE INDEX IF NOT EXISTS "RolePermission_companyId_module_idx" 
    ON "RolePermission"("companyId", "module");

-- 4. Foreign Key with RESTRICT deletion policy
ALTER TABLE "RolePermission" DROP CONSTRAINT IF EXISTS "RolePermission_companyId_fkey";
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_companyId_fkey" 
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
