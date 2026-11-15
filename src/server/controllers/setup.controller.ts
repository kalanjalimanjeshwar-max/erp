import { Request, Response, NextFunction } from 'express';
import { SetupService } from '../services/setup.service.js';
import { BrandingAssetService } from '../services/branding-asset.service.js';
import { initialSetupSchema } from '../validation/setup.schema.js';
import { SetupStatusResponse, InitialSetupResult } from '../../shared/types.js';

function decodeUploadPayload(req: Request): {
  assetTypeRaw: unknown;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  fallbackPngBuffer: Buffer | null;
} {
  if (Buffer.isBuffer(req.body)) {
    return {
      assetTypeRaw: req.query.assetType || req.headers['x-asset-type'],
      fileName: String(req.query.fileName || req.headers['x-file-name'] || 'branding.png'),
      mimeType: String(req.headers['content-type'] || 'application/octet-stream'),
      buffer: req.body,
      fallbackPngBuffer: null,
    };
  }

  const body = (req.body || {}) as {
    assetType?: string;
    fileName?: string;
    mimeType?: string;
    dataBase64?: string;
    fallbackPngBase64?: string | null;
  };

  let rawBase64 = String(body.dataBase64 || '').trim();
  const dataUriMatch = rawBase64.match(/^data:([^;]+);base64,(.+)$/i);
  let extractedMime = body.mimeType || '';
  if (dataUriMatch) {
    if (!extractedMime) extractedMime = dataUriMatch[1];
    rawBase64 = dataUriMatch[2];
  }

  const buffer = rawBase64 ? Buffer.from(rawBase64, 'base64') : Buffer.alloc(0);

  let fallbackPngBuffer: Buffer | null = null;
  if (body.fallbackPngBase64 && typeof body.fallbackPngBase64 === 'string') {
    let rawFallback = body.fallbackPngBase64.trim();
    const fbMatch = rawFallback.match(/^data:image\/png;base64,(.+)$/i);
    if (fbMatch) rawFallback = fbMatch[1];
    if (rawFallback) {
      fallbackPngBuffer = Buffer.from(rawFallback, 'base64');
    }
  }

  return {
    assetTypeRaw: body.assetType || req.query.assetType,
    fileName: String(body.fileName || 'branding.png'),
    mimeType: String(extractedMime || ''),
    buffer,
    fallbackPngBuffer,
  };
}

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

  /**
   * POST /api/setup/branding/upload
   * Stages Logo, Seal, or Signature BEFORE initial company bootstrap completes.
   * Locked with HTTP 409 once setup is completed.
   */
  static async uploadBrandingAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await SetupService.getSetupStatus();
      if (!status.isSetupRequired) {
        const err = new Error(
          'Initial setup has already been completed. Use authenticated Company Settings to manage branding.'
        );
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      const decoded = decodeUploadPayload(req);
      const assetType = BrandingAssetService.normalizeAssetType(decoded.assetTypeRaw);
      const staged = await BrandingAssetService.stageSetupAsset({
        assetType,
        fileName: decoded.fileName,
        mimeType: decoded.mimeType,
        buffer: decoded.buffer,
        fallbackPngBuffer: decoded.fallbackPngBuffer,
      });

      res.status(201).json(staged);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/setup/branding/assets/:id/file
   * Serves staged pre-setup preview image while initial setup is incomplete.
   */
  static async getStagedBrandingAssetFile(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const status = await SetupService.getSetupStatus();
      if (!status.isSetupRequired) {
        const err = new Error('Initial setup has already been completed.');
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      const { filePath, meta } = await BrandingAssetService.getStagedSetupAssetFile(
        String(req.params.id)
      );
      res.setHeader('Content-Type', meta.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${meta.fileName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(filePath);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/setup/branding/assets/:id
   * Removes a staged pre-setup asset before bootstrap completes.
   */
  static async deleteStagedBrandingAsset(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const status = await SetupService.getSetupStatus();
      if (!status.isSetupRequired) {
        const err = new Error('Initial setup has already been completed.');
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      await BrandingAssetService.deleteStagedSetupAsset(String(req.params.id));
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
}
