import { Request, Response } from 'express';
import { prisma } from '../db/client.js';
import { BiometricService } from '../services/biometric.service.js';
import { BiometricMappingService } from '../services/biometric-mapping.service.js';
import { PunchReconciliationService } from '../services/punch-reconciliation.service.js';
import {
  assertAuthorizedHistoricalActor,
  computeLocalDateEndUtc,
  computeLocalDateStartUtc,
  resolveStrictCompanyTimezone,
} from '../services/biometric-safety.js';
import { AuthUser, BiometricTerminalStatus } from '../../shared/types.js';
import { AuthenticatedDeviceRequest } from '../middleware/device-auth.middleware.js';

const CALENDAR_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_WITH_TZ_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

function createControllerError(message: string, statusCode: number, code: string): Error {
  const err = new Error(message) as Error & { statusCode?: number; code?: string };
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

export class BiometricController {
  /**
   * GET /api/biometric/devices
   * Lists registered biometric terminals for the authenticated company
   */
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { status, includeInactive } = req.query;

      const terminals = await BiometricService.listTerminals(actor.companyId, {
        status: typeof status === 'string' ? (status as BiometricTerminalStatus) : undefined,
        includeInactive: includeInactive === 'true',
      });

      res.json(terminals);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_DEVICE_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * POST /api/biometric/devices
   * Registers a new physical biometric terminal and returns one-time API key
   */
  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const result = await BiometricService.registerTerminal(actor, req.body, req.correlationId);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 409 ? 'BIOMETRIC_DEVICE_CONFLICT' : 'BIOMETRIC_DEVICE_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * POST /api/biometric/devices/:id/deactivate
   * Deactivates a terminal, taking it offline and immediately invalidating credentials (requires BIOMETRIC:DEACTIVATE)
   */
  static async deactivate(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { id } = req.params;
      const terminal = await BiometricService.deactivateTerminal(actor, id, req.correlationId);
      res.status(200).json({
        success: true,
        terminal,
      });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 404 ? 'TERMINAL_NOT_FOUND' : 'BIOMETRIC_TERMINAL_DEACTIVATE_FAILED',
          message: (err as Error).message || 'Failed to deactivate biometric terminal.',
        },
      });
    }
  }

  /**
   * POST /api/biometric/devices/:id/rotate-key
   * Rotates a terminal's API key and returns plaintext key once (requires BIOMETRIC:EDIT)
   */
  static async rotateKey(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { id } = req.params;
      const result = await BiometricService.rotateTerminalKey(actor, id, req.correlationId);
      res.status(200).json({
        success: true,
        terminal: result.terminal,
        apiKey: result.apiKey,
      });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 404 ? 'TERMINAL_NOT_FOUND' : 'BIOMETRIC_KEY_ROTATE_FAILED',
          message: (err as Error).message || 'Failed to rotate biometric terminal API key.',
        },
      });
    }
  }

  /**
   * POST /api/biometric/devices/:id/test-connection
   * Probes TCP connectivity and evaluates LAN Bridge heartbeat state (requires BIOMETRIC:VIEW)
   */
  static async testConnection(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { id } = req.params;
      const result = await BiometricService.testTerminalConnection(actor, id, req.correlationId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 404 ? 'TERMINAL_NOT_FOUND' : 'BIOMETRIC_TEST_CONNECTION_FAILED',
          message: (err as Error).message || 'Failed to test terminal connectivity.',
        },
      });
    }
  }

  private static parseSyncRequestBody(body: unknown): Record<string, unknown> {
    if (body === undefined) return {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw createControllerError(
        'Invalid request payload: expected a JSON object.',
        400,
        'VALIDATION_ERROR'
      );
    }
    return body as Record<string, unknown>;
  }

  private static parseTargetedFilter(value: unknown, fieldName: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) {
      throw createControllerError(
        `Invalid targeted reconciliation filter '${fieldName}': value must be a non-empty string.`,
        400,
        'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
      );
    }
    return value.trim();
  }

  private static parseBatchSize(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw createControllerError(
        "Invalid 'batchSize': value must be a positive integer.",
        400,
        'VALIDATION_ERROR'
      );
    }
    return value;
  }

  private static parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      throw createControllerError(
        `Invalid '${fieldName}': value must be a boolean.`,
        400,
        'VALIDATION_ERROR'
      );
    }
    return value;
  }

  private static rejectHistoricalQueryOverrides(query: Request['query']): void {
    if (!query || typeof query !== 'object') return;
    for (const forbiddenKey of ['allowHistorical', 'fromPunchTime', 'toPunchTime']) {
      if (query[forbiddenKey] !== undefined) {
        throw createControllerError(
          `Query parameter '${forbiddenKey}' is not permitted for biometric reconciliation.`,
          400,
          'VALIDATION_ERROR'
        );
      }
    }
  }

  private static assertHistoricalAuthorizationIfRequested(
    actor: AuthUser,
    allowHistorical: boolean | undefined
  ): void {
    if (allowHistorical === true) {
      assertAuthorizedHistoricalActor(actor?.companyId || '', actor);
    }
  }

  private static async parsePunchBoundaryTime(
    value: unknown,
    companyId: string,
    fieldName: 'fromPunchTime' | 'toPunchTime',
    boundary: 'start' | 'end'
  ): Promise<Date | undefined> {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) {
      throw createControllerError(
        `Invalid '${fieldName}': expected a valid YYYY-MM-DD calendar date or ISO-8601 datetime string with timezone offset.`,
        400,
        'VALIDATION_ERROR'
      );
    }

    const trimmed = value.trim();

    const dateMatch = CALENDAR_DATE_REGEX.exec(trimmed);
    if (dateMatch) {
      const year = Number(dateMatch[1]);
      const month = Number(dateMatch[2]);
      const day = Number(dateMatch[3]);
      if (!isValidCalendarDateParts(year, month, day)) {
        throw createControllerError(
          `Invalid '${fieldName}' calendar date '${trimmed}'.`,
          400,
          'VALIDATION_ERROR'
        );
      }

      const companyTimezone = await resolveStrictCompanyTimezone(companyId, prisma);
      return boundary === 'start'
        ? computeLocalDateStartUtc(trimmed, companyTimezone)
        : computeLocalDateEndUtc(trimmed, companyTimezone);
    }

    const isoMatch = ISO_DATETIME_WITH_TZ_REGEX.exec(trimmed);
    if (isoMatch) {
      const year = Number(isoMatch[1]);
      const month = Number(isoMatch[2]);
      const day = Number(isoMatch[3]);
      const hour = Number(isoMatch[4]);
      const minute = Number(isoMatch[5]);
      const second = isoMatch[6] !== undefined ? Number(isoMatch[6]) : 0;
      const tzPart = isoMatch[8];

      if (!isValidCalendarDateParts(year, month, day)) {
        throw createControllerError(
          `Invalid '${fieldName}' calendar date in '${trimmed}'.`,
          400,
          'VALIDATION_ERROR'
        );
      }
      if (hour > 23 || minute > 59 || second > 59) {
        throw createControllerError(
          `Invalid '${fieldName}' time component in '${trimmed}'.`,
          400,
          'VALIDATION_ERROR'
        );
      }
      if (tzPart !== 'Z') {
        const offsetHour = Number(tzPart.slice(1, 3));
        const offsetMinute = Number(tzPart.slice(4, 6));
        if (offsetHour > 23 || offsetMinute > 59) {
          throw createControllerError(
            `Invalid '${fieldName}' timezone offset in '${trimmed}'.`,
            400,
            'VALIDATION_ERROR'
          );
        }
      }

      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        throw createControllerError(
          `Invalid '${fieldName}' ISO-8601 timestamp '${trimmed}'.`,
          400,
          'VALIDATION_ERROR'
        );
      }
      return parsed;
    }

    throw createControllerError(
      `Invalid '${fieldName}': expected a valid YYYY-MM-DD calendar date or ISO-8601 datetime string with timezone offset (Z or ±HH:MM).`,
      400,
      'VALIDATION_ERROR'
    );
  }

  /**
   * Validates and normalizes optional `fromPunchTime`:
   * - `undefined`: returns `undefined` so reconciliation preserves its company-local today-only default cutoff.
   * - `YYYY-MM-DD`: normalized to the start of that calendar day in the company's configured timezone (fail-closed).
   * - ISO-8601 datetime with explicit `Z` or `±HH:MM` offset: preserves the explicitly supplied instant.
   */
  static async parseFromPunchTime(value: unknown, companyId: string): Promise<Date | undefined> {
    return BiometricController.parsePunchBoundaryTime(value, companyId, 'fromPunchTime', 'start');
  }

  static async parseToPunchTime(value: unknown, companyId: string): Promise<Date | undefined> {
    return BiometricController.parsePunchBoundaryTime(value, companyId, 'toPunchTime', 'end');
  }

  /**
   * POST /api/biometric/devices/:id/sync
   * Queues immediate bridge pull and reconciles pending raw punches for this terminal (requires BIOMETRIC:EDIT;
   * historical reconciliation additionally requires SUPER_ADMIN + explicit allowHistorical: true + bounded range)
   */
  static async syncTerminal(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { id } = req.params;
      BiometricController.rejectHistoricalQueryOverrides(req.query);
      const body = BiometricController.parseSyncRequestBody(req.body);
      const {
        batchSize,
        retryErrors,
        keepUnmappedPending,
        fromPunchTime,
        toPunchTime,
        allowHistorical,
        userEnrollmentId,
        employeeId,
        punchId,
      } = body;

      const parsedAllowHistorical = BiometricController.parseOptionalBoolean(
        allowHistorical,
        'allowHistorical'
      );
      BiometricController.assertHistoricalAuthorizationIfRequested(actor, parsedAllowHistorical);

      const parsedBatchSize = BiometricController.parseBatchSize(batchSize);
      const parsedRetryErrors = BiometricController.parseOptionalBoolean(retryErrors, 'retryErrors');
      const parsedKeepUnmappedPending = BiometricController.parseOptionalBoolean(
        keepUnmappedPending,
        'keepUnmappedPending'
      );
      const parsedEnrollmentId = BiometricController.parseTargetedFilter(
        userEnrollmentId,
        'userEnrollmentId'
      );
      const parsedEmployeeId = BiometricController.parseTargetedFilter(employeeId, 'employeeId');
      const parsedPunchId = BiometricController.parseTargetedFilter(punchId, 'punchId');
      const parsedFromPunchTime = await BiometricController.parseFromPunchTime(
        fromPunchTime,
        actor.companyId
      );
      const parsedToPunchTime = await BiometricController.parseToPunchTime(
        toPunchTime,
        actor.companyId
      );

      const result = await BiometricService.triggerTerminalSync(
        actor,
        id,
        {
          batchSize: parsedBatchSize,
          retryErrors: parsedRetryErrors ?? false,
          keepUnmappedPending: parsedKeepUnmappedPending,
          fromPunchTime: parsedFromPunchTime,
          toPunchTime: parsedToPunchTime,
          allowHistorical: parsedAllowHistorical,
          userEnrollmentId: parsedEnrollmentId,
          employeeId: parsedEmployeeId,
          punchId: parsedPunchId,
        },
        req.correlationId
      );
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      const explicitCode = (err as { code?: string }).code;
      res.status(status).json({
        error: {
          code:
            explicitCode ||
            (status === 403
              ? 'BIOMETRIC_HISTORICAL_FORBIDDEN'
              : status === 404
              ? 'TERMINAL_NOT_FOUND'
              : status === 400
              ? 'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
              : 'BIOMETRIC_TERMINAL_SYNC_FAILED'),
          message: (err as Error).message || 'Failed to sync biometric terminal.',
        },
      });
    }
  }

  /**
   * POST /api/biometric/devices/:id/sync-users
   * Queues hardware user synchronization ONLY for this terminal (never runs punch reconciliation)
   */
  static async syncTerminalUsers(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { id } = req.params;
      const result = await BiometricService.triggerTerminalUserSync(actor, id, req.correlationId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 404 ? 'TERMINAL_NOT_FOUND' : 'BIOMETRIC_TERMINAL_USER_SYNC_FAILED',
          message: (err as Error).message || 'Failed to queue hardware user sync.',
        },
      });
    }
  }

  /**
   * GET /api/biometric/devices/:id/user-sync-status
   * Returns current user-sync job lifecycle state, bridge process status, physical device status, and synced users (requires BIOMETRIC:VIEW)
   */
  static async getUserSyncStatus(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { id } = req.params;
      const status = await BiometricService.getTerminalUserSyncStatus(actor.companyId, id);
      res.json(status);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 404 ? 'TERMINAL_NOT_FOUND' : 'BIOMETRIC_USER_SYNC_STATUS_FAILED',
          message: (err as Error).message || 'Failed to load hardware user sync status.',
        },
      });
    }
  }

  /**
   * GET /api/biometric/devices/:id/users
   * Lists persisted hardware users synced from this terminal (requires BIOMETRIC:VIEW)
   */
  static async listDeviceUsers(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { id } = req.params;
      const users = await BiometricService.getTerminalDeviceUsers(actor.companyId, id);
      res.json(users);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 404 ? 'TERMINAL_NOT_FOUND' : 'BIOMETRIC_DEVICE_USERS_LIST_FAILED',
          message: (err as Error).message || 'Failed to load synced device users.',
        },
      });
    }
  }

  /**
   * POST /api/biometric/heartbeat
   * Authenticated device heartbeat ping (authenticated via device API key)
   */
  static async heartbeat(req: AuthenticatedDeviceRequest, res: Response): Promise<void> {
    try {
      const terminal = req.terminal;
      const result = await BiometricService.recordHeartbeat(terminal, req.body || {}, req.correlationId);
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_HEARTBEAT_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * POST /api/biometric/users/jobs/claim
   * Atomically claims a pending user-sync job for an authenticated terminal (authenticated via device API key)
   */
  static async claimUserSyncJob(req: AuthenticatedDeviceRequest, res: Response): Promise<void> {
    try {
      const terminal = req.terminal;
      const result = await BiometricService.claimPendingUserSyncJob(
        terminal,
        req.body || {},
        req.correlationId
      );
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_USER_SYNC_CLAIM_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * POST /api/biometric/users/jobs/fail
   * Reports a user-sync job execution failure from an authenticated bridge (authenticated via device API key)
   */
  static async failUserSyncJob(req: AuthenticatedDeviceRequest, res: Response): Promise<void> {
    try {
      const terminal = req.terminal;
      const result = await BiometricService.reportUserSyncJobFailure(
        terminal,
        req.body || {},
        req.correlationId
      );
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_USER_SYNC_FAIL_REPORT_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * POST /api/biometric/users
   * Authenticated dedicated hardware user snapshot upload (authenticated via device API key)
   */
  static async ingestUsers(req: AuthenticatedDeviceRequest, res: Response): Promise<void> {
    try {
      const terminal = req.terminal;
      const result = await BiometricService.syncDeviceUsers(terminal, req.body, req.correlationId);
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_USERS_SYNC_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * POST /api/biometric/punches
   * Ingests a batch of biometric punch events (authenticated via device API key)
   */
  static async ingestPunches(req: AuthenticatedDeviceRequest, res: Response): Promise<void> {
    try {
      const terminal = req.terminal;
      const result = await BiometricService.ingestPunches(terminal, req.body, req.correlationId);
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      const explicitCode = (err as { code?: string }).code;
      res.status(status).json({
        error: {
          code: explicitCode || 'BIOMETRIC_PUNCH_INGEST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * GET /api/biometric/punches
   * Lists raw punch logs with filters and pagination (requires BIOMETRIC:VIEW)
   */
  static async listPunches(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { syncStatus, terminalId, matchedEmployeeId, userEnrollmentId, startDate, endDate, page, limit } = req.query;

      const result = await PunchReconciliationService.listPunches(
        actor.companyId,
        {
          syncStatus: typeof syncStatus === 'string' ? (syncStatus as any) : undefined,
          terminalId: typeof terminalId === 'string' ? terminalId : undefined,
          matchedEmployeeId: typeof matchedEmployeeId === 'string' ? matchedEmployeeId : undefined,
          userEnrollmentId: typeof userEnrollmentId === 'string' && userEnrollmentId.trim() ? userEnrollmentId.trim() : undefined,
          startDate: typeof startDate === 'string' ? startDate : undefined,
          endDate: typeof endDate === 'string' ? endDate : undefined,
        },
        {
          page: page ? parseInt(page as string, 10) : undefined,
          limit: limit ? parseInt(limit as string, 10) : undefined,
        }
      );

      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_PUNCH_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * GET /api/biometric/enrollments
   * Lists active employee-to-terminal enrollment mappings for the authenticated company (requires BIOMETRIC:VIEW)
   */
  static async listEnrollments(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { terminalId, employeeId } = req.query;
      const enrollments = await BiometricMappingService.listCompanyMappings(actor.companyId, {
        terminalId: typeof terminalId === 'string' ? terminalId : undefined,
        employeeId: typeof employeeId === 'string' ? employeeId : undefined,
      });
      res.json(enrollments);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_ENROLLMENTS_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * POST /api/biometric/sync
   * Triggers bounded, idempotent punch reconciliation (requires BIOMETRIC:EDIT)
   */
  static async triggerSync(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      BiometricController.rejectHistoricalQueryOverrides(req.query);
      const body = BiometricController.parseSyncRequestBody(req.body);
      const {
        batchSize,
        terminalId,
        userEnrollmentId,
        employeeId,
        punchId,
        retryErrors,
        keepUnmappedPending,
        fromPunchTime,
        toPunchTime,
        allowHistorical,
      } = body;

      const parsedAllowHistorical = BiometricController.parseOptionalBoolean(
        allowHistorical,
        'allowHistorical'
      );
      BiometricController.assertHistoricalAuthorizationIfRequested(actor, parsedAllowHistorical);

      const parsedBatchSize = BiometricController.parseBatchSize(batchSize);
      const parsedRetryErrors = BiometricController.parseOptionalBoolean(retryErrors, 'retryErrors');
      const parsedKeepUnmappedPending = BiometricController.parseOptionalBoolean(
        keepUnmappedPending,
        'keepUnmappedPending'
      );
      const parsedTerminalId = BiometricController.parseTargetedFilter(terminalId, 'terminalId');
      const parsedEnrollmentId = BiometricController.parseTargetedFilter(
        userEnrollmentId,
        'userEnrollmentId'
      );
      const parsedEmployeeId = BiometricController.parseTargetedFilter(employeeId, 'employeeId');
      const parsedPunchId = BiometricController.parseTargetedFilter(punchId, 'punchId');
      const parsedFromPunchTime = await BiometricController.parseFromPunchTime(
        fromPunchTime,
        actor.companyId
      );
      const parsedToPunchTime = await BiometricController.parseToPunchTime(
        toPunchTime,
        actor.companyId
      );

      if (parsedTerminalId) {
        const ownedTerminal = await prisma.biometricTerminal.findFirst({
          where: { id: parsedTerminalId, companyId: actor.companyId },
          select: { id: true },
        });
        if (!ownedTerminal) {
          throw createControllerError(
            'Biometric terminal not found for this company.',
            404,
            'TERMINAL_NOT_FOUND'
          );
        }
      }

      const result = await PunchReconciliationService.reconcilePendingPunches(
        actor.companyId,
        {
          batchSize: parsedBatchSize,
          terminalId: parsedTerminalId,
          userEnrollmentId: parsedEnrollmentId,
          employeeId: parsedEmployeeId,
          punchId: parsedPunchId,
          retryErrors: parsedRetryErrors ?? false,
          keepUnmappedPending: parsedKeepUnmappedPending,
          fromPunchTime: parsedFromPunchTime,
          toPunchTime: parsedToPunchTime,
          allowHistorical: parsedAllowHistorical,
        },
        actor,
        req.correlationId
      );

      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      const explicitCode = (err as { code?: string }).code;
      res.status(status).json({
        error: {
          code:
            explicitCode ||
            (status === 403
              ? 'BIOMETRIC_HISTORICAL_FORBIDDEN'
              : status === 400
              ? 'BIOMETRIC_INVALID_RECONCILIATION_FILTER'
              : status === 404
              ? 'BIOMETRIC_TARGET_NOT_FOUND'
              : 'BIOMETRIC_SYNC_FAILED'),
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * GET /api/biometric/sync/summary
   * Returns punch sync telemetry summary counts (requires BIOMETRIC:VIEW)
   */
  static async getSummary(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const result = await PunchReconciliationService.getSyncSummary(actor.companyId);
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_SUMMARY_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}

