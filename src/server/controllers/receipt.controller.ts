import { Request, Response } from 'express';
import { ReceiptService } from '../services/receipt.service.js';
import { AuthUser, ReceiptStatus } from '../../shared/types.js';

export class ReceiptController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { customerId, status, fromDate, toDate, search } = req.query;

      const receipts = await ReceiptService.listReceipts(actor.companyId, {
        customerId: typeof customerId === 'string' ? customerId : undefined,
        status: typeof status === 'string' ? (status as ReceiptStatus) : undefined,
        fromDate: typeof fromDate === 'string' ? fromDate : undefined,
        toDate: typeof toDate === 'string' ? toDate : undefined,
        search: typeof search === 'string' ? search : undefined,
      });

      res.json(receipts);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'RECEIPT_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const receipt = await ReceiptService.getReceiptById(actor.companyId, req.params.id);
      res.json(receipt);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'RECEIPT_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const receipt = await ReceiptService.createReceipt(
        actor,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(receipt);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'RECEIPT_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async void(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { reason } = req.body;
      if (!reason || !reason.trim()) {
        res.status(400).json({
          error: {
            code: 'VOID_REASON_REQUIRED',
            message: 'A void reason is required.',
          },
        });
        return;
      }

      const receipt = await ReceiptService.voidReceipt(
        actor,
        req.params.id,
        reason,
        req.headers['x-correlation-id'] as string
      );
      res.json(receipt);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'RECEIPT_VOID_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}
