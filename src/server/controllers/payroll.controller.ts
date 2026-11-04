import { Request, Response } from 'express';
import { PayrollService } from '../services/payroll.service.js';
import { AuthUser, PayrollStatus, PayslipStatus } from '../../shared/types.js';

export class PayrollController {
  static async listPeriods(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { year, status } = req.query;

      const periods = await PayrollService.listPeriods(actor, {
        year: typeof year === 'string' ? parseInt(year, 10) : undefined,
        status: typeof status === 'string' ? (status as PayrollStatus) : undefined,
      });

      res.json(periods);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 403 ? 'FORBIDDEN' : 'PAYROLL_PERIOD_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getPeriodById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const period = await PayrollService.getPeriodById(actor, req.params.id);
      res.json(period);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 403 ? 'FORBIDDEN' : 'PAYROLL_PERIOD_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async createPeriod(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const created = await PayrollService.createPeriod(actor, req.body, req.correlationId);
      res.status(201).json(created);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 409 ? 'PAYROLL_PERIOD_CONFLICT' : 'PAYROLL_PERIOD_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async processPeriod(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const processed = await PayrollService.processPeriod(actor, req.params.id, req.correlationId);
      res.json(processed);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'PAYROLL_PROCESS_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async approveAccounts(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { notes } = req.body || {};
      const approved = await PayrollService.approveAccounts(
        actor,
        req.params.id,
        notes,
        req.correlationId
      );
      res.json(approved);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code:
            status === 403
              ? 'FORBIDDEN'
              : status === 404
              ? 'PAYROLL_PERIOD_NOT_FOUND'
              : 'PAYROLL_ACCOUNTS_APPROVAL_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async postPeriod(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const posted = await PayrollService.postPeriod(actor, req.params.id, req.body, req.correlationId);
      res.json(posted);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'PAYROLL_POST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async cancelPeriod(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const cancelled = await PayrollService.cancelPeriod(actor, req.params.id, req.correlationId);
      res.json(cancelled);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'PAYROLL_CANCEL_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async listPayslips(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { employeeId, status } = req.query;

      const payslips = await PayrollService.listPayslips(actor, req.params.id, {
        employeeId: typeof employeeId === 'string' ? employeeId : undefined,
        status: typeof status === 'string' ? (status as PayslipStatus) : undefined,
      });

      res.json(payslips);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'PAYSLIP_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async listMyPayslips(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { year } = req.query;

      const payslips = await PayrollService.listMyPayslips(actor, {
        year: typeof year === 'string' ? parseInt(year, 10) : undefined,
      });

      res.json(payslips);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 404 ? 'EMPLOYEE_NOT_FOUND' : 'MY_PAYSLIPS_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getPayslipById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const payslip = await PayrollService.getPayslipById(actor, req.params.id);
      res.json(payslip);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 403 ? 'FORBIDDEN' : 'PAYSLIP_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }
}
