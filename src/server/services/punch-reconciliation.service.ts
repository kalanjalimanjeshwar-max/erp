import { prisma } from '../db/client.js';
import {
  PunchSyncStatus,
  RawPunchLogItem,
  PunchReconciliationOptions,
  PunchReconciliationResponse,
  PunchReconciliationItemResult,
  PunchSyncSummaryResponse,
  AttendanceStatus,
} from '../../shared/types.js';
import { AuditService } from './audit.service.js';

const DEBOUNCE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

export interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateStr: string; // "YYYY-MM-DD"
  timeStr: string; // "HH:mm"
}

export class PunchReconciliationService {
  /**
   * Resolves the canonical timezone for the company.
   * Enforces policy: If Company.timezone is valid IANA, use it.
   * If missing or invalid, explicitly documents and enforces UTC reference timezone.
   */
  static async resolveCompanyTimezone(companyId: string, tx?: any): Promise<string> {
    const client = tx || prisma;
    const company = await client.company.findUnique({
      where: { id: companyId },
      select: { timezone: true },
    });

    const tzCandidate = company?.timezone?.trim();
    if (tzCandidate) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tzCandidate });
        return tzCandidate;
      } catch {
        // Invalid timezone string: fallback to canonical UTC policy
      }
    }

    return 'UTC';
  }

  /**
   * Converts a UTC Date into local time parts for a given IANA timezone.
   */
  static getLocalDateTime(utcDate: Date, timeZone: string): LocalTimeParts {
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });

      const parts = formatter.formatToParts(utcDate);
      const partMap: Record<string, string> = {};
      for (const p of parts) {
        partMap[p.type] = p.value;
      }

      const year = parseInt(partMap.year || '1970', 10);
      const month = parseInt(partMap.month || '1', 10);
      const day = parseInt(partMap.day || '1', 10);
      const hour = parseInt(partMap.hour || '0', 10);
      const minute = parseInt(partMap.minute || '0', 10);
      const second = parseInt(partMap.second || '0', 10);

      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

      return { year, month, day, hour, minute, second, dateStr, timeStr };
    } catch {
      // Fallback to UTC representation
      const dateStr = utcDate.toISOString().split('T')[0];
      const timeStr = utcDate.toISOString().split('T')[1].slice(0, 5);
      return {
        year: utcDate.getUTCFullYear(),
        month: utcDate.getUTCMonth() + 1,
        day: utcDate.getUTCDate(),
        hour: utcDate.getUTCHours(),
        minute: utcDate.getUTCMinutes(),
        second: utcDate.getUTCSeconds(),
        dateStr,
        timeStr,
      };
    }
  }

  /**
   * Deterministically assigns work date considering overnight and standard shifts.
   *
   * Overnight Shift Policy:
   * A shift spanning midnight (e.g. 22:00 to 06:00):
   * - Punches on or after 12:00 (noon) on Day D belong to the shift of Day D.
   * - Punches before 12:00 (noon) on Day D+1 belong to the shift that started on Day D (Day D+1 minus 1 day).
   */
  static determineWorkDate(
    punchDate: Date,
    timeZone: string,
    shift: { startTime: string; endTime: string; isOvernight: boolean } | null
  ): string {
    const local = this.getLocalDateTime(punchDate, timeZone);

    if (!shift || !shift.isOvernight) {
      return local.dateStr;
    }

    // Overnight shift handling:
    // If local hour < 12 (morning hours after midnight), this punch is part of the shift that commenced yesterday
    if (local.hour < 12) {
      const yesterday = new Date(punchDate.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayLocal = this.getLocalDateTime(yesterday, timeZone);
      return yesterdayLocal.dateStr;
    }

    return local.dateStr;
  }

  /**
   * Calculates late minutes based on scheduled shift start, grace minutes, and work date.
   */
  static calculateLateMinutes(
    checkIn: Date | null,
    workDateStr: string,
    shift: { startTime: string; graceMinutes: number } | null,
    timeZone = 'UTC'
  ): number {
    if (!checkIn || !shift || !shift.startTime) {
      return 0;
    }

    const [startH, startM] = shift.startTime.split(':').map(Number);
    if (isNaN(startH) || isNaN(startM)) {
      return 0;
    }

    const localParts = this.getLocalDateTime(checkIn, timeZone);
    const punchMinutes = localParts.hour * 60 + localParts.minute;
    const scheduledStartMinutes = startH * 60 + startM;
    const graceMinutes = shift.graceMinutes || 0;

    if (punchMinutes > scheduledStartMinutes + graceMinutes) {
      return Math.max(0, punchMinutes - scheduledStartMinutes);
    }

    return 0;
  }

  /**
   * Calculates overtime minutes based on scheduled shift end time.
   */
  static calculateOvertimeMinutes(
    checkOut: Date | null,
    workDateStr: string,
    shift: { endTime: string; isOvernight: boolean } | null,
    timeZone = 'UTC'
  ): number {
    if (!checkOut || !shift || !shift.endTime) {
      return 0;
    }

    const [endH, endM] = shift.endTime.split(':').map(Number);
    if (isNaN(endH) || isNaN(endM)) {
      return 0;
    }

    const localParts = this.getLocalDateTime(checkOut, timeZone);
    const punchMinutes = localParts.hour * 60 + localParts.minute;
    const scheduledEndMinutes = endH * 60 + endM;

    if (shift.isOvernight) {
      if (localParts.hour < 12 && punchMinutes > scheduledEndMinutes) {
        return Math.max(0, punchMinutes - scheduledEndMinutes);
      }
    } else {
      if (punchMinutes > scheduledEndMinutes) {
        return Math.max(0, punchMinutes - scheduledEndMinutes);
      }
    }

    return 0;
  }


  /**
   * Reconciles a single raw punch record within an atomic transaction.
   * Guarantees:
   * 1. Tenant isolation throughout.
   * 2. Protected attendance and payroll records are never overwritten.
   * 3. Idempotent execution: already processed punches are safely skipped.
   * 4. Comprehensive logging of outcomes and reasons on RawPunchLog.
   */
  static async reconcilePunch(
    punchId: string,
    correlationId?: string
  ): Promise<PunchReconciliationItemResult> {
    return prisma.$transaction(async (tx) => {
      const punch = await tx.rawPunchLog.findUnique({
        where: { id: punchId },
        include: {
          company: { select: { id: true, timezone: true } },
          terminal: { select: { id: true, name: true, location: true } },
          matchedEmployee: {
            include: {
              shift: true,
            },
          },
        },
      });

      if (!punch) {
        return {
          punchId,
          userEnrollmentId: '',
          matchedEmployeeId: null,
          workDate: null,
          status: 'ERROR',
          message: 'Raw punch record not found.',
        };
      }

      // Idempotency: if already processed, return current state without side effects
      if (punch.syncStatus === 'PROCESSED') {
        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: punch.matchedEmployeeId,
          workDate: null,
          status: 'PROCESSED',
          message: 'Punch was already successfully processed.',
        };
      }

      // A. Employee Mapping Resolution
      let employee = punch.matchedEmployee;
      if (!employee) {
        // Strictly resolve active employee in the same tenant by biometricDeviceId
        const foundEmployee = await tx.employee.findFirst({
          where: {
            companyId: punch.companyId,
            biometricDeviceId: punch.userEnrollmentId.trim(),
            status: 'ACTIVE',
          },
          include: { shift: true },
        });

        if (!foundEmployee) {
          const reason = `Unmapped biometric enrollment ID: No active employee found with biometricDeviceId '${punch.userEnrollmentId}' in company.`;
          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: {
              syncStatus: 'ERROR',
              errorMessage: reason,
            },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: null,
            workDate: null,
            status: 'ERROR',
            message: reason,
          };
        }

        // Link matched employee
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: { matchedEmployeeId: foundEmployee.id },
        });

        employee = foundEmployee;
      } else if (employee.companyId !== punch.companyId) {
        // Cross-tenant guard
        const reason = 'Security violation: Employee company ID does not match punch company ID.';
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: { syncStatus: 'ERROR', errorMessage: reason },
        });
        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: null,
          workDate: null,
          status: 'ERROR',
          message: reason,
        };
      }

      // B. Resolve Timezone and Work Date
      const timeZone = await this.resolveCompanyTimezone(punch.companyId, tx);
      const shift = employee.shift;
      const workDateStr = this.determineWorkDate(punch.punchTime, timeZone, shift);
      const workDateObj = new Date(`${workDateStr}T00:00:00.000Z`);

      // C. Data & Payroll Integrity: Protect Finalized / Processed / Posted Payroll Periods
      const lockedPayroll = await tx.payrollPeriod.findFirst({
        where: {
          companyId: punch.companyId,
          startDate: { lte: workDateObj },
          endDate: { gte: workDateObj },
          status: { in: ['PROCESSED', 'POSTED'] },
        },
        select: { id: true, name: true, status: true },
      });

      if (lockedPayroll) {
        const reason = `Protected payroll period: Payroll period '${lockedPayroll.name}' (${lockedPayroll.status}) is finalized/locked. Attendance for ${workDateStr} cannot be modified.`;
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: {
            syncStatus: 'ERROR',
            errorMessage: reason,
          },
        });

        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: employee.id,
          workDate: workDateStr,
          status: 'ERROR',
          message: reason,
        };
      }

      // D. Find Existing Attendance Record for (companyId, employeeId, workDate)
      const existingAttendance = await tx.attendance.findUnique({
        where: {
          companyId_employeeId_workDate: {
            companyId: punch.companyId,
            employeeId: employee.id,
            workDate: workDateObj,
          },
        },
      });

      // E. Protect Approved Leave Records (both pre-existing Attendance and LeaveRequest records)
      const approvedLeave = await tx.leaveRequest.findFirst({
        where: {
          companyId: punch.companyId,
          employeeId: employee.id,
          status: 'APPROVED',
          startDate: { lte: workDateObj },
          endDate: { gte: workDateObj },
        },
        include: {
          leaveType: { select: { name: true, code: true } },
        },
      });

      if (approvedLeave || (existingAttendance && existingAttendance.status === 'ON_LEAVE')) {
        const leaveDetail = approvedLeave?.leaveType?.name
          ? ` (${approvedLeave.leaveType.name})`
          : existingAttendance?.status === 'ON_LEAVE'
          ? ' (status: ON_LEAVE)'
          : '';
        const reason = `Protected record: Employee has approved leave on ${workDateStr}${leaveDetail}. Biometric punch flagged for manual review.`;
        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: {
            syncStatus: 'IGNORED',
            errorMessage: reason,
          },
        });

        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: employee.id,
          workDate: workDateStr,
          status: 'IGNORED',
          message: reason,
        };
      }

      // F. Process by InOutMode according to explicit business rules
      const punchTime = punch.punchTime;
      const mode = punch.inOutMode;

      if (mode === 'CHECK_IN') {
        if (!existingAttendance) {
          // Normal first check-in: create attendance record
          const lateMinutes = this.calculateLateMinutes(punchTime, workDateStr, shift, timeZone);
          const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

          await tx.attendance.create({
            data: {
              companyId: punch.companyId,
              employeeId: employee.id,
              shiftId: shift?.id || null,
              workDate: workDateObj,
              checkIn: punchTime,
              checkOut: null,
              status,
              lateMinutes,
              overtimeMinutes: 0,
              source: 'BIOMETRIC',
              notes: `Biometric Check-In at ${punchTime.toISOString()}`,
            },
          });

          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'PROCESSED', errorMessage: null },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'PROCESSED',
            message: 'Check-in recorded successfully.',
          };
        } else {
          // Existing attendance record exists
          if (!existingAttendance.checkIn) {
            // Check-out was previously recorded first (out-of-order punch); now assign check-in
            if (existingAttendance.checkOut && punchTime.getTime() > existingAttendance.checkOut.getTime()) {
              const reason = 'Invalid sequence: Incoming check-in time is later than existing check-out time.';
              await tx.rawPunchLog.update({
                where: { id: punch.id },
                data: { syncStatus: 'ERROR', errorMessage: reason },
              });
              return {
                punchId: punch.id,
                userEnrollmentId: punch.userEnrollmentId,
                matchedEmployeeId: employee.id,
                workDate: workDateStr,
                status: 'ERROR',
                message: reason,
              };
            }

            const lateMinutes = this.calculateLateMinutes(punchTime, workDateStr, shift, timeZone);
            const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

            await tx.attendance.update({
              where: { id: existingAttendance.id },
              data: {
                checkIn: punchTime,
                lateMinutes,
                status,
                source: 'BIOMETRIC',
              },
            });

            await tx.rawPunchLog.update({
              where: { id: punch.id },
              data: { syncStatus: 'PROCESSED', errorMessage: null },
            });

            return {
              punchId: punch.id,
              userEnrollmentId: punch.userEnrollmentId,
              matchedEmployeeId: employee.id,
              workDate: workDateStr,
              status: 'PROCESSED',
              message: 'Check-in assigned to existing record.',
            };
          }

          // Debounce check: if duplicate within DEBOUNCE_THRESHOLD_MS
          const diffMs = Math.abs(punchTime.getTime() - existingAttendance.checkIn.getTime());
          if (diffMs <= DEBOUNCE_THRESHOLD_MS) {
            const reason = 'Duplicate check-in punch debounced within 2 minutes.';
            await tx.rawPunchLog.update({
              where: { id: punch.id },
              data: { syncStatus: 'IGNORED', errorMessage: reason },
            });
            return {
              punchId: punch.id,
              userEnrollmentId: punch.userEnrollmentId,
              matchedEmployeeId: employee.id,
              workDate: workDateStr,
              status: 'IGNORED',
              message: reason,
            };
          }

          // If incoming check-in is earlier than existing check-in, update to earliest in
          if (punchTime.getTime() < existingAttendance.checkIn.getTime()) {
            const lateMinutes = this.calculateLateMinutes(punchTime, workDateStr, shift, timeZone);
            const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

            await tx.attendance.update({
              where: { id: existingAttendance.id },
              data: {
                checkIn: punchTime,
                lateMinutes,
                status,
              },
            });

            await tx.rawPunchLog.update({
              where: { id: punch.id },
              data: { syncStatus: 'PROCESSED', errorMessage: null },
            });

            return {
              punchId: punch.id,
              userEnrollmentId: punch.userEnrollmentId,
              matchedEmployeeId: employee.id,
              workDate: workDateStr,
              status: 'PROCESSED',
              message: 'Earlier check-in updated.',
            };
          }

          // Subsequent check-in ignored to prevent overwriting genuine start of day
          const reason = `Subsequent check-in ignored: Employee already checked in at ${existingAttendance.checkIn.toISOString()}.`;
          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'IGNORED', errorMessage: reason },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'IGNORED',
            message: reason,
          };
        }
      } else if (mode === 'CHECK_OUT') {
        if (!existingAttendance) {
          // Missing check-in scenario: record check-out gracefully
          const overtimeMinutes = this.calculateOvertimeMinutes(punchTime, workDateStr, shift, timeZone);

          await tx.attendance.create({
            data: {
              companyId: punch.companyId,
              employeeId: employee.id,
              shiftId: shift?.id || null,
              workDate: workDateObj,
              checkIn: null,
              checkOut: punchTime,
              status: 'PRESENT',
              lateMinutes: 0,
              overtimeMinutes,
              source: 'BIOMETRIC',
              notes: 'Biometric check-out recorded without matching check-in.',
            },
          });

          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'PROCESSED', errorMessage: null },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'PROCESSED',
            message: 'Check-out recorded without check-in.',
          };
        } else {
          // Validate checkOut >= checkIn
          if (existingAttendance.checkIn && punchTime.getTime() < existingAttendance.checkIn.getTime()) {
            const reason = 'Invalid sequence: Check-out time is earlier than check-in time.';
            await tx.rawPunchLog.update({
              where: { id: punch.id },
              data: { syncStatus: 'ERROR', errorMessage: reason },
            });
            return {
              punchId: punch.id,
              userEnrollmentId: punch.userEnrollmentId,
              matchedEmployeeId: employee.id,
              workDate: workDateStr,
              status: 'ERROR',
              message: reason,
            };
          }

          // Debounce check: if duplicate within DEBOUNCE_THRESHOLD_MS of existing checkout
          if (existingAttendance.checkOut) {
            const diffMs = Math.abs(punchTime.getTime() - existingAttendance.checkOut.getTime());
            if (diffMs <= DEBOUNCE_THRESHOLD_MS) {
              const reason = 'Duplicate check-out punch debounced within 2 minutes.';
              await tx.rawPunchLog.update({
                where: { id: punch.id },
                data: { syncStatus: 'IGNORED', errorMessage: reason },
              });
              return {
                punchId: punch.id,
                userEnrollmentId: punch.userEnrollmentId,
                matchedEmployeeId: employee.id,
                workDate: workDateStr,
                status: 'IGNORED',
                message: reason,
              };
            }

            // If incoming checkout is earlier than existing checkout, do not regress checkout time
            if (punchTime.getTime() < existingAttendance.checkOut.getTime()) {
              const reason = `Earlier check-out ignored: Later check-out already recorded at ${existingAttendance.checkOut.toISOString()}.`;
              await tx.rawPunchLog.update({
                where: { id: punch.id },
                data: { syncStatus: 'IGNORED', errorMessage: reason },
              });
              return {
                punchId: punch.id,
                userEnrollmentId: punch.userEnrollmentId,
                matchedEmployeeId: employee.id,
                workDate: workDateStr,
                status: 'IGNORED',
                message: reason,
              };
            }
          }

          // Update check-out timestamp and recalculate overtime minutes
          const overtimeMinutes = this.calculateOvertimeMinutes(punchTime, workDateStr, shift, timeZone);

          await tx.attendance.update({
            where: { id: existingAttendance.id },
            data: {
              checkOut: punchTime,
              overtimeMinutes,
            },
          });

          await tx.rawPunchLog.update({
            where: { id: punch.id },
            data: { syncStatus: 'PROCESSED', errorMessage: null },
          });

          return {
            punchId: punch.id,
            userEnrollmentId: punch.userEnrollmentId,
            matchedEmployeeId: employee.id,
            workDate: workDateStr,
            status: 'PROCESSED',
            message: 'Check-out updated successfully.',
          };
        }
      } else {
        // BREAK_OUT or BREAK_IN
        const breakNote = `[${mode} at ${punchTime.toISOString()}]`;

        if (existingAttendance) {
          const alreadyHasNote = existingAttendance.notes?.includes(breakNote);
          if (!alreadyHasNote) {
            const updatedNotes = existingAttendance.notes
              ? `${existingAttendance.notes} ${breakNote}`
              : breakNote;

            await tx.attendance.update({
              where: { id: existingAttendance.id },
              data: { notes: updatedNotes },
            });
          }
        } else {
          await tx.attendance.create({
            data: {
              companyId: punch.companyId,
              employeeId: employee.id,
              shiftId: shift?.id || null,
              workDate: workDateObj,
              status: 'PRESENT',
              source: 'BIOMETRIC',
              notes: breakNote,
            },
          });
        }

        await tx.rawPunchLog.update({
          where: { id: punch.id },
          data: { syncStatus: 'PROCESSED', errorMessage: null },
        });

        return {
          punchId: punch.id,
          userEnrollmentId: punch.userEnrollmentId,
          matchedEmployeeId: employee.id,
          workDate: workDateStr,
          status: 'PROCESSED',
          message: `${mode} event recorded.`,
        };
      }
    });
  }

  /**
   * Bounded synchronization operation for pending raw biometric punches.
   * Prevents unbounded loops, enforces idempotency, and respects batch limits.
   */
  static async reconcilePendingPunches(
    companyId: string,
    options?: PunchReconciliationOptions,
    actorUserId?: string,
    correlationId?: string
  ): Promise<PunchReconciliationResponse> {
    const batchLimit = Math.min(500, Math.max(1, options?.batchSize || 100));

    const where: {
      companyId: string;
      syncStatus: PunchSyncStatus | { in: PunchSyncStatus[] };
      terminalId?: string;
    } = {
      companyId,
      syncStatus: options?.retryErrors
        ? { in: ['PENDING', 'ERROR'] }
        : 'PENDING',
    };

    if (options?.terminalId) {
      where.terminalId = options.terminalId;
    }

    const pendingPunches = await prisma.rawPunchLog.findMany({
      where,
      take: batchLimit,
      orderBy: [{ punchTime: 'asc' }],
      select: { id: true },
    });

    const results: PunchReconciliationItemResult[] = [];
    let processedCount = 0;
    let ignoredCount = 0;
    let errorCount = 0;

    for (const punch of pendingPunches) {
      try {
        const itemResult = await this.reconcilePunch(punch.id, correlationId);
        results.push(itemResult);

        if (itemResult.status === 'PROCESSED') processedCount++;
        else if (itemResult.status === 'IGNORED') ignoredCount++;
        else errorCount++;
      } catch (err: unknown) {
        errorCount++;
        const errorMessage = (err as Error).message || 'Reconciliation failed';
        await prisma.rawPunchLog.update({
          where: { id: punch.id },
          data: {
            syncStatus: 'ERROR',
            errorMessage,
          },
        });
        results.push({
          punchId: punch.id,
          userEnrollmentId: '',
          matchedEmployeeId: null,
          workDate: null,
          status: 'ERROR',
          message: errorMessage,
        });
      }
    }

    if (actorUserId) {
      await AuditService.log({
        companyId,
        userId: actorUserId,
        action: 'BIOMETRIC_PUNCH_RECONCILE',
        entity: 'RawPunchLog',
        entityId: companyId,
        correlationId,
        details: {
          totalEvaluated: pendingPunches.length,
          processed: processedCount,
          ignored: ignoredCount,
          errors: errorCount,
        },
      });
    }

    return {
      success: true,
      totalEvaluated: pendingPunches.length,
      processed: processedCount,
      ignored: ignoredCount,
      errors: errorCount,
      results,
    };
  }

  /**
   * Lists raw punch logs for audit inspection and reconciliation review
   */
  static async listPunches(
    companyId: string,
    filters?: {
      syncStatus?: PunchSyncStatus;
      terminalId?: string;
      matchedEmployeeId?: string;
      startDate?: string;
      endDate?: string;
    },
    pagination?: { page?: number; limit?: number }
  ): Promise<{ items: RawPunchLogItem[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, pagination?.page || 1);
    const limit = Math.min(100, Math.max(1, pagination?.limit || 20));
    const skip = (page - 1) * limit;

    const where: {
      companyId: string;
      syncStatus?: PunchSyncStatus;
      terminalId?: string;
      matchedEmployeeId?: string;
      punchTime?: { gte?: Date; lte?: Date };
    } = { companyId };

    if (filters?.syncStatus) {
      where.syncStatus = filters.syncStatus;
    }
    if (filters?.terminalId) {
      where.terminalId = filters.terminalId;
    }
    if (filters?.matchedEmployeeId) {
      where.matchedEmployeeId = filters.matchedEmployeeId;
    }
    if (filters?.startDate || filters?.endDate) {
      where.punchTime = {};
      if (filters.startDate) {
        where.punchTime.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        where.punchTime.lte = new Date(filters.endDate);
      }
    }

    const [total, records] = await Promise.all([
      prisma.rawPunchLog.count({ where }),
      prisma.rawPunchLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ punchTime: 'desc' }],
        include: {
          terminal: { select: { name: true, deviceSerialNumber: true } },
          matchedEmployee: { select: { employeeCode: true, fullName: true } },
        },
      }),
    ]);

    const items: RawPunchLogItem[] = records.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      terminalId: r.terminalId,
      terminalName: r.terminal?.name || null,
      deviceSerialNumber: r.terminal?.deviceSerialNumber || null,
      devicePunchId: r.devicePunchId,
      userEnrollmentId: r.userEnrollmentId,
      punchTime: r.punchTime.toISOString(),
      verifyType: r.verifyType,
      inOutMode: r.inOutMode,
      syncStatus: r.syncStatus,
      errorMessage: r.errorMessage,
      idempotencyKey: r.idempotencyKey,
      matchedEmployeeId: r.matchedEmployeeId,
      matchedEmployeeCode: r.matchedEmployee?.employeeCode || null,
      matchedEmployeeName: r.matchedEmployee?.fullName || null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return { items, total, page, limit };
  }

  /**
   * Retrieves summary telemetry of pending/processed/error punches across company
   */
  static async getSyncSummary(companyId: string): Promise<PunchSyncSummaryResponse> {
    const [pending, processed, ignored, error, total, terminal] = await Promise.all([
      prisma.rawPunchLog.count({ where: { companyId, syncStatus: 'PENDING' } }),
      prisma.rawPunchLog.count({ where: { companyId, syncStatus: 'PROCESSED' } }),
      prisma.rawPunchLog.count({ where: { companyId, syncStatus: 'IGNORED' } }),
      prisma.rawPunchLog.count({ where: { companyId, syncStatus: 'ERROR' } }),
      prisma.rawPunchLog.count({ where: { companyId } }),
      prisma.biometricTerminal.findFirst({
        where: { companyId, lastSyncAt: { not: null } },
        orderBy: { lastSyncAt: 'desc' },
        select: { lastSyncAt: true },
      }),
    ]);

    return {
      pendingCount: pending,
      processedCount: processed,
      ignoredCount: ignored,
      errorCount: error,
      totalCount: total,
      lastSyncAt: terminal?.lastSyncAt ? terminal.lastSyncAt.toISOString() : null,
    };
  }
}
