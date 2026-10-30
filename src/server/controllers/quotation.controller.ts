import { Request, Response } from 'express';
import { QuotationService } from '../services/quotation.service.js';
import { BillingService } from '../services/billing.service.js';
import { AuthUser, QuotationStatus } from '../../shared/types.js';

export class QuotationController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { status, customerId, search, fromDate, toDate } = req.query;

      const quotations = await QuotationService.listQuotations(actor.companyId, {
        status: typeof status === 'string' ? (status as QuotationStatus) : undefined,
        customerId: typeof customerId === 'string' ? customerId : undefined,
        search: typeof search === 'string' ? search : undefined,
        fromDate: typeof fromDate === 'string' ? fromDate : undefined,
        toDate: typeof toDate === 'string' ? toDate : undefined,
      });

      res.json(quotations);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'QUOTATION_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const quotation = await QuotationService.getQuotationById(actor.companyId, req.params.id);
      res.json(quotation);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'QUOTATION_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const quotation = await QuotationService.createQuotation(
        actor,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(quotation);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'QUOTATION_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const quotation = await QuotationService.updateQuotation(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.json(quotation);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'QUOTATION_UPDATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async updateStatus(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { status } = req.body;
      const quotation = await QuotationService.updateStatus(
        actor,
        req.params.id,
        status as QuotationStatus,
        req.headers['x-correlation-id'] as string
      );
      res.json(quotation);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'QUOTATION_STATUS_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async convertToInvoice(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const invoice = await BillingService.convertQuotationToInvoice(
        actor,
        req.params.id,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(invoice);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'QUOTATION_CONVERT_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}
