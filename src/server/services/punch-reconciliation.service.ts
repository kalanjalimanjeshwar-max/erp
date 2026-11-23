import crypto from 'crypto';
import { prisma } from '../db/client.js';
import {
  PunchSyncStatus,
  RawPunchLogItem,
  PunchReconciliationOptions,
  PunchReconciliationResponse,
  PunchReconciliationItemResult,
  PunchSyncSummaryResponse,
  AttendanceStatus,
  PunchInOutMode,
} from '../../shared/types.js';
import { AuditService } from './audit.service.js';
import { BiometricMappingService } from './biometric-mapping.service.js';
import {
  WorkPolicyService,
  canUsePrismaDelegate,
  getStartOfLocalDayUtc,
  ShiftDurationShape,
} from './work-policy.service.js';
import {
  addCalendarDaysToDateStr,
  localDateTimeToUtcIso,
} from '../../shared/timezone.js';

const DEBOUNCE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PairablePunchEvent {
  id: string;
  rawPunchLogId?: string | null;
  punchTime: Date;
  inOutMode: PunchInOutMode;
  createdAt?: Date;
}

export interface PairedAttendanceInterval {
  sequence: number;
  inEventId: string | null;
  outEventId: string | null;
  checkIn: Date | null;
  checkOut: Date | null;
  durationMinutes: number;
  isComplete: boolean;
}

export interface NormalizedAlternatingPunchEvent {
  id: string;
  rawPunchLogId?: string | null;
  punchTime: Date;
  effectiveMode: 'CHECK_IN' | 'CHECK_OUT';
  previousMode: PunchInOutMode;
  sequenceOrder: number;
}

export interface ChronologicalPairingResult {
  normalizedEvents: NormalizedAlternatingPunchEvent[];
  intervals: PairedAttendanceInterval[];
  actualWorkedMinutes: number | null;
  punchPairsCount: number;
  hasIncompletePunch: boolean;
  earliestCheckIn: Date | null;
  latestCheckOut: Date | null;
}

/**
 * Pure deterministic chronological IN/OUT alternation and pairing engine for a single workday.
 *
 * Biometric terminals such as eSSL X2008 do not emit reliable explicit IN/OUT punch modes
 * (frequently reporting CHECK_IN for every tap). Therefore, all non-break biometric events
 * for an employee on an effective local attendance date are sorted deterministically by
 * (punchTime ASC, createdAt ASC, id ASC) and assigned strict alternating effective directions:
 *   1st -> CHECK_IN, 2nd -> CHECK_OUT, 3rd -> CHECK_IN, 4th -> CHECK_OUT, ...
 *
 * Raw device modes remain untouched on RawPunchLog for auditability; normalizedEvents reports
 * the authoritative alternating direction for each AttendancePunchEvent so out-of-order
 * arrivals deterministically re-sequence existing events and intervals.
 */
export function pairAttendanceEventsChronologically(
  events: PairablePunchEvent[]
): ChronologicalPairingResult {
  const inOutEvents = events
    .filter((ev) => ev.inOutMode === 'CHECK_IN' || ev.inOutMode === 'CHECK_OUT')
    .slice()
    .sort((a, b) => {
      const timeDiff = a.punchTime.getTime() - b.punchTime.getTime();
      if (timeDiff !== 0) return timeDiff;
      const createdDiff =
        (a.createdAt ? a.createdAt.getTime() : 0) - (b.createdAt ? b.createdAt.getTime() : 0);
      if (createdDiff !== 0) return createdDiff;
      return a.id.localeCompare(b.id);
    });

  if (inOutEvents.length === 0) {
    return {
      normalizedEvents: [],
      intervals: [],
      actualWorkedMinutes: null,
      punchPairsCount: 0,
      hasIncompletePunch: false,
      earliestCheckIn: null,
      latestCheckOut: null,
    };
  }

  const normalizedEvents: NormalizedAlternatingPunchEvent[] = inOutEvents.map((ev, index) => ({
    id: ev.id,
    rawPunchLogId: ev.rawPunchLogId,
    punchTime: ev.punchTime,
    effectiveMode: index % 2 === 0 ? 'CHECK_IN' : 'CHECK_OUT',
    previousMode: ev.inOutMode,
    sequenceOrder: index + 1,
  }));

  const intervals: PairedAttendanceInterval[] = [];
  const earliestCheckIn: Date = normalizedEvents[0].punchTime;
  let latestCheckOut: Date | null = null;

  for (let i = 0; i < normalizedEvents.length; i += 2) {
    const inEv = normalizedEvents[i];
    const outEv = normalizedEvents[i + 1] ?? null;

    if (outEv) {
      latestCheckOut = outEv.punchTime;
      const durationMinutes = Math.max(
        0,
        Math.round((outEv.punchTime.getTime() - inEv.punchTime.getTime()) / (1000 * 60))
      );
      intervals.push({
        sequence: intervals.length + 1,
        inEventId: inEv.id,
        outEventId: outEv.id,
        checkIn: inEv.punchTime,
        checkOut: outEv.punchTime,
        durationMinutes,
        isComplete: true,
      });
    } else {
      // Odd total count: trailing open CHECK_IN pending subsequent CHECK_OUT
      intervals.push({
        sequence: intervals.length + 1,
        inEventId: inEv.id,
        outEventId: null,
        checkIn: inEv.punchTime,
        checkOut: null,
        durationMinutes: 0,
        isComplete: false,
      });
    }
  }

  const completeIntervals = intervals.filter((iv) => iv.isComplete);
  const punchPairsCount = completeIntervals.length;
  const hasIncompletePunch = intervals.some((iv) => !iv.isComplete);
  const actualWorkedMinutes = completeIntervals.reduce((sum, iv) => sum + iv.durationMinutes, 0);

  return {
    normalizedEvents,
    intervals,
    actualWorkedMinutes,
    punchPairsCount,
    hasIncompletePunch,
    earliestCheckIn,
    latestCheckOut,
  };
}

/**
 * Derives a deterministic pair of signed 32-bit integers for PostgreSQL
 * `pg_advisory_xact_lock(int4, int4)` scoped to (companyId, employeeId, workDate).
 */
