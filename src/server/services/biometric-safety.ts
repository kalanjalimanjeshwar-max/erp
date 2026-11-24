import { prisma } from '../db/client.js';
import { isValidTimeZone, localDateTimeToUtcIso } from '../../shared/timezone.js';
import type { AuthUser, PunchReconciliationOptions } from '../../shared/types.js';
import { AuthService } from './auth.service.js';

export const MAX_HISTORICAL_RECONCILIATION_SPAN_DAYS = 90;
const MAX_HISTORICAL_RECONCILIATION_SPAN_MS =
  MAX_HISTORICAL_RECONCILIATION_SPAN_DAYS * 24 * 60 * 60 * 1000;

/**
 * Server-enforced maximum number of punches processed in a single historical reconciliation run.
 * Caller-supplied batchSize cannot exceed this limit.
 */
export const MAX_HISTORICAL_RECONCILIATION_BATCH_SIZE = 100;

/**
 * Server-enforced maximum number of punches processed in a single normal current-day batch.
 */
export const MAX_NORMAL_RECONCILIATION_BATCH_SIZE = 500;

/**
 * Conservative clock-skew tolerance applied to the current-day upper bound.
 * Allows minor terminal RTC drift (+5 minutes) while rejecting future-dated punches
 * and strictly preventing any punch from crossing into the next company-local calendar day.
 */
export const CURRENT_DAY_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Maximum lifetime (5 minutes) for a trusted reconciliation time window minted for a bounded batch.
 * Trusted windows are additionally revoked immediately when the batch finishes or throws.
 */
export const TRUSTED_WINDOW_TTL_MS = 5 * 60 * 1000;
export const TRUSTED_WINDOW_BACKWARD_CLOCK_SKEW_MS = 60 * 1000;

const ISO_DATETIME_WITH_EXPLICIT_TZ_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

export interface BiometricSafetyError extends Error {
  statusCode: number;
  code: string;
}

export interface BiometricActorContext {
  readonly userId?: string;
  readonly role?: AuthUser['role'];
  readonly companyId?: string;
  readonly isActive?: boolean;
  readonly isPreview?: boolean;
  readonly tokenVersion?: number;
  readonly hasServerProvenance: boolean;
}

export interface VerifiedHistoricalActor {
  readonly userId: string;
  readonly role: 'SUPER_ADMIN';
  readonly companyId: string;
  readonly tokenVersion: number;
  readonly isActive: true;
  readonly isPreview: false;
  readonly hasServerProvenance: true;
}

export type ReconciliationActorInput =
  | AuthUser
  | Partial<Omit<BiometricActorContext, 'hasServerProvenance'>>
  | string
  | undefined;

export interface ReconciliationWindowScope {
  readonly punchId?: string;
  readonly terminalId?: string;
  readonly userEnrollmentId?: string;
  readonly employeeId?: string;
}

export interface TrustedWindowPunchContext {
  readonly companyId: string;
  readonly punchId: string;
  readonly terminalId?: string | null;
  readonly userEnrollmentId?: string | null;
  readonly matchedEmployeeId?: string | null;
}

export interface EvaluatedReconciliationWindow {
  readonly companyId: string;
  readonly mode: 'CURRENT_DAY' | 'HISTORICAL';
  readonly companyTimezone: string;
  readonly currentDayStartUtc: Date;
  readonly currentDayUpperBoundUtc: Date;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date;
  readonly requestedFrom?: Date;
  readonly requestedTo?: Date;
  readonly emptyWindow: boolean;
  readonly actor: BiometricActorContext;
  readonly scope: ReconciliationWindowScope;
  readonly issuedAtMs: number;
  readonly issuedLocalDateStr: string;
}

export interface ResolvedReconciliationTimeWindow {
  readonly companyId: string;
  readonly mode: 'CURRENT_DAY' | 'HISTORICAL';
  readonly companyTimezone: string;
  readonly currentDayStartUtc: Date;
  readonly currentDayUpperBoundUtc: Date;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date;
  readonly requestedFrom?: Date;
  readonly requestedTo?: Date;
  readonly emptyWindow: boolean;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly scope: ReconciliationWindowScope;
  readonly maxUses: number;
}

