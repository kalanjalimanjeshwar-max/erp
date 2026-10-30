import { Request, Response, NextFunction } from 'express';
import { CoaService } from '../services/coa.service.js';
import { JournalService } from '../services/journal.service.js';
import { AccountingReportService } from '../services/accounting-report.service.js';
import {
  AccountRootType,
  JournalStatus,
  CreateAccountGroupRequest,
  CreateAccountLedgerRequest,
  UpdateAccountLedgerRequest,
  CreateJournalEntryRequest,
} from '../../shared/types.js';

export class AccountingController {
  // ==========================================
  // Chart of Accounts: Groups
  // ==========================================

  static async listGroups(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const groups = await CoaService.listGroups(companyId);
      res.status(200).json(groups);
    } catch (error) {
      next(error);
    }
  }

  static async createGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const input = req.body as CreateAccountGroupRequest;

      const group = await CoaService.createGroup(actor, input, req.correlationId);
      res.status(201).json(group);
    } catch (error) {
      next(error);
    }
  }

  // ==========================================
  // Chart of Accounts: Ledgers
  // ==========================================

  static async listLedgers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const groupId = req.query.groupId as string | undefined;
      const rootType = req.query.rootType as AccountRootType | undefined;
      const isActive = req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined;
      const search = req.query.search as string | undefined;

      const ledgers = await CoaService.listLedgers(companyId, {
        groupId,
        rootType,
        isActive,
        search,
      });

      res.status(200).json(ledgers);
    } catch (error) {
      next(error);
    }
  }

  static async createLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const input = req.body as CreateAccountLedgerRequest;

      const ledger = await CoaService.createLedger(actor, input, req.correlationId);
      res.status(201).json(ledger);
    } catch (error) {
      next(error);
    }
  }

  static async updateLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const ledgerId = req.params.id;
      const input = req.body as UpdateAccountLedgerRequest;

      const updated = await CoaService.updateLedger(actor, ledgerId, input, req.correlationId);
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  }

  static async toggleLedgerStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const ledgerId = req.params.id;
      const { isActive } = req.body;

      if (isActive === undefined) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'isActive boolean flag is required.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      await CoaService.toggleLedgerStatus(actor, ledgerId, Boolean(isActive), req.correlationId);
      res.status(200).json({ success: true, message: 'Ledger status updated successfully.' });
    } catch (error) {
      next(error);
    }
  }

  // ==========================================
  // Double-Entry Journals
  // ==========================================

  static async listJournals(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const status = req.query.status as JournalStatus | undefined;
      const fromDate = req.query.fromDate as string | undefined;
      const toDate = req.query.toDate as string | undefined;
      const ledgerId = req.query.ledgerId as string | undefined;
      const search = req.query.search as string | undefined;

      const journals = await JournalService.listJournals(companyId, {
        status,
        fromDate,
        toDate,
        ledgerId,
        search,
      });

      res.status(200).json(journals);
    } catch (error) {
      next(error);
    }
  }

  static async getJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const id = req.params.id;

      const journal = await JournalService.getJournalById(companyId, id);
      res.status(200).json(journal);
    } catch (error) {
      next(error);
    }
  }

  static async createJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const input = req.body as CreateJournalEntryRequest;

      const idempotencyKey =
        (req.headers['idempotency-key'] as string) || input.idempotencyKey;

      const journal = await JournalService.createJournal(
        actor,
        { ...input, idempotencyKey },
        req.correlationId
      );

      res.status(201).json(journal);
    } catch (error) {
      next(error);
    }
  }

  static async postJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const journalId = req.params.id;

      const journal = await JournalService.postJournal(actor, journalId, req.correlationId);
      res.status(200).json(journal);
    } catch (error) {
      next(error);
    }
  }

  static async reverseJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const journalId = req.params.id;
      const { reason } = req.body;

      if (!reason || !reason.trim()) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Reason for reversal is required.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      const result = await JournalService.reverseJournal(
        actor,
        journalId,
        reason.trim(),
        req.correlationId
      );

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  // ==========================================
  // Financial Reports
  // ==========================================

  static async validateOpeningBalances(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const validation = await AccountingReportService.validateOpeningBalances(companyId);
      res.status(200).json(validation);
    } catch (error) {
      next(error);
    }
  }

  static async getLedgerStatement(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const ledgerId = req.params.ledgerId;
      const fromDate = req.query.fromDate as string | undefined;
      const toDate = req.query.toDate as string | undefined;

      const report = await AccountingReportService.getLedgerStatement(companyId, ledgerId, {
        fromDate,
        toDate,
      });

      res.status(200).json(report);
    } catch (error) {
      next(error);
    }
  }

  static async getTrialBalance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const fromDate = req.query.fromDate as string | undefined;
      const toDate = req.query.toDate as string | undefined;

      const report = await AccountingReportService.getTrialBalance(companyId, {
        fromDate,
        toDate,
      });

      res.status(200).json(report);
    } catch (error) {
      next(error);
    }
  }

  static async getProfitAndLoss(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const fromDate = req.query.fromDate as string | undefined;
      const toDate = req.query.toDate as string | undefined;

      const report = await AccountingReportService.getProfitAndLoss(companyId, {
        fromDate,
        toDate,
      });

      res.status(200).json(report);
    } catch (error) {
      next(error);
    }
  }

  static async getBalanceSheet(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const asOfDate = req.query.asOfDate as string | undefined;

      const report = await AccountingReportService.getBalanceSheet(companyId, {
        asOfDate,
      });

      res.status(200).json(report);
    } catch (error) {
      next(error);
    }
  }

  static async getCashBook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const ledgerId = req.query.ledgerId as string | undefined;
      const fromDate = req.query.fromDate as string | undefined;
      const toDate = req.query.toDate as string | undefined;

      const report = await AccountingReportService.getCashBook(companyId, {
        ledgerId,
        fromDate,
        toDate,
      });

      res.status(200).json(report);
    } catch (error) {
      next(error);
    }
  }

  static async getBankBook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const ledgerId = req.query.ledgerId as string | undefined;
      const fromDate = req.query.fromDate as string | undefined;
      const toDate = req.query.toDate as string | undefined;

      const report = await AccountingReportService.getBankBook(companyId, {
        ledgerId,
        fromDate,
        toDate,
      });

      res.status(200).json(report);
    } catch (error) {
      next(error);
    }
  }
}
