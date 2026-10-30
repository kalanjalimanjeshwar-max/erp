import bcrypt from 'bcryptjs';
import { prisma } from '../db/client.js';
import { AuthUser, Role, UserListItem, CreateUserRequest } from '../../shared/types.js';
import { PermissionService } from './permission.service.js';
import { AuditService } from './audit.service.js';

export class UserService {
  /**
   * Lists users strictly scoped to the actor's company with optional search and filters
   * Never exposes password hashes or internal secrets
   */
  static async listCompanyUsers(
    companyId: string,
    filters?: { search?: string; role?: Role; isActive?: boolean }
  ): Promise<UserListItem[]> {
    const where: {
      companyId: string;
      role?: Role;
      isActive?: boolean;
      OR?: Array<{ email?: { contains: string; mode: 'insensitive' }; fullName?: { contains: string; mode: 'insensitive' } }>;
    } = {
      companyId,
    };

    if (filters?.role) {
      where.role = filters.role;
    }

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    if (filters?.search && filters.search.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { email: { contains: term, mode: 'insensitive' } },
        { fullName: { contains: term, mode: 'insensitive' } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        companyId: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
          },
        },
      },
    });

    return users.map((u) => ({
      ...u,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      createdAt: u.createdAt.toISOString(),
      employee: u.employee || null,
    }));
  }

  /**
   * Creates a new user in the actor's company
   * Enforces role assignment boundaries (ADMIN cannot create SUPER_ADMIN)
   */
  static async createUser(
    actor: AuthUser,
    input: CreateUserRequest,
    correlationId?: string
  ): Promise<UserListItem> {
    // 1. Role assignment authorization check
    if (!PermissionService.canAssignRole(actor.role, input.role)) {
      const err = new Error(`Role "${actor.role}" is not authorized to create a user with role "${input.role}".`);
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const email = input.email.trim().toLowerCase();

    // 2. Check duplicate email within company
    const existing = await prisma.user.findUnique({
      where: {
        companyId_email: {
          companyId: actor.companyId,
          email,
        },
      },
    });

    if (existing) {
      const err = new Error(`A user with email "${email}" already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(input.password, saltRounds);

    const user = await prisma.$transaction(async (tx) => {
      // Validate optional employee linkage
      if (input.employeeId) {
        const employee = await tx.employee.findFirst({
          where: {
            id: input.employeeId,
            companyId: actor.companyId,
          },
        });

        if (!employee) {
          const err = new Error('Selected employee record does not exist or does not belong to this company.');
          (err as { statusCode?: number }).statusCode = 404;
          throw err;
        }

        if (employee.userId) {
          const err = new Error('Selected employee already has a linked user login account.');
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
      }

      const newUser = await tx.user.create({
        data: {
          companyId: actor.companyId,
          email,
          fullName: input.fullName.trim(),
          passwordHash,
          role: input.role,
          isActive: input.isActive !== undefined ? input.isActive : true,
        },
      });

      if (input.employeeId) {
        await tx.employee.update({
          where: { id: input.employeeId },
          data: { userId: newUser.id },
        });
      }

      return newUser;
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'USER_CREATED',
      entity: 'User',
      entityId: user.id,
      severity: 'INFO',
      correlationId,
      metadata: {
        createdUserEmail: user.email,
        createdUserRole: user.role,
        isActive: user.isActive,
        linkedEmployeeId: input.employeeId || null,
      },
    });

    let linkedEmployee: { id: string; employeeCode: string; fullName: string } | null = null;
    if (input.employeeId) {
      const emp = await prisma.employee.findUnique({
        where: { id: input.employeeId },
        select: { id: true, employeeCode: true, fullName: true },
      });
      if (emp) {
        linkedEmployee = emp;
      }
    }

    return {
      id: user.id,
      companyId: user.companyId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      isActive: user.isActive,
      lastLoginAt: null,
      createdAt: user.createdAt.toISOString(),
      employee: linkedEmployee,
    };
  }

  /**
   * Updates a user's role with self-escalation protection and final SUPER_ADMIN safeguards
   */
  static async updateUserRole(
    actor: AuthUser,
    targetUserId: string,
    newRole: Role,
    correlationId?: string
  ): Promise<void> {
    // Self-escalation / Self-modification prevention
    if (actor.id === targetUserId && actor.role !== newRole) {
      const err = new Error('Users are not permitted to elevate or change their own role.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      const err = new Error('User not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Cross-company access check
    if (targetUser.companyId !== actor.companyId) {
      const err = new Error('Access denied. Cannot modify a user from another company.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // Role assignment authority check
    if (!PermissionService.canAssignRole(actor.role, newRole)) {
      const err = new Error(`Role "${actor.role}" cannot assign role "${newRole}".`);
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // If modifying existing SUPER_ADMIN, actor must also be SUPER_ADMIN
    if (targetUser.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      const err = new Error('Only a Super Admin can modify the role of another Super Admin.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // Final SUPER_ADMIN protection: cannot downgrade the last SUPER_ADMIN in the company
    if (targetUser.role === 'SUPER_ADMIN' && newRole !== 'SUPER_ADMIN') {
      const superAdminCount = await prisma.user.count({
        where: {
          companyId: actor.companyId,
          role: 'SUPER_ADMIN',
          isActive: true,
        },
      });

      if (superAdminCount <= 1) {
        const err = new Error('Cannot downgrade the final active Super Administrator. Assign another Super Admin first.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    await prisma.user.update({
      where: { id: targetUserId },
      data: {
        role: newRole,
        tokenVersion: { increment: 1 }, // Invalidate sessions on role change
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'USER_ROLE_CHANGED',
      entity: 'User',
      entityId: targetUserId,
      severity: 'WARN',
      correlationId,
      metadata: {
        targetUserEmail: targetUser.email,
        oldRole: targetUser.role,
        newRole,
      },
    });
  }

  /**
   * Toggles active/inactive status (soft deactivation)
   * Protects the final SUPER_ADMIN from deactivation
   */
  static async updateUserStatus(
    actor: AuthUser,
    targetUserId: string,
    isActive: boolean,
    correlationId?: string
  ): Promise<void> {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      const err = new Error('User not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Cross-company check
    if (targetUser.companyId !== actor.companyId) {
      const err = new Error('Access denied. Cannot modify a user from another company.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // Self-deactivation prevention
    if (actor.id === targetUserId && !isActive) {
      const err = new Error('Administrators cannot deactivate their own account.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Final SUPER_ADMIN protection
    if (targetUser.role === 'SUPER_ADMIN' && !isActive) {
      const activeSuperAdminCount = await prisma.user.count({
        where: {
          companyId: actor.companyId,
          role: 'SUPER_ADMIN',
          isActive: true,
        },
      });

      if (activeSuperAdminCount <= 1) {
        const err = new Error('Cannot deactivate the sole active Super Administrator.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    await prisma.user.update({
      where: { id: targetUserId },
      data: {
        isActive,
        tokenVersion: { increment: 1 }, // Revoke all active sessions
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      entity: 'User',
      entityId: targetUserId,
      severity: 'WARN',
      correlationId,
      metadata: {
        targetUserEmail: targetUser.email,
        newStatus: isActive ? 'ACTIVE' : 'INACTIVE',
      },
    });
  }

  /**
   * Authorized administrative password reset
   */
  static async resetUserPassword(
    actor: AuthUser,
    targetUserId: string,
    newPassword: string,
    correlationId?: string
  ): Promise<void> {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      const err = new Error('User not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (targetUser.companyId !== actor.companyId) {
      const err = new Error('Access denied.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // Only SUPER_ADMIN can reset another SUPER_ADMIN's password
    if (targetUser.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      const err = new Error('Only a Super Admin can reset the password of another Super Admin.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    await prisma.user.update({
      where: { id: targetUserId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 }, // Revoke old sessions
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'USER_PASSWORD_RESET',
      entity: 'User',
      entityId: targetUserId,
      severity: 'WARN',
      correlationId,
      metadata: {
        targetUserEmail: targetUser.email,
        resetBy: actor.email,
      },
    });
  }
}
