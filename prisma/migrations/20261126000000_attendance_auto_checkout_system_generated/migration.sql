-- Additive, non-destructive migration to support automatic 11:55 PM check-outs
-- distinctly marked as SYSTEM_GENERATED without altering existing attendance rows
-- or creating synthetic biometric punch logs.
-- Note: ALTER TYPE ... ADD VALUE is strictly additive and does not lock or rewrite
-- existing table rows in PostgreSQL.

ALTER TYPE "AttendanceSource" ADD VALUE IF NOT EXISTS 'SYSTEM_GENERATED';
