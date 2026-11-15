import { Request, Response, NextFunction } from 'express';
import { CompanyService } from '../services/company.service.js';
import { DocumentSequenceService } from '../services/document-sequence.service.js';
import { SettingsChangeRequestStatus } from '../../shared/types.js';

export class CompanyController {
  /**
   * GET /api/company/profile
   */
  static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const profile = await CompanyService.getProfile(companyId);
      res.status(200).json(profile);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/company/profile
   */
  static async updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const profile = await CompanyService.updateProfile(actor, req.body, req.correlationId);
      res.status(200).json(profile);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/company/print-settings
   */
  static async getPrintSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const settings = await CompanyService.getPrintSettings(companyId);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/company/print-settings
   */
  static async updatePrintSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const result = await CompanyService.updatePrintSettings(actor, req.body, req.correlationId);
      res.status(result.pendingApproval ? 202 : 200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/company/change-requests
   */
  static async listChangeRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const status = req.query.status as SettingsChangeRequestStatus | undefined;
      const list = await CompanyService.listChangeRequests(companyId, status);
      res.status(200).json(list);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/company/change-requests/:id/approve
   */
  static async approveChangeRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const result = await CompanyService.approveChangeRequest(
        actor,
        String(req.params.id),
        req.correlationId
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/company/change-requests/:id/reject
   */
  static async rejectChangeRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const result = await CompanyService.rejectChangeRequest(
        actor,
        String(req.params.id),
        req.body?.reason,
        req.correlationId
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/company/sequences
   * Read-only administrative inspection of sequence counters
   */
  static async getSequences(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const sequences = await DocumentSequenceService.listCompanySequences(companyId);
      res.status(200).json(sequences);
    } catch (error) {
      next(error);
    }
  }
}
