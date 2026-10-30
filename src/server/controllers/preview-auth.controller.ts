import { Request, Response, NextFunction } from 'express';
import { PreviewAuthService } from '../services/preview-auth.service.js';

export class PreviewAuthController {
  /**
   * POST /api/auth/preview-login
   * Temporary preview authentication for UI testing only.
   */
  static login(req: Request, res: Response, next: NextFunction): void {
    try {
      const { id, password } = req.body;

      if (!id || !password) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Preview ID and password are required.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      const previewSession = PreviewAuthService.authenticatePreview({ id, password });
      res.status(200).json(previewSession);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/auth/preview-status
   * Checks whether preview mode is available in the current environment.
   */
  static getStatus(_req: Request, res: Response): void {
    const enabled = PreviewAuthService.isPreviewModeEnabled();
    res.status(200).json({
      enabled,
      mode: enabled ? 'development/preview' : 'production',
      accountLabel: 'Temporary Preview Account — Not a Real Super Admin',
      credentialsHint: enabled
        ? {
            id: 'preview_admin',
            note: 'Non-production demo account for UI exploration only',
          }
        : null,
    });
  }
}
