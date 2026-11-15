import { Request, Response } from 'express';
import { AuthUser } from '../../shared/types.js';
import { DocumentExportService } from '../services/document-export.service.js';

export class DocumentExportController {
  static async exportPdf(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const correlationId =
        req.correlationId || (req.headers['x-correlation-id'] as string | undefined);

      const result = await DocumentExportService.exportDocument(
        actor,
        req.body,
        'pdf',
        correlationId
      );

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Length', String(result.buffer.length));
      res.status(200).send(result.buffer);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 403 ? 'FORBIDDEN_PERMISSION_DENIED' : 'DOCUMENT_EXPORT_PDF_FAILED',
          message: (err as Error).message || 'Failed to export PDF document.',
        },
      });
    }
  }

  static async exportDocx(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const correlationId =
        req.correlationId || (req.headers['x-correlation-id'] as string | undefined);

      const result = await DocumentExportService.exportDocument(
        actor,
        req.body,
        'docx',
        correlationId
      );

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Length', String(result.buffer.length));
      res.status(200).send(result.buffer);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 403 ? 'FORBIDDEN_PERMISSION_DENIED' : 'DOCUMENT_EXPORT_DOCX_FAILED',
          message: (err as Error).message || 'Failed to export Word document.',
        },
      });
    }
  }
}
