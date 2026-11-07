import { Request, Response, NextFunction } from 'express';
import { CompanyService } from '../services/company.service.js';
import { DocumentSequenceService } from '../services/document-sequence.service.js';

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
