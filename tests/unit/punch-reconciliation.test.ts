import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import {
  PunchReconciliationService,
  deriveAttendanceAdvisoryLockKeys,
} from '../../src/server/services/punch-reconciliation.service.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { BiometricMappingService } from '../../src/server/services/biometric-mapping.service.js';
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
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T20:00:00.000Z'));
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null as any);
    vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([defaultMockEmployee] as any);
    vi.spyOn(prisma.leaveRequest, 'findFirst').mockResolvedValue(null as any);
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      if (typeof callback === 'function') {
        return callback(prisma);
      }
      return callback;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });


  describe('1. Timezone Policy & Date Calculation', () => {
    it('should resolve company timezone when valid IANA string is configured', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({
        timezone: 'America/New_York',
      } as any);

      const tz = await PunchReconciliationService.resolveCompanyTimezone(companyAlphaId);
      expect(tz).toBe('America/New_York');
    });

    it('should fail closed when company timezone is missing or invalid (P0-B, never falls back to UTC)', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({
        timezone: 'Invalid/Non_Existent_Timezone',
      } as any);

      await expect(
        PunchReconciliationService.resolveCompanyTimezone(companyAlphaId)
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_INVALID' });

      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce(null);
      await expect(
        PunchReconciliationService.resolveCompanyTimezone(companyAlphaId)
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_MISSING' });
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
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([matchedEmp] as any);
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
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([] as any); // Not found
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

    it('should treat the first punch of the day as CHECK_IN chronologically even if raw device mode is CHECK_OUT', async () => {
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
            checkIn: punchOutAlone.punchTime,
            checkOut: null,
            hasIncompletePunch: true,
            punchPairsCount: 0,
            source: 'BIOMETRIC',
          }),
        })
      );
    });

    it('should re-order out-of-order earlier punch chronologically as CHECK_IN and shift existing punch to CHECK_OUT', async () => {
      const existingAttendance = {
        id: 'att-uuid-1',
        companyId: companyAlphaId,
        employeeId: 'emp-uuid-1',
        workDate: new Date('2026-10-19T00:00:00.000Z'),
        checkIn: new Date('2026-10-19T09:00:00.000Z'),
        checkOut: null,
      };

      // Out-of-order earlier punch timestamp 07:00 arrives after 09:00
      const earlierOutPunch = {
        id: 'punch-earlier-out',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T07:00:00.000Z'),
        inOutMode: 'CHECK_OUT' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: mockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(earlierOutPunch as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(existingAttendance as any);
      const updateAttSpy = vi.spyOn(prisma.attendance, 'update').mockResolvedValueOnce({} as any);
      const updateRawSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-earlier-out');

      expect(result.status).toBe('PROCESSED');
      expect(result.message).toContain('paired chronologically');
      expect(updateAttSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-uuid-1' },
          data: expect.objectContaining({
            checkIn: earlierOutPunch.punchTime,
            checkOut: existingAttendance.checkIn,
            actualWorkedMinutes: 120,
            hasIncompletePunch: false,
            punchPairsCount: 1,
          }),
        })
      );
      expect(updateRawSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            syncStatus: 'PROCESSED',
            errorMessage: null,
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
      vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));
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

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: employeeUser.userId,
        companyId: employeeUser.companyId,
        email: employeeUser.email,
        fullName: employeeUser.fullName,
        role: employeeUser.role,
        isActive: true,
        tokenVersion: 1,
      } as any);
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null as any);

      const resSync = await request(app)
        .post('/api/biometric/sync')
        .set('Authorization', `Bearer ${empToken}`)
        .send({});

      expect(resSync.status).toBe(403);
      expect(resSync.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');

      const resPunches = await request(app)
        .get('/api/biometric/punches')
        .set('Authorization', `Bearer ${empToken}`);

      expect(resPunches.status).toBe(403);
      expect(resPunches.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
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
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
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
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
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

        vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
        vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([{ id: 'punch-err-retry' }] as any);
        vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(errorPunch as any);
        vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([
          {
            id: 'new-emp-uuid',
            companyId: companyAlphaId,
            biometricDeviceId: 'BIO-NEW-EMP',
            status: 'ACTIVE',
            shift: standardShift,
          },
        ] as any);
        vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValue({} as any);
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
      } finally {
        vi.useRealTimers();
      }
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

    it('should fail closed when company timezone is missing or invalid (P0-B, never falls back to UTC)', async () => {
      // 1. Timezone is null
      const mockTxNull = {
        company: {
          findUnique: vi.fn().mockResolvedValue({ timezone: null }),
        },
      } as any;
      await expect(
        PunchReconciliationService.resolveCompanyTimezone('c1', mockTxNull)
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_MISSING' });

      // 2. Timezone is invalid string
      const mockTxInvalid = {
        company: {
          findUnique: vi.fn().mockResolvedValue({ timezone: 'Invalid/NonExistent_Zone' }),
        },
      } as any;
      await expect(
        PunchReconciliationService.resolveCompanyTimezone('c1', mockTxInvalid)
      ).rejects.toMatchObject({ statusCode: 422, code: 'BIOMETRIC_TIMEZONE_INVALID' });
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

  describe('8. Mock-Based Concurrency Locking, Rollback, Idempotency & Debounce Unit Simulations (Real DB Concurrency is Tested in tests/integration/concurrent-punch-reconciliation.test.ts)', () => {
    it('derives deterministic company/employee/workDate advisory lock keys and acquires FOR UPDATE then pg_advisory_xact_lock before attendance lookup', async () => {
      const uuidCompanyA = '22222222-2222-4222-8222-222222222210';
      const uuidCompanyB = '22222222-2222-4222-8222-222222222211';
      const uuidEmpId = '33333333-3333-4333-8333-333333333310';
      const uuidPunchId = '11111111-1111-4111-8111-111111111110';

      const keysA1 = deriveAttendanceAdvisoryLockKeys(uuidCompanyA, uuidEmpId, '2026-10-19');
      const keysA2 = deriveAttendanceAdvisoryLockKeys(uuidCompanyA, uuidEmpId, '2026-10-19');
      const keysDiffCompany = deriveAttendanceAdvisoryLockKeys(uuidCompanyB, uuidEmpId, '2026-10-19');
      const keysDiffDate = deriveAttendanceAdvisoryLockKeys(uuidCompanyA, uuidEmpId, '2026-10-20');

      expect(keysA1).toEqual(keysA2);
      expect(keysA1).not.toEqual(keysDiffCompany);
      expect(keysA1).not.toEqual(keysDiffDate);
      expect(Number.isInteger(keysA1[0])).toBe(true);
      expect(Number.isInteger(keysA1[1])).toBe(true);

      const callOrder: string[] = [];
      const txQueryRaw = vi.fn(async () => {
        callOrder.push('RAW_PUNCH_FOR_UPDATE');
        return [{ id: uuidPunchId }];
      });
      const txExecuteRaw = vi.fn(async (_strings: TemplateStringsArray, k1: number, k2: number) => {
        callOrder.push(`ADVISORY_XACT_LOCK:${k1}:${k2}`);
        return 1;
      });
      const txFindUnique = vi.fn(async () => {
        callOrder.push('RAW_PUNCH_READ');
        return {
          id: uuidPunchId,
          companyId: uuidCompanyA,
          userEnrollmentId: 'BIO-1001',
          punchTime: new Date('2026-10-19T09:00:00.000Z'),
          inOutMode: 'CHECK_IN' as const,
          syncStatus: 'PENDING' as const,
          matchedEmployeeId: uuidEmpId,
          matchedEmployee: { ...defaultMockEmployee, id: uuidEmpId, companyId: uuidCompanyA },
        };
      });
      const txAttFindUnique = vi.fn(async () => {
        callOrder.push('ATTENDANCE_FIND_UNIQUE');
        return null;
      });
      const txAttCreate = vi.fn(async () => {
        callOrder.push('ATTENDANCE_CREATE');
        return { id: 'att-created-1' };
      });

      const txSpy = vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (cb: any) =>
        cb({
          $queryRaw: txQueryRaw,
          $executeRaw: txExecuteRaw,
          rawPunchLog: { findUnique: txFindUnique, update: vi.fn().mockResolvedValue({}) },
          companySetting: { findUnique: vi.fn().mockResolvedValue(null) },
          employee: { findMany: vi.fn().mockResolvedValue([{ ...defaultMockEmployee, id: uuidEmpId, companyId: uuidCompanyA }]) },
          company: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
          payrollPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
          attendance: { findUnique: txAttFindUnique, create: txAttCreate },
          leaveRequest: { findFirst: vi.fn().mockResolvedValue(null) },
        })) as any);

      try {
        const res = await PunchReconciliationService.reconcilePunch(uuidPunchId, undefined, {
          expectedCompanyId: uuidCompanyA,
        });
        expect(res.status).toBe('PROCESSED');
        expect(callOrder).toEqual([
          'RAW_PUNCH_FOR_UPDATE',
          'RAW_PUNCH_READ',
          `ADVISORY_XACT_LOCK:${keysA1[0]}:${keysA1[1]}`,
          'ATTENDANCE_FIND_UNIQUE',
          'ATTENDANCE_CREATE',
        ]);
      } finally {
        txSpy.mockRestore();
      }
    });

    it('acquires FOR UPDATE lock before reading syncStatus and returns idempotent PROCESSED result when already processed', async () => {
      const uuidPunchId = '11111111-1111-4111-8111-111111111101';
      const uuidCompanyId = '22222222-2222-4222-8222-222222222201';
      const callOrder: string[] = [];

      const txQueryRaw = vi.fn(async () => {
        callOrder.push('FOR_UPDATE');
        return [{ id: uuidPunchId }];
      });
      const txFindUnique = vi.fn(async () => {
        callOrder.push('FIND_UNIQUE');
        return {
          id: uuidPunchId,
          companyId: uuidCompanyId,
          userEnrollmentId: '101',
          punchTime: new Date('2026-10-19T09:00:00.000Z'),
          inOutMode: 'CHECK_IN' as const,
          syncStatus: 'PROCESSED' as const,
          matchedEmployeeId: 'emp-uuid-1',
          matchedEmployee: defaultMockEmployee,
        };
      });
      const txAttCreate = vi.fn();
      const txAttUpdate = vi.fn();
      const txRawUpdate = vi.fn();

      const txSpy = vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (cb: any) =>
        cb({
          $queryRaw: txQueryRaw,
          rawPunchLog: { findUnique: txFindUnique, update: txRawUpdate },
          attendance: { create: txAttCreate, update: txAttUpdate },
        })) as any);

      try {
        const result = await PunchReconciliationService.reconcilePunch(uuidPunchId, undefined, {
          expectedCompanyId: uuidCompanyId,
        });

        expect(callOrder).toEqual(['FOR_UPDATE', 'FIND_UNIQUE']);
        expect(txQueryRaw).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('PROCESSED');
        expect(result.matchedEmployeeId).toBe('emp-uuid-1');
        expect(result.message).toBe('Punch was already successfully processed.');
        expect(txAttCreate).not.toHaveBeenCalled();
        expect(txAttUpdate).not.toHaveBeenCalled();
        expect(txRawUpdate).not.toHaveBeenCalled();
      } finally {
        txSpy.mockRestore();
      }
    });

    it('serializes concurrent duplicate requests on the same PENDING punch without IGNORED overwrite or duplicate Attendance', async () => {
      const uuidCompanyId = '22222222-2222-4222-8222-222222222202';
      const uuidPunchId = '11111111-1111-4111-8111-111111111102';
      const punchTime = new Date('2026-10-19T09:00:00.000Z');

      const committedPunch = {
        id: uuidPunchId,
        companyId: uuidCompanyId,
        terminalId: 'term-uuid-1',
        userEnrollmentId: 'BIO-1001',
        punchTime,
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        errorMessage: null as string | null,
        matchedEmployeeId: null as string | null,
      };
      const committedAttendance: Array<Record<string, any>> = [];

      // Barrier ensures both concurrent reconcilePendingPunches calls finish findMany() as PENDING
      let arrived = 0;
      let releaseBarrier!: () => void;
      const bothReady = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      // Async mutex simulates PostgreSQL SELECT ... FOR UPDATE row lock
      let lockQueue = Promise.resolve();
      const acquireRowLock = async (): Promise<() => void> => {
        let unlock!: () => void;
        const next = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        const prev = lockQueue;
        lockQueue = prev.then(() => next);
        await prev;
        return unlock;
      };

      const findManySpy = vi
        .spyOn(prisma.rawPunchLog, 'findMany')
        .mockImplementation((async () => {
          if (committedPunch.syncStatus !== 'PENDING') return [];
          return [{ id: committedPunch.id }] as any;
        }) as any);

      const txSpy = vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => {
        arrived += 1;
        if (arrived >= 2) releaseBarrier();
        await bothReady;

        const unlock = await acquireRowLock();
        try {
          const mockTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: committedPunch.id }]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            rawPunchLog: {
              findUnique: vi.fn(async () => ({
                ...committedPunch,
                company: { id: uuidCompanyId, timezone: 'UTC' },
                terminal: { id: 'term-uuid-1', name: 'Gate', location: 'Main' },
                matchedEmployee: committedPunch.matchedEmployeeId
                  ? { ...defaultMockEmployee, companyId: uuidCompanyId }
                  : null,
              })),
              update: vi.fn(async (args: any) => {
                Object.assign(committedPunch, args.data);
                return { ...committedPunch };
              }),
            },
            companySetting: {
              findUnique: vi.fn(async () => null),
            },
            employee: {
              findMany: vi.fn(async () => [
                {
                  ...defaultMockEmployee,
                  companyId: uuidCompanyId,
                },
              ]),
            },
            company: {
              findUnique: vi.fn(async () => ({ timezone: 'UTC' })),
            },
            payrollPeriod: {
              findFirst: vi.fn(async () => null),
            },
            attendance: {
              findUnique: vi.fn(
                async (args: any) =>
                  committedAttendance.find(
                    (a) =>
                      a.companyId === args.where.companyId_employeeId_workDate.companyId &&
                      a.employeeId === args.where.companyId_employeeId_workDate.employeeId &&
                      a.workDate.toISOString() ===
                        args.where.companyId_employeeId_workDate.workDate.toISOString()
                  ) || null
              ),
              create: vi.fn(async (args: any) => {
                const duplicate = committedAttendance.find(
                  (a) =>
                    a.companyId === args.data.companyId &&
                    a.employeeId === args.data.employeeId &&
                    a.workDate.toISOString() === args.data.workDate.toISOString()
                );
                if (duplicate) {
                  const p2002 = new Error('Unique constraint failed on Attendance');
                  (p2002 as any).code = 'P2002';
                  throw p2002;
                }
                const row = { id: `att-${committedAttendance.length + 1}`, ...args.data };
                committedAttendance.push(row);
                return row;
              }),
            },
            leaveRequest: {
              findFirst: vi.fn(async () => null),
            },
          };

          return await cb(mockTx);
        } finally {
          unlock();
        }
      }) as any);

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
      const companyTzSpy = vi
        .spyOn(prisma.company, 'findUnique')
        .mockResolvedValue({ timezone: 'UTC' } as any);

      try {
        const [resA, resB] = await Promise.all([
          PunchReconciliationService.reconcilePendingPunches(uuidCompanyId, {
            punchId: uuidPunchId,
          }),
          PunchReconciliationService.reconcilePendingPunches(uuidCompanyId, {
            punchId: uuidPunchId,
          }),
        ]);

        expect(arrived).toBe(2);
        expect(resA.totalEvaluated).toBe(1);
        expect(resB.totalEvaluated).toBe(1);
        expect(resA.errors).toBe(0);
        expect(resB.errors).toBe(0);
        expect(resA.ignored).toBe(0);
        expect(resB.ignored).toBe(0);
        expect(resA.results[0]?.status).toBe('PROCESSED');
        expect(resB.results[0]?.status).toBe('PROCESSED');
        expect([resA.results[0]?.message, resB.results[0]?.message].sort()).toEqual([
          'Check-in recorded successfully.',
          'Punch was already successfully processed.',
        ]);
        expect(committedPunch.syncStatus).toBe('PROCESSED');
        expect(committedPunch.matchedEmployeeId).toBe(defaultMockEmployee.id);
        expect(committedAttendance).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        companyTzSpy.mockRestore();
        findManySpy.mockRestore();
        txSpy.mockRestore();
      }
    });

    it('rolls back partial Attendance writes on transaction failure and never overwrites a PROCESSED punch in catch fallback', async () => {
      const uuidCompanyId = '22222222-2222-4222-8222-222222222203';
      const uuidPunchId = '11111111-1111-4111-8111-111111111103';

      const committedPunch = {
        id: uuidPunchId,
        companyId: uuidCompanyId,
        terminalId: 'term-uuid-1',
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T09:00:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        errorMessage: null as string | null,
        matchedEmployeeId: defaultMockEmployee.id,
      };
      const committedAttendance: Array<Record<string, any>> = [];

      // Simulate atomic transaction buffer that rolls back on throw
      const txSpy = vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (cb: any) => {
        const stagingPunch = { ...committedPunch };
        const stagingAttendance = [...committedAttendance];

        const mockTx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: uuidPunchId }]),
          $executeRaw: vi.fn().mockResolvedValue(1),
          rawPunchLog: {
            findUnique: vi.fn(async () => ({
              ...stagingPunch,
              company: { id: uuidCompanyId, timezone: 'UTC' },
              terminal: { id: 'term-uuid-1', name: 'Gate', location: 'Main' },
              matchedEmployee: { ...defaultMockEmployee, companyId: uuidCompanyId },
            })),
            update: vi.fn(async () => {
              throw new Error('Simulated DB connection drop before commit');
            }),
          },
          companySetting: { findUnique: vi.fn(async () => null) },
          employee: {
            findMany: vi.fn(async () => [{ ...defaultMockEmployee, companyId: uuidCompanyId }]),
          },
          company: { findUnique: vi.fn(async () => ({ timezone: 'UTC' })) },
          payrollPeriod: { findFirst: vi.fn(async () => null) },
          attendance: {
            findUnique: vi.fn(async () => null),
            create: vi.fn(async (args: any) => {
              const row = { id: 'att-staged-1', ...args.data };
              stagingAttendance.push(row);
              return row;
            }),
          },
          leaveRequest: { findFirst: vi.fn(async () => null) },
        };

        const out = await cb(mockTx);
        Object.assign(committedPunch, stagingPunch);
        committedAttendance.splice(0, committedAttendance.length, ...stagingAttendance);
        return out;
      }) as any);

      // Simulate concurrent catch-guard check when punch is already PROCESSED
      const findManySpy = vi
        .spyOn(prisma.rawPunchLog, 'findMany')
        .mockResolvedValueOnce([{ id: uuidPunchId }] as any);
      const updateManySpy = vi
        .spyOn(prisma.rawPunchLog, 'updateMany')
        .mockImplementation((async (args: any) => {
          const excluded: string[] = args?.where?.syncStatus?.notIn || [];
          if (!excluded.includes(committedPunch.syncStatus)) {
            Object.assign(committedPunch, args.data);
            return { count: 1 } as any;
          }
          return { count: 0 } as any;
        }) as any);

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
      const companyTzSpy = vi
        .spyOn(prisma.company, 'findUnique')
        .mockResolvedValue({ timezone: 'UTC' } as any);

      try {
        // 1. Direct reconcilePunch throws and leaves committed store rolled back
        await expect(
          PunchReconciliationService.reconcilePunch(uuidPunchId)
        ).rejects.toThrow('Simulated DB connection drop before commit');
        expect(committedAttendance).toHaveLength(0);
        expect(committedPunch.syncStatus).toBe('PENDING');

        // 2. reconcilePendingPunches catch block uses guarded updateMany that skips PROCESSED rows
        committedPunch.syncStatus = 'PROCESSED' as any;
        txSpy.mockRejectedValueOnce(new Error('Simulated transient transaction error'));

        const batchRes = await PunchReconciliationService.reconcilePendingPunches(uuidCompanyId, {
          punchId: uuidPunchId,
        });
        expect(batchRes.errors).toBe(1);
        expect(updateManySpy).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: uuidPunchId,
              syncStatus: { notIn: ['PROCESSED', 'IGNORED'] },
            },
          })
        );
        expect(committedPunch.syncStatus).toBe('PROCESSED');
      } finally {
        vi.useRealTimers();
        companyTzSpy.mockRestore();
        txSpy.mockRestore();
        findManySpy.mockRestore();
        updateManySpy.mockRestore();
      }
    });

    it('preserves existing 2-minute debounce behavior for rapid repeated CHECK_OUT punches', async () => {
      const existingAttendance = {
        id: 'att-uuid-debounce-out',
        companyId: companyAlphaId,
        employeeId: 'emp-uuid-1',
        workDate: new Date('2026-10-19T00:00:00.000Z'),
        checkIn: new Date('2026-10-19T09:00:00.000Z'),
        checkOut: new Date('2026-10-19T18:00:00.000Z'),
      };

      const punchDupOut = {
        id: 'punch-dup-out',
        companyId: companyAlphaId,
        userEnrollmentId: 'BIO-1001',
        punchTime: new Date('2026-10-19T18:01:30.000Z'), // 90 seconds after checkOut
        inOutMode: 'CHECK_OUT' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployee: defaultMockEmployee,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punchDupOut as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValueOnce({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(existingAttendance as any);
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      try {
        const result = await PunchReconciliationService.reconcilePunch('punch-dup-out');

        expect(result.status).toBe('IGNORED');
        expect(result.message).toBe('Duplicate check-out punch debounced within 2 minutes.');
        expect(attUpdateSpy).not.toHaveBeenCalled();
        expect(rawUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'punch-dup-out' },
            data: expect.objectContaining({
              syncStatus: 'IGNORED',
              errorMessage: 'Duplicate check-out punch debounced within 2 minutes.',
            }),
          })
        );
      } finally {
        attUpdateSpy.mockRestore();
        rawUpdateSpy.mockRestore();
      }
    });
  });

  describe('9. GAP 2: Pre-matched RawPunchLog re-verification on legacy ambiguity & tenant integrity', () => {
    it('fails closed without Attendance mutation when a previously legacy-matched punch becomes ambiguous after a second employee acquires the same biometricDeviceId', async () => {
      const empA = {
        ...defaultMockEmployee,
        id: 'emp-legacy-pre-a',
        biometricDeviceId: 'BIO-SHARED-901',
      };
      const empB = {
        ...defaultMockEmployee,
        id: 'emp-legacy-pre-b',
        employeeCode: 'EMP-002',
        biometricDeviceId: 'BIO-SHARED-901',
      };

      const preMatchedPunch = {
        id: 'punch-prematched-ambiguous',
        companyId: companyAlphaId,
        terminalId: 'term-gate-1',
        userEnrollmentId: 'BIO-SHARED-901',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: empA.id,
        matchedEmployee: empA,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(preMatchedPunch as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValueOnce(null as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([empA, empB] as any);
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-ambiguous');

      expect(result.status).toBe('ERROR');
      expect(result.workDate).toBeNull();
      expect(result.message).toContain('Ambiguous legacy biometric enrollment mapping');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      expect(rawUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'punch-prematched-ambiguous' },
          data: expect.objectContaining({
            syncStatus: 'ERROR',
            errorMessage: expect.stringContaining('Ambiguous legacy biometric enrollment mapping'),
          }),
        })
      );
      // Must NOT blindly reassign matchedEmployeeId on RawPunchLog
      const updatePayload = rawUpdateSpy.mock.calls[0][0].data as Record<string, unknown>;
      expect(updatePayload.matchedEmployeeId).toBeUndefined();
    });

    it('continues to reconcile a unique pre-matched legacy punch cleanly', async () => {
      const uniqueEmp = {
        ...defaultMockEmployee,
        id: 'emp-legacy-unique-902',
        biometricDeviceId: 'BIO-UNIQUE-902',
      };

      const preMatchedUniquePunch = {
        id: 'punch-prematched-unique',
        companyId: companyAlphaId,
        terminalId: 'term-gate-1',
        userEnrollmentId: 'BIO-UNIQUE-902',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: uniqueEmp.id,
        matchedEmployee: uniqueEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(preMatchedUniquePunch as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValueOnce(null as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([uniqueEmp] as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create').mockResolvedValueOnce({} as any);
      vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValue({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-unique');

      expect(result.status).toBe('PROCESSED');
      expect(result.matchedEmployeeId).toBe(uniqueEmp.id);
      expect(attCreateSpy).toHaveBeenCalledTimes(1);
    });

    it('reconciles a pre-matched punch backed by a valid explicit terminal mapping even when other legacy employees share the enrollment ID', async () => {
      const explicitEmp = {
        ...defaultMockEmployee,
        id: 'emp-explicit-903',
        biometricDeviceId: 'BIO-EXPLICIT-903',
      };

      const explicitPunch = {
        id: 'punch-prematched-explicit',
        companyId: companyAlphaId,
        terminalId: 'term-gate-explicit',
        userEnrollmentId: 'BIO-EXPLICIT-903',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: explicitEmp.id,
        matchedEmployee: explicitEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(explicitPunch as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValueOnce({
        id: 'setting-explicit',
        companyId: companyAlphaId,
        key: 'BIOMETRIC_EMPLOYEE_MAPPINGS_V1',
        value: JSON.stringify([
          {
            id: 'map-903',
            companyId: companyAlphaId,
            employeeId: explicitEmp.id,
            terminalId: 'term-gate-explicit',
            enrollmentId: 'BIO-EXPLICIT-903',
            isActive: true,
            source: 'EXPLICIT',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ]),
      } as any);
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValueOnce(explicitEmp as any);
      const legacyFindManySpy = vi.spyOn(prisma.employee, 'findMany');
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.attendance, 'findUnique').mockResolvedValueOnce(null);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create').mockResolvedValueOnce({} as any);
      vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValue({} as any);

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-explicit');

      expect(result.status).toBe('PROCESSED');
      expect(result.matchedEmployeeId).toBe(explicitEmp.id);
      expect(attCreateSpy).toHaveBeenCalledTimes(1);
      expect(legacyFindManySpy).not.toHaveBeenCalled();
    });

    it('rejects a previously matched punch whose matchedEmployee belongs to another company without bypassing tenant checks', async () => {
      const betaEmp = {
        ...defaultMockEmployee,
        id: 'emp-beta-904',
        companyId: companyBetaId,
        biometricDeviceId: 'BIO-904',
      };

      const crossTenantPreMatched = {
        id: 'punch-prematched-cross-tenant',
        companyId: companyAlphaId,
        terminalId: 'term-gate-1',
        userEnrollmentId: 'BIO-904',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: betaEmp.id,
        matchedEmployee: betaEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(crossTenantPreMatched as any);
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-cross-tenant');

      expect(result.status).toBe('ERROR');
      expect(result.matchedEmployeeId).toBeNull();
      expect(result.message).toContain('Security violation');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(rawUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'punch-prematched-cross-tenant' },
          data: expect.objectContaining({
            syncStatus: 'ERROR',
            errorMessage: expect.stringContaining('Security violation'),
          }),
        })
      );
    });

    it('fails closed without Attendance mutation or matchedEmployeeId reassignment when current resolution returns employee=null', async () => {
      const staleEmp = {
        ...defaultMockEmployee,
        id: 'emp-stale-905',
        biometricDeviceId: 'BIO-STALE-905',
      };

      const stalePunch = {
        id: 'punch-prematched-emp-null',
        companyId: companyAlphaId,
        terminalId: 'term-gate-1',
        userEnrollmentId: 'BIO-STALE-905',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: staleEmp.id,
        matchedEmployee: staleEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(stalePunch as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValueOnce(null as any);
      // No legacy employee currently matches BIO-STALE-905 -> resolveEmployeeForPunch returns { employee: null, matchedVia: null }
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([] as any);
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-emp-null');

      expect(result.status).toBe('ERROR');
      expect(result.workDate).toBeNull();
      expect(result.matchedEmployeeId).toBe(staleEmp.id);
      expect(result.message).toContain('Biometric enrollment mapping mismatch');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      expect(rawUpdateSpy).toHaveBeenCalledTimes(1);
      const updatePayload = rawUpdateSpy.mock.calls[0][0].data as Record<string, unknown>;
      expect(updatePayload.syncStatus).toBe('ERROR');
      expect(updatePayload.matchedEmployeeId).toBeUndefined();
    });

    it('fails closed without Attendance mutation or matchedEmployeeId reassignment when current resolution returns matchedVia=null', async () => {
      const preEmp = {
        ...defaultMockEmployee,
        id: 'emp-matchedvia-null-906',
        biometricDeviceId: 'BIO-906',
      };

      const punch = {
        id: 'punch-prematched-via-null',
        companyId: companyAlphaId,
        terminalId: 'term-gate-1',
        userEnrollmentId: 'BIO-906',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: preEmp.id,
        matchedEmployee: preEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punch as any);
      vi.spyOn(BiometricMappingService, 'resolveEmployeeForPunch').mockResolvedValueOnce({
        employee: preEmp,
        matchedVia: null,
      });
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-via-null');

      expect(result.status).toBe('ERROR');
      expect(result.workDate).toBeNull();
      expect(result.matchedEmployeeId).toBe(preEmp.id);
      expect(result.message).toContain('Biometric enrollment mapping mismatch');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      const updatePayload = rawUpdateSpy.mock.calls[0][0].data as Record<string, unknown>;
      expect(updatePayload.syncStatus).toBe('ERROR');
      expect(updatePayload.matchedEmployeeId).toBeUndefined();
    });

    it('fails closed without Attendance mutation or reassignment when active explicit mapping now points to another employee', async () => {
      const oldEmp = {
        ...defaultMockEmployee,
        id: 'emp-old-907',
        biometricDeviceId: 'BIO-907',
      };
      const newExplicitEmp = {
        ...defaultMockEmployee,
        id: 'emp-new-explicit-907',
        employeeCode: 'EMP-907B',
        biometricDeviceId: 'BIO-907',
      };

      const punch = {
        id: 'punch-prematched-explicit-other',
        companyId: companyAlphaId,
        terminalId: 'term-gate-907',
        userEnrollmentId: 'BIO-907',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: oldEmp.id,
        matchedEmployee: oldEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punch as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValueOnce({
        id: 'setting-907',
        companyId: companyAlphaId,
        key: 'BIOMETRIC_EMPLOYEE_MAPPINGS_V1',
        value: JSON.stringify([
          {
            id: 'map-907',
            companyId: companyAlphaId,
            employeeId: newExplicitEmp.id,
            terminalId: 'term-gate-907',
            enrollmentId: 'BIO-907',
            isActive: true,
            source: 'EXPLICIT',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ]),
      } as any);
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValueOnce(newExplicitEmp as any);
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-explicit-other');

      expect(result.status).toBe('ERROR');
      expect(result.workDate).toBeNull();
      expect(result.matchedEmployeeId).toBe(oldEmp.id);
      expect(result.message).toContain('Biometric enrollment mapping mismatch');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      const updatePayload = rawUpdateSpy.mock.calls[0][0].data as Record<string, unknown>;
      expect(updatePayload.syncStatus).toBe('ERROR');
      expect(updatePayload.matchedEmployeeId).toBeUndefined();
    });

    it('fails closed without Attendance mutation or reassignment when active explicit mapping points to an inactive or missing employee', async () => {
      const legacyPreEmp = {
        ...defaultMockEmployee,
        id: 'emp-legacy-pre-908',
        biometricDeviceId: 'BIO-908',
      };
      const inactiveExplicitEmp = {
        ...defaultMockEmployee,
        id: 'emp-inactive-explicit-908',
        status: 'INACTIVE',
      };

      // Case A: Active explicit mapping points to an INACTIVE different employee
      const punchInactive = {
        id: 'punch-prematched-explicit-inactive',
        companyId: companyAlphaId,
        terminalId: 'term-gate-908',
        userEnrollmentId: 'BIO-908',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: legacyPreEmp.id,
        matchedEmployee: legacyPreEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punchInactive as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValueOnce({
        id: 'setting-908-inactive',
        companyId: companyAlphaId,
        key: 'BIOMETRIC_EMPLOYEE_MAPPINGS_V1',
        value: JSON.stringify([
          {
            id: 'map-908-inactive',
            companyId: companyAlphaId,
            employeeId: inactiveExplicitEmp.id,
            terminalId: 'term-gate-908',
            enrollmentId: 'BIO-908',
            isActive: true,
            source: 'EXPLICIT',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ]),
      } as any);
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValueOnce(inactiveExplicitEmp as any);
      const rawUpdateSpyA = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const resInactive = await PunchReconciliationService.reconcilePunch('punch-prematched-explicit-inactive');
      expect(resInactive.status).toBe('ERROR');
      expect(resInactive.workDate).toBeNull();
      expect(resInactive.message).toContain('Biometric enrollment mapping mismatch');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      expect((rawUpdateSpyA.mock.calls[0][0].data as Record<string, unknown>).matchedEmployeeId).toBeUndefined();

      // Case B: Active explicit mapping points to a MISSING (deleted/stale) employee
      const punchMissing = {
        ...punchInactive,
        id: 'punch-prematched-explicit-missing',
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punchMissing as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValueOnce({
        id: 'setting-908-missing',
        companyId: companyAlphaId,
        key: 'BIOMETRIC_EMPLOYEE_MAPPINGS_V1',
        value: JSON.stringify([
          {
            id: 'map-908-missing',
            companyId: companyAlphaId,
            employeeId: 'emp-deleted-908',
            terminalId: 'term-gate-908',
            enrollmentId: 'BIO-908',
            isActive: true,
            source: 'EXPLICIT',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ]),
      } as any);
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValueOnce(null);
      const rawUpdateSpyB = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);

      const resMissing = await PunchReconciliationService.reconcilePunch('punch-prematched-explicit-missing');
      expect(resMissing.status).toBe('ERROR');
      expect(resMissing.workDate).toBeNull();
      expect(resMissing.message).toContain('Biometric enrollment mapping mismatch');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      expect((rawUpdateSpyB.mock.calls[0][0].data as Record<string, unknown>).matchedEmployeeId).toBeUndefined();
    });

    it('fails closed without Attendance mutation or reassignment when legacy mapping now resolves to a different employee', async () => {
      const oldLegacyEmp = {
        ...defaultMockEmployee,
        id: 'emp-legacy-old-909',
        biometricDeviceId: 'BIO-909',
      };
      const newLegacyEmp = {
        ...defaultMockEmployee,
        id: 'emp-legacy-new-909',
        employeeCode: 'EMP-909B',
        biometricDeviceId: 'BIO-909',
      };

      const punch = {
        id: 'punch-prematched-legacy-other',
        companyId: companyAlphaId,
        terminalId: 'term-gate-1',
        userEnrollmentId: 'BIO-909',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: oldLegacyEmp.id,
        matchedEmployee: oldLegacyEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punch as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValueOnce(null as any);
      // Only newLegacyEmp now holds biometricDeviceId 'BIO-909'
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([newLegacyEmp] as any);
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-legacy-other');

      expect(result.status).toBe('ERROR');
      expect(result.workDate).toBeNull();
      expect(result.matchedEmployeeId).toBe(oldLegacyEmp.id);
      expect(result.message).toContain('Biometric enrollment mapping mismatch');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      const updatePayload = rawUpdateSpy.mock.calls[0][0].data as Record<string, unknown>;
      expect(updatePayload.syncStatus).toBe('ERROR');
      expect(updatePayload.matchedEmployeeId).toBeUndefined();
    });

    it('fails closed without Attendance mutation or reassignment when pre-matched resolution omits employee.companyId', async () => {
      const preEmp = {
        ...defaultMockEmployee,
        id: 'emp-missing-company-910',
        biometricDeviceId: 'BIO-910',
      };
      const { companyId: _omittedCompanyId, ...empWithoutCompanyId } = preEmp;

      const punch = {
        id: 'punch-prematched-missing-company',
        companyId: companyAlphaId,
        terminalId: 'term-gate-1',
        userEnrollmentId: 'BIO-910',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: preEmp.id,
        matchedEmployee: preEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punch as any);
      vi.spyOn(BiometricMappingService, 'resolveEmployeeForPunch').mockResolvedValueOnce({
        employee: empWithoutCompanyId,
        matchedVia: 'MAPPING',
      });
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-missing-company');

      expect(result.status).toBe('ERROR');
      expect(result.workDate).toBeNull();
      expect(result.matchedEmployeeId).toBe(preEmp.id);
      expect(result.message).toContain('Biometric enrollment mapping mismatch');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      const updatePayload = rawUpdateSpy.mock.calls[0][0].data as Record<string, unknown>;
      expect(updatePayload.syncStatus).toBe('ERROR');
      expect(updatePayload.matchedEmployeeId).toBeUndefined();
    });

    it('fails closed without Attendance mutation or reassignment when pre-matched resolution returns a different employee.companyId', async () => {
      const preEmp = {
        ...defaultMockEmployee,
        id: 'emp-wrong-company-911',
        biometricDeviceId: 'BIO-911',
      };

      const punch = {
        id: 'punch-prematched-wrong-company',
        companyId: companyAlphaId,
        terminalId: 'term-gate-1',
        userEnrollmentId: 'BIO-911',
        punchTime: new Date('2026-10-19T08:55:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: preEmp.id,
        matchedEmployee: preEmp,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(punch as any);
      vi.spyOn(BiometricMappingService, 'resolveEmployeeForPunch').mockResolvedValueOnce({
        employee: { ...preEmp, companyId: companyBetaId },
        matchedVia: 'LEGACY',
      });
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValueOnce({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const result = await PunchReconciliationService.reconcilePunch('punch-prematched-wrong-company');

      expect(result.status).toBe('ERROR');
      expect(result.workDate).toBeNull();
      expect(result.matchedEmployeeId).toBe(preEmp.id);
      expect(result.message).toContain('Biometric enrollment mapping mismatch');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      const updatePayload = rawUpdateSpy.mock.calls[0][0].data as Record<string, unknown>;
      expect(updatePayload.syncStatus).toBe('ERROR');
      expect(updatePayload.matchedEmployeeId).toBeUndefined();
    });
  });
});


