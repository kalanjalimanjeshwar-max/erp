import { Request, Response, NextFunction } from 'express';
import { AuditService } from '../services/audit.service.js';

export class AuditController {
  /**
   * GET /api/audit-logs
   * Strictly returns audit logs for the authenticated user's company
   */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
      const entity = req.query.entity as string | undefined;

      const logs = await AuditService.getCompanyAuditLogs(companyId, {
        limit: Math.min(limit, 100),
        offset,
        entity,
      });

      res.status(200).json(logs);
    } catch (error) {
      next(error);
    }
  }
}
