import { Request, Response } from 'express';
import { AttendanceService } from '../services/attendance.service.js';
import { AuthUser, AttendanceStatus } from '../../shared/types.js';

export class AttendanceController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const { employeeId, status, startDate, endDate, page, limit } = req.query;

      const result = await AttendanceService.listAttendance(
        actor,
        {
          employeeId: typeof employeeId === 'string' ? employeeId : undefined,
          status: typeof status === 'string' ? (status as AttendanceStatus) : undefined,
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
          code: 'ATTENDANCE_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const record = await AttendanceService.getAttendanceById(actor, req.params.id);
      res.json(record);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'ATTENDANCE_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const record = await AttendanceService.createAttendance(actor, req.body, req.correlationId);
      res.status(201).json(record);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 409 ? 'ATTENDANCE_CONFLICT' : 'ATTENDANCE_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const record = await AttendanceService.updateAttendance(actor, req.params.id, req.body, req.correlationId);
      res.json(record);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'ATTENDANCE_UPDATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getWorkingHoursSummary(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
      const summary = await AttendanceService.getWorkingHoursSummary(actor, employeeId);
      res.json(summary);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'WORKING_HOURS_SUMMARY_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getAdminNotifications(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const notifications = await AttendanceService.getAdminNotifications(actor);
      res.json(notifications);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'ADMIN_NOTIFICATIONS_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }
}

