import React, { useState, useEffect, useCallback } from 'react';
import {
  CalendarCheck,
  Clock,
  Plus,
  Filter,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  X,
  Edit2,
  PowerOff,
  Lock,
  AlertTriangle,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { LoadingSpinner } from '../components/common/LoadingSpinner.tsx';
import { EmptyState } from '../components/common/EmptyState.tsx';
import { ConfirmDialog, executeConfirmedAction } from '../components/common/ConfirmDialog.tsx';
import {
  AuthUser,
  AttendanceItem,
  AttendanceIntervalItem,
  AttendanceStatus,
  ShiftItem,
  EmployeeItem,
  CreateAttendanceRequest,
  UpdateAttendanceRequest,
  CreateShiftRequest,
  UpdateShiftRequest,
  CompanyProfile,
} from '../../shared/types.ts';
import {
  formatTimeInTimezone,
  formatTimeInputInTimezone,
  formatDateInTimezone,
  formatUtcTimestamp,
  getEffectiveTimeZone,
  getTimezoneShortName,
  localDateTimeToUtcIso,
  addCalendarDaysToDateStr,
} from '../../shared/timezone.ts';

interface AttendancePageProps {
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
}

export function formatMinutesDuration(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || Number.isNaN(minutes)) return '—';
  const absMins = Math.max(0, Math.round(minutes));
  const h = Math.floor(absMins / 60);
  const m = absMins % 60;
  if (h > 0) {
    return `${absMins}m (${h}h ${m}m)`;
  }
  return `${absMins}m`;
}

export function resolveDefaultShiftIdForEmployee(
  employee: EmployeeItem | null | undefined
): string {
  if (!employee) return '';
  const configuredShiftId =
    employee.effectiveWorkPolicy?.shiftId ?? employee.shiftId ?? null;
  return configuredShiftId || '';
}

export function isBiometricIntervalLocked(
  record: AttendanceItem | null | undefined
): boolean {
  if (!record) return false;
  const hasIntervals = Array.isArray(record.intervals) && record.intervals.length > 0;
  const hasPunchEvents = Array.isArray(record.punchEvents) && record.punchEvents.length > 0;
  const hasMultiPairs =
    typeof record.punchPairsCount === 'number' && record.punchPairsCount > 1;
  return hasIntervals || hasPunchEvents || hasMultiPairs;
}

export function getSortedAttendanceIntervals(
  record: AttendanceItem
): AttendanceIntervalItem[] {
  if (!Array.isArray(record.intervals) || record.intervals.length === 0) {
    return [];
  }
  return [...record.intervals].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    const aTime = a.checkIn ? new Date(a.checkIn).getTime() : 0;
    const bTime = b.checkIn ? new Date(b.checkIn).getTime() : 0;
    return aTime - bTime;
  });
}

export function extractLocalTimesForAttendanceForm(
  record: AttendanceItem,
  timezone?: string | null
): { workDate: string; checkIn: string; checkOut: string } {
  return {
    workDate: record.workDate.split('T')[0],
    checkIn: formatTimeInputInTimezone(record.checkIn, timezone),
    checkOut: formatTimeInputInTimezone(record.checkOut, timezone),
  };
}

export function convertManualTimesToUtcIso(params: {
  workDate: string;
  checkIn: string;
  checkOut: string;
  timezone?: string | null;
  isOvernightShift?: boolean;
}): { checkIn: string | null; checkOut: string | null } {
  const { workDate, checkIn, checkOut, timezone, isOvernightShift } = params;
  const checkInIso = checkIn ? localDateTimeToUtcIso(workDate, checkIn, timezone) : null;

  let checkOutDateStr = workDate;
  if (isOvernightShift && checkIn && checkOut && checkOut < checkIn) {
    checkOutDateStr = addCalendarDaysToDateStr(workDate, 1);
  }
  const checkOutIso = checkOut ? localDateTimeToUtcIso(checkOutDateStr, checkOut, timezone) : null;

  return {
    checkIn: checkInIso,
    checkOut: checkOutIso,
  };
}

export function buildAttendanceUpdatePayload(params: {
  editingRecord: AttendanceItem;
  formShiftId: string;
  formStatus: AttendanceStatus;
  formNotes: string;
  formWorkDate: string;
  formCheckIn: string;
  formCheckOut: string;
  timezone?: string | null;
  isOvernightShift?: boolean;
}): UpdateAttendanceRequest {
  const {
    editingRecord,
    formShiftId,
    formStatus,
    formNotes,
    formWorkDate,
    formCheckIn,
    formCheckOut,
    timezone,
    isOvernightShift,
  } = params;

  if (isBiometricIntervalLocked(editingRecord)) {
    return {
      shiftId: formShiftId || null,
      status: formStatus,
      notes: formNotes || null,
    };
  }

  const { checkIn, checkOut } = convertManualTimesToUtcIso({
    workDate: formWorkDate,
    checkIn: formCheckIn,
    checkOut: formCheckOut,
    timezone,
    isOvernightShift,
  });

  return {
    checkIn,
    checkOut,
    shiftId: formShiftId || null,
    status: formStatus,
    notes: formNotes || null,
  };
}

