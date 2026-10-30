-- CoreERP Phase 6: Employee Management, Departments, Designations & Salary Structure Migration
-- Non-destructively adds Department, Designation, Employee, and SalaryRevision models

-- 1. Create Enums
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmployeeStatus') THEN
        CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXITED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmploymentType') THEN
        CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN');
    END IF;
END $$;

-- 2. Create Table: Department
CREATE TABLE IF NOT EXISTS "Department" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Department_companyId_code_key" ON "Department"("companyId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "Department_companyId_name_key" ON "Department"("companyId", "name");
CREATE INDEX IF NOT EXISTS "Department_companyId_idx" ON "Department"("companyId");
CREATE INDEX IF NOT EXISTS "Department_isActive_idx" ON "Department"("isActive");

ALTER TABLE "Department" DROP CONSTRAINT IF EXISTS "Department_companyId_fkey";
ALTER TABLE "Department" ADD CONSTRAINT "Department_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Create Table: Designation
CREATE TABLE IF NOT EXISTS "Designation" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Designation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Designation_companyId_code_key" ON "Designation"("companyId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "Designation_companyId_name_key" ON "Designation"("companyId", "name");
CREATE INDEX IF NOT EXISTS "Designation_companyId_idx" ON "Designation"("companyId");
CREATE INDEX IF NOT EXISTS "Designation_isActive_idx" ON "Designation"("isActive");

ALTER TABLE "Designation" DROP CONSTRAINT IF EXISTS "Designation_companyId_fkey";
ALTER TABLE "Designation" ADD CONSTRAINT "Designation_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Create Table: Employee
CREATE TABLE IF NOT EXISTS "Employee" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "employeeCode" VARCHAR(32) NOT NULL,
    "fullName" VARCHAR(128) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(32),
    "address" VARCHAR(255),
    "photoUrl" VARCHAR(512),
    "dateOfBirth" DATE,
    "dateOfJoining" DATE NOT NULL,
    "departmentId" UUID,
    "designationId" UUID,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "biometricDeviceId" VARCHAR(64),
    "userId" UUID,
    "ledgerId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Employee_companyId_employeeCode_key" ON "Employee"("companyId", "employeeCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_userId_key" ON "Employee"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_ledgerId_key" ON "Employee"("ledgerId");
CREATE INDEX IF NOT EXISTS "Employee_companyId_idx" ON "Employee"("companyId");
CREATE INDEX IF NOT EXISTS "Employee_departmentId_idx" ON "Employee"("departmentId");
CREATE INDEX IF NOT EXISTS "Employee_designationId_idx" ON "Employee"("designationId");
CREATE INDEX IF NOT EXISTS "Employee_status_idx" ON "Employee"("status");
CREATE INDEX IF NOT EXISTS "Employee_dateOfJoining_idx" ON "Employee"("dateOfJoining");

ALTER TABLE "Employee" DROP CONSTRAINT IF EXISTS "Employee_companyId_fkey";
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Employee" DROP CONSTRAINT IF EXISTS "Employee_departmentId_fkey";
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Employee" DROP CONSTRAINT IF EXISTS "Employee_designationId_fkey";
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_designationId_fkey"
    FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Employee" DROP CONSTRAINT IF EXISTS "Employee_userId_fkey";
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Employee" DROP CONSTRAINT IF EXISTS "Employee_ledgerId_fkey";
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "AccountLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Create Table: SalaryRevision
CREATE TABLE IF NOT EXISTS "SalaryRevision" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "fixedSalary" DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "revisionReason" VARCHAR(255),
    "notes" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SalaryRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SalaryRevision_companyId_idx" ON "SalaryRevision"("companyId");
CREATE INDEX IF NOT EXISTS "SalaryRevision_employeeId_idx" ON "SalaryRevision"("employeeId");
CREATE INDEX IF NOT EXISTS "SalaryRevision_effectiveFrom_idx" ON "SalaryRevision"("effectiveFrom");

ALTER TABLE "SalaryRevision" DROP CONSTRAINT IF EXISTS "SalaryRevision_companyId_fkey";
ALTER TABLE "SalaryRevision" ADD CONSTRAINT "SalaryRevision_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalaryRevision" DROP CONSTRAINT IF EXISTS "SalaryRevision_employeeId_fkey";
ALTER TABLE "SalaryRevision" ADD CONSTRAINT "SalaryRevision_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalaryRevision" DROP CONSTRAINT IF EXISTS "SalaryRevision_createdByUserId_fkey";
ALTER TABLE "SalaryRevision" ADD CONSTRAINT "SalaryRevision_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
