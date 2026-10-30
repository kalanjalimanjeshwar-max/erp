import { Request, Response } from 'express';
import { EmployeeService } from '../services/employee.service.js';
import { AuthUser, EmployeeStatus } from '../../shared/types.js';

export class EmployeeController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const {
        departmentId,
        designationId,
        status,
        search,
        fromJoiningDate,
        toJoiningDate,
        page,
        limit,
      } = req.query;

      const result = await EmployeeService.listEmployees(
        actor.companyId,
        {
          departmentId: typeof departmentId === 'string' ? departmentId : undefined,
          designationId: typeof designationId === 'string' ? designationId : undefined,
          status: typeof status === 'string' ? (status as EmployeeStatus) : undefined,
          search: typeof search === 'string' ? search : undefined,
          fromJoiningDate: typeof fromJoiningDate === 'string' ? fromJoiningDate : undefined,
          toJoiningDate: typeof toJoiningDate === 'string' ? toJoiningDate : undefined,
        },
        {
          page: typeof page === 'string' ? parseInt(page, 10) : undefined,
          limit: typeof limit === 'string' ? parseInt(limit, 10) : undefined,
        }
      );

      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      // If EMPLOYEE role, check if they are requesting themselves
      if (actor.role === 'EMPLOYEE') {
        const selfProfile = await EmployeeService.getEmployeeForSelf(actor.companyId, actor.userId || actor.id);
        if (selfProfile.id !== req.params.id) {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: 'Employees are only permitted to view their own profile.',
            },
          });
          return;
        }
        res.json(selfProfile);
        return;
      }

      const employee = await EmployeeService.getEmployeeById(actor.companyId, req.params.id);
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * Self-service profile endpoint: derives identity exclusively from authenticated session
   */
  static async getSelf(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const profile = await EmployeeService.getEmployeeForSelf(actor.companyId, actor.userId || actor.id);
      res.json(profile);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_SELF_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employee = await EmployeeService.createEmployee(
        actor,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employee = await EmployeeService.updateEmployee(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_UPDATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async deactivate(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employee = await EmployeeService.deactivateEmployee(
        actor,
        req.params.id,
        req.headers['x-correlation-id'] as string
      );
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_DEACTIVATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async createLogin(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employee = await EmployeeService.createEmployeeLogin(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_LOGIN_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async toggleLogin(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const isActive = req.body.isActive === true;
      const employee = await EmployeeService.toggleEmployeeLoginStatus(
        actor,
        req.params.id,
        isActive,
        req.headers['x-correlation-id'] as string
      );
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_LOGIN_TOGGLE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async linkLedger(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employee = await EmployeeService.linkEmployeeLedger(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_LEDGER_LINK_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async listSalaries(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;

      // If EMPLOYEE role, can only view own salary
      if (actor.role === 'EMPLOYEE') {
        const selfProfile = await EmployeeService.getEmployeeForSelf(actor.companyId, actor.userId || actor.id);
        if (selfProfile.id !== req.params.id) {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: 'Employees are only permitted to view their own salary history.',
            },
          });
          return;
        }
      }

      const salaries = await EmployeeService.listSalaryRevisions(actor.companyId, req.params.id);
      res.json(salaries);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'SALARY_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async createSalaryRevision(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;

      // Ordinary employees cannot edit salary
      if (actor.role === 'EMPLOYEE') {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Employees cannot create or alter salary structure.',
          },
        });
        return;
      }

      const rev = await EmployeeService.createSalaryRevision(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(rev);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'SALARY_REVISION_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}