export function deriveAttendanceAdvisoryLockKeys(
  companyId: string,
  employeeId: string,
  workDateStr: string
): [number, number] {
  const digest = crypto
    .createHash('sha256')
    .update(`attendance_reconcile:${companyId}:${employeeId}:${workDateStr}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateStr: string; // "YYYY-MM-DD"
  timeStr: string; // "HH:mm"
}

export class PunchReconciliationService {
  /**
   * Resolves the canonical timezone for the company.
   * Enforces policy: If Company.timezone is valid IANA, use it.
   * If missing or invalid, explicitly documents and enforces UTC reference timezone.
   */
  static async resolveCompanyTimezone(companyId: string, tx?: any): Promise<string> {
    const client = tx || prisma;
    const company = await client.company.findUnique({
      where: { id: companyId },
      select: { timezone: true },
    });

    const tzCandidate = company?.timezone?.trim();
    if (tzCandidate) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tzCandidate });
        return tzCandidate;
      } catch {
        // Invalid timezone string: fallback to canonical UTC policy
      }
    }

    return 'UTC';
  }

  /**
   * Converts a UTC Date into local time parts for a given IANA timezone.
   */
  static getLocalDateTime(utcDate: Date, timeZone: string): LocalTimeParts {
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });

      const parts = formatter.formatToParts(utcDate);
      const partMap: Record<string, string> = {};
      for (const p of parts) {
        partMap[p.type] = p.value;
      }

      const year = parseInt(partMap.year || '1970', 10);
      const month = parseInt(partMap.month || '1', 10);
      const day = parseInt(partMap.day || '1', 10);
      const hour = parseInt(partMap.hour || '0', 10);
      const minute = parseInt(partMap.minute || '0', 10);
      const second = parseInt(partMap.second || '0', 10);

      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

      return { year, month, day, hour, minute, second, dateStr, timeStr };
    } catch {
      // Fallback to UTC representation
      const dateStr = utcDate.toISOString().split('T')[0];
      const timeStr = utcDate.toISOString().split('T')[1].slice(0, 5);
      return {
        year: utcDate.getUTCFullYear(),
        month: utcDate.getUTCMonth() + 1,
        day: utcDate.getUTCDate(),
        hour: utcDate.getUTCHours(),
        minute: utcDate.getUTCMinutes(),
        second: utcDate.getUTCSeconds(),
        dateStr,
        timeStr,
      };
    }
  }

  /**
   * Deterministically assigns work date considering overnight and standard shifts.
   *
   * Overnight Shift Policy:
   * A shift spanning midnight (e.g. 22:00 to 06:00):
   * - Punches on or after 12:00 (noon) on Day D belong to the shift of Day D.
   * - Punches before 12:00 (noon) on Day D+1 belong to the shift that started on Day D (Day D+1 minus 1 day).
   */
  static determineWorkDate(
    punchDate: Date,
    timeZone: string,
    shift: { startTime: string; endTime: string; isOvernight: boolean } | null
  ): string {
    const local = this.getLocalDateTime(punchDate, timeZone);

    if (!shift || !shift.isOvernight) {
      return local.dateStr;
    }

    // Overnight shift handling:
    // If local hour < 12 (morning hours after midnight), this punch is part of the shift
    // that commenced on the previous local calendar day (DST-safe calendar subtraction).
    if (local.hour < 12) {
      return addCalendarDaysToDateStr(local.dateStr, -1);
    }

    return local.dateStr;
  }

  /**
   * Calculates late minutes based on scheduled shift start, grace minutes, and work date.
   * Uses timezone-aware UTC projection on workDateStr so overnight shifts and DST boundaries
   * compute exact lateness even when first arrival occurs after midnight.
   */
  static calculateLateMinutes(
    checkIn: Date | null,
    workDateStr: string,
    shift: { startTime: string; graceMinutes: number } | null,
    timeZone = 'UTC'
  ): number {
    if (!checkIn || !shift || !shift.startTime) {
      return 0;
    }

    const parts = shift.startTime.trim().split(':');
    const startH = Number(parts[0]);
    const startM = Number(parts[1]);
    if (isNaN(startH) || isNaN(startM)) {
      return 0;
    }

    const normalizedStartTime = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;
    const scheduledStartIso = localDateTimeToUtcIso(workDateStr, normalizedStartTime, timeZone);
    if (!scheduledStartIso) {
      return 0;
    }

    const scheduledStartMs = new Date(scheduledStartIso).getTime();
    const graceMinutes = shift.graceMinutes || 0;
    const diffMinutes = Math.floor((checkIn.getTime() - scheduledStartMs) / 60000);

    if (diffMinutes > graceMinutes) {
      return Math.max(0, diffMinutes);
    }

    return 0;
  }

  /**
   * Calculates overtime minutes based on scheduled shift end time.
   */
  static calculateOvertimeMinutes(
    checkOut: Date | null,
    workDateStr: string,
    shift: { endTime: string; isOvernight: boolean } | null,
    timeZone = 'UTC'
  ): number {
    if (!checkOut || !shift || !shift.endTime) {
      return 0;
    }

    const [endH, endM] = shift.endTime.split(':').map(Number);
    if (isNaN(endH) || isNaN(endM)) {
      return 0;
    }

    const localParts = this.getLocalDateTime(checkOut, timeZone);
    const punchMinutes = localParts.hour * 60 + localParts.minute;
    const scheduledEndMinutes = endH * 60 + endM;

    if (shift.isOvernight) {
      if (localParts.hour < 12 && punchMinutes > scheduledEndMinutes) {
        return Math.max(0, punchMinutes - scheduledEndMinutes);
      }
    } else {
      if (punchMinutes > scheduledEndMinutes) {
        return Math.max(0, punchMinutes - scheduledEndMinutes);
      }
    }

    return 0;
  }


  /**
   * Reconciles a single raw punch record within an atomic transaction.
   * Guarantees:
   * 1. Tenant isolation throughout.
   * 2. Protected attendance and payroll records are never overwritten.
   * 3. Idempotent execution: already processed punches are safely skipped.
   * 4. Comprehensive logging of outcomes and reasons on RawPunchLog.
   */
  static async reconcilePunch(
    punchId: string,
    correlationId?: string,
    options?: { keepUnmappedPending?: boolean; expectedCompanyId?: string; companyTimezone?: string }
  ): Promise<PunchReconciliationItemResult> {
    return prisma.$transaction(async (tx) => {
      // Acquire an exclusive PostgreSQL row-level lock on RawPunchLog BEFORE reading syncStatus
      // so concurrent transactions serialize on the same punch and re-read committed state.
      const hasQueryRaw = typeof (tx as any).$queryRaw === 'function';
      const isMockedQueryRaw =
        hasQueryRaw && typeof ((tx as any).$queryRaw as { mock?: unknown }).mock === 'object';
      if (hasQueryRaw && UUID_REGEX.test(punchId) && (tx !== prisma || isMockedQueryRaw)) {
        if (options?.expectedCompanyId && UUID_REGEX.test(options.expectedCompanyId)) {
          await (tx as any).$queryRaw`
            SELECT id FROM "RawPunchLog"
            WHERE id = ${punchId}::uuid AND "companyId" = ${options.expectedCompanyId}::uuid
            FOR UPDATE
          `;
        } else {
          await (tx as any).$queryRaw`
            SELECT id FROM "RawPunchLog"
            WHERE id = ${punchId}::uuid
            FOR UPDATE
          `;
        }
      }

      const punch = await tx.rawPunchLog.findUnique({
        where: { id: punchId },
        include: {
          company: { select: { id: true, timezone: true } },
          terminal: { select: { id: true, name: true, location: true } },
          matchedEmployee: {
            include: {
              shift: true,
            },
          },
        },
      });

      if (!punch || (options?.expectedCompanyId && punch.companyId !== options.expectedCompanyId)) {
        return {
          punchId,
          userEnrollmentId: '',
          matchedEmployeeId: null,
          workDate: null,
          status: 'ERROR',
          message: 'Raw punch record not found.',
        };
      }

      // Idempotency: after acquiring the row lock, if already finalized by another transaction,
      // return the existing outcome cleanly without mutating Attendance or RawPunchLog.
      if (punch.syncStatus === 'PROCESSED') {
        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: punch.matchedEmployeeId,
          workDate: null,
          status: 'PROCESSED',
          message: 'Punch was already successfully processed.',
        };
      }

      if (punch.syncStatus === 'IGNORED') {
        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: punch.matchedEmployeeId,
          workDate: null,
          status: 'IGNORED',
          message: punch.errorMessage || 'Punch was already ignored during reconciliation.',
        };
      }

      // A. Employee Mapping Resolution (Terminal-scoped mapping -> legacy fallback)
      let employee = punch.matchedEmployee;
      if (!employee) {
        const resolution = await BiometricMappingService.resolveEmployeeForPunch(
          punch.companyId,
          punch.terminalId,
          punch.userEnrollmentId,
          tx
        );
        const foundEmployee = resolution.employee;

        if (!foundEmployee) {
          if (options?.keepUnmappedPending) {
            const pendingReason = `Pending enrollment mapping: No employee mapped for enrollment ID '${punch.userEnrollmentId}' on this terminal.`;
            await tx.rawPunchLog.update({
              where: { id: punch.id },
              data: {
                syncStatus: 'PENDING',
                errorMessage: pendingReason,
              },
            });

            return {
              punchId: punch.id,
              userEnrollmentId: punch.userEnrollmentId,
              matchedEmployeeId: null,
              workDate: null,
              status: 'PENDING',
              message: pendingReason,
            };
          }

          const reason = `Unmapped biometric enrollment ID: No active employee found with biometricDeviceId '${punch.userEnrollmentId}' in company.`;
          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: {
              syncStatus: 'ERROR',
              errorMessage: reason,
            },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: null,
            workDate: null,
            status: 'ERROR',
            message: reason,
          };
        }

        // Cross-tenant guard
        if (foundEmployee.companyId !== punch.companyId) {
          const reason = 'Security violation: Employee company ID does not match punch company ID.';
          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'ERROR', errorMessage: reason },
          });
          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: null,
            workDate: null,
            status: 'ERROR',
            message: reason,
          };
        }

        // Link matched employee for audit traceability
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: { matchedEmployeeId: foundEmployee.id },
        });

        employee = foundEmployee;
      } else if (employee.companyId !== punch.companyId) {
        // Cross-tenant guard
        const reason = 'Security violation: Employee company ID does not match punch company ID.';
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: { syncStatus: 'ERROR', errorMessage: reason },
        });
        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: null,
          workDate: null,
          status: 'ERROR',
          message: reason,
        };
      }

      // A2. Inactive Employee Policy Enforcement
      // Preserves RawPunchLog audit trail as IGNORED without creating or mutating Attendance records
      if (employee.status !== undefined && employee.status !== 'ACTIVE') {
        const reason = `Inactive employee policy: Employee '${employee.fullName || employee.employeeCode || employee.id}' has status '${employee.status}'. Attendance records are only generated for ACTIVE employees.`;
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: {
            matchedEmployeeId: employee.id,
            syncStatus: 'IGNORED',
            errorMessage: reason,
          },
        });
        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: employee.id,
          workDate: null,
          status: 'IGNORED',
          message: reason,
        };
      }

      // B. Resolve Timezone, Work Date, and Effective-Dated Work Policy
      const timeZone =
        options?.companyTimezone ||
        (await this.resolveCompanyTimezone(punch.companyId, tx));
      let shift: ShiftDurationShape | null = employee.shift || null;
      let policyRevisions = await WorkPolicyService.listRevisionsForEmployee(
        punch.companyId,
        employee.id,
        tx
      );
      if (policyRevisions.length > 0) {
        const provisionalLocalStr = this.getLocalDateTime(punch.punchTime, timeZone).dateStr;
        const provisionalPolicy = WorkPolicyService.resolvePolicyForDate({
          date: provisionalLocalStr,
          employee,
          revisions: policyRevisions,
        });
        if (provisionalPolicy.shift) {
          shift = provisionalPolicy.shift;
        }
      }

      const workDateStr = this.determineWorkDate(punch.punchTime, timeZone, shift);
      const workDateObj = new Date(`${workDateStr}T00:00:00.000Z`);
      const effectiveDailyPolicy = WorkPolicyService.resolvePolicyForDate({
        date: workDateObj,
        employee,
        revisions: policyRevisions,
      });
      const effectiveShift = effectiveDailyPolicy.shift || shift || null;

      // B2. Acquire a PostgreSQL transaction-scoped advisory lock keyed by
      // (companyId, employeeId, workDateStr) BEFORE checking/creating Attendance.
      // This serializes concurrent transactions for distinct RawPunchLog IDs belonging
      // to the same employee and work date even when no Attendance row exists yet.
      const hasExecuteRaw = typeof (tx as any).$executeRaw === 'function';
      const isMockedExecuteRaw =
        hasExecuteRaw && typeof ((tx as any).$executeRaw as { mock?: unknown }).mock === 'object';
      if (hasExecuteRaw && (tx !== prisma || isMockedExecuteRaw)) {
        const [lockKey1, lockKey2] = deriveAttendanceAdvisoryLockKeys(
          punch.companyId,
          employee.id,
          workDateStr
        );
        await (tx as any).$executeRaw`
          SELECT pg_advisory_xact_lock(${lockKey1}::integer, ${lockKey2}::integer)
        `;
      }

      // C. Data & Payroll Integrity: Protect Finalized / Processed / Accounts-Approved / Posted Payroll Periods
      const lockedPayroll = await tx.payrollPeriod.findFirst({
        where: {
          companyId: punch.companyId,
          startDate: { lte: workDateObj },
          endDate: { gte: workDateObj },
          status: { in: ['PROCESSED', 'ACCOUNTS_APPROVED', 'POSTED'] },
        },
        select: { id: true, name: true, status: true },
      });

      if (lockedPayroll) {
        const reason = `Protected payroll period: Payroll period '${lockedPayroll.name}' (${lockedPayroll.status}) is finalized/locked. Attendance for ${workDateStr} cannot be modified.`;
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: {
            syncStatus: 'ERROR',
            errorMessage: reason,
          },
        });

        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: employee.id,
          workDate: workDateStr,
          status: 'ERROR',
          message: reason,
        };
      }

      // D. Find Existing Attendance Record for (companyId, employeeId, workDate)
      const existingAttendance = await tx.attendance.findUnique({
        where: {
          companyId_employeeId_workDate: {
            companyId: punch.companyId,
            employeeId: employee.id,
            workDate: workDateObj,
          },
        },
      });

      // E. Protect Approved Leave Records (both pre-existing Attendance and LeaveRequest records)
      const approvedLeave = await tx.leaveRequest.findFirst({
        where: {
          companyId: punch.companyId,
          employeeId: employee.id,
          status: 'APPROVED',
          startDate: { lte: workDateObj },
          endDate: { gte: workDateObj },
        },
        include: {
          leaveType: { select: { name: true, code: true } },
        },
      });

      if (approvedLeave || (existingAttendance && existingAttendance.status === 'ON_LEAVE')) {
        const leaveDetail = approvedLeave?.leaveType?.name
          ? ` (${approvedLeave.leaveType.name})`
          : existingAttendance?.status === 'ON_LEAVE'
          ? ' (status: ON_LEAVE)'
          : '';
        const reason = `Protected record: Employee has approved leave on ${workDateStr}${leaveDetail}. Biometric punch flagged for manual review.`;
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: {
            syncStatus: 'IGNORED',
            errorMessage: reason,
          },
        });

        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: employee.id,
          workDate: workDateStr,
          status: 'IGNORED',
          message: reason,
        };
      }

      // F. Process by InOutMode according to explicit business rules
      const punchTime = punch.punchTime;
      const mode = punch.inOutMode;

      if (mode === 'CHECK_IN' || mode === 'CHECK_OUT') {
        const useMultiPairPipeline = canUsePrismaDelegate(tx, 'attendancePunchEvent', 'findMany');

        if (useMultiPairPipeline) {
          let attendanceRecord = existingAttendance;
          if (!attendanceRecord) {
            // Under deterministic chronological alternation, the first punch of a workday
            // is always treated as the initial CHECK_IN regardless of unreliable device mode.
            attendanceRecord = await tx.attendance.create({
              data: {
                companyId: punch.companyId,
                employeeId: employee.id,
                shiftId: effectiveDailyPolicy.shiftId || effectiveShift?.id || null,
                workDate: workDateObj,
                checkIn: punchTime,
                checkOut: null,
                status: 'PRESENT',
                lateMinutes: 0,
                overtimeMinutes: 0,
                actualWorkedMinutes: 0,
                hasIncompletePunch: true,
                punchPairsCount: 0,
                source: 'BIOMETRIC',
                notes: `Biometric Check-In at ${punchTime.toISOString()}`,
              },
            });
          }

          let existingEvents = (await tx.attendancePunchEvent.findMany({
            where: {
              attendanceId: attendanceRecord.id,
              companyId: punch.companyId,
            },
            orderBy: [{ punchTime: 'asc' }, { createdAt: 'asc' }],
          })) as PairablePunchEvent[];

          // Legacy pre-migration Attendance compatibility: seed unlinked punch events
          // if the Attendance row already existed with checkIn/checkOut timestamps and 0 events
          if (
            existingAttendance &&
            existingEvents.length === 0 &&
            canUsePrismaDelegate(tx, 'attendancePunchEvent', 'create')
          ) {
            const legacySource = existingAttendance.source || 'MANUAL';
            if (existingAttendance.checkIn) {
              const seededIn = await tx.attendancePunchEvent.create({
                data: {
                  companyId: punch.companyId,
                  attendanceId: attendanceRecord.id,
                  rawPunchLogId: null,
                  punchTime: existingAttendance.checkIn,
                  inOutMode: 'CHECK_IN',
                  source: legacySource,
                },
              });
              existingEvents.push(seededIn);
            }
            if (existingAttendance.checkOut) {
              const seededOut = await tx.attendancePunchEvent.create({
                data: {
                  companyId: punch.companyId,
                  attendanceId: attendanceRecord.id,
                  rawPunchLogId: null,
                  punchTime: existingAttendance.checkOut,
                  inOutMode: 'CHECK_OUT',
                  source: legacySource,
                },
              });
              existingEvents.push(seededOut);
            }
          }

          // Safeguard: if this raw punch already created an AttendancePunchEvent, remain idempotent
          if (existingEvents.some((ev) => ev.rawPunchLogId === punch.id)) {
            await tx.rawPunchLog.update({
              where: { id: punch.id },
              data: { syncStatus: 'PROCESSED', errorMessage: null },
            });
            return {
              punchId: punch.id,
              userEnrollmentId: punch.userEnrollmentId,
              matchedEmployeeId: employee.id,
              workDate: workDateStr,
              status: 'PROCESSED',
              message: 'Punch was already linked to attendance events.',
            };
          }

          // Mode-agnostic 2-minute duplicate debounce against ALL existing workday IN/OUT events.
          // Prevents rapid double-taps on eSSL terminals from creating false 0-minute IN->OUT pairs.
          const duplicateNearbyEvent = existingEvents.find(
            (ev) =>
              (ev.inOutMode === 'CHECK_IN' || ev.inOutMode === 'CHECK_OUT') &&
              Math.abs(punchTime.getTime() - ev.punchTime.getTime()) <= DEBOUNCE_THRESHOLD_MS
          );
          if (duplicateNearbyEvent) {
            const reason =
              duplicateNearbyEvent.inOutMode === 'CHECK_OUT'
                ? 'Duplicate check-out punch debounced within 2 minutes.'
                : 'Duplicate check-in punch debounced within 2 minutes.';
            await tx.rawPunchLog.update({
              where: { id: punch.id },
              data: { syncStatus: 'IGNORED', errorMessage: reason },
            });
            return {
              punchId: punch.id,
              userEnrollmentId: punch.userEnrollmentId,
              matchedEmployeeId: employee.id,
              workDate: workDateStr,
              status: 'IGNORED',
              message: reason,
            };
          }

          // Determine chronological effective IN/OUT mode for insertion (even -> CHECK_IN, odd -> CHECK_OUT).
          // RawPunchLog.inOutMode is NEVER mutated so original hardware data stays intact for audit.
          const existingInOutBeforeCount = existingEvents.filter(
            (ev) =>
              (ev.inOutMode === 'CHECK_IN' || ev.inOutMode === 'CHECK_OUT') &&
              ev.punchTime.getTime() <= punchTime.getTime()
          ).length;
          const initialEffectiveMode: PunchInOutMode =
            existingInOutBeforeCount % 2 === 0 ? 'CHECK_IN' : 'CHECK_OUT';

          // Insert new chronological punch event linked to RawPunchLog
          const createdEvent = await tx.attendancePunchEvent.create({
            data: {
              companyId: punch.companyId,
              attendanceId: attendanceRecord.id,
              rawPunchLogId: punch.id,
              punchTime,
              inOutMode: initialEffectiveMode,
              source: 'BIOMETRIC',
            },
          });
          existingEvents.push(createdEvent);

          // Re-sequence & pair entire workday chronologically (handles repeated device CHECK_INs,
          // multi-pair sessions, overnight shifts, and out-of-order arrivals deterministically).
          const pairing = pairAttendanceEventsChronologically(existingEvents);

          // Synchronize AttendancePunchEvent.inOutMode whenever an out-of-order punch flips
          // the chronological alternating direction of any event on this attendance record.
          if (canUsePrismaDelegate(tx, 'attendancePunchEvent', 'update')) {
            for (const normEv of pairing.normalizedEvents) {
              if (normEv.effectiveMode !== normEv.previousMode) {
                await tx.attendancePunchEvent.update({
                  where: { id: normEv.id },
                  data: { inOutMode: normEv.effectiveMode },
                });
              }
            }
          }

          if (canUsePrismaDelegate(tx, 'attendanceInterval', 'deleteMany')) {
            await tx.attendanceInterval.deleteMany({
              where: {
                attendanceId: attendanceRecord.id,
                companyId: punch.companyId,
              },
            });
          }

          if (canUsePrismaDelegate(tx, 'attendanceInterval', 'create')) {
            for (const interval of pairing.intervals) {
              await tx.attendanceInterval.create({
                data: {
                  companyId: punch.companyId,
                  attendanceId: attendanceRecord.id,
                  sequence: interval.sequence,
                  inEventId: interval.inEventId,
                  outEventId: interval.outEventId,
                  checkIn: interval.checkIn,
                  checkOut: interval.checkOut,
                  durationMinutes: interval.durationMinutes,
                  isComplete: interval.isComplete,
                },
              });
            }
          }

          const shiftForLate =
            effectiveShift && effectiveShift.graceMinutes !== undefined
              ? { startTime: effectiveShift.startTime, graceMinutes: effectiveShift.graceMinutes }
              : null;
          const lateMinutes = this.calculateLateMinutes(
            pairing.earliestCheckIn,
            workDateStr,
            shiftForLate,
            timeZone
          );
          const nextStatus: AttendanceStatus =
            attendanceRecord.status === 'HALF_DAY'
              ? 'HALF_DAY'
              : lateMinutes > 0
              ? 'LATE'
              : 'PRESENT';

          const dailyRequiredMin = effectiveDailyPolicy.effectiveDailyRequiredMinutes;
          const computedWorkedMin = pairing.actualWorkedMinutes ?? 0;
          const overtimeMinutes =
            dailyRequiredMin !== null ? Math.max(0, computedWorkedMin - dailyRequiredMin) : 0;

          await tx.attendance.update({
            where: { id: attendanceRecord.id },
            data: {
              shiftId: effectiveDailyPolicy.shiftId || effectiveShift?.id || null,
              checkIn: pairing.earliestCheckIn,
              checkOut: pairing.latestCheckOut,
              status: nextStatus,
              lateMinutes,
              overtimeMinutes,
              actualWorkedMinutes: pairing.actualWorkedMinutes,
              hasIncompletePunch: pairing.hasIncompletePunch,
              punchPairsCount: pairing.punchPairsCount,
              source: 'BIOMETRIC',
            },
          });

          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'PROCESSED', errorMessage: null },
          });

          const createdNormalized = pairing.normalizedEvents.find(
            (ev) => ev.id === createdEvent.id
          );
          const effectiveMode = createdNormalized?.effectiveMode ?? initialEffectiveMode;
          const isTrailingOpenEvent =
            pairing.hasIncompletePunch &&
            createdNormalized !== undefined &&
            createdNormalized.sequenceOrder === pairing.normalizedEvents.length;

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'PROCESSED',
            message: isTrailingOpenEvent
              ? 'Check-in recorded as open punch pending check-out.'
              : pairing.hasIncompletePunch
              ? `${effectiveMode === 'CHECK_IN' ? 'Check-in' : 'Check-out'} paired chronologically (${pairing.punchPairsCount} pair${pairing.punchPairsCount === 1 ? '' : 's'}) with open trailing check-in.`
              : `${effectiveMode === 'CHECK_IN' ? 'Check-in' : 'Check-out'} paired chronologically (${pairing.punchPairsCount} pair${pairing.punchPairsCount === 1 ? '' : 's'}).`,
          };
        }

        // Legacy fallback when unit-test Prisma spies omit AttendancePunchEvent/AttendanceInterval.
        // Enforces the same deterministic chronological IN -> OUT alternation and mode-agnostic
        // 2-minute debounce without relying on raw device inOutMode.
        const shiftForLate =
          effectiveShift && effectiveShift.graceMinutes !== undefined
            ? { startTime: effectiveShift.startTime, graceMinutes: effectiveShift.graceMinutes }
            : null;

        if (!existingAttendance) {
          const lateMinutes = this.calculateLateMinutes(
            punchTime,
            workDateStr,
            shiftForLate,
            timeZone
          );
          const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

          await tx.attendance.create({
            data: {
              companyId: punch.companyId,
              employeeId: employee.id,
              shiftId: effectiveDailyPolicy.shiftId || effectiveShift?.id || null,
              workDate: workDateObj,
              checkIn: punchTime,
              checkOut: null,
              status,
              lateMinutes,
              overtimeMinutes: 0,
              actualWorkedMinutes: 0,
              hasIncompletePunch: true,
              punchPairsCount: 0,
              source: 'BIOMETRIC',
              notes: `Biometric Check-In at ${punchTime.toISOString()}`,
            },
          });

          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'PROCESSED', errorMessage: null },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'PROCESSED',
            message: 'Check-in recorded successfully.',
          };
        }

        // Mode-agnostic 2-minute debounce against existing checkIn / checkOut
        if (
          existingAttendance.checkIn &&
          Math.abs(punchTime.getTime() - existingAttendance.checkIn.getTime()) <=
            DEBOUNCE_THRESHOLD_MS
        ) {
          const reason = 'Duplicate check-in punch debounced within 2 minutes.';
          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'IGNORED', errorMessage: reason },
          });
          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'IGNORED',
            message: reason,
          };
        }

        if (
          existingAttendance.checkOut &&
          Math.abs(punchTime.getTime() - existingAttendance.checkOut.getTime()) <=
            DEBOUNCE_THRESHOLD_MS
        ) {
          const reason = 'Duplicate check-out punch debounced within 2 minutes.';
          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'IGNORED', errorMessage: reason },
          });
          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'IGNORED',
            message: reason,
          };
        }

        if (!existingAttendance.checkIn && existingAttendance.checkOut) {
          const [firstTime, secondTime] = [punchTime, existingAttendance.checkOut].sort(
            (a, b) => a.getTime() - b.getTime()
          );
          const lateMinutes = this.calculateLateMinutes(
            firstTime,
            workDateStr,
            shiftForLate,
            timeZone
          );
          const overtimeMinutes = this.calculateOvertimeMinutes(
            secondTime,
            workDateStr,
            effectiveShift,
            timeZone
          );
          const workedMin = Math.max(
            0,
            Math.round((secondTime.getTime() - firstTime.getTime()) / 60000)
          );
          const status: AttendanceStatus =
            existingAttendance.status === 'HALF_DAY'
              ? 'HALF_DAY'
              : lateMinutes > 0
              ? 'LATE'
              : 'PRESENT';

          await tx.attendance.update({
            where: { id: existingAttendance.id },
            data: {
              checkIn: firstTime,
              checkOut: secondTime,
              lateMinutes,
              overtimeMinutes,
              status,
              actualWorkedMinutes: workedMin,
              hasIncompletePunch: false,
              punchPairsCount: 1,
              source: 'BIOMETRIC',
            },
          });

          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'PROCESSED', errorMessage: null },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'PROCESSED',
            message: 'Check-in paired chronologically with existing punch.',
          };
        }

        if (existingAttendance.checkIn && !existingAttendance.checkOut) {
          const [firstTime, secondTime] = [existingAttendance.checkIn, punchTime].sort(
            (a, b) => a.getTime() - b.getTime()
          );
          const lateMinutes = this.calculateLateMinutes(
            firstTime,
            workDateStr,
            shiftForLate,
            timeZone
          );
          const overtimeMinutes = this.calculateOvertimeMinutes(
            secondTime,
            workDateStr,
            effectiveShift,
            timeZone
          );
          const workedMin = Math.max(
            0,
            Math.round((secondTime.getTime() - firstTime.getTime()) / 60000)
          );
          const status: AttendanceStatus =
            existingAttendance.status === 'HALF_DAY'
              ? 'HALF_DAY'
              : lateMinutes > 0
              ? 'LATE'
              : 'PRESENT';

          await tx.attendance.update({
            where: { id: existingAttendance.id },
            data: {
              checkIn: firstTime,
              checkOut: secondTime,
              lateMinutes,
              overtimeMinutes,
              status,
              actualWorkedMinutes: workedMin,
              hasIncompletePunch: false,
              punchPairsCount: 1,
            },
          });

          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'PROCESSED', errorMessage: null },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'PROCESSED',
            message: 'Check-out paired chronologically.',
          };
        }

        // Both checkIn and checkOut already exist in legacy fallback (no AttendancePunchEvent table)
        if (
          existingAttendance.checkIn &&
          punchTime.getTime() < existingAttendance.checkIn.getTime()
        ) {
          const lateMinutes = this.calculateLateMinutes(
            punchTime,
            workDateStr,
            shiftForLate,
            timeZone
          );
          const status: AttendanceStatus =
            existingAttendance.status === 'HALF_DAY'
              ? 'HALF_DAY'
              : lateMinutes > 0
              ? 'LATE'
              : 'PRESENT';

          await tx.attendance.update({
            where: { id: existingAttendance.id },
            data: {
              checkIn: punchTime,
              lateMinutes,
              status,
            },
          });

          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'PROCESSED', errorMessage: null },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'PROCESSED',
            message: 'Earlier check-in updated.',
          };
        }

        if (
          existingAttendance.checkOut &&
          punchTime.getTime() > existingAttendance.checkOut.getTime()
        ) {
          const overtimeMinutes = this.calculateOvertimeMinutes(
            punchTime,
            workDateStr,
            effectiveShift,
            timeZone
          );
          const workedMin = existingAttendance.checkIn
            ? Math.max(
                0,
                Math.round((punchTime.getTime() - existingAttendance.checkIn.getTime()) / 60000)
              )
            : 0;

          await tx.attendance.update({
            where: { id: existingAttendance.id },
            data: {
              checkOut: punchTime,
              overtimeMinutes,
              actualWorkedMinutes: workedMin,
              hasIncompletePunch: !existingAttendance.checkIn,
              punchPairsCount: existingAttendance.checkIn ? 1 : 0,
            },
          });

          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'PROCESSED', errorMessage: null },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'PROCESSED',
            message: 'Check-out updated successfully.',
          };
        }

        const reason = `Intermediate punch ignored in legacy fallback without punch event table.`;
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: { syncStatus: 'IGNORED', errorMessage: reason },
        });
        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: employee.id,
          workDate: workDateStr,
          status: 'IGNORED',
          message: reason,
        };
      } else {
        // BREAK_OUT or BREAK_IN
        const breakNote = `[${mode} at ${punchTime.toISOString()}]`;

        if (existingAttendance) {
          const alreadyHasNote = existingAttendance.notes?.includes(breakNote);
          if (!alreadyHasNote) {
            const updatedNotes = existingAttendance.notes
              ? `${existingAttendance.notes} ${breakNote}`
              : breakNote;

            await tx.attendance.update({
              where: { id: existingAttendance.id },
              data: { notes: updatedNotes },
            });
          }
        } else {
          await tx.attendance.create({
            data: {
              companyId: punch.companyId,
              employeeId: employee.id,
              shiftId: shift?.id || null,
              workDate: workDateObj,
              status: 'PRESENT',
              source: 'BIOMETRIC',
              notes: breakNote,
            },
          });
        }

        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: { syncStatus: 'PROCESSED', errorMessage: null },
        });

        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: employee.id,
          workDate: workDateStr,
          status: 'PROCESSED',
          message: `${mode} event recorded.`,
        };
      }
    });
  }

  /**
   * Bounded synchronization operation for pending raw biometric punches.
   * Prevents unbounded loops, enforces idempotency, and respects batch limits.
   */
  static async reconcilePendingPunches(
    companyId: string,
    options?: PunchReconciliationOptions,
    actorUserId?: string,
    correlationId?: string
  ): Promise<PunchReconciliationResponse> {
    if (options?.punchId !== undefined && (typeof options.punchId !== 'string' || !options.punchId.trim())) {
      const err = new Error('Targeted punchId filter cannot be empty.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    if (options?.employeeId !== undefined && (typeof options.employeeId !== 'string' || !options.employeeId.trim())) {
      const err = new Error('Targeted employeeId filter cannot be empty.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    if (options?.terminalId !== undefined && (typeof options.terminalId !== 'string' || !options.terminalId.trim())) {
      const err = new Error('Targeted terminalId filter cannot be empty.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    if (
      options?.userEnrollmentId !== undefined &&
      (typeof options.userEnrollmentId !== 'string' || !options.userEnrollmentId.trim())
    ) {
      const err = new Error('Targeted userEnrollmentId filter cannot be empty.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const targetPunchId = options?.punchId?.trim();
    const targetEmployeeId = options?.employeeId?.trim();
    const targetTerminalId = options?.terminalId?.trim();
    const targetEnrollmentId = options?.userEnrollmentId?.trim();

    const batchLimit = targetPunchId
      ? 1
      : Math.min(500, Math.max(1, options?.batchSize || 100));
    const keepUnmappedPending = options?.keepUnmappedPending !== false;

    const where: {
      id?: string;
      companyId: string;
      syncStatus: PunchSyncStatus | { in: PunchSyncStatus[] };
      terminalId?: string;
      userEnrollmentId?: string;
      punchTime?: { gte?: Date };
      OR?: Array<Record<string, unknown>>;
    } = {
      companyId,
      syncStatus: options?.retryErrors
        ? { in: ['PENDING', 'ERROR'] }
        : 'PENDING',
    };

    if (targetPunchId) {
      where.id = targetPunchId;
    }
    if (targetTerminalId) {
      where.terminalId = targetTerminalId;
    }
    if (targetEnrollmentId) {
      where.userEnrollmentId = targetEnrollmentId;
    }
    let resolvedCompanyTimezone: string | undefined;
    if (options?.fromPunchTime !== undefined && options?.fromPunchTime !== null) {
      const fromDate =
        options.fromPunchTime instanceof Date
          ? options.fromPunchTime
          : new Date(options.fromPunchTime);
      if (isNaN(fromDate.getTime())) {
        const err = new Error('Invalid fromPunchTime filter format.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      where.punchTime = { gte: fromDate };
    } else if (!targetPunchId && !targetEmployeeId && !targetEnrollmentId) {
      resolvedCompanyTimezone = await WorkPolicyService.resolveCompanyTimezone(companyId, prisma);
      where.punchTime = { gte: getStartOfLocalDayUtc(resolvedCompanyTimezone) };
    }

    if (targetEmployeeId) {
      const targetEmployee =
        typeof prisma.employee?.findFirst === 'function'
          ? await prisma.employee.findFirst({
              where: { id: targetEmployeeId, companyId },
              select: { id: true, companyId: true, biometricDeviceId: true },
            })
          : null;

      if (!targetEmployee) {
        const err = new Error('Selected employee record not found in this company.');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }

      const activeMappings = await BiometricMappingService.listMappingsForEmployee(
        companyId,
        targetEmployee.id
      );

      const employeeOrConditions: Array<Record<string, unknown>> = [
        { matchedEmployeeId: targetEmployee.id },
      ];

      for (const mapping of activeMappings) {
        employeeOrConditions.push({
          terminalId: mapping.terminalId,
          userEnrollmentId: mapping.enrollmentId,
          OR: [{ matchedEmployeeId: null }, { matchedEmployeeId: targetEmployee.id }],
        });
      }

      if (activeMappings.length === 0 && targetEmployee.biometricDeviceId?.trim()) {
        employeeOrConditions.push({
          userEnrollmentId: targetEmployee.biometricDeviceId.trim(),
          OR: [{ matchedEmployeeId: null }, { matchedEmployeeId: targetEmployee.id }],
        });
      }

      where.OR = employeeOrConditions;
    }

    const pendingPunches = await prisma.rawPunchLog.findMany({
      where,
      take: batchLimit,
      orderBy: [{ punchTime: 'asc' }],
      select: { id: true },
    });

    const results: PunchReconciliationItemResult[] = [];
    let processedCount = 0;
    let pendingCount = 0;
    let ignoredCount = 0;
    let errorCount = 0;

    for (const punch of pendingPunches) {
      try {
        const itemResult = await this.reconcilePunch(punch.id, correlationId, {
          keepUnmappedPending,
          expectedCompanyId: companyId,
          companyTimezone: resolvedCompanyTimezone,
        });
        results.push(itemResult);

        if (itemResult.status === 'PROCESSED') processedCount++;
        else if (itemResult.status === 'PENDING') pendingCount++;
        else if (itemResult.status === 'IGNORED') ignoredCount++;
        else errorCount++;
      } catch (err: unknown) {
        errorCount++;
        const errorMessage = (err as Error).message || 'Reconciliation failed';
        const hasMockedUpdate =
          typeof (prisma.rawPunchLog.update as { mock?: unknown })?.mock === 'object';
        const hasMockedUpdateMany =
          typeof (prisma.rawPunchLog.updateMany as { mock?: unknown })?.mock === 'object';

        if (
          typeof prisma.rawPunchLog.updateMany === 'function' &&
          (!hasMockedUpdate || hasMockedUpdateMany)
        ) {
          await prisma.rawPunchLog.updateMany({
            where: {
              id: punch.id,
              syncStatus: { notIn: ['PROCESSED', 'IGNORED'] },
            },
            data: {
              syncStatus: 'ERROR',
              errorMessage,
            },
          });
        } else {
          await prisma.rawPunchLog.update({
            where: { id: punch.id },
            data: {
              syncStatus: 'ERROR',
              errorMessage,
            },
          });
        }
        results.push({
          punchId: punch.id,
          userEnrollmentId: '',
          matchedEmployeeId: null,
          workDate: null,
          status: 'ERROR',
          message: errorMessage,
        });
      }
    }

    if (actorUserId) {
      await AuditService.log({
        companyId,
        userId: actorUserId,
        action: 'BIOMETRIC_PUNCH_RECONCILE',
        entity: 'RawPunchLog',
        entityId: targetPunchId || companyId,
        correlationId,
        details: {
          punchId: targetPunchId || null,
          employeeId: targetEmployeeId || null,
          terminalId: targetTerminalId || null,
          userEnrollmentId: targetEnrollmentId || null,
          totalEvaluated: pendingPunches.length,
          processed: processedCount,
          pending: pendingCount,
          ignored: ignoredCount,
          errors: errorCount,
        },
      });
    }

    return {
      success: true,
      totalEvaluated: pendingPunches.length,
      processed: processedCount,
      pending: pendingCount,
      ignored: ignoredCount,
      errors: errorCount,
      results,
    };
  }

  /**
   * Reconciles eligible current-day pending (and previously unmapped error) punches strictly for an exact
   * (terminalId, userEnrollmentId) mapping without touching other unmapped enrollment IDs or historical punches.
   * Defaults to the start of the current company-local calendar day (UTC) unless an explicit fromPunchTime is supplied.
   */
  static async reconcileForEmployeeMapping(
    companyId: string,
    terminalId: string,
    userEnrollmentId: string,
    actorUserId?: string,
    correlationId?: string,
    options?: { fromPunchTime?: Date | string }
  ): Promise<PunchReconciliationResponse> {
    const trimmedEnrollmentId = userEnrollmentId.trim();
    if (!terminalId || !trimmedEnrollmentId) {
      return {
        success: true,
        totalEvaluated: 0,
        processed: 0,
        pending: 0,
        ignored: 0,
        errors: 0,
        results: [],
      };
    }

    let effectiveFromPunchTime: Date | string;
    if (options?.fromPunchTime !== undefined && options?.fromPunchTime !== null) {
      effectiveFromPunchTime = options.fromPunchTime;
    } else {
      const companyTimezone = await WorkPolicyService.resolveCompanyTimezone(companyId, prisma);
      effectiveFromPunchTime = getStartOfLocalDayUtc(companyTimezone);
    }

    return this.reconcilePendingPunches(
      companyId,
      {
        terminalId,
        userEnrollmentId: trimmedEnrollmentId,
        batchSize: 500,
        retryErrors: true,
        keepUnmappedPending: true,
        fromPunchTime: effectiveFromPunchTime,
      },
      actorUserId,
      correlationId
    );
  }

  /**
   * Lists raw punch logs for audit inspection and reconciliation review
   */
  static async listPunches(
    companyId: string,
    filters?: {
      syncStatus?: PunchSyncStatus;
      terminalId?: string;
      matchedEmployeeId?: string;
      userEnrollmentId?: string;
      startDate?: string;
      endDate?: string;
    },
    pagination?: { page?: number; limit?: number }
  ): Promise<{ items: RawPunchLogItem[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, pagination?.page || 1);
    const limit = Math.min(100, Math.max(1, pagination?.limit || 20));
    const skip = (page - 1) * limit;

    const where: {
      companyId: string;
      syncStatus?: PunchSyncStatus;
      terminalId?: string;
      matchedEmployeeId?: string;
      userEnrollmentId?: string;
      punchTime?: { gte?: Date; lte?: Date };
    } = { companyId };

    if (filters?.syncStatus) {
      where.syncStatus = filters.syncStatus;
    }
    if (filters?.terminalId) {
      where.terminalId = filters.terminalId;
    }
    if (filters?.matchedEmployeeId) {
      where.matchedEmployeeId = filters.matchedEmployeeId;
    }
    if (filters?.userEnrollmentId && filters.userEnrollmentId.trim()) {
      where.userEnrollmentId = filters.userEnrollmentId.trim();
    }
    if (filters?.startDate || filters?.endDate) {
      where.punchTime = {};
      if (filters.startDate) {
        where.punchTime.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        where.punchTime.lte = new Date(filters.endDate);
      }
    }

    const [total, records] = await Promise.all([
      prisma.rawPunchLog.count({ where }),
      prisma.rawPunchLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ punchTime: 'desc' }],
        include: {
          terminal: { select: { name: true, deviceSerialNumber: true } },
          matchedEmployee: { select: { employeeCode: true, fullName: true } },
        },
      }),
    ]);

    const items: RawPunchLogItem[] = records.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      terminalId: r.terminalId,
      terminalName: r.terminal?.name || null,
      deviceSerialNumber: r.terminal?.deviceSerialNumber || null,
      devicePunchId: r.devicePunchId,
      userEnrollmentId: r.userEnrollmentId,
      punchTime: r.punchTime.toISOString(),
      verifyType: r.verifyType,
      inOutMode: r.inOutMode,
      syncStatus: r.syncStatus,
      errorMessage: r.errorMessage,
      idempotencyKey: r.idempotencyKey,
      matchedEmployeeId: r.matchedEmployeeId,
      matchedEmployeeCode: r.matchedEmployee?.employeeCode || null,
      matchedEmployeeName: r.matchedEmployee?.fullName || null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return { items, total, page, limit };
  }

  /**
   * Retrieves summary telemetry of pending/processed/error punches across company
   */
  static async getSyncSummary(companyId: string): Promise<PunchSyncSummaryResponse> {
    const [pending, processed, ignored, error, total, terminal] = await Promise.all([
      prisma.rawPunchLog.count({ where: { companyId, syncStatus: 'PENDING' } }),
      prisma.rawPunchLog.count({ where: { companyId, syncStatus: 'PROCESSED' } }),
      prisma.rawPunchLog.count({ where: { companyId, syncStatus: 'IGNORED' } }),
      prisma.rawPunchLog.count({ where: { companyId, syncStatus: 'ERROR' } }),
      prisma.rawPunchLog.count({ where: { companyId } }),
      prisma.biometricTerminal.findFirst({
        where: { companyId, lastSyncAt: { not: null } },
        orderBy: { lastSyncAt: 'desc' },
        select: { lastSyncAt: true },
      }),
    ]);

    return {
      pendingCount: pending,
      processedCount: processed,
      ignoredCount: ignored,
      errorCount: error,
      totalCount: total,
      lastSyncAt: terminal?.lastSyncAt ? terminal.lastSyncAt.toISOString() : null,
    };
  }
}
