import { prisma } from '../db/client.js';
import { AuthUser, ShiftItem, CreateShiftRequest, UpdateShiftRequest } from '../../shared/types.js';
import { AuditService } from './audit.service.js';

const TIME_FORMAT_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ShiftService {
  /**
   * Helper: Validates "HH:mm" 24-hour time string
   */
  private static validateTimeFormat(timeStr: string, fieldName: string): string {
    if (!timeStr || typeof timeStr !== 'string' || !TIME_FORMAT_REGEX.test(timeStr.trim())) {
      const err = new Error(`${fieldName} must be a valid 24-hour time format (HH:mm, e.g. "09:00" or "22:00").`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    return timeStr.trim();
  }

  /**
   * Lists shifts scoped to company
   */
  static async listShifts(
    companyId: string,
    includeInactive = false
  ): Promise<ShiftItem[]> {
    const where: { companyId: string; isActive?: boolean } = { companyId };
    if (!includeInactive) {
      where.isActive = true;
    }

    const shifts = await prisma.shift.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });

    return shifts.map((s) => ({
      id: s.id,
      companyId: s.companyId,
      code: s.code,
      name: s.name,
      startTime: s.startTime,
      endTime: s.endTime,
      isOvernight: s.isOvernight,
      graceMinutes: s.graceMinutes,
      halfDayMinutes: s.halfDayMinutes,
      isActive: s.isActive,
      description: s.description,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));
  }

  /**
   * Gets a shift by ID with strict company scoping
   */
  static async getShiftById(companyId: string, id: string): Promise<ShiftItem> {
    const shift = await prisma.shift.findUnique({
      where: { id },
    });

    if (!shift || shift.companyId !== companyId) {
      const err = new Error('Shift not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return {
      id: shift.id,
      companyId: shift.companyId,
      code: shift.code,
      name: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      isOvernight: shift.isOvernight,
      graceMinutes: shift.graceMinutes,
      halfDayMinutes: shift.halfDayMinutes,
      isActive: shift.isActive,
      description: shift.description,
      createdAt: shift.createdAt.toISOString(),
      updatedAt: shift.updatedAt.toISOString(),
    };
  }

  /**
   * Creates a new company-scoped shift
   */
  static async createShift(
    actor: AuthUser,
    input: CreateShiftRequest,
    correlationId?: string
  ): Promise<ShiftItem> {
    const trimmedCode = (input.code || '').trim().toUpperCase();
    const trimmedName = (input.name || '').trim();

    if (!trimmedCode) {
      const err = new Error('Shift code is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!trimmedName) {
      const err = new Error('Shift name is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const startTime = this.validateTimeFormat(input.startTime, 'Start time');
    const endTime = this.validateTimeFormat(input.endTime, 'End time');

    // Handle overnight shifts: if endTime <= startTime, shift spans midnight boundary
    let isOvernight = Boolean(input.isOvernight);
    if (endTime < startTime && !input.isOvernight) {
      // If end time is earlier than start time, it is an overnight shift
      isOvernight = true;
    }

    const graceMinutes = input.graceMinutes !== undefined ? Number(input.graceMinutes) : 15;
    if (isNaN(graceMinutes) || graceMinutes < 0) {
      const err = new Error('Grace minutes must be a non-negative number.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const halfDayMinutes = input.halfDayMinutes !== undefined ? Number(input.halfDayMinutes) : 240;
    if (isNaN(halfDayMinutes) || halfDayMinutes < 0) {
      const err = new Error('Half-day threshold must be a non-negative number.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check unique code in company
    const existingCode = await prisma.shift.findUnique({
      where: {
        companyId_code: {
          companyId: actor.companyId,
          code: trimmedCode,
        },
      },
    });

    if (existingCode) {
      const err = new Error(`Shift code '${trimmedCode}' already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const created = await prisma.shift.create({
      data: {
        companyId: actor.companyId,
        code: trimmedCode,
        name: trimmedName,
        startTime,
        endTime,
        isOvernight,
        graceMinutes,
        halfDayMinutes,
        isActive: true,
        description: input.description?.trim() || null,
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'SHIFT_CREATE',
      entity: 'Shift',
      entityId: created.id,
      correlationId,
      details: {
        code: created.code,
        name: created.name,
        startTime: created.startTime,
        endTime: created.endTime,
        isOvernight: created.isOvernight,
      },
    });

    return {
      id: created.id,
      companyId: created.companyId,
      code: created.code,
      name: created.name,
      startTime: created.startTime,
      endTime: created.endTime,
      isOvernight: created.isOvernight,
      graceMinutes: created.graceMinutes,
      halfDayMinutes: created.halfDayMinutes,
      isActive: created.isActive,
      description: created.description,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  /**
   * Updates an existing shift
   */
  static async updateShift(
    actor: AuthUser,
    id: string,
    input: UpdateShiftRequest,
    correlationId?: string
  ): Promise<ShiftItem> {
    const existing = await prisma.shift.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Shift not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const dataToUpdate: {
      code?: string;
      name?: string;
      startTime?: string;
      endTime?: string;
      isOvernight?: boolean;
      graceMinutes?: number;
      halfDayMinutes?: number;
      description?: string | null;
      isActive?: boolean;
    } = {};

    if (input.code !== undefined) {
      const trimmedCode = input.code.trim().toUpperCase();
      if (!trimmedCode) {
        const err = new Error('Shift code cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmedCode !== existing.code) {
        const duplicate = await prisma.shift.findUnique({
          where: {
            companyId_code: {
              companyId: actor.companyId,
              code: trimmedCode,
            },
          },
        });
        if (duplicate) {
          const err = new Error(`Shift code '${trimmedCode}' already exists in this company.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        dataToUpdate.code = trimmedCode;
      }
    }

    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (!trimmedName) {
        const err = new Error('Shift name cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      dataToUpdate.name = trimmedName;
    }

    let finalStartTime = existing.startTime;
    let finalEndTime = existing.endTime;

    if (input.startTime !== undefined) {
      finalStartTime = this.validateTimeFormat(input.startTime, 'Start time');
      dataToUpdate.startTime = finalStartTime;
    }

    if (input.endTime !== undefined) {
      finalEndTime = this.validateTimeFormat(input.endTime, 'End time');
      dataToUpdate.endTime = finalEndTime;
    }

    if (input.isOvernight !== undefined) {
      dataToUpdate.isOvernight = Boolean(input.isOvernight);
    } else if (input.startTime !== undefined || input.endTime !== undefined) {
      if (finalEndTime < finalStartTime && !existing.isOvernight) {
        dataToUpdate.isOvernight = true;
      }
    }

    if (input.graceMinutes !== undefined) {
      const grace = Number(input.graceMinutes);
      if (isNaN(grace) || grace < 0) {
        const err = new Error('Grace minutes must be a non-negative number.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      dataToUpdate.graceMinutes = grace;
    }

    if (input.halfDayMinutes !== undefined) {
      const halfDay = Number(input.halfDayMinutes);
      if (isNaN(halfDay) || halfDay < 0) {
        const err = new Error('Half-day threshold must be a non-negative number.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      dataToUpdate.halfDayMinutes = halfDay;
    }

    if (input.description !== undefined) {
      dataToUpdate.description = input.description?.trim() || null;
    }

    if (input.isActive !== undefined) {
      dataToUpdate.isActive = Boolean(input.isActive);
    }

    const updated = await prisma.shift.update({
      where: { id },
      data: dataToUpdate,
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'SHIFT_UPDATE',
      entity: 'Shift',
      entityId: updated.id,
      correlationId,
      details: { updatedFields: Object.keys(dataToUpdate) },
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      code: updated.code,
      name: updated.name,
      startTime: updated.startTime,
      endTime: updated.endTime,
      isOvernight: updated.isOvernight,
      graceMinutes: updated.graceMinutes,
      halfDayMinutes: updated.halfDayMinutes,
      isActive: updated.isActive,
      description: updated.description,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Deactivates a shift
   */
  static async deactivateShift(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<ShiftItem> {
    const existing = await prisma.shift.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Shift not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const updated = await prisma.shift.update({
      where: { id },
      data: { isActive: false },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'SHIFT_DEACTIVATE',
      entity: 'Shift',
      entityId: updated.id,
      correlationId,
      details: { code: updated.code, name: updated.name },
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      code: updated.code,
      name: updated.name,
      startTime: updated.startTime,
      endTime: updated.endTime,
      isOvernight: updated.isOvernight,
      graceMinutes: updated.graceMinutes,
      halfDayMinutes: updated.halfDayMinutes,
      isActive: updated.isActive,
      description: updated.description,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }
}
