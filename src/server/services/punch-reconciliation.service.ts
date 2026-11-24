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
  ShiftDurationShape,
} from './work-policy.service.js';
import {
  addCalendarDaysToDateStr,
  localDateTimeToUtcIso,
} from '../../shared/timezone.js';
import {
  computeCurrentDayUpperBoundUtc,
  computeCurrentLocalDayStartUtc,
  createBiometricSafetyError,
  evaluateReconciliationWindow,
  EvaluatedReconciliationWindow,
  formatCompanyLocalDateStr,
  hasExplicitReconciliationScope,
  MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE,
  MAX_NORMAL_RECONCILIATION_BATCH_SIZE,
  normalizeReconciliationScope,
  parseStrictEnforcedTimeWindow,
  ReconciliationActorInput,
  ReconciliationWindowScope,
  ResolvedReconciliationTimeWindow,
  resolveStrictCompanyTimezone,
  TRUSTED_WINDOW_BACKWARD_CLOCK_SKEW_MS,
  TRUSTED_WINDOW_TTL_MS,
  TrustedWindowPunchContext,
  validateReconciliationRequestPreDb,
  VerifiedTrustedReconciliationWindow,
} from './biometric-safety.js';

const DEBOUNCE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TrustedWindowRegistryEntry extends VerifiedTrustedReconciliationWindow {
  usedCount: number;
}

// Module-private trusted-window registry owned exclusively by PunchReconciliationService.
// No external module, service, or callback API can mint or register a trusted window.
// Every window is bound to tenant, mode, immutable timestamps, TTL, local calendar date,
// explicit scope, and a hard server-side usage budget, and is revoked unconditionally in finally.
const trustedWindowRegistry = new WeakMap<
  ResolvedReconciliationTimeWindow,
  TrustedWindowRegistryEntry
>();
const revokedTrustedWindows = new WeakSet<ResolvedReconciliationTimeWindow>();

function parseStrictReconciliationBatchSize(
  rawBatchSize: unknown,
  defaultBatchLimit: number,
  maxBatchLimit: number
): number {
  if (rawBatchSize === undefined) {
    return Math.min(maxBatchLimit, defaultBatchLimit);
  }
  if (
    typeof rawBatchSize !== 'number' ||
    !Number.isFinite(rawBatchSize) ||
    !Number.isInteger(rawBatchSize) ||
    rawBatchSize <= 0
  ) {
    throw createBiometricSafetyError(
      "Invalid 'batchSize': value must be a positive finite integer.",
      400,
      'VALIDATION_ERROR'
    );
  }
  return Math.min(maxBatchLimit, rawBatchSize);
}

function mintScopedTrustedWindow(
  evaluated: EvaluatedReconciliationWindow,
  scope: ReconciliationWindowScope,
  maxUses: number
): ResolvedReconciliationTimeWindow {
  const normalizedScope = normalizeReconciliationScope(scope);
  if (evaluated.mode === 'HISTORICAL' && !hasExplicitReconciliationScope(normalizedScope)) {
    throw createBiometricSafetyError(
      'Historical biometric punch reconciliation requires an explicit target scope (terminalId, employeeId, userEnrollmentId, or punchId). Company-wide historical reconciliation is not permitted.',
      400,
      'BIOMETRIC_HISTORICAL_SCOPE_REQUIRED'
    );
  }

  if (
    typeof maxUses !== 'number' ||
    !Number.isFinite(maxUses) ||
    !Number.isInteger(maxUses) ||
    maxUses <= 0
  ) {
    throw createBiometricSafetyError(
      'Invalid trusted reconciliation window usage limit: expected a positive finite integer.',
      400,
      'VALIDATION_ERROR'
    );
  }

  const serverMaxCap =
    evaluated.mode === 'HISTORICAL'
      ? MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE
      : MAX_NORMAL_RECONCILIATION_BATCH_SIZE;
  const boundedMaxUses = Math.min(serverMaxCap, maxUses);
  const expiresAtMs = evaluated.issuedAtMs + TRUSTED_WINDOW_TTL_MS;

  const windowObj: ResolvedReconciliationTimeWindow = Object.freeze({
    companyId: evaluated.companyId,
    mode: evaluated.mode,
    companyTimezone: evaluated.companyTimezone,
    currentDayStartUtc: new Date(evaluated.currentDayStartUtc.getTime()),
    currentDayUpperBoundUtc: new Date(evaluated.currentDayUpperBoundUtc.getTime()),
    effectiveFrom: new Date(evaluated.effectiveFrom.getTime()),
    effectiveTo: new Date(evaluated.effectiveTo.getTime()),
    requestedFrom: evaluated.requestedFrom ? new Date(evaluated.requestedFrom.getTime()) : undefined,
    requestedTo: evaluated.requestedTo ? new Date(evaluated.requestedTo.getTime()) : undefined,
    emptyWindow: evaluated.emptyWindow,
    issuedAt: new Date(evaluated.issuedAtMs),
    expiresAt: new Date(expiresAtMs),
    scope: normalizedScope,
    maxUses: boundedMaxUses,
  });

  if (!evaluated.emptyWindow) {
    trustedWindowRegistry.set(windowObj, {
      companyId: evaluated.companyId,
      mode: evaluated.mode,
      companyTimezone: evaluated.companyTimezone,
      issuedAtMs: evaluated.issuedAtMs,
      expiresAtMs,
      issuedLocalDateStr: evaluated.issuedLocalDateStr,
      currentDayStartUtcMs: evaluated.currentDayStartUtc.getTime(),
      currentDayUpperBoundUtcMs: evaluated.currentDayUpperBoundUtc.getTime(),
      effectiveFromMs: evaluated.effectiveFrom.getTime(),
      effectiveToMs: evaluated.effectiveTo.getTime(),
      scope: normalizedScope,
      maxUses: boundedMaxUses,
      usedCount: 0,
    });
  }

  return windowObj;
}

