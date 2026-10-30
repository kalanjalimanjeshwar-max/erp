import { prisma } from '../db/client.js';
import {
  AuthUser,
  AttendanceItem,
  CreateAttendanceRequest,
  UpdateAttendanceRequest,
  AttendanceStatus,
  AttendanceSource,
  WorkingHoursSummary,
  WorkingHoursStatus,
  AdminNotificationItem,
  AdminNotificationType,
} from '../../shared/types.js';
import { AuditService } from './audit.service.js';

const VALID_STATUSES: AttendanceStatus[] = ['PRESENT', 'ABSENT', 'HALF_DAY', 'LATE', 'ON_LEAVE'];
const VALID_SOURCES: AttendanceSource[] = ['MANUAL', 'BIOMETRIC'];

export class AttendanceService {
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

  /**
   * Helper: Calculates late minutes given checkIn timestamp, shift, and workDate
   */
  private static calculateLateMinutes(
    checkIn: Date | null,
    workDateStr: string,
    shift: { startTime: string; graceMinutes: number } | null
  ): number {
    if (!checkIn || !shift || !shift.startTime) {
      return 0;
    }

    // Parse shift start on workDate
    const [startH, startM] = shift.startTime.split(':').map(Number);
    if (isNaN(startH) || isNaN(startM)) {
      return 0;
    }

    // Align checkIn time on workDate
    const scheduledStart = new Date(`${workDateStr}T${shift.startTime}:00.000Z`);
    const graceMs = shift.graceMinutes * 60 * 1000;
    const graceThreshold = new Date(scheduledStart.getTime() + graceMs);

    if (checkIn.getTime() > graceThreshold.getTime()) {
      const diffMs = checkIn.getTime() - scheduledStart.getTime();
      return Math.max(0, Math.floor(diffMs / (60 * 1000)));
    }

    return 0;
  }

