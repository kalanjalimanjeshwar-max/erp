import { Request, Response } from 'express';
import { prisma } from '../db/client.js';
import { LeaveService } from '../services/leave.service.js';
import { AuthUser, LeaveStatus } from '../../shared/types.js';

export class LeaveController {
  // ==========================================================================
  // LEAVE TYPE HANDLERS
  // ==========================================================================

  static async listTypes(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const includeInactive = req.query.includeInactive === 'true';
      const types = await LeaveService.listLeaveTypes(actor.companyId, includeInactive);
      res.json(types);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'LEAVE_TYPE_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getTypeById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const type = await LeaveService.getLeaveTypeById(actor.companyId, req.params.id);
      res.json(type);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'LEAVE_TYPE_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async createType(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const created = await LeaveService.createLeaveType(actor, req.body, req.correlationId);
      res.status(201).json(created);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 409 ? 'LEAVE_TYPE_CONFLICT' : 'LEAVE_TYPE_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async updateType(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const updated = await LeaveService.updateLeaveType(actor, req.params.id, req.body, req.correlationId);
      res.json(updated);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 409 ? 'LEAVE_TYPE_CONFLICT' : 'LEAVE_TYPE_UPDATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async deactivateType(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const deactivated = await LeaveService.deactivateLeaveType(actor, req.params.id, req.correlationId);
      res.json(deactivated);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'LEAVE_TYPE_DEACTIVATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  // ==========================================================================
  // LEAVE REQUEST HANDLERS
  // ==========================================================================

  static async listRequests(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { employeeId, leaveTypeId, status, startDate, endDate, page, limit } = req.query;

      const result = await LeaveService.listLeaveRequests(
        actor,
        {
          employeeId: typeof employeeId === 'string' ? employeeId : undefined,
          leaveTypeId: typeof leaveTypeId === 'string' ? leaveTypeId : undefined,
          status: typeof status === 'string' ? (status as LeaveStatus) : undefined,
          startDate: typeof startDate === 'string' ? startDate : undefined,
          endDate: typeof endDate === 'string' ? endDate : undefined,
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
          code: 'LEAVE_REQUEST_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getRequestById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const record = await LeaveService.getLeaveRequestById(actor, req.params.id);
      res.json(record);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'LEAVE_REQUEST_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async submitRequest(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const record = await LeaveService.submitLeaveRequest(actor, req.body, req.correlationId);
      res.status(201).json(record);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'LEAVE_REQUEST_SUBMIT_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async approveRequest(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const record = await LeaveService.reviewLeaveRequest(actor, req.params.id, 'APPROVE', undefined, req.correlationId);
      res.json(record);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'LEAVE_REQUEST_APPROVE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async rejectRequest(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { rejectionReason } = req.body || {};
      const record = await LeaveService.reviewLeaveRequest(actor, req.params.id, 'REJECT', rejectionReason, req.correlationId);
      res.json(record);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'LEAVE_REQUEST_REJECT_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getSummary(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { employeeId, year, month } = req.query;
      const now = new Date();

      // Validate year (optional; integer 2000-2100)
      let parsedYear = now.getUTCFullYear();
      if (year !== undefined) {
        if (typeof year !== 'string' || !/^\d{4}$/.test(year.trim())) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Query parameter "year" must be an integer between 2000 and 2100.',
            },
          });
          return;
        }
        parsedYear = Number(year.trim());
        if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 2100) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Query parameter "year" must be an integer between 2000 and 2100.',
            },
          });
          return;
        }
      }

      // Validate month (optional; integer 1-12)
      let parsedMonth = now.getUTCMonth() + 1;
      if (month !== undefined) {
        if (typeof month !== 'string' || !/^\d{1,2}$/.test(month.trim())) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Query parameter "month" must be an integer between 1 and 12.',
            },
          });
          return;
        }
        parsedMonth = Number(month.trim());
        if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Query parameter "month" must be an integer between 1 and 12.',
            },
          });
          return;
        }
      }

      // Validate optional employeeId
      let validatedEmployeeId: string | undefined;
      if (employeeId !== undefined) {
        if (typeof employeeId !== 'string' || employeeId.trim().length === 0 || employeeId.trim().length > 128) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Query parameter "employeeId" must be a non-empty string.',
            },
          });
          return;
        }
        validatedEmployeeId = employeeId.trim();
      }

      // Enforce strict self-access for EMPLOYEE users: forbid inspecting another employee's summary
      if (actor.role === 'EMPLOYEE' && validatedEmployeeId) {
        const ownEmployee = await prisma.employee.findFirst({
          where: {
            companyId: actor.companyId,
            userId: actor.userId || actor.id,
          },
          select: { id: true },
        });
        if (!ownEmployee || ownEmployee.id !== validatedEmployeeId) {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: 'Employees are only permitted to view their own monthly leave summary.',
            },
          });
          return;
        }
      }

      const summary = await LeaveService.getMonthlyLeaveSummary(actor, {
        employeeId: actor.role === 'EMPLOYEE' ? undefined : validatedEmployeeId,
        year: parsedYear,
        month: parsedMonth,
      });

      res.json(summary);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      const code =
        status === 400
          ? 'VALIDATION_ERROR'
          : status === 403
          ? 'FORBIDDEN'
          : status === 404
          ? 'NOT_FOUND'
          : 'LEAVE_SUMMARY_FAILED';
      res.status(status).json({
        error: {
          code,
          message: (err as Error).message,
        },
      });
    }
  }
}
