import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AttendanceService } from '../../src/server/services/attendance.service.js';
import { prisma } from '../../src/server/db/client.js';
import { AuthUser } from '../../src/shared/types.ts';

vi.mock('../../src/server/db/client.js', () => {
  return {
    prisma: {
      company: {
        findUnique: vi.fn(),
      },
      employee: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      shift: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      attendance: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
    },
  };
});

describe('Stage 1.4: Working Hours Logout Summary & Admin Notifications Tests', () => {
  const companyId = 'company-test-101';

  const employeeActor: AuthUser = {
    id: 'user-emp-1',
    userId: 'user-emp-1',
    companyId,
    email: 'alice@company.com',
    fullName: 'Alice Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const adminActor: AuthUser = {
    id: 'user-admin-1',
    userId: 'user-admin-1',
    companyId,
    email: 'admin@company.com',
    fullName: 'Bob Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const superAdminActor: AuthUser = {
    id: 'user-super-1',
    userId: 'user-super-1',
    companyId,
    email: 'super@company.com',
    fullName: 'Charlie Super',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const sampleShift = {
    id: 'shift-std-8',
    companyId,
    name: 'Standard Morning Shift',
    startTime: '09:00',
    endTime: '17:00',
    isOvernight: false,
    isActive: true,
  };

  const sampleOvernightShift = {
    id: 'shift-night-8',
    companyId,
    name: 'Night Shift',
    startTime: '22:00',
    endTime: '06:00',
    isOvernight: true,
    isActive: true,
  };

  const sampleEmployee = {
    id: 'emp-alice-1',
    companyId,
    userId: employeeActor.id,
    employeeCode: 'EMP-001',
    fullName: 'Alice Employee',
    email: 'alice@company.com',
    shiftId: sampleShift.id,
    shift: sampleShift,
    status: 'ACTIVE',
    company: {
      id: companyId,
      timezone: 'America/New_York',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(prisma.company.findUnique).mockResolvedValue({
      id: companyId,
      name: 'Acme Test Corp',
      code: 'ACME',
      currency: 'USD',
      timezone: 'America/New_York',
    } as any);

    vi.mocked(prisma.employee.findFirst).mockResolvedValue({
      id: sampleEmployee.id,
    } as any);

    vi.mocked(prisma.employee.findUnique).mockResolvedValue(sampleEmployee as any);
  });

  describe('Part 1: Working Hours Summary on Application Logout', () => {
    it('1. Returns HOURS_COMPLETED when employee finished required shift duration', async () => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      vi.mocked(prisma.attendance.findFirst).mockResolvedValue({
        id: 'att-1',
        employeeId: sampleEmployee.id,
        companyId,
        workDate: new Date(`${today}T00:00:00.000Z`),
        checkIn: new Date(`${today}T09:00:00.000Z`),
        checkOut: new Date(`${today}T17:00:00.000Z`),
        shift: sampleShift,
        updatedAt: new Date(),
      } as any);

      const summary = await AttendanceService.getWorkingHoursSummary(employeeActor);

      expect(summary.status).toBe('HOURS_COMPLETED');
      expect(summary.expectedDurationHours).toBe(8);
      expect(summary.workedDurationHours).toBe(8);
      expect(summary.shortDurationMinutes).toBe(0);
      expect(summary.overtimeDurationMinutes).toBe(0);
      expect(summary.requiresAttendanceAction).toBe(false);
      expect(summary.statusMessage).toContain('Shift Complete');
      expect(summary.statusMessage).toContain('8h working hours for today');

      // Crucial: ensure no attendance records were mutated
      expect(prisma.attendance.create).not.toHaveBeenCalled();
      expect(prisma.attendance.update).not.toHaveBeenCalled();
    });

    it('2. Returns SHORT_HOURS when employee clocked out early with duration shortfall', async () => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      vi.mocked(prisma.attendance.findFirst).mockResolvedValue({
        id: 'att-2',
        employeeId: sampleEmployee.id,
        companyId,
        workDate: new Date(`${today}T00:00:00.000Z`),
        checkIn: new Date(`${today}T09:00:00.000Z`),
        checkOut: new Date(`${today}T15:00:00.000Z`),
        shift: sampleShift,
        updatedAt: new Date(),
      } as any);

      const summary = await AttendanceService.getWorkingHoursSummary(employeeActor);

      expect(summary.status).toBe('SHORT_HOURS');
      expect(summary.expectedDurationHours).toBe(8);
      expect(summary.workedDurationHours).toBe(6);
      expect(summary.shortDurationMinutes).toBe(120);
      expect(summary.overtimeDurationMinutes).toBe(0);
      expect(summary.requiresAttendanceAction).toBe(false);
      expect(summary.statusMessage).toContain('Short Hours');
      expect(summary.statusMessage).toContain('short by 2h 0m of your scheduled 8h shift');
    });

    it('3. Returns OVERTIME when employee worked more than the scheduled shift duration', async () => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      vi.mocked(prisma.attendance.findFirst).mockResolvedValue({
        id: 'att-3',
        employeeId: sampleEmployee.id,
        companyId,
        workDate: new Date(`${today}T00:00:00.000Z`),
        checkIn: new Date(`${today}T08:30:00.000Z`),
        checkOut: new Date(`${today}T18:00:00.000Z`),
        shift: sampleShift,
        updatedAt: new Date(),
      } as any);

      const summary = await AttendanceService.getWorkingHoursSummary(employeeActor);

      expect(summary.status).toBe('OVERTIME');
      expect(summary.expectedDurationHours).toBe(8);
      expect(summary.workedDurationHours).toBe(9.5);
      expect(summary.shortDurationMinutes).toBe(0);
      expect(summary.overtimeDurationMinutes).toBe(90);
      expect(summary.requiresAttendanceAction).toBe(false);
      expect(summary.statusMessage).toContain('Overtime Recorded');
      expect(summary.statusMessage).toContain('9.5h of work');
      expect(summary.statusMessage).toContain('1h 30m of overtime');
    });

    it('4. Returns INCOMPLETE_ATTENDANCE when check-in exists without a check-out punch', async () => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      vi.mocked(prisma.attendance.findFirst).mockResolvedValue({
        id: 'att-4',
        employeeId: sampleEmployee.id,
        companyId,
        workDate: new Date(`${today}T00:00:00.000Z`),
        checkIn: new Date(`${today}T09:00:00.000Z`),
        checkOut: null,
        shift: sampleShift,
        updatedAt: new Date(),
      } as any);

      const summary = await AttendanceService.getWorkingHoursSummary(employeeActor);

      expect(summary.status).toBe('INCOMPLETE_ATTENDANCE');
      expect(summary.checkIn).not.toBeNull();
      expect(summary.checkOut).toBeNull();
      expect(summary.workedDurationHours).toBeNull();
      expect(summary.requiresAttendanceAction).toBe(true);
      expect(summary.statusMessage).toContain('Attendance Incomplete');
      expect(summary.statusMessage).toContain('Logging out of CoreERP will NOT record your check-out');

      // Crucial: app logout must NEVER auto-create or auto-complete attendance
      expect(prisma.attendance.update).not.toHaveBeenCalled();
    });

    it('5. Returns MISSING_CHECK_IN when no attendance punch was recorded for today', async () => {
      vi.mocked(prisma.attendance.findFirst).mockResolvedValue(null);

      const summary = await AttendanceService.getWorkingHoursSummary(employeeActor);

      expect(summary.status).toBe('MISSING_CHECK_IN');
      expect(summary.checkIn).toBeNull();
      expect(summary.checkOut).toBeNull();
      expect(summary.workedDurationHours).toBeNull();
      expect(summary.requiresAttendanceAction).toBe(true);
      expect(summary.statusMessage).toContain('No attendance check-in has been logged');
      expect(summary.statusMessage).toContain('Logging out of CoreERP will NOT record attendance');
    });

    it('6. Returns NO_SHIFT_ASSIGNED when employee has no configured shift', async () => {
      const unassignedEmployee = {
        ...sampleEmployee,
        shiftId: null,
        shift: null,
      };
      vi.mocked(prisma.employee.findUnique).mockResolvedValue(unassignedEmployee as any);
      vi.mocked(prisma.attendance.findFirst).mockResolvedValue(null);

      const summary = await AttendanceService.getWorkingHoursSummary(employeeActor);

      expect(summary.status).toBe('NO_SHIFT_ASSIGNED');
      expect(summary.expectedDurationHours).toBeNull();
      expect(summary.statusMessage).toContain('No working shift is assigned to your employee account');
      expect(summary.statusMessage).toContain('Logging out of CoreERP will NOT record attendance');
    });

    it('7. Accurately evaluates overnight shifts (22:00 to 06:00)', async () => {
      const overnightEmployee = {
        ...sampleEmployee,
        shiftId: sampleOvernightShift.id,
        shift: sampleOvernightShift,
      };
      vi.mocked(prisma.employee.findUnique).mockResolvedValue(overnightEmployee as any);

      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      vi.mocked(prisma.attendance.findFirst).mockResolvedValue({
        id: 'att-night',
        employeeId: sampleEmployee.id,
        companyId,
        workDate: new Date(`${today}T00:00:00.000Z`),
        checkIn: new Date(`${today}T22:00:00.000Z`),
        checkOut: new Date(new Date(`${today}T22:00:00.000Z`).getTime() + 8 * 3600 * 1000),
        shift: sampleOvernightShift,
        updatedAt: new Date(),
      } as any);

      const summary = await AttendanceService.getWorkingHoursSummary(employeeActor);

      expect(summary.expectedDurationHours).toBe(8);
      expect(summary.workedDurationHours).toBe(8);
      expect(summary.status).toBe('HOURS_COMPLETED');
    });

    it('8. Uses Company.timezone to determine workday date', async () => {
      const tokyoEmployee = {
        ...sampleEmployee,
        company: {
          id: companyId,
          timezone: 'Asia/Tokyo',
        },
      };
      vi.mocked(prisma.employee.findUnique).mockResolvedValue(tokyoEmployee as any);
      vi.mocked(prisma.attendance.findFirst).mockResolvedValue(null);

      const summary = await AttendanceService.getWorkingHoursSummary(employeeActor);

      const expectedTokyoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
      expect(summary.timezone).toBe('Asia/Tokyo');
      expect(summary.workDate).toBe(expectedTokyoDate);
    });
  });

  describe('Part 2: Admin Shift & Attendance Notifications', () => {
    it('1. Enforces strict RBAC: rejects EMPLOYEE role with 403 Forbidden', async () => {
      await expect(AttendanceService.getAdminNotifications(employeeActor)).rejects.toThrow(
        /Access denied: Admin notifications are restricted to administrators/
      );
    });

    it('2. Allows ADMIN and SUPER_ADMIN roles to query notifications', async () => {
      vi.mocked(prisma.employee.findMany).mockResolvedValue([]);
      vi.mocked(prisma.attendance.findMany).mockResolvedValue([]);

      const adminRes = await AttendanceService.getAdminNotifications(adminActor);
      expect(adminRes.total).toBe(0);
      expect(Array.isArray(adminRes.items)).toBe(true);

      const superAdminRes = await AttendanceService.getAdminNotifications(superAdminActor);
      expect(superAdminRes.total).toBe(0);
      expect(Array.isArray(superAdminRes.items)).toBe(true);
    });

    it('3. Generates NO_SHIFT_ASSIGNED alert for active employees without an assigned shift', async () => {
      const unassignedEmployee = {
        id: 'emp-unassigned',
        companyId,
        fullName: 'Diana Prince',
        employeeCode: 'EMP-007',
        shiftId: null,
        shift: null,
        status: 'ACTIVE',
      };

      vi.mocked(prisma.employee.findMany).mockResolvedValue([unassignedEmployee as any]);
      vi.mocked(prisma.attendance.findMany).mockResolvedValue([]);

      const res = await AttendanceService.getAdminNotifications(adminActor);

      expect(res.total).toBe(1);
      const alert = res.items[0];
      expect(alert.type).toBe('NO_SHIFT_ASSIGNED');
      expect(alert.severity).toBe('WARN');
      expect(alert.employeeId).toBe('emp-unassigned');
      expect(alert.message).toContain('has no assigned shift');
      expect(alert.actionUrl).toBe('/employees');
    });

    it('4. Generates INCOMPLETE_PUNCH alert for missing check-out records', async () => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const employee = {
        id: 'emp-missing-out',
        companyId,
        fullName: 'Evan Wright',
        employeeCode: 'EMP-012',
        shiftId: sampleShift.id,
        shift: sampleShift,
        status: 'ACTIVE',
      };

      vi.mocked(prisma.employee.findMany).mockResolvedValue([employee as any]);
      vi.mocked(prisma.attendance.findMany).mockResolvedValue([
        {
          id: 'att-inc-1',
          companyId,
          employeeId: employee.id,
          employee,
          workDate: new Date(`${today}T00:00:00.000Z`),
          checkIn: new Date(`${today}T09:00:00.000Z`),
          checkOut: null,
          shift: sampleShift,
          updatedAt: new Date(),
        } as any,
      ]);

      const res = await AttendanceService.getAdminNotifications(adminActor);

      const alert = res.items.find((item) => item.type === 'INCOMPLETE_PUNCH');
      expect(alert).toBeDefined();
      expect(alert?.severity).toBe('WARN');
      expect(alert?.message).toContain('has no check-out punch');
      expect(alert?.actionUrl).toBe('/attendance');
    });

    it('5. Generates SHORT_HOURS alert when employee completes significantly short hours', async () => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const employee = {
        id: 'emp-short',
        companyId,
        fullName: 'Fiona Gallagher',
        employeeCode: 'EMP-015',
        shiftId: sampleShift.id,
        shift: sampleShift,
        status: 'ACTIVE',
      };

      vi.mocked(prisma.employee.findMany).mockResolvedValue([employee as any]);
      // 8 hour shift, worked 5.5 hours (2.5 hours short)
      vi.mocked(prisma.attendance.findMany).mockResolvedValue([
        {
          id: 'att-short-1',
          companyId,
          employeeId: employee.id,
          employee,
          workDate: new Date(`${today}T00:00:00.000Z`),
          checkIn: new Date(`${today}T09:00:00.000Z`),
          checkOut: new Date(`${today}T14:30:00.000Z`),
          shift: sampleShift,
          updatedAt: new Date(),
        } as any,
      ]);

      const res = await AttendanceService.getAdminNotifications(adminActor);

      const alert = res.items.find((item) => item.type === 'SHORT_HOURS');
      expect(alert).toBeDefined();
      expect(alert?.severity).toBe('WARN');
      expect(alert?.message).toContain('was short by 2h 30m of scheduled shift');
    });

    it('6. Strictly prevents duplicate notifications for the same employee, type, and workday', async () => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const employee = {
        id: 'emp-dup',
        companyId,
        fullName: 'George Clark',
        employeeCode: 'EMP-020',
        shiftId: sampleShift.id,
        shift: sampleShift,
        status: 'ACTIVE',
      };

      vi.mocked(prisma.employee.findMany).mockResolvedValue([employee as any]);
      // Two identical check-ins with missing punches on the same workday
      vi.mocked(prisma.attendance.findMany).mockResolvedValue([
        {
          id: 'att-dup-1',
          companyId,
          employeeId: employee.id,
          employee,
          workDate: new Date(`${today}T00:00:00.000Z`),
          checkIn: new Date(`${today}T09:00:00.000Z`),
          checkOut: null,
          shift: sampleShift,
          updatedAt: new Date(),
        } as any,
        {
          id: 'att-dup-2',
          companyId,
          employeeId: employee.id,
          employee,
          workDate: new Date(`${today}T00:00:00.000Z`),
          checkIn: new Date(`${today}T09:05:00.000Z`),
          checkOut: null,
          shift: sampleShift,
          updatedAt: new Date(),
        } as any,
      ]);

      const res = await AttendanceService.getAdminNotifications(adminActor);

      const incompleteAlerts = res.items.filter(
        (item) => item.type === 'INCOMPLETE_PUNCH' && item.employeeId === employee.id
      );
      // Deduplication must reduce duplicates to exactly 1 alert
      expect(incompleteAlerts.length).toBe(1);
      expect(incompleteAlerts[0].id).toBe(`${employee.id}_INCOMPLETE_PUNCH_${today}`);
    });

    it('7. Enforces multi-tenant isolation: only returns records matching actor.companyId', async () => {
      // Return employee for companyId
      (prisma.employee.findMany as any).mockImplementation(async (query: any) => {
        expect(query.where.companyId).toBe(companyId);
        return [];
      });

      // Verify attendance query restricts by companyId
      (prisma.attendance.findMany as any).mockImplementation(async (query: any) => {
        expect(query.where.companyId).toBe(companyId);
        return [];
      });

      await AttendanceService.getAdminNotifications(adminActor);
    });
  });
});
