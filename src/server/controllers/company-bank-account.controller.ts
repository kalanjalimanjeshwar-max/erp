import { Request, Response, NextFunction } from 'express';
import { CompanyBankAccountService } from '../services/company-bank-account.service.js';

export class CompanyBankAccountController {
  /**
   * GET /api/company/bank-accounts
   * List company bank accounts with optional isActive filter
   */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const isActiveQuery = req.query.isActive;
      const isActive =
        isActiveQuery !== undefined
          ? isActiveQuery === 'true' || isActiveQuery === '1'
          : undefined;

      const accounts = await CompanyBankAccountService.listBankAccounts(actor, {
        isActive,
      });
      res.status(200).json(accounts);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/company/bank-accounts/:id
   * Retrieve a specific bank account with masked sensitive credentials
   */
  static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const { id } = req.params;
      const account = await CompanyBankAccountService.getBankAccountById(actor, id);
      res.status(200).json(account);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/company/bank-accounts
   * Create a new corporate bank account
   */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const correlationId =
        req.correlationId || (req.headers?.['x-correlation-id'] as string | undefined);
      const created = await CompanyBankAccountService.createBankAccount(
        actor,
        req.body,
        correlationId
      );
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/company/bank-accounts/:id
   * Update an existing corporate bank account
   */
  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const { id } = req.params;
      const correlationId =
        req.correlationId || (req.headers?.['x-correlation-id'] as string | undefined);
      const updated = await CompanyBankAccountService.updateBankAccount(
        actor,
        id,
        req.body,
        correlationId
      );
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/company/bank-accounts/:id/default
   * Designate an account as the active default
   */
  static async setDefault(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const { id } = req.params;
      const correlationId =
        req.correlationId || (req.headers?.['x-correlation-id'] as string | undefined);
      const updated = await CompanyBankAccountService.setDefaultAccount(
        actor,
        id,
        correlationId
      );
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/company/bank-accounts/:id/status
   * Activate or deactivate a bank account
   */
  static async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const { id } = req.params;
      const { isActive } = req.body;
      const correlationId =
        req.correlationId || (req.headers?.['x-correlation-id'] as string | undefined);

      if (typeof isActive !== 'boolean') {
        const err = new Error('Field "isActive" must be a boolean (true or false).');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      const updated = isActive
        ? await CompanyBankAccountService.activateBankAccount(actor, id, correlationId)
        : await CompanyBankAccountService.deactivateBankAccount(actor, id, correlationId);

      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/company/bank-accounts/:id
   * Safely delete a non-default bank account
   */
  static async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const { id } = req.params;
      const correlationId =
        req.correlationId || (req.headers?.['x-correlation-id'] as string | undefined);
      const result = await CompanyBankAccountService.deleteBankAccount(
        actor,
        id,
        correlationId
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
