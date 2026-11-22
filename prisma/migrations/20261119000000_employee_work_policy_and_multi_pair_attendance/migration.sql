-- CoreERP Migration: Effective-Dated Employee Work Policy & Multi-Pair Attendance
-- STRICTLY ADDITIVE AND NON-DESTRUCTIVE:
--   1. Adds nullable dailyWorkingHours and monthlyLeaveAllowance to Employee (with validation CHECKs)
--   2. Adds composite unique indexes on Employee, Shift, Attendance, and RawPunchLog for tenant-safe FKs
--   3. Adds EmployeeWorkPolicyRevision with composite tenant FKs, partial open-period uniqueness,
--      concurrency-safe daterange overlap trigger (zero-extension alternative to btree_gist), and CHECKs
--   4. Adds nullable/defaulted multi-pair summary columns to Attendance (preserving existing rows untouched)
--   5. Adds AttendancePunchEvent and AttendanceInterval tables with composite tenant/attendance FKs & CHECKs
-- Zero existing business data is modified, backfilled, or deleted.

SET lock_timeout = '3s';

-- 1. Prerequisite composite unique indexes on existing tables for composite tenant-safe FKs
CREATE UNIQUE INDEX IF NOT EXISTS "User_id_companyId_key"
    ON "User"("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_id_companyId_key"
    ON "Employee"("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "Shift_id_companyId_key"
    ON "Shift"("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "Attendance_id_companyId_key"
    ON "Attendance"("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "RawPunchLog_id_companyId_key"
    ON "RawPunchLog"("id", "companyId");

-- 2. Additive nullable configuration columns and validation CHECKs on Employee
ALTER TABLE "Employee"
    ADD COLUMN IF NOT EXISTS "dailyWorkingHours" DECIMAL(4, 2),
    ADD COLUMN IF NOT EXISTS "monthlyLeaveAllowance" DECIMAL(5, 2);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Employee_dailyWorkingHours_chk') THEN
        ALTER TABLE "Employee"
            ADD CONSTRAINT "Employee_dailyWorkingHours_chk"
            CHECK ("dailyWorkingHours" IS NULL OR ("dailyWorkingHours" > 0 AND "dailyWorkingHours" <= 24));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Employee_monthlyLeaveAllowance_chk') THEN
        ALTER TABLE "Employee"
            ADD CONSTRAINT "Employee_monthlyLeaveAllowance_chk"
            CHECK ("monthlyLeaveAllowance" IS NULL OR ("monthlyLeaveAllowance" >= 0 AND "monthlyLeaveAllowance" <= 31));
    END IF;
END $$;

-- 3. Effective-dated EmployeeWorkPolicyRevision history table
CREATE TABLE IF NOT EXISTS "EmployeeWorkPolicyRevision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "shiftId" UUID,
    "dailyWorkingHours" DECIMAL(4, 2),
    "monthlyLeaveAllowance" DECIMAL(5, 2),
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "revisionReason" VARCHAR(255),
    "notes" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeWorkPolicyRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeWorkPolicyRevision_comp_emp_effFrom_key"
    ON "EmployeeWorkPolicyRevision"("companyId", "employeeId", "effectiveFrom");
CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeWorkPolicyRevision_companyId_employeeId_open_key"
    ON "EmployeeWorkPolicyRevision"("companyId", "employeeId")
    WHERE "effectiveTo" IS NULL;
CREATE INDEX IF NOT EXISTS "EmployeeWorkPolicyRevision_comp_emp_range_idx"
    ON "EmployeeWorkPolicyRevision"("companyId", "employeeId", "effectiveFrom", "effectiveTo");
CREATE INDEX IF NOT EXISTS "EmployeeWorkPolicyRevision_employeeId_idx"
    ON "EmployeeWorkPolicyRevision"("employeeId");
CREATE INDEX IF NOT EXISTS "EmployeeWorkPolicyRevision_effectiveFrom_idx"
    ON "EmployeeWorkPolicyRevision"("effectiveFrom");
CREATE INDEX IF NOT EXISTS "EmployeeWorkPolicyRevision_shiftId_idx"
    ON "EmployeeWorkPolicyRevision"("shiftId");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeWorkPolicyRevision_companyId_fkey') THEN
        ALTER TABLE "EmployeeWorkPolicyRevision"
            ADD CONSTRAINT "EmployeeWorkPolicyRevision_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeWorkPolicyRevision_employeeId_companyId_fkey') THEN
        ALTER TABLE "EmployeeWorkPolicyRevision"
            ADD CONSTRAINT "EmployeeWorkPolicyRevision_employeeId_companyId_fkey"
            FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeWorkPolicyRevision_shiftId_companyId_fkey') THEN
        ALTER TABLE "EmployeeWorkPolicyRevision"
            ADD CONSTRAINT "EmployeeWorkPolicyRevision_shiftId_companyId_fkey"
            FOREIGN KEY ("shiftId", "companyId") REFERENCES "Shift"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeWorkPolicyRevision_createdByUserId_companyId_fkey') THEN
        ALTER TABLE "EmployeeWorkPolicyRevision"
            ADD CONSTRAINT "EmployeeWorkPolicyRevision_createdByUserId_companyId_fkey"
            FOREIGN KEY ("createdByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeWorkPolicyRevision_effective_dates_chk') THEN
        ALTER TABLE "EmployeeWorkPolicyRevision"
            ADD CONSTRAINT "EmployeeWorkPolicyRevision_effective_dates_chk"
            CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeWorkPolicyRevision_dailyWorkingHours_chk') THEN
        ALTER TABLE "EmployeeWorkPolicyRevision"
            ADD CONSTRAINT "EmployeeWorkPolicyRevision_dailyWorkingHours_chk"
            CHECK ("dailyWorkingHours" IS NULL OR ("dailyWorkingHours" > 0 AND "dailyWorkingHours" <= 24));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeWorkPolicyRevision_monthlyLeaveAllowance_chk') THEN
        ALTER TABLE "EmployeeWorkPolicyRevision"
            ADD CONSTRAINT "EmployeeWorkPolicyRevision_monthlyLeaveAllowance_chk"
            CHECK ("monthlyLeaveAllowance" IS NULL OR ("monthlyLeaveAllowance" >= 0 AND "monthlyLeaveAllowance" <= 31));
    END IF;
END $$;

-- Zero-extension concurrency-safe overlap protection for EmployeeWorkPolicyRevision
CREATE OR REPLACE FUNCTION "enforce_employee_work_policy_no_overlap"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NEW."effectiveTo" IS NOT NULL AND NEW."effectiveTo" < NEW."effectiveFrom" THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'coreerp:work_policy_revision:' || NEW."companyId"::text || ':' || NEW."employeeId"::text,
            0
        )
    );

    IF EXISTS (
        SELECT 1
        FROM "EmployeeWorkPolicyRevision" r
        WHERE r."companyId" = NEW."companyId"
          AND r."employeeId" = NEW."employeeId"
          AND r."id" <> NEW."id"
          AND daterange(r."effectiveFrom", r."effectiveTo", '[]')
              && daterange(NEW."effectiveFrom", NEW."effectiveTo", '[]')
    ) THEN
        RAISE EXCEPTION
            'Overlapping EmployeeWorkPolicyRevision period for company % and employee % (% to %)',
            NEW."companyId",
            NEW."employeeId",
            NEW."effectiveFrom",
            COALESCE(NEW."effectiveTo"::text, 'infinity')
            USING ERRCODE = '23P01',
                  CONSTRAINT = 'EmployeeWorkPolicyRevision_no_overlapping_periods';
    END IF;

    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'EmployeeWorkPolicyRevision_no_overlap_trg'
          AND tgrelid = '"EmployeeWorkPolicyRevision"'::regclass
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER "EmployeeWorkPolicyRevision_no_overlap_trg"
            BEFORE INSERT OR UPDATE OF "companyId", "employeeId", "effectiveFrom", "effectiveTo"
            ON "EmployeeWorkPolicyRevision"
            FOR EACH ROW
            EXECUTE FUNCTION "enforce_employee_work_policy_no_overlap"();
    END IF;
END $$;

-- 4. Additive multi-pair summary columns and validation CHECKs on Attendance
ALTER TABLE "Attendance"
    ADD COLUMN IF NOT EXISTS "actualWorkedMinutes" INTEGER,
    ADD COLUMN IF NOT EXISTS "hasIncompletePunch" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "punchPairsCount" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Attendance_actualWorkedMinutes_chk') THEN
        ALTER TABLE "Attendance"
            ADD CONSTRAINT "Attendance_actualWorkedMinutes_chk"
            CHECK ("actualWorkedMinutes" IS NULL OR "actualWorkedMinutes" >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Attendance_punchPairsCount_chk') THEN
        ALTER TABLE "Attendance"
            ADD CONSTRAINT "Attendance_punchPairsCount_chk"
            CHECK ("punchPairsCount" >= 0);
    END IF;
END $$;

-- 5. Chronological punch events per Attendance record
CREATE TABLE IF NOT EXISTS "AttendancePunchEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "attendanceId" UUID NOT NULL,
    "rawPunchLogId" UUID,
    "punchTime" TIMESTAMPTZ(6) NOT NULL,
    "inOutMode" "PunchInOutMode" NOT NULL,
    "source" "AttendanceSource" NOT NULL DEFAULT 'BIOMETRIC',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendancePunchEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AttendancePunchEvent_rawPunchLogId_companyId_key"
    ON "AttendancePunchEvent"("rawPunchLogId", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "AttendancePunchEvent_id_attendanceId_companyId_key"
    ON "AttendancePunchEvent"("id", "attendanceId", "companyId");
CREATE INDEX IF NOT EXISTS "AttendancePunchEvent_companyId_idx"
    ON "AttendancePunchEvent"("companyId");
CREATE INDEX IF NOT EXISTS "AttendancePunchEvent_attendanceId_punchTime_idx"
    ON "AttendancePunchEvent"("attendanceId", "punchTime");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendancePunchEvent_companyId_fkey') THEN
        ALTER TABLE "AttendancePunchEvent"
            ADD CONSTRAINT "AttendancePunchEvent_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendancePunchEvent_attendanceId_companyId_fkey') THEN
        ALTER TABLE "AttendancePunchEvent"
            ADD CONSTRAINT "AttendancePunchEvent_attendanceId_companyId_fkey"
            FOREIGN KEY ("attendanceId", "companyId") REFERENCES "Attendance"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendancePunchEvent_rawPunchLogId_companyId_fkey') THEN
        ALTER TABLE "AttendancePunchEvent"
            ADD CONSTRAINT "AttendancePunchEvent_rawPunchLogId_companyId_fkey"
            FOREIGN KEY ("rawPunchLogId", "companyId") REFERENCES "RawPunchLog"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- 6. Chronologically paired / incomplete work intervals per Attendance record
CREATE TABLE IF NOT EXISTS "AttendanceInterval" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "attendanceId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "inEventId" UUID,
    "outEventId" UUID,
    "checkIn" TIMESTAMPTZ(6),
    "checkOut" TIMESTAMPTZ(6),
    "durationMinutes" INTEGER NOT NULL DEFAULT 0,
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceInterval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AttendanceInterval_attendanceId_sequence_key"
    ON "AttendanceInterval"("attendanceId", "sequence");
CREATE INDEX IF NOT EXISTS "AttendanceInterval_companyId_idx"
    ON "AttendanceInterval"("companyId");
CREATE INDEX IF NOT EXISTS "AttendanceInterval_inEventId_idx"
    ON "AttendanceInterval"("inEventId");
CREATE INDEX IF NOT EXISTS "AttendanceInterval_outEventId_idx"
    ON "AttendanceInterval"("outEventId");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendanceInterval_companyId_fkey') THEN
        ALTER TABLE "AttendanceInterval"
            ADD CONSTRAINT "AttendanceInterval_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendanceInterval_attendanceId_companyId_fkey') THEN
        ALTER TABLE "AttendanceInterval"
            ADD CONSTRAINT "AttendanceInterval_attendanceId_companyId_fkey"
            FOREIGN KEY ("attendanceId", "companyId") REFERENCES "Attendance"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendanceInterval_inEventId_attendanceId_companyId_fkey') THEN
        ALTER TABLE "AttendanceInterval"
            ADD CONSTRAINT "AttendanceInterval_inEventId_attendanceId_companyId_fkey"
            FOREIGN KEY ("inEventId", "attendanceId", "companyId")
            REFERENCES "AttendancePunchEvent"("id", "attendanceId", "companyId")
            ON DELETE NO ACTION ON UPDATE CASCADE
            DEFERRABLE INITIALLY DEFERRED;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendanceInterval_outEventId_attendanceId_companyId_fkey') THEN
        ALTER TABLE "AttendanceInterval"
            ADD CONSTRAINT "AttendanceInterval_outEventId_attendanceId_companyId_fkey"
            FOREIGN KEY ("outEventId", "attendanceId", "companyId")
            REFERENCES "AttendancePunchEvent"("id", "attendanceId", "companyId")
            ON DELETE NO ACTION ON UPDATE CASCADE
            DEFERRABLE INITIALLY DEFERRED;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendanceInterval_sequence_chk') THEN
        ALTER TABLE "AttendanceInterval"
            ADD CONSTRAINT "AttendanceInterval_sequence_chk"
            CHECK ("sequence" >= 1);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendanceInterval_durationMinutes_chk') THEN
        ALTER TABLE "AttendanceInterval"
            ADD CONSTRAINT "AttendanceInterval_durationMinutes_chk"
            CHECK ("durationMinutes" >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendanceInterval_check_order_chk') THEN
        ALTER TABLE "AttendanceInterval"
            ADD CONSTRAINT "AttendanceInterval_check_order_chk"
            CHECK ("checkIn" IS NULL OR "checkOut" IS NULL OR "checkOut" >= "checkIn");
    END IF;
END $$;

RESET lock_timeout;
