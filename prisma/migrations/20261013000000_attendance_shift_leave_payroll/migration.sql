-- CoreERP Phase 7.1: Attendance, Shift, Leave and Payroll Database Foundation Migration
-- Non-destructively adds Shift, Attendance, LeaveType, LeaveRequest, PayrollPeriod, and Payslip models

-- 1. Create Enums
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AttendanceStatus') THEN
        CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'HALF_DAY', 'LATE', 'ON_LEAVE');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AttendanceSource') THEN
        CREATE TYPE "AttendanceSource" AS ENUM ('MANUAL', 'BIOMETRIC');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LeaveStatus') THEN
        CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PayrollStatus') THEN
        CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'PROCESSED', 'POSTED', 'CANCELLED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PayslipStatus') THEN
        CREATE TYPE "PayslipStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');
    END IF;
END $$;

-- 2. Create Table: Shift
CREATE TABLE IF NOT EXISTS "Shift" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "startTime" VARCHAR(8) NOT NULL,
    "endTime" VARCHAR(8) NOT NULL,
    "isOvernight" BOOLEAN NOT NULL DEFAULT false,
    "graceMinutes" INTEGER NOT NULL DEFAULT 15,
    "halfDayMinutes" INTEGER NOT NULL DEFAULT 240,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Shift_companyId_code_key" ON "Shift"("companyId", "code");
CREATE INDEX IF NOT EXISTS "Shift_companyId_idx" ON "Shift"("companyId");
CREATE INDEX IF NOT EXISTS "Shift_isActive_idx" ON "Shift"("isActive");

ALTER TABLE "Shift" DROP CONSTRAINT IF EXISTS "Shift_companyId_fkey";
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Add shift relation to Employee
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "shiftId" UUID;
CREATE INDEX IF NOT EXISTS "Employee_shiftId_idx" ON "Employee"("shiftId");

ALTER TABLE "Employee" DROP CONSTRAINT IF EXISTS "Employee_shiftId_fkey";
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Create Table: Attendance
CREATE TABLE IF NOT EXISTS "Attendance" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "shiftId" UUID,
    "workDate" DATE NOT NULL,
    "checkIn" TIMESTAMPTZ(6),
    "checkOut" TIMESTAMPTZ(6),
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "source" "AttendanceSource" NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Attendance_companyId_employeeId_workDate_key" ON "Attendance"("companyId", "employeeId", "workDate");
CREATE INDEX IF NOT EXISTS "Attendance_companyId_idx" ON "Attendance"("companyId");
CREATE INDEX IF NOT EXISTS "Attendance_employeeId_idx" ON "Attendance"("employeeId");
CREATE INDEX IF NOT EXISTS "Attendance_workDate_idx" ON "Attendance"("workDate");
CREATE INDEX IF NOT EXISTS "Attendance_status_idx" ON "Attendance"("status");

ALTER TABLE "Attendance" DROP CONSTRAINT IF EXISTS "Attendance_companyId_fkey";
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Attendance" DROP CONSTRAINT IF EXISTS "Attendance_employeeId_fkey";
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Attendance" DROP CONSTRAINT IF EXISTS "Attendance_shiftId_fkey";
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. Create Table: LeaveType
CREATE TABLE IF NOT EXISTS "LeaveType" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "defaultAllowance" INTEGER NOT NULL DEFAULT 12,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LeaveType_companyId_code_key" ON "LeaveType"("companyId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "LeaveType_companyId_name_key" ON "LeaveType"("companyId", "name");
CREATE INDEX IF NOT EXISTS "LeaveType_companyId_idx" ON "LeaveType"("companyId");
CREATE INDEX IF NOT EXISTS "LeaveType_isActive_idx" ON "LeaveType"("isActive");

ALTER TABLE "LeaveType" DROP CONSTRAINT IF EXISTS "LeaveType_companyId_fkey";
ALTER TABLE "LeaveType" ADD CONSTRAINT "LeaveType_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Create Table: LeaveRequest
CREATE TABLE IF NOT EXISTS "LeaveRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "totalDays" DECIMAL(5, 2) NOT NULL DEFAULT 1.00,
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMPTZ(6),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeaveRequest_companyId_idx" ON "LeaveRequest"("companyId");
CREATE INDEX IF NOT EXISTS "LeaveRequest_employeeId_idx" ON "LeaveRequest"("employeeId");
CREATE INDEX IF NOT EXISTS "LeaveRequest_leaveTypeId_idx" ON "LeaveRequest"("leaveTypeId");
CREATE INDEX IF NOT EXISTS "LeaveRequest_status_idx" ON "LeaveRequest"("status");
CREATE INDEX IF NOT EXISTS "LeaveRequest_startDate_idx" ON "LeaveRequest"("startDate");

ALTER TABLE "LeaveRequest" DROP CONSTRAINT IF EXISTS "LeaveRequest_companyId_fkey";
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" DROP CONSTRAINT IF EXISTS "LeaveRequest_employeeId_fkey";
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" DROP CONSTRAINT IF EXISTS "LeaveRequest_leaveTypeId_fkey";
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_leaveTypeId_fkey"
    FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" DROP CONSTRAINT IF EXISTS "LeaveRequest_reviewedByUserId_fkey";
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 7. Create Table: PayrollPeriod
CREATE TABLE IF NOT EXISTS "PayrollPeriod" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "name" VARCHAR(64),
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "processedAt" TIMESTAMPTZ(6),
    "postedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_companyId_year_month_key" ON "PayrollPeriod"("companyId", "year", "month");
CREATE INDEX IF NOT EXISTS "PayrollPeriod_companyId_idx" ON "PayrollPeriod"("companyId");
CREATE INDEX IF NOT EXISTS "PayrollPeriod_status_idx" ON "PayrollPeriod"("status");
CREATE INDEX IF NOT EXISTS "PayrollPeriod_year_month_idx" ON "PayrollPeriod"("year", "month");

ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_companyId_fkey";
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_createdByUserId_fkey";
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 8. Create Table: Payslip
CREATE TABLE IF NOT EXISTS "Payslip" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "payrollPeriodId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "basicSalary" DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    "allowances" DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    "overtimePay" DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    "grossSalary" DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    "deductions" DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    "lossOfPayDeduction" DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    "netSalary" DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    "status" "PayslipStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentMethod" VARCHAR(32),
    "paymentDate" DATE,
    "ledgerId" UUID,
    "journalEntryId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Payslip_payrollPeriodId_employeeId_key" ON "Payslip"("payrollPeriodId", "employeeId");
CREATE INDEX IF NOT EXISTS "Payslip_companyId_idx" ON "Payslip"("companyId");
CREATE INDEX IF NOT EXISTS "Payslip_payrollPeriodId_idx" ON "Payslip"("payrollPeriodId");
CREATE INDEX IF NOT EXISTS "Payslip_employeeId_idx" ON "Payslip"("employeeId");
CREATE INDEX IF NOT EXISTS "Payslip_status_idx" ON "Payslip"("status");

ALTER TABLE "Payslip" DROP CONSTRAINT IF EXISTS "Payslip_companyId_fkey";
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payslip" DROP CONSTRAINT IF EXISTS "Payslip_payrollPeriodId_fkey";
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_payrollPeriodId_fkey"
    FOREIGN KEY ("payrollPeriodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payslip" DROP CONSTRAINT IF EXISTS "Payslip_employeeId_fkey";
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payslip" DROP CONSTRAINT IF EXISTS "Payslip_ledgerId_fkey";
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "AccountLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payslip" DROP CONSTRAINT IF EXISTS "Payslip_journalEntryId_fkey";
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_journalEntryId_fkey"
    FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
