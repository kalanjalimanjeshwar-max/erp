import { Request, Response, NextFunction } from 'express';
import { SetupService } from '../services/setup.service.js';
import { initialSetupSchema } from '../validation/setup.schema.js';
import { SetupStatusResponse, InitialSetupResult } from '../../shared/types.js';

export class SetupController {
  /**
   * GET /api/setup/status
   * Determines whether the initial company and Super Admin exist
   */
  static async getStatus(
    _req: Request,
    res: Response<SetupStatusResponse>,
    next: NextFunction
  ): Promise<void> {
    try {
      const status = await SetupService.getSetupStatus();
      res.status(200).json(status);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/setup/bootstrap
   * Creates the initial company and Super Admin user
   */
  static async bootstrap(
    req: Request,
    res: Response<InitialSetupResult>,
    next: NextFunction
  ): Promise<void> {
    try {
      const validatedInput = initialSetupSchema.parse(req.body);

      const metadata = {
        ipAddress: req.ip || req.socket.remoteAddress,
        userAgent: req.get('User-Agent'),
      };

      const result = await SetupService.bootstrapInitialSetup(validatedInput, metadata);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
}
