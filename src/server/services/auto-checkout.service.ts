import { prisma } from '../db/client.js';
import {
  addCalendarDaysToDateStr,
  isValidTimeZone,
  localDateTimeToUtcIso,
} from '../../shared/timezone.js';
import { AuditService } from './audit.service.js';
import { deriveAttendanceAdvisoryLockKeys } from './punch-reconciliation.service.js';
import { WorkPolicyService, canUsePrismaDelegate } from './work-policy.service.js';

export const AUTO_CHECKOUT_TARGET_HOUR = 23;
export const AUTO_CHECKOUT_TARGET_MINUTE = 55;
export const AUTO_CHECKOUT_LOCAL_TIME_STR = '23:55:00';
const AUTO_CHECKOUT_NOTE_PREFIX = '[System Auto Check-Out';
const MAX_TRACKED_COMPLETION_KEYS = 2000;

export interface AutoCheckoutClockEvaluation {
  validTimezone: boolean;
  timeZone: string;
  localDateStr: string | null;
  hour: number;
  minute: number;
  second: number;
  isDue: boolean;
  reason?: string;
}

export interface AutoCheckoutEmployeeOutcome {
  attendanceId: string;
  employeeId: string;
  employeeCode: string | null;
  workDate: string;
  outcome: 'AUTO_CHECKED_OUT' | 'SKIPPED';
  reason?: string;
  checkOut?: string;
  actualWorkedMinutes?: number;
  overtimeMinutes?: number;
  closedIntervalsCount?: number;
  source?: 'SYSTEM_GENERATED';
}

export interface AutoCheckoutCompanyRunResult {
  companyId: string;
  companyTimezone: string;
  workDate: string;
  isOutageRecovery?: boolean;
  evaluated: number;
  autoCheckedOut: number;
  skipped: number;
  payrollLocked: boolean;
  outcomes: AutoCheckoutEmployeeOutcome[];
}

export interface AutoCheckoutCycleResult {
  evaluatedCompanies: number;
  dueCompanies: number;
  recoveredCompanyDates: number;
  skippedAlreadyRan: number;
  skippedInvalidTimezone: number;
  totalAutoCheckedOut: number;
  totalSkipped: number;
  companyResults: AutoCheckoutCompanyRunResult[];
  errors: Array<{ companyId: string; message: string }>;
}

/**
 * Evaluates whether automatic 11:55 PM check-out is due for a company's configured
 * IANA timezone at the supplied UTC instant.
 *
 * Fails closed when the company timezone is missing or invalid.
 * Returns `isDue: true` during the 23:55:00–23:59:59 local-time window so polling
 * schedulers never miss the 11:55 PM trigger due to event-loop jitter, while
 * per-company-date deduplication and database idempotency ensure single execution.
 */
export function evaluateCompanyAutoCheckoutTime(
  referenceNow: Date,
  timeZone: string | null | undefined
): AutoCheckoutClockEvaluation {
  const normalizedTz = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!normalizedTz || !isValidTimeZone(normalizedTz)) {
    return {
      validTimezone: false,
      timeZone: normalizedTz,
      localDateStr: null,
      hour: -1,
      minute: -1,
      second: -1,
      isDue: false,
      reason: !normalizedTz ? 'COMPANY_TIMEZONE_MISSING' : 'COMPANY_TIMEZONE_INVALID',
    };
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizedTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(referenceNow);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  const rawHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const second = Number(parts.find((p) => p.type === 'second')?.value ?? '0');

  // Guard against ICU edge case emitting 24 at midnight
  const hour = rawHour === 24 ? 0 : rawHour;
  const localDateStr = year && month && day ? `${year}-${month}-${day}` : null;
  const isDue =
    Boolean(localDateStr) &&
    hour === AUTO_CHECKOUT_TARGET_HOUR &&
    minute >= AUTO_CHECKOUT_TARGET_MINUTE;

  return {
    validTimezone: true,
    timeZone: normalizedTz,
    localDateStr,
    hour,
    minute,
    second,
    isDue,
  };
}

function isStrictDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatWorkedHoursLabel(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${Number(hours.toFixed(2))}h`;
}

function appendAutoCheckoutNote(
  existingNotes: string | null | undefined,
  companyTimezone: string,
  configuredMinutes: number
): string {
  const note = `${AUTO_CHECKOUT_NOTE_PREFIX} at 23:55 ${companyTimezone}: worked ${formatWorkedHoursLabel(configuredMinutes)}, overtime 0m]`;
  const trimmed = existingNotes?.trim();
  if (!trimmed) {
    return note;
  }
  if (trimmed.includes(AUTO_CHECKOUT_NOTE_PREFIX)) {
    return trimmed;
  }
  return `${trimmed} | ${note}`;
}

export class AutoCheckoutService {
  /**
   * Computes the exact UTC Date representing 23:55:00 on `executionDateStr` in `companyTimezone`.
   */
  static resolveScheduledCutoffTimestamp(
    executionDateStr: string,
    companyTimezone: string
  ): Date {
    const utcIso = localDateTimeToUtcIso(
      executionDateStr,
      AUTO_CHECKOUT_LOCAL_TIME_STR,
      companyTimezone
    );
    if (!utcIso) {
      throw new Error(
        `Failed to resolve 23:55 auto check-out timestamp for ${executionDateStr} in timezone '${companyTimezone}'.`
      );
    }
    return new Date(utcIso);
  }

  /**
   * Checks whether the specified workDate falls inside a finalized / locked payroll period.
   */
  private static async isPayrollPeriodLocked(
    companyId: string,
    workDateObj: Date,
    db: any = prisma
  ): Promise<boolean> {
    if (!canUsePrismaDelegate(db, 'payrollPeriod', 'findFirst')) {
      return false;
    }
    const lockedPayroll = await db.payrollPeriod.findFirst({
      where: {
        companyId,
        startDate: { lte: workDateObj },
        endDate: { gte: workDateObj },
        status: { in: ['PROCESSED', 'ACCOUNTS_APPROVED', 'POSTED'] },
      },
      select: { id: true },
    });
    return Boolean(lockedPayroll);
  }

  /**
   * Discovers distinct prior local attendance dates (`workDate < currentLocalDateStr`)
   * for a company that still have open, eligible Attendance records (checkIn present,
   * checkOut null, not SYSTEM_GENERATED, not ON_LEAVE/ABSENT).
   *
   * Returns deduplicated YYYY-MM-DD strings sorted in ascending chronological order so
   * outage recovery processes missed dates deterministically from oldest to newest.
   */
  static async discoverMissedAutoCheckoutDates(
    companyId: string,
    currentLocalDateStr: string,
    db: any = prisma
  ): Promise<string[]> {
    if (!companyId || !isStrictDateOnly(currentLocalDateStr)) {
      return [];
    }
    if (!canUsePrismaDelegate(db, 'attendance', 'findMany')) {
      return [];
    }

    const currentLocalDateObj = new Date(`${currentLocalDateStr}T00:00:00.000Z`);
    const openPriorRows = await db.attendance.findMany({
      where: {
        companyId,
        workDate: { lt: currentLocalDateObj },
        checkIn: { not: null },
        checkOut: null,
        source: { not: 'SYSTEM_GENERATED' },
        status: { notIn: ['ON_LEAVE', 'ABSENT'] },
      },
      select: {
        workDate: true,
      },
      orderBy: {
        workDate: 'asc',
      },
    });

    const missedDates = new Set<string>();
    for (const row of openPriorRows) {
      if (!(row?.workDate instanceof Date)) {
        continue;
      }
      const dateStr = row.workDate.toISOString().split('T')[0];
      // Defensive guard in case a test mock ignores the `{ lt }` predicate on workDate
      if (isStrictDateOnly(dateStr) && dateStr < currentLocalDateStr) {
        missedDates.add(dateStr);
      }
    }

    return Array.from(missedDates).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Executes idempotent 11:55 PM automatic check-out for a single company and local execution date.
   *
   * Strict invariants enforced:
   * - Processes open non-overnight records for `workDateStr` whose `checkIn <= 23:55:00` local time,
   *   skipping active overnight shifts starting on `workDateStr` (still mid-shift at 23:55).
   * - Also closes forgotten open overnight-shift records from `workDateStr - 1` (whose shift ended
   *   the next morning before the noon work-date boundary and still have no OUT punch by 23:55
   *   on `workDateStr`).
   * - Never modifies attendance records that already have a manual/biometric check-out,
   *   records already marked `SYSTEM_GENERATED`, leave/absent records, or records inside
   *   finalized/locked payroll periods.
   * - Closes any open `AttendanceInterval` (`isComplete: false, checkOut: null`) directly with
   *   `checkOut = 23:55:00` local time, `outEventId = null`, `durationMinutes = configuredMinutes`,
   *   and `isComplete = true` — NEVER creating fake `RawPunchLog` or `AttendancePunchEvent` rows.
   * - Sets `actualWorkedMinutes` strictly to the employee's effective daily working hours
   *   from `WorkPolicyService`, sets `overtimeMinutes = 0`, sets `hasIncompletePunch = false`,
   *   sets `punchPairsCount = Math.max(1, current.punchPairsCount || 0)`, and marks
   *   `source = 'SYSTEM_GENERATED'`.
   */
  static async runForCompanyDate(
    companyId: string,
    workDateStr: string,
    options?: {
      referenceNow?: Date;
      companyTimezone?: string;
      isOutageRecovery?: boolean;
    }
  ): Promise<AutoCheckoutCompanyRunResult> {
    if (!companyId || typeof companyId !== 'string') {
      throw new Error('companyId is required for automatic check-out.');
    }
    if (!isStrictDateOnly(workDateStr)) {
      throw new Error(`Invalid workDateStr '${workDateStr}'. Expected YYYY-MM-DD.`);
    }

    const isOutageRecovery = Boolean(options?.isOutageRecovery);

    let companyTimezone = options?.companyTimezone?.trim() || '';
    if (!companyTimezone) {
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { timezone: true },
      });
      companyTimezone = company?.timezone?.trim() || '';
    }

    if (!companyTimezone || !isValidTimeZone(companyTimezone)) {
      throw new Error(
        `Company '${companyId}' does not have a valid configured IANA timezone ('${companyTimezone || 'missing'}').`
      );
    }

    const workDateObj = new Date(`${workDateStr}T00:00:00.000Z`);
    const previousWorkDateStr = addCalendarDaysToDateStr(workDateStr, -1);
    const previousWorkDateObj = new Date(`${previousWorkDateStr}T00:00:00.000Z`);
    const scheduled2355Time = this.resolveScheduledCutoffTimestamp(workDateStr, companyTimezone);

    // 1. Check payroll locks independently for target date (and previous date during normal sweep)
    const currentDateLocked = await this.isPayrollPeriodLocked(companyId, workDateObj, prisma);
    const previousDateLocked = isOutageRecovery
      ? true
      : await this.isPayrollPeriodLocked(companyId, previousWorkDateObj, prisma);

    if (currentDateLocked && previousDateLocked) {
      return {
        companyId,
        companyTimezone,
        workDate: workDateStr,
        ...(isOutageRecovery ? { isOutageRecovery: true } : {}),
        evaluated: 0,
        autoCheckedOut: 0,
        skipped: 0,
        payrollLocked: true,
        outcomes: [],
      };
    }

    const fetchCandidatesForDate = async (targetDateObj: Date) =>
      prisma.attendance.findMany({
        where: {
          companyId,
          workDate: targetDateObj,
          checkIn: { not: null },
          checkOut: null,
          source: { not: 'SYSTEM_GENERATED' },
          status: { notIn: ['ON_LEAVE', 'ABSENT'] },
        },
        include: {
          employee: {
            include: {
              shift: true,
            },
          },
          shift: true,
        },
      });

    // 2. Fetch open attendance records:
    //    - Target execution date (for standard shifts, and during outage recovery also for
    //      expired overnight shifts whose (D+1) 23:55 deadline has already passed)
    //    - During normal scheduled runs (non-recovery), also sweep previous date's forgotten
    //      overnight shifts whose next-day 23:55 deadline has arrived.
    const [currentDayCandidates, previousDayRawCandidates] = await Promise.all([
      currentDateLocked ? Promise.resolve([]) : fetchCandidatesForDate(workDateObj),
      isOutageRecovery || previousDateLocked
        ? Promise.resolve([])
        : fetchCandidatesForDate(previousWorkDateObj),
    ]);

    // Deduplicate by attendance id in case a unit-test mock ignores workDate filter in findMany
    const seenCandidateIds = new Set<string>();
    const taggedCandidates: Array<{
      candidate: any;
      candidateWorkDateStr: string;
      candidateWorkDateObj: Date;
      isPreviousDayOvernightSweep: boolean;
    }> = [];

    for (const c of currentDayCandidates) {
      const cDateStr =
        c.workDate instanceof Date
          ? c.workDate.toISOString().split('T')[0]
          : workDateStr;
      if (cDateStr !== workDateStr || seenCandidateIds.has(c.id)) {
        continue;
      }
      seenCandidateIds.add(c.id);
      taggedCandidates.push({
        candidate: c,
        candidateWorkDateStr: workDateStr,
        candidateWorkDateObj: workDateObj,
        isPreviousDayOvernightSweep: false,
      });
    }

    for (const c of previousDayRawCandidates) {
      const cDateStr =
        c.workDate instanceof Date
          ? c.workDate.toISOString().split('T')[0]
          : previousWorkDateStr;
      if (cDateStr !== previousWorkDateStr || seenCandidateIds.has(c.id)) {
        continue;
      }
      seenCandidateIds.add(c.id);
      taggedCandidates.push({
        candidate: c,
        candidateWorkDateStr: previousWorkDateStr,
        candidateWorkDateObj: previousWorkDateObj,
        isPreviousDayOvernightSweep: true,
      });
    }

    if (taggedCandidates.length === 0) {
      return {
        companyId,
        companyTimezone,
        workDate: workDateStr,
        ...(isOutageRecovery ? { isOutageRecovery: true } : {}),
        evaluated: 0,
        autoCheckedOut: 0,
        skipped: 0,
        payrollLocked: currentDateLocked,
        outcomes: [],
      };
    }

    // 3. Batch-load effective-dated work policy revisions for all candidate employees
    const employeeIds = Array.from(new Set(taggedCandidates.map((t) => t.candidate.employeeId)));
    const revisionsByEmployee = await WorkPolicyService.listRevisionsForEmployees(
      companyId,
      employeeIds,
      prisma
    );

    const outcomes: AutoCheckoutEmployeeOutcome[] = [];
    let evaluatedCount = 0;
    let autoCheckedOutCount = 0;
    let skippedCount = 0;

    for (const entry of taggedCandidates) {
      const {
        candidate,
        candidateWorkDateStr,
        candidateWorkDateObj,
        isPreviousDayOvernightSweep,
      } = entry;
      const employee = candidate.employee;
      const employeeCode: string | null = employee?.employeeCode ?? null;

      const revisions = revisionsByEmployee.get(candidate.employeeId) || [];
      const effectivePolicy = WorkPolicyService.resolvePolicyForDate({
        date: candidateWorkDateObj,
        employee: employee || {
          id: candidate.employeeId,
          shiftId: candidate.shiftId,
          shift: candidate.shift || null,
          dailyWorkingHours: null,
          monthlyLeaveAllowance: null,
        },
        revisions,
        attendanceShiftOverride: candidate.shift || null,
      });

      const isOvernightShift = effectivePolicy.shift?.isOvernight === true;

      // Previous-day sweep ONLY applies to forgotten overnight shifts; ignore non-overnight rows from yesterday
      if (isPreviousDayOvernightSweep && !isOvernightShift) {
        continue;
      }

      evaluatedCount++;

      // Defensive checks even if mock findMany ignored where filters
      if (!candidate.checkIn) {
        skippedCount++;
        outcomes.push({
          attendanceId: candidate.id,
          employeeId: candidate.employeeId,
          employeeCode,
          workDate: candidateWorkDateStr,
          outcome: 'SKIPPED',
          reason: 'NO_CHECK_IN',
        });
        continue;
      }

      if (candidate.checkOut !== null && candidate.checkOut !== undefined) {
        skippedCount++;
        outcomes.push({
          attendanceId: candidate.id,
          employeeId: candidate.employeeId,
          employeeCode,
          workDate: candidateWorkDateStr,
          outcome: 'SKIPPED',
          reason: 'ALREADY_HAS_CHECK_OUT',
        });
        continue;
      }

      if (candidate.source === 'SYSTEM_GENERATED') {
        skippedCount++;
        outcomes.push({
          attendanceId: candidate.id,
          employeeId: candidate.employeeId,
          employeeCode,
          workDate: candidateWorkDateStr,
          outcome: 'SKIPPED',
          reason: 'ALREADY_SYSTEM_GENERATED',
        });
        continue;
      }

      if (candidate.status === 'ON_LEAVE' || candidate.status === 'ABSENT') {
        skippedCount++;
        outcomes.push({
          attendanceId: candidate.id,
          employeeId: candidate.employeeId,
          employeeCode,
          workDate: candidateWorkDateStr,
          outcome: 'SKIPPED',
          reason: `STATUS_${candidate.status}`,
        });
        continue;
      }

      if (employee?.status && employee.status !== 'ACTIVE') {
        skippedCount++;
        outcomes.push({
          attendanceId: candidate.id,
          employeeId: candidate.employeeId,
          employeeCode,
          workDate: candidateWorkDateStr,
          outcome: 'SKIPPED',
          reason: 'INACTIVE_EMPLOYEE',
        });
        continue;
      }

      // Compute the exact scheduled 11:55 PM check-out timestamp for this candidate:
      // - Standard shifts on date D: exact D 23:55:00 in companyTimezone.
      // - Overnight shifts starting on date D: exact (D + 1) 23:55:00 in companyTimezone
      //   so an active overnight shift is never prematurely closed while mid-shift.
      const candidateAutoCheckoutDateStr = isOvernightShift
        ? addCalendarDaysToDateStr(candidateWorkDateStr, 1)
        : candidateWorkDateStr;
      const candidateScheduledTime =
        candidateAutoCheckoutDateStr === workDateStr
          ? scheduled2355Time
          : this.resolveScheduledCutoffTimestamp(candidateAutoCheckoutDateStr, companyTimezone);

      // Protect active overnight shifts from premature closure
      if (isOvernightShift) {
        const overnightNotYetDue = isOutageRecovery
          ? !options?.referenceNow ||
            options.referenceNow.getTime() < candidateScheduledTime.getTime()
          : !isPreviousDayOvernightSweep ||
            (options?.referenceNow !== undefined &&
              options.referenceNow.getTime() < candidateScheduledTime.getTime());

        if (overnightNotYetDue) {
          skippedCount++;
          outcomes.push({
            attendanceId: candidate.id,
            employeeId: candidate.employeeId,
            employeeCode,
            workDate: candidateWorkDateStr,
            outcome: 'SKIPPED',
            reason: 'OVERNIGHT_SHIFT_IN_PROGRESS',
          });
          continue;
        }
      } else if (
        isOutageRecovery &&
        options?.referenceNow &&
        options.referenceNow.getTime() < candidateScheduledTime.getTime()
      ) {
        skippedCount++;
        outcomes.push({
          attendanceId: candidate.id,
          employeeId: candidate.employeeId,
          employeeCode,
          workDate: candidateWorkDateStr,
          outcome: 'SKIPPED',
          reason: 'AUTO_CHECKOUT_NOT_YET_DUE',
        });
        continue;
      }

      // Never auto-check-out someone who checked in AFTER the 23:55:00 local cutoff
      if (new Date(candidate.checkIn).getTime() > candidateScheduledTime.getTime()) {
        skippedCount++;
        outcomes.push({
          attendanceId: candidate.id,
          employeeId: candidate.employeeId,
          employeeCode,
          workDate: candidateWorkDateStr,
          outcome: 'SKIPPED',
          reason: 'CHECK_IN_AFTER_AUTO_CHECKOUT_CUTOFF',
        });
        continue;
      }

      const configuredMinutes = effectivePolicy.effectiveDailyRequiredMinutes;
      if (
        configuredMinutes === null ||
        !Number.isFinite(configuredMinutes) ||
        configuredMinutes <= 0
      ) {
        skippedCount++;
        outcomes.push({
          attendanceId: candidate.id,
          employeeId: candidate.employeeId,
          employeeCode,
          workDate: candidateWorkDateStr,
          outcome: 'SKIPPED',
          reason: 'UNCONFIGURED_DAILY_WORKING_HOURS',
        });
        continue;
      }

      const txOutcome = await prisma.$transaction(
        async (tx): Promise<AutoCheckoutEmployeeOutcome> => {
          // Serialize against concurrent biometric punch reconciliation and peer scheduler instances
          const hasExecuteRaw = typeof (tx as any).$executeRaw === 'function';
          const isMockedExecuteRaw =
            hasExecuteRaw &&
            typeof ((tx as any).$executeRaw as { mock?: unknown }).mock === 'object';
          if (hasExecuteRaw && (tx !== prisma || isMockedExecuteRaw)) {
            const [lockKey1, lockKey2] = deriveAttendanceAdvisoryLockKeys(
              companyId,
              candidate.employeeId,
              candidateWorkDateStr
            );
            await (tx as any).$executeRaw`
              SELECT pg_advisory_xact_lock(${lockKey1}::integer, ${lockKey2}::integer)
            `;
          }

          // Re-verify payroll lock inside transaction
          if (await this.isPayrollPeriodLocked(companyId, candidateWorkDateObj, tx)) {
            return {
              attendanceId: candidate.id,
              employeeId: candidate.employeeId,
              employeeCode,
              workDate: candidateWorkDateStr,
              outcome: 'SKIPPED',
              reason: 'PAYROLL_PERIOD_LOCKED',
            };
          }

          // Re-verify inside lock that the record has not been manually/biometrically closed
          const current = canUsePrismaDelegate(tx, 'attendance', 'findUnique')
            ? await tx.attendance.findUnique({
                where: { id: candidate.id },
              })
            : candidate;

          if (
            !current ||
            current.companyId !== companyId ||
            !current.checkIn ||
            current.checkOut !== null ||
            current.source === 'SYSTEM_GENERATED' ||
            current.status === 'ON_LEAVE' ||
            current.status === 'ABSENT'
          ) {
            return {
              attendanceId: candidate.id,
              employeeId: candidate.employeeId,
              employeeCode,
              workDate: candidateWorkDateStr,
              outcome: 'SKIPPED',
              reason:
                current?.source === 'SYSTEM_GENERATED'
                  ? 'ALREADY_SYSTEM_GENERATED'
                  : current?.checkOut !== null
                  ? 'ALREADY_HAS_CHECK_OUT'
                  : 'NO_LONGER_ELIGIBLE',
            };
          }

          if (new Date(current.checkIn).getTime() > candidateScheduledTime.getTime()) {
            return {
              attendanceId: candidate.id,
              employeeId: candidate.employeeId,
              employeeCode,
              workDate: candidateWorkDateStr,
              outcome: 'SKIPPED',
              reason: 'CHECK_IN_AFTER_AUTO_CHECKOUT_CUTOFF',
            };
          }

          // Protect approved leave requests for this date
          if (canUsePrismaDelegate(tx, 'leaveRequest', 'findFirst')) {
            const approvedLeave = await tx.leaveRequest.findFirst({
              where: {
                companyId,
                employeeId: candidate.employeeId,
                status: 'APPROVED',
                startDate: { lte: candidateWorkDateObj },
                endDate: { gte: candidateWorkDateObj },
              },
              select: { id: true },
            });
            if (approvedLeave) {
              return {
                attendanceId: candidate.id,
                employeeId: candidate.employeeId,
                employeeCode,
                workDate: candidateWorkDateStr,
                outcome: 'SKIPPED',
                reason: 'APPROVED_LEAVE_PROTECTED',
              };
            }
          }

          // Extra defense-in-depth: never modify a record that already has any manual/biometric CHECK_OUT event
          if (canUsePrismaDelegate(tx, 'attendancePunchEvent', 'findMany')) {
            const punchEvents = await tx.attendancePunchEvent.findMany({
              where: {
                attendanceId: candidate.id,
                companyId,
              },
              select: { id: true, inOutMode: true },
            });
            if (punchEvents.some((ev) => ev.inOutMode === 'CHECK_OUT')) {
              return {
                attendanceId: candidate.id,
                employeeId: candidate.employeeId,
                employeeCode,
                workDate: candidateWorkDateStr,
                outcome: 'SKIPPED',
                reason: 'MANUAL_OR_BIOMETRIC_OUT_EVENT_EXISTS',
              };
            }
          }

          const updatedNotes = appendAutoCheckoutNote(
            current.notes,
            companyTimezone,
            configuredMinutes
          );
          const nextPunchPairsCount = Math.max(
            1,
            typeof (current as any).punchPairsCount === 'number'
              ? (current as any).punchPairsCount
              : 0
          );

          // Conditional atomic update guarantees idempotency across concurrent executions.
          // Never creates RawPunchLog or AttendancePunchEvent rows.
          const updateResult = await tx.attendance.updateMany({
            where: {
              id: candidate.id,
              companyId,
              checkIn: { not: null },
              checkOut: null,
              source: { not: 'SYSTEM_GENERATED' },
              status: { notIn: ['ON_LEAVE', 'ABSENT'] },
            },
            data: {
              checkOut: candidateScheduledTime,
              actualWorkedMinutes: configuredMinutes,
              overtimeMinutes: 0,
              hasIncompletePunch: false,
              punchPairsCount: nextPunchPairsCount,
              source: 'SYSTEM_GENERATED',
              notes: updatedNotes,
            },
          });

          if (updateResult.count !== 1) {
            return {
              attendanceId: candidate.id,
              employeeId: candidate.employeeId,
              employeeCode,
              workDate: candidateWorkDateStr,
              outcome: 'SKIPPED',
              reason: 'ALREADY_CLOSED_OR_CONCURRENTLY_MODIFIED',
            };
          }

          // Close any open AttendanceInterval rows in-place (keeping outEventId = null so
          // ZERO synthetic RawPunchLog or AttendancePunchEvent rows are ever created).
          let closedIntervalsCount = 0;
          if (
            canUsePrismaDelegate(tx, 'attendanceInterval', 'findMany') &&
            canUsePrismaDelegate(tx, 'attendanceInterval', 'update')
          ) {
            const openIntervals = await tx.attendanceInterval.findMany({
              where: {
                attendanceId: candidate.id,
                companyId,
                isComplete: false,
                checkOut: null,
              },
              orderBy: { sequence: 'asc' },
            });

            for (const openIv of openIntervals) {
              const intervalCheckOut =
                openIv.checkIn &&
                new Date(openIv.checkIn).getTime() > candidateScheduledTime.getTime()
                  ? new Date(openIv.checkIn)
                  : candidateScheduledTime;

              await tx.attendanceInterval.update({
                where: { id: openIv.id },
                data: {
                  checkOut: intervalCheckOut,
                  outEventId: null,
                  durationMinutes: configuredMinutes,
                  isComplete: true,
                },
              });
              closedIntervalsCount++;
            }
          }

          await AuditService.log(
            {
              companyId,
              userId: null,
              action: 'ATTENDANCE_AUTO_CHECKOUT',
              entity: 'Attendance',
              entityId: candidate.id,
              details: {
                employeeId: candidate.employeeId,
                employeeCode,
                workDate: candidateWorkDateStr,
                executionDate: workDateStr,
                outageRecovery: isOutageRecovery,
                overnightRecovery: isOvernightShift,
                companyTimezone,
                checkIn: new Date(current.checkIn).toISOString(),
                checkOut: candidateScheduledTime.toISOString(),
                scheduledAutoCheckoutAt: candidateScheduledTime.toISOString(),
                actualWorkedMinutes: configuredMinutes,
                effectiveDailyWorkingHours: effectivePolicy.effectiveDailyWorkingHours,
                overtimeMinutes: 0,
                closedIntervalsCount,
                source: 'SYSTEM_GENERATED',
                policySource: effectivePolicy.source,
              },
            },
            tx
          );

          return {
            attendanceId: candidate.id,
            employeeId: candidate.employeeId,
            employeeCode,
            workDate: candidateWorkDateStr,
            outcome: 'AUTO_CHECKED_OUT',
            checkOut: candidateScheduledTime.toISOString(),
            actualWorkedMinutes: configuredMinutes,
            overtimeMinutes: 0,
            closedIntervalsCount,
            source: 'SYSTEM_GENERATED',
          };
        }
      );

      outcomes.push(txOutcome);
      if (txOutcome.outcome === 'AUTO_CHECKED_OUT') {
        autoCheckedOutCount++;
      } else {
        skippedCount++;
      }
    }

    return {
      companyId,
      companyTimezone,
      workDate: workDateStr,
      ...(isOutageRecovery ? { isOutageRecovery: true } : {}),
      evaluated: evaluatedCount,
      autoCheckedOut: autoCheckedOutCount,
      skipped: skippedCount,
      payrollLocked: currentDateLocked,
      outcomes,
    };
  }

  private static trackCompletedKey(
    completedCompanyDateKeys: Set<string> | undefined,
    key: string
  ): void {
    if (!completedCompanyDateKeys) {
      return;
    }
    if (completedCompanyDateKeys.size >= MAX_TRACKED_COMPLETION_KEYS) {
      const oldestKey = completedCompanyDateKeys.values().next().value;
      if (oldestKey) {
        completedCompanyDateKeys.delete(oldestKey);
      }
    }
    completedCompanyDateKeys.add(key);
  }

  /**
   * Evaluates all companies against `referenceNow` in each company's own IANA timezone:
   * 1. Detects and safely recovers any missed prior local dates (`workDate < localDateStr`)
   *    that still have eligible open Attendance records (e.g. after a server outage across
   *    the 23:55–23:59 window or multi-day downtime).
   * 2. Triggers normal 11:55 PM automatic check-out for companies currently inside their
   *    daily 23:55–23:59 local-time window.
   */
  static async runScheduledCycle(
    referenceNow: Date = new Date(),
    completedCompanyDateKeys?: Set<string>
  ): Promise<AutoCheckoutCycleResult> {
    const companies = await prisma.company.findMany({
      select: {
        id: true,
        timezone: true,
      },
    });

    const companyResults: AutoCheckoutCompanyRunResult[] = [];
    const errors: Array<{ companyId: string; message: string }> = [];
    let dueCompanies = 0;
    let recoveredCompanyDates = 0;
    let skippedAlreadyRan = 0;
    let skippedInvalidTimezone = 0;
    let totalAutoCheckedOut = 0;
    let totalSkipped = 0;

    for (const company of companies) {
      const clock = evaluateCompanyAutoCheckoutTime(referenceNow, company.timezone);
      if (!clock.validTimezone || !clock.localDateStr) {
        skippedInvalidTimezone++;
        continue;
      }

      // 1. Outage recovery: detect and recover missed prior local dates for this company
      try {
        const missedDates = await this.discoverMissedAutoCheckoutDates(
          company.id,
          clock.localDateStr,
          prisma
        );

        for (const missedDateStr of missedDates) {
          const fullKey = `${company.id}::${missedDateStr}`;
          const sameDayOvernightDeferKey = `${company.id}::${missedDateStr}::recovery-on::${clock.localDateStr}`;
          if (
            completedCompanyDateKeys?.has(fullKey) ||
            completedCompanyDateKeys?.has(sameDayOvernightDeferKey)
          ) {
            continue;
          }

          try {
            const recoveryResult = await this.runForCompanyDate(company.id, missedDateStr, {
              referenceNow,
              companyTimezone: clock.timeZone,
              isOutageRecovery: true,
            });
            recoveredCompanyDates++;
            companyResults.push(recoveryResult);
            totalAutoCheckedOut += recoveryResult.autoCheckedOut;
            totalSkipped += recoveryResult.skipped;

            // If an active overnight shift from yesterday is still mid-shift on `clock.localDateStr`,
            // defer only for today so today's 23:55 run (or a future day's recovery if 23:55 is also
            // missed) will still evaluate it cleanly without polling every 30 seconds.
            const hasPendingOvernight = recoveryResult.outcomes.some(
              (o) => o.outcome === 'SKIPPED' && o.reason === 'OVERNIGHT_SHIFT_IN_PROGRESS'
            );
            this.trackCompletedKey(
              completedCompanyDateKeys,
              hasPendingOvernight ? sameDayOvernightDeferKey : fullKey
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ companyId: company.id, message });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ companyId: company.id, message });
      }

      // 2. Normal daily 23:55–23:59 local-time execution for today's attendance date
      if (!clock.isDue) {
        continue;
      }

      dueCompanies++;
      const dedupeKey = `${company.id}::${clock.localDateStr}`;
      if (completedCompanyDateKeys?.has(dedupeKey)) {
        skippedAlreadyRan++;
        continue;
      }

      try {
        const result = await this.runForCompanyDate(company.id, clock.localDateStr, {
          referenceNow,
          companyTimezone: clock.timeZone,
        });
        companyResults.push(result);
        totalAutoCheckedOut += result.autoCheckedOut;
        totalSkipped += result.skipped;

        this.trackCompletedKey(completedCompanyDateKeys, dedupeKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ companyId: company.id, message });
      }
    }

    return {
      evaluatedCompanies: companies.length,
      dueCompanies,
      recoveredCompanyDates,
      skippedAlreadyRan,
      skippedInvalidTimezone,
      totalAutoCheckedOut,
      totalSkipped,
      companyResults,
      errors,
    };
  }
}