export function formatAttendanceSaveError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message || 'Failed to save attendance record.';
  }
  if (err instanceof Error) {
    return err.message || 'Failed to save attendance record.';
  }
  return 'Failed to save attendance record.';
}

export const AttendanceIntervalsCell: React.FC<{
  record: AttendanceItem;
  timezone: string;
}> = ({ record, timezone }) => {
  const effectiveTz = getEffectiveTimeZone(timezone);
  const sortedIntervals = getSortedAttendanceIntervals(record);
  const formatTime = (iso: string | null) =>
    formatTimeInTimezone(iso, effectiveTz, { hour12: true, includeZoneAbbr: true });

  return (
    <div className="space-y-1.5 min-w-[210px]">
      {sortedIntervals.length > 0 ? (
        <div className="space-y-1">
          {typeof record.punchPairsCount === 'number' && (
            <div className="text-[11px] font-mono text-indigo-300 font-medium">
              {record.punchPairsCount} punch pair{record.punchPairsCount === 1 ? '' : 's'}
            </div>
          )}
          {sortedIntervals.map((iv) => (
            <div
              key={iv.id}
              className="text-[11px] font-mono tabular-nums bg-slate-950/70 border border-slate-800/80 rounded px-2 py-1 flex items-center justify-between gap-2"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500">#{iv.sequence}</span>
                <span title={iv.checkIn ? `UTC: ${formatUtcTimestamp(iv.checkIn)}` : undefined}>
                  IN {formatTime(iv.checkIn)}
                </span>
                <span className="text-slate-600">→</span>
                <span
                  className={iv.checkOut ? 'text-slate-200' : 'text-amber-400 font-semibold'}
                  title={iv.checkOut ? `UTC: ${formatUtcTimestamp(iv.checkOut)}` : undefined}
                >
                  OUT {iv.checkOut ? formatTime(iv.checkOut) : 'Missing OUT'}
                </span>
              </div>
              <span className="text-slate-400 shrink-0">
                {iv.isComplete ? formatMinutesDuration(iv.durationMinutes) : 'Incomplete'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-0.5 text-xs font-mono tabular-nums">
          <div title={record.checkIn ? `UTC: ${formatUtcTimestamp(record.checkIn)}` : undefined}>
            <span className="text-slate-500 mr-1">IN:</span>
            <span className="text-slate-200">{formatTime(record.checkIn)}</span>
          </div>
          <div title={record.checkOut ? `UTC: ${formatUtcTimestamp(record.checkOut)}` : undefined}>
            <span className="text-slate-500 mr-1">OUT:</span>
            <span className="text-slate-200">{formatTime(record.checkOut)}</span>
          </div>
          {typeof record.punchPairsCount === 'number' && record.punchPairsCount > 0 && (
            <div className="text-[11px] text-slate-400">
              {record.punchPairsCount} punch pair{record.punchPairsCount === 1 ? '' : 's'}
            </div>
          )}
        </div>
      )}

      {record.hasIncompletePunch === true && (
        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[11px] font-medium">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span>Incomplete punch</span>
        </div>
      )}
    </div>
  );
};

export const AttendanceWorkedSummaryCell: React.FC<{
  record: AttendanceItem;
}> = ({ record }) => {
  const actualWorked = record.actualWorkedMinutes;
  const required = record.requiredMinutes;
  const shortTime =
    typeof (record.shortTimeMinutes as number | null | undefined) === 'number'
      ? (record.shortTimeMinutes as number)
      : null;
  const extraTime =
    typeof (record.extraTimeMinutes as number | null | undefined) === 'number'
      ? (record.extraTimeMinutes as number)
      : null;

  return (
    <div className="space-y-1 text-[11px] font-mono tabular-nums min-w-[190px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-400">Worked:</span>
        <span className="text-slate-100 font-semibold">
          {actualWorked !== null && actualWorked !== undefined
            ? formatMinutesDuration(actualWorked)
            : '—'}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-400">Required:</span>
        <span className="text-slate-300">
          {required !== null && required !== undefined
            ? formatMinutesDuration(required)
            : 'Unconfigured'}
        </span>
      </div>
      {shortTime !== null && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-400">Short Time:</span>
          <span className={shortTime > 0 ? 'text-amber-400 font-semibold' : 'text-slate-500'}>
            {shortTime}m
          </span>
        </div>
      )}
      {extraTime !== null && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Extra Time:</span>
            <span className={extraTime > 0 ? 'text-indigo-300 font-semibold' : 'text-slate-500'}>
              {extraTime > 0 ? `+${extraTime}m` : '0m'}
            </span>
          </div>
          <div className="text-[10px] font-sans text-slate-500">
            Informational only (does not offset Short Time)
          </div>
        </div>
      )}
      {record.lateMinutes > 0 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-400">Late:</span>
          <span className="text-amber-400">{record.lateMinutes}m</span>
        </div>
      )}
    </div>
  );
};

export interface AttendanceFormModalProps {
  isOpen: boolean;
  editingAttendance: AttendanceItem | null;
  employees: EmployeeItem[];
  shifts: ShiftItem[];
  timezone: string;
  formEmployeeId: string;
  formWorkDate: string;
  formShiftId: string;
  formCheckIn: string;
  formCheckOut: string;
  formStatus: AttendanceStatus;
  formNotes: string;
  attendanceFormError: string | null;
  isSubmittingAttendance: boolean;
  onClose: () => void;
  onEmployeeChange: (employeeId: string) => void;
  onWorkDateChange: (workDate: string) => void;
  onShiftChange: (shiftId: string) => void;
  onCheckInChange: (checkIn: string) => void;
  onCheckOutChange: (checkOut: string) => void;
  onStatusChange: (status: AttendanceStatus) => void;
  onNotesChange: (notes: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export const AttendanceFormModal: React.FC<AttendanceFormModalProps> = ({
  isOpen,
  editingAttendance,
  employees,
  shifts,
  timezone,
  formEmployeeId,
  formWorkDate,
  formShiftId,
  formCheckIn,
  formCheckOut,
  formStatus,
  formNotes,
  attendanceFormError,
  isSubmittingAttendance,
  onClose,
  onEmployeeChange,
  onWorkDateChange,
  onShiftChange,
  onCheckInChange,
  onCheckOutChange,
  onStatusChange,
  onNotesChange,
  onSubmit,
}) => {
  if (!isOpen) return null;

  const effectiveTz = getEffectiveTimeZone(timezone);
  const tzAbbr = getTimezoneShortName(effectiveTz);
  const biometricLocked = isBiometricIntervalLocked(editingAttendance);
  const sortedIntervals = editingAttendance ? getSortedAttendanceIntervals(editingAttendance) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <CalendarCheck className="w-4 h-4 text-indigo-400" />
              <span>{editingAttendance ? 'Edit Attendance Record' : 'Record Manual Attendance'}</span>
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Times interpreted in company timezone: <span className="font-mono text-slate-300">{effectiveTz} ({tzAbbr})</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {attendanceFormError && (
          <div className="bg-rose-950/40 border border-rose-900 rounded-lg p-3 text-xs text-rose-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{attendanceFormError}</span>
          </div>
        )}

        {biometricLocked && editingAttendance && (
          <div className="bg-amber-950/30 border border-amber-800/60 rounded-lg p-3 space-y-2.5 text-xs">
            <div className="flex items-start gap-2 text-amber-200">
              <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">Biometric Punch Intervals Locked (Read-Only)</div>
                <p className="text-[11px] text-amber-200/90 mt-0.5">
                  Check-In/Check-Out timestamps and ABSENT/ON_LEAVE statuses are disabled because biometric punch events or work intervals exist for this record. You may still update Shift, permitted statuses (PRESENT, LATE, HALF_DAY), and Notes.
                </p>
              </div>
            </div>

            {sortedIntervals.length > 0 && (
              <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-2.5 space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-slate-400 font-medium">
                  <span>Recorded Chronological Intervals</span>
                  {typeof editingAttendance.punchPairsCount === 'number' && (
                    <span className="font-mono text-indigo-300">
                      {editingAttendance.punchPairsCount} pair{editingAttendance.punchPairsCount === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                {sortedIntervals.map((iv) => (
                  <div
                    key={iv.id}
                    className="flex items-center justify-between text-[11px] font-mono text-slate-300 border-t border-slate-800/60 pt-1"
                  >
                    <span>
                      #{iv.sequence}:{' '}
                      {formatTimeInTimezone(iv.checkIn, effectiveTz, {
                        hour12: true,
                        includeZoneAbbr: true,
                      })}{' '}
                      →{' '}
                      {iv.checkOut
                        ? formatTimeInTimezone(iv.checkOut, effectiveTz, {
                            hour12: true,
                            includeZoneAbbr: true,
                          })
                        : 'Missing OUT'}
                    </span>
                    <span className="text-slate-400">
                      {iv.isComplete ? formatMinutesDuration(iv.durationMinutes) : 'Incomplete'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          {!editingAttendance && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Employee *</label>
              <select
                value={formEmployeeId}
                onChange={(e) => onEmployeeChange(e.target.value)}
                required
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="" disabled>
                  Select Employee
                </option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.employeeCode} — {emp.fullName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Work Date *</label>
              <input
                type="date"
                value={formWorkDate}
                onChange={(e) => onWorkDateChange(e.target.value)}
                disabled={!!editingAttendance}
                required
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Assigned Shift</label>
              <select
                value={formShiftId}
                onChange={(e) => onShiftChange(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="">No Shift / Default</option>
                {shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} ({s.startTime} - {s.endTime})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Check-In Time ({tzAbbr})
              </label>
              <input
                type="time"
                value={formCheckIn}
                onChange={(e) => onCheckInChange(e.target.value)}
                disabled={biometricLocked}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Check-Out Time ({tzAbbr})
              </label>
              <input
                type="time"
                value={formCheckOut}
                onChange={(e) => onCheckOutChange(e.target.value)}
                disabled={biometricLocked}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Attendance Status *</label>
            <select
              value={formStatus}
              onChange={(e) => onStatusChange(e.target.value as AttendanceStatus)}
              required
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="PRESENT">PRESENT (Full Day)</option>
              <option value="LATE">LATE (Grace Period Exceeded)</option>
              <option value="HALF_DAY">HALF_DAY (0.5 Day Attendance)</option>
              <option value="ABSENT" disabled={biometricLocked}>
                ABSENT (Unpaid Absence){biometricLocked ? ' — Disabled for biometric records' : ''}
              </option>
              <option value="ON_LEAVE" disabled={biometricLocked}>
                ON_LEAVE (Approved Leave){biometricLocked ? ' — Disabled for biometric records' : ''}
              </option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Notes / Justification</label>
            <textarea
              value={formNotes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="Optional manual attendance remarks..."
              rows={2}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmittingAttendance}
              className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition disabled:opacity-50"
            >
              {isSubmittingAttendance ? 'Saving...' : editingAttendance ? 'Save Changes' : 'Record Attendance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export const AttendancePage: React.FC<AttendancePageProps> = ({ currentUser, companyProfile }) => {
  const timezone = getEffectiveTimeZone(companyProfile?.timezone);
  const isEmployee = currentUser.role === 'EMPLOYEE';
  const [activeTab, setActiveTab] = useState<'attendance' | 'shifts'>('attendance');

  // Attendance State
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceItem[]>([]);
  const [attendanceTotal, setAttendanceTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [limit] = useState<number>(20);
  const [isLoadingAttendance, setIsLoadingAttendance] = useState<boolean>(true);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);

  // Filters
  const [filterEmployeeId, setFilterEmployeeId] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');

  // Shifts State
  const [shifts, setShifts] = useState<ShiftItem[]>([]);
  const [isLoadingShifts, setIsLoadingShifts] = useState<boolean>(false);
  const [shiftsError, setShiftsError] = useState<string | null>(null);

  // Employees lookup for managers
  const [employees, setEmployees] = useState<EmployeeItem[]>([]);

  // Modals
  const [isAttendanceModalOpen, setIsAttendanceModalOpen] = useState<boolean>(false);
  const [editingAttendance, setEditingAttendance] = useState<AttendanceItem | null>(null);
  const [attendanceFormError, setAttendanceFormError] = useState<string | null>(null);
  const [isSubmittingAttendance, setIsSubmittingAttendance] = useState<boolean>(false);

  // Attendance Form Fields
  const [formEmployeeId, setFormEmployeeId] = useState<string>('');
  const [formWorkDate, setFormWorkDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [formShiftId, setFormShiftId] = useState<string>('');
  const [formCheckIn, setFormCheckIn] = useState<string>('');
  const [formCheckOut, setFormCheckOut] = useState<string>('');
  const [formStatus, setFormStatus] = useState<AttendanceStatus>('PRESENT');
  const [formNotes, setFormNotes] = useState<string>('');

  // Shift Modals
  const [pendingDeactivateShift, setPendingDeactivateShift] = useState<ShiftItem | null>(null);
  const [isDeactivatingShift, setIsDeactivatingShift] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isShiftModalOpen, setIsShiftModalOpen] = useState<boolean>(false);
  const [editingShift, setEditingShift] = useState<ShiftItem | null>(null);
  const [shiftFormError, setShiftFormError] = useState<string | null>(null);
  const [isSubmittingShift, setIsSubmittingShift] = useState<boolean>(false);

  // Shift Form Fields
  const [shiftCode, setShiftCode] = useState<string>('');
  const [shiftName, setShiftName] = useState<string>('');
  const [shiftStartTime, setShiftStartTime] = useState<string>('09:00');
  const [shiftEndTime, setShiftEndTime] = useState<string>('17:00');
  const [shiftIsOvernight, setShiftIsOvernight] = useState<boolean>(false);
  const [shiftGraceMinutes, setShiftGraceMinutes] = useState<number>(15);
  const [shiftHalfDayMinutes, setShiftHalfDayMinutes] = useState<number>(240);
  const [shiftDescription, setShiftDescription] = useState<string>('');

  // Load shifts for dropdowns
  const loadShifts = useCallback(async () => {
    setIsLoadingShifts(true);
    setShiftsError(null);
    try {
      const data = await api.getShifts(true);
      setShifts(data);
    } catch (err: unknown) {
      setShiftsError((err as Error).message || 'Failed to load shifts.');
    } finally {
      setIsLoadingShifts(false);
    }
  }, []);

  // Load employees for manager selection
  const loadEmployees = useCallback(async () => {
    if (isEmployee) return;
    try {
      const res = await api.getEmployees({ limit: 100, status: 'ACTIVE' });
      setEmployees(res.items);
    } catch {
      // Safe fallback
    }
  }, [isEmployee]);

  // Load attendance
  const loadAttendance = useCallback(async () => {
    setIsLoadingAttendance(true);
    setAttendanceError(null);
    try {
      const res = await api.getAttendance({
        employeeId: !isEmployee && filterEmployeeId ? filterEmployeeId : undefined,
        status: (filterStatus as AttendanceStatus) || undefined,
        startDate: filterStartDate || undefined,
        endDate: filterEndDate || undefined,
        page,
        limit,
      });
      setAttendanceRecords(res.items);
      setAttendanceTotal(res.total);
    } catch (err: unknown) {
      setAttendanceError((err as Error).message || 'Failed to load attendance records.');
    } finally {
      setIsLoadingAttendance(false);
    }
  }, [isEmployee, filterEmployeeId, filterStatus, filterStartDate, filterEndDate, page, limit]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance]);

  useEffect(() => {
    loadShifts();
    loadEmployees();
  }, [loadShifts, loadEmployees]);

  // Handle Open Create Attendance
  const handleOpenCreateAttendance = () => {
    setEditingAttendance(null);
    const defaultEmp = employees.length > 0 ? employees[0] : null;
    setFormEmployeeId(defaultEmp ? defaultEmp.id : '');
    setFormWorkDate(
      formatDateInTimezone(new Date(), timezone, new Date().toISOString().split('T')[0])
    );
    setFormShiftId(resolveDefaultShiftIdForEmployee(defaultEmp));
    setFormCheckIn('');
    setFormCheckOut('');
    setFormStatus('PRESENT');
    setFormNotes('');
    setAttendanceFormError(null);
    setIsAttendanceModalOpen(true);
  };

  // Handle Employee selection change in Create Attendance Modal
  const handleFormEmployeeChange = (employeeId: string) => {
    setFormEmployeeId(employeeId);
    const selectedEmp = employees.find((emp) => emp.id === employeeId) || null;
    setFormShiftId(resolveDefaultShiftIdForEmployee(selectedEmp));
  };

  // Handle Open Edit Attendance
  const handleOpenEditAttendance = (record: AttendanceItem) => {
    const localTimes = extractLocalTimesForAttendanceForm(record, timezone);
    setEditingAttendance(record);
    setFormEmployeeId(record.employeeId);
    setFormWorkDate(localTimes.workDate);
    setFormShiftId(record.shiftId || '');
    setFormCheckIn(localTimes.checkIn);
    setFormCheckOut(localTimes.checkOut);
    setFormStatus(record.status);
    setFormNotes(record.notes || '');
    setAttendanceFormError(null);
    setIsAttendanceModalOpen(true);
  };

  // Handle Save Attendance
  const handleSaveAttendance = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttendanceFormError(null);
    setIsSubmittingAttendance(true);

    try {
      const selectedShift = shifts.find((s) => s.id === formShiftId) || null;
      const isOvernightShift = Boolean(selectedShift?.isOvernight);

      if (editingAttendance) {
        const updateData = buildAttendanceUpdatePayload({
          editingRecord: editingAttendance,
          formShiftId,
          formStatus,
          formNotes,
          formWorkDate,
          formCheckIn,
          formCheckOut,
          timezone,
          isOvernightShift,
        });
        await api.updateAttendance(editingAttendance.id, updateData);
      } else {
        const { checkIn: checkInIso, checkOut: checkOutIso } = convertManualTimesToUtcIso({
          workDate: formWorkDate,
          checkIn: formCheckIn,
          checkOut: formCheckOut,
          timezone,
          isOvernightShift,
        });
        const createData: CreateAttendanceRequest = {
          employeeId: formEmployeeId,
          workDate: formWorkDate,
          checkIn: checkInIso,
          checkOut: checkOutIso,
          shiftId: formShiftId || null,
          status: formStatus,
          source: 'MANUAL',
          notes: formNotes || null,
        };
        await api.createAttendance(createData);
      }

      setIsAttendanceModalOpen(false);
      loadAttendance();
    } catch (err: unknown) {
      setAttendanceFormError(formatAttendanceSaveError(err));
    } finally {
      setIsSubmittingAttendance(false);
    }
  };

  // Shift Management Handlers
  const handleOpenCreateShift = () => {
    setEditingShift(null);
    setShiftCode('');
    setShiftName('');
    setShiftStartTime('09:00');
    setShiftEndTime('17:00');
    setShiftIsOvernight(false);
    setShiftGraceMinutes(15);
    setShiftHalfDayMinutes(240);
    setShiftDescription('');
    setShiftFormError(null);
    setIsShiftModalOpen(true);
  };

  const handleOpenEditShift = (shift: ShiftItem) => {
    setEditingShift(shift);
    setShiftCode(shift.code);
    setShiftName(shift.name);
    setShiftStartTime(shift.startTime);
    setShiftEndTime(shift.endTime);
    setShiftIsOvernight(shift.isOvernight);
    setShiftGraceMinutes(shift.graceMinutes);
    setShiftHalfDayMinutes(shift.halfDayMinutes);
    setShiftDescription(shift.description || '');
    setShiftFormError(null);
    setIsShiftModalOpen(true);
  };

  const handleSaveShift = async (e: React.FormEvent) => {
    e.preventDefault();
    setShiftFormError(null);
    setIsSubmittingShift(true);

    try {
      if (editingShift) {
        const updateData: UpdateShiftRequest = {
          code: shiftCode.trim().toUpperCase(),
          name: shiftName.trim(),
          startTime: shiftStartTime,
          endTime: shiftEndTime,
          isOvernight: shiftIsOvernight,
          graceMinutes: Number(shiftGraceMinutes),
          halfDayMinutes: Number(shiftHalfDayMinutes),
          description: shiftDescription || null,
        };
        await api.updateShift(editingShift.id, updateData);
      } else {
        const createData: CreateShiftRequest = {
          code: shiftCode.trim().toUpperCase(),
          name: shiftName.trim(),
          startTime: shiftStartTime,
          endTime: shiftEndTime,
          isOvernight: shiftIsOvernight,
          graceMinutes: Number(shiftGraceMinutes),
          halfDayMinutes: Number(shiftHalfDayMinutes),
          description: shiftDescription || null,
        };
        await api.createShift(createData);
      }

      setIsShiftModalOpen(false);
      loadShifts();
    } catch (err: unknown) {
      setShiftFormError((err as Error).message || 'Failed to save shift.');
    } finally {
      setIsSubmittingShift(false);
    }
  };

  const handleDeactivateShift = (shift: ShiftItem) => {
    setActionError(null);
    setPendingDeactivateShift(shift);
  };

  const handleConfirmDeactivateShift = async () => {
    if (!pendingDeactivateShift) return;
    const shift = pendingDeactivateShift;
    setIsDeactivatingShift(true);
    setActionError(null);
    try {
      const outcome = await executeConfirmedAction(
        true,
        () => api.deactivateShift(shift.id),
        'Failed to deactivate shift.'
      );
      if (outcome?.ok) {
        setActionSuccess(`Shift "${shift.name}" (${shift.code}) deactivated.`);
        setPendingDeactivateShift(null);
        loadShifts();
      } else if (outcome?.errorMessage) {
        setActionError(outcome.errorMessage);
        setPendingDeactivateShift(null);
      }
    } finally {
      setIsDeactivatingShift(false);
    }
  };

  const getStatusTextClass = (status: AttendanceStatus) => {
    switch (status) {
      case 'PRESENT':
        return 'text-emerald-400';
      case 'LATE':
        return 'text-amber-400';
      case 'HALF_DAY':
        return 'text-sky-400';
      case 'ON_LEAVE':
        return 'text-indigo-400';
      case 'ABSENT':
        return 'text-rose-400';
      default:
        return 'text-slate-400';
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2.5">
            <CalendarCheck className="w-6 h-6 text-indigo-400" />
            <span>Time &amp; Attendance</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {isEmployee
              ? 'View your personal attendance logs, working hours, and check-in times.'
              : 'Enterprise attendance tracking, shift scheduling, and biometric record verification.'}
          </p>
        </div>

        {/* View Switcher and Actions */}
        <div className="flex items-center gap-3">
          {!isEmployee && (
            <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
              <button
                onClick={() => setActiveTab('attendance')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'attendance'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Attendance Logs
              </button>
              <button
                onClick={() => setActiveTab('shifts')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'shifts'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Shifts Configuration
              </button>
            </div>
          )}

          {activeTab === 'attendance' && !isEmployee && (
            <button
              onClick={handleOpenCreateAttendance}
              className="px-3.5 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Record Attendance</span>
            </button>
          )}

          {activeTab === 'shifts' && !isEmployee && (
            <button
              onClick={handleOpenCreateShift}
              className="px-3.5 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Shift</span>
            </button>
          )}
        </div>
      </div>

      {/* Action Feedback Banners */}
      {actionError && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-rose-950/50 border border-rose-800 text-rose-200 text-xs flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{actionError}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label="Dismiss error notification"
            className="cursor-pointer text-rose-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {actionSuccess && (
        <div
          role="status"
          className="p-4 rounded-xl bg-emerald-950/50 border border-emerald-800 text-emerald-200 text-xs flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{actionSuccess}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionSuccess(null)}
            aria-label="Dismiss success notification"
            className="cursor-pointer text-emerald-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main Tab Content */}
      {activeTab === 'attendance' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Filter className="w-3.5 h-3.5" />
                <span>Filters:</span>
              </div>

              {!isEmployee && (
                <div className="min-w-[160px]">
                  <select
                    value={filterEmployeeId}
                    onChange={(e) => {
                      setFilterEmployeeId(e.target.value);
                      setPage(1);
                    }}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">All Employees</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.employeeCode} · {emp.fullName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="min-w-[130px]">
                <select
                  value={filterStatus}
                  onChange={(e) => {
                    setFilterStatus(e.target.value);
                    setPage(1);
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">All Statuses</option>
                  <option value="PRESENT">Present</option>
                  <option value="ABSENT">Absent</option>
                  <option value="HALF_DAY">Half Day</option>
                  <option value="LATE">Late</option>
                  <option value="ON_LEAVE">On Leave</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={filterStartDate}
                  onChange={(e) => {
                    setFilterStartDate(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Start Date"
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                />
                <span className="text-slate-600 text-xs">to</span>
                <input
                  type="date"
                  value={filterEndDate}
                  onChange={(e) => {
                    setFilterEndDate(e.target.value);
                    setPage(1);
                  }}
                  placeholder="End Date"
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                />
              </div>

              {(filterEmployeeId || filterStatus || filterStartDate || filterEndDate) && (
                <button
                  onClick={() => {
                    setFilterEmployeeId('');
                    setFilterStatus('');
                    setFilterStartDate('');
                    setFilterEndDate('');
                    setPage(1);
                  }}
                  className="text-xs text-slate-400 hover:text-slate-200 underline transition-colors"
                >
                  Reset
                </button>
              )}
            </div>

            <button
              onClick={loadAttendance}
              disabled={isLoadingAttendance}
              className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
              title="Refresh attendance records"
            >
              <RefreshCw className={`w-4 h-4 ${isLoadingAttendance ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Error Message */}
          {attendanceError && (
            <div className="bg-rose-950/40 border border-rose-900 rounded-xl p-4 text-xs text-rose-300 flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{attendanceError}</span>
            </div>
          )}

          {/* Attendance Table */}
          {isLoadingAttendance ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-12">
              <LoadingSpinner message="Retrieving attendance records..." />
            </div>
          ) : attendanceRecords.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-8">
              <EmptyState
                icon={<CalendarCheck className="w-6 h-6" />}
                title="No Attendance Records Found"
                description={
                  isEmployee
                    ? 'No attendance punches or manual records are logged for your account yet.'
                    : 'No attendance records match your active query. Record daily attendance or adjust your date range filters.'
                }
                action={
                  !isEmployee ? (
                    <button
                      onClick={handleOpenCreateAttendance}
                      className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                    >
                      Log Attendance Now
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-3 px-4 font-medium">Work Date</th>
                      {!isEmployee && <th className="py-3 px-4 font-medium">Employee</th>}
                      <th className="py-3 px-4 font-medium">Shift</th>
                      <th className="py-3 px-4 font-medium">Punches &amp; Intervals</th>
                      <th className="py-3 px-4 font-medium">Worked vs Required</th>
                      <th className="py-3 px-4 font-medium">Status</th>
                      <th className="py-3 px-4 font-medium">Source</th>
                      <th className="py-3 px-4 font-medium">Notes</th>
                      {!isEmployee && <th className="py-3 px-4 font-medium text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {attendanceRecords.map((rec) => (
                      <tr key={rec.id} className="hover:bg-slate-800/40 transition-colors align-top">
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-200 whitespace-nowrap">
                          {rec.workDate.split('T')[0]}
                        </td>
                        {!isEmployee && (
                          <td className="py-3 px-4">
                            <div className="font-medium text-slate-200">{rec.employeeName || '—'}</div>
                            <div className="text-[11px] text-slate-500 font-mono">{rec.employeeCode}</div>
                          </td>
                        )}
                        <td className="py-3 px-4 text-slate-400 whitespace-nowrap">{rec.shiftName || '—'}</td>
                        <td className="py-3 px-4">
                          <AttendanceIntervalsCell record={rec} timezone={timezone} />
                        </td>
                        <td className="py-3 px-4">
                          <AttendanceWorkedSummaryCell record={rec} />
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span className={`font-semibold ${getStatusTextClass(rec.status)}`}>
                            {rec.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-400 whitespace-nowrap">{rec.source}</td>
                        <td className="py-3 px-4 text-slate-400 max-w-xs truncate" title={rec.notes || ''}>
                          {rec.notes || '—'}
                        </td>
                        {!isEmployee && (
                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => handleOpenEditAttendance(rec)}
                              className="p-1 text-slate-400 hover:text-indigo-400 transition-colors rounded hover:bg-slate-800"
                              title="Edit Attendance Record"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
                <span>
                  Showing <span className="font-mono tabular-nums font-medium text-slate-200">{attendanceRecords.length}</span> of{' '}
                  <span className="font-mono tabular-nums font-medium text-slate-200">{attendanceTotal}</span> records
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    Previous
                  </button>
                  <span className="font-mono tabular-nums">Page {page}</span>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page * limit >= attendanceTotal}
                    className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Shifts Management Tab */}
      {activeTab === 'shifts' && !isEmployee && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
            <div className="text-xs text-slate-400">
              Configured work shifts govern automatic late calculations, half-day thresholds, and biometric alignment.
            </div>
            <button
              onClick={loadShifts}
              disabled={isLoadingShifts}
              className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
              title="Refresh shifts"
            >
              <RefreshCw className={`w-4 h-4 ${isLoadingShifts ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {shiftsError && (
            <div className="bg-rose-950/40 border border-rose-900 rounded-xl p-4 text-xs text-rose-300 flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{shiftsError}</span>
            </div>
          )}

          {isLoadingShifts ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-12">
              <LoadingSpinner message="Loading configured shifts..." />
            </div>
          ) : shifts.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-8">
              <EmptyState
                icon={<Clock className="w-6 h-6" />}
                title="No Shifts Configured"
                description="Create your company's standard working shifts to enable accurate attendance reporting."
                action={
                  <button
                    onClick={handleOpenCreateShift}
                    className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                  >
                    Create First Shift
                  </button>
                }
              />
            </div>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4 font-medium">Code</th>
                    <th className="py-3 px-4 font-medium">Shift Name</th>
                    <th className="py-3 px-4 font-medium">Hours</th>
                    <th className="py-3 px-4 font-medium">Overnight</th>
                    <th className="py-3 px-4 font-medium">Grace Period</th>
                    <th className="py-3 px-4 font-medium">Half-Day Threshold</th>
                    <th className="py-3 px-4 font-medium">Status</th>
                    <th className="py-3 px-4 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {shifts.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-4 font-mono font-semibold text-indigo-300">{s.code}</td>
                      <td className="py-3 px-4 font-medium text-slate-200">{s.name}</td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                        {s.startTime} – {s.endTime}
                      </td>
                      <td className="py-3 px-4 text-slate-400">
                        {s.isOvernight ? (
                          <span className="text-amber-400 font-medium">Yes (Cross-midnight)</span>
                        ) : (
                          <span className="text-slate-500">Standard</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-400">
                        {s.graceMinutes} mins
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-400">
                        {s.halfDayMinutes} mins ({Math.round(s.halfDayMinutes / 60)}h)
                      </td>
                      <td className="py-3 px-4">
                        <span className={`font-semibold ${s.isActive ? 'text-emerald-400' : 'text-slate-500'}`}>
                          {s.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleOpenEditShift(s)}
                            className="p-1 text-slate-400 hover:text-indigo-400 transition-colors rounded hover:bg-slate-800"
                            title="Edit Shift"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          {s.isActive && (
                            <button
                              onClick={() => handleDeactivateShift(s)}
                              className="p-1 text-slate-400 hover:text-rose-400 transition-colors rounded hover:bg-slate-800"
                              title="Deactivate Shift (Soft-Deactivation)"
                            >
                              <PowerOff className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Record/Edit Attendance Modal */}
      <AttendanceFormModal
        isOpen={isAttendanceModalOpen}
        editingAttendance={editingAttendance}
        employees={employees}
        shifts={shifts}
        timezone={timezone}
        formEmployeeId={formEmployeeId}
        formWorkDate={formWorkDate}
        formShiftId={formShiftId}
        formCheckIn={formCheckIn}
        formCheckOut={formCheckOut}
        formStatus={formStatus}
        formNotes={formNotes}
        attendanceFormError={attendanceFormError}
        isSubmittingAttendance={isSubmittingAttendance}
        onClose={() => setIsAttendanceModalOpen(false)}
        onEmployeeChange={handleFormEmployeeChange}
        onWorkDateChange={setFormWorkDate}
        onShiftChange={setFormShiftId}
        onCheckInChange={setFormCheckIn}
        onCheckOutChange={setFormCheckOut}
        onStatusChange={setFormStatus}
        onNotesChange={setFormNotes}
        onSubmit={handleSaveAttendance}
      />

      {/* Create/Edit Shift Modal */}
      {isShiftModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-400" />
                <span>{editingShift ? 'Edit Shift Schedule' : 'Create New Shift'}</span>
              </h3>
              <button
                onClick={() => setIsShiftModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {shiftFormError && (
              <div className="bg-rose-950/40 border border-rose-900 rounded-lg p-3 text-xs text-rose-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{shiftFormError}</span>
              </div>
            )}

            <form onSubmit={handleSaveShift} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Shift Code *</label>
                  <input
                    type="text"
                    value={shiftCode}
                    onChange={(e) => setShiftCode(e.target.value)}
                    placeholder="e.g. MORN-1"
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono uppercase"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Shift Name *</label>
                  <input
                    type="text"
                    value={shiftName}
                    onChange={(e) => setShiftName(e.target.value)}
                    placeholder="e.g. Morning Regular Shift"
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Start Time (HH:mm) *</label>
                  <input
                    type="time"
                    value={shiftStartTime}
                    onChange={(e) => setShiftStartTime(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">End Time (HH:mm) *</label>
                  <input
                    type="time"
                    value={shiftEndTime}
                    onChange={(e) => setShiftEndTime(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="isOvernight"
                  checked={shiftIsOvernight}
                  onChange={(e) => setShiftIsOvernight(e.target.checked)}
                  className="rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-0"
                />
                <label htmlFor="isOvernight" className="text-xs text-slate-300 cursor-pointer">
                  Overnight Shift (wraps past midnight into next calendar day)
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Grace Period (Minutes)</label>
                  <input
                    type="number"
                    min="0"
                    max="120"
                    value={shiftGraceMinutes}
                    onChange={(e) => setShiftGraceMinutes(parseInt(e.target.value, 10) || 0)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                  />
                  <p className="text-[10px] text-slate-500 mt-0.5">Tolerance before marked LATE</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Half-Day Threshold (Minutes)</label>
                  <input
                    type="number"
                    min="60"
                    max="720"
                    value={shiftHalfDayMinutes}
                    onChange={(e) => setShiftHalfDayMinutes(parseInt(e.target.value, 10) || 0)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                  />
                  <p className="text-[10px] text-slate-500 mt-0.5">Minimum minutes for half-day credit</p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Description / Notes</label>
                <textarea
                  value={shiftDescription}
                  onChange={(e) => setShiftDescription(e.target.value)}
                  placeholder="Optional operational details for this shift..."
                  rows={2}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsShiftModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingShift}
                  className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition disabled:opacity-50"
                >
                  {isSubmittingShift ? 'Saving...' : editingShift ? 'Update Shift' : 'Create Shift'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={Boolean(pendingDeactivateShift)}
        title="Deactivate Shift"
        message={
          pendingDeactivateShift
            ? `Are you sure you want to deactivate shift "${pendingDeactivateShift.name}" (${pendingDeactivateShift.code})? It can no longer be assigned to new records.`
            : ''
        }
        confirmLabel="Deactivate Shift"
        confirmBusyLabel="Deactivating..."
        variant="danger"
        isSubmitting={isDeactivatingShift}
        onConfirm={handleConfirmDeactivateShift}
        onCancel={() => {
          if (!isDeactivatingShift) {
            setPendingDeactivateShift(null);
          }
        }}
      />
    </div>
  );
};
