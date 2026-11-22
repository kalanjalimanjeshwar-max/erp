import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Request, Response } from 'express';
import { ApiError } from '../../src/client/services/api.ts';
import {
  AttendanceIntervalsCell,
  AttendanceWorkedSummaryCell,
  AttendanceFormModal,
  resolveDefaultShiftIdForEmployee,
  isBiometricIntervalLocked,
  getSortedAttendanceIntervals,
  extractLocalTimesForAttendanceForm,
  convertManualTimesToUtcIso,
  buildAttendanceUpdatePayload,
  formatAttendanceSaveError,
} from '../../src/client/pages/AttendancePage.tsx';
import {
  WorkingHoursSummaryContent,
  WorkingHoursSummaryWithIntervals,
} from '../../src/client/components/attendance/WorkingHoursLogoutModal.tsx';
import { AttendanceController } from '../../src/server/controllers/attendance.controller.ts';
import { AttendanceService } from '../../src/server/services/attendance.service.ts';
import { localDateTimeToUtcIso, formatTimeInputInTimezone } from '../../src/shared/timezone.ts';
import { AttendanceItem, AuthUser, EmployeeItem, ShiftItem } from '../../src/shared/types.ts';

describe('Step 3 Scope 3: Attendance UI, WorkingHoursLogoutModal, Controller & Timezone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sampleShifts: ShiftItem[] = [
    {
      id: 'shift-day',
      companyId: 'comp-1',
      code: 'DAY',
      name: 'Day Shift',
      startTime: '09:00',
      endTime: '17:00',
      graceMinutes: 15,
      halfDayMinutes: 240,
      isOvernight: false,
      isActive: true,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'shift-night',
      companyId: 'comp-1',
      code: 'NIGHT',
      name: 'Overnight Shift',
      startTime: '22:00',
      endTime: '06:00',
      graceMinutes: 15,
      halfDayMinutes: 240,
      isOvernight: true,
      isActive: true,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const employeeWithExplicitHoursNoShift: EmployeeItem = {
    id: 'emp-hours-only',
    companyId: 'comp-1',
    employeeCode: 'EMP-101',
    fullName: 'Hours Policy Worker',
    email: 'hours@company.local',
    phone: null,
    address: null,
    photoUrl: null,
    dateOfBirth: '1990-01-01',
    dateOfJoining: '2026-01-01',
    departmentId: null,
    designationId: null,
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    notes: null,
    biometricDeviceId: null,
    userId: null,
    ledgerId: null,
    shiftId: null,
    shiftName: null,
    dailyWorkingHours: 8,
    monthlyLeaveAllowance: 4,
    effectiveWorkPolicy: {
      dailyWorkingHours: 8,
      monthlyLeaveAllowance: 4,
      shiftId: null,
      effectiveFrom: '2026-11-01',
      effectiveTo: null,
      source: 'REVISION',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const employeeWithShift: EmployeeItem = {
    ...employeeWithExplicitHoursNoShift,
    id: 'emp-with-shift',
    employeeCode: 'EMP-102',
    fullName: 'Shift Assigned Worker',
    shiftId: 'shift-night',
    shiftName: 'Overnight Shift',
    dailyWorkingHours: null,
    effectiveWorkPolicy: {
      dailyWorkingHours: null,
      monthlyLeaveAllowance: 5,
      shiftId: 'shift-night',
      effectiveFrom: '2026-11-01',
      effectiveTo: null,
      source: 'REVISION',
    },
  };

  const multiIntervalRecord: AttendanceItem = {
    id: 'att-biometric-1',
    companyId: 'comp-1',
    employeeId: 'emp-hours-only',
    employeeCode: 'EMP-101',
    employeeName: 'Hours Policy Worker',
    shiftId: null,
    shiftName: null,
    workDate: '2026-11-15',
    checkIn: '2026-11-15T03:30:00.000Z',
    checkOut: '2026-11-15T12:30:00.000Z',
    status: 'PRESENT',
    lateMinutes: 0,
    overtimeMinutes: 0,
    actualWorkedMinutes: 450,
    hasIncompletePunch: false,
    punchPairsCount: 2,
    requiredMinutes: 480,
    shortTimeMinutes: 30,
    extraTimeMinutes: 0,
    intervals: [
      {
        id: 'iv-2',
        attendanceId: 'att-biometric-1',
        sequence: 2,
        inEventId: 'ev-3',
        outEventId: 'ev-4',
        checkIn: '2026-11-15T08:00:00.000Z', // 13:30 IST
        checkOut: '2026-11-15T12:30:00.000Z', // 18:00 IST
        durationMinutes: 270,
        isComplete: true,
      },
      {
        id: 'iv-1',
        attendanceId: 'att-biometric-1',
        sequence: 1,
        inEventId: 'ev-1',
        outEventId: 'ev-2',
        checkIn: '2026-11-15T03:30:00.000Z', // 09:00 IST
        checkOut: '2026-11-15T06:30:00.000Z', // 12:00 IST
        durationMinutes: 180,
        isComplete: true,
      },
    ],
    punchEvents: [
      {
        id: 'ev-1',
        attendanceId: 'att-biometric-1',
        rawPunchLogId: 'raw-1',
        punchTime: '2026-11-15T03:30:00.000Z',
        inOutMode: 'CHECK_IN',
        source: 'BIOMETRIC',
      },
    ],
    source: 'BIOMETRIC',
    notes: 'Synced from main gate',
    createdAt: '2026-11-15T03:30:00.000Z',
    updatedAt: '2026-11-15T12:30:00.000Z',
  };

  const legacyManualRecord: AttendanceItem = {
    id: 'att-manual-1',
    companyId: 'comp-1',
    employeeId: 'emp-with-shift',
    employeeCode: 'EMP-102',
    employeeName: 'Shift Assigned Worker',
    shiftId: 'shift-day',
    shiftName: 'Day Shift',
    workDate: '2026-11-15',
    checkIn: '2026-11-15T03:30:00.000Z', // 09:00 IST
    checkOut: '2026-11-15T12:00:00.000Z', // 17:30 IST
    status: 'PRESENT',
    lateMinutes: 0,
    overtimeMinutes: 0,
    actualWorkedMinutes: 510,
    hasIncompletePunch: false,
    punchPairsCount: 1,
    requiredMinutes: 480,
    shortTimeMinutes: 0,
    extraTimeMinutes: 30,
    source: 'MANUAL',
    notes: 'Legacy manual entry',
    createdAt: '2026-11-15T03:30:00.000Z',
    updatedAt: '2026-11-15T12:00:00.000Z',
  };

  it('1. Displays multiple chronological IN/OUT intervals with punchPairsCount and falls back to legacy checkIn/checkOut', () => {
    const sorted = getSortedAttendanceIntervals(multiIntervalRecord);
    expect(sorted.map((iv) => iv.sequence)).toEqual([1, 2]);

    const multiHtml = renderToStaticMarkup(
      React.createElement(AttendanceIntervalsCell, {
        record: multiIntervalRecord,
        timezone: 'Asia/Kolkata',
      })
    );
    expect(multiHtml).toContain('2 punch pairs');
    expect(multiHtml).toContain('#1');
    expect(multiHtml).toContain('#2');
    expect(multiHtml).toContain('180m (3h 0m)');
    expect(multiHtml).toContain('270m (4h 30m)');
    // Chronological order: #1 appears before #2
    expect(multiHtml.indexOf('#1')).toBeLessThan(multiHtml.indexOf('#2'));

    const legacyHtml = renderToStaticMarkup(
      React.createElement(AttendanceIntervalsCell, {
        record: legacyManualRecord,
        timezone: 'Asia/Kolkata',
      })
    );
    expect(legacyHtml).toContain('IN:');
    expect(legacyHtml).toContain('OUT:');
    expect(legacyHtml).toContain('09:00 AM');
    expect(legacyHtml).toContain('05:30 PM');
    expect(legacyHtml).toContain('1 punch pair');
  });

  it('2. Displays actualWorkedMinutes and requiredMinutes clearly, including unconfigured schedule fallback', () => {
    const html = renderToStaticMarkup(
      React.createElement(AttendanceWorkedSummaryCell, { record: multiIntervalRecord })
    );
    expect(html).toContain('Worked:');
    expect(html).toContain('450m (7h 30m)');
    expect(html).toContain('Required:');
    expect(html).toContain('480m (8h 0m)');

    const unconfiguredHtml = renderToStaticMarkup(
      React.createElement(AttendanceWorkedSummaryCell, {
        record: {
          ...legacyManualRecord,
          requiredMinutes: null,
          shortTimeMinutes: undefined,
          extraTimeMinutes: undefined,
        },
      })
    );
    expect(unconfiguredHtml).toContain('Unconfigured');
  });

  it('3. Displays shortTimeMinutes and extraTimeMinutes separately and labels Extra Time as informational only (never netted)', () => {
    const mixedSyntheticRecord: AttendanceItem = {
      ...multiIntervalRecord,
      shortTimeMinutes: 45,
      extraTimeMinutes: 30,
    };
    const html = renderToStaticMarkup(
      React.createElement(AttendanceWorkedSummaryCell, { record: mixedSyntheticRecord })
    );
    expect(html).toContain('Short Time:');
    expect(html).toContain('45m');
    expect(html).toContain('Extra Time:');
    expect(html).toContain('+30m');
    expect(html).toContain('Informational only (does not offset Short Time)');
    // Must not net 45 - 30 = 15m
    expect(html).not.toContain('15m');
  });

  it('4. Displays incomplete-punch warning clearly when hasIncompletePunch is true', () => {
    const incompleteRecord: AttendanceItem = {
      ...multiIntervalRecord,
      hasIncompletePunch: true,
      punchPairsCount: 1,
      intervals: [
        multiIntervalRecord.intervals![1],
        {
          id: 'iv-open',
          attendanceId: 'att-biometric-1',
          sequence: 2,
          inEventId: 'ev-3',
          outEventId: null,
          checkIn: '2026-11-15T08:00:00.000Z',
          checkOut: null,
          durationMinutes: 0,
          isComplete: false,
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(AttendanceIntervalsCell, {
        record: incompleteRecord,
        timezone: 'Asia/Kolkata',
      })
    );
    expect(html).toContain('Incomplete punch');
    expect(html).toContain('Missing OUT');
  });

  it('5. Defaults manual attendance shiftId to employee configured shift or no shift when employee uses explicit dailyWorkingHours', () => {
    expect(resolveDefaultShiftIdForEmployee(employeeWithShift)).toBe('shift-night');
    expect(resolveDefaultShiftIdForEmployee(employeeWithExplicitHoursNoShift)).toBe('');
    expect(resolveDefaultShiftIdForEmployee(null)).toBe('');

    const employeeWithDirectShiftFallback: EmployeeItem = {
      ...employeeWithExplicitHoursNoShift,
      shiftId: 'shift-day',
      effectiveWorkPolicy: undefined,
    };
    expect(resolveDefaultShiftIdForEmployee(employeeWithDirectShiftFallback)).toBe('shift-day');
  });

  it('6. Locks checkIn/checkOut and ABSENT/ON_LEAVE in edit modal for biometric interval records while permitting notes/shiftId/PRESENT-LATE-HALF_DAY edits', () => {
    expect(isBiometricIntervalLocked(multiIntervalRecord)).toBe(true);

    const modalHtml = renderToStaticMarkup(
      React.createElement(AttendanceFormModal, {
        isOpen: true,
        editingAttendance: multiIntervalRecord,
        employees: [employeeWithExplicitHoursNoShift, employeeWithShift],
        shifts: sampleShifts,
        timezone: 'Asia/Kolkata',
        formEmployeeId: multiIntervalRecord.employeeId,
        formWorkDate: multiIntervalRecord.workDate,
        formShiftId: '',
        formCheckIn: '09:00',
        formCheckOut: '18:00',
        formStatus: 'LATE',
        formNotes: 'Updated note',
        attendanceFormError: null,
        isSubmittingAttendance: false,
        onClose: () => {},
        onEmployeeChange: () => {},
        onWorkDateChange: () => {},
        onShiftChange: () => {},
        onCheckInChange: () => {},
        onCheckOutChange: () => {},
        onStatusChange: () => {},
        onNotesChange: () => {},
        onSubmit: () => {},
      })
    );

    expect(modalHtml).toContain('Biometric Punch Intervals Locked (Read-Only)');
    expect(modalHtml).toContain('Recorded Chronological Intervals');
    expect(modalHtml).toMatch(/<input type="time"[^>]*disabled=""[^>]*value="09:00"/);
    expect(modalHtml).toMatch(/<input type="time"[^>]*disabled=""[^>]*value="18:00"/);
    expect(modalHtml).toContain('<option value="ABSENT" disabled="">');
    expect(modalHtml).toContain('<option value="ON_LEAVE" disabled="">');
    expect(modalHtml).toContain('<option value="PRESENT">');
    expect(modalHtml).toContain('<option value="LATE" selected="">');

    const payload = buildAttendanceUpdatePayload({
      editingRecord: multiIntervalRecord,
      formShiftId: 'shift-day',
      formStatus: 'HALF_DAY',
      formNotes: 'Reviewed multi-pair punches',
      formWorkDate: '2026-11-15',
      formCheckIn: '09:00',
      formCheckOut: '18:00',
      timezone: 'Asia/Kolkata',
    });

    expect(payload).toEqual({
      shiftId: 'shift-day',
      status: 'HALF_DAY',
      notes: 'Reviewed multi-pair punches',
    });
    expect('checkIn' in payload).toBe(false);
    expect('checkOut' in payload).toBe(false);
  });

  it('7. Preserves normal manual attendance editing when no biometric intervals or punch events exist', () => {
    expect(isBiometricIntervalLocked(legacyManualRecord)).toBe(false);

    const modalHtml = renderToStaticMarkup(
      React.createElement(AttendanceFormModal, {
        isOpen: true,
        editingAttendance: legacyManualRecord,
        employees: [employeeWithExplicitHoursNoShift, employeeWithShift],
        shifts: sampleShifts,
        timezone: 'Asia/Kolkata',
        formEmployeeId: legacyManualRecord.employeeId,
        formWorkDate: legacyManualRecord.workDate,
        formShiftId: 'shift-day',
        formCheckIn: '09:00',
        formCheckOut: '17:30',
        formStatus: 'PRESENT',
        formNotes: 'Manual update',
        attendanceFormError: null,
        isSubmittingAttendance: false,
        onClose: () => {},
        onEmployeeChange: () => {},
        onWorkDateChange: () => {},
        onShiftChange: () => {},
        onCheckInChange: () => {},
        onCheckOutChange: () => {},
        onStatusChange: () => {},
        onNotesChange: () => {},
        onSubmit: () => {},
      })
    );

    expect(modalHtml).not.toContain('Biometric Punch Intervals Locked');
    expect(modalHtml).toMatch(/<input type="time"[^>]*value="09:00"/);
    expect(modalHtml).not.toMatch(/<input type="time"[^>]*disabled=""[^>]*value="09:00"/);
    expect(modalHtml).toContain('<option value="ABSENT">');
    expect(modalHtml).toContain('<option value="ON_LEAVE">');

    const payload = buildAttendanceUpdatePayload({
      editingRecord: legacyManualRecord,
      formShiftId: 'shift-day',
      formStatus: 'PRESENT',
      formNotes: 'Manual correction',
      formWorkDate: '2026-11-15',
      formCheckIn: '09:15',
      formCheckOut: '17:45',
      timezone: 'Asia/Kolkata',
    });

    expect(payload).toEqual({
      checkIn: '2026-11-15T03:45:00.000Z',
      checkOut: '2026-11-15T12:15:00.000Z',
      shiftId: 'shift-day',
      status: 'PRESENT',
      notes: 'Manual correction',
    });
  });

  it('8. Propagates actual server 409 error message instead of overwriting with duplicate attendance text', () => {
    const biometricLockErr = new ApiError(
      'Cannot manually modify timestamps or change status to ABSENT/ON_LEAVE when biometric punch events or work intervals exist for this attendance record.',
      409,
      'ATTENDANCE_CONFLICT'
    );
    expect(formatAttendanceSaveError(biometricLockErr)).toBe(
      'Cannot manually modify timestamps or change status to ABSENT/ON_LEAVE when biometric punch events or work intervals exist for this attendance record.'
    );

    const payrollLockErr = new ApiError(
      "Cannot modify attendance for 2026-11-15: payroll period 'Nov 2026' is already in 'POSTED' status.",
      409,
      'ATTENDANCE_CONFLICT'
    );
    expect(formatAttendanceSaveError(payrollLockErr)).toBe(
      "Cannot modify attendance for 2026-11-15: payroll period 'Nov 2026' is already in 'POSTED' status."
    );
  });

  it('9. Maps HTTP 409 from AttendanceController.update to ATTENDANCE_CONFLICT while preserving 403 FORBIDDEN and 404 ATTENDANCE_NOT_FOUND', async () => {
    const actor: AuthUser = {
      id: 'user-1',
      userId: 'user-1',
      companyId: 'comp-1',
      email: 'admin@company.local',
      fullName: 'Admin',
      role: 'ADMIN',
      isActive: true,
      tokenVersion: 1,
    };

    const createMockRes = () => {
      const res: { statusCode: number; body: unknown } = { statusCode: 200, body: null };
      const mockRes = {
        status(code: number) {
          res.statusCode = code;
          return this;
        },
        json(payload: unknown) {
          res.body = payload;
          return this;
        },
      } as unknown as Response;
      return { res, mockRes };
    };

    // 409 -> ATTENDANCE_CONFLICT
    const conflictErr = Object.assign(
      new Error('Cannot manually modify timestamps when biometric intervals exist.'),
      { statusCode: 409 }
    );
    vi.spyOn(AttendanceService, 'updateAttendance').mockRejectedValueOnce(conflictErr);
    const r409 = createMockRes();
    await AttendanceController.update(
      { user: actor, params: { id: 'att-1' }, body: { checkIn: '2026-11-15T03:30:00.000Z' } } as unknown as Request,
      r409.mockRes
    );
    expect(r409.res.statusCode).toBe(409);
    expect(r409.res.body).toEqual({
      error: {
        code: 'ATTENDANCE_CONFLICT',
        message: 'Cannot manually modify timestamps when biometric intervals exist.',
      },
    });

    // 404 -> ATTENDANCE_NOT_FOUND
    const notFoundErr = Object.assign(new Error('Attendance record not found in this company.'), {
      statusCode: 404,
    });
    vi.spyOn(AttendanceService, 'updateAttendance').mockRejectedValueOnce(notFoundErr);
    const r404 = createMockRes();
    await AttendanceController.update(
      { user: actor, params: { id: 'att-missing' }, body: { notes: 'x' } } as unknown as Request,
      r404.mockRes
    );
    expect(r404.res.statusCode).toBe(404);
    expect(r404.res.body).toEqual({
      error: {
        code: 'ATTENDANCE_NOT_FOUND',
        message: 'Attendance record not found in this company.',
      },
    });

    // 403 -> FORBIDDEN (getById & update)
    const forbiddenErr = Object.assign(
      new Error('Employees are only permitted to view their own attendance records.'),
      { statusCode: 403 }
    );
    vi.spyOn(AttendanceService, 'getAttendanceById').mockRejectedValueOnce(forbiddenErr);
    const r403 = createMockRes();
    await AttendanceController.getById(
      { user: actor, params: { id: 'att-other' } } as unknown as Request,
      r403.mockRes
    );
    expect(r403.res.statusCode).toBe(403);
    expect(r403.res.body).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Employees are only permitted to view their own attendance records.',
      },
    });
  });

  it('10. Converts Check-In/Check-Out accurately across non-UTC date boundaries on both load and save', () => {
    // Forward-offset timezone crossing UTC date backward: 2026-11-15 00:30 IST -> 2026-11-14T19:00:00.000Z
    const istUtcIso = localDateTimeToUtcIso('2026-11-15', '00:30', 'Asia/Kolkata');
    expect(istUtcIso).toBe('2026-11-14T19:00:00.000Z');
    expect(formatTimeInputInTimezone(istUtcIso, 'Asia/Kolkata')).toBe('00:30');

    // Negative-offset timezone crossing UTC date forward: 2026-11-15 21:30 EST -> 2026-11-16T02:30:00.000Z
    const nyUtcIso = localDateTimeToUtcIso('2026-11-15', '21:30', 'America/New_York');
    expect(nyUtcIso).toBe('2026-11-16T02:30:00.000Z');
    expect(formatTimeInputInTimezone(nyUtcIso, 'America/New_York')).toBe('21:30');

    // Round-trip loading & saving inside AttendancePage helpers
    const crossBoundaryRecord: AttendanceItem = {
      ...legacyManualRecord,
      workDate: '2026-11-15',
      checkIn: '2026-11-14T19:00:00.000Z', // 00:30 IST on 2026-11-15
      checkOut: '2026-11-15T04:00:00.000Z', // 09:30 IST on 2026-11-15
    };
    const loaded = extractLocalTimesForAttendanceForm(crossBoundaryRecord, 'Asia/Kolkata');
    expect(loaded).toEqual({
      workDate: '2026-11-15',
      checkIn: '00:30',
      checkOut: '09:30',
    });

    const saved = convertManualTimesToUtcIso({
      workDate: loaded.workDate,
      checkIn: loaded.checkIn,
      checkOut: loaded.checkOut,
      timezone: 'Asia/Kolkata',
    });
    expect(saved).toEqual({
      checkIn: '2026-11-14T19:00:00.000Z',
      checkOut: '2026-11-15T04:00:00.000Z',
    });

    // Overnight shift crosses local calendar day for checkOut
    const overnightSaved = convertManualTimesToUtcIso({
      workDate: '2026-11-15',
      checkIn: '22:00',
      checkOut: '06:00',
      timezone: 'Asia/Kolkata',
      isOvernightShift: true,
    });
    expect(overnightSaved).toEqual({
      checkIn: '2026-11-15T16:30:00.000Z',
      checkOut: '2026-11-16T00:30:00.000Z',
    });
  });

  it('11. WorkingHoursLogoutModal displays punchPairsCount, intervals, actualWorkedMinutes, separate Short/Extra Time, and incomplete-punch warning', () => {
    const summaryWithMultiIntervals: WorkingHoursSummaryWithIntervals = {
      workDate: '2026-11-15',
      timezone: 'Asia/Kolkata',
      employeeId: 'emp-1',
      employeeName: 'Alice Worker',
      employeeCode: 'EMP-001',
      shiftId: null,
      shiftName: null,
      shiftSchedule: 'Custom Schedule (8h/day)',
      expectedDurationHours: 8,
      checkIn: '2026-11-15T03:30:00.000Z',
      checkOut: '2026-11-15T11:30:00.000Z',
      workedDurationHours: 7.5,
      actualWorkedMinutes: 450,
      punchPairsCount: 2,
      hasIncompletePunch: true,
      shortDurationMinutes: 30,
      overtimeDurationMinutes: 15,
      status: 'INCOMPLETE_ATTENDANCE',
      statusMessage: 'Attendance Incomplete: You have an unclosed punch sequence for today.',
      requiresAttendanceAction: true,
      intervals: [
        {
          id: 'iv-1',
          attendanceId: 'att-1',
          sequence: 1,
          inEventId: 'e1',
          outEventId: 'e2',
          checkIn: '2026-11-15T03:30:00.000Z',
          checkOut: '2026-11-15T06:30:00.000Z',
          durationMinutes: 180,
          isComplete: true,
        },
        {
          id: 'iv-2',
          attendanceId: 'att-1',
          sequence: 2,
          inEventId: 'e3',
          outEventId: null,
          checkIn: '2026-11-15T07:00:00.000Z',
          checkOut: null,
          durationMinutes: 0,
          isComplete: false,
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(WorkingHoursSummaryContent, { summary: summaryWithMultiIntervals })
    );
    expect(html).toContain('Punch Pairs: 2');
    expect(html).toContain('Incomplete Punch Warning');
    expect(html).toContain('7.5h');
    expect(html).toContain('450 mins (7h 30m)');
    expect(html).toContain('Recorded IN/OUT Intervals');
    expect(html).toContain('180m');
    expect(html).toContain('Short Time');
    expect(html).toContain('30 mins');
    expect(html).toContain('Extra Time');
    expect(html).toContain('+15 mins');
    expect(html).toContain('Informational only — does not offset Short Time');
  });
});
