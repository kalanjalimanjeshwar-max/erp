import { Request, Response, NextFunction } from 'express';
import { PermissionService } from '../services/permission.service.js';
import { prisma } from '../db/client.js';
import { AuditService } from '../services/audit.service.js';
import { Role, AppModule, AppAction } from '../../shared/types.js';

export class PermissionController {
  /**
   * GET /api/permissions/matrix
   */
  static async getMatrix(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const companyId = req.user!.companyId;
      const matrix = await PermissionService.getCompanyPermissionMatrix(companyId);
      res.status(200).json(matrix);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/permissions/override
   * Configures customized role permission override for the company
   */
  static async setOverride(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user!;
      const { role, module, action, isGranted } = req.body as {
        role: Role;
        module: AppModule;
        action: AppAction;
        isGranted: boolean;
      };

      if (!role || !module || !action || isGranted === undefined) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Fields (role, module, action, isGranted) are required.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      // ADMIN cannot modify SUPER_ADMIN permissions or grant permissions beyond their own ceiling
      if (actor.role === 'ADMIN') {
        if (role === 'SUPER_ADMIN') {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: 'Admins cannot modify Super Admin permissions.',
              timestamp: new Date().toISOString(),
            },
          });
          return;
        }

        const actorHasPerm = await PermissionService.hasPermission(actor.companyId, actor.role, module, action);
        if (!actorHasPerm) {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: 'Admins cannot grant permissions they do not possess.',
              timestamp: new Date().toISOString(),
            },
          });
          return;
        }
      }

      const override = await prisma.rolePermission.upsert({
        where: {
          companyId_role_module_action: {
            companyId: actor.companyId,
            role,
            module,
            action,
          },
        },
        create: {
          companyId: actor.companyId,
          role,
          module,
          action,
          isGranted: Boolean(isGranted),
        },
        update: {
          isGranted: Boolean(isGranted),
        },
      });

      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.id,
        action: 'PERMISSION_OVERRIDE_UPDATED',
        entity: 'RolePermission',
        entityId: override.id,
        severity: 'WARN',
        correlationId: req.correlationId,
        metadata: {
          role,
          module,
          action,
          isGranted,
        },
      });

      res.status(200).json({ success: true, override });
    } catch (error) {
      next(error);
    }
  }
}