  /**
   * Lists attendance records scoped to company with filters
   */
  static async listAttendance(
    actor: AuthUser,
    filters?: {
      employeeId?: string;
      status?: AttendanceStatus;
      startDate?: string;
      endDate?: string;
    },
    pagination?: {
      page?: number;
      limit?: number;
    }
  ): Promise<{ items: AttendanceItem[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, pagination?.page || 1);
    const limit = Math.min(100, Math.max(1, pagination?.limit || 20));
    const skip = (page - 1) * limit;

    const where: {
      companyId: string;
      employeeId?: string;
      status?: AttendanceStatus;
      workDate?: { gte?: Date; lte?: Date };
    } = { companyId: actor.companyId };

    // If actor is EMPLOYEE, restrict strictly to their own employee ID
    if (actor.role === 'EMPLOYEE') {
      const selfEmployeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
      where.employeeId = selfEmployeeId;
    } else if (filters?.employeeId) {
      where.employeeId = filters.employeeId;
    }

    if (filters?.status) {
      if (!VALID_STATUSES.includes(filters.status)) {
        const err = new Error(`Invalid attendance status '${filters.status}'.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      where.status = filters.status;
    }

    if (filters?.startDate || filters?.endDate) {
      where.workDate = {};
      if (filters.startDate) {
        where.workDate.gte = new Date(`${filters.startDate}T00:00:00.000Z`);
      }
      if (filters.endDate) {
        where.workDate.lte = new Date(`${filters.endDate}T23:59:59.999Z`);
      }
    }

    const [total, records] = await Promise.all([
      prisma.attendance.count({ where }),
      prisma.attendance.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }],
        include: {
          employee: {
            select: { employeeCode: true, fullName: true },
          },
          shift: {
            select: { name: true },
          },
        },
      }),
    ]);

    const items: AttendanceItem[] = records.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      employeeId: r.employeeId,
      employeeCode: r.employee.employeeCode,
      employeeName: r.employee.fullName,
      shiftId: r.shiftId,
      shiftName: r.shift?.name || null,
      workDate: r.workDate.toISOString().split('T')[0],
      checkIn: r.checkIn ? r.checkIn.toISOString() : null,
      checkOut: r.checkOut ? r.checkOut.toISOString() : null,
      status: r.status as AttendanceStatus,
      lateMinutes: r.lateMinutes,
      overtimeMinutes: r.overtimeMinutes,
      source: r.source as AttendanceSource,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return { items, total, page, limit };
  }

  /**
   * Gets single attendance record by ID with company and employee scoping
   */
  static async getAttendanceById(actor: AuthUser, id: string): Promise<AttendanceItem> {
    const record = await prisma.attendance.findUnique({
      where: { id },
      include: {
        employee: { select: { employeeCode: true, fullName: true, userId: true } },
        shift: { select: { name: true } },
      },
    });

    if (!record || record.companyId !== actor.companyId) {
      const err = new Error('Attendance record not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // If EMPLOYEE role, ensure record belongs to actor
    if (actor.role === 'EMPLOYEE') {
      const selfEmployeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
      if (record.employeeId !== selfEmployeeId) {
        const err = new Error('Employees are only permitted to view their own attendance records.');
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
      shiftId: record.shiftId,
      shiftName: record.shift?.name || null,
      workDate: record.workDate.toISOString().split('T')[0],
      checkIn: record.checkIn ? record.checkIn.toISOString() : null,
      checkOut: record.checkOut ? record.checkOut.toISOString() : null,
      status: record.status as AttendanceStatus,
      lateMinutes: record.lateMinutes,
      overtimeMinutes: record.overtimeMinutes,
      source: record.source as AttendanceSource,
      notes: record.notes,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /**
   * Creates a manual attendance record
   */
  static async createAttendance(
    actor: AuthUser,
    input: CreateAttendanceRequest,
    correlationId?: string
  ): Promise<AttendanceItem> {
    let employeeId = input.employeeId;

    // If EMPLOYEE role, derive strictly from self
    if (actor.role === 'EMPLOYEE') {
      employeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
    } else {
      if (!employeeId) {
        const err = new Error('Employee ID is required.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      // Verify employee belongs to actor company
      const emp = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, companyId: true, shiftId: true },
      });
      if (!emp || emp.companyId !== actor.companyId) {
        const err = new Error('Employee not found in this company.');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }
    }

    // Validate workDate
    const workDateStr = (input.workDate || '').trim();
    if (!workDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(workDateStr)) {
      const err = new Error('Work date is required and must be in YYYY-MM-DD format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const workDateObj = new Date(`${workDateStr}T00:00:00.000Z`);
    if (isNaN(workDateObj.getTime())) {
      const err = new Error('Invalid work date format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check duplicate attendance record for (companyId, employeeId, workDate)
    const existing = await prisma.attendance.findUnique({
      where: {
        companyId_employeeId_workDate: {
          companyId: actor.companyId,
          employeeId,
          workDate: workDateObj,
        },
      },
    });

    if (existing) {
      const err = new Error(`An attendance record already exists for this employee on date ${workDateStr}.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    // Parse checkIn and checkOut
    let checkInDate: Date | null = null;
    let checkOutDate: Date | null = null;

    if (input.checkIn) {
      checkInDate = new Date(input.checkIn);
      if (isNaN(checkInDate.getTime())) {
        const err = new Error('Invalid check-in timestamp.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    if (input.checkOut) {
      checkOutDate = new Date(input.checkOut);
      if (isNaN(checkOutDate.getTime())) {
        const err = new Error('Invalid check-out timestamp.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    // Reject check-out earlier than check-in
    if (checkInDate && checkOutDate && checkOutDate.getTime() < checkInDate.getTime()) {
      const err = new Error('Check-out time cannot be earlier than check-in time.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Resolve shift (either explicit or employee default)
    let shiftId = input.shiftId || null;
    let shiftRecord: { id: string; name: string; startTime: string; graceMinutes: number } | null = null;

    if (shiftId) {
      const s = await prisma.shift.findUnique({
        where: { id: shiftId },
        select: { id: true, name: true, companyId: true, startTime: true, graceMinutes: true },
      });
      if (!s || s.companyId !== actor.companyId) {
        const err = new Error('Assigned shift not found in this company.');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }
      shiftRecord = s;
    } else {
      // Lookup employee default shift
      const empWithShift = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: {
          shift: {
            select: { id: true, name: true, startTime: true, graceMinutes: true },
          },
        },
      });
      if (empWithShift?.shift) {
        shiftId = empWithShift.shift.id;
        shiftRecord = empWithShift.shift;
      }
    }

    // Calculate late minutes if applicable
    const lateMinutes = this.calculateLateMinutes(checkInDate, workDateStr, shiftRecord);

    // Validate status
    let status: AttendanceStatus = input.status || (lateMinutes > 0 ? 'LATE' : 'PRESENT');
    if (input.status) {
      if (!VALID_STATUSES.includes(input.status)) {
        const err = new Error(`Invalid status '${input.status}'. Allowed: ${VALID_STATUSES.join(', ')}.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      status = input.status;
    }

    // Validate source
    const source: AttendanceSource = input.source || 'MANUAL';
    if (!VALID_SOURCES.includes(source)) {
      const err = new Error(`Invalid source '${source}'. Allowed: ${VALID_SOURCES.join(', ')}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Execute atomic transaction for record creation and audit log
    const created = await prisma.$transaction(async (tx) => {
      const att = await tx.attendance.create({
        data: {
          companyId: actor.companyId,
          employeeId,
          shiftId,
          workDate: workDateObj,
          checkIn: checkInDate,
          checkOut: checkOutDate,
          status,
          lateMinutes,
          overtimeMinutes: 0, // Prompt: Do not calculate overtime pay or run payroll in this phase
          source,
          notes: input.notes?.trim() || null,
        },
        include: {
          employee: { select: { employeeCode: true, fullName: true } },
          shift: { select: { name: true } },
        },
      });

      return att;
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'ATTENDANCE_RECORD',
      entity: 'Attendance',
      entityId: created.id,
      correlationId,
      details: {
        employeeId,
        workDate: workDateStr,
        status,
        lateMinutes,
        source,
      },
    });

    return {
      id: created.id,
      companyId: created.companyId,
      employeeId: created.employeeId,
      employeeCode: created.employee.employeeCode,
      employeeName: created.employee.fullName,
      shiftId: created.shiftId,
      shiftName: created.shift?.name || null,
      workDate: created.workDate.toISOString().split('T')[0],
      checkIn: created.checkIn ? created.checkIn.toISOString() : null,
      checkOut: created.checkOut ? created.checkOut.toISOString() : null,
      status: created.status as AttendanceStatus,
      lateMinutes: created.lateMinutes,
      overtimeMinutes: created.overtimeMinutes,
      source: created.source as AttendanceSource,
      notes: created.notes,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  /**
   * Updates an existing attendance record
   */
  static async updateAttendance(
    actor: AuthUser,
    id: string,
    input: UpdateAttendanceRequest,
    correlationId?: string
  ): Promise<AttendanceItem> {
    const existing = await prisma.attendance.findUnique({
      where: { id },
      include: {
        employee: { select: { employeeCode: true, fullName: true } },
        shift: { select: { id: true, name: true, startTime: true, graceMinutes: true } },
      },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Attendance record not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const dataToUpdate: {
      checkIn?: Date | null;
      checkOut?: Date | null;
      shiftId?: string | null;
      status?: AttendanceStatus;
      lateMinutes?: number;
      notes?: string | null;
    } = {};

    let effectiveCheckIn = existing.checkIn;
    let effectiveCheckOut = existing.checkOut;

    if (input.checkIn !== undefined) {
      if (input.checkIn === null) {
        effectiveCheckIn = null;
        dataToUpdate.checkIn = null;
      } else {
        effectiveCheckIn = new Date(input.checkIn);
        if (isNaN(effectiveCheckIn.getTime())) {
          const err = new Error('Invalid check-in timestamp.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        dataToUpdate.checkIn = effectiveCheckIn;
      }
    }

    if (input.checkOut !== undefined) {
      if (input.checkOut === null) {
        effectiveCheckOut = null;
        dataToUpdate.checkOut = null;
      } else {
        effectiveCheckOut = new Date(input.checkOut);
        if (isNaN(effectiveCheckOut.getTime())) {
          const err = new Error('Invalid check-out timestamp.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        dataToUpdate.checkOut = effectiveCheckOut;
      }
    }

    // Validate checkOut >= checkIn
    if (effectiveCheckIn && effectiveCheckOut && effectiveCheckOut.getTime() < effectiveCheckIn.getTime()) {
      const err = new Error('Check-out time cannot be earlier than check-in time.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    let effectiveShift = existing.shift;
    if (input.shiftId !== undefined) {
      if (input.shiftId === null) {
        effectiveShift = null;
        dataToUpdate.shiftId = null;
      } else {
        const s = await prisma.shift.findUnique({
          where: { id: input.shiftId },
          select: { id: true, name: true, companyId: true, startTime: true, graceMinutes: true },
        });
        if (!s || s.companyId !== actor.companyId) {
          const err = new Error('Assigned shift not found in this company.');
          (err as { statusCode?: number }).statusCode = 404;
          throw err;
        }
        effectiveShift = s;
        dataToUpdate.shiftId = s.id;
      }
    }

    // Recompute late minutes if check-in or shift changed
    if (input.checkIn !== undefined || input.shiftId !== undefined) {
      const workDateStr = existing.workDate.toISOString().split('T')[0];
      dataToUpdate.lateMinutes = this.calculateLateMinutes(effectiveCheckIn, workDateStr, effectiveShift);
    }

    if (input.status !== undefined) {
      if (!VALID_STATUSES.includes(input.status)) {
        const err = new Error(`Invalid status '${input.status}'. Allowed: ${VALID_STATUSES.join(', ')}.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      dataToUpdate.status = input.status;
    }

    if (input.notes !== undefined) {
      dataToUpdate.notes = input.notes?.trim() || null;
    }

    const updated = await prisma.attendance.update({
      where: { id },
      data: dataToUpdate,
      include: {
        employee: { select: { employeeCode: true, fullName: true } },
        shift: { select: { name: true } },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'ATTENDANCE_UPDATE',
      entity: 'Attendance',
      entityId: updated.id,
      correlationId,
      details: { updatedFields: Object.keys(dataToUpdate) },
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      employeeId: updated.employeeId,
      employeeCode: updated.employee.employeeCode,
      employeeName: updated.employee.fullName,
      shiftId: updated.shiftId,
      shiftName: updated.shift?.name || null,
      workDate: updated.workDate.toISOString().split('T')[0],
      checkIn: updated.checkIn ? updated.checkIn.toISOString() : null,
      checkOut: updated.checkOut ? updated.checkOut.toISOString() : null,
      status: updated.status as AttendanceStatus,
      lateMinutes: updated.lateMinutes,
      overtimeMinutes: updated.overtimeMinutes,
      source: updated.source as AttendanceSource,
      notes: updated.notes,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Stage 1.4: Computes employee pre-logout working-hours summary
   * Strictly read-only: does NOT create or alter attendance check-out punches
   */
  static async getWorkingHoursSummary(actor: AuthUser, employeeId?: string): Promise<WorkingHoursSummary> {
    let targetEmployeeId = employeeId;
    if (actor.role === 'EMPLOYEE' || !targetEmployeeId) {
      targetEmployeeId = await this.getEmployeeIdForUser(actor.companyId, actor.userId || actor.id);
    }

    const employee = await prisma.employee.findUnique({
      where: { id: targetEmployeeId },
      include: {
        company: { select: { id: true, timezone: true } },
        shift: { select: { id: true, name: true, startTime: true, endTime: true, isOvernight: true } },
      },
    });

    if (!employee || employee.companyId !== actor.companyId) {
      const err = new Error('Employee not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const timezone = employee.company?.timezone || 'UTC';
    let todayStr: string;
    try {
      todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      todayStr = new Date().toISOString().split('T')[0];
    }

    const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

    // Fetch today's attendance record
    let attendance = await prisma.attendance.findFirst({
      where: {
        companyId: actor.companyId,
        employeeId: targetEmployeeId,
        workDate: todayDate,
      },
      include: {
        shift: { select: { id: true, name: true, startTime: true, endTime: true, isOvernight: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Overnight shift support: check if an active overnight shift started yesterday without a check-out
    if (!attendance && employee.shift?.isOvernight) {
      const yesterdayDate = new Date(todayDate);
      yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
      const yesterdayAtt = await prisma.attendance.findFirst({
        where: {
          companyId: actor.companyId,
          employeeId: targetEmployeeId,
          workDate: yesterdayDate,
          checkIn: { not: null },
        },
        include: {
          shift: { select: { id: true, name: true, startTime: true, endTime: true, isOvernight: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (yesterdayAtt && (!yesterdayAtt.checkOut || (Date.now() - yesterdayAtt.checkIn!.getTime() < 24 * 60 * 60 * 1000))) {
        attendance = yesterdayAtt;
      }
    }

    const effectiveShift = attendance?.shift || employee.shift;
    let expectedDurationHours: number | null = null;
    let shiftSchedule: string | null = null;
    let expectedMinutes = 0;

    if (effectiveShift) {
      const startH = parseInt(effectiveShift.startTime.slice(0, 2), 10);
      const startM = parseInt(effectiveShift.startTime.slice(3, 5), 10);
      const endH = parseInt(effectiveShift.endTime.slice(0, 2), 10);
      const endM = parseInt(effectiveShift.endTime.slice(3, 5), 10);
      const startMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;
      expectedMinutes = effectiveShift.isOvernight && endMin <= startMin
        ? (endMin + 1440 - startMin)
        : (endMin - startMin);
      expectedDurationHours = Math.round((expectedMinutes / 60) * 100) / 100;
      shiftSchedule = `${effectiveShift.name} (${effectiveShift.startTime} – ${effectiveShift.endTime}${effectiveShift.isOvernight ? ' +1d' : ''})`;
    }

    let status: WorkingHoursStatus;
    let statusMessage: string;
    let requiresAttendanceAction = false;
    let workedDurationHours: number | null = null;
    let shortDurationMinutes = 0;
    let overtimeDurationMinutes = 0;

    if (!effectiveShift) {
      status = 'NO_SHIFT_ASSIGNED';
      statusMessage = 'No working shift is assigned to your employee account. Daily required working hours are unavailable. Logging out of CoreERP will NOT record attendance.';
    } else if (!attendance || !attendance.checkIn) {
      status = 'MISSING_CHECK_IN';
      statusMessage = 'No attendance check-in has been logged for your account today. Logging out of CoreERP will NOT record attendance.';
      requiresAttendanceAction = true;
    } else if (attendance.checkIn && !attendance.checkOut) {
      status = 'INCOMPLETE_ATTENDANCE';
      const checkInTime = attendance.checkIn.toISOString().substring(11, 16);
      statusMessage = `Attendance Incomplete: You checked in today at ${checkInTime} UTC, but have not recorded a check-out punch. Logging out of CoreERP will NOT record your check-out. Please punch out on the Attendance page if your workday has ended.`;
      requiresAttendanceAction = true;
    } else if (attendance.checkIn && attendance.checkOut) {
      const workedMs = attendance.checkOut.getTime() - attendance.checkIn.getTime();
      const workedMinutes = Math.round(workedMs / (1000 * 60));
      workedDurationHours = Math.round((workedMinutes / 60) * 100) / 100;

      if (workedMinutes < 0) {
        status = 'DATA_REQUIRES_REVIEW';
        statusMessage = 'Attendance punch timestamps require administrative review because check-out timestamp is earlier than check-in.';
      } else if (workedMinutes < expectedMinutes) {
        status = 'SHORT_HOURS';
        shortDurationMinutes = expectedMinutes - workedMinutes;
        const shortH = Math.floor(shortDurationMinutes / 60);
        const shortM = shortDurationMinutes % 60;
        const shortDurationStr = shortH > 0 ? `${shortH}h ${shortM}m` : `${shortM}m`;
        statusMessage = `Short Hours: You completed ${workedDurationHours}h of work today, which is short by ${shortDurationStr} of your scheduled ${expectedDurationHours}h shift.`;
      } else if (workedMinutes > expectedMinutes) {
        status = 'OVERTIME';
        overtimeDurationMinutes = workedMinutes - expectedMinutes;
        const otH = Math.floor(overtimeDurationMinutes / 60);
        const otM = overtimeDurationMinutes % 60;
        const otStr = otH > 0 ? `${otH}h ${otM}m` : `${otM}m`;
        statusMessage = `Overtime Recorded: You completed ${workedDurationHours}h of work today, exceeding your scheduled ${expectedDurationHours}h shift by ${otStr} of overtime.`;
      } else {
        status = 'HOURS_COMPLETED';
        statusMessage = `Shift Complete: You have completed your scheduled ${expectedDurationHours}h working hours for today.`;
      }
    } else {
      status = 'DATA_REQUIRES_REVIEW';
      statusMessage = 'Attendance record data requires review by an administrator.';
    }

    return {
      workDate: todayStr,
      timezone,
      employeeId: employee.id,
      employeeName: employee.fullName,
      employeeCode: employee.employeeCode,
      shiftId: effectiveShift?.id || null,
      shiftName: effectiveShift?.name || null,
      shiftSchedule,
      expectedDurationHours,
      checkIn: attendance?.checkIn ? attendance.checkIn.toISOString() : null,
      checkOut: attendance?.checkOut ? attendance.checkOut.toISOString() : null,
      workedDurationHours,
      shortDurationMinutes,
      overtimeDurationMinutes,
      status,
      statusMessage,
      requiresAttendanceAction,
    };
  }

  /**
   * Stage 1.4: Retrieves Admin-visible notifications for attendance and shift events
   * Strictly tenant-isolated, role-protected, and deduplicated
   */
  static async getAdminNotifications(actor: AuthUser): Promise<{ items: AdminNotificationItem[]; total: number }> {
    if (!['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN'].includes(actor.role)) {
      const err = new Error('Access denied: Admin notifications are restricted to administrators.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const company = await prisma.company.findUnique({
      where: { id: actor.companyId },
      select: { timezone: true },
    });
    const timezone = company?.timezone || 'UTC';
    let todayStr: string;
    try {
      todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      todayStr = new Date().toISOString().split('T')[0];
    }

    const activeEmployees = await prisma.employee.findMany({
      where: { companyId: actor.companyId, status: 'ACTIVE' },
      include: {
        shift: { select: { id: true, name: true, startTime: true, endTime: true, isOvernight: true } },
      },
      orderBy: { employeeCode: 'asc' },
    });

    const sevenDaysAgo = new Date(`${todayStr}T00:00:00.000Z`);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);

    const recentAttendances = await prisma.attendance.findMany({
      where: {
        companyId: actor.companyId,
        workDate: { gte: sevenDaysAgo },
      },
      include: {
        employee: {
          select: {
            id: true,
            fullName: true,
            employeeCode: true,
            shift: { select: { id: true, name: true, startTime: true, endTime: true, isOvernight: true } },
          },
        },
        shift: { select: { id: true, name: true, startTime: true, endTime: true, isOvernight: true } },
      },
      orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }],
    });

    const notificationsMap = new Map<string, AdminNotificationItem>();

    // 1. Unassigned Shifts
    for (const emp of activeEmployees) {
      if (!emp.shiftId || !emp.shift) {
        const id = `${emp.id}_NO_SHIFT_ASSIGNED_${todayStr}`;
        notificationsMap.set(id, {
          id,
          companyId: actor.companyId,
          type: 'NO_SHIFT_ASSIGNED',
          severity: 'WARN',
          title: 'Unassigned Working Schedule',
          message: `${emp.fullName} (${emp.employeeCode}) has no assigned shift. Configured working hours are unavailable.`,
          employeeId: emp.id,
          employeeName: emp.fullName,
          employeeCode: emp.employeeCode,
          workDate: todayStr,
          actionUrl: '/employees',
          createdAt: new Date().toISOString(),
        });
      }
    }

    // 2. Attendance Events (Incomplete Punch, Short Hours, Hours Completed, Data Review)
    for (const att of recentAttendances) {
      const workDateStr = att.workDate.toISOString().split('T')[0];
      const shift = att.shift || att.employee.shift;

      if (att.checkIn && !att.checkOut) {
        const id = `${att.employee.id}_INCOMPLETE_PUNCH_${workDateStr}`;
        if (!notificationsMap.has(id)) {
          notificationsMap.set(id, {
            id,
            companyId: actor.companyId,
            type: 'INCOMPLETE_PUNCH',
            severity: 'WARN',
            title: 'Missing Check-Out Punch',
            message: `${att.employee.fullName} (${att.employee.employeeCode}) checked in on ${workDateStr} but has no check-out punch.`,
            employeeId: att.employee.id,
            employeeName: att.employee.fullName,
            employeeCode: att.employee.employeeCode,
            workDate: workDateStr,
            actionUrl: '/attendance',
            createdAt: att.updatedAt.toISOString(),
          });
        }
      } else if (att.checkIn && att.checkOut && shift) {
        const startMin = parseInt(shift.startTime.slice(0, 2), 10) * 60 + parseInt(shift.startTime.slice(3, 5), 10);
        const endMin = parseInt(shift.endTime.slice(0, 2), 10) * 60 + parseInt(shift.endTime.slice(3, 5), 10);
        const expectedMin = shift.isOvernight && endMin <= startMin ? endMin + 1440 - startMin : endMin - startMin;
        const workedMs = att.checkOut.getTime() - att.checkIn.getTime();
        const workedMin = Math.round(workedMs / (1000 * 60));

        if (workedMin < 0) {
          const id = `${att.employee.id}_ATTENDANCE_REVIEW_REQUIRED_${workDateStr}`;
          if (!notificationsMap.has(id)) {
            notificationsMap.set(id, {
              id,
              companyId: actor.companyId,
              type: 'ATTENDANCE_REVIEW_REQUIRED',
              severity: 'ERROR',
              title: 'Attendance Punch Inversion',
              message: `Check-out timestamp is earlier than check-in for ${att.employee.fullName} on ${workDateStr}.`,
              employeeId: att.employee.id,
              employeeName: att.employee.fullName,
              employeeCode: att.employee.employeeCode,
              workDate: workDateStr,
              actionUrl: '/attendance',
              createdAt: att.updatedAt.toISOString(),
            });
          }
        } else if (workedMin < expectedMin) {
          const id = `${att.employee.id}_SHORT_HOURS_${workDateStr}`;
          if (!notificationsMap.has(id)) {
            const shortMin = expectedMin - workedMin;
            const shortH = Math.floor(shortMin / 60);
            const shortM = shortMin % 60;
            const shortStr = shortH > 0 ? `${shortH}h ${shortM}m` : `${shortM}m`;
            notificationsMap.set(id, {
              id,
              companyId: actor.companyId,
              type: 'SHORT_HOURS',
              severity: 'WARN',
              title: 'Short Hours Recorded',
              message: `${att.employee.fullName} (${att.employee.employeeCode}) was short by ${shortStr} of scheduled shift on ${workDateStr}.`,
              employeeId: att.employee.id,
              employeeName: att.employee.fullName,
              employeeCode: att.employee.employeeCode,
              workDate: workDateStr,
              actionUrl: '/attendance',
              createdAt: att.updatedAt.toISOString(),
            });
          }
        } else if (workedMin >= expectedMin) {
          const id = `${att.employee.id}_HOURS_COMPLETED_${workDateStr}`;
          if (!notificationsMap.has(id)) {
            const workedH = (workedMin / 60).toFixed(1);
            notificationsMap.set(id, {
              id,
              companyId: actor.companyId,
              type: 'HOURS_COMPLETED',
              severity: 'INFO',
              title: 'Shift Hours Completed',
              message: `${att.employee.fullName} (${att.employee.employeeCode}) completed required shift duration (${workedH}h worked) on ${workDateStr}.`,
              employeeId: att.employee.id,
              employeeName: att.employee.fullName,
              employeeCode: att.employee.employeeCode,
              workDate: workDateStr,
              actionUrl: '/attendance',
              createdAt: att.updatedAt.toISOString(),
            });
          }
        }
      }
    }

    const items = Array.from(notificationsMap.values());
    return { items, total: items.length };
  }
}

