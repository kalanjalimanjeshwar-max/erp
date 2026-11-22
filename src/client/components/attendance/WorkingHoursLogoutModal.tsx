import React, { useEffect, useState } from 'react';
import {
  Clock,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  LogOut,
  Calendar,
  Briefcase,
  HelpCircle,
  ExternalLink,
} from 'lucide-react';
import { api, ApiError } from '../../services/api.ts';
import {
  WorkingHoursSummary,
  AttendanceIntervalItem,
  AuthUser,
  CompanyProfile,
} from '../../../shared/types.ts';
import {
  formatTimeInTimezone,
  getEffectiveTimeZone,
  getTimezoneShortName,
} from '../../../shared/timezone.ts';
import { LoadingSpinner } from '../common/LoadingSpinner.tsx';

export type WorkingHoursSummaryWithIntervals = WorkingHoursSummary & {
  intervals?: AttendanceIntervalItem[];
};

interface WorkingHoursLogoutModalProps {
  isOpen: boolean;
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
  onClose: () => void;
  onConfirmLogout: () => void;
  onNavigateToAttendance?: () => void;
}

export function formatWorkedHoursMinutes(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || Number.isNaN(minutes)) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export const WorkingHoursSummaryContent: React.FC<{
  summary: WorkingHoursSummaryWithIntervals;
  fallbackTimezone?: string | null;
}> = ({ summary, fallbackTimezone }) => {
  const effectiveTimezone = getEffectiveTimeZone(summary.timezone || fallbackTimezone);

  const formatIsoTime = (iso: string | null) => {
    if (!iso) return 'None';
    return formatTimeInTimezone(iso, effectiveTimezone, {
      hour12: true,
      includeZoneAbbr: true,
      fallback: iso,
    });
  };

  const intervals = Array.isArray(summary.intervals)
    ? [...summary.intervals].sort((a, b) => a.sequence - b.sequence)
    : [];

  const showWorkedBreakdown =
    summary.expectedDurationHours !== null ||
    summary.shortDurationMinutes > 0 ||
    summary.overtimeDurationMinutes > 0 ||
    typeof summary.actualWorkedMinutes === 'number';

  return (
    <div className="space-y-4">
      {/* Shift & Workday Metadata Card */}
      <div className="grid grid-cols-2 gap-2 text-xs bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5">
        <div className="flex items-center gap-2 text-slate-400">
          <Calendar className="w-3.5 h-3.5 text-slate-500" />
          <span>Work Date:</span>
          <span className="font-mono font-medium text-slate-200">{summary.workDate}</span>
        </div>
        <div className="flex items-center gap-2 text-slate-400">
          <Clock className="w-3.5 h-3.5 text-slate-500" />
          <span>Timezone:</span>
          <span className="font-mono font-medium text-slate-200">{summary.timezone}</span>
        </div>
        <div className="col-span-2 flex items-center justify-between gap-2 text-slate-400 border-t border-slate-800/60 pt-2 mt-1">
          <div className="flex items-center gap-2">
            <Briefcase className="w-3.5 h-3.5 text-slate-500" />
            <span>Assigned Shift:</span>
            <span className="font-medium text-slate-200">
              {summary.shiftSchedule || 'No shift assigned'}
            </span>
          </div>
          {typeof summary.punchPairsCount === 'number' && (
            <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
              Punch Pairs: {summary.punchPairsCount}
            </span>
          )}
        </div>
      </div>

      {/* Incomplete-Punch Warning */}
      {summary.hasIncompletePunch === true && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-amber-950/40 border border-amber-700/60 text-amber-200 text-xs flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-amber-100">Incomplete Punch Warning</div>
            <p className="text-[11px] text-amber-200/90 mt-0.5">
              One or more IN/OUT punch sequences are unclosed for today. Worked duration reflects completed punch pairs only.
            </p>
          </div>
        </div>
      )}

      {/* Attendance Punch Timestamps */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
        <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
          <div className="text-[11px] text-slate-400">Check-In Punch</div>
          <div className="text-sm font-semibold text-slate-200 mt-0.5">
            {formatIsoTime(summary.checkIn)}
          </div>
        </div>
        <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
          <div className="text-[11px] text-slate-400">Check-Out Punch</div>
          <div className={`text-sm font-semibold mt-0.5 ${summary.checkOut ? 'text-slate-200' : 'text-rose-400'}`}>
            {summary.checkOut ? formatIsoTime(summary.checkOut) : 'Missing Punch'}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1 bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
          <div className="text-[11px] text-slate-400">Duration Completed</div>
          <div className="text-sm font-semibold text-indigo-300 mt-0.5">
            {summary.workedDurationHours !== null ? `${summary.workedDurationHours}h` : 'Incomplete'}
          </div>
          {typeof summary.actualWorkedMinutes === 'number' && (
            <div className="text-[11px] font-mono text-slate-400 mt-0.5">
              {summary.actualWorkedMinutes} mins ({formatWorkedHoursMinutes(summary.actualWorkedMinutes)})
            </div>
          )}
        </div>
      </div>

      {/* Multi-Interval Details when available */}
      {intervals.length > 0 && (
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 space-y-2 text-xs">
          <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold uppercase tracking-wide">
            <span>Recorded IN/OUT Intervals</span>
            <span className="font-mono text-slate-300">
              {typeof summary.punchPairsCount === 'number'
                ? `${summary.punchPairsCount} completed pair(s)`
                : `${intervals.filter((iv) => iv.isComplete).length} completed pair(s)`}
            </span>
          </div>
          <div className="divide-y divide-slate-800/70">
            {intervals.map((iv) => (
              <div key={iv.id} className="py-1.5 flex items-center justify-between gap-2 text-[11px]">
                <div className="font-mono text-slate-300">
                  <span className="text-slate-500 mr-1.5">#{iv.sequence}</span>
                  <span>IN {formatIsoTime(iv.checkIn)}</span>
                  <span className="text-slate-500 mx-1.5">→</span>
                  <span className={iv.checkOut ? 'text-slate-300' : 'text-amber-400'}>
                    OUT {iv.checkOut ? formatIsoTime(iv.checkOut) : 'Missing'}
                  </span>
                </div>
                <div className="font-mono text-slate-400 shrink-0">
                  {iv.isComplete ? `${iv.durationMinutes}m` : 'Open'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Separate Non-Netted Short Time & Informational Extra Time */}
      {showWorkedBreakdown && (
        <div className="grid grid-cols-2 gap-2.5 text-xs">
          <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
            <div className="text-[11px] text-slate-400">Short Time</div>
            <div
              className={`text-sm font-mono font-semibold mt-0.5 ${
                summary.shortDurationMinutes > 0 ? 'text-amber-300' : 'text-slate-300'
              }`}
            >
              {summary.shortDurationMinutes} mins
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              Tracked independently for payroll compliance
            </div>
          </div>
          <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
            <div className="text-[11px] text-slate-400">Extra Time</div>
            <div
              className={`text-sm font-mono font-semibold mt-0.5 ${
                summary.overtimeDurationMinutes > 0 ? 'text-indigo-300' : 'text-slate-300'
              }`}
            >
              {summary.overtimeDurationMinutes > 0 ? `+${summary.overtimeDurationMinutes} mins` : '0 mins'}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              Informational only — does not offset Short Time
            </div>
          </div>
        </div>
      )}

      {/* Explanatory Policy Notice */}
      <div
        className={`p-4 rounded-xl border text-xs leading-relaxed space-y-1.5 ${
          summary.requiresAttendanceAction
            ? 'bg-rose-950/30 border-rose-800/50 text-rose-200'
            : summary.status === 'SHORT_HOURS'
            ? 'bg-amber-950/30 border-amber-800/50 text-amber-200'
            : summary.status === 'OVERTIME'
            ? 'bg-indigo-950/30 border-indigo-800/50 text-indigo-200'
            : 'bg-emerald-950/30 border-emerald-800/50 text-emerald-200'
        }`}
      >
        <div className="font-semibold flex items-center gap-1.5">
          {summary.requiresAttendanceAction ? (
            <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
          ) : summary.status === 'SHORT_HOURS' ? (
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          )}
          <span>Working-Hours Evaluation</span>
        </div>
        <p>{summary.statusMessage}</p>
      </div>

      {/* Crucial Safeguard Warning */}
      <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl text-[11px] text-slate-400 flex items-start gap-2.5">
        <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <span>
          <strong>Attendance Safety Rule:</strong> Logging out of this application terminates your active web
          session, but <strong>does NOT record an attendance punch</strong>. To complete your shift, ensure you
          record a Check-Out punch on the Attendance register.
        </span>
      </div>
    </div>
  );
};

export const WorkingHoursLogoutModal: React.FC<WorkingHoursLogoutModalProps> = ({
  isOpen,
  currentUser,
  companyProfile,
  onClose,
  onConfirmLogout,
  onNavigateToAttendance,
}) => {
  const [summary, setSummary] = useState<WorkingHoursSummaryWithIntervals | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSummary(null);
      setFetchError(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setFetchError(null);

    // In Preview Mode, provide deterministic simulation summary
    if (currentUser.isPreview) {
      setTimeout(() => {
        if (!isMounted) return;
        const previewTz = getEffectiveTimeZone(companyProfile?.timezone);
        const previewTzAbbr = getTimezoneShortName(previewTz);
        const previewCheckInIso = `${new Date().toISOString().split('T')[0]}T03:35:00.000Z`;
        const formattedCheckIn = formatTimeInTimezone(previewCheckInIso, previewTz, {
          includeZoneAbbr: true,
        });
        setSummary({
          workDate: new Date().toISOString().split('T')[0],
          timezone: previewTz,
          employeeId: 'emp-preview-01',
          employeeName: currentUser.fullName || 'Preview Employee',
          employeeCode: 'EMP-PREVIEW',
          shiftId: 'shift-preview-01',
          shiftName: 'General Morning Shift',
          shiftSchedule: 'General Morning Shift (09:00 – 17:00)',
          expectedDurationHours: 8.0,
          checkIn: previewCheckInIso,
          checkOut: null, // Simulated missing punch
          workedDurationHours: null,
          actualWorkedMinutes: 0,
          punchPairsCount: 0,
          hasIncompletePunch: true,
          shortDurationMinutes: 0,
          overtimeDurationMinutes: 0,
          status: 'INCOMPLETE_ATTENDANCE',
          statusMessage: `Attendance Incomplete: You checked in today at ${formattedCheckIn} (${previewTzAbbr}), but have not recorded a check-out punch. Logging out of CoreERP will NOT record your check-out. Please punch out on the Attendance page if your workday has ended.`,
          requiresAttendanceAction: true,
        });
        setIsLoading(false);
      }, 150);
      return () => {
        isMounted = false;
      };
    }

    api
      .getLogoutSummary()
      .then((data) => {
        if (isMounted) {
          setSummary(data);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (isMounted) {
          const apiErr = err as ApiError;
          setFetchError(apiErr.message || 'Unable to retrieve your current shift summary.');
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, currentUser, companyProfile?.timezone]);

  if (!isOpen) return null;

  const getStatusBadge = () => {
    if (!summary) return null;
    switch (summary.status) {
      case 'HOURS_COMPLETED':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Shift Hours Completed
          </span>
        );
      case 'SHORT_HOURS':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40">
            <AlertTriangle className="w-3.5 h-3.5" />
            Short Hours Recorded
          </span>
        );
      case 'OVERTIME':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
            <Clock className="w-3.5 h-3.5" />
            Overtime Recorded
          </span>
        );
      case 'INCOMPLETE_ATTENDANCE':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/40">
            <AlertCircle className="w-3.5 h-3.5" />
            Check-Out Punch Missing
          </span>
        );
      case 'MISSING_CHECK_IN':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/40">
            <AlertCircle className="w-3.5 h-3.5" />
            No Check-In Recorded
          </span>
        );
      case 'NO_SHIFT_ASSIGNED':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-500/20 text-slate-300 border border-slate-500/40">
            <HelpCircle className="w-3.5 h-3.5" />
            No Shift Assigned
          </span>
        );
      case 'DATA_REQUIRES_REVIEW':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/40">
            <AlertTriangle className="w-3.5 h-3.5" />
            Requires Administrative Review
          </span>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="logout-summary-title"
    >
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl text-slate-200 space-y-5 max-h-[90vh] overflow-y-auto">
        {/* Modal Header */}
        <div className="flex items-start justify-between border-b border-slate-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-slate-800 text-indigo-400 border border-slate-700/60">
              <LogOut className="w-5 h-5" />
            </div>
            <div>
              <h3 id="logout-summary-title" className="text-base font-bold text-white">
                Confirm Application Logout
              </h3>
              <p className="text-xs text-slate-400">
                Shift status for {currentUser.fullName || currentUser.email}
              </p>
            </div>
          </div>
          {getStatusBadge()}
        </div>

        {/* Content Body */}
        {isLoading ? (
          <div className="py-8 flex flex-col items-center justify-center space-y-3">
            <LoadingSpinner size="md" />
            <p className="text-xs text-slate-400">Retrieving today&apos;s shift &amp; attendance summary...</p>
          </div>
        ) : fetchError ? (
          <div className="p-4 rounded-xl bg-rose-950/30 border border-rose-800/50 text-rose-300 text-xs space-y-2">
            <div className="flex items-center gap-2 font-semibold text-rose-200">
              <AlertCircle className="w-4 h-4 text-rose-400" />
              Failed to verify current shift status
            </div>
            <p>{fetchError}</p>
            <p className="text-slate-400 text-[11px]">
              You may still log out of your session, but your shift attendance could not be verified.
            </p>
          </div>
        ) : summary ? (
          <WorkingHoursSummaryContent
            summary={summary}
            fallbackTimezone={companyProfile?.timezone}
          />
        ) : null}

        {/* Modal Action Buttons */}
        <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-slate-800/80">
          <button
            onClick={onClose}
            className="w-full sm:w-auto px-4 py-2 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          >
            Stay Logged In
          </button>

          <div className="flex flex-col sm:flex-row items-center gap-2 w-full sm:w-auto">
            {summary?.requiresAttendanceAction && onNavigateToAttendance && (
              <button
                onClick={() => {
                  onClose();
                  onNavigateToAttendance();
                }}
                className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors shadow-sm shadow-indigo-600/30"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Record Punch on Attendance Page
              </button>
            )}

            <button
              onClick={() => {
                onClose();
                onConfirmLogout();
              }}
              className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-rose-600 hover:bg-rose-500 text-white transition-colors shadow-sm shadow-rose-600/30"
            >
              <LogOut className="w-3.5 h-3.5" />
              Confirm &amp; Log Out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

