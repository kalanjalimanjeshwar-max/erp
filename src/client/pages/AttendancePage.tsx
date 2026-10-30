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
  User,
  Search,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { LoadingSpinner } from '../components/common/LoadingSpinner.tsx';
import { EmptyState } from '../components/common/EmptyState.tsx';
import {
  AuthUser,
  AttendanceItem,
  AttendanceStatus,
  ShiftItem,
  EmployeeItem,
  CreateAttendanceRequest,
  UpdateAttendanceRequest,
  CreateShiftRequest,
  UpdateShiftRequest,
} from '../../shared/types.ts';

interface AttendancePageProps {
  currentUser: AuthUser;
}

export const AttendancePage: React.FC<AttendancePageProps> = ({ currentUser }) => {
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
    setFormEmployeeId(employees.length > 0 ? employees[0].id : '');
    setFormWorkDate(new Date().toISOString().split('T')[0]);
    setFormShiftId(shifts.length > 0 ? shifts[0].id : '');
    setFormCheckIn('');
    setFormCheckOut('');
    setFormStatus('PRESENT');
    setFormNotes('');
    setAttendanceFormError(null);
    setIsAttendanceModalOpen(true);
  };

  // Handle Open Edit Attendance
  const handleOpenEditAttendance = (record: AttendanceItem) => {
    setEditingAttendance(record);
    setFormEmployeeId(record.employeeId);
    setFormWorkDate(record.workDate.split('T')[0]);
    setFormShiftId(record.shiftId || '');
    setFormCheckIn(record.checkIn ? record.checkIn.substring(11, 16) : '');
    setFormCheckOut(record.checkOut ? record.checkOut.substring(11, 16) : '');
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
      // Build ISO strings if time is provided
      let checkInIso: string | null = null;
      let checkOutIso: string | null = null;

      if (formCheckIn) {
        checkInIso = `${formWorkDate}T${formCheckIn}:00.000Z`;
      }
      if (formCheckOut) {
        checkOutIso = `${formWorkDate}T${formCheckOut}:00.000Z`;
      }

      if (editingAttendance) {
        const updateData: UpdateAttendanceRequest = {
          checkIn: checkInIso,
          checkOut: checkOutIso,
          shiftId: formShiftId || null,
          status: formStatus,
          notes: formNotes || null,
        };
        await api.updateAttendance(editingAttendance.id, updateData);
      } else {
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
      if (err instanceof ApiError && err.statusCode === 409) {
        setAttendanceFormError('An attendance record already exists for this employee on this date.');
      } else {
        setAttendanceFormError((err as Error).message || 'Failed to save attendance record.');
      }
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

  const handleDeactivateShift = async (shift: ShiftItem) => {
    if (!confirm(`Are you sure you want to deactivate shift "${shift.name}" (${shift.code})? It can no longer be assigned to new records.`)) {
      return;
    }
    try {
      await api.deactivateShift(shift.id);
      loadShifts();
    } catch (err: unknown) {
      alert((err as Error).message || 'Failed to deactivate shift.');
    }
  };

  const formatTime = (isoString: string | null) => {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
    } catch {
      return '—';
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
                      <th className="py-3 px-4 font-medium">Check-In</th>
                      <th className="py-3 px-4 font-medium">Check-Out</th>
                      <th className="py-3 px-4 font-medium">Status</th>
                      <th className="py-3 px-4 font-medium">Late</th>
                      <th className="py-3 px-4 font-medium">Overtime</th>
                      <th className="py-3 px-4 font-medium">Source</th>
                      <th className="py-3 px-4 font-medium">Notes</th>
                      {!isEmployee && <th className="py-3 px-4 font-medium text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {attendanceRecords.map((rec) => (
                      <tr key={rec.id} className="hover:bg-slate-800/40 transition-colors">
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-200">
                          {rec.workDate.split('T')[0]}
                        </td>
                        {!isEmployee && (
                          <td className="py-3 px-4">
                            <div className="font-medium text-slate-200">{rec.employeeName || '—'}</div>
                            <div className="text-[11px] text-slate-500 font-mono">{rec.employeeCode}</div>
                          </td>
                        )}
                        <td className="py-3 px-4 text-slate-400">{rec.shiftName || '—'}</td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                          {formatTime(rec.checkIn)}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                          {formatTime(rec.checkOut)}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`font-semibold ${getStatusTextClass(rec.status)}`}>
                            {rec.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums">
                          {rec.lateMinutes > 0 ? (
                            <span className="text-amber-400 font-medium">{rec.lateMinutes}m</span>
                          ) : (
                            <span className="text-slate-500">0</span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums">
                          {rec.overtimeMinutes > 0 ? (
                            <span className="text-emerald-400 font-medium">+{rec.overtimeMinutes}m</span>
                          ) : (
                            <span className="text-slate-500">0</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-400">{rec.source}</td>
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
      {isAttendanceModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <CalendarCheck className="w-4 h-4 text-indigo-400" />
                <span>{editingAttendance ? 'Edit Attendance Record' : 'Record Manual Attendance'}</span>
              </h3>
              <button
                onClick={() => setIsAttendanceModalOpen(false)}
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

            <form onSubmit={handleSaveAttendance} className="space-y-4">
              {!editingAttendance && (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Employee *</label>
                  <select
                    value={formEmployeeId}
                    onChange={(e) => setFormEmployeeId(e.target.value)}
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
                    onChange={(e) => setFormWorkDate(e.target.value)}
                    disabled={!!editingAttendance}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums disabled:opacity-50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Assigned Shift</label>
                  <select
                    value={formShiftId}
                    onChange={(e) => setFormShiftId(e.target.value)}
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
                  <label className="block text-xs font-medium text-slate-300 mb-1">Check-In Time</label>
                  <input
                    type="time"
                    value={formCheckIn}
                    onChange={(e) => setFormCheckIn(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Check-Out Time</label>
                  <input
                    type="time"
                    value={formCheckOut}
                    onChange={(e) => setFormCheckOut(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Attendance Status *</label>
                <select
                  value={formStatus}
                  onChange={(e) => setFormStatus(e.target.value as AttendanceStatus)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="PRESENT">PRESENT (Full Day)</option>
                  <option value="LATE">LATE (Grace Period Exceeded)</option>
                  <option value="HALF_DAY">HALF_DAY (0.5 Day Attendance)</option>
                  <option value="ABSENT">ABSENT (Unpaid Absence)</option>
                  <option value="ON_LEAVE">ON_LEAVE (Approved Leave)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Notes / Justification</label>
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="Optional manual attendance remarks..."
                  rows={2}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAttendanceModalOpen(false)}
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
      )}

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
    </div>
  );
};
