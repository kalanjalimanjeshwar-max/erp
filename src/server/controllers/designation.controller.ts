import { Request, Response } from 'express';
import { DesignationService } from '../services/designation.service.js';
import { AuthUser } from '../../shared/types.js';

export class DesignationController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const includeInactive = req.query.includeInactive === 'true';
      const designations = await DesignationService.listDesignations(actor.companyId, includeInactive);
      res.json(designations);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DESIGNATION_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const desig = await DesignationService.getDesignationById(actor.companyId, req.params.id);
      res.json(desig);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DESIGNATION_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const desig = await DesignationService.createDesignation(
        actor,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(desig);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DESIGNATION_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const desig = await DesignationService.updateDesignation(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.json(desig);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DESIGNATION_UPDATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async deactivate(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const desig = await DesignationService.deactivateDesignation(
        actor,
        req.params.id,
        req.headers['x-correlation-id'] as string
      );
      res.json(desig);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DESIGNATION_DEACTIVATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}
