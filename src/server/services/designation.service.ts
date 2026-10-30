import { prisma } from '../db/client.js';
import {
  AuthUser,
  DesignationItem,
  CreateDesignationRequest,
  UpdateDesignationRequest,
} from '../../shared/types.js';
import { AuditService } from './audit.service.js';

export class DesignationService {
  /**
   * Lists designations scoped to company
   */
  static async listDesignations(
    companyId: string,
    includeInactive = false
  ): Promise<DesignationItem[]> {
    const where: { companyId: string; isActive?: boolean } = { companyId };
    if (!includeInactive) {
      where.isActive = true;
    }

    const desigs = await prisma.designation.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { employees: true } },
      },
    });

    return desigs.map((d) => ({
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
   * Gets single designation by ID with company scoping
   */
  static async getDesignationById(companyId: string, id: string): Promise<DesignationItem> {
    const desig = await prisma.designation.findUnique({
      where: { id },
      include: {
        _count: { select: { employees: true } },
      },
    });

    if (!desig || desig.companyId !== companyId) {
      const err = new Error('Designation not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return {
      id: desig.id,
      companyId: desig.companyId,
      code: desig.code,
      name: desig.name,
      description: desig.description,
      isActive: desig.isActive,
      employeeCount: desig._count.employees,
      createdAt: desig.createdAt.toISOString(),
      updatedAt: desig.updatedAt.toISOString(),
    };
  }

  /**
   * Creates a new company-scoped designation
   */
  static async createDesignation(
    actor: AuthUser,
    input: CreateDesignationRequest,
    correlationId?: string
  ): Promise<DesignationItem> {
    const trimmedCode = input.code.trim().toUpperCase();
    const trimmedName = input.name.trim();

    if (!trimmedCode) {
      const err = new Error('Designation code is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!trimmedName) {
      const err = new Error('Designation name is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check unique code in company
    const existingCode = await prisma.designation.findUnique({
      where: { companyId_code: { companyId: actor.companyId, code: trimmedCode } },
    });
    if (existingCode) {
      const err = new Error(`Designation code '${trimmedCode}' already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    // Check unique name in company
    const existingName = await prisma.designation.findUnique({
      where: { companyId_name: { companyId: actor.companyId, name: trimmedName } },
    });
    if (existingName) {
      const err = new Error(`Designation name '${trimmedName}' already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const created = await prisma.designation.create({
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
      action: 'DESIGNATION_CREATE',
      entity: 'Designation',
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
   * Updates an existing designation
   */
  static async updateDesignation(
    actor: AuthUser,
    id: string,
    input: UpdateDesignationRequest,
    correlationId?: string
  ): Promise<DesignationItem> {
    const existing = await prisma.designation.findUnique({ where: { id } });
    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Designation not found in this company.');
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
        const err = new Error('Designation code cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmedCode !== existing.code) {
        const duplicate = await prisma.designation.findUnique({
          where: { companyId_code: { companyId: actor.companyId, code: trimmedCode } },
        });
        if (duplicate) {
          const err = new Error(`Designation code '${trimmedCode}' already exists in this company.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        updateData.code = trimmedCode;
      }
    }

    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (!trimmedName) {
        const err = new Error('Designation name cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmedName !== existing.name) {
        const duplicate = await prisma.designation.findUnique({
          where: { companyId_name: { companyId: actor.companyId, name: trimmedName } },
        });
        if (duplicate) {
          const err = new Error(`Designation name '${trimmedName}' already exists in this company.`);
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

    const updated = await prisma.designation.update({
      where: { id },
      data: updateData,
      include: {
        _count: { select: { employees: true } },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'DESIGNATION_UPDATE',
      entity: 'Designation',
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
   * Deactivates a designation (preserving references)
   */
  static async deactivateDesignation(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<DesignationItem> {
    return this.updateDesignation(actor, id, { isActive: false }, correlationId);
  }
}
