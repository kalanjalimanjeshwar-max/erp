import { prisma } from '../db/client.js';
import {
  AuthUser,
  LeaveTypeItem,
  CreateLeaveTypeRequest,
  UpdateLeaveTypeRequest,
  LeaveRequestItem,
  CreateLeaveRequestInput,
  LeaveStatus,
  MonthlyLeaveSummary,
} from '../../shared/types.js';
import { AuditService } from './audit.service.js';
import { Decimal, AccountingMath } from '../accounting/decimal-math.js';

const VALID_LEAVE_STATUSES: LeaveStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

export class LeaveService {
  /**
   * Helper: Resolves employee ID for self-service employee queries
   */
  private static async getEmployeeIdForUser(companyId: string, userId: string): Promise<string> {
    const employee = await prisma.employee.findFirst({
      where: {
        companyId,
        userId,
      },
      select: { id: true },
    });

    if (!employee) {
      const err = new Error('No employee record found for your user account.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return employee.id;
  }

  // ==========================================================================
  // LEAVE TYPE MANAGEMENT
  // ==========================================================================

  /**
   * Lists company-scoped leave types
   */
  static async listLeaveTypes(
    companyId: string,
    includeInactive = false
  ): Promise<LeaveTypeItem[]> {
    const where: { companyId: string; isActive?: boolean } = { companyId };
    if (!includeInactive) {
      where.isActive = true;
    }

    const types = await prisma.leaveType.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });

    return types.map((t) => ({
      id: t.id,
      companyId: t.companyId,
      code: t.code,
      name: t.name,
      description: t.description,
      isPaid: t.isPaid,
      defaultAllowance: t.defaultAllowance,
      isActive: t.isActive,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));
  }

  /**
   * Gets leave type by ID with company scoping
   */
  static async getLeaveTypeById(companyId: string, id: string): Promise<LeaveTypeItem> {
    const leaveType = await prisma.leaveType.findUnique({
      where: { id },
    });

    if (!leaveType || leaveType.companyId !== companyId) {
      const err = new Error('Leave type not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return {
      id: leaveType.id,
      companyId: leaveType.companyId,
      code: leaveType.code,
      name: leaveType.name,
      description: leaveType.description,
      isPaid: leaveType.isPaid,
      defaultAllowance: leaveType.defaultAllowance,
      isActive: leaveType.isActive,
      createdAt: leaveType.createdAt.toISOString(),
      updatedAt: leaveType.updatedAt.toISOString(),
    };
  }

  /**
   * Creates a company-scoped leave type
   */
  static async createLeaveType(
    actor: AuthUser,
    input: CreateLeaveTypeRequest,
    correlationId?: string
  ): Promise<LeaveTypeItem> {
    const trimmedCode = (input.code || '').trim().toUpperCase();
    const trimmedName = (input.name || '').trim();

    if (!trimmedCode) {
      const err = new Error('Leave type code is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!trimmedName) {
      const err = new Error('Leave type name is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const defaultAllowance = input.defaultAllowance !== undefined ? Number(input.defaultAllowance) : 12;
    if (isNaN(defaultAllowance) || defaultAllowance < 0) {
      const err = new Error('Default allowance must be a non-negative number.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check unique code
    const existingCode = await prisma.leaveType.findUnique({
      where: {
        companyId_code: {
          companyId: actor.companyId,
          code: trimmedCode,
        },
      },
    });

    if (existingCode) {
      const err = new Error(`Leave type code '${trimmedCode}' already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    // Check unique name
    const existingName = await prisma.leaveType.findUnique({
      where: {
        companyId_name: {
          companyId: actor.companyId,
          name: trimmedName,
        },
      },
    });

    if (existingName) {
      const err = new Error(`Leave type name '${trimmedName}' already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const created = await prisma.leaveType.create({
      data: {
        companyId: actor.companyId,
        code: trimmedCode,
        name: trimmedName,
        description: input.description?.trim() || null,
        isPaid: input.isPaid !== undefined ? Boolean(input.isPaid) : true,
        defaultAllowance,
        isActive: true,
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'LEAVE_TYPE_CREATE',
      entity: 'LeaveType',
      entityId: created.id,
      correlationId,
      details: { code: created.code, name: created.name, isPaid: created.isPaid },
    });

    return {
      id: created.id,
      companyId: created.companyId,
      code: created.code,
      name: created.name,
      description: created.description,
      isPaid: created.isPaid,
      defaultAllowance: created.defaultAllowance,
      isActive: created.isActive,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  /**
   * Updates an existing leave type
   */
  static async updateLeaveType(
    actor: AuthUser,
    id: string,
    input: UpdateLeaveTypeRequest,
    correlationId?: string
  ): Promise<LeaveTypeItem> {
    const existing = await prisma.leaveType.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Leave type not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const dataToUpdate: {
      code?: string;
      name?: string;
      description?: string | null;
      isPaid?: boolean;
      defaultAllowance?: number;
      isActive?: boolean;
    } = {};

    if (input.code !== undefined) {
      const trimmedCode = input.code.trim().toUpperCase();
      if (!trimmedCode) {
        const err = new Error('Leave type code cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmedCode !== existing.code) {
        const duplicate = await prisma.leaveType.findUnique({
          where: {
            companyId_code: {
              companyId: actor.companyId,
              code: trimmedCode,
            },
          },
        });
        if (duplicate) {
          const err = new Error(`Leave type code '${trimmedCode}' already exists in this company.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        dataToUpdate.code = trimmedCode;
      }
    }

    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (!trimmedName) {
        const err = new Error('Leave type name cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmedName !== existing.name) {
        const duplicate = await prisma.leaveType.findUnique({
          where: {
            companyId_name: {
              companyId: actor.companyId,
              name: trimmedName,
            },
          },
        });
        if (duplicate) {
          const err = new Error(`Leave type name '${trimmedName}' already exists in this company.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        dataToUpdate.name = trimmedName;
      }
    }

    if (input.description !== undefined) {
      dataToUpdate.description = input.description?.trim() || null;
    }

    if (input.isPaid !== undefined) {
      dataToUpdate.isPaid = Boolean(input.isPaid);
    }

    if (input.defaultAllowance !== undefined) {
      const allowance = Number(input.defaultAllowance);
      if (isNaN(allowance) || allowance < 0) {
        const err = new Error('Default allowance must be a non-negative number.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      dataToUpdate.defaultAllowance = allowance;
    }

    if (input.isActive !== undefined) {
      dataToUpdate.isActive = Boolean(input.isActive);
    }

    const updated = await prisma.leaveType.update({
      where: { id },
      data: dataToUpdate,
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'LEAVE_TYPE_UPDATE',
      entity: 'LeaveType',
      entityId: updated.id,
      correlationId,
      details: { updatedFields: Object.keys(dataToUpdate) },
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      code: updated.code,
      name: updated.name,
      description: updated.description,
      isPaid: updated.isPaid,
      defaultAllowance: updated.defaultAllowance,
      isActive: updated.isActive,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Deactivates a leave type safely
   */
  static async deactivateLeaveType(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<LeaveTypeItem> {
    const existing = await prisma.leaveType.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Leave type not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const updated = await prisma.leaveType.update({
      where: { id },
      data: { isActive: false },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'LEAVE_TYPE_DEACTIVATE',
      entity: 'LeaveType',
      entityId: updated.id,
      correlationId,
      details: { code: updated.code, name: updated.name },
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      code: updated.code,
      name: updated.name,
      description: updated.description,
      isPaid: updated.isPaid,
      defaultAllowance: updated.defaultAllowance,
      isActive: updated.isActive,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  // ==========================================================================
  // LEAVE REQUEST MANAGEMENT
  // ==========================================================================

  /**
   * Lists leave requests scoped to company and permissions
   */
  static async listLeaveRequests(
    actor: AuthUser,
    filters?: {
      employeeId?: string;
      leaveTypeId?: string;
      status?: LeaveStatus;
      startDate?: string;
      endDate?: string;
    },
    pagination?: {
      page?: number;
      limit?: number;
    }
  ): Promise<{ items: LeaveRequestItem[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, pagination?.page || 1);
    const limit = Math.min(100, Math.max(1, pagination?.limit || 20));
    const skip = (page - 1) * limit;

    const where: {
      companyId: string;
      employeeId?: string;
      leaveTypeId?: string;
      status?: LeaveStatus;
      startDate?: { gte?: Date };
      endDate?: { lte?: Date };
    } = { companyId: actor.companyId };

    // If EMPLOYEE role, restrict strictly to their own employee ID
    if (actor.role === 'EMPLOYEE') {
      const selfEmployeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
      where.employeeId = selfEmployeeId;
    } else if (filters?.employeeId) {
      where.employeeId = filters.employeeId;
    }

    if (filters?.leaveTypeId) {
      where.leaveTypeId = filters.leaveTypeId;
    }

    if (filters?.status) {
      if (!VALID_LEAVE_STATUSES.includes(filters.status)) {
        const err = new Error(`Invalid leave status '${filters.status}'.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      where.status = filters.status;
    }

    if (filters?.startDate) {
      where.startDate = { gte: new Date(`${filters.startDate}T00:00:00.000Z`) };
    }
    if (filters?.endDate) {
      where.endDate = { lte: new Date(`${filters.endDate}T23:59:59.999Z`) };
    }

    const [total, records] = await Promise.all([
      prisma.leaveRequest.count({ where }),
      prisma.leaveRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }],
        include: {
          employee: { select: { employeeCode: true, fullName: true } },
          leaveType: { select: { code: true, name: true } },
          reviewedByUser: { select: { fullName: true } },
        },
      }),
    ]);

    const items: LeaveRequestItem[] = records.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      employeeId: r.employeeId,
      employeeCode: r.employee.employeeCode,
      employeeName: r.employee.fullName,
      leaveTypeId: r.leaveTypeId,
      leaveTypeCode: r.leaveType.code,
      leaveTypeName: r.leaveType.name,
      startDate: r.startDate.toISOString().split('T')[0],
      endDate: r.endDate.toISOString().split('T')[0],
      totalDays: Number(r.totalDays),
      reason: r.reason,
      status: r.status as LeaveStatus,
      reviewedByUserId: r.reviewedByUserId,
      reviewedByUserName: r.reviewedByUser?.fullName || null,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      rejectionReason: r.rejectionReason,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return { items, total, page, limit };
  }

  /**
   * Gets single leave request by ID with company and employee scoping
   */
  static async getLeaveRequestById(actor: AuthUser, id: string): Promise<LeaveRequestItem> {
    const record = await prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        employee: { select: { employeeCode: true, fullName: true, userId: true } },
        leaveType: { select: { code: true, name: true } },
        reviewedByUser: { select: { fullName: true } },
      },
    });

    if (!record || record.companyId !== actor.companyId) {
      const err = new Error('Leave request not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // If EMPLOYEE role, verify it belongs to actor
    if (actor.role === 'EMPLOYEE') {
      const selfEmployeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
      if (record.employeeId !== selfEmployeeId) {
        const err = new Error('Employees are only permitted to view their own leave requests.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }
    }

    return {
      id: record.id,
      companyId: record.companyId,
      employeeId: record.employeeId,
      employeeCode: record.employee.employeeCode,
      employeeName: record.employee.fullName,
      leaveTypeId: record.leaveTypeId,
      leaveTypeCode: record.leaveType.code,
      leaveTypeName: record.leaveType.name,
      startDate: record.startDate.toISOString().split('T')[0],
      endDate: record.endDate.toISOString().split('T')[0],
      totalDays: Number(record.totalDays),
      reason: record.reason,
      status: record.status as LeaveStatus,
      reviewedByUserId: record.reviewedByUserId,
      reviewedByUserName: record.reviewedByUser?.fullName || null,
      reviewedAt: record.reviewedAt ? record.reviewedAt.toISOString() : null,
      rejectionReason: record.rejectionReason,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /**
   * Submits a leave request
   */
  static async submitLeaveRequest(
    actor: AuthUser,
    input: CreateLeaveRequestInput,
    correlationId?: string
  ): Promise<LeaveRequestItem> {
    let employeeId = input.employeeId;

    if (actor.role === 'EMPLOYEE') {
      employeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
    } else {
      if (!employeeId) {
        const err = new Error('Employee ID is required.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      const emp = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, companyId: true },
      });
      if (!emp || emp.companyId !== actor.companyId) {
        const err = new Error('Employee not found in this company.');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }
    }

    // Validate leaveType
    if (!input.leaveTypeId) {
      const err = new Error('Leave type ID is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const leaveType = await prisma.leaveType.findUnique({
      where: { id: input.leaveTypeId },
      select: { id: true, companyId: true, isActive: true, code: true, name: true },
    });

    if (!leaveType || leaveType.companyId !== actor.companyId) {
      const err = new Error('Leave type not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!leaveType.isActive) {
      const err = new Error(`Leave type '${leaveType.name}' is deactivated and cannot accept new requests.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Validate date format YYYY-MM-DD
    const startStr = (input.startDate || '').trim();
    const endStr = (input.endDate || '').trim();

    if (!startStr || !/^\d{4}-\d{2}-\d{2}$/.test(startStr)) {
      const err = new Error('Start date is required and must be in YYYY-MM-DD format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!endStr || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
      const err = new Error('End date is required and must be in YYYY-MM-DD format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const startDate = new Date(`${startStr}T00:00:00.000Z`);
    const endDate = new Date(`${endStr}T00:00:00.000Z`);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      const err = new Error('Invalid start or end date format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (endDate.getTime() < startDate.getTime()) {
      const err = new Error('End date cannot be earlier than start date.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Validate or calculate totalDays
    let totalDays: number;
    if (input.totalDays !== undefined && input.totalDays !== null) {
      totalDays = Number(input.totalDays);
      if (isNaN(totalDays) || totalDays <= 0) {
        const err = new Error('Total days must be a positive number.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    } else {
      const dayDiff = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      totalDays = Math.max(1, dayDiff);
    }

    const created = await prisma.leaveRequest.create({
      data: {
        companyId: actor.companyId,
        employeeId,
        leaveTypeId: leaveType.id,
        startDate,
        endDate,
        totalDays,
        reason: input.reason?.trim() || null,
        status: 'PENDING',
      },
      include: {
        employee: { select: { employeeCode: true, fullName: true } },
        leaveType: { select: { code: true, name: true } },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'LEAVE_REQUEST_SUBMIT',
      entity: 'LeaveRequest',
      entityId: created.id,
      correlationId,
      details: {
        employeeId,
        leaveTypeId: leaveType.id,
        startDate: startStr,
        endDate: endStr,
        totalDays,
      },
    });

    return {
      id: created.id,
      companyId: created.companyId,
      employeeId: created.employeeId,
      employeeCode: created.employee.employeeCode,
      employeeName: created.employee.fullName,
      leaveTypeId: created.leaveTypeId,
      leaveTypeCode: created.leaveType.code,
      leaveTypeName: created.leaveType.name,
      startDate: created.startDate.toISOString().split('T')[0],
      endDate: created.endDate.toISOString().split('T')[0],
      totalDays: Number(created.totalDays),
      reason: created.reason,
      status: created.status as LeaveStatus,
      reviewedByUserId: null,
      reviewedByUserName: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  /**
   * Reviews a pending leave request (Approve or Reject)
   */
  static async reviewLeaveRequest(
    actor: AuthUser,
    id: string,
    action: 'APPROVE' | 'REJECT',
    rejectionReason?: string,
    correlationId?: string
  ): Promise<LeaveRequestItem> {
    // 1. Role enforcement: Employees cannot approve or reject leave requests
    if (actor.role === 'EMPLOYEE') {
      const err = new Error('Employees are not authorized to review leave requests.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const existing = await prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        employee: { select: { employeeCode: true, fullName: true, userId: true } },
        leaveType: { select: { code: true, name: true } },
      },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Leave request not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // 2. Prevent self-review (reviewing actor cannot be the employee whose leave is requested)
    if (existing.employee.userId && existing.employee.userId === (actor.userId || actor.id)) {
      const err = new Error('Managers and administrators cannot review their own leave requests.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // 3. Status validation: Only PENDING requests may be reviewed
    if (existing.status !== 'PENDING') {
      const err = new Error(`Only pending leave requests can be reviewed. Current status is ${existing.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // 4. Validate rejection reason if rejected
    const trimmedRejectionReason = rejectionReason?.trim() || null;
    if (action === 'REJECT' && !trimmedRejectionReason) {
      const err = new Error('A rejection reason is required when rejecting a leave request.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const targetStatus: LeaveStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const reviewerId = actor.userId || actor.id;
    const reviewedAt = new Date();

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: targetStatus,
        reviewedByUserId: reviewerId,
        reviewedAt,
        rejectionReason: action === 'REJECT' ? trimmedRejectionReason : null,
      },
      include: {
        employee: { select: { employeeCode: true, fullName: true } },
        leaveType: { select: { code: true, name: true } },
        reviewedByUser: { select: { fullName: true } },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: reviewerId,
      action: action === 'APPROVE' ? 'LEAVE_REQUEST_APPROVE' : 'LEAVE_REQUEST_REJECT',
      entity: 'LeaveRequest',
      entityId: updated.id,
      correlationId,
      details: {
        employeeId: updated.employeeId,
        status: targetStatus,
        rejectionReason: trimmedRejectionReason,
      },
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      employeeId: updated.employeeId,
      employeeCode: updated.employee.employeeCode,
      employeeName: updated.employee.fullName,
      leaveTypeId: updated.leaveTypeId,
      leaveTypeCode: updated.leaveType.code,
      leaveTypeName: updated.leaveType.name,
      startDate: updated.startDate.toISOString().split('T')[0],
      endDate: updated.endDate.toISOString().split('T')[0],
      totalDays: Number(updated.totalDays),
      reason: updated.reason,
      status: updated.status as LeaveStatus,
      reviewedByUserId: updated.reviewedByUserId,
      reviewedByUserName: updated.reviewedByUser?.fullName || null,
      reviewedAt: updated.reviewedAt ? updated.reviewedAt.toISOString() : null,
      rejectionReason: updated.rejectionReason,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Calculates monthly leave summary and entitlement balance for an employee.
   * If actor is an EMPLOYEE, self-resolution is strictly enforced.
   */
  static async getMonthlyLeaveSummary(
    actor: AuthUser,
    params: {
      employeeId?: string;
      year: number;
      month: number;
    },
    tx?: any
  ): Promise<MonthlyLeaveSummary> {
    const db = tx || prisma;
    let targetEmployeeId = params.employeeId;

    if (actor.role === "EMPLOYEE") {
      targetEmployeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
    } else if (!targetEmployeeId) {
      const emp = await db.employee.findFirst({
        where: { companyId: actor.companyId, userId: actor.userId || actor.id },
        select: { id: true },
      });
      if (emp) {
        targetEmployeeId = emp.id;
      } else {
        const err = new Error("Employee ID is required to calculate monthly leave summary.");
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    const year = Number(params.year);
    const month = Number(params.month);

    if (isNaN(year) || year < 2000 || year > 2100) {
      const err = new Error("Invalid year parameter.");
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (isNaN(month) || month < 1 || month > 12) {
      const err = new Error("Invalid month parameter (must be between 1 and 12).");
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const startOfMonth = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const endOfMonth = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    const startOfYear = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
    const endOfYear = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

    const employee = await db.employee.findUnique({
      where: { id: targetEmployeeId },
      select: {
        id: true,
        companyId: true,
        fullName: true,
        employeeCode: true,
        shiftId: true,
        shift: {
          select: {
            id: true,
            name: true,
            code: true,
            startTime: true,
            endTime: true,
            isOvernight: true,
          },
        },
        salaryRevisions: {
          where: { effectiveFrom: { lte: endOfMonth } },
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
          select: { fixedSalary: true },
        },
      },
    });

    if (!employee || employee.companyId !== actor.companyId) {
      const err = new Error("Employee not found in this company.");
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const leaveTypes = await db.leaveType.findMany({
      where: { companyId: actor.companyId, isActive: true },
      orderBy: { name: "asc" },
    });

    const annualRequests = await db.leaveRequest.findMany({
      where: {
        companyId: actor.companyId,
        employeeId: targetEmployeeId,
        startDate: { lte: endOfYear },
        endDate: { gte: startOfYear },
      },
      include: {
        leaveType: true,
      },
    });

    const monthlyAttendances = await db.attendance.findMany({
      where: {
        companyId: actor.companyId,
        employeeId: targetEmployeeId,
        workDate: { gte: startOfMonth, lte: endOfMonth },
      },
      include: {
        shift: {
          select: {
            id: true,
            name: true,
            startTime: true,
            endTime: true,
            isOvernight: true,
          },
        },
      },
      orderBy: { workDate: 'asc' },
    });

    const roundLeaveDays = (val: number): number => Math.round(val * 10000) / 10000;

    const getDateDaysList = (startDate: Date, endDate: Date): string[] => {
      const dates: string[] = [];
      const startUTC = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
      const endUTC = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
      const msPerDay = 1000 * 60 * 60 * 24;
      for (let t = startUTC; t <= endUTC; t += msPerDay) {
        const d = new Date(t);
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        dates.push(`${yyyy}-${mm}-${dd}`);
      }
      return dates;
    };

    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
    const yearPrefix = `${year}-`;

    let totalMonthRequestedDays = 0;
    let totalMonthApprovedDays = 0;
    let totalMonthPendingDays = 0;
    let totalMonthRejectedDays = 0;
    let rejectedCount = 0;
    let pendingCount = 0;
    let approvedCount = 0;

    let totalAnnualEntitlement = 0;
    let totalAnnualUsedDays = 0;
    let overlappingMonthApprovedDays = 0;
    let overlappingAnnualApprovedDays = 0;

    const byTypeMap = new Map();

    for (const lt of leaveTypes) {
      const allowance = Number(lt.defaultAllowance) || 0;
      totalAnnualEntitlement += allowance;
      byTypeMap.set(lt.id, {
        leaveTypeId: lt.id,
        leaveTypeCode: lt.code,
        leaveTypeName: lt.name,
        isPaid: lt.isPaid,
        annualAllowance: allowance,
        monthRequestedDays: 0,
        monthApprovedDays: 0,
        monthPendingDays: 0,
        annualUsedDays: 0,
        annualRemainingDays: allowance,
      });
    }

    // Group requests by status to process approved requests with occupancy deduplication
    const approvedRequests = (annualRequests as any[]).filter((r: any) => r.status === 'APPROVED');
    const pendingRequests = (annualRequests as any[]).filter((r: any) => r.status === 'PENDING');
    const rejectedRequests = (annualRequests as any[]).filter((r: any) => r.status === 'REJECTED');

    const approvedDailyOccupancy = new Map<string, number>();

    for (const req of approvedRequests) {
      const dates = getDateDaysList(req.startDate, req.endDate);
      const calendarSpan = Math.max(1, dates.length);
      const rawTotalDays = Number(req.totalDays);
      const totalDays = !isNaN(rawTotalDays) && rawTotalDays > 0 ? rawTotalDays : calendarSpan;
      const dailyWeight = totalDays / calendarSpan;
      const typeEntry = byTypeMap.get(req.leaveTypeId);

      let reqMonthAllocated = 0;
      let reqAnnualAllocated = 0;
      let touchesCurrentMonth = false;

      for (const d of dates) {
        const isYear = d.startsWith(yearPrefix);
        const isMonth = d.startsWith(monthPrefix);

        if (!isYear) continue;
        if (isMonth) touchesCurrentMonth = true;

        const currentDayOccupancy = approvedDailyOccupancy.get(d) || 0;
        const availableCapacity = Math.max(0, 1.0 - currentDayOccupancy);
        const allocatable = Math.min(dailyWeight, availableCapacity);
        const overlap = Math.max(0, dailyWeight - allocatable);

        if (overlap > 0) {
          overlappingAnnualApprovedDays += overlap;
          if (isMonth) {
            overlappingMonthApprovedDays += overlap;
          }
        }

        if (allocatable > 0) {
          approvedDailyOccupancy.set(d, currentDayOccupancy + allocatable);
          reqAnnualAllocated += allocatable;
          if (isMonth) {
            reqMonthAllocated += allocatable;
          }
        }
      }

      if (touchesCurrentMonth) {
        approvedCount += 1;
        totalMonthApprovedDays += reqMonthAllocated;
        totalMonthRequestedDays += reqMonthAllocated;
        if (typeEntry) {
          typeEntry.monthApprovedDays += reqMonthAllocated;
          typeEntry.monthRequestedDays += reqMonthAllocated;
        }
      }

      if (reqAnnualAllocated > 0) {
        totalAnnualUsedDays += reqAnnualAllocated;
        if (typeEntry) {
          typeEntry.annualUsedDays += reqAnnualAllocated;
        }
      }
    }

    for (const req of pendingRequests) {
      const dates = getDateDaysList(req.startDate, req.endDate);
      const calendarSpan = Math.max(1, dates.length);
      const rawTotalDays = Number(req.totalDays);
      const totalDays = !isNaN(rawTotalDays) && rawTotalDays > 0 ? rawTotalDays : calendarSpan;
      const dailyWeight = totalDays / calendarSpan;
      const typeEntry = byTypeMap.get(req.leaveTypeId);

      let reqMonthDays = 0;
      for (const d of dates) {
        if (d.startsWith(monthPrefix)) {
          reqMonthDays += dailyWeight;
        }
      }

      if (reqMonthDays > 0) {
        pendingCount += 1;
        totalMonthPendingDays += reqMonthDays;
        totalMonthRequestedDays += reqMonthDays;
        if (typeEntry) {
          typeEntry.monthPendingDays += reqMonthDays;
          typeEntry.monthRequestedDays += reqMonthDays;
        }
      }
    }

    for (const req of rejectedRequests) {
      const dates = getDateDaysList(req.startDate, req.endDate);
      const calendarSpan = Math.max(1, dates.length);
      const rawTotalDays = Number(req.totalDays);
      const totalDays = !isNaN(rawTotalDays) && rawTotalDays > 0 ? rawTotalDays : calendarSpan;
      const dailyWeight = totalDays / calendarSpan;

      let reqMonthDays = 0;
      for (const d of dates) {
        if (d.startsWith(monthPrefix)) {
          reqMonthDays += dailyWeight;
        }
      }

      if (reqMonthDays > 0) {
        rejectedCount += 1;
        totalMonthRejectedDays += reqMonthDays;
        totalMonthRequestedDays += reqMonthDays;
      }
    }

    for (const item of byTypeMap.values()) {
      item.monthRequestedDays = roundLeaveDays(item.monthRequestedDays);
      item.monthApprovedDays = roundLeaveDays(item.monthApprovedDays);
      item.monthPendingDays = roundLeaveDays(item.monthPendingDays);
      item.annualUsedDays = roundLeaveDays(item.annualUsedDays);
      item.annualRemainingDays = roundLeaveDays(Math.max(0, item.annualAllowance - item.annualUsedDays));
    }

    totalMonthRequestedDays = roundLeaveDays(totalMonthRequestedDays);
    totalMonthApprovedDays = roundLeaveDays(totalMonthApprovedDays);
    totalMonthPendingDays = roundLeaveDays(totalMonthPendingDays);
    totalMonthRejectedDays = roundLeaveDays(totalMonthRejectedDays);
    totalAnnualUsedDays = roundLeaveDays(totalAnnualUsedDays);
    const annualRemainingBalance = roundLeaveDays(Math.max(0, totalAnnualEntitlement - totalAnnualUsedDays));
    const excessLeaveDays = roundLeaveDays(Math.max(0, totalAnnualUsedDays - totalAnnualEntitlement));
    const cleanOverlappingMonthApprovedDays = roundLeaveDays(overlappingMonthApprovedDays);

    // 1. Working Hours Configuration
    let configuredDailyWorkingHours: number | null = null;
    let shiftSchedule: string | null = null;

    if (employee.shift) {
      const s = employee.shift;
      const startMin = parseInt(s.startTime.slice(0, 2), 10) * 60 + parseInt(s.startTime.slice(3, 5), 10);
      const endMin = parseInt(s.endTime.slice(0, 2), 10) * 60 + parseInt(s.endTime.slice(3, 5), 10);
      const durationMin = s.isOvernight && endMin <= startMin
        ? (endMin + 1440 - startMin)
        : (endMin - startMin);
      configuredDailyWorkingHours = Math.round((durationMin / 60) * 100) / 100;
      shiftSchedule = `${s.name} (${s.startTime} – ${s.endTime}${s.isOvernight ? ' +1d' : ''})`;
    }

    // 2. Salary Rates (Fixed 30-day divisor per company policy)
    let monthlySalaryStr: string | null = null;
    let dailySalaryRateStr: string | null = null;
    let hourlySalaryRateStr: string | null = null;
    let dailySalaryRateDecimal: Decimal | null = null;
    let hourlySalaryRateDecimal: Decimal | null = null;

    if (employee.salaryRevisions && employee.salaryRevisions.length > 0) {
      const fixedSalaryDecimal = AccountingMath.from(employee.salaryRevisions[0].fixedSalary);
      if (AccountingMath.gt(fixedSalaryDecimal, 0)) {
        monthlySalaryStr = AccountingMath.format(fixedSalaryDecimal, 2);
        dailySalaryRateDecimal = fixedSalaryDecimal.dividedBy(30).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
        dailySalaryRateStr = AccountingMath.format(dailySalaryRateDecimal, 2);

        if (configuredDailyWorkingHours !== null && configuredDailyWorkingHours > 0) {
          hourlySalaryRateDecimal = dailySalaryRateDecimal
            .dividedBy(configuredDailyWorkingHours)
            .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
          hourlySalaryRateStr = AccountingMath.format(hourlySalaryRateDecimal, 2);
        }
      }
    }

    // 3. Monthly Leave Allowance (4 days per company policy, no carry-forward)
    const monthlyLeaveAllowance = 4.0;
    const monthApprovedDays = totalMonthApprovedDays;
    const monthRemainingLeave = Math.max(0, roundLeaveDays(monthlyLeaveAllowance - monthApprovedDays));
    const monthlyExcessLeaveDays = Math.max(0, roundLeaveDays(monthApprovedDays - monthlyLeaveAllowance));

    // 4. Duplicate Deduction Prevention: Identify dates covered by excess leave, absence, or half-day
    const excessLeaveDatesSet = new Set<string>();
    let accumulatedApprovedDays = 0;
    for (const req of approvedRequests) {
      const dates = getDateDaysList(req.startDate, req.endDate);
      const calendarSpan = Math.max(1, dates.length);
      const rawTotalDays = Number(req.totalDays);
      const totalDays = !isNaN(rawTotalDays) && rawTotalDays > 0 ? rawTotalDays : calendarSpan;
      const dailyWeight = totalDays / calendarSpan;
      for (const d of dates) {
        if (d.startsWith(monthPrefix)) {
          accumulatedApprovedDays += dailyWeight;
          if (accumulatedApprovedDays > 4.0) {
            excessLeaveDatesSet.add(d);
          }
        }
      }
    }

    // 5. Short Hours Calculation from Valid Attendance Records
    let totalShortMinutes = 0;
    let incompleteAttendanceCount = 0;

    for (const att of monthlyAttendances) {
      const dateKey = att.workDate.toISOString().split('T')[0];

      // Prevent duplicate deductions: full-day absence, half-day attendance, or excess leave
      if (att.status === 'ABSENT' || att.status === 'HALF_DAY' || excessLeaveDatesSet.has(dateKey)) {
        continue;
      }

      // Missing check-out record requires administrative review; do NOT deduct automatically
      if (att.checkIn && !att.checkOut) {
        incompleteAttendanceCount++;
        continue;
      }

      if (att.checkIn && att.checkOut) {
        const effectiveShift = att.shift || employee.shift;
        if (effectiveShift) {
          const startMin = parseInt(effectiveShift.startTime.slice(0, 2), 10) * 60 + parseInt(effectiveShift.startTime.slice(3, 5), 10);
          const endMin = parseInt(effectiveShift.endTime.slice(0, 2), 10) * 60 + parseInt(effectiveShift.endTime.slice(3, 5), 10);
          const expectedMin = effectiveShift.isOvernight && endMin <= startMin
            ? (endMin + 1440 - startMin)
            : (endMin - startMin);

          const workedMin = Math.round((att.checkOut.getTime() - att.checkIn.getTime()) / (1000 * 60));
          if (workedMin < expectedMin) {
            totalShortMinutes += (expectedMin - workedMin);
          }
        }
      }
    }

    const deductibleShortHours = Math.round((totalShortMinutes / 60) * 100) / 100;

    // 6. Monetary Deductions
    const excessLeaveDeductionDecimal = dailySalaryRateDecimal
      ? dailySalaryRateDecimal.times(monthlyExcessLeaveDays).toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      : new Decimal(0);

    const shortHoursDeductionDecimal = (hourlySalaryRateDecimal && deductibleShortHours > 0)
      ? hourlySalaryRateDecimal.times(deductibleShortHours).toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      : new Decimal(0);

    const totalSalaryDeductionsDecimal = excessLeaveDeductionDecimal.plus(shortHoursDeductionDecimal);

    const excessLeaveDeduction = AccountingMath.format(excessLeaveDeductionDecimal, 2);
    const shortHoursDeduction = AccountingMath.format(shortHoursDeductionDecimal, 2);
    const totalSalaryDeductions = AccountingMath.format(totalSalaryDeductionsDecimal, 2);

    // 7. Policy Warnings & Notices
    const warnings: string[] = [];
    if (!employee.shift) {
      warnings.push(
        'No assigned working schedule/shift found for this employee. Configured daily working hours are unavailable; hourly-rate and short-hours deductions were skipped. Please assign an official shift.'
      );
    }
    if (incompleteAttendanceCount > 0) {
      warnings.push(
        `Detected ${incompleteAttendanceCount} incomplete attendance record(s) with missing check-out punches. In accordance with company policy, automatic short-hours deduction was withheld pending administrative review.`
      );
    }
    if (cleanOverlappingMonthApprovedDays > 0) {
      warnings.push(
        `Detected ${cleanOverlappingMonthApprovedDays} overlapping approved leave day(s) in this month. Overlapping days were de-duplicated to prevent double-counting.`
      );
    }

    return {
      year,
      month,
      employeeId: employee.id,
      employeeName: employee.fullName,
      employeeCode: employee.employeeCode,
      totalRequestedDays: totalMonthRequestedDays,
      approvedDays: totalMonthApprovedDays,
      pendingDays: totalMonthPendingDays,
      rejectedDays: totalMonthRejectedDays,
      rejectedCount,
      pendingCount,
      approvedCount,
      totalAnnualEntitlement: roundLeaveDays(totalAnnualEntitlement),
      annualUsedDays: totalAnnualUsedDays,
      annualRemainingBalance,
      excessLeaveDays,
      monthlyLeaveAllowance,
      monthApprovedDays,
      monthRemainingLeave,
      monthlyExcessLeaveDays,
      monthlySalary: monthlySalaryStr,
      dailySalaryRate: dailySalaryRateStr,
      hourlySalaryRate: hourlySalaryRateStr,
      configuredDailyWorkingHours,
      shiftSchedule,
      deductibleShortHours,
      incompleteAttendanceCount,
      excessLeaveDeduction,
      shortHoursDeduction,
      totalSalaryDeductions,
      overlappingApprovedDays: cleanOverlappingMonthApprovedDays,
      warnings,
      byType: Array.from(byTypeMap.values()),
    };
  }
}