export interface VerifiedTrustedReconciliationWindow {
  readonly companyId: string;
  readonly mode: 'CURRENT_DAY' | 'HISTORICAL';
  readonly companyTimezone: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly issuedLocalDateStr: string;
  readonly currentDayStartUtcMs: number;
  readonly currentDayUpperBoundUtcMs: number;
  readonly effectiveFromMs: number;
  readonly effectiveToMs: number;
  readonly scope: ReconciliationWindowScope;
  readonly maxUses: number;
}

export interface ParsedEnforcedTimeWindow {
  readonly effectiveFromMs: number;
  readonly effectiveToMs?: number;
}

export interface ValidatedReconciliationPreDb {
  readonly allowHistorical: boolean;
  readonly actor: BiometricActorContext;
  readonly scope: ReconciliationWindowScope;
  readonly requestedFrom?: Date;
  readonly requestedTo?: Date;
}

function hasOwn(obj: object, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

export function createBiometricSafetyError(
  message: string,
  statusCode: number,
  code: string
): BiometricSafetyError {
  const err = new Error(message) as BiometricSafetyError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function isValidCalendarDateParts(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function formatCompanyLocalDateStr(timeZone: string, referenceNow: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(referenceNow);
}

export function normalizeReconciliationScope(
  scope?: ReconciliationWindowScope
): ReconciliationWindowScope {
  if (!scope || typeof scope !== 'object') {
    return Object.freeze({});
  }
  const normalized: {
    punchId?: string;
    terminalId?: string;
    userEnrollmentId?: string;
    employeeId?: string;
  } = {};

  if (hasOwn(scope, 'punchId') && typeof scope.punchId === 'string' && scope.punchId.trim()) {
    normalized.punchId = scope.punchId.trim();
  }
  if (
    hasOwn(scope, 'terminalId') &&
    typeof scope.terminalId === 'string' &&
    scope.terminalId.trim()
  ) {
    normalized.terminalId = scope.terminalId.trim();
  }
  if (
    hasOwn(scope, 'userEnrollmentId') &&
    typeof scope.userEnrollmentId === 'string' &&
    scope.userEnrollmentId.trim()
  ) {
    normalized.userEnrollmentId = scope.userEnrollmentId.trim();
  }
  if (
    hasOwn(scope, 'employeeId') &&
    typeof scope.employeeId === 'string' &&
    scope.employeeId.trim()
  ) {
    normalized.employeeId = scope.employeeId.trim();
  }

  return Object.freeze(normalized);
}

export function hasExplicitReconciliationScope(scope?: ReconciliationWindowScope): boolean {
  const normalized = normalizeReconciliationScope(scope);
  return Boolean(
    normalized.punchId ||
      normalized.terminalId ||
      normalized.userEnrollmentId ||
      normalized.employeeId
  );
}

/**
 * Normalizes an actor input for reconciliation audit logging and non-privileged context.
 * - Reads ONLY own properties (never prototype-inherited properties).
 * - Plain user ID strings and plain caller-created objects NEVER receive `hasServerProvenance: true`.
 * - `hasServerProvenance` is true ONLY when the exact object reference was minted by
 *   `AuthService.validateSessionUser()` and verified in its module-private WeakMap registry.
 */
export function normalizeReconciliationActor(
  actorOrUserId?: ReconciliationActorInput
): BiometricActorContext {
  if (!actorOrUserId) {
    return Object.freeze({ hasServerProvenance: false });
  }
  if (typeof actorOrUserId === 'string') {
    const trimmed = actorOrUserId.trim();
    return Object.freeze(
      trimmed
        ? { userId: trimmed, hasServerProvenance: false }
        : { hasServerProvenance: false }
    );
  }
  if (typeof actorOrUserId !== 'object' || Array.isArray(actorOrUserId)) {
    return Object.freeze({ hasServerProvenance: false });
  }

  // Prefer server-verified immutable provenance if the object was minted by AuthService.validateSessionUser()
  const provenance = AuthService.getAuthenticatedActorProvenance(actorOrUserId);
  if (provenance) {
    return Object.freeze({
      userId: provenance.userId,
      role: provenance.role,
      companyId: provenance.companyId,
      isActive: true,
      isPreview: false,
      tokenVersion: provenance.tokenVersion,
      hasServerProvenance: true,
    });
  }

  // Unprovenanced caller object: read own properties strictly for normal-mode audit userId attribution ONLY.
  // Never trusted for historical authorization.
  const obj = actorOrUserId as Record<string, unknown>;
  const rawUserId =
    (hasOwn(obj, 'userId') && typeof obj.userId === 'string' && obj.userId.trim()) ||
    (hasOwn(obj, 'id') && typeof obj.id === 'string' && obj.id.trim()) ||
    undefined;
  const rawRole = hasOwn(obj, 'role') ? (obj.role as AuthUser['role'] | undefined) : undefined;
  const rawCompanyId =
    hasOwn(obj, 'companyId') && typeof obj.companyId === 'string' && obj.companyId.trim()
      ? obj.companyId.trim()
      : undefined;
  const rawIsActive =
    hasOwn(obj, 'isActive') && typeof obj.isActive === 'boolean' ? obj.isActive : undefined;
  const rawIsPreview =
    hasOwn(obj, 'isPreview') && typeof obj.isPreview === 'boolean' ? obj.isPreview : undefined;
  const rawTokenVersion =
    hasOwn(obj, 'tokenVersion') && typeof obj.tokenVersion === 'number'
      ? obj.tokenVersion
      : undefined;

  return Object.freeze({
    userId: rawUserId,
    role: rawRole,
    companyId: rawCompanyId,
    isActive: rawIsActive,
    isPreview: rawIsPreview,
    tokenVersion: rawTokenVersion,
    hasServerProvenance: false,
  });
}

/**
 * Synchronous pre-DB provenance check for historical reconciliation.
 * Requires a non-forgeable AuthUser reference genuinely minted by AuthService.validateSessionUser()
 * for an active, non-preview, tenant-bound SUPER_ADMIN.
 * Rejects plain objects, cloned objects, prototype-inherited objects, strings, preview sessions,
 * non-SUPER_ADMIN roles, and cross-company actors with 403 and ZERO database queries.
 */
export function assertAuthorizedHistoricalActor(
  companyId: string,
  actorOrUserId?: ReconciliationActorInput
): VerifiedHistoricalActor {
  const normalizedCompanyId = typeof companyId === 'string' ? companyId.trim() : '';
  const provenance = AuthService.getAuthenticatedActorProvenance(actorOrUserId);

  if (
    !provenance ||
    !normalizedCompanyId ||
    provenance.role !== 'SUPER_ADMIN' ||
    provenance.companyId !== normalizedCompanyId ||
    provenance.isActive !== true ||
    provenance.isPreview !== false
  ) {
    throw createBiometricSafetyError(
      'Historical biometric punch reconciliation is restricted to active, server-authenticated SUPER_ADMIN users belonging to the target company with explicit authorization.',
      403,
      'BIOMETRIC_HISTORICAL_FORBIDDEN'
    );
  }

  return Object.freeze({
    userId: provenance.userId,
    role: 'SUPER_ADMIN',
    companyId: provenance.companyId,
    tokenVersion: provenance.tokenVersion,
    isActive: true,
    isPreview: false,
    hasServerProvenance: true,
  });
}

/**
 * Live database re-verification at the historical authorization boundary.
 * First verifies non-forgeable server provenance synchronously, then re-queries the authoritative
 * User record via the real Prisma client to reject revoked sessions (tokenVersion mismatch),
 * demoted roles, deactivated accounts, or company reassignments fail-closed.
 */
export async function verifyAuthorizedHistoricalActorLive(
  companyId: string,
  actorOrUserId?: ReconciliationActorInput
): Promise<VerifiedHistoricalActor> {
  const provenancedActor = assertAuthorizedHistoricalActor(companyId, actorOrUserId);

  let dbUser: {
    id: string;
    companyId: string;
    role: AuthUser['role'];
    isActive: boolean;
    tokenVersion: number;
  } | null = null;

  try {
    dbUser = await prisma.user.findUnique({
      where: { id: provenancedActor.userId },
      select: {
        id: true,
        companyId: true,
        role: true,
        isActive: true,
        tokenVersion: true,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('[UNIT TEST DB ISOLATION ERROR]')) {
      throw err;
    }
    throw createBiometricSafetyError(
      'Failed to re-verify historical reconciliation actor against authoritative user store (fail-closed).',
      503,
      'BIOMETRIC_HISTORICAL_AUTH_UNAVAILABLE'
    );
  }

  if (
    !dbUser ||
    dbUser.id !== provenancedActor.userId ||
    dbUser.isActive !== true ||
    dbUser.role !== 'SUPER_ADMIN' ||
    dbUser.companyId !== provenancedActor.companyId ||
    dbUser.tokenVersion !== provenancedActor.tokenVersion
  ) {
    throw createBiometricSafetyError(
      'Historical biometric punch reconciliation denied: SUPER_ADMIN session has been revoked, deactivated, demoted, or reassigned.',
      403,
      'BIOMETRIC_HISTORICAL_FORBIDDEN'
    );
  }

  return provenancedActor;
}

/**
 * Strictly validates caller-supplied `enforcedTimeWindow` fail-closed.
 * - `undefined` returns `undefined`.
 * - Rejects non-objects, arrays, missing/non-Date/Invalid Date `effectiveFrom`,
 *   non-Date/Invalid Date `effectiveTo`, prototype-inherited properties, and reversed bounds
 *   (`effectiveFrom > effectiveTo`) with a structured 400 VALIDATION_ERROR.
 */
export function parseStrictEnforcedTimeWindow(
  raw: unknown
): ParsedEnforcedTimeWindow | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw createBiometricSafetyError(
      "Invalid 'enforcedTimeWindow': expected an object with a valid Date 'effectiveFrom' and optional valid Date 'effectiveTo'.",
      400,
      'VALIDATION_ERROR'
    );
  }

  const record = raw as Record<string, unknown>;
  const effectiveFrom = hasOwn(record, 'effectiveFrom') ? record.effectiveFrom : undefined;

  if (!(effectiveFrom instanceof Date) || Number.isNaN(effectiveFrom.getTime())) {
    throw createBiometricSafetyError(
      "Invalid 'enforcedTimeWindow.effectiveFrom': expected a valid Date instance.",
      400,
      'VALIDATION_ERROR'
    );
  }

  let effectiveToMs: number | undefined;
  if (hasOwn(record, 'effectiveTo') && record.effectiveTo !== undefined) {
    const effectiveTo = record.effectiveTo;
    if (!(effectiveTo instanceof Date) || Number.isNaN(effectiveTo.getTime())) {
      throw createBiometricSafetyError(
        "Invalid 'enforcedTimeWindow.effectiveTo': expected a valid Date instance when provided.",
        400,
        'VALIDATION_ERROR'
      );
    }
    effectiveToMs = effectiveTo.getTime();
  }

  const effectiveFromMs = effectiveFrom.getTime();
  if (effectiveToMs !== undefined && effectiveFromMs > effectiveToMs) {
    throw createBiometricSafetyError(
      "Invalid 'enforcedTimeWindow': effectiveFrom must be earlier than or equal to effectiveTo.",
      400,
      'VALIDATION_ERROR'
    );
  }

  return Object.freeze({
    effectiveFromMs,
    effectiveToMs,
  });
}

/**
 * Resolves the authoritative company IANA timezone from the Company record.
 * Strictly FAIL-CLOSED:
 * - Never falls back to UTC when the company record is missing, timezone is blank/null,
 *   timezone is not a valid IANA identifier, or the database query fails.
 */
export async function resolveStrictCompanyTimezone(
  companyId: string,
  db: any = prisma
): Promise<string> {
  if (!companyId || typeof companyId !== 'string' || !companyId.trim()) {
    throw createBiometricSafetyError(
      'Company identifier is required to resolve biometric timezone configuration (fail-closed).',
      400,
      'BIOMETRIC_TIMEZONE_MISSING'
    );
  }

  let company: { timezone?: string | null } | null = null;
  try {
    if (!db || typeof db.company?.findUnique !== 'function') {
      throw new Error('Company timezone lookup delegate is unavailable.');
    }
    company = await db.company.findUnique({
      where: { id: companyId },
      select: { timezone: true },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('[UNIT TEST DB ISOLATION ERROR]')) {
      throw err;
    }
    throw createBiometricSafetyError(
      'Failed to load company timezone configuration; biometric operation blocked (fail-closed).',
      503,
      'BIOMETRIC_TIMEZONE_LOOKUP_FAILED'
    );
  }

  const candidate = typeof company?.timezone === 'string' ? company.timezone.trim() : '';
  if (!candidate) {
    throw createBiometricSafetyError(
      'Company timezone is not configured. Biometric punch ingestion and reconciliation require a valid company IANA timezone (fail-closed).',
      422,
      'BIOMETRIC_TIMEZONE_MISSING'
    );
  }

  if (!isValidTimeZone(candidate)) {
    throw createBiometricSafetyError(
      `Invalid company timezone '${candidate}'. Biometric punch ingestion and reconciliation require a valid company IANA timezone (fail-closed).`,
      422,
      'BIOMETRIC_TIMEZONE_INVALID'
    );
  }

  return candidate;
}

/**
 * Computes the UTC instant corresponding to 00:00:00.000 of the current calendar day
 * in the specified company IANA timezone.
 *
 * Example: for Asia/Kolkata (UTC+05:30), local date 2026-11-23 starts at 2026-11-22T18:30:00.000Z.
 */
export function computeCurrentLocalDayStartUtc(
  timeZone: string,
  referenceNow: Date = new Date()
): Date {
  if (!timeZone || typeof timeZone !== 'string' || !isValidTimeZone(timeZone.trim())) {
    throw createBiometricSafetyError(
      `Invalid company timezone '${String(timeZone || '')}'. Cannot compute current-day cutoff (fail-closed).`,
      422,
      'BIOMETRIC_TIMEZONE_INVALID'
    );
  }

  if (!(referenceNow instanceof Date) || Number.isNaN(referenceNow.getTime())) {
    throw createBiometricSafetyError(
      'Invalid reference clock while computing biometric current-day cutoff (fail-closed).',
      500,
      'BIOMETRIC_INVALID_CLOCK'
    );
  }

  const normalizedTz = timeZone.trim();
  const localDateStr = formatCompanyLocalDateStr(normalizedTz, referenceNow);

  const utcIso = localDateTimeToUtcIso(localDateStr, '00:00:00', normalizedTz);
  const cutoff = new Date(utcIso);
  if (Number.isNaN(cutoff.getTime())) {
    throw createBiometricSafetyError(
      `Failed to compute current-day UTC cutoff for timezone '${normalizedTz}' (fail-closed).`,
      500,
      'BIOMETRIC_TIMEZONE_CALCULATION_FAILED'
    );
  }
  return cutoff;
}

/**
 * Computes the mandatory current-day upper bound in UTC for the specified company IANA timezone:
 *   min(endOfCurrentCompanyLocalDayUtc, referenceNow + CURRENT_DAY_FUTURE_CLOCK_SKEW_MS)
 *
 * Prevents both future-dated punches beyond the 5-minute clock-skew allowance and any punch
 * crossing into the next company-local calendar day from being ingested or reconciled in normal mode.
 */
export function computeCurrentDayUpperBoundUtc(
  timeZone: string,
  referenceNow: Date = new Date()
): Date {
  if (!timeZone || typeof timeZone !== 'string' || !isValidTimeZone(timeZone.trim())) {
    throw createBiometricSafetyError(
      `Invalid company timezone '${String(timeZone || '')}'. Cannot compute current-day upper bound (fail-closed).`,
      422,
      'BIOMETRIC_TIMEZONE_INVALID'
    );
  }

  if (!(referenceNow instanceof Date) || Number.isNaN(referenceNow.getTime())) {
    throw createBiometricSafetyError(
      'Invalid reference clock while computing biometric current-day upper bound (fail-closed).',
      500,
      'BIOMETRIC_INVALID_CLOCK'
    );
  }

  const normalizedTz = timeZone.trim();
  const localDateStr = formatCompanyLocalDateStr(normalizedTz, referenceNow);
  const localDayEndUtc = computeLocalDateEndUtc(localDateStr, normalizedTz);
  const skewCapMs = referenceNow.getTime() + CURRENT_DAY_FUTURE_CLOCK_SKEW_MS;

  return new Date(Math.min(localDayEndUtc.getTime(), skewCapMs));
}

/**
 * Computes the UTC instant corresponding to 00:00:00.000 of a specific YYYY-MM-DD local date
 * in the given company IANA timezone.
 */
export function computeLocalDateStartUtc(localDateStr: string, timeZone: string): Date {
  if (!isValidTimeZone(timeZone)) {
    throw createBiometricSafetyError(
      `Invalid company timezone '${timeZone}' (fail-closed).`,
      422,
      'BIOMETRIC_TIMEZONE_INVALID'
    );
  }
  const utcIso = localDateTimeToUtcIso(localDateStr, '00:00:00', timeZone);
  const dt = new Date(utcIso);
  if (Number.isNaN(dt.getTime())) {
    throw createBiometricSafetyError(
      `Failed to convert local date '${localDateStr}' start in timezone '${timeZone}'.`,
      400,
      'VALIDATION_ERROR'
    );
  }
  return dt;
}

/**
 * Computes the UTC instant corresponding to 23:59:59.999 of a specific YYYY-MM-DD local date
 * in the given company IANA timezone.
 */
export function computeLocalDateEndUtc(localDateStr: string, timeZone: string): Date {
  if (!isValidTimeZone(timeZone)) {
    throw createBiometricSafetyError(
      `Invalid company timezone '${timeZone}' (fail-closed).`,
      422,
      'BIOMETRIC_TIMEZONE_INVALID'
    );
  }
  const utcIso = localDateTimeToUtcIso(localDateStr, '23:59:59', timeZone);
  const base = new Date(utcIso);
  if (Number.isNaN(base.getTime())) {
    throw createBiometricSafetyError(
      `Failed to convert local date '${localDateStr}' end in timezone '${timeZone}'.`,
      400,
      'VALIDATION_ERROR'
    );
  }
  return new Date(base.getTime() + 999);
}

/**
 * Strict service-layer timestamp parser:
 * - Accepts already-validated Date instances (e.g. converted by the trusted controller).
 * - Accepts strict ISO-8601 datetime strings WITH explicit timezone offset (Z or ±HH:MM).
 * - Rejects ambiguous date-only strings (e.g. '2026-11-19') and offset-less timestamps
 *   (e.g. '2026-11-19T09:00:00') so service-layer dates are never interpreted in process-local time or implicit UTC.
 */
export function parseStrictServiceDateInput(
  value: string | Date | undefined | null,
  fieldName: string
): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw createBiometricSafetyError(
        `Invalid '${fieldName}' date value.`,
        400,
        'VALIDATION_ERROR'
      );
    }
    return new Date(value.getTime());
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw createBiometricSafetyError(
      `Invalid '${fieldName}': expected a Date or ISO-8601 datetime string with explicit timezone offset (Z or ±HH:MM).`,
      400,
      'VALIDATION_ERROR'
    );
  }

  const trimmed = value.trim();
  const match = ISO_DATETIME_WITH_EXPLICIT_TZ_REGEX.exec(trimmed);
  if (!match) {
    throw createBiometricSafetyError(
      `Invalid '${fieldName}': ambiguous date-only strings and timestamps without an explicit timezone offset (Z or ±HH:MM) are not permitted at the service layer.`,
      400,
      'VALIDATION_ERROR'
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] !== undefined ? Number(match[6]) : 0;
  const tzPart = match[8];

  if (!isValidCalendarDateParts(year, month, day)) {
    throw createBiometricSafetyError(
      `Invalid '${fieldName}' calendar date in '${trimmed}'.`,
      400,
      'VALIDATION_ERROR'
    );
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw createBiometricSafetyError(
      `Invalid '${fieldName}' time component in '${trimmed}'.`,
      400,
      'VALIDATION_ERROR'
    );
  }
  if (tzPart !== 'Z') {
    const offsetHour = Number(tzPart.slice(1, 3));
    const offsetMinute = Number(tzPart.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      throw createBiometricSafetyError(
        `Invalid '${fieldName}' timezone offset in '${trimmed}'.`,
        400,
        'VALIDATION_ERROR'
      );
    }
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw createBiometricSafetyError(
      `Invalid '${fieldName}' ISO-8601 timestamp '${trimmed}'.`,
      400,
      'VALIDATION_ERROR'
    );
  }
  return parsed;
}

/**
 * Pure pre-database validation for reconciliation requests:
 * Runs BEFORE terminal lookup, telemetry mutation, or any database query.
 * - Validates boolean allowHistorical flag.
 * - Enforces non-forgeable server-authenticated SUPER_ADMIN + tenant-bound provenance for allowHistorical: true.
 * - Enforces strict non-ambiguous timestamp parsing, bounded <= 90-day range rules, and explicit non-empty
 *   target scope for historical operations (company-wide historical reconciliation is disallowed).
 */
export function validateReconciliationRequestPreDb(
  companyId: string,
  options: PunchReconciliationOptions | undefined,
  actorOrUserId: ReconciliationActorInput
): ValidatedReconciliationPreDb {
  if (
    options?.allowHistorical !== undefined &&
    typeof options.allowHistorical !== 'boolean'
  ) {
    throw createBiometricSafetyError(
      "Invalid 'allowHistorical': value must be a boolean.",
      400,
      'VALIDATION_ERROR'
    );
  }

  const allowHistorical = options?.allowHistorical === true;
  const scope = normalizeReconciliationScope({
    punchId: options?.punchId,
    terminalId: options?.terminalId,
    userEnrollmentId: options?.userEnrollmentId,
    employeeId: options?.employeeId,
  });

  if (allowHistorical) {
    // 1. Non-forgeable provenance check FIRST (zero DB queries or mutations on failure)
    const actor = assertAuthorizedHistoricalActor(companyId, actorOrUserId);

    // 2. Strict bounded historical range validation (both start and end required)
    const requestedFrom = parseStrictServiceDateInput(options?.fromPunchTime, 'fromPunchTime');
    const requestedTo = parseStrictServiceDateInput(options?.toPunchTime, 'toPunchTime');

    if (!requestedFrom || !requestedTo) {
      throw createBiometricSafetyError(
        'Historical biometric punch reconciliation requires both bounded fromPunchTime and toPunchTime values.',
        400,
        'BIOMETRIC_HISTORICAL_RANGE_REQUIRED'
      );
    }

    if (requestedFrom.getTime() > requestedTo.getTime()) {
      throw createBiometricSafetyError(
        'Invalid historical reconciliation range: fromPunchTime must be earlier than or equal to toPunchTime.',
        400,
        'BIOMETRIC_INVALID_HISTORICAL_RANGE'
      );
    }

    if (requestedTo.getTime() - requestedFrom.getTime() > MAX_HISTORICAL_RECONCILIATION_SPAN_MS) {
      throw createBiometricSafetyError(
        `Historical reconciliation range exceeds the maximum allowed window of ${MAX_HISTORICAL_RECONCILIATION_SPAN_DAYS} days.`,
        400,
        'BIOMETRIC_HISTORICAL_RANGE_TOO_LARGE'
      );
    }

    // 3. Explicit non-empty target scope required (SEC-2: disallow default company-wide historical runs)
    if (!hasExplicitReconciliationScope(scope)) {
      throw createBiometricSafetyError(
        'Historical biometric punch reconciliation requires an explicit target scope (terminalId, employeeId, userEnrollmentId, or punchId). Company-wide historical reconciliation is not permitted.',
        400,
        'BIOMETRIC_HISTORICAL_SCOPE_REQUIRED'
      );
    }

    return {
      allowHistorical: true,
      actor,
      scope,
      requestedFrom,
      requestedTo,
    };
  }

  const actor = normalizeReconciliationActor(actorOrUserId);
  const requestedFrom = parseStrictServiceDateInput(options?.fromPunchTime, 'fromPunchTime');
  const requestedTo = parseStrictServiceDateInput(options?.toPunchTime, 'toPunchTime');

  if (requestedFrom && requestedTo && requestedFrom.getTime() > requestedTo.getTime()) {
    throw createBiometricSafetyError(
      'Invalid reconciliation range: fromPunchTime must be earlier than or equal to toPunchTime.',
      400,
      'VALIDATION_ERROR'
    );
  }

  return {
    allowHistorical: false,
    actor,
    scope,
    requestedFrom,
    requestedTo,
  };
}

/**
 * Non-minting reconciliation window evaluation using ONLY the real Prisma client and server clock.
 * Performs:
 * 1. Pre-DB validation (allowHistorical, provenance, strict dates, bounded range, explicit historical scope).
 * 2. Live DB user re-verification (if allowHistorical: true) to catch revoked/demoted/inactive SUPER_ADMINs.
 * 3. Fail-closed authoritative Company.timezone resolution.
 * 4. Mandatory current-day [startUtc, upperBoundUtc] clamping and empty/reversed window detection.
 *
 * NEVER mints or registers a trusted window token.
 */
export async function evaluateReconciliationWindow(
  companyId: string,
  options: PunchReconciliationOptions | undefined,
  actorOrUserId: ReconciliationActorInput
): Promise<EvaluatedReconciliationWindow> {
  const preDb = validateReconciliationRequestPreDb(companyId, options, actorOrUserId);

  let verifiedActor: BiometricActorContext = preDb.actor;
  if (preDb.allowHistorical) {
    verifiedActor = await verifyAuthorizedHistoricalActorLive(companyId, actorOrUserId);
  }

  const companyTimezone = await resolveStrictCompanyTimezone(companyId, prisma);
  const now = new Date();
  const issuedAtMs = now.getTime();
  const issuedLocalDateStr = formatCompanyLocalDateStr(companyTimezone, now);
  const currentDayStartUtc = computeCurrentLocalDayStartUtc(companyTimezone, now);
  const currentDayUpperBoundUtc = computeCurrentDayUpperBoundUtc(companyTimezone, now);

  if (preDb.allowHistorical) {
    const effectiveFrom = preDb.requestedFrom!;
    const effectiveTo = preDb.requestedTo!;

    return Object.freeze({
      companyId,
      mode: 'HISTORICAL',
      companyTimezone,
      currentDayStartUtc: new Date(currentDayStartUtc.getTime()),
      currentDayUpperBoundUtc: new Date(currentDayUpperBoundUtc.getTime()),
      effectiveFrom: new Date(effectiveFrom.getTime()),
      effectiveTo: new Date(effectiveTo.getTime()),
      requestedFrom: new Date(effectiveFrom.getTime()),
      requestedTo: new Date(effectiveTo.getTime()),
      emptyWindow: false,
      actor: verifiedActor,
      scope: preDb.scope,
      issuedAtMs,
      issuedLocalDateStr,
    });
  }

  // Mandatory current-day bounds: caller-provided bounds can only tighten, never broaden
  const effectiveFrom =
    preDb.requestedFrom && preDb.requestedFrom.getTime() > currentDayStartUtc.getTime()
      ? preDb.requestedFrom
      : currentDayStartUtc;

  const effectiveTo =
    preDb.requestedTo && preDb.requestedTo.getTime() < currentDayUpperBoundUtc.getTime()
      ? preDb.requestedTo
      : currentDayUpperBoundUtc;

  const emptyWindow = effectiveFrom.getTime() > effectiveTo.getTime();

  return Object.freeze({
    companyId,
    mode: 'CURRENT_DAY',
    companyTimezone,
    currentDayStartUtc: new Date(currentDayStartUtc.getTime()),
    currentDayUpperBoundUtc: new Date(currentDayUpperBoundUtc.getTime()),
    effectiveFrom: new Date(effectiveFrom.getTime()),
    effectiveTo: new Date(effectiveTo.getTime()),
    requestedFrom: preDb.requestedFrom ? new Date(preDb.requestedFrom.getTime()) : undefined,
    requestedTo: preDb.requestedTo ? new Date(preDb.requestedTo.getTime()) : undefined,
    emptyWindow,
    actor: verifiedActor,
    scope: preDb.scope,
    issuedAtMs,
    issuedLocalDateStr,
  });
}
