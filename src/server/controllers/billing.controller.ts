import { Request, Response } from 'express';
import { BillingService } from '../services/billing.service.js';
import { AuthUser, InvoiceStatus } from '../../shared/types.js';

export class BillingController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { status, customerId, search, fromDate, toDate } = req.query;

      const invoices = await BillingService.listInvoices(actor.companyId, {
        status: typeof status === 'string' ? (status as InvoiceStatus) : undefined,
        customerId: typeof customerId === 'string' ? customerId : undefined,
        search: typeof search === 'string' ? search : undefined,
        fromDate: typeof fromDate === 'string' ? fromDate : undefined,
        toDate: typeof toDate === 'string' ? toDate : undefined,
      });

      res.json(invoices);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'INVOICE_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const invoice = await BillingService.getInvoiceById(actor.companyId, req.params.id);
      res.json(invoice);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'INVOICE_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const invoice = await BillingService.createInvoice(
        actor,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(invoice);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'INVOICE_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async issue(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const invoice = await BillingService.issueInvoice(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.json(invoice);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'INVOICE_ISSUE_FAILED',
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

      const invoice = await BillingService.voidInvoice(
        actor,
        req.params.id,
        reason,
        req.headers['x-correlation-id'] as string
      );
      res.json(invoice);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'INVOICE_VOID_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}
