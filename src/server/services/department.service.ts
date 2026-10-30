import { prisma } from '../db/client.js';
import {
  AuthUser,
  DepartmentItem,
  CreateDepartmentRequest,
  UpdateDepartmentRequest,
} from '../../shared/types.js';
import { AuditService } from './audit.service.js';

export class DepartmentService {
  /**
   * Lists departments scoped to company
   */
  static async listDepartments(
    companyId: string,
    includeInactive = false
  ): Promise<DepartmentItem[]> {
    const where: { companyId: string; isActive?: boolean } = { companyId };
    if (!includeInactive) {
      where.isActive = true;
    }

    const depts = await prisma.department.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { employees: true } },
      },
    });

    return depts.map((d) => ({
      id: d.id,
      companyId: d.companyId,
      code: d.code,
      name: d.name,
      description: d.description,
      isActive: d.isActive,
      employeeCount: d._count.employees,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    }));
  }

  /**
   * Gets single department by ID with company scoping
   */
  static async getDepartmentById(companyId: string, id: string): Promise<DepartmentItem> {
    const dept = await prisma.department.findUnique({
      where: { id },
      include: {
        _count: { select: { employees: true } },
      },
    });

    if (!dept || dept.companyId !== companyId) {
      const err = new Error('Department not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return {
      id: dept.id,
      companyId: dept.companyId,
      code: dept.code,
      name: dept.name,
      description: dept.description,
      isActive: dept.isActive,
      employeeCount: dept._count.employees,
      createdAt: dept.createdAt.toISOString(),
      updatedAt: dept.updatedAt.toISOString(),
    };
  }

  /**
   * Creates a new company-scoped department
   */
  static async createDepartment(
    actor: AuthUser,
    input: CreateDepartmentRequest,
    correlationId?: string
  ): Promise<DepartmentItem> {
    const trimmedCode = input.code.trim().toUpperCase();
    const trimmedName = input.name.trim();

    if (!trimmedCode) {
      const err = new Error('Department code is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!trimmedName) {
      const err = new Error('Department name is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check unique code in company
    const existingCode = await prisma.department.findUnique({
      where: { companyId_code: { companyId: actor.companyId, code: trimmedCode } },
    });
    if (existingCode) {
      const err = new Error(`Department code '${trimmedCode}' already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    // Check unique name in company
    const existingName = await prisma.department.findUnique({
      where: { companyId_name: { companyId: actor.companyId, name: trimmedName } },
    });
    if (existingName) {
      const err = new Error(`Department name '${trimmedName}' already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const created = await prisma.department.create({
      data: {
        companyId: actor.companyId,
        code: trimmedCode,
        name: trimmedName,
        description: input.description?.trim() || null,
        isActive: true,
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'DEPARTMENT_CREATE',
      entity: 'Department',
      entityId: created.id,
      correlationId,
      details: { code: created.code, name: created.name },
    });

    return {
      id: created.id,
      companyId: created.companyId,
      code: created.code,
      name: created.name,
      description: created.description,
      isActive: created.isActive,
      employeeCount: 0,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  /**
   * Updates an existing department
   */
  static async updateDepartment(
    actor: AuthUser,
    id: string,
    input: UpdateDepartmentRequest,
    correlationId?: string
  ): Promise<DepartmentItem> {
    const existing = await prisma.department.findUnique({ where: { id } });
    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Department not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const updateData: {
      code?: string;
      name?: string;
      description?: string | null;
      isActive?: boolean;
    } = {};

    if (input.code !== undefined) {
      const trimmedCode = input.code.trim().toUpperCase();
      if (!trimmedCode) {
        const err = new Error('Department code cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmedCode !== existing.code) {
        const duplicate = await prisma.department.findUnique({
          where: { companyId_code: { companyId: actor.companyId, code: trimmedCode } },
        });
        if (duplicate) {
          const err = new Error(`Department code '${trimmedCode}' already exists in this company.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        updateData.code = trimmedCode;
      }
    }

    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (!trimmedName) {
        const err = new Error('Department name cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmedName !== existing.name) {
        const duplicate = await prisma.department.findUnique({
          where: { companyId_name: { companyId: actor.companyId, name: trimmedName } },
        });
        if (duplicate) {
          const err = new Error(`Department name '${trimmedName}' already exists in this company.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        updateData.name = trimmedName;
      }
    }

    if (input.description !== undefined) {
      updateData.description = input.description?.trim() || null;
    }

    if (input.isActive !== undefined) {
      updateData.isActive = input.isActive;
    }

    const updated = await prisma.department.update({
      where: { id },
      data: updateData,
      include: {
        _count: { select: { employees: true } },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'DEPARTMENT_UPDATE',
      entity: 'Department',
      entityId: updated.id,
      correlationId,
      details: updateData,
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      code: updated.code,
      name: updated.name,
      description: updated.description,
      isActive: updated.isActive,
      employeeCount: updated._count.employees,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Deactivates a department (preserving references)
   */
  static async deactivateDepartment(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<DepartmentItem> {
    return this.updateDepartment(actor, id, { isActive: false }, correlationId);
  }
}
