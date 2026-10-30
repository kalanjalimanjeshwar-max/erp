import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Phase 7.1 Attendance, Shift, Leave and Payroll Foundation Tests', () => {
  const schemaPath = path.resolve(import.meta.dirname, '../../prisma/schema.prisma');
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

  it('should define all Phase 7.1 enums with correct values', () => {
    // AttendanceStatus
    expect(schemaContent).toContain('enum AttendanceStatus {');
    expect(schemaContent).toContain('PRESENT');
    expect(schemaContent).toContain('ABSENT');
    expect(schemaContent).toContain('HALF_DAY');
    expect(schemaContent).toContain('LATE');
    expect(schemaContent).toContain('ON_LEAVE');

    // AttendanceSource
    expect(schemaContent).toContain('enum AttendanceSource {');
    expect(schemaContent).toContain('MANUAL');
    expect(schemaContent).toContain('BIOMETRIC');

    // LeaveStatus
    expect(schemaContent).toContain('enum LeaveStatus {');
    expect(schemaContent).toContain('PENDING');
    expect(schemaContent).toContain('APPROVED');
    expect(schemaContent).toContain('REJECTED');
    expect(schemaContent).toContain('CANCELLED');

    // PayrollStatus
    expect(schemaContent).toContain('enum PayrollStatus {');
    expect(schemaContent).toContain('DRAFT');
    expect(schemaContent).toContain('PROCESSED');
    expect(schemaContent).toContain('POSTED');

    // PayslipStatus
    expect(schemaContent).toContain('enum PayslipStatus {');
    expect(schemaContent).toContain('APPROVED');
    expect(schemaContent).toContain('PAID');
  });

  it('should define all Phase 7.1 models in Prisma schema', () => {
    const requiredModels = [
      'model Shift',
      'model Attendance',
      'model LeaveType',
      'model LeaveRequest',
      'model PayrollPeriod',
      'model Payslip',
    ];

    for (const modelDef of requiredModels) {
      expect(schemaContent).toContain(modelDef);
    }
  });

  it('should enforce company scoping and ON DELETE RESTRICT on all Phase 7.1 models', () => {
    const phase7Models = [
      'Shift',
      'Attendance',
      'LeaveType',
      'LeaveRequest',
      'PayrollPeriod',
      'Payslip',
    ];

    for (const model of phase7Models) {
      const match = schemaContent.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\}`, 'm'));
      expect(match).not.toBeNull();
      const body = match![0];

      expect(body).toMatch(/companyId\s+String\s+@db\.Uuid/);
      expect(body).toMatch(/@relation\(fields:\s*\[companyId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/);
    }
  });

  it('should enforce Shift model specifications including overnight shift support and company-scoped code', () => {
    const shiftMatch = schemaContent.match(/model Shift \{[\s\S]*?\}/);
    expect(shiftMatch).not.toBeNull();
    const shiftBody = shiftMatch![0];

    expect(shiftBody).toMatch(/code\s+String\s+@db\.VarChar\(32\)/);
    expect(shiftBody).toMatch(/name\s+String\s+@db\.VarChar\(128\)/);
    expect(shiftBody).toMatch(/startTime\s+String\s+@db\.VarChar\(8\)/);
    expect(shiftBody).toMatch(/endTime\s+String\s+@db\.VarChar\(8\)/);
    expect(shiftBody).toMatch(/isOvernight\s+Boolean\s+@default\(false\)/);
    expect(shiftBody).toMatch(/graceMinutes\s+Int\s+@default\(15\)/);
    expect(shiftBody).toMatch(/halfDayMinutes\s+Int\s+@default\(240\)/);
    expect(shiftBody).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    expect(shiftBody).toMatch(/@@unique\(\[companyId,\s*code\]\)/);
  });

  it('should prevent overlapping duplicate attendance records for the same employee and work date', () => {
    const attendanceMatch = schemaContent.match(/model Attendance \{[\s\S]*?\}/);
    expect(attendanceMatch).not.toBeNull();
    const attendanceBody = attendanceMatch![0];

    // Must have unique constraint across companyId, employeeId, workDate
    expect(attendanceBody).toMatch(/@@unique\(\[companyId,\s*employeeId,\s*workDate\]\)/);
    expect(attendanceBody).toMatch(/workDate\s+DateTime\s+@db\.Date/);
    expect(attendanceBody).toMatch(/status\s+AttendanceStatus\s+@default\(PRESENT\)/);
    expect(attendanceBody).toMatch(/source\s+AttendanceSource\s+@default\(MANUAL\)/);
  });

  it('should enforce LeaveType and LeaveRequest structure and constraints', () => {
    const leaveTypeMatch = schemaContent.match(/model LeaveType \{[\s\S]*?\}/);
    expect(leaveTypeMatch).not.toBeNull();
    const leaveTypeBody = leaveTypeMatch![0];
    expect(leaveTypeBody).toMatch(/@@unique\(\[companyId,\s*code\]\)/);
    expect(leaveTypeBody).toMatch(/isPaid\s+Boolean\s+@default\(true\)/);
    expect(leaveTypeBody).toMatch(/defaultAllowance\s+Int\s+@default\(12\)/);

    const leaveRequestMatch = schemaContent.match(/model LeaveRequest \{[\s\S]*?\}/);
    expect(leaveRequestMatch).not.toBeNull();
    const leaveRequestBody = leaveRequestMatch![0];
    expect(leaveRequestBody).toMatch(/startDate\s+DateTime\s+@db\.Date/);
    expect(leaveRequestBody).toMatch(/endDate\s+DateTime\s+@db\.Date/);
    expect(leaveRequestBody).toMatch(/totalDays\s+Decimal\s+@default\(1\.0\)\s+@db\.Decimal\(5,\s*2\)/);
    expect(leaveRequestBody).toMatch(/reviewedByUserId\s+String\?\s+@db\.Uuid/);
  });

  it('should enforce PayrollPeriod uniqueness per company and calendar month/year', () => {
    const periodMatch = schemaContent.match(/model PayrollPeriod \{[\s\S]*?\}/);
    expect(periodMatch).not.toBeNull();
    const periodBody = periodMatch![0];

    expect(periodBody).toMatch(/month\s+Int/);
    expect(periodBody).toMatch(/year\s+Int/);
    expect(periodBody).toMatch(/@@unique\(\[companyId,\s*year,\s*month\]\)/);
    expect(periodBody).toMatch(/status\s+PayrollStatus\s+@default\(DRAFT\)/);
  });

  it('should enforce Decimal(18, 4) exact precision on Payslip monetary columns without float inaccuracies', () => {
    const payslipMatch = schemaContent.match(/model Payslip \{[\s\S]*?\}/);
    expect(payslipMatch).not.toBeNull();
    const payslipBody = payslipMatch![0];

    expect(payslipBody).toMatch(/basicSalary\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(payslipBody).toMatch(/grossSalary\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(payslipBody).toMatch(/deductions\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(payslipBody).toMatch(/netSalary\s+Decimal\s+@default\(0\.0000\)\s+@db\.Decimal\(18,\s*4\)/);
    expect(payslipBody).toMatch(/@@unique\(\[payrollPeriodId,\s*employeeId\]\)/);
  });

  it('should integrate Payslip with AccountLedger and JournalEntry without breaking accounting engine', () => {
    const payslipMatch = schemaContent.match(/model Payslip \{[\s\S]*?\}/);
    expect(payslipMatch).not.toBeNull();
    const payslipBody = payslipMatch![0];

    // Optional foreign keys to AccountLedger and JournalEntry
    expect(payslipBody).toMatch(/ledgerId\s+String\?\s+@db\.Uuid/);
    expect(payslipBody).toMatch(/@relation\("PayslipLedger",\s*fields:\s*\[ledgerId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/);

    expect(payslipBody).toMatch(/journalEntryId\s+String\?\s+@db\.Uuid/);
    expect(payslipBody).toMatch(/@relation\("PayslipJournalEntry",\s*fields:\s*\[journalEntryId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/);
  });
});