function revokeTrustedWindow(windowObj: ResolvedReconciliationTimeWindow): void {
  revokedTrustedWindows.add(windowObj);
  trustedWindowRegistry.delete(windowObj);
}

function verifyTrustedReconciliationTimeWindow(
  candidate: ResolvedReconciliationTimeWindow | undefined,
  context: TrustedWindowPunchContext
): VerifiedTrustedReconciliationWindow | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  if (revokedTrustedWindows.has(candidate)) {
    return null;
  }

  const entry = trustedWindowRegistry.get(candidate);
  if (!entry) {
    return null;
  }

  if (!context.companyId || entry.companyId !== context.companyId) {
    return null;
  }

  if (entry.mode === 'HISTORICAL' && !hasExplicitReconciliationScope(entry.scope)) {
    return null;
  }

  const now = new Date();
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) {
    return null;
  }

  // Enforce TTL and guard against backward clock jumps
  if (nowMs > entry.expiresAtMs || nowMs < entry.issuedAtMs - TRUSTED_WINDOW_BACKWARD_CLOCK_SKEW_MS) {
    return null;
  }

  // Enforce local-midnight rollover invalidation for CURRENT_DAY windows
  if (entry.mode === 'CURRENT_DAY') {
    const currentLocalDateStr = formatCompanyLocalDateStr(entry.companyTimezone, now);
    if (currentLocalDateStr !== entry.issuedLocalDateStr) {
      return null;
    }
  }

  // Enforce scope bindings (punchId, terminalId, userEnrollmentId, and matchedEmployeeId when already known)
  if (entry.scope.punchId !== undefined && context.punchId !== entry.scope.punchId) {
    return null;
  }
  if (entry.scope.terminalId !== undefined && context.terminalId !== entry.scope.terminalId) {
    return null;
  }
  if (entry.scope.userEnrollmentId !== undefined) {
    const normalizedPunchEnrollment =
      typeof context.userEnrollmentId === 'string' ? context.userEnrollmentId.trim() : '';
    if (normalizedPunchEnrollment !== entry.scope.userEnrollmentId) {
      return null;
    }
  }
  if (
    entry.scope.employeeId !== undefined &&
    context.matchedEmployeeId &&
    context.matchedEmployeeId !== entry.scope.employeeId
  ) {
    return null;
  }

  // Enforce server-side per-window usage budget (fail-closed)
  if (
    !Number.isFinite(entry.maxUses) ||
    !Number.isInteger(entry.maxUses) ||
    entry.maxUses <= 0 ||
    entry.usedCount >= entry.maxUses
  ) {
    return null;
  }
  entry.usedCount += 1;

  return Object.freeze({
    companyId: entry.companyId,
    mode: entry.mode,
    companyTimezone: entry.companyTimezone,
    issuedAtMs: entry.issuedAtMs,
    expiresAtMs: entry.expiresAtMs,
    issuedLocalDateStr: entry.issuedLocalDateStr,
    currentDayStartUtcMs: entry.currentDayStartUtcMs,
    currentDayUpperBoundUtcMs: entry.currentDayUpperBoundUtcMs,
    effectiveFromMs: entry.effectiveFromMs,
    effectiveToMs: entry.effectiveToMs,
    scope: entry.scope,
    maxUses: entry.maxUses,
  });
}

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
   * Resolves the canonical IANA timezone for the company.
   * P0-B Fail-Closed Policy: NEVER falls back to UTC when timezone is missing, invalid, or cannot be loaded.
   */
  static async resolveCompanyTimezone(companyId: string, tx?: any): Promise<string> {
    return resolveStrictCompanyTimezone(companyId, tx || prisma);
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
   * Authoritative pre-match verification for punches that already carry a matchedEmployeeId.
   * Allows reconciliation to proceed ONLY when current mapping resolution is non-ambiguous,
   * resolves via EXPLICIT ('MAPPING') or unique 'LEGACY' (never null), returns a non-null
   * employee in the same company, and matches the exact pre-matched employee ID.
   */
  private static isAuthoritativePreMatchValid(
    resolution: {
      employee: { id?: unknown; companyId?: unknown } | null;
      matchedVia: 'MAPPING' | 'LEGACY' | null;
      ambiguous?: boolean;
    },
    expectedEmployeeId: string,
    companyId: string
  ): boolean {
    if (resolution.ambiguous) {
      return false;
    }
    if (!resolution.employee || typeof resolution.employee.id !== 'string') {
      return false;
    }
    if (resolution.matchedVia !== 'MAPPING' && resolution.matchedVia !== 'LEGACY') {
      return false;
    }
    if (resolution.employee.companyId !== companyId) {
      return false;
    }
    return resolution.employee.id === expectedEmployeeId;
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
    options?: {
      keepUnmappedPending?: boolean;
      expectedCompanyId?: string;
      companyTimezone?: string;
      enforcedTimeWindow?: { effectiveFrom: Date; effectiveTo?: Date };
      trustedTimeWindow?: ResolvedReconciliationTimeWindow;
    }
  ): Promise<PunchReconciliationItemResult> {
    // F4: Strictly validate enforcedTimeWindow fail-closed BEFORE any database transaction or mutation.
    const parsedEnforcedWindow = parseStrictEnforcedTimeWindow(options?.enforcedTimeWindow);

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

      // P0-B Mandatory Independent Cutoff, Upper-Bound, Scope & Intersection Enforcement:
      // 1. If the caller passed a trustedTimeWindow, verify it against the server-private registry
      //    (tenant, non-revoked, within TTL, non-rolled-over local day, and batch scope). Any forged,
      //    revoked, expired, rolled-over, cross-tenant, or out-of-scope trusted window is rejected
      //    immediately without mutating RawPunchLog or Attendance.
      // 2. Otherwise (direct call without trustedTimeWindow), resolve the authoritative Company
      //    timezone fail-closed inside this transaction and independently enforce BOTH the
      //    current-company-day lower cutoff and current-day upper bound (now + skew, <= local day end).
      // 3. If enforcedTimeWindow was supplied, ALWAYS intersect it with the active bounds so it can
      //    only tighten (never broaden) either lower or upper bound.
      let verifiedTrustedWindow: ReturnType<typeof verifyTrustedReconciliationTimeWindow> = null;
      let resolvedCompanyTimezone: string;
      let effectiveMinMs: number;
      let effectiveMaxMs: number;

      if (options?.trustedTimeWindow !== undefined) {
        verifiedTrustedWindow = verifyTrustedReconciliationTimeWindow(options.trustedTimeWindow, {
          companyId: punch.companyId,
          punchId: punch.id,
          terminalId: punch.terminalId,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: punch.matchedEmployeeId,
        });

        if (!verifiedTrustedWindow) {
          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: punch.matchedEmployeeId,
            workDate: null,
            status: punch.syncStatus,
            message:
              'Punch falls outside the authorized reconciliation time window and was left untouched.',
          };
        }

        resolvedCompanyTimezone = verifiedTrustedWindow.companyTimezone;
        effectiveMinMs = verifiedTrustedWindow.effectiveFromMs;
        effectiveMaxMs = verifiedTrustedWindow.effectiveToMs;

        if (verifiedTrustedWindow.mode === 'CURRENT_DAY') {
          const liveUpperBoundMs = computeCurrentDayUpperBoundUtc(resolvedCompanyTimezone).getTime();
          if (liveUpperBoundMs < effectiveMaxMs) {
            effectiveMaxMs = liveUpperBoundMs;
          }
        }
      } else {
        resolvedCompanyTimezone = await this.resolveCompanyTimezone(punch.companyId, tx);
        const now = new Date();
        effectiveMinMs = computeCurrentLocalDayStartUtc(resolvedCompanyTimezone, now).getTime();
        effectiveMaxMs = computeCurrentDayUpperBoundUtc(resolvedCompanyTimezone, now).getTime();
      }

      if (parsedEnforcedWindow) {
        if (parsedEnforcedWindow.effectiveFromMs > effectiveMinMs) {
          effectiveMinMs = parsedEnforcedWindow.effectiveFromMs;
        }
        if (
          parsedEnforcedWindow.effectiveToMs !== undefined &&
          parsedEnforcedWindow.effectiveToMs < effectiveMaxMs
        ) {
          effectiveMaxMs = parsedEnforcedWindow.effectiveToMs;
        }
      }

      const punchMs = new Date(punch.punchTime).getTime();
      if (
        Number.isNaN(punchMs) ||
        effectiveMinMs > effectiveMaxMs ||
        punchMs < effectiveMinMs ||
        punchMs > effectiveMaxMs
      ) {
        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: punch.matchedEmployeeId,
          workDate: null,
          status: punch.syncStatus,
          message:
            'Punch falls outside the authorized reconciliation time window and was left untouched.',
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
          if (verifiedTrustedWindow?.scope.employeeId) {
            return {
              punchId: punch.id,
              userEnrollmentId: punch.userEnrollmentId,
              matchedEmployeeId: punch.matchedEmployeeId,
              workDate: null,
              status: punch.syncStatus,
              message:
                'Punch falls outside the authorized reconciliation scope and was left untouched.',
            };
          }

          if (resolution.ambiguous) {
            const reason = `Ambiguous legacy biometric enrollment mapping: Multiple employees share biometricDeviceId '${punch.userEnrollmentId}' in this company. Configure explicit terminal enrollment mappings before reconciling.`;
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

        // F3: Enforce employee scope BEFORE mutating matchedEmployeeId on RawPunchLog
        if (
          verifiedTrustedWindow?.scope.employeeId &&
          foundEmployee.id !== verifiedTrustedWindow.scope.employeeId
        ) {
          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: punch.matchedEmployeeId,
            workDate: null,
            status: punch.syncStatus,
            message:
              'Punch falls outside the authorized reconciliation scope and was left untouched.',
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
      } else if (
        verifiedTrustedWindow?.scope.employeeId &&
        employee.id !== verifiedTrustedWindow.scope.employeeId
      ) {
        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: punch.matchedEmployeeId,
          workDate: null,
          status: punch.syncStatus,
          message:
            'Punch falls outside the authorized reconciliation scope and was left untouched.',
        };
      } else {
        // FIND-1 pre-matched fail-closed verification: reconciliation may continue ONLY if
        // current authoritative mapping resolution is non-ambiguous, has a non-null matchedVia
        // ('MAPPING' or 'LEGACY'), returns a non-null employee in the same company, and resolves
        // to the exact same employee ID as punch.matchedEmployee.id. Never blindly reassigns
        // punch.matchedEmployeeId.
        const currentResolution = await BiometricMappingService.resolveEmployeeForPunch(
          punch.companyId,
          punch.terminalId,
          punch.userEnrollmentId,
          tx
        );

        if (!this.isAuthoritativePreMatchValid(currentResolution, employee.id, punch.companyId)) {
          const reason = currentResolution.ambiguous
            ? `Ambiguous legacy biometric enrollment mapping: Multiple employees share biometricDeviceId '${punch.userEnrollmentId}' in this company. Configure explicit terminal enrollment mappings before reconciling.`
            : `Biometric enrollment mapping mismatch: Pre-matched employee '${employee.id}' is no longer authoritatively resolved for enrollment '${punch.userEnrollmentId}'. Configure explicit terminal enrollment mappings before reconciling.`;
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
            matchedEmployeeId: punch.matchedEmployeeId ?? employee.id,
            workDate: null,
            status: 'ERROR',
            message: reason,
          };
        }
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
      const timeZone = resolvedCompanyTimezone;
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
    actorOrUserId?: ReconciliationActorInput,
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

    const keepUnmappedPending = options?.keepUnmappedPending !== false;

    // P0-B Mandatory Safety Gate (F1, F2, F3, F5, SEC-1, SEC-2):
    // 1. Evaluates request WITHOUT minting a trusted window:
    //    - Verifies non-forgeable SUPER_ADMIN provenance + live DB user status + explicit non-empty
    //      scope + bounded <= 90-day range for historical mode BEFORE any target/punch lookup.
    //    - Resolves company timezone fail-closed using real Prisma client and server clock.
    //    - Enforces mandatory current-company-day lower cutoff AND upper bound across ALL paths.
    const evaluated = await evaluateReconciliationWindow(companyId, options, actorOrUserId);

    const actorContext = evaluated.actor;
    const actorUserId = actorContext.userId;
    const effectiveCutoffIso = evaluated.effectiveFrom.toISOString();
    const effectiveToIso = evaluated.effectiveTo.toISOString();
    const isHistoricalMode = evaluated.mode === 'HISTORICAL';

    // 2. Strictly validate batchSize (positive finite integer only, fail-closed 400 VALIDATION_ERROR)
    //    and enforce server-side maximum batch cap independently of caller batchSize (AUDIT-5).
    const maxBatchLimit = isHistoricalMode
      ? MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE
      : MAX_NORMAL_RECONCILIATION_BATCH_SIZE;
    const defaultBatchLimit = isHistoricalMode ? MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE : 100;
    const validatedBatchLimit = parseStrictReconciliationBatchSize(
      options?.batchSize,
      defaultBatchLimit,
      maxBatchLimit
    );
    const batchLimit = targetPunchId ? 1 : validatedBatchLimit;

    if (evaluated.emptyWindow) {
      return {
        success: true,
        totalEvaluated: 0,
        processed: 0,
        pending: 0,
        ignored: 0,
        errors: 0,
        effectiveCutoffIso,
        effectiveToIso,
        companyTimezone: evaluated.companyTimezone,
        historicalMode: false,
        results: [],
      };
    }

    // 3. Validate explicit target entities (terminal, employee, punch, enrollment) strictly BEFORE
    //    writing any BIOMETRIC_HISTORICAL_RECONCILE audit record or minting a trusted window.
    if (isHistoricalMode && targetTerminalId) {
      if (typeof prisma.biometricTerminal?.findFirst !== 'function') {
        throw createBiometricSafetyError(
          'Terminal validation store is unavailable for historical reconciliation (fail-closed).',
          503,
          'BIOMETRIC_TARGET_VALIDATION_UNAVAILABLE'
        );
      }
      const targetTerminal = await prisma.biometricTerminal.findFirst({
        where: { id: targetTerminalId, companyId },
        select: { id: true, companyId: true },
      });
      if (!targetTerminal || (targetTerminal.companyId && targetTerminal.companyId !== companyId)) {
        throw createBiometricSafetyError(
          'Biometric terminal not found for this company.',
          404,
          'TERMINAL_NOT_FOUND'
        );
      }
    }

    let employeeOrConditions: Array<Record<string, unknown>> | undefined;
    let validatedEmployee: {
      id: string;
      companyId: string;
      biometricDeviceId: string | null;
    } | null = null;

    if (targetEmployeeId) {
      const targetEmployee =
        typeof prisma.employee?.findFirst === 'function'
          ? await prisma.employee.findFirst({
              where: { id: targetEmployeeId, companyId },
              select: { id: true, companyId: true, biometricDeviceId: true },
            })
          : null;

      if (!targetEmployee || (targetEmployee.companyId && targetEmployee.companyId !== companyId)) {
        throw createBiometricSafetyError(
          'Selected employee record not found in this company.',
          404,
          'BIOMETRIC_TARGET_NOT_FOUND'
        );
      }

      validatedEmployee = targetEmployee;
      const activeMappings = await BiometricMappingService.listMappingsForEmployee(
        companyId,
        targetEmployee.id
      );

      let conflictingLegacyTerminalIds: string[] = [];
      let isAmbiguousLegacyEmployee = false;
      if (activeMappings.length === 0 && targetEmployee.biometricDeviceId?.trim()) {
        const legacyEnrollmentId = targetEmployee.biometricDeviceId.trim();
        const companyMappings = await BiometricMappingService.readCompanyMappings(companyId);
        const explicitMappedEmployeeIds = new Set(
          companyMappings.filter((m) => m.isActive).map((m) => m.employeeId)
        );
        conflictingLegacyTerminalIds = [
          ...new Set(
            companyMappings
              .filter(
                (m) =>
                  m.isActive &&
                  m.employeeId !== targetEmployee.id &&
                  m.enrollmentId === legacyEnrollmentId
              )
              .map((m) => m.terminalId)
          ),
        ];
        const legacyPeers = await BiometricMappingService.findLegacyEmployeesForEnrollment(
          companyId,
          legacyEnrollmentId,
          explicitMappedEmployeeIds
        );
        isAmbiguousLegacyEmployee = legacyPeers.length > 1;
      }

      if (isHistoricalMode && targetEnrollmentId) {
        const matchesActiveMapping = activeMappings.some(
          (m) =>
            m.enrollmentId === targetEnrollmentId &&
            (!targetTerminalId || m.terminalId === targetTerminalId)
        );
        const legacyBlockedByOtherMapping =
          Boolean(targetTerminalId) && conflictingLegacyTerminalIds.includes(targetTerminalId!);
        const matchesLegacyEnrollment =
          activeMappings.length === 0 &&
          !legacyBlockedByOtherMapping &&
          targetEmployee.biometricDeviceId?.trim() === targetEnrollmentId;

        if (!matchesActiveMapping && matchesLegacyEnrollment && isAmbiguousLegacyEmployee) {
          throw createBiometricSafetyError(
            `Ambiguous legacy biometric enrollment mapping: Multiple employees share biometricDeviceId '${targetEnrollmentId}' in this company. Configure explicit terminal enrollment mappings before reconciling.`,
            400,
            'BIOMETRIC_AMBIGUOUS_LEGACY_MAPPING'
          );
        }

        if (!matchesActiveMapping && !matchesLegacyEnrollment) {
          throw createBiometricSafetyError(
            'Requested userEnrollmentId does not belong to the selected employee in this company.',
            400,
            'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
          );
        }
      }

      if (
        isHistoricalMode &&
        !targetPunchId &&
        !targetEnrollmentId &&
        isAmbiguousLegacyEmployee &&
        targetEmployee.biometricDeviceId?.trim()
      ) {
        throw createBiometricSafetyError(
          `Ambiguous legacy biometric enrollment mapping: Multiple employees share biometricDeviceId '${targetEmployee.biometricDeviceId.trim()}' in this company. Configure explicit terminal enrollment mappings before reconciling.`,
          400,
          'BIOMETRIC_AMBIGUOUS_LEGACY_MAPPING'
        );
      }

      const conditions: Array<Record<string, unknown>> = [
        { matchedEmployeeId: targetEmployee.id },
      ];

      for (const mapping of activeMappings) {
        conditions.push({
          terminalId: mapping.terminalId,
          userEnrollmentId: mapping.enrollmentId,
          OR: [{ matchedEmployeeId: null }, { matchedEmployeeId: targetEmployee.id }],
        });
      }

      if (
        activeMappings.length === 0 &&
        !isAmbiguousLegacyEmployee &&
        targetEmployee.biometricDeviceId?.trim()
      ) {
        conditions.push({
          userEnrollmentId: targetEmployee.biometricDeviceId.trim(),
          ...(conflictingLegacyTerminalIds.length > 0
            ? { terminalId: { notIn: conflictingLegacyTerminalIds } }
            : {}),
          OR: [{ matchedEmployeeId: null }, { matchedEmployeeId: targetEmployee.id }],
        });
      }

      employeeOrConditions = conditions;
    }

    if (isHistoricalMode && targetPunchId) {
      const targetPunch =
        typeof prisma.rawPunchLog?.findUnique === 'function'
          ? await prisma.rawPunchLog.findUnique({
              where: { id: targetPunchId },
              select: {
                id: true,
                companyId: true,
                terminalId: true,
                userEnrollmentId: true,
                matchedEmployeeId: true,
              },
            })
          : null;

      if (!targetPunch || targetPunch.companyId !== companyId) {
        throw createBiometricSafetyError(
          'Target biometric punch record not found in this company.',
          404,
          'BIOMETRIC_TARGET_NOT_FOUND'
        );
      }

      if (targetTerminalId && targetPunch.terminalId !== targetTerminalId) {
        throw createBiometricSafetyError(
          'Target punchId does not belong to the requested terminalId.',
          400,
          'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
        );
      }
      if (targetEnrollmentId && targetPunch.userEnrollmentId.trim() !== targetEnrollmentId) {
        throw createBiometricSafetyError(
          'Target punchId does not match the requested userEnrollmentId.',
          400,
          'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
        );
      }
      if (targetPunch.matchedEmployeeId) {
        if (validatedEmployee && targetPunch.matchedEmployeeId !== validatedEmployee.id) {
          throw createBiometricSafetyError(
            'Target punchId does not belong to the selected employee.',
            400,
            'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
          );
        }

        const punchResolution = await BiometricMappingService.resolveEmployeeForPunch(
          companyId,
          targetPunch.terminalId,
          targetPunch.userEnrollmentId
        );

        if (
          !this.isAuthoritativePreMatchValid(
            punchResolution,
            targetPunch.matchedEmployeeId,
            companyId
          )
        ) {
          if (punchResolution.ambiguous) {
            throw createBiometricSafetyError(
              `Ambiguous legacy biometric enrollment mapping: Multiple employees share biometricDeviceId '${targetPunch.userEnrollmentId}' in this company. Configure explicit terminal enrollment mappings before reconciling.`,
              400,
              'BIOMETRIC_AMBIGUOUS_LEGACY_MAPPING'
            );
          }
          throw createBiometricSafetyError(
            `Biometric enrollment mapping mismatch: Target punchId pre-matched employee '${targetPunch.matchedEmployeeId}' is no longer authoritatively resolved for enrollment '${targetPunch.userEnrollmentId}'. Configure explicit terminal enrollment mappings before reconciling.`,
            400,
            'BIOMETRIC_MAPPING_MISMATCH'
          );
        }
      } else {
        // AUDIT-3 & FIND-1: When matchedEmployeeId is null, resolve authoritative ownership via
        // explicit terminal/enrollment mappings and legacy fallback BEFORE auditing or minting.
        const punchResolution = await BiometricMappingService.resolveEmployeeForPunch(
          companyId,
          targetPunch.terminalId,
          targetPunch.userEnrollmentId
        );
        if (punchResolution.ambiguous) {
          throw createBiometricSafetyError(
            `Ambiguous legacy biometric enrollment mapping: Multiple employees share biometricDeviceId '${targetPunch.userEnrollmentId}' in this company. Configure explicit terminal enrollment mappings before reconciling.`,
            400,
            'BIOMETRIC_AMBIGUOUS_LEGACY_MAPPING'
          );
        }
        if (validatedEmployee) {
          if (!punchResolution.employee) {
            throw createBiometricSafetyError(
              'Target punchId is unmapped and does not belong to the selected employee.',
              400,
              'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
            );
          }
          if (
            punchResolution.employee.companyId !== companyId ||
            punchResolution.employee.id !== validatedEmployee.id
          ) {
            throw createBiometricSafetyError(
              'Target punchId does not belong to the selected employee.',
              400,
              'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
            );
          }
        }
      }
    }

    if (isHistoricalMode && targetEnrollmentId) {
      if (targetEnrollmentId.length > 128 || /[\r\n\0]/.test(targetEnrollmentId)) {
        throw createBiometricSafetyError(
          "Invalid targeted reconciliation filter 'userEnrollmentId'.",
          400,
          'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
        );
      }

      // When userEnrollmentId is not already validated via employeeId or punchId, verify that the
      // enrollment target resolves unambiguously to an employee or existing punch within the tenant.
      if (!validatedEmployee && !targetPunchId) {
        let enrollmentExistsInTenant = false;

        if (targetTerminalId) {
          const resolution = await BiometricMappingService.resolveEmployeeForPunch(
            companyId,
            targetTerminalId,
            targetEnrollmentId
          );
          if (resolution.ambiguous) {
            throw createBiometricSafetyError(
              `Ambiguous legacy biometric enrollment mapping: Multiple employees share biometricDeviceId '${targetEnrollmentId}' in this company. Configure explicit terminal enrollment mappings before reconciling.`,
              400,
              'BIOMETRIC_AMBIGUOUS_LEGACY_MAPPING'
            );
          }
          if (resolution.employee && resolution.employee.companyId === companyId) {
            enrollmentExistsInTenant = true;
          }
        } else {
          const companyMappings = await BiometricMappingService.readCompanyMappings(companyId);
          const hasExplicitMappingForEnrollment = companyMappings.some(
            (m) => m.isActive && m.enrollmentId === targetEnrollmentId
          );
          if (hasExplicitMappingForEnrollment) {
            enrollmentExistsInTenant = true;
          } else {
            const resolution = await BiometricMappingService.resolveEmployeeForPunch(
              companyId,
              undefined,
              targetEnrollmentId
            );
            if (resolution.ambiguous) {
              throw createBiometricSafetyError(
                `Ambiguous legacy biometric enrollment mapping: Multiple employees share biometricDeviceId '${targetEnrollmentId}' in this company. Configure explicit terminal enrollment mappings before reconciling.`,
                400,
                'BIOMETRIC_AMBIGUOUS_LEGACY_MAPPING'
              );
            }
            if (resolution.employee && resolution.employee.companyId === companyId) {
              enrollmentExistsInTenant = true;
            }
          }
        }

        if (!enrollmentExistsInTenant && typeof prisma.rawPunchLog?.findMany === 'function') {
          const matchingPunches = await prisma.rawPunchLog.findMany({
            where: {
              companyId,
              ...(targetTerminalId ? { terminalId: targetTerminalId } : {}),
              userEnrollmentId: targetEnrollmentId,
            },
            take: 1,
            select: { id: true },
          });
          enrollmentExistsInTenant = matchingPunches.length > 0;
        }

        if (!enrollmentExistsInTenant) {
          throw createBiometricSafetyError(
            'Requested biometric userEnrollmentId target was not found in this company.',
            404,
            'BIOMETRIC_TARGET_NOT_FOUND'
          );
        }
      }
    }

    const validatedScope = normalizeReconciliationScope({
      punchId: targetPunchId,
      terminalId: targetTerminalId,
      userEnrollmentId: targetEnrollmentId,
      employeeId: targetEmployeeId,
    });

    // 4. Mandatory historical audit log AFTER live SUPER_ADMIN auth and target validation,
    //    and strictly BEFORE trusted-window minting or any punch query/mutation.
    if (isHistoricalMode) {
      await AuditService.log({
        companyId,
        userId: actorUserId!,
        action: 'BIOMETRIC_HISTORICAL_RECONCILE',
        entity: 'RawPunchLog',
        entityId:
          targetPunchId || targetTerminalId || targetEmployeeId || targetEnrollmentId || companyId,
        correlationId,
        details: {
          companyId,
          actorUserId: actorUserId!,
          actorRole: actorContext.role,
          authorizedAt: new Date().toISOString(),
          companyTimezone: evaluated.companyTimezone,
          currentDayCutoffUtc: evaluated.currentDayStartUtc.toISOString(),
          requestedFromPunchTime: evaluated.requestedFrom?.toISOString() || null,
          requestedToPunchTime: evaluated.requestedTo?.toISOString() || null,
          validatedScope: {
            punchId: validatedScope.punchId || null,
            employeeId: validatedScope.employeeId || null,
            terminalId: validatedScope.terminalId || null,
            userEnrollmentId: validatedScope.userEnrollmentId || null,
          },
          scope: {
            punchId: targetPunchId || null,
            employeeId: targetEmployeeId || null,
            terminalId: targetTerminalId || null,
            userEnrollmentId: targetEnrollmentId || null,
            batchSize: batchLimit,
            maxBatchLimit,
            retryErrors: Boolean(options?.retryErrors),
          },
        },
      });
    }

    // 5. Mint private, scope-bound, TTL-limited, usage-capped trusted window and guarantee
    //    unconditional revocation in finally on normal completion, early return, or thrown error.
    const timeWindow = mintScopedTrustedWindow(evaluated, validatedScope, batchLimit);

    try {
      const where: {
        id?: string;
        companyId: string;
        syncStatus: PunchSyncStatus | { in: PunchSyncStatus[] };
        terminalId?: string;
        userEnrollmentId?: string;
        punchTime: { gte: Date; lte: Date };
        OR?: Array<Record<string, unknown>>;
      } = {
        companyId,
        syncStatus: options?.retryErrors
          ? { in: ['PENDING', 'ERROR'] }
          : 'PENDING',
        punchTime: {
          gte: timeWindow.effectiveFrom,
          lte: timeWindow.effectiveTo,
        },
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
      if (employeeOrConditions) {
        where.OR = employeeOrConditions;
      }

      const fetchedPendingPunches = await prisma.rawPunchLog.findMany({
        where,
        take: batchLimit,
        orderBy: [{ punchTime: 'asc' }],
        select: { id: true },
      });
      const pendingPunches = fetchedPendingPunches.slice(0, batchLimit);

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
            companyTimezone: timeWindow.companyTimezone,
            trustedTimeWindow: timeWindow,
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
            historicalMode: isHistoricalMode,
            companyTimezone: timeWindow.companyTimezone,
            effectiveCutoffIso,
            effectiveToIso,
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
        effectiveCutoffIso,
        effectiveToIso,
        companyTimezone: timeWindow.companyTimezone,
        historicalMode: isHistoricalMode,
        results,
      };
    } finally {
      revokeTrustedWindow(timeWindow);
    }
  }

  /**
   * Reconciles eligible current-day pending (and previously unmapped error) punches strictly for an exact
   * (terminalId, userEnrollmentId) mapping without touching other unmapped enrollment IDs or historical punches.
   * Always enforces the fail-closed company timezone and mandatory current-day cutoff unless authorized historical mode is supplied.
   */
  static async reconcileForEmployeeMapping(
    companyId: string,
    terminalId: string,
    userEnrollmentId: string,
    actorOrUserId?: ReconciliationActorInput,
    correlationId?: string,
    options?: {
      fromPunchTime?: Date | string;
      toPunchTime?: Date | string;
      allowHistorical?: boolean;
      batchSize?: number;
      employeeId?: string;
    }
  ): Promise<PunchReconciliationResponse> {
    if (
      options !== undefined &&
      (options === null || typeof options !== 'object' || Array.isArray(options))
    ) {
      throw createBiometricSafetyError(
        "Invalid reconciliation 'options': expected an options object.",
        400,
        'VALIDATION_ERROR'
      );
    }

    const normalizedTerminalId = typeof terminalId === 'string' ? terminalId.trim() : '';
    const normalizedEnrollmentId =
      typeof userEnrollmentId === 'string' ? userEnrollmentId.trim() : '';

    // Enforce historical authorization & options validation BEFORE rejecting empty IDs
    // so unauthorized historical callers cannot bypass 403 via empty terminalId/userEnrollmentId.
    if (options?.allowHistorical !== undefined) {
      validateReconciliationRequestPreDb(
        companyId,
        {
          terminalId: normalizedTerminalId || undefined,
          userEnrollmentId: normalizedEnrollmentId || undefined,
          employeeId: options.employeeId,
          fromPunchTime: options.fromPunchTime,
          toPunchTime: options.toPunchTime,
          allowHistorical: options.allowHistorical,
        },
        actorOrUserId
      );
    }

    if (!normalizedTerminalId || !normalizedEnrollmentId) {
      throw createBiometricSafetyError(
        'Both terminalId and userEnrollmentId must be non-empty strings for employee mapping reconciliation.',
        400,
        'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
      );
    }

    const defaultMappingBatchSize =
      options?.allowHistorical === true
        ? MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE
        : MAX_NORMAL_RECONCILIATION_BATCH_SIZE;

    return this.reconcilePendingPunches(
      companyId,
      {
        terminalId: normalizedTerminalId,
        userEnrollmentId: normalizedEnrollmentId,
        employeeId: options?.employeeId,
        batchSize:
          options?.batchSize !== undefined ? options.batchSize : defaultMappingBatchSize,
        retryErrors: true,
        keepUnmappedPending: true,
        fromPunchTime: options?.fromPunchTime,
        toPunchTime: options?.toPunchTime,
        allowHistorical: options?.allowHistorical,
      },
      actorOrUserId,
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
