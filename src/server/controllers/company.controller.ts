import { Request, Response, NextFunction } from 'express';
import { CompanyService } from '../services/company.service.js';
import { BrandingAssetService } from '../services/branding-asset.service.js';
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

  /**
   * GET /api/company/branding
   */
  static async getBrandingAssets(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const assets = await BrandingAssetService.getCompanyBrandingAssets(companyId);
      res.status(200).json(assets);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/company/branding/upload
   * POST /api/company/branding/:assetType
   */
  static async uploadBrandingAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const rawType = req.params.assetType || req.body?.assetType || req.query.assetType;
      const assetType = BrandingAssetService.normalizeAssetType(rawType);

      let fileName = 'branding.png';
      let mimeType = '';
      let buffer: Buffer = Buffer.alloc(0);
      let fallbackPngBuffer: Buffer | null = null;

      if (Buffer.isBuffer(req.body)) {
        fileName = String(req.query.fileName || req.headers['x-file-name'] || 'branding.png');
        mimeType = String(req.headers['content-type'] || '');
        buffer = req.body;
      } else {
        const body = (req.body || {}) as {
          fileName?: string;
          mimeType?: string;
          dataBase64?: string;
          fallbackPngBase64?: string | null;
        };
        fileName = String(body.fileName || 'branding.png');
        mimeType = String(body.mimeType || '');
        let rawBase64 = String(body.dataBase64 || '').trim();
        const dataUriMatch = rawBase64.match(/^data:([^;]+);base64,(.+)$/i);
        if (dataUriMatch) {
          if (!mimeType) mimeType = dataUriMatch[1];
          rawBase64 = dataUriMatch[2];
        }
        if (rawBase64) {
          buffer = Buffer.from(rawBase64, 'base64');
        }
        if (body.fallbackPngBase64 && typeof body.fallbackPngBase64 === 'string') {
          let rawFb = body.fallbackPngBase64.trim();
          const fbMatch = rawFb.match(/^data:image\/png;base64,(.+)$/i);
          if (fbMatch) rawFb = fbMatch[1];
          if (rawFb) {
            fallbackPngBuffer = Buffer.from(rawFb, 'base64');
          }
        }
      }

      const result = await BrandingAssetService.uploadCompanyAsset(
        actor,
        {
          assetType,
          fileName,
          mimeType,
          buffer,
          fallbackPngBuffer,
        },
        req.correlationId
      );

      const profile = result.pendingApproval
        ? undefined
        : await CompanyService.getProfile(actor.companyId);

      res.status(result.pendingApproval ? 202 : 201).json({
        ...result,
        ...(profile ? { profile } : {}),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/company/branding/:assetType
   */
  static async removeBrandingAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const assetType = BrandingAssetService.normalizeAssetType(req.params.assetType);
      const result = await BrandingAssetService.removeCompanyAsset(
        actor,
        assetType,
        req.correlationId
      );

      const profile = result.pendingApproval
        ? undefined
        : await CompanyService.getProfile(actor.companyId);

      res.status(result.pendingApproval ? 202 : 200).json({
        ...result,
        ...(profile ? { profile } : {}),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/company/branding/assets/:id/file
   * Serves company-scoped branding assets securely without exposing OS paths.
   */
  static async getBrandingAssetFile(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const { filePath, meta } = await BrandingAssetService.getCompanyAssetFile(
        companyId,
        String(req.params.id)
      );
      res.setHeader('Content-Type', meta.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${meta.fileName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.sendFile(filePath);
    } catch (error) {
      next(error);
    }
  }
}
