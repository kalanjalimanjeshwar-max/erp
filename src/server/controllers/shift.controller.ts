import { Request, Response } from 'express';
import { ShiftService } from '../services/shift.service.js';
import { AuthUser } from '../../shared/types.js';

export class ShiftController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const includeInactive = req.query.includeInactive === 'true';
      const shifts = await ShiftService.listShifts(actor.companyId, includeInactive);
      res.json(shifts);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'SHIFT_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const shift = await ShiftService.getShiftById(actor.companyId, req.params.id);
      res.json(shift);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'SHIFT_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const shift = await ShiftService.createShift(actor, req.body, req.correlationId);
      res.status(201).json(shift);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'SHIFT_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const shift = await ShiftService.updateShift(actor, req.params.id, req.body, req.correlationId);
      res.json(shift);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'SHIFT_UPDATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async deactivate(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const shift = await ShiftService.deactivateShift(actor, req.params.id, req.correlationId);
      res.json(shift);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'SHIFT_DEACTIVATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}
