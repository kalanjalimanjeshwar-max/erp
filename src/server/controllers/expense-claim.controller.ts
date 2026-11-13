import { Request, Response } from 'express';
import { AuthUser } from '../../shared/types.js';
import { ExpenseClaimService } from '../services/expense-claim.service.js';
import { ReceiptStorageService } from '../services/receipt-storage.service.js';

export class ExpenseClaimController {
  static async getCapabilities(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const capabilities = await ExpenseClaimService.getCapabilities(actor);
      res.json(capabilities);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CAPABILITIES_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  // ==========================================================================
  // RECEIPT ATTACHMENT HANDLERS
  // ==========================================================================

  static async uploadAttachment(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      let fileName = 'receipt.pdf';
      let mimeType = 'application/pdf';
      let buffer: Buffer;

      if (req.body && typeof req.body === 'object' && req.body.dataBase64) {
        fileName = req.body.fileName || fileName;
        mimeType = req.body.mimeType || mimeType;
        buffer = Buffer.from(req.body.dataBase64, 'base64');
      } else if (Buffer.isBuffer(req.body)) {
        buffer = req.body;
        fileName = (req.query.fileName as string) || fileName;
        mimeType = req.headers['content-type'] || mimeType;
      } else {
        res.status(400).json({
          error: {
            code: 'INVALID_PAYLOAD',
            message: 'Provide receipt attachment either as JSON with dataBase64 or as raw file body.',
          },
        });
        return;
      }

      const attachment = await ReceiptStorageService.storeReceipt(
        actor,
        fileName,
        buffer,
        mimeType,
        req.query.claimId as string | undefined
      );

      res.status(201).json(attachment);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'ATTACHMENT_UPLOAD_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getAttachmentFile(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { filePath, attachment } = await ReceiptStorageService.getReceiptFile(actor, req.params.id);

      res.setHeader('Content-Type', attachment.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${attachment.fileName}"`);
      res.setHeader('X-Content-SHA256', attachment.sha256Hash);
      res.sendFile(filePath);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'ATTACHMENT_RETRIEVAL_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  // ==========================================================================
  // EXPENSE CLAIM LIFECYCLE HANDLERS
  // ==========================================================================

  static async listClaims(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const claims = await ExpenseClaimService.listClaims(actor, {
        status: req.query.status as any,
        employeeId: req.query.employeeId as string,
        departmentId: req.query.departmentId as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        search: req.query.search as string,
        queue: req.query.queue as any,
      });

      res.json(claims);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CLAIM_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getClaimById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const claim = await ExpenseClaimService.getClaimById(actor, req.params.id);
      res.json(claim);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CLAIM_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async createClaim(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const created = await ExpenseClaimService.createClaim(actor, req.body, req.correlationId);
      res.status(201).json(created);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CLAIM_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async updateClaim(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const updated = await ExpenseClaimService.updateClaim(actor, req.params.id, req.body, req.correlationId);
      res.json(updated);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CLAIM_UPDATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async submitClaim(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const submitted = await ExpenseClaimService.submitClaim(actor, req.params.id, req.correlationId);
      res.json(submitted);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CLAIM_SUBMIT_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async cancelClaim(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const cancelled = await ExpenseClaimService.cancelClaim(actor, req.params.id, req.body?.reason, req.correlationId);
      res.json(cancelled);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CLAIM_CANCEL_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async managerReview(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const reviewed = await ExpenseClaimService.reviewAsManager(actor, req.params.id, req.body, req.correlationId);
      res.json(reviewed);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CLAIM_MANAGER_REVIEW_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async accountsReview(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const reviewed = await ExpenseClaimService.reviewAsAccounts(actor, req.params.id, req.body, req.correlationId);
      res.json(reviewed);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CLAIM_ACCOUNTS_REVIEW_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async recordPayment(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const paid = await ExpenseClaimService.recordPayment(actor, req.params.id, req.body, req.correlationId);
      res.json(paid);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_CLAIM_PAYMENT_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getSummaryReport(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const report = await ExpenseClaimService.getSummaryReport(actor);
      res.json(report);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EXPENSE_REPORT_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}
