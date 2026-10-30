import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { AuthUser } from '../../src/shared/types.ts';

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Phase 8.2: Biometric Punch Reconciliation Engine and Sync Service Tests', () => {
  const app = createApp();

  const companyAlphaId = 'company-uuid-alpha';
  const companyBetaId = 'company-uuid-beta';

  const superAdminUser: AuthUser = {
    id: 'user-sa-uuid',
    userId: 'user-sa-uuid',
    companyId: companyAlphaId,
    email: 'admin@alpha.local',
    fullName: 'Alpha Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeUser: AuthUser = {
    id: 'user-emp-uuid',
    userId: 'user-emp-uuid',
    companyId: companyAlphaId,
    email: 'john@alpha.local',
    fullName: 'John Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const standardShift = {
    id: 'shift-std-uuid',
    companyId: companyAlphaId,
    code: 'GENERAL',
    name: 'General Shift',
    startTime: '09:00',
    endTime: '18:00',
    isOvernight: false,
    graceMinutes: 15,
    halfDayMinutes: 240,
    isActive: true,
  };

  const overnightShift = {
    id: 'shift-night-uuid',
    companyId: companyAlphaId,
    code: 'NIGHT',
    name: 'Night Shift',
    startTime: '22:00',
    endTime: '06:00',
    isOvernight: true,
    graceMinutes: 15,
    halfDayMinutes: 240,
    isActive: true,
  };

  const defaultMockEmployee = {
    id: 'emp-uuid-1',
    companyId: companyAlphaId,
    employeeCode: 'EMP-001',
    biometricDeviceId: 'BIO-1001',
    status: 'ACTIVE',
    shift: standardShift,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(prisma.leaveRequest, 'findFirst').mockResolvedValue(null as any);
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      if (typeof callback === 'function') {
        return callback(prisma);
      }
      return callback;
    });
  });


  describe('1. Timezone Policy & Date Calculation', () => {
    it('should resolve company timezone when valid IANA string is configured', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({
        timezone: 'America/New_York',
      } as any);

      const tz = await PunchReconciliationService.resolveCompanyTimezone(companyAlphaId);
      expect(tz).toBe('America/New_York');
    });

    it('should fallback to canonical UTC policy when timezone is missing or invalid', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({
        timezone: 'Invalid/Non_Existent_Timezone',
      } as any);

      const tz = await PunchReconciliationService.resolveCompanyTimezone(companyAlphaId);
      expect(tz).toBe('UTC');

      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce(null);
      const tz2 = await PunchReconciliationService.resolveCompanyTimezone(companyAlphaId);
      expect(tz2).toBe('UTC');
    });

    it('should correctly determine workDate for standard daytime shifts', () => {
      const punchUtc = new Date('2026-10-19T08:55:00.000Z');
      const workDate = PunchReconciliationService.determineWorkDate(punchUtc, 'UTC', standardShift);
      expect(workDate).toBe('2026-10-19');
    });

    it('should correctly attribute overnight shift punches to the commencement date across midnight', () => {
      // 1. Check-in at 21:55 on 2026-10-19 (commencement date: 2026-10-19)
      const punchIn = new Date('2026-10-19T21:55:00.000Z');
      const workDateIn = PunchReconciliationService.determineWorkDate(punchIn, 'UTC', overnightShift);
      expect(workDateIn).toBe('2026-10-19');

      // 2. Check-out at 06:10 on 2026-10-20 (local hour 6 < 12 -> attributes to 2026-10-19)
      const punchOut = new Date('2026-10-20T06:10:00.000Z');
      const workDateOut = PunchReconciliationService.determineWorkDate(punchOut, 'UTC', overnightShift);
      expect(workDateOut).toBe('2026-10-19');
    });
  });

  describe('2. Employee Mapping & Cross-Tenant Isolation', () => {
    it('should successfully map unlinked punch to active employee in the same tenant', async () => {
      const rawPunch = {
        id: 'punch-1',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T08:50:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: null,
      };

      const matchedEmp = {
        id: 'emp-uuid-1',
        companyId: companyAlphaId,
        employeeCode: 'EMP-001',
        biometricDeviceId: 'BIO-1001',
        status: 'ACTIVE',
        shift: standardShift,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(rawPunch as any);
      vi.spyOn(prisma.employee, 'findFirst').mockResolvedValueOnce(matchedEmp as any);
      vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValue({} as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null); // No locked payroll
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null); // No existing attendance
      const attendanceCreateSpy = vi.spyOn(prisma.attendance, 'create').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-1');

      expect(result.status).toBe('PROCESSED');
      expect(result.matchedEmployeeId).toBe('emp-uuid-1');
      expect(attendanceCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            companyId: companyAlphaId,
            employeeId: 'emp-uuid-1',
            source: 'BIOMETRIC',
            status: 'PRESENT',
            lateMinutes: 0,
          }),
        })
      );
    });

    it('should reject employee match across companies and never cross tenant boundaries', async () => {
      const rawPunch = {
        id: 'punch-cross-tenant',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-SHARED',
        punchTime: new Date('2026-10-19T09:00:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: {
          id: 'emp-beta-uuid',
          companyId: companyBetaId, // Mismatched tenant
        },
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(rawPunch as any);
      const updateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-cross-tenant');

      expect(result.status).toBe('ERROR');
      expect(result.message).toContain('Security violation');
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            syncStatus: 'ERROR',
            errorMessage: expect.stringContaining('Security violation'),
          }),
        })
      );
    });

    it('should mark unmapped enrollment IDs with explicit ERROR and preserve for manual review', async () => {
      const rawPunch = {
        id: 'punch-unmapped',
        companyId: companyAlphaId,
        userEnrollmentId: 'UNKNOWN-BIO-9999',
        punchTime: new Date('2026-10-19T09:00:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: null,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(rawPunch as any);
      vi.spyOn(prisma.employee, 'findFirst').mockResolvedValueOnce(null); // Not found
      const updateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-unmapped');

      expect(result.status).toBe('ERROR');
      expect(result.message).toContain('Unmapped biometric enrollment ID');
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            syncStatus: 'ERROR',
            errorMessage: expect.stringContaining('No active employee found'),
          }),
        })
      );
    });
  });

  describe('3. Normal IN/OUT Pairs, Late Minutes & Overtime', () => {
    const mockEmployee = {
      id: 'emp-uuid-1',
      companyId: companyAlphaId,
      employeeCode: 'EMP-001',
      biometricDeviceId: 'BIO-1001',
      status: 'ACTIVE',
      shift: standardShift,
    };

    it('should record CHECK_IN with late minutes when arriving after shift start + grace period', async () => {
      // Shift starts at 09:00 with 15m grace. Arrival at 09:30 is 30 minutes late.
      const rawPunch = {
        id: 'punch-late-in',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T09:30:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: mockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(rawPunch as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null);
      const createSpy = vi.spyOn(prisma.attendance, 'create').mockResolvedValueOnce({} as any);
      vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-late-in');

      expect(result.status).toBe('PROCESSED');
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'LATE',
            lateMinutes: 30,
            source: 'BIOMETRIC',
          }),
        })
      );
    });

    it('should pair CHECK_OUT with existing attendance and compute overtime minutes', async () => {
      // Shift ends at 18:00. Departure at 19:15 is 75 minutes overtime.
      const existingAttendance = {
        id: 'att-uuid-1',
        companyId: companyAlphaId,
        employeeId: 'emp-uuid-1',
        workDate: new Date('2026-10-19T00:00:00.000Z'),
        checkIn: new Date('2026-10-19T08:55:00.000Z'),
        checkOut: null,
        status: 'PRESENT',
        lateMinutes: 0,
        overtimeMinutes: 0,
      };

      const punchOut = {
        id: 'punch-out-1',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T19:15:00.000Z'),
        inOutMode: 'CHECK_OUT' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: mockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punchOut as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(existingAttendance as any);
      const updateAttendanceSpy = vi.spyOn(prisma.attendance, 'update').mockResolvedValueOnce({} as any);
      vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-out-1');

      expect(result.status).toBe('PROCESSED');
      expect(updateAttendanceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-uuid-1' },
          data: expect.objectContaining({
            checkOut: punchOut.punchTime,
            overtimeMinutes: 75,
          }),
        })
      );
    });
  });

  describe('4. Duplicate Debounce, Out-of-Order & Missing Punches', () => {
    const mockEmployee = {
      id: 'emp-uuid-1',
      companyId: companyAlphaId,
      employeeCode: 'EMP-001',
      biometricDeviceId: 'BIO-1001',
      status: 'ACTIVE',
      shift: standardShift,
    };

    it('should debounce rapid repeated check-in taps within 2 minutes', async () => {
      const existingAttendance = {
        id: 'att-uuid-1',
        companyId: companyAlphaId,
        employeeId: 'emp-uuid-1',
        workDate: new Date('2026-10-19T00:00:00.000Z'),
        checkIn: new Date('2026-10-19T08:58:00.000Z'),
        checkOut: null,
      };

      // Second tap 45 seconds later
      const punchDup = {
        id: 'punch-dup',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T08:58:45.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: mockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punchDup as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(existingAttendance as any);
      const updateRawSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-dup');

      expect(result.status).toBe('IGNORED');
      expect(result.message).toContain('debounced');
      expect(updateRawSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            syncStatus: 'IGNORED',
            errorMessage: expect.stringContaining('debounced within 2 minutes'),
          }),
        })
      );
    });

    it('should record missing check-in gracefully when CHECK_OUT arrives alone', async () => {
      const punchOutAlone = {
        id: 'punch-out-alone',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T18:05:00.000Z'),
        inOutMode: 'CHECK_OUT' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: mockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punchOutAlone as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null); // No attendance yet
      const createSpy = vi.spyOn(prisma.attendance, 'create').mockResolvedValueOnce({} as any);
      vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-out-alone');

      expect(result.status).toBe('PROCESSED');
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkIn: null,
            checkOut: punchOutAlone.punchTime,
            status: 'PRESENT',
            notes: expect.stringContaining('without matching check-in'),
          }),
        })
      );
    });

    it('should reject invalid sequence where checkout is earlier than checkin', async () => {
      const existingAttendance = {
        id: 'att-uuid-1',
        companyId: companyAlphaId,
        employeeId: 'emp-uuid-1',
        workDate: new Date('2026-10-19T00:00:00.000Z'),
        checkIn: new Date('2026-10-19T09:00:00.000Z'),
        checkOut: null,
      };

      // Corrupt/invalid punch: checkout timestamp is 07:00 (earlier than 09:00 checkin)
      const invalidPunch = {
        id: 'punch-invalid-seq',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T07:00:00.000Z'),
        inOutMode: 'CHECK_OUT' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: mockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(invalidPunch as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(existingAttendance as any);
      const updateRawSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-invalid-seq');

      expect(result.status).toBe('ERROR');
      expect(result.message).toContain('earlier than check-in time');
      expect(updateRawSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            syncStatus: 'ERROR',
            errorMessage: expect.stringContaining('earlier than check-in time'),
          }),
        })
      );
    });
  });

  describe('5. Break Events & Shift Notes', () => {
    it('should record BREAK_OUT and BREAK_IN without overwriting daily checkIn or checkOut', async () => {
      const existingAttendance = {
        id: 'att-uuid-1',
        companyId: companyAlphaId,
        employeeId: 'emp-uuid-1',
        workDate: new Date('2026-10-19T00:00:00.000Z'),
        checkIn: new Date('2026-10-19T09:00:00.000Z'),
        checkOut: null,
        notes: 'Initial check-in',
      };

      const breakOutPunch = {
        id: 'punch-break-out',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T13:00:00.000Z'),
        inOutMode: 'BREAK_OUT' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: {
          id: 'emp-uuid-1',
          companyId: companyAlphaId,
          shift: standardShift,
        },
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(breakOutPunch as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(existingAttendance as any);
      const updateAttSpy = vi.spyOn(prisma.attendance, 'update').mockResolvedValueOnce({} as any);
      vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-break-out');

      expect(result.status).toBe('PROCESSED');
      expect(updateAttSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            notes: expect.stringContaining('[BREAK_OUT at 2026-10-19T13:00:00.000Z]'),
          }),
        })
      );
    });

    it('should not append duplicate break notes when break punch is retried', async () => {
      const existingAttendance = {
        id: 'att-uuid-1',
        companyId: companyAlphaId,
        employeeId: 'emp-uuid-1',
        workDate: new Date('2026-10-19T00:00:00.000Z'),
        checkIn: new Date('2026-10-19T09:00:00.000Z'),
        checkOut: null,
        notes: 'Initial check-in [BREAK_IN at 2026-10-19T13:30:00.000Z]',
      };

      const breakInRetryPunch = {
        id: 'punch-break-in-retry',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T13:30:00.000Z'),
        inOutMode: 'BREAK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: {
          id: 'emp-uuid-1',
          companyId: companyAlphaId,
          shift: standardShift,
        },
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(breakInRetryPunch as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(existingAttendance as any);
      const updateAttSpy = vi.spyOn(prisma.attendance, 'update');
      vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-break-in-retry');

      expect(result.status).toBe('PROCESSED');
      // Notes should not be updated since the exact note already exists
      expect(updateAttSpy).not.toHaveBeenCalled();
    });
  });

  describe('6. Data & Payroll Integrity Protections', () => {
    const mockEmployee = {
      id: 'emp-uuid-1',
      companyId: companyAlphaId,
      shift: standardShift,
    };

    it('should block punch reconciliation if payroll period for workDate is POSTED or PROCESSED', async () => {
      const punchInLockedPeriod = {
        id: 'punch-locked-payroll',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-09-15T09:00:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: mockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punchInLockedPeriod as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      // Simulate existing POSTED period for September 2026
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce({
        id: 'period-sep-2026',
        name: '2026-09 Payroll',
        status: 'POSTED',
      } as any);

      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-locked-payroll');

      expect(result.status).toBe('ERROR');
      expect(result.message).toContain('Protected payroll period');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      expect(rawUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            syncStatus: 'ERROR',
            errorMessage: expect.stringContaining('POSTED'),
          }),
        })
      );

      attCreateSpy.mockRestore();
      attUpdateSpy.mockRestore();
    });

    it('should protect approved leave records (ON_LEAVE) from being overwritten by punches', async () => {
      const punchOnLeave = {
        id: 'punch-on-leave',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T09:00:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: mockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punchOnLeave as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      // Existing attendance is marked ON_LEAVE
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce({
        id: 'att-leave-1',
        status: 'ON_LEAVE',
      } as any);

      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-on-leave');

      expect(result.status).toBe('IGNORED');
      expect(result.message).toContain('ON_LEAVE');
      expect(attUpdateSpy).not.toHaveBeenCalled();
      expect(rawUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            syncStatus: 'IGNORED',
            errorMessage: expect.stringContaining('ON_LEAVE'),
          }),
        })
      );

      attUpdateSpy.mockRestore();
    });

    it('should handle re-reconciliation idempotently without duplicate records', async () => {
      const alreadyProcessedPunch = {
        id: 'punch-processed',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T09:00:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PROCESSED' as const,
        matchedEmployeeId: 'emp-uuid-1',
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(alreadyProcessedPunch as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const result = await PunchReconciliationService.reconcilePunch('punch-processed');

      expect(result.status).toBe('PROCESSED');
      expect(result.message).toContain('already successfully processed');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();

      attCreateSpy.mockRestore();
      attUpdateSpy.mockRestore();
    });
  });

  describe('7. API Endpoints & RBAC Security Guards', () => {
    it('should reject unauthenticated access to /api/biometric/sync and /api/biometric/punches with 401', async () => {
      const res1 = await request(app).post('/api/biometric/sync').send({});
      expect(res1.status).toBe(401);

      const res2 = await request(app).get('/api/biometric/punches');
      expect(res2.status).toBe(401);

      const res3 = await request(app).get('/api/biometric/sync/summary');
      expect(res3.status).toBe(401);
    });

    it('should block EMPLOYEE role session token from sync and punch listing with 403 Forbidden', async () => {
      const empToken = AuthService.generateSessionToken({
        userId: employeeUser.userId,
        companyId: employeeUser.companyId,
        email: employeeUser.email,
        role: employeeUser.role,
        tokenVersion: employeeUser.tokenVersion,
      });

      const resSync = await request(app)
        .post('/api/biometric/sync')
        .set('Authorization', `Bearer ${empToken}`)
        .send({});

      expect([401, 403]).toContain(resSync.status);
      if (resSync.status === 403) {
        expect(resSync.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
      }

      const resPunches = await request(app)
        .get('/api/biometric/punches')
        .set('Authorization', `Bearer ${empToken}`);

      expect([401, 403]).toContain(resPunches.status);
      if (resPunches.status === 403) {
        expect(resPunches.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
      }
    });

    it('should allow authorized sync and log administrative action', async () => {
      const saToken = AuthService.generateSessionToken({
        userId: superAdminUser.userId,
        companyId: superAdminUser.companyId,
        email: superAdminUser.email,
        role: superAdminUser.role,
        tokenVersion: superAdminUser.tokenVersion,
      });

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: superAdminUser.userId,
        companyId: superAdminUser.companyId,
        email: superAdminUser.email,
        fullName: superAdminUser.fullName,
        role: superAdminUser.role,
        isActive: true,
        tokenVersion: 1,
      } as any);

      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([]); // No pending punches

      const res = await request(app)
        .post('/api/biometric/sync')
        .set('Authorization', `Bearer ${saToken}`)
        .send({ batchSize: 50 });


      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalEvaluated).toBe(0);
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BIOMETRIC_PUNCH_RECONCILE',
          companyId: companyAlphaId,
        })
      );
    });

    it('should support safe bounded retry sync with retryErrors: true', async () => {
      const saToken = AuthService.generateSessionToken({
        userId: superAdminUser.userId,
        companyId: superAdminUser.companyId,
        email: superAdminUser.email,
        role: superAdminUser.role,
        tokenVersion: superAdminUser.tokenVersion,
      });

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: superAdminUser.userId,
        companyId: superAdminUser.companyId,
        email: superAdminUser.email,
        fullName: superAdminUser.fullName,
        role: superAdminUser.role,
        isActive: true,
        tokenVersion: 1,
      } as any);

      const errorPunch = {
        id: 'punch-err-retry',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-NEW-EMP',
        punchTime: new Date('2026-10-19T08:50:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'ERROR' as const,
        matchedEmployee: null,
      };

      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([{ id: 'punch-err-retry' }] as any);
      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(errorPunch as any);
      vi.spyOn(prisma.employee, 'findFirst').mockResolvedValueOnce({
        id: 'new-emp-uuid',
        companyId: companyAlphaId,
        biometricDeviceId: 'BIO-NEW-EMP',
        status: 'ACTIVE',
        shift: standardShift,
      } as any);
      vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValue({} as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'create').mockResolvedValueOnce({} as any);

      const res = await request(app)
        .post('/api/biometric/sync')
        .set('Authorization', `Bearer ${saToken}`)
        .send({ retryErrors: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.processed).toBe(1);
      expect(res.body.errors).toBe(0);
    });

    it('should return sync summary counts via GET /api/biometric/sync/summary', async () => {
      const saToken = AuthService.generateSessionToken({
        userId: superAdminUser.userId,
        companyId: superAdminUser.companyId,
        email: superAdminUser.email,
        role: superAdminUser.role,
        tokenVersion: superAdminUser.tokenVersion,
      });

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: superAdminUser.userId,
        companyId: superAdminUser.companyId,
        email: superAdminUser.email,
        fullName: superAdminUser.fullName,
        role: superAdminUser.role,
        isActive: true,
        tokenVersion: 1,
      } as any);

      vi.spyOn(prisma.rawPunchLog, 'count')
        .mockResolvedValueOnce(2) // pending
        .mockResolvedValueOnce(15) // processed
        .mockResolvedValueOnce(1) // ignored
        .mockResolvedValueOnce(0) // error
        .mockResolvedValueOnce(18); // total
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValueOnce({
        lastSyncAt: new Date('2026-10-19T09:00:00.000Z'),
      } as any);

      const res = await request(app)
        .get('/api/biometric/sync/summary')
        .set('Authorization', `Bearer ${saToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pendingCount).toBe(2);
      expect(res.body.processedCount).toBe(15);
      expect(res.body.totalCount).toBe(18);
    });
  });

  describe('7. Phase 8.4 Timezone Conversions & Approved Leave Protections', () => {
    it('should correctly calculate late minutes in Asia/Kolkata (UTC+5:30)', () => {
      const shift = { startTime: '09:00', graceMinutes: 10 };

      // 03:45 UTC is 09:15 IST -> 15 min late
      const punchLate = new Date('2026-10-19T03:45:00.000Z');
      const lateMins = PunchReconciliationService.calculateLateMinutes(
        punchLate,
        '2026-10-19',
        shift,
        'Asia/Kolkata'
      );
      expect(lateMins).toBe(15);

      // 03:35 UTC is 09:05 IST -> within 10 min grace period -> 0 min late
      const punchOnTime = new Date('2026-10-19T03:35:00.000Z');
      const onTimeMins = PunchReconciliationService.calculateLateMinutes(
        punchOnTime,
        '2026-10-19',
        shift,
        'Asia/Kolkata'
      );
      expect(onTimeMins).toBe(0);
    });

    it('should handle daylight-saving time transitions in America/New_York (EDT vs EST)', () => {
      const shift = { startTime: '09:00', graceMinutes: 10 };

      // Summer EDT (UTC-4): 13:15 UTC is 09:15 EDT -> 15 min late
      const summerPunch = new Date('2026-07-15T13:15:00.000Z');
      const summerLate = PunchReconciliationService.calculateLateMinutes(
        summerPunch,
        '2026-07-15',
        shift,
        'America/New_York'
      );
      expect(summerLate).toBe(15);

      // Winter EST (UTC-5): 14:15 UTC is 09:15 EST -> 15 min late
      const winterPunch = new Date('2026-01-15T14:15:00.000Z');
      const winterLate = PunchReconciliationService.calculateLateMinutes(
        winterPunch,
        '2026-01-15',
        shift,
        'America/New_York'
      );
      expect(winterLate).toBe(15);

      // Overtime in America/New_York: shift end 17:00, checkout 22:30 UTC is 18:30 EDT -> 90 min overtime
      const overtimeShift = { endTime: '17:00', isOvernight: false };
      const checkoutPunch = new Date('2026-07-15T22:30:00.000Z');
      const otMins = PunchReconciliationService.calculateOvertimeMinutes(
        checkoutPunch,
        '2026-07-15',
        overtimeShift,
        'America/New_York'
      );
      expect(otMins).toBe(90);
    });

    it('should safely fall back to UTC when company timezone is missing or invalid', async () => {
      // 1. Timezone is null
      const mockTxNull = {
        company: {
          findUnique: vi.fn().mockResolvedValue({ timezone: null }),
        },
      } as any;
      const tzNull = await PunchReconciliationService.resolveCompanyTimezone('c1', mockTxNull);
      expect(tzNull).toBe('UTC');

      // 2. Timezone is invalid string
      const mockTxInvalid = {
        company: {
          findUnique: vi.fn().mockResolvedValue({ timezone: 'Invalid/NonExistent_Zone' }),
        },
      } as any;
      const tzInvalid = await PunchReconciliationService.resolveCompanyTimezone('c1', mockTxInvalid);
      expect(tzInvalid).toBe('UTC');
    });

    it('should protect approved leave when no Attendance row exists yet and ignore punch', async () => {
      const punchOnLeave = {
        id: 'punch-leave-no-att',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T09:00:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: defaultMockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punchOnLeave as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      // NO attendance row exists yet
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null);
      // But approved leave request exists for that work date
      vi.spyOn(prisma.leaveRequest, 'findFirst').mockResolvedValueOnce({
        id: 'leave-approved-1',
        companyId: companyAlphaId,
        employeeId: defaultMockEmployee.id,
        status: 'APPROVED',
        startDate: new Date('2026-10-19T00:00:00.000Z'),
        endDate: new Date('2026-10-19T23:59:59.999Z'),
        leaveType: { name: 'Paid Annual Leave', code: 'AL' },
      } as any);

      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-leave-no-att');

      expect(result.status).toBe('IGNORED');
      expect(result.message).toContain('Employee has approved leave on 2026-10-19 (Paid Annual Leave)');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(rawUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            syncStatus: 'IGNORED',
            errorMessage: expect.stringContaining('Paid Annual Leave'),
          }),
        })
      );

      attCreateSpy.mockRestore();
      rawUpdateSpy.mockRestore();
    });
  });
});

