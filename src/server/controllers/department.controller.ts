import { Request, Response } from 'express';
import { DepartmentService } from '../services/department.service.js';
import { AuthUser } from '../../shared/types.js';

export class DepartmentController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const includeInactive = req.query.includeInactive === 'true';
      const departments = await DepartmentService.listDepartments(actor.companyId, includeInactive);
      res.json(departments);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DEPARTMENT_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const dept = await DepartmentService.getDepartmentById(actor.companyId, req.params.id);
      res.json(dept);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DEPARTMENT_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const dept = await DepartmentService.createDepartment(
        actor,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(dept);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DEPARTMENT_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const dept = await DepartmentService.updateDepartment(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.json(dept);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DEPARTMENT_UPDATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async deactivate(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const dept = await DepartmentService.deactivateDepartment(
        actor,
        req.params.id,
        req.headers['x-correlation-id'] as string
      );
      res.json(dept);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'DEPARTMENT_DEACTIVATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}
