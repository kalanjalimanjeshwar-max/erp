import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WorkPolicyService,
  formatUtcDateOnly,
  parseUtcDateOnly,
  getFirstDayOfNextCalendarMonth,
  WorkPolicyRevisionRecord,
} from '../../src/server/services/work-policy.service.js';

function createInMemoryTx(options?: {
  timezone?: string;
  initialRevisions?: Array<{
    id: string;
    companyId: string;
    employeeId: string;
    shiftId: string | null;
    dailyWorkingHours: number | null;
    monthlyLeaveAllowance: number | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    revisionReason?: string | null;
    notes?: string | null;
    createdByUserId: string;
  }>;
  lockedPayrollPeriods?: Array<{
    id: string;
    companyId: string;
    name: string;
    status: string;
    startDate: Date;
    endDate: Date;
  }>;
}) {
  let nextId = 1;
  const rows: WorkPolicyRevisionRecord[] = (options?.initialRevisions || []).map((r) => ({
    ...r,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  }));
  const employeeUpdates: any[] = [];
  const periods = options?.lockedPayrollPeriods || [];

  const tx = {
    company: {
      findUnique: vi.fn().mockResolvedValue({ timezone: options?.timezone || 'UTC' }),
    },
    payrollPeriod: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        const gteDate: Date | undefined = where?.endDate?.gte;
        const allowedStatuses: string[] = where?.status?.in || [];
        return (
          periods.find(
            (p) =>
              p.companyId === where.companyId &&
              allowedStatuses.includes(p.status) &&
              (!gteDate || p.endDate >= gteDate)
          ) || null
        );
      }),
    },
    employeeWorkPolicyRevision: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        return rows
          .filter((r) => r.companyId === where.companyId && r.employeeId === where.employeeId)
          .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())
          .map((r) => ({ ...r }));
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx === -1) throw new Error('Revision not found');
        rows[idx] = {
          ...rows[idx],
          ...data,
          updatedAt: new Date(),
        };
        return { ...rows[idx] };
      }),
      deleteMany: vi.fn().mockImplementation(async ({ where }: any) => {
        const gteDate: Date | undefined = where?.effectiveFrom?.gte;
        let deleted = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (
            r.companyId === where.companyId &&
            r.employeeId === where.employeeId &&
            (!gteDate || r.effectiveFrom.getTime() >= gteDate.getTime())
          ) {
            rows.splice(i, 1);
            deleted++;
          }
        }
        return { count: deleted };
      }),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        const fromStr = formatUtcDateOnly(data.effectiveFrom);
        const toStr = data.effectiveTo ? formatUtcDateOnly(data.effectiveTo) : null;
        // Simulate DB non-overlap and open-period uniqueness check
        for (const existing of rows) {
          if (existing.companyId !== data.companyId || existing.employeeId !== data.employeeId) continue;
          const eFrom = formatUtcDateOnly(existing.effectiveFrom);
          const eTo = existing.effectiveTo ? formatUtcDateOnly(existing.effectiveTo) : null;
          if (eFrom === fromStr) {
            throw new Error(`Duplicate effectiveFrom constraint violation on ${fromStr}`);
          }
          if (eTo === null && toStr === null) {
            throw new Error('Partial open-period unique constraint violation');
          }
          const overlaps =
            (toStr === null || eFrom <= toStr) && (eTo === null || eTo >= fromStr);
          if (overlaps) {
            throw new Error(`Overlapping period constraint violation: [${fromStr}, ${toStr}] vs [${eFrom}, ${eTo}]`);
          }
        }
        const created: WorkPolicyRevisionRecord = {
          id: `rev-gen-${nextId++}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(created);
        return { ...created };
      }),
    },
    employee: {
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        employeeUpdates.push({ where, data });
        return { id: where.id, ...data };
      }),
    },
  };

  return { tx, rows, employeeUpdates };
}

describe('WorkPolicyService - Effective-Dated Policy Resolution & Next-Month Leave Allowance', () => {
  const companyId = 'comp-1';
  const employeeId = 'emp-1';
  const userId = 'admin-1';

  const dayShift = {
    id: 'shift-day',
    code: 'DAY8',
    name: 'Day Shift',
    startTime: '09:00',
    endTime: '17:00',
    isOvernight: false,
    graceMinutes: 15,
  };

  const nightShift = {
    id: 'shift-night',
    code: 'NIGHT9',
    name: 'Night Shift',
    startTime: '21:00',
    endTime: '06:00',
    isOvernight: true,
    graceMinutes: 15,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves daily required hours using employee dailyWorkingHours first, then shift duration, then null', () => {
    // 1. Employee-specific hours override shift (even when no shift assigned)
    const customNoShift = WorkPolicyService.resolvePolicyForDate({
      date: '2026-11-15',
      employee: {
        shiftId: null,
        shift: null,
        dailyWorkingHours: 7.5,
        monthlyLeaveAllowance: null,
      },
    });
    expect(customNoShift.effectiveDailyWorkingHours).toBe(7.5);
    expect(customNoShift.effectiveDailyRequiredMinutes).toBe(450);
    expect(customNoShift.monthlyLeaveAllowance).toBe(4);

    // 2. Fallback to shift duration when dailyWorkingHours is null
    const shiftOnly = WorkPolicyService.resolvePolicyForDate({
      date: '2026-11-15',
      employee: {
        shiftId: nightShift.id,
        shift: nightShift,
        dailyWorkingHours: null,
        monthlyLeaveAllowance: 3,
      },
    });
    expect(shiftOnly.effectiveDailyWorkingHours).toBe(9);
    expect(shiftOnly.effectiveDailyRequiredMinutes).toBe(540);
    expect(shiftOnly.monthlyLeaveAllowance).toBe(3);

    // 3. Explicit dailyWorkingHours takes precedence over assigned Shift duration
    const customOverridesShift = WorkPolicyService.resolvePolicyForDate({
      date: '2026-11-15',
      employee: {
        shiftId: dayShift.id,
        shift: dayShift,
        dailyWorkingHours: 6,
      },
    });
    expect(customOverridesShift.effectiveDailyWorkingHours).toBe(6);
    expect(customOverridesShift.effectiveDailyRequiredMinutes).toBe(360);

    // 4. Null when neither dailyWorkingHours nor Shift exists
    const unconfigured = WorkPolicyService.resolvePolicyForDate({
      date: '2026-11-15',
      employee: { shiftId: null, shift: null, dailyWorkingHours: null },
    });
    expect(unconfigured.effectiveDailyWorkingHours).toBeNull();
    expect(unconfigured.effectiveDailyRequiredMinutes).toBeNull();
  });

  it('computes 1st day of next calendar month in company local timezone (including year rollover and UTC boundary)', () => {
    // Nov 15, 2026 -> Dec 1, 2026
    expect(
      formatUtcDateOnly(
        getFirstDayOfNextCalendarMonth('UTC', new Date('2026-11-15T10:00:00.000Z'))
      )
    ).toBe('2026-12-01');

    // Dec 20, 2026 -> Jan 1, 2027
    expect(
      formatUtcDateOnly(
        getFirstDayOfNextCalendarMonth('UTC', new Date('2026-12-20T12:00:00.000Z'))
      )
    ).toBe('2027-01-01');

    // Timezone crossing midnight on Nov 30 UTC -> Dec 1 local in Asia/Kolkata (+05:30)
    // 2026-11-30T20:00:00.000Z is 2026-12-01 01:30 IST -> next month is Jan 1, 2027
    expect(
      formatUtcDateOnly(
        getFirstDayOfNextCalendarMonth('Asia/Kolkata', new Date('2026-11-30T20:00:00.000Z'))
      )
    ).toBe('2027-01-01');
  });

  it('defers monthlyLeaveAllowance change to 1st of next month while preserving current month at 4 days', async () => {
    const { tx, rows, employeeUpdates } = createInMemoryTx({
      timezone: 'UTC',
      initialRevisions: [
        {
          id: 'rev-init',
          companyId,
          employeeId,
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 4,
          effectiveFrom: parseUtcDateOnly('2026-01-01'),
          effectiveTo: null,
          createdByUserId: userId,
        },
      ],
    });

    const result = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
      companyId,
      employee: {
        id: employeeId,
        dateOfJoining: parseUtcDateOnly('2026-01-01'),
        shiftId: dayShift.id,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
      },
      nextMonthlyLeaveAllowance: 2,
      submittedAt: new Date('2026-11-15T12:00:00.000Z'),
      createdByUserId: userId,
    });

    expect(result.applied).toBe(true);
    expect(result.allowanceEffectiveFrom).toBe('2026-12-01');
    expect(rows).toHaveLength(2);
    expect(formatUtcDateOnly(rows[0].effectiveFrom)).toBe('2026-01-01');
    expect(formatUtcDateOnly(rows[0].effectiveTo!)).toBe('2026-11-30');
    expect(Number(rows[0].monthlyLeaveAllowance)).toBe(4);

    expect(formatUtcDateOnly(rows[1].effectiveFrom)).toBe('2026-12-01');
    expect(rows[1].effectiveTo).toBeNull();
    expect(Number(rows[1].monthlyLeaveAllowance)).toBe(2);

    // Employee snapshot must keep November allowance = 4 during November!
    expect(employeeUpdates[0].data.monthlyLeaveAllowance).toBe(4);

    // Month resolution: November stays 4, December becomes 2
    expect(
      WorkPolicyService.resolveMonthlyLeaveAllowanceForMonth({
        year: 2026,
        month: 11,
        employee: { monthlyLeaveAllowance: 4 },
        revisions: rows,
      })
    ).toBe(4);
    expect(
      WorkPolicyService.resolveMonthlyLeaveAllowanceForMonth({
        year: 2026,
        month: 12,
        employee: { monthlyLeaveAllowance: 4 },
        revisions: rows,
      })
    ).toBe(2);
  });

  it('splits timeline cleanly when dailyWorkingHours and monthlyLeaveAllowance change simultaneously with different effective dates', async () => {
    // Pre-Step-1 employee with 0 revision rows initially
    const { tx, rows, employeeUpdates } = createInMemoryTx({ timezone: 'UTC' });

    const result = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
      companyId,
      employee: {
        id: employeeId,
        dateOfJoining: parseUtcDateOnly('2026-01-01'),
        shiftId: dayShift.id,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
      },
      nextDailyWorkingHours: 7,
      nextMonthlyLeaveAllowance: 2,
      workPolicyEffectiveFrom: '2026-11-15',
      submittedAt: new Date('2026-11-15T09:00:00.000Z'),
      createdByUserId: userId,
    });

    expect(result.applied).toBe(true);
    expect(result.workPolicyEffectiveFrom).toBe('2026-11-15');
    expect(result.allowanceEffectiveFrom).toBe('2026-12-01');

    // Should produce 3 contiguous non-overlapping slices:
    // [Jan 1..Nov 14]: 8h, allow 4
    // [Nov 15..Nov 30]: 7h, allow 4
    // [Dec 1..null]: 7h, allow 2
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => ({
      from: formatUtcDateOnly(r.effectiveFrom),
      to: r.effectiveTo ? formatUtcDateOnly(r.effectiveTo) : null,
      hours: Number(r.dailyWorkingHours),
      allow: Number(r.monthlyLeaveAllowance),
    }))).toEqual([
      { from: '2026-01-01', to: '2026-11-14', hours: 8, allow: 4 },
      { from: '2026-11-15', to: '2026-11-30', hours: 7, allow: 4 },
      { from: '2026-12-01', to: null, hours: 7, allow: 2 },
    ]);

    // Today (Nov 15) snapshot has dailyWorkingHours=7 and monthlyLeaveAllowance=4
    expect(employeeUpdates[0].data.dailyWorkingHours).toBe(7);
    expect(employeeUpdates[0].data.monthlyLeaveAllowance).toBe(4);
  });

  it('preserves scheduled Dec 1 allowance change when dailyWorkingHours is subsequently changed mid-November', async () => {
    const { tx, rows } = createInMemoryTx({
      timezone: 'UTC',
      initialRevisions: [
        {
          id: 'rev-1',
          companyId,
          employeeId,
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 4,
          effectiveFrom: parseUtcDateOnly('2026-01-01'),
          effectiveTo: parseUtcDateOnly('2026-11-30'),
          createdByUserId: userId,
        },
        {
          id: 'rev-2',
          companyId,
          employeeId,
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 2,
          effectiveFrom: parseUtcDateOnly('2026-12-01'),
          effectiveTo: null,
          createdByUserId: userId,
        },
      ],
    });

    await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
      companyId,
      employee: {
        id: employeeId,
        dateOfJoining: parseUtcDateOnly('2026-01-01'),
        shiftId: dayShift.id,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
      },
      nextShiftId: nightShift.id,
      nextDailyWorkingHours: 6.5,
      workPolicyEffectiveFrom: '2026-11-20',
      submittedAt: new Date('2026-11-20T09:00:00.000Z'),
      createdByUserId: userId,
    });

    expect(rows.map((r) => ({
      from: formatUtcDateOnly(r.effectiveFrom),
      to: r.effectiveTo ? formatUtcDateOnly(r.effectiveTo) : null,
      shiftId: r.shiftId,
      hours: Number(r.dailyWorkingHours),
      allow: Number(r.monthlyLeaveAllowance),
    }))).toEqual([
      { from: '2026-01-01', to: '2026-11-19', shiftId: dayShift.id, hours: 8, allow: 4 },
      { from: '2026-11-20', to: '2026-11-30', shiftId: nightShift.id, hours: 6.5, allow: 4 },
      { from: '2026-12-01', to: null, shiftId: nightShift.id, hours: 6.5, allow: 2 },
    ]);
  });

  it('blocks policy changes overlapping ACCOUNTS_APPROVED, PROCESSED, or POSTED payroll periods', async () => {
    for (const status of ['PROCESSED', 'ACCOUNTS_APPROVED', 'POSTED']) {
      const { tx } = createInMemoryTx({
        lockedPayrollPeriods: [
          {
            id: 'pp-nov',
            companyId,
            name: '2026-11 Payroll',
            status,
            startDate: new Date('2026-11-01T00:00:00.000Z'),
            endDate: new Date('2026-11-30T23:59:59.999Z'),
          },
        ],
      });

      await expect(
        WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
          companyId,
          employee: {
            id: employeeId,
            dateOfJoining: parseUtcDateOnly('2026-01-01'),
            shiftId: null,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 4,
          },
          nextDailyWorkingHours: 7,
          workPolicyEffectiveFrom: '2026-11-15',
          submittedAt: new Date('2026-11-15T10:00:00.000Z'),
          createdByUserId: userId,
        })
      ).rejects.toThrow(new RegExp(status));
    }
  });

  it('rejects out-of-range dailyWorkingHours, monthlyLeaveAllowance, and pre-joining effectiveFrom dates', async () => {
    const { tx } = createInMemoryTx();
    const baseEmp = {
      id: employeeId,
      dateOfJoining: parseUtcDateOnly('2026-05-01'),
      shiftId: null,
      dailyWorkingHours: 8,
      monthlyLeaveAllowance: 4,
    };

    await expect(
      WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: baseEmp,
        nextDailyWorkingHours: 0,
        createdByUserId: userId,
      })
    ).rejects.toThrow(/greater than 0 and at most 24/);

    await expect(
      WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: baseEmp,
        nextDailyWorkingHours: 25,
        createdByUserId: userId,
      })
    ).rejects.toThrow(/greater than 0 and at most 24/);

    await expect(
      WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: baseEmp,
        nextMonthlyLeaveAllowance: 32,
        createdByUserId: userId,
      })
    ).rejects.toThrow(/between 0 and 31/);

    await expect(
      WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: baseEmp,
        nextDailyWorkingHours: 7,
        workPolicyEffectiveFrom: '2026-04-30',
        submittedAt: new Date('2026-11-15T00:00:00.000Z'),
        createdByUserId: userId,
      })
    ).rejects.toThrow(/earlier than employee date of joining/);
  });

  it('backdates before the first existing revision by inserting a preceding segment without losing existing future revisions', async () => {
    const dayShift = { id: 'shift-day', name: 'Day', workingHours: 8, isActive: true };
    const nightShift = { id: 'shift-night', name: 'Night', workingHours: 6, isActive: true };
    const { tx, rows } = createInMemoryTx({
      timezone: 'UTC',
      initialRevisions: [
        {
          id: 'rev-1',
          companyId,
          employeeId,
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 4,
          effectiveFrom: parseUtcDateOnly('2026-06-01'),
          effectiveTo: parseUtcDateOnly('2026-11-30'),
          createdByUserId: userId,
        },
        {
          id: 'rev-2',
          companyId,
          employeeId,
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 2,
          effectiveFrom: parseUtcDateOnly('2026-12-01'),
          effectiveTo: null,
          createdByUserId: userId,
        },
      ],
    });

    await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
      companyId,
      employee: {
        id: employeeId,
        dateOfJoining: parseUtcDateOnly('2026-01-01'),
        shiftId: dayShift.id,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
      },
      nextShiftId: nightShift.id,
      nextDailyWorkingHours: 6,
      workPolicyEffectiveFrom: '2026-03-01',
      submittedAt: new Date('2026-03-01T10:00:00.000Z'),
      createdByUserId: userId,
    });

    expect(
      rows.map((r) => ({
        from: formatUtcDateOnly(r.effectiveFrom),
        to: r.effectiveTo ? formatUtcDateOnly(r.effectiveTo) : null,
        shiftId: r.shiftId,
        hours: Number(r.dailyWorkingHours),
        allow: Number(r.monthlyLeaveAllowance),
      }))
    ).toEqual([
      { from: '2026-03-01', to: '2026-05-31', shiftId: nightShift.id, hours: 6, allow: 4 },
      { from: '2026-06-01', to: '2026-11-30', shiftId: dayShift.id, hours: 8, allow: 4 },
      { from: '2026-12-01', to: null, shiftId: dayShift.id, hours: 8, allow: 2 },
    ]);

    for (let i = 0; i < rows.length - 1; i++) {
      expect(formatUtcDateOnly(rows[i].effectiveTo!)).toBe(
        formatUtcDateOnly(new Date(rows[i + 1].effectiveFrom.getTime() - 86400000))
      );
    }
  });

  it('preserves future scheduled shiftId, dailyWorkingHours, and monthlyLeaveAllowance revisions with zero overlap', async () => {
    const dayShift = { id: 'shift-day', name: 'Day', workingHours: 8, isActive: true };
    const swingShift = { id: 'shift-swing', name: 'Swing', workingHours: 7, isActive: true };
    const nightShift = { id: 'shift-night', name: 'Night', workingHours: 6, isActive: true };

    const { tx, rows } = createInMemoryTx({
      timezone: 'UTC',
      initialRevisions: [
        {
          id: 'rev-1',
          companyId,
          employeeId,
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 4,
          effectiveFrom: parseUtcDateOnly('2026-01-01'),
          effectiveTo: parseUtcDateOnly('2026-11-30'),
          createdByUserId: userId,
        },
        {
          id: 'rev-2',
          companyId,
          employeeId,
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 2,
          effectiveFrom: parseUtcDateOnly('2026-12-01'),
          effectiveTo: parseUtcDateOnly('2026-12-31'),
          createdByUserId: userId,
        },
        {
          id: 'rev-3',
          companyId,
          employeeId,
          shiftId: nightShift.id,
          dailyWorkingHours: 6,
          monthlyLeaveAllowance: 2,
          effectiveFrom: parseUtcDateOnly('2027-01-01'),
          effectiveTo: null,
          createdByUserId: userId,
        },
      ],
    });

    await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
      companyId,
      employee: {
        id: employeeId,
        dateOfJoining: parseUtcDateOnly('2026-01-01'),
        shiftId: dayShift.id,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
      },
      nextShiftId: swingShift.id,
      nextDailyWorkingHours: 7,
      workPolicyEffectiveFrom: '2026-11-15',
      submittedAt: new Date('2026-11-15T09:00:00.000Z'),
      createdByUserId: userId,
    });

    expect(
      rows.map((r) => ({
        from: formatUtcDateOnly(r.effectiveFrom),
        to: r.effectiveTo ? formatUtcDateOnly(r.effectiveTo) : null,
        shiftId: r.shiftId,
        hours: Number(r.dailyWorkingHours),
        allow: Number(r.monthlyLeaveAllowance),
      }))
    ).toEqual([
      { from: '2026-01-01', to: '2026-11-14', shiftId: dayShift.id, hours: 8, allow: 4 },
      { from: '2026-11-15', to: '2026-11-30', shiftId: swingShift.id, hours: 7, allow: 4 },
      { from: '2026-12-01', to: '2026-12-31', shiftId: swingShift.id, hours: 7, allow: 2 },
      { from: '2027-01-01', to: null, shiftId: nightShift.id, hours: 6, allow: 2 },
    ]);

    for (let i = 0; i < rows.length - 1; i++) {
      expect(formatUtcDateOnly(rows[i].effectiveTo!)).toBe(
        formatUtcDateOnly(new Date(rows[i + 1].effectiveFrom.getTime() - 86400000))
      );
    }
    expect(rows[rows.length - 1].effectiveTo).toBeNull();
  });

  describe('P2-3: Preserving already scheduled next-month monthlyLeaveAllowance', () => {
    it('preserves scheduled next-month allowance of 6 when caller resubmits current allowance of 5 alongside a shift change', async () => {
      const { tx, rows } = createInMemoryTx({
        timezone: 'UTC',
        initialRevisions: [
          {
            id: 'rev-hist',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 4,
            effectiveFrom: parseUtcDateOnly('2026-01-01'),
            effectiveTo: parseUtcDateOnly('2026-09-30'),
            createdByUserId: userId,
          },
          {
            id: 'rev-curr',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 5,
            effectiveFrom: parseUtcDateOnly('2026-10-01'),
            effectiveTo: parseUtcDateOnly('2026-11-30'),
            createdByUserId: userId,
          },
          {
            id: 'rev-next',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 6,
            effectiveFrom: parseUtcDateOnly('2026-12-01'),
            effectiveTo: null,
            createdByUserId: userId,
          },
        ],
      });

      const result = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: {
          id: employeeId,
          dateOfJoining: parseUtcDateOnly('2026-01-01'),
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
        },
        nextShiftId: nightShift.id,
        nextMonthlyLeaveAllowance: 5, // Raw API caller resubmitting current effective allowance
        workPolicyEffectiveFrom: '2026-11-15',
        submittedAt: new Date('2026-11-15T09:00:00.000Z'),
        createdByUserId: userId,
      });

      expect(result.applied).toBe(true);
      expect(result.workPolicyEffectiveFrom).toBe('2026-11-15');
      expect(result.allowanceEffectiveFrom).toBeNull();
      expect(
        rows.map((r) => ({
          from: formatUtcDateOnly(r.effectiveFrom),
          to: r.effectiveTo ? formatUtcDateOnly(r.effectiveTo) : null,
          shiftId: r.shiftId,
          hours: Number(r.dailyWorkingHours),
          allow: Number(r.monthlyLeaveAllowance),
        }))
      ).toEqual([
        { from: '2026-01-01', to: '2026-09-30', shiftId: dayShift.id, hours: 8, allow: 4 },
        { from: '2026-10-01', to: '2026-11-14', shiftId: dayShift.id, hours: 8, allow: 5 },
        { from: '2026-11-15', to: '2026-11-30', shiftId: nightShift.id, hours: 8, allow: 5 },
        { from: '2026-12-01', to: null, shiftId: nightShift.id, hours: 8, allow: 6 },
      ]);
    });

    it('preserves scheduled next-month allowance of 6 during a dailyWorkingHours-only update (with resubmitted 5 and with omitted allowance)', async () => {
      const { tx, rows } = createInMemoryTx({
        timezone: 'UTC',
        initialRevisions: [
          {
            id: 'rev-curr',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 5,
            effectiveFrom: parseUtcDateOnly('2026-01-01'),
            effectiveTo: parseUtcDateOnly('2026-11-30'),
            createdByUserId: userId,
          },
          {
            id: 'rev-next',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 6,
            effectiveFrom: parseUtcDateOnly('2026-12-01'),
            effectiveTo: null,
            createdByUserId: userId,
          },
        ],
      });

      // 1. dailyWorkingHours update resubmitting current effective allowance 5
      const resWithEcho = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: {
          id: employeeId,
          dateOfJoining: parseUtcDateOnly('2026-01-01'),
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
        },
        nextDailyWorkingHours: 7,
        nextMonthlyLeaveAllowance: 5,
        workPolicyEffectiveFrom: '2026-11-15',
        submittedAt: new Date('2026-11-15T09:00:00.000Z'),
        createdByUserId: userId,
      });

      expect(resWithEcho.applied).toBe(true);
      expect(resWithEcho.allowanceEffectiveFrom).toBeNull();
      expect(
        rows.map((r) => ({
          from: formatUtcDateOnly(r.effectiveFrom),
          to: r.effectiveTo ? formatUtcDateOnly(r.effectiveTo) : null,
          hours: Number(r.dailyWorkingHours),
          allow: Number(r.monthlyLeaveAllowance),
        }))
      ).toEqual([
        { from: '2026-01-01', to: '2026-11-14', hours: 8, allow: 5 },
        { from: '2026-11-15', to: '2026-11-30', hours: 7, allow: 5 },
        { from: '2026-12-01', to: null, hours: 7, allow: 6 },
      ]);

      // 2. Subsequent dailyWorkingHours-only update with omitted monthlyLeaveAllowance
      const resOmitted = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: {
          id: employeeId,
          dateOfJoining: parseUtcDateOnly('2026-01-01'),
          shiftId: dayShift.id,
          dailyWorkingHours: 7,
          monthlyLeaveAllowance: 5,
        },
        nextDailyWorkingHours: 6.5,
        workPolicyEffectiveFrom: '2026-11-20',
        submittedAt: new Date('2026-11-20T09:00:00.000Z'),
        createdByUserId: userId,
      });

      expect(resOmitted.applied).toBe(true);
      expect(resOmitted.allowanceEffectiveFrom).toBeNull();
      expect(
        rows.map((r) => ({
          from: formatUtcDateOnly(r.effectiveFrom),
          to: r.effectiveTo ? formatUtcDateOnly(r.effectiveTo) : null,
          hours: Number(r.dailyWorkingHours),
          allow: Number(r.monthlyLeaveAllowance),
        }))
      ).toEqual([
        { from: '2026-01-01', to: '2026-11-14', hours: 8, allow: 5 },
        { from: '2026-11-15', to: '2026-11-19', hours: 7, allow: 5 },
        { from: '2026-11-20', to: '2026-11-30', hours: 6.5, allow: 5 },
        { from: '2026-12-01', to: null, hours: 6.5, allow: 6 },
      ]);
    });

    it('still schedules the intended next-month revision when explicitly changing to another permitted allowance while preserving historical and later future revisions', async () => {
      const { tx, rows } = createInMemoryTx({
        timezone: 'UTC',
        initialRevisions: [
          {
            id: 'rev-hist',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 5,
            effectiveFrom: parseUtcDateOnly('2026-01-01'),
            effectiveTo: parseUtcDateOnly('2026-11-30'),
            createdByUserId: userId,
          },
          {
            id: 'rev-dec',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 6,
            effectiveFrom: parseUtcDateOnly('2026-12-01'),
            effectiveTo: parseUtcDateOnly('2026-12-31'),
            createdByUserId: userId,
          },
          {
            id: 'rev-jan',
            companyId,
            employeeId,
            shiftId: nightShift.id,
            dailyWorkingHours: 7,
            monthlyLeaveAllowance: 5,
            effectiveFrom: parseUtcDateOnly('2027-01-01'),
            effectiveTo: null,
            createdByUserId: userId,
          },
        ],
      });

      const result = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: {
          id: employeeId,
          dateOfJoining: parseUtcDateOnly('2026-01-01'),
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
        },
        nextMonthlyLeaveAllowance: 4, // Explicit change to a different permitted allowance (4 != 5 && 4 != 6)
        submittedAt: new Date('2026-11-18T10:00:00.000Z'),
        createdByUserId: userId,
      });

      expect(result.applied).toBe(true);
      expect(result.allowanceEffectiveFrom).toBe('2026-12-01');
      expect(
        rows.map((r) => ({
          from: formatUtcDateOnly(r.effectiveFrom),
          to: r.effectiveTo ? formatUtcDateOnly(r.effectiveTo) : null,
          shiftId: r.shiftId,
          hours: Number(r.dailyWorkingHours),
          allow: Number(r.monthlyLeaveAllowance),
        }))
      ).toEqual([
        { from: '2026-01-01', to: '2026-11-30', shiftId: dayShift.id, hours: 8, allow: 5 },
        { from: '2026-12-01', to: '2026-12-31', shiftId: dayShift.id, hours: 8, allow: 4 },
        { from: '2027-01-01', to: null, shiftId: nightShift.id, hours: 7, allow: 5 },
      ]);
    });

    it('remains compatible with default [4, 5, 6] allowance behavior when current month uses implicit default 4 and next month is scheduled to 6', async () => {
      const { tx, rows } = createInMemoryTx({
        timezone: 'UTC',
        initialRevisions: [
          {
            id: 'rev-default-curr',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: null, // Implicit default 4
            effectiveFrom: parseUtcDateOnly('2026-01-01'),
            effectiveTo: parseUtcDateOnly('2026-11-30'),
            createdByUserId: userId,
          },
          {
            id: 'rev-next-6',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 6,
            effectiveFrom: parseUtcDateOnly('2026-12-01'),
            effectiveTo: null,
            createdByUserId: userId,
          },
        ],
      });

      // Resubmitting default 4 alongside shift change must preserve scheduled 6
      const resKeep = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: {
          id: employeeId,
          dateOfJoining: parseUtcDateOnly('2026-01-01'),
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: null,
        },
        nextShiftId: nightShift.id,
        nextMonthlyLeaveAllowance: 4,
        workPolicyEffectiveFrom: '2026-11-15',
        submittedAt: new Date('2026-11-15T10:00:00.000Z'),
        createdByUserId: userId,
      });

      expect(resKeep.applied).toBe(true);
      expect(resKeep.allowanceEffectiveFrom).toBeNull();
      expect(Number(rows[rows.length - 1].monthlyLeaveAllowance)).toBe(6);

      // Explicitly selecting 5 (another permitted default option) still updates Dec 1 to 5
      const resExplicit5 = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: {
          id: employeeId,
          dateOfJoining: parseUtcDateOnly('2026-01-01'),
          shiftId: nightShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: null,
        },
        nextMonthlyLeaveAllowance: 5,
        submittedAt: new Date('2026-11-16T10:00:00.000Z'),
        createdByUserId: userId,
      });

      expect(resExplicit5.applied).toBe(true);
      expect(resExplicit5.allowanceEffectiveFrom).toBe('2026-12-01');
      expect(Number(rows[rows.length - 1].monthlyLeaveAllowance)).toBe(5);
    });

    it('Decision 2 (P2-3): reverts scheduled next-month allowance (6 -> 5) on explicit revision while keeping current month, historical, and later future revisions intact without overlap', async () => {
      const { tx, rows } = createInMemoryTx({
        timezone: 'UTC',
        initialRevisions: [
          {
            id: 'rev-hist',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 4,
            effectiveFrom: parseUtcDateOnly('2026-01-01'),
            effectiveTo: parseUtcDateOnly('2026-09-30'),
            createdByUserId: userId,
          },
          {
            id: 'rev-curr',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 5,
            effectiveFrom: parseUtcDateOnly('2026-10-01'),
            effectiveTo: parseUtcDateOnly('2026-11-30'),
            createdByUserId: userId,
          },
          {
            id: 'rev-dec',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 6,
            effectiveFrom: parseUtcDateOnly('2026-12-01'),
            effectiveTo: parseUtcDateOnly('2026-12-31'),
            createdByUserId: userId,
          },
          {
            id: 'rev-jan',
            companyId,
            employeeId,
            shiftId: nightShift.id,
            dailyWorkingHours: 7,
            monthlyLeaveAllowance: 4,
            effectiveFrom: parseUtcDateOnly('2027-01-01'),
            effectiveTo: null,
            createdByUserId: userId,
          },
        ],
      });

      const result = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: {
          id: employeeId,
          dateOfJoining: parseUtcDateOnly('2026-01-01'),
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
        },
        nextMonthlyLeaveAllowance: 5,
        allowAllowanceReversionToCurrent: true,
        submittedAt: new Date('2026-11-18T10:00:00.000Z'),
        revisionReason: 'Revert scheduled December increase back to 5',
        createdByUserId: userId,
      });

      expect(result.applied).toBe(true);
      expect(result.workPolicyEffectiveFrom).toBeNull();
      expect(result.allowanceEffectiveFrom).toBe('2026-12-01');
      expect(result.todayEffectiveSnapshot.monthlyLeaveAllowance).toBe(5);
      expect(
        rows.map((r) => ({
          from: formatUtcDateOnly(r.effectiveFrom),
          to: r.effectiveTo ? formatUtcDateOnly(r.effectiveTo) : null,
          shiftId: r.shiftId,
          hours: Number(r.dailyWorkingHours),
          allow: Number(r.monthlyLeaveAllowance),
        }))
      ).toEqual([
        { from: '2026-01-01', to: '2026-09-30', shiftId: dayShift.id, hours: 8, allow: 4 },
        { from: '2026-10-01', to: '2026-11-30', shiftId: dayShift.id, hours: 8, allow: 5 },
        { from: '2026-12-01', to: '2026-12-31', shiftId: dayShift.id, hours: 8, allow: 5 },
        { from: '2027-01-01', to: null, shiftId: nightShift.id, hours: 7, allow: 4 },
      ]);

      for (let i = 0; i < rows.length - 1; i++) {
        expect(formatUtcDateOnly(rows[i].effectiveTo!)).toBe(
          formatUtcDateOnly(new Date(rows[i + 1].effectiveFrom.getTime() - 86400000))
        );
      }
      expect(rows[rows.length - 1].effectiveTo).toBeNull();
    });

    it('Decision 2 (P2-3): respects company-local month boundary during explicit allowance reversion and blocks reversion when allowAllowanceReversionToCurrent is false', async () => {
      // 2026-11-30T20:00:00Z is 2026-12-01 01:30 Asia/Kolkata -> current local month is Dec 2026, next month is 2027-01-01
      const { tx, rows } = createInMemoryTx({
        timezone: 'Asia/Kolkata',
        initialRevisions: [
          {
            id: 'rev-curr-dec',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 5,
            effectiveFrom: parseUtcDateOnly('2026-01-01'),
            effectiveTo: parseUtcDateOnly('2026-12-31'),
            createdByUserId: userId,
          },
          {
            id: 'rev-next-jan',
            companyId,
            employeeId,
            shiftId: dayShift.id,
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: 6,
            effectiveFrom: parseUtcDateOnly('2027-01-01'),
            effectiveTo: null,
            createdByUserId: userId,
          },
        ],
      });

      // Mixed profile/policy echo (`allowAllowanceReversionToCurrent: false`) must NOT revert Jan 2027 from 6 to 5
      const blockedEcho = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: {
          id: employeeId,
          dateOfJoining: parseUtcDateOnly('2026-01-01'),
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
        },
        nextMonthlyLeaveAllowance: 5,
        allowAllowanceReversionToCurrent: false,
        submittedAt: new Date('2026-11-30T20:00:00.000Z'),
        createdByUserId: userId,
      });

      expect(blockedEcho.applied).toBe(false);
      expect(blockedEcho.allowanceEffectiveFrom).toBeNull();
      expect(Number(rows[1].monthlyLeaveAllowance)).toBe(6);

      // Allowance-only / explicit revision reverts 2027-01-01 from 6 back to 5
      const reverted = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId,
        employee: {
          id: employeeId,
          dateOfJoining: parseUtcDateOnly('2026-01-01'),
          shiftId: dayShift.id,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
        },
        nextMonthlyLeaveAllowance: 5,
        allowAllowanceReversionToCurrent: true,
        submittedAt: new Date('2026-11-30T20:00:00.000Z'),
        createdByUserId: userId,
      });

      expect(reverted.applied).toBe(true);
      expect(reverted.allowanceEffectiveFrom).toBe('2027-01-01');
      expect(formatUtcDateOnly(rows[0].effectiveTo!)).toBe('2026-12-31');
      expect(Number(rows[0].monthlyLeaveAllowance)).toBe(5);
      expect(formatUtcDateOnly(rows[1].effectiveFrom)).toBe('2027-01-01');
      expect(Number(rows[1].monthlyLeaveAllowance)).toBe(5);
    });
  });
});


