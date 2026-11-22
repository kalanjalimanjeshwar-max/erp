import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import {
  BiometricMappingService,
  BIOMETRIC_DEVICE_USERS_SETTING_KEY,
  BIOMETRIC_MAPPINGS_SETTING_KEY,
} from '../../src/server/services/biometric-mapping.service.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';
import { EmployeeService } from '../../src/server/services/employee.service.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { AuthUser } from '../../src/shared/types.js';
import { decodeUserTablePayload } from '../../bridges/essl-x2008-bridge/src/protocol/zkteco-tcp.adapter.js';

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Employee Biometric Enrollment Mapping, Activation & Targeted Reconciliation', () => {
  const app = createApp();
  const companyAlphaId = '11111111-1111-4111-8111-111111111111';
  const companyBetaId = '22222222-2222-4222-8222-222222222222';

  const adminActor: AuthUser = {
    id: 'user-admin-alpha',
    userId: 'user-admin-alpha',
    companyId: companyAlphaId,
    email: 'admin@alpha.local',
    fullName: 'Alpha HR Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeActor: AuthUser = {
    id: 'user-emp-alpha',
    userId: 'user-emp-alpha',
    companyId: companyAlphaId,
    email: 'emp@alpha.local',
    fullName: 'Alpha Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const esslTerminal = {
    id: 'term-essl-x2008',
    companyId: companyAlphaId,
    deviceSerialNumber: 'NFZ8252800275',
    name: 'eSSL X2008 Main Entrance',
    terminalModel: 'eSSL X2008 (ZLM60_TFT)',
    ipAddress: '192.168.1.201',
    port: 4370,
    location: 'Ground Floor Lobby',
    apiKeyPrefix: 'bio_live_essl',
    status: 'ONLINE' as const,
    lastHeartbeatAt: new Date(),
    lastSyncAt: new Date(),
    firmwareVersion: 'ZLM60_TFT_VX10.0',
    registeredByUserId: 'user-admin-alpha',
    registeredByUser: { fullName: 'Alpha HR Admin' },
    isActive: true,
    notes: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  };

  const secondaryTerminal = {
    ...esslTerminal,
    id: 'term-gate-2',
    deviceSerialNumber: 'ZK-GATE-2002',
    name: 'Warehouse Biometric',
    terminalModel: 'ZKTeco F22',
    ipAddress: '192.168.1.202',
    location: 'Warehouse Gate',
  };

  const betaTerminal = {
    ...esslTerminal,
    id: 'term-beta-1',
    companyId: companyBetaId,
    deviceSerialNumber: 'BETA-SN-999',
    name: 'Beta Gate',
  };

  const standardShift = {
    id: 'shift-general',
    companyId: companyAlphaId,
    code: 'GEN',
    name: 'General Shift',
    startTime: '09:00',
    endTime: '18:00',
    isOvernight: false,
    graceMinutes: 15,
    halfDayMinutes: 240,
    isActive: true,
  };

  function createInMemorySettingStore() {
    const store = new Map<string, string>();
    const makeKey = (companyId: string, key: string) => `${companyId}::${key}`;

    vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation((async (args: any) => {
      const k = makeKey(args.where.companyId_key.companyId, args.where.companyId_key.key);
      const val = store.get(k);
      if (val === undefined) return null;
      return { id: k, companyId: args.where.companyId_key.companyId, key: args.where.companyId_key.key, value: val } as any;
    }) as any);

    vi.spyOn(prisma.companySetting, 'upsert').mockImplementation((async (args: any) => {
      const k = makeKey(args.where.companyId_key.companyId, args.where.companyId_key.key);
      const val = args.update?.value ?? args.create?.value ?? '[]';
      store.set(k, val);
      return { id: k, companyId: args.where.companyId_key.companyId, key: args.where.companyId_key.key, value: val } as any;
    }) as any);

    return store;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([] as any);
    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') {
        return cb(prisma);
      }
      return cb;
    });
  });

  describe('1. Employee Creation & Multi-Terminal Enrollment Mappings', () => {
    it('defaults status to ACTIVE and persists multiple biometricMappings across terminals', async () => {
      const settingStore = createInMemorySettingStore();
      const employeesById = new Map<string, any>();

      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where?.companyId_employeeCode) {
          for (const emp of employeesById.values()) {
            if (
              emp.companyId === args.where.companyId_employeeCode.companyId &&
              emp.employeeCode === args.where.companyId_employeeCode.employeeCode
            ) {
              return emp;
            }
          }
          return null;
        }
        return employeesById.get(args.where?.id) || null;
      }) as any);

      vi.spyOn(prisma.employee, 'create').mockImplementation((async (args: any) => {
        const now = new Date();
        const rec = {
          id: 'emp-created-1',
          ...args.data,
          department: null,
          designation: null,
          shift: null,
          user: null,
          ledger: null,
          salaryRevisions: [],
          _count: { salaryRevisions: 0 },
          createdAt: now,
          updatedAt: now,
        };
        employeesById.set(rec.id, rec);
        return rec;
      }) as any);

      vi.spyOn(prisma.employee, 'update').mockImplementation((async (args: any) => {
        const existing = employeesById.get(args.where.id);
        const updated = { ...existing, ...args.data, updatedAt: new Date() };
        employeesById.set(updated.id, updated);
        return updated;
      }) as any);

      vi.spyOn(prisma.biometricTerminal, 'findMany').mockImplementation((async (args: any) => {
        const ids: string[] | undefined = args?.where?.id?.in;
        const pool = [esslTerminal, secondaryTerminal, betaTerminal].filter(
          (t) => t.companyId === args?.where?.companyId
        );
        return (ids ? pool.filter((t) => ids.includes(t.id)) : pool) as any;
      }) as any);

      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValue([]);

      const created = await EmployeeService.createEmployee(adminActor, {
        employeeCode: 'emp-205',
        fullName: 'Priya Menon',
        dateOfJoining: '2026-10-01',
        biometricMappings: [
          { terminalId: esslTerminal.id, enrollmentId: '205', source: 'EXPLICIT' },
          { terminalId: secondaryTerminal.id, enrollmentId: 'W-205', source: 'DEVICE_SYNC' },
        ],
      });

      expect(created.status).toBe('ACTIVE');
      expect(created.employeeCode).toBe('EMP-205');
      expect(created.biometricDeviceId).toBe('205');
      expect(created.biometricMappings).toHaveLength(2);
      expect(created.biometricMappings?.map((m) => `${m.terminalId}:${m.enrollmentId}`)).toEqual([
        `${esslTerminal.id}:205`,
        `${secondaryTerminal.id}:W-205`,
      ]);

      const rawSetting = settingStore.get(`${companyAlphaId}::${BIOMETRIC_MAPPINGS_SETTING_KEY}`);
      expect(rawSetting).toBeTruthy();
      expect(JSON.parse(rawSetting!)).toHaveLength(2);
    });

    it('supports explicitly creating an employee with status INACTIVE or EXITED', async () => {
      createInMemorySettingStore();
      let storedEmp: any = null;

      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where?.companyId_employeeCode) return null;
        return storedEmp;
      }) as any);
      vi.spyOn(prisma.employee, 'create').mockImplementation((async (args: any) => {
        storedEmp = {
          id: 'emp-inactive-create',
          ...args.data,
          department: null,
          designation: null,
          shift: null,
          user: null,
          ledger: null,
          salaryRevisions: [],
          _count: { salaryRevisions: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return storedEmp;
      }) as any);
      vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([]);

      const created = await EmployeeService.createEmployee(adminActor, {
        employeeCode: '101',
        fullName: 'Arjun Nair',
        dateOfJoining: '2026-09-01',
        status: 'INACTIVE',
      });

      expect(created.status).toBe('INACTIVE');
    });
  });

  describe('2. Duplicate Mapping Rejection & Cross-Tenant Isolation', () => {
    it('rejects duplicate active mapping (409) on same terminal & enrollmentId, but allows different terminal or freed slot', async () => {
      createInMemorySettingStore();

      const empA = { id: 'emp-a', companyId: companyAlphaId, employeeCode: '101', fullName: 'Asha' };
      const empB = { id: 'emp-b', companyId: companyAlphaId, employeeCode: '102', fullName: 'Bala' };

      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where.id === 'emp-a') return empA as any;
        if (args.where.id === 'emp-b') return empB as any;
        return null;
      }) as any);
      vi.spyOn(prisma.employee, 'update').mockResolvedValue(empA as any);
      vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([esslTerminal, secondaryTerminal] as any);

      // Map empA -> (esslTerminal, '101')
      await BiometricMappingService.replaceEmployeeMappings(adminActor, 'emp-a', [
        { terminalId: esslTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
      ]);

      // Attempt duplicate (esslTerminal, '101') on empB -> 409 Conflict
      await expect(
        BiometricMappingService.replaceEmployeeMappings(adminActor, 'emp-b', [
          { terminalId: esslTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
        ])
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("Enrollment ID '101'"),
      });

      // Same enrollmentId '101' on a DIFFERENT terminal for empB IS permitted
      const multiTermMappings = await BiometricMappingService.replaceEmployeeMappings(adminActor, 'emp-b', [
        { terminalId: secondaryTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
      ]);
      expect(multiTermMappings).toHaveLength(1);
      expect(multiTermMappings[0].terminalId).toBe(secondaryTerminal.id);

      // Clear empA's mappings -> now (esslTerminal, '101') is free for empB
      await BiometricMappingService.replaceEmployeeMappings(adminActor, 'emp-a', []);
      const reassigned = await BiometricMappingService.replaceEmployeeMappings(adminActor, 'emp-b', [
        { terminalId: esslTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
      ]);
      expect(reassigned).toHaveLength(1);
      expect(reassigned[0].enrollmentId).toBe('101');
    });

    it('serializes concurrent mapping attempts atomically, rejects duplicate with 409, and acquires FOR UPDATE lock on real tx', async () => {
      createInMemorySettingStore();

      const empA = { id: 'emp-a', companyId: companyAlphaId, employeeCode: '101', fullName: 'Asha' };
      const empB = { id: 'emp-b', companyId: companyAlphaId, employeeCode: '102', fullName: 'Bala' };

      const txQueryRawSpy = vi.fn().mockResolvedValue([]);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        if (typeof cb === 'function') {
          const txClient = {
            $queryRaw: txQueryRawSpy,
            employee: prisma.employee,
            biometricTerminal: prisma.biometricTerminal,
            companySetting: prisma.companySetting,
          };
          return cb(txClient);
        }
        return cb;
      });

      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where.id === 'emp-a') return empA as any;
        if (args.where.id === 'emp-b') return empB as any;
        return null;
      }) as any);
      vi.spyOn(prisma.employee, 'update').mockResolvedValue(empA as any);
      vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([esslTerminal] as any);

      // Fire two concurrent mapping requests for the exact same (terminalId, enrollmentId)
      const [resA, resB] = await Promise.allSettled([
        BiometricMappingService.replaceEmployeeMappings(adminActor, 'emp-a', [
          { terminalId: esslTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
        ]),
        BiometricMappingService.replaceEmployeeMappings(adminActor, 'emp-b', [
          { terminalId: esslTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
        ]),
      ]);

      expect(resA.status).toBe('fulfilled');
      expect(resB.status).toBe('rejected');
      if (resB.status === 'rejected') {
        expect(resB.reason).toMatchObject({
          statusCode: 409,
          message: expect.stringContaining("Enrollment ID '101'"),
        });
      }
      // Verify interactive tx acquired Company FOR UPDATE row lock for each transaction
      expect(txQueryRawSpy).toHaveBeenCalledTimes(2);

      // Verify lock queue released cleanly after 409 rejection: another non-conflicting call succeeds immediately
      const resBValid = await BiometricMappingService.replaceEmployeeMappings(adminActor, 'emp-b', [
        { terminalId: esslTerminal.id, enrollmentId: '102', source: 'EXPLICIT' },
      ]);
      expect(resBValid).toHaveLength(1);
      expect(resBValid[0].enrollmentId).toBe('102');
    });

    it('enforces cross-tenant boundaries for terminals (400) and employees (404)', async () => {
      createInMemorySettingStore();

      const alphaEmp = { id: 'emp-alpha-1', companyId: companyAlphaId, employeeCode: 'E1', fullName: 'Alpha' };
      const betaEmp = { id: 'emp-beta-1', companyId: companyBetaId, employeeCode: 'B1', fullName: 'Beta' };

      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where.id === 'emp-alpha-1') return alphaEmp as any;
        if (args.where.id === 'emp-beta-1') return betaEmp as any;
        return null;
      }) as any);
      // Query filters by actor.companyId so betaTerminal won't be returned
      vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([]);

      await expect(
        BiometricMappingService.replaceEmployeeMappings(adminActor, 'emp-alpha-1', [
          { terminalId: betaTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
        ])
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('invalid or belongs to another company'),
      });

      await expect(
        EmployeeService.activateEmployee(adminActor, 'emp-beta-1')
      ).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe('3. Inactive Employee Policy in Punch Reconciliation', () => {
    it('marks punches for INACTIVE or EXITED employees as IGNORED and never creates Attendance', async () => {
      createInMemorySettingStore();

      const inactiveEmployee = {
        id: 'emp-101',
        companyId: companyAlphaId,
        employeeCode: '101',
        fullName: 'Inactive Employee 101',
        biometricDeviceId: '101',
        status: 'INACTIVE',
        shift: standardShift,
      };

      const rawPunch = {
        id: 'punch-inactive-101',
        companyId: companyAlphaId,
        terminalId: esslTerminal.id,
        userEnrollmentId: '101',
        punchTime: new Date('2026-10-19T03:45:00.000Z'),
        inOutMode: 'CHECK_IN' as const,
        syncStatus: 'PENDING' as const,
        matchedEmployeeId: null,
        matchedEmployee: null,
      };

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValueOnce(rawPunch as any);
      vi.spyOn(prisma.employee, 'findFirst').mockResolvedValueOnce(inactiveEmployee as any);
      const rawUpdateSpy = vi.spyOn(prisma.rawPunchLog, 'update').mockResolvedValue({} as any);
      const attCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const attUpdateSpy = vi.spyOn(prisma.attendance, 'update');

      const result = await PunchReconciliationService.reconcilePunch('punch-inactive-101');

      expect(result.status).toBe('IGNORED');
      expect(result.matchedEmployeeId).toBe('emp-101');
      expect(result.message).toContain('INACTIVE');
      expect(attCreateSpy).not.toHaveBeenCalled();
      expect(attUpdateSpy).not.toHaveBeenCalled();
      expect(rawUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'punch-inactive-101' },
          data: expect.objectContaining({
            syncStatus: 'IGNORED',
            matchedEmployeeId: 'emp-101',
            errorMessage: expect.stringContaining('INACTIVE'),
          }),
        })
      );
    });
  });

  describe('4. End-to-End Scenario: Employee 101 Activation + eSSL X2008 Enrollment 101 + Targeted Reconciliation', () => {
    it('activates Employee 101, maps eSSL X2008 enrollment 101, reconciles ONLY 101 punches idempotently, and leaves 102/103 PENDING', async () => {
      createInMemorySettingStore();

      const emp101: any = {
        id: 'emp-uuid-101',
        companyId: companyAlphaId,
        employeeCode: '101',
        fullName: 'Karthik Rao',
        email: 'karthik@nammamedia.in',
        phone: '9876543210',
        address: null,
        photoUrl: null,
        dateOfBirth: null,
        dateOfJoining: new Date('2026-01-01T00:00:00.000Z'),
        departmentId: null,
        department: null,
        designationId: null,
        designation: null,
        shiftId: standardShift.id,
        shift: standardShift,
        employmentType: 'FULL_TIME',
        status: 'INACTIVE',
        notes: 'Historical onboarding notes preserved',
        biometricDeviceId: null,
        userId: null,
        user: null,
        ledgerId: null,
        ledger: null,
        salaryRevisions: [{ fixedSalary: '35000.00' }],
        _count: { salaryRevisions: 1 },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      };

      const rawPunches: Array<any> = [
        {
          id: 'punch-101-in',
          companyId: companyAlphaId,
          terminalId: esslTerminal.id,
          userEnrollmentId: '101',
          punchTime: new Date('2026-10-19T03:35:00.000Z'), // 09:05 IST -> PRESENT (within 15m grace)
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          matchedEmployeeId: null,
          errorMessage: null,
        },
        {
          id: 'punch-101-out',
          companyId: companyAlphaId,
          terminalId: esslTerminal.id,
          userEnrollmentId: '101',
          punchTime: new Date('2026-10-19T13:00:00.000Z'), // 18:30 IST -> 30m overtime
          inOutMode: 'CHECK_OUT',
          syncStatus: 'ERROR', // previously unmapped error punch should also retry
          matchedEmployeeId: null,
          errorMessage: 'No employee found',
        },
        {
          id: 'punch-102-unmapped',
          companyId: companyAlphaId,
          terminalId: esslTerminal.id,
          userEnrollmentId: '102',
          punchTime: new Date('2026-10-19T03:40:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          matchedEmployeeId: null,
          errorMessage: null,
        },
        {
          id: 'punch-103-unmapped',
          companyId: companyAlphaId,
          terminalId: esslTerminal.id,
          userEnrollmentId: '103',
          punchTime: new Date('2026-10-19T03:42:00.000Z'),
          inOutMode: 'CHECK_IN',
          syncStatus: 'PENDING',
          matchedEmployeeId: null,
          errorMessage: null,
        },
      ];

      const attendanceRecords: any[] = [];

      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where.id === emp101.id) return { ...emp101 };
        return null;
      }) as any);
      vi.spyOn(prisma.employee, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.employee, 'update').mockImplementation((async (args: any) => {
        Object.assign(emp101, args.data, { updatedAt: new Date() });
        return { ...emp101 };
      }) as any);
      vi.spyOn(prisma.biometricTerminal, 'findMany').mockImplementation((async () => [esslTerminal] as any) as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Asia/Kolkata' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.leaveRequest, 'findFirst').mockResolvedValue(null);

      vi.spyOn(prisma.rawPunchLog, 'findMany').mockImplementation((async (args: any) => {
        const where = args?.where || {};
        return rawPunches.filter((p) => {
          if (where.companyId && p.companyId !== where.companyId) return false;
          if (where.terminalId && p.terminalId !== where.terminalId) return false;
          if (where.userEnrollmentId && p.userEnrollmentId !== where.userEnrollmentId) return false;
          if (where.syncStatus) {
            if (typeof where.syncStatus === 'string' && p.syncStatus !== where.syncStatus) return false;
            if (where.syncStatus.in && !where.syncStatus.in.includes(p.syncStatus)) return false;
          }
          return true;
        });
      }) as any);

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockImplementation((async (args: any) => {
        const found = rawPunches.find((p) => p.id === args.where.id);
        if (!found) return null as any;
        return {
          ...found,
          company: { id: companyAlphaId, timezone: 'Asia/Kolkata' },
          terminal: { id: esslTerminal.id, name: esslTerminal.name, location: esslTerminal.location },
          matchedEmployee: found.matchedEmployeeId === emp101.id ? { ...emp101 } : null,
        } as any;
      }) as any);

      vi.spyOn(prisma.rawPunchLog, 'update').mockImplementation((async (args: any) => {
        const found = rawPunches.find((p) => p.id === args.where.id);
        if (found) Object.assign(found, args.data);
        return found as any;
      }) as any);

      vi.spyOn(prisma.attendance, 'findUnique').mockImplementation((async (args: any) => {
        const key = args.where.companyId_employeeId_workDate;
        const found = attendanceRecords.find(
          (a) =>
            a.companyId === key.companyId &&
            a.employeeId === key.employeeId &&
            a.workDate.getTime() === key.workDate.getTime()
        );
        return (found || null) as any;
      }) as any);

      vi.spyOn(prisma.attendance, 'create').mockImplementation((async (args: any) => {
        const created = { id: `att-${attendanceRecords.length + 1}`, ...args.data };
        attendanceRecords.push(created);
        return created as any;
      }) as any);

      vi.spyOn(prisma.attendance, 'update').mockImplementation((async (args: any) => {
        const found = attendanceRecords.find((a) => a.id === args.where.id);
        if (found) Object.assign(found, args.data);
        return found as any;
      }) as any);

      // Step 1: Map eSSL X2008 enrollment 101 while employee is still INACTIVE -> no Attendance created
      const preActivateMap = await EmployeeService.updateEmployeeBiometricMappings(adminActor, emp101.id, [
        { terminalId: esslTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
      ]);
      expect(preActivateMap.employee.biometricMappings).toHaveLength(1);
      expect(attendanceRecords).toHaveLength(0);

      // Step 2: Activate Employee 101 -> safely preserves notes/salary and reconciles ONLY enrollment 101 punches
      const activated = await EmployeeService.activateEmployee(adminActor, emp101.id);
      expect(activated.status).toBe('ACTIVE');
      expect(activated.notes).toBe('Historical onboarding notes preserved');
      expect(activated.currentSalary).toBe('35000.00');

      expect(attendanceRecords).toHaveLength(1);
      expect(attendanceRecords[0]).toMatchObject({
        companyId: companyAlphaId,
        employeeId: emp101.id,
        status: 'PRESENT',
        source: 'BIOMETRIC',
        overtimeMinutes: 30,
      });

      expect(rawPunches.find((p) => p.id === 'punch-101-in')?.syncStatus).toBe('PROCESSED');
      expect(rawPunches.find((p) => p.id === 'punch-101-out')?.syncStatus).toBe('PROCESSED');
      // Crucial invariant: 102 and 103 remain PENDING!
      expect(rawPunches.find((p) => p.id === 'punch-102-unmapped')?.syncStatus).toBe('PENDING');
      expect(rawPunches.find((p) => p.id === 'punch-103-unmapped')?.syncStatus).toBe('PENDING');

      // Step 3: General pending sync counts remaining unmapped 102 & 103 accurately as `pending`
      const syncResult = await PunchReconciliationService.reconcilePendingPunches(
        companyAlphaId,
        { batchSize: 100 },
        adminActor.userId
      );
      expect(syncResult.totalEvaluated).toBe(2);
      expect(syncResult.processed).toBe(0);
      expect(syncResult.pending).toBe(2);
      expect(syncResult.errors).toBe(0);

      // Step 4: Targeted re-run for 101 is completely idempotent (no duplicate attendance)
      const secondRun = await PunchReconciliationService.reconcileForEmployeeMapping(
        companyAlphaId,
        esslTerminal.id,
        '101',
        adminActor.userId
      );
      expect(secondRun.totalEvaluated).toBe(0);
      expect(attendanceRecords).toHaveLength(1);
    });
  });

  describe('5. Hardware User Snapshot Sync & LAN Bridge User Decoder', () => {
    it('never fabricates users when snapshot is empty and surfaces real deviceUsers from heartbeat', async () => {
      const store = createInMemorySettingStore();

      vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([esslTerminal] as any);
      vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValue(esslTerminal as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([]);

      // Before any hardware user sync, deviceUsersByTerminal must be empty (no fabrication)
      const emptyOptions = await BiometricMappingService.getEnrollmentOptionsForCompany(companyAlphaId);
      expect(emptyOptions.deviceUsersByTerminal).toEqual({});

      // Record heartbeat containing real hardware-enrolled user 101 from eSSL X2008
      await BiometricService.recordHeartbeat(
        { id: esslTerminal.id, companyId: companyAlphaId, name: esslTerminal.name },
        {
          firmwareVersion: 'ZLM60_TFT',
          deviceUsers: [
            { uid: 1, enrollmentId: '101', name: 'Karthik Rao', cardNo: '445566' },
            { uid: 2, enrollmentId: '102', name: 'Unmapped Visitor', cardNo: null },
          ],
        }
      );

      expect(store.has(`${companyAlphaId}::${BIOMETRIC_DEVICE_USERS_SETTING_KEY}`)).toBe(true);
      const populatedOptions = await BiometricMappingService.getEnrollmentOptionsForCompany(companyAlphaId);
      expect(populatedOptions.deviceUsersByTerminal[esslTerminal.id]).toHaveLength(2);
      expect(populatedOptions.deviceUsersByTerminal[esslTerminal.id][0]).toMatchObject({
        uid: 1,
        enrollmentId: '101',
        name: 'Karthik Rao',
        cardNo: '445566',
        terminalId: esslTerminal.id,
      });
    });

    it('decodes 72-byte ZLM60_TFT user table packets cleanly in ZKTecoTcpAdapter decoder', () => {
      const rec = Buffer.alloc(72, 0);
      rec.writeUInt16LE(7, 0); // uid = 7
      Buffer.from('Karthik', 'ascii').copy(rec, 11);
      rec.writeUInt32LE(998877, 35); // cardNo
      Buffer.from('101', 'ascii').copy(rec, 48); // enrollment userId = "101"

      const payload = Buffer.alloc(4 + 72);
      payload.writeUInt32LE(72, 0);
      rec.copy(payload, 4);

      const decoded = decodeUserTablePayload(payload);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toEqual({
        uid: 7,
        enrollmentId: '101',
        name: 'Karthik',
        cardNo: '998877',
      });
    });

    it('surfaces dedicated syncDeviceUsers snapshot + telemetry in getEnrollmentOptionsForCompany and maps Employee 101 to real enrollment ID 101', async () => {
      createInMemorySettingStore();

      const employeesById = new Map<string, any>();
      vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([esslTerminal] as any);
      vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValue(esslTerminal as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([]);
      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where?.companyId_employeeCode) return null;
        return employeesById.get(args.where?.id) || null;
      }) as any);
      vi.spyOn(prisma.employee, 'create').mockImplementation((async (args: any) => {
        const created = {
          id: 'emp-101-synced',
          ...args.data,
          department: null,
          designation: null,
          shift: null,
          user: null,
          ledger: null,
          salaryRevisions: [],
          _count: { salaryRevisions: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        employeesById.set(created.id, created);
        return created;
      }) as any);
      vi.spyOn(prisma.employee, 'update').mockImplementation((async (args: any) => {
        const existing = employeesById.get(args.where.id);
        const updated = { ...existing, ...args.data, updatedAt: new Date() };
        employeesById.set(updated.id, updated);
        return updated;
      }) as any);
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValue([]);

      await BiometricService.syncDeviceUsers(
        { id: esslTerminal.id, companyId: companyAlphaId, name: esslTerminal.name, deviceSerialNumber: esslTerminal.deviceSerialNumber },
        {
          discoveredCount: 1,
          deviceUsers: [{ uid: 1, enrollmentId: '101', name: 'Karthik Rao', cardNo: '445566' }],
        }
      );

      const options = await BiometricMappingService.getEnrollmentOptionsForCompany(companyAlphaId);
      expect(options.deviceUsersByTerminal[esslTerminal.id]).toHaveLength(1);
      expect(options.terminals[0].discoveredUserCount).toBe(1);
      expect(options.terminals[0].syncedUserCount).toBe(1);
      expect(options.terminals[0].lastUserSyncAt).toBeTruthy();
      expect(options.terminals[0].lastUserSyncError).toBeNull();

      const created = await EmployeeService.createEmployee(adminActor, {
        employeeCode: '101',
        fullName: 'Karthik Rao',
        dateOfJoining: '2026-10-01',
        biometricMappings: [
          { terminalId: esslTerminal.id, enrollmentId: '101', source: 'DEVICE_SYNC' },
        ],
      });
      expect(created.biometricDeviceId).toBe('101');
      expect(created.biometricMappings?.[0]).toMatchObject({
        terminalId: esslTerminal.id,
        enrollmentId: '101',
        source: 'DEVICE_SYNC',
      });
    });
  });

  describe('6. Express API Routes & RBAC Enforcement', () => {
    it('protects new endpoints against unauthenticated and EMPLOYEE-role callers', async () => {
      const empToken = AuthService.generateSessionToken({
        userId: employeeActor.userId,
        companyId: employeeActor.companyId,
        email: employeeActor.email,
        role: employeeActor.role,
        tokenVersion: employeeActor.tokenVersion,
      });

      expect((await request(app).get('/api/employees/biometric-options')).status).toBe(401);
      expect((await request(app).post('/api/employees/e1/activate')).status).toBe(401);
      expect((await request(app).put('/api/employees/e1/biometric-mappings').send([])).status).toBe(401);
      expect((await request(app).get('/api/biometric/enrollments')).status).toBe(401);

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({ ...employeeActor } as any);
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);

      const empActivate = await request(app)
        .post('/api/employees/e1/activate')
        .set('Authorization', `Bearer ${empToken}`);
      expect(empActivate.status).toBe(403);

      const empMap = await request(app)
        .put('/api/employees/e1/biometric-mappings')
        .set('Authorization', `Bearer ${empToken}`)
        .send({ mappings: [] });
      expect(empMap.status).toBe(403);

      const empEnrollments = await request(app)
        .get('/api/biometric/enrollments')
        .set('Authorization', `Bearer ${empToken}`);
      expect(empEnrollments.status).toBe(403);
    });

    it('serves biometric options, employee activation, mapping updates, enrollments & targeted sync for ADMIN', async () => {
      const adminToken = AuthService.generateSessionToken({
        userId: adminActor.userId,
        companyId: adminActor.companyId,
        email: adminActor.email,
        role: adminActor.role,
        tokenVersion: adminActor.tokenVersion,
      });

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({ ...adminActor } as any);
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);

      vi.spyOn(BiometricMappingService, 'getEnrollmentOptionsForCompany').mockResolvedValueOnce({
        terminals: [],
        deviceUsersByTerminal: {},
        activeMappings: [],
      });
      const optRes = await request(app)
        .get('/api/employees/biometric-options')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(optRes.status).toBe(200);
      expect(optRes.body).toEqual({
        terminals: [],
        deviceUsersByTerminal: {},
        activeMappings: [],
      });

      const fakeEmpItem: any = {
        id: 'emp-101',
        companyId: companyAlphaId,
        employeeCode: '101',
        fullName: 'Karthik',
        status: 'ACTIVE',
        biometricDeviceId: '101',
        biometricMappings: [],
      };
      vi.spyOn(EmployeeService, 'activateEmployee').mockResolvedValueOnce(fakeEmpItem);
      const actRes = await request(app)
        .post('/api/employees/emp-101/activate')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(actRes.status).toBe(200);
      expect(actRes.body.status).toBe('ACTIVE');

      vi.spyOn(EmployeeService, 'updateEmployeeBiometricMappings').mockResolvedValueOnce({
        employee: fakeEmpItem,
        reconciliation: {
          success: true,
          totalEvaluated: 1,
          processed: 1,
          pending: 0,
          ignored: 0,
          errors: 0,
          results: [],
        },
      });
      const mapRes = await request(app)
        .put('/api/employees/emp-101/biometric-mappings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mappings: [{ terminalId: esslTerminal.id, enrollmentId: '101', source: 'EXPLICIT' }],
        });
      expect(mapRes.status).toBe(200);
      expect(mapRes.body.reconciliation.processed).toBe(1);

      vi.spyOn(BiometricMappingService, 'listCompanyMappings').mockResolvedValueOnce([]);
      const enrollRes = await request(app)
        .get('/api/biometric/enrollments')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(enrollRes.status).toBe(200);
      expect(enrollRes.body).toEqual([]);

      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValueOnce({
        id: esslTerminal.id,
      } as any);
      const syncSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches').mockResolvedValueOnce({
        success: true,
        totalEvaluated: 3,
        processed: 1,
        pending: 2,
        ignored: 0,
        errors: 0,
        results: [],
      });
      const syncRes = await request(app)
        .post('/api/biometric/sync')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ terminalId: esslTerminal.id, userEnrollmentId: '101', keepUnmappedPending: true });
      expect(syncRes.status).toBe(200);
      expect(syncRes.body.pending).toBe(2);
      expect(syncSpy).toHaveBeenCalledWith(
        companyAlphaId,
        expect.objectContaining({
          terminalId: esslTerminal.id,
          userEnrollmentId: '101',
          keepUnmappedPending: true,
        }),
        adminActor.userId,
        expect.any(String)
      );
    });
  });

  describe('7. Frontend UI Source Contracts', () => {
    it('replaces plain text biometric input in EmployeesPage.tsx with searchable terminal mapping UI, real device user dropdown, and manual fallback', () => {
      const empSource = fs.readFileSync(
        path.resolve(process.cwd(), 'src/client/pages/EmployeesPage.tsx'),
        'utf-8'
      );
      expect(empSource).toContain('getEmployeeBiometricOptions');
      expect(empSource).toContain('activateEmployee');
      expect(empSource).toContain('Biometric Terminal &amp; Enrollment Mappings');
      expect(empSource).toContain('Search terminal name, model, serial, IP...');
      expect(empSource).toContain('Hardware Enrolled Users');
      expect(empSource).toContain('Refresh Device Users');
      expect(empSource).toContain('Manual Enrollment ID Fallback');
      expect(empSource).toContain('lastUserSyncError');
      expect(empSource).toContain('deactivateTarget');
      expect(empSource).not.toMatch(/window\.confirm|confirm\(/);
    });

    it('renders Pending count and Hardware User Synchronization controls in BiometricDevicesPage.tsx', () => {
      const bioSource = fs.readFileSync(
        path.resolve(process.cwd(), 'src/client/pages/BiometricDevicesPage.tsx'),
        'utf-8'
      );
      expect(bioSource).toContain('syncOutcome.pending ?? 0');
      expect(bioSource).toContain('>Pending<');
      expect(bioSource).toContain('syncBiometricTerminalUsers');
      expect(bioSource).toContain('Sync Device Users');
      expect(bioSource).toContain('Selected terminal');
      expect(bioSource).toContain('Last user sync');
      expect(bioSource).toContain('Users discovered');
      expect(bioSource).toContain('Users synchronized');
      expect(bioSource).toContain('Errors');
    });
  });

  describe('8. P1-3: Today-Only Cutoff on Employee Activation & Biometric Mapping Reconciliation', () => {
    const secondTerminal = {
      id: 'term-essl-secondary',
      companyId: companyAlphaId,
      deviceSerialNumber: 'NFZ8252800999',
      name: 'eSSL X2008 Back Gate',
      terminalModel: 'eSSL X2008',
      ipAddress: '192.168.1.202',
      port: 4370,
      location: 'Back Gate',
      isActive: true,
      status: 'ONLINE' as const,
      lastHeartbeatAt: new Date(),
      lastSyncAt: new Date(),
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    function setupCutoffHarness(options: {
      timezone: string;
      initialStatus: 'ACTIVE' | 'INACTIVE';
      initialMapped?: boolean;
      punches: Array<{
        id: string;
        terminalId?: string;
        userEnrollmentId: string;
        punchTime: Date;
        inOutMode: 'CHECK_IN' | 'CHECK_OUT';
        syncStatus: 'PENDING' | 'ERROR';
        errorMessage?: string | null;
      }>;
    }) {
      const store = createInMemorySettingStore();
      const emp: any = {
        id: 'emp-p13-101',
        companyId: companyAlphaId,
        employeeCode: 'EMP-P13-101',
        fullName: 'Cutoff Test Employee',
        email: 'cutoff@alpha.local',
        phone: null,
        address: null,
        photoUrl: null,
        dateOfBirth: null,
        dateOfJoining: new Date('2026-01-01T00:00:00.000Z'),
        departmentId: null,
        department: null,
        designationId: null,
        designation: null,
        shiftId: standardShift.id,
        shift: standardShift,
        employmentType: 'FULL_TIME',
        status: options.initialStatus,
        notes: null,
        biometricDeviceId: options.initialMapped ? '101' : null,
        userId: null,
        user: null,
        ledgerId: null,
        ledger: null,
        salaryRevisions: [],
        _count: { salaryRevisions: 0 },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      };

      if (options.initialMapped) {
        store.set(
          `${companyAlphaId}::${BIOMETRIC_MAPPINGS_SETTING_KEY}`,
          JSON.stringify([
            {
              id: 'map-p13-101',
              companyId: companyAlphaId,
              employeeId: emp.id,
              terminalId: esslTerminal.id,
              enrollmentId: '101',
              isActive: true,
              source: 'EXPLICIT',
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
            },
          ])
        );
      }

      const rawPunches = options.punches.map((p) => ({
        id: p.id,
        companyId: companyAlphaId,
        terminalId: p.terminalId || esslTerminal.id,
        userEnrollmentId: p.userEnrollmentId,
        punchTime: p.punchTime,
        inOutMode: p.inOutMode,
        syncStatus: p.syncStatus as 'PENDING' | 'ERROR' | 'PROCESSED' | 'IGNORED',
        matchedEmployeeId: null as string | null,
        errorMessage: p.errorMessage ?? null,
      }));

      const attendanceRecords: any[] = [];
      const observedFindManyWheres: any[] = [];

      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);
      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where.id === emp.id) return { ...emp };
        return null;
      }) as any);
      vi.spyOn(prisma.employee, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.employee, 'update').mockImplementation((async (args: any) => {
        Object.assign(emp, args.data, { updatedAt: new Date() });
        return { ...emp };
      }) as any);
      vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([
        esslTerminal,
        secondTerminal,
      ] as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: options.timezone } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.leaveRequest, 'findFirst').mockResolvedValue(null);

      vi.spyOn(prisma.rawPunchLog, 'findMany').mockImplementation((async (args: any) => {
        const where = args?.where || {};
        observedFindManyWheres.push(where);
        return rawPunches
          .filter((p) => {
            if (where.companyId && p.companyId !== where.companyId) return false;
            if (where.terminalId && p.terminalId !== where.terminalId) return false;
            if (where.userEnrollmentId && p.userEnrollmentId !== where.userEnrollmentId) return false;
            if (where.syncStatus) {
              if (typeof where.syncStatus === 'string' && p.syncStatus !== where.syncStatus) return false;
              if (where.syncStatus.in && !where.syncStatus.in.includes(p.syncStatus)) return false;
            }
            if (where.punchTime?.gte) {
              const cutoffMs = new Date(where.punchTime.gte).getTime();
              if (p.punchTime.getTime() < cutoffMs) return false;
            }
            return true;
          })
          .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
      }) as any);

      vi.spyOn(prisma.rawPunchLog, 'findUnique').mockImplementation((async (args: any) => {
        const found = rawPunches.find((p) => p.id === args.where.id);
        if (!found) return null as any;
        const term = found.terminalId === secondTerminal.id ? secondTerminal : esslTerminal;
        return {
          ...found,
          company: { id: companyAlphaId, timezone: options.timezone },
          terminal: { id: term.id, name: term.name, location: term.location },
          matchedEmployee: found.matchedEmployeeId === emp.id ? { ...emp } : null,
        } as any;
      }) as any);

      vi.spyOn(prisma.rawPunchLog, 'update').mockImplementation((async (args: any) => {
        const found = rawPunches.find((p) => p.id === args.where.id);
        if (found) Object.assign(found, args.data);
        return found as any;
      }) as any);

      vi.spyOn(prisma.attendance, 'findUnique').mockImplementation((async (args: any) => {
        const key = args.where.companyId_employeeId_workDate;
        const found = attendanceRecords.find(
          (a) =>
            a.companyId === key.companyId &&
            a.employeeId === key.employeeId &&
            a.workDate.getTime() === key.workDate.getTime()
        );
        return (found || null) as any;
      }) as any);

      vi.spyOn(prisma.attendance, 'create').mockImplementation((async (args: any) => {
        const created = { id: `att-p13-${attendanceRecords.length + 1}`, ...args.data };
        attendanceRecords.push(created);
        return created as any;
      }) as any);

      vi.spyOn(prisma.attendance, 'update').mockImplementation((async (args: any) => {
        const found = attendanceRecords.find((a) => a.id === args.where.id);
        if (found) Object.assign(found, args.data);
        return found as any;
      }) as any);

      return { emp, rawPunches, attendanceRecords, observedFindManyWheres };
    }

    it('employee activation does not implicitly process historical PENDING or ERROR punches while reconciling current-day punches and preserving targeted filters', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-20T12:00:00.000Z'));

      const { emp, rawPunches, attendanceRecords, observedFindManyWheres } = setupCutoffHarness({
        timezone: 'UTC',
        initialStatus: 'INACTIVE',
        initialMapped: true,
        punches: [
          {
            id: 'hist-pending',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-19T09:00:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'hist-error',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-19T18:00:00.000Z'),
            inOutMode: 'CHECK_OUT',
            syncStatus: 'ERROR',
            errorMessage: 'Historical failure',
          },
          {
            id: 'today-in-101',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T09:05:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'today-err-101',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T11:30:00.000Z'),
            inOutMode: 'CHECK_OUT',
            syncStatus: 'ERROR',
            errorMessage: 'Previously unmapped today',
          },
          {
            id: 'today-other-terminal-101',
            terminalId: secondTerminal.id,
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T09:05:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'today-other-enrollment-102',
            userEnrollmentId: '102',
            punchTime: new Date('2026-11-20T09:05:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
        ],
      });

      const activated = await EmployeeService.activateEmployee(adminActor, emp.id);
      expect(activated.status).toBe('ACTIVE');

      // Query strictly enforced tenant, terminal, enrollment, and start-of-today UTC cutoff
      expect(observedFindManyWheres).toHaveLength(1);
      expect(observedFindManyWheres[0]).toMatchObject({
        companyId: companyAlphaId,
        terminalId: esslTerminal.id,
        userEnrollmentId: '101',
        syncStatus: { in: ['PENDING', 'ERROR'] },
      });
      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        '2026-11-20T00:00:00.000Z'
      );

      // Historical PENDING & ERROR punches before cutoff remain completely untouched
      expect(rawPunches.find((p) => p.id === 'hist-pending')?.syncStatus).toBe('PENDING');
      expect(rawPunches.find((p) => p.id === 'hist-error')?.syncStatus).toBe('ERROR');

      // Current-day targeted punches are processed
      expect(rawPunches.find((p) => p.id === 'today-in-101')?.syncStatus).toBe('PROCESSED');
      expect(rawPunches.find((p) => p.id === 'today-err-101')?.syncStatus).toBe('PROCESSED');
      expect(attendanceRecords).toHaveLength(1);

      // Unmapped terminal & other enrollment remain untouched PENDING
      expect(rawPunches.find((p) => p.id === 'today-other-terminal-101')?.syncStatus).toBe('PENDING');
      expect(rawPunches.find((p) => p.id === 'today-other-enrollment-102')?.syncStatus).toBe('PENDING');
    });

    it('biometric mapping update does not implicitly process historical PENDING or ERROR punches while reconciling current-day mapped punches', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-20T14:00:00.000Z'));

      const { emp, rawPunches, observedFindManyWheres } = setupCutoffHarness({
        timezone: 'UTC',
        initialStatus: 'ACTIVE',
        initialMapped: false,
        punches: [
          {
            id: 'map-hist-pending',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-18T09:00:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'map-hist-error',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-19T23:59:59.000Z'),
            inOutMode: 'CHECK_OUT',
            syncStatus: 'ERROR',
            errorMessage: 'Historical error',
          },
          {
            id: 'map-today-pending',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T08:45:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'map-other-terminal',
            terminalId: secondTerminal.id,
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T08:45:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
        ],
      });

      const res = await EmployeeService.updateEmployeeBiometricMappings(adminActor, emp.id, [
        { terminalId: esslTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
      ]);

      expect(res.reconciliation.totalEvaluated).toBe(1);
      expect(res.reconciliation.processed).toBe(1);
      expect(observedFindManyWheres).toHaveLength(1);
      expect(observedFindManyWheres[0]).toMatchObject({
        companyId: companyAlphaId,
        terminalId: esslTerminal.id,
        userEnrollmentId: '101',
      });
      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        '2026-11-20T00:00:00.000Z'
      );

      expect(rawPunches.find((p) => p.id === 'map-hist-pending')?.syncStatus).toBe('PENDING');
      expect(rawPunches.find((p) => p.id === 'map-hist-error')?.syncStatus).toBe('ERROR');
      expect(rawPunches.find((p) => p.id === 'map-today-pending')?.syncStatus).toBe('PROCESSED');
      expect(rawPunches.find((p) => p.id === 'map-other-terminal')?.syncStatus).toBe('PENDING');
    });

    it('calculates Asia/Kolkata (+05:30) cutoff accurately across the UTC date boundary', async () => {
      // 2026-11-20T20:00:00Z is already 2026-11-21 01:30:00 IST -> start of IST today is 2026-11-20T18:30:00.000Z
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-20T20:00:00.000Z'));

      const { emp, rawPunches, observedFindManyWheres } = setupCutoffHarness({
        timezone: 'Asia/Kolkata',
        initialStatus: 'INACTIVE',
        initialMapped: true,
        punches: [
          {
            id: 'ist-yesterday-last-sec',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T18:29:59.000Z'), // 2026-11-20 23:59:59 IST (yesterday local)
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'ist-yesterday-error',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T10:00:00.000Z'), // 2026-11-20 15:30:00 IST (yesterday local)
            inOutMode: 'CHECK_OUT',
            syncStatus: 'ERROR',
            errorMessage: 'Old IST error',
          },
          {
            id: 'ist-today-midnight',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T18:30:00.000Z'), // 2026-11-21 00:00:00 IST (today local)
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'ist-today-0100',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T19:30:00.000Z'), // 2026-11-21 01:00:00 IST (today local)
            inOutMode: 'CHECK_OUT',
            syncStatus: 'PENDING',
          },
        ],
      });

      await EmployeeService.activateEmployee(adminActor, emp.id);

      expect(observedFindManyWheres).toHaveLength(1);
      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        '2026-11-20T18:30:00.000Z'
      );

      expect(rawPunches.find((p) => p.id === 'ist-yesterday-last-sec')?.syncStatus).toBe('PENDING');
      expect(rawPunches.find((p) => p.id === 'ist-yesterday-error')?.syncStatus).toBe('ERROR');
      expect(rawPunches.find((p) => p.id === 'ist-today-midnight')?.syncStatus).toBe('PROCESSED');
      expect(rawPunches.find((p) => p.id === 'ist-today-0100')?.syncStatus).toBe('PROCESSED');
    });

    it('calculates America/New_York (-05:00) cutoff accurately across the UTC date boundary', async () => {
      // 2026-11-21T02:00:00Z is still 2026-11-20 21:00:00 EST -> start of EST today is 2026-11-20T05:00:00.000Z
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-21T02:00:00.000Z'));

      const { emp, rawPunches, observedFindManyWheres } = setupCutoffHarness({
        timezone: 'America/New_York',
        initialStatus: 'ACTIVE',
        initialMapped: false,
        punches: [
          {
            id: 'ny-yesterday-last-sec',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T04:59:59.000Z'), // 2026-11-19 23:59:59 EST (yesterday local)
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'ny-yesterday-error',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-19T16:00:00.000Z'), // 2026-11-19 11:00:00 EST
            inOutMode: 'CHECK_OUT',
            syncStatus: 'ERROR',
            errorMessage: 'Old EST error',
          },
          {
            id: 'ny-today-midnight',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-20T05:00:00.000Z'), // 2026-11-20 00:00:00 EST (today local)
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'ny-today-evening',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-21T01:15:00.000Z'), // 2026-11-20 20:15:00 EST (today local)
            inOutMode: 'CHECK_OUT',
            syncStatus: 'PENDING',
          },
        ],
      });

      const res = await EmployeeService.updateEmployeeBiometricMappings(adminActor, emp.id, [
        { terminalId: esslTerminal.id, enrollmentId: '101', source: 'EXPLICIT' },
      ]);

      expect(res.reconciliation.totalEvaluated).toBe(2);
      expect(res.reconciliation.processed).toBe(2);
      expect(observedFindManyWheres).toHaveLength(1);
      expect(new Date(observedFindManyWheres[0].punchTime.gte).toISOString()).toBe(
        '2026-11-20T05:00:00.000Z'
      );

      expect(rawPunches.find((p) => p.id === 'ny-yesterday-last-sec')?.syncStatus).toBe('PENDING');
      expect(rawPunches.find((p) => p.id === 'ny-yesterday-error')?.syncStatus).toBe('ERROR');
      expect(rawPunches.find((p) => p.id === 'ny-today-midnight')?.syncStatus).toBe('PROCESSED');
      expect(rawPunches.find((p) => p.id === 'ny-today-evening')?.syncStatus).toBe('PROCESSED');
    });

    it('preserves explicitly authorized historical reconciliation when an explicit fromPunchTime is supplied', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-20T12:00:00.000Z'));

      const { rawPunches, observedFindManyWheres } = setupCutoffHarness({
        timezone: 'Asia/Kolkata',
        initialStatus: 'ACTIVE',
        initialMapped: true,
        punches: [
          {
            id: 'explicit-hist-older',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-15T04:00:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'explicit-hist-in-range',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-18T04:00:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
          {
            id: 'explicit-hist-error-in-range',
            userEnrollmentId: '101',
            punchTime: new Date('2026-11-18T12:30:00.000Z'),
            inOutMode: 'CHECK_OUT',
            syncStatus: 'ERROR',
            errorMessage: 'Historical unmapped error',
          },
          {
            id: 'explicit-other-enrollment',
            userEnrollmentId: '102',
            punchTime: new Date('2026-11-18T04:00:00.000Z'),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
          },
        ],
      });

      // Default mapping reconciliation without fromPunchTime skips all historical punches
      const defaultRes = await PunchReconciliationService.reconcileForEmployeeMapping(
        companyAlphaId,
        esslTerminal.id,
        '101',
        adminActor.userId
      );
      expect(defaultRes.totalEvaluated).toBe(0);
      expect(rawPunches.find((p) => p.id === 'explicit-hist-in-range')?.syncStatus).toBe('PENDING');
      expect(rawPunches.find((p) => p.id === 'explicit-hist-error-in-range')?.syncStatus).toBe('ERROR');

      // Explicit administrator historical reconciliation with fromPunchTime processes only punches >= cutoff for this mapping
      const explicitRes = await PunchReconciliationService.reconcileForEmployeeMapping(
        companyAlphaId,
        esslTerminal.id,
        '101',
        adminActor.userId,
        undefined,
        { fromPunchTime: '2026-11-18T00:00:00.000Z' }
      );
      expect(explicitRes.totalEvaluated).toBe(2);
      expect(explicitRes.processed).toBe(2);
      expect(new Date(observedFindManyWheres[1].punchTime.gte).toISOString()).toBe(
        '2026-11-18T00:00:00.000Z'
      );

      expect(rawPunches.find((p) => p.id === 'explicit-hist-older')?.syncStatus).toBe('PENDING');
      expect(rawPunches.find((p) => p.id === 'explicit-hist-in-range')?.syncStatus).toBe('PROCESSED');
      expect(rawPunches.find((p) => p.id === 'explicit-hist-error-in-range')?.syncStatus).toBe('PROCESSED');
      expect(rawPunches.find((p) => p.id === 'explicit-other-enrollment')?.syncStatus).toBe('PENDING');
    });
  });
});

