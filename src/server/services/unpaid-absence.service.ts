import { Decimal, AccountingMath } from '../accounting/decimal-math.js';
import { prisma } from '../db/client.js';

export interface UnpaidDateEntry {
  date: string;
  units: Decimal;
  source: 'LEAVE' | 'ATTENDANCE_ABSENT' | 'ATTENDANCE_HALF_DAY';
  notes?: string;
}

export interface UnpaidAbsenceResult {
  totalUnpaidDays: Decimal;
  calendarDaysInPeriod: number;
  breakdown: UnpaidDateEntry[];
  clippedLeaveCount: number;
}

export class UnpaidAbsenceService {
  /**
   * Calculates total unpaid absence days for an employee in a given payroll period.
   *
   * Core Guarantees:
   * 1. Strictly clips multi-period leave requests to [startDate, endDate] boundary.
   * 2. De-duplicates overlapping approved unpaid leave and ABSENT attendance on the same calendar date.
   * 3. Explicitly supports HALF_DAY attendance (0.5 unpaid days) where applicable.
   * 4. Decimal-safe arithmetic for fractional absence days.
   * 5. No date is counted more than once.
   */
  static async calculateEmployeeUnpaidDays(params: {
    companyId: string;
    employeeId: string;
    startDate: Date;
    endDate: Date;
    tx?: any;
  }): Promise<UnpaidAbsenceResult> {
    const { companyId, employeeId, startDate, endDate, tx } = params;
    const client = tx || prisma;

    // Normalizing period boundaries to UTC midnight for date arithmetic
    const periodStart = new Date(startDate.toISOString().split('T')[0] + 'T00:00:00.000Z');
    const periodEnd = new Date(endDate.toISOString().split('T')[0] + 'T23:59:59.999Z');

    const diffMs = periodEnd.getTime() - periodStart.getTime();
    const calendarDaysInPeriod = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)));

    // Map: date string (YYYY-MM-DD) -> UnpaidDateEntry
    const dateMap = new Map<string, UnpaidDateEntry>();
    let clippedLeaveCount = 0;

    // 1. Fetch approved unpaid leave requests overlapping this period
    const unpaidLeaveRequests = await client.leaveRequest.findMany({
      where: {
        companyId,
        employeeId,
        status: 'APPROVED',
        startDate: { lte: periodEnd },
        endDate: { gte: periodStart },
        leaveType: { isPaid: false },
      },
      include: {
        leaveType: { select: { code: true, name: true } },
      },
      orderBy: { startDate: 'asc' },
    });

    for (const lr of unpaidLeaveRequests) {
      clippedLeaveCount++;
      const lrStart = new Date(lr.startDate.toISOString().split('T')[0] + 'T00:00:00.000Z');
      const lrEnd = new Date(lr.endDate.toISOString().split('T')[0] + 'T23:59:59.999Z');

      // Clip leave dates to period boundaries
      const effectiveStart = lrStart < periodStart ? periodStart : lrStart;
      const effectiveEnd = lrEnd > periodEnd ? periodEnd : lrEnd;

      // Determine daily rate for leave
      // If totalDays is specified and fractional (< 1.0 for single day), respect fraction
      const totalDaysDecimal = AccountingMath.from(lr.totalDays);
      const isFractionalSingleDay = AccountingMath.lt(totalDaysDecimal, 1) && AccountingMath.gt(totalDaysDecimal, 0);
      const dailyUnits = isFractionalSingleDay ? totalDaysDecimal : new Decimal(1.0);

      const cursor = new Date(effectiveStart);
      while (cursor <= effectiveEnd) {
        const dateKey = cursor.toISOString().split('T')[0];
        dateMap.set(dateKey, {
          date: dateKey,
          units: dailyUnits,
          source: 'LEAVE',
          notes: `Approved unpaid leave: ${lr.leaveType.name}`,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    // 2. Fetch attendance records within the period
    const attendances = await client.attendance.findMany({
      where: {
        companyId,
        employeeId,
        workDate: { gte: periodStart, lte: periodEnd },
      },
      orderBy: { workDate: 'asc' },
    });

    for (const att of attendances) {
      const dateKey = att.workDate.toISOString().split('T')[0];

      if (att.status === 'ABSENT') {
        const existing = dateMap.get(dateKey);
        if (existing) {
          // Date already has unpaid deduction (e.g. from approved unpaid leave).
          // Do NOT add another full day of deduction!
          if (AccountingMath.lt(existing.units, 1.0)) {
            // Escalate partial deduction to full day if attendance was marked ABSENT
            existing.units = new Decimal(1.0);
            existing.source = 'ATTENDANCE_ABSENT';
            existing.notes = 'Absent attendance (escalated from partial leave)';
          }
        } else {
          dateMap.set(dateKey, {
            date: dateKey,
            units: new Decimal(1.0),
            source: 'ATTENDANCE_ABSENT',
            notes: 'Marked ABSENT in daily attendance',
          });
        }
      } else if (att.status === 'HALF_DAY') {
        const existing = dateMap.get(dateKey);
        if (!existing) {
          // Half day counts as 0.5 unpaid day
          dateMap.set(dateKey, {
            date: dateKey,
            units: new Decimal(0.5),
            source: 'ATTENDANCE_HALF_DAY',
            notes: 'Half-day attendance (0.5 unpaid day)',
          });
        }
        // If already marked as 1.0 (from full-day unpaid leave or absent), leave remains 1.0
      }
    }

    // 3. Sum deduplicated unpaid days with Decimal precision
    let totalUnpaidDays = new Decimal(0);
    const breakdown: UnpaidDateEntry[] = [];

    for (const entry of dateMap.values()) {
      totalUnpaidDays = totalUnpaidDays.plus(entry.units);
      breakdown.push(entry);
    }

    // Sort breakdown chronologically
    breakdown.sort((a, b) => a.date.localeCompare(b.date));

    return {
      totalUnpaidDays,
      calendarDaysInPeriod,
      breakdown,
      clippedLeaveCount,
    };
  }
}
