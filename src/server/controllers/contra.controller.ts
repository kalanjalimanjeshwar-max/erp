import { Request, Response, NextFunction } from 'express';
import { ContraService } from '../services/contra.service.js';
import { CreateContraEntryRequest, JournalStatus } from '../../shared/types.js';

export class ContraController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const status = req.query.status as JournalStatus | undefined;
      const fromDate = req.query.fromDate as string | undefined;
      const toDate = req.query.toDate as string | undefined;
      const search = req.query.search as string | undefined;

      const entries = await ContraService.listContraEntries(companyId, {
        status,
        fromDate,
        toDate,
        search,
      });

      res.status(200).json(entries);
    } catch (error) {
      next(error);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const id = req.params.id;

      const entry = await ContraService.getContraEntryById(companyId, id);
      res.status(200).json(entry);
    } catch (error) {
      next(error);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const input = req.body as CreateContraEntryRequest;

      const idempotencyKey =
        (req.headers['idempotency-key'] as string) || input.idempotencyKey;

      const entry = await ContraService.createContraEntry(
        actor,
        { ...input, idempotencyKey },
        req.correlationId
      );

      res.status(201).json(entry);
    } catch (error) {
      next(error);
    }
  }

  static async post(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const id = req.params.id;

      const entry = await ContraService.postContraEntry(actor, id, req.correlationId);
      res.status(200).json(entry);
    } catch (error) {
      next(error);
    }
  }

  static async reverse(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const id = req.params.id;
      const { reason } = req.body;

      if (!reason || !reason.trim()) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Reason for contra reversal is required.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      const result = await ContraService.reverseContraEntry(
        actor,
        id,
        reason.trim(),
        req.correlationId
      );

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
