import { Request, Response } from 'express';
import { BiometricService } from '../services/biometric.service.js';
import { PunchReconciliationService } from '../services/punch-reconciliation.service.js';
import { AuthUser, BiometricTerminalStatus } from '../../shared/types.js';
import { AuthenticatedDeviceRequest } from '../middleware/device-auth.middleware.js';

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
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_PUNCH_INGEST_FAILED',
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
      const { syncStatus, terminalId, matchedEmployeeId, startDate, endDate, page, limit } = req.query;

      const result = await PunchReconciliationService.listPunches(
        actor.companyId,
        {
          syncStatus: typeof syncStatus === 'string' ? (syncStatus as any) : undefined,
          terminalId: typeof terminalId === 'string' ? terminalId : undefined,
          matchedEmployeeId: typeof matchedEmployeeId === 'string' ? matchedEmployeeId : undefined,
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
   * POST /api/biometric/sync
   * Triggers bounded, idempotent punch reconciliation (requires BIOMETRIC:EDIT)
   */
  static async triggerSync(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { batchSize, terminalId, retryErrors } = req.body || {};

      const result = await PunchReconciliationService.reconcilePendingPunches(
        actor.companyId,
        {
          batchSize: typeof batchSize === 'number' ? batchSize : undefined,
          terminalId: typeof terminalId === 'string' ? terminalId : undefined,
          retryErrors: retryErrors === true,
        },
        actor.userId || actor.id,
        req.correlationId
      );

      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'BIOMETRIC_SYNC_FAILED',
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

