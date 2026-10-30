import { Request, Response, NextFunction } from 'express';
import { UserService } from '../services/user.service.js';
import { Role } from '../../shared/types.js';

export class UserController {
  /**
   * GET /api/users
   */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const search = req.query.search as string | undefined;
      const role = req.query.role as Role | undefined;
      const isActive = req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined;

      const users = await UserService.listCompanyUsers(companyId, {
        search,
        role,
        isActive,
      });

      res.status(200).json(users);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/users
   */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const { email, fullName, password, role, isActive, employeeId } = req.body;

      if (!email || !fullName || !password || !role) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'All fields (email, fullName, password, role) are required.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      if (typeof password !== 'string' || password.length < 8) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Password must be at least 8 characters long.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      const created = await UserService.createUser(
        actor,
        {
          email,
          fullName,
          password,
          role,
          isActive: isActive !== undefined ? Boolean(isActive) : true,
          employeeId: employeeId || undefined,
        },
        req.correlationId
      );

      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/users/:id/role
   */
  static async updateRole(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const targetUserId = req.params.id;
      const { role } = req.body;

      if (!role) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Role is required.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      await UserService.updateUserRole(actor, targetUserId, role, req.correlationId);
      res.status(200).json({ success: true, message: 'User role updated successfully.' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/users/:id/status
   */
  static async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const targetUserId = req.params.id;
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

      await UserService.updateUserStatus(actor, targetUserId, Boolean(isActive), req.correlationId);
      res.status(200).json({ success: true, message: 'User status updated successfully.' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/users/:id/reset-password
   */
  static async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const targetUserId = req.params.id;
      const { newPassword } = req.body;

      if (!newPassword || newPassword.length < 8) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'New password must be at least 8 characters long.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      await UserService.resetUserPassword(actor, targetUserId, newPassword, req.correlationId);
      res.status(200).json({ success: true, message: 'Password reset successfully.' });
    } catch (error) {
      next(error);
    }
  }
}
