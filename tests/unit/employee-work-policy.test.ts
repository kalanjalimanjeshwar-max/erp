import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../src/server/db/client.js';
import { EmployeeService } from '../../src/server/services/employee.service.js';
import { CompanyService } from '../../src/server/services/company.service.js';
import { WorkPolicyService } from '../../src/server/services/work-policy.service.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { AuthUser } from '../../src/shared/types.js';

describe('EmployeeService - Work Policy Integration & Safeguards', () => {
  const companyId = 'comp-emp-wp-1';
  const otherCompanyId = 'comp-emp-wp-2';
  const adminActor: AuthUser = {
    id: 'user-admin-1',
    userId: 'user-admin-1',
    companyId,
    email: 'admin@alpha.local',
    fullName: 'HR Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };
  const empActor: AuthUser = {
    id: 'user-emp-1',
    userId: 'user-emp-1',
    companyId,
    email: 'emp@alpha.local',
    fullName: 'Ravi Kumar',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([]);
  });

  it('creates initial EmployeeWorkPolicyRevision on createEmployee without modifying SalaryRevision logic or triggering reconciliation', async () => {
    const revRows: any[] = [];
    const salaryRows: any[] = [];
    let createdEmp: any = null;

    vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
      if (args.where?.companyId_employeeCode) return null;
      return createdEmp;
    }) as any);

    vi.spyOn(prisma.shift, 'findUnique').mockResolvedValue({
      id: 'shift-1',
      companyId,
      code: 'STD',
      name: 'Standard',
      startTime: '09:00',
      endTime: '17:00',
      isOvernight: false,
      graceMinutes: 15,
    } as any);

    vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);

    vi.spyOn(prisma.employee, 'create').mockImplementation((async ({ data }: any) => {
      createdEmp = {
        id: 'emp-new-1',
        ...data,
        department: null,
        designation: null,
        shift: {
          id: 'shift-1',
          code: 'STD',
          name: 'Standard',
          startTime: '09:00',
          endTime: '17:00',
          isOvernight: false,
        },
        user: null,
        ledger: null,
        salaryRevisions: [],
        _count: { salaryRevisions: data.initialSalary ? 1 : 0 },
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      };
      return createdEmp;
    }) as any);

    vi.spyOn(prisma.employeeWorkPolicyRevision, 'create').mockImplementation((async ({ data }: any) => {
      const r = {
        id: `rev-${revRows.length + 1}`,
        ...data,
        shift: createdEmp.shift,
        createdByUser: { fullName: adminActor.fullName },
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      };
      revRows.push(r);
      return r;
    }) as any);

    vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockImplementation((async () => revRows) as any);
    vi.spyOn(prisma.salaryRevision, 'create').mockImplementation((async ({ data }: any) => {
      salaryRows.push(data);
      createdEmp.salaryRevisions = [{ fixedSalary: data.fixedSalary }];
      createdEmp._count = { salaryRevisions: 1 };
      return data;
    }) as any);
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
    const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcileForEmployeeMapping');

    const emp = await EmployeeService.createEmployee(adminActor, {
      employeeCode: 'EMP-301',
      fullName: 'Ravi Kumar',
      dateOfJoining: '2026-10-01',
      shiftId: 'shift-1',
      dailyWorkingHours: 7.5,
      monthlyLeaveAllowance: 5,
      initialSalary: 45000,
    });

    expect(revRows).toHaveLength(1);
    expect(revRows[0].dailyWorkingHours).toBe(7.5);
    expect(revRows[0].monthlyLeaveAllowance).toBe(5);
    expect(revRows[0].effectiveTo).toBeNull();
    expect(salaryRows).toHaveLength(1);
    expect(emp.configuredDailyWorkingHours).toBe(7.5);
    expect(emp.monthlyLeaveAllowance).toBe(5);
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('updates dailyWorkingHours on selected effectiveFrom without triggering reconciliation or modifying SalaryRevision', async () => {
    const revRows: any[] = [
      {
        id: 'rev-1',
        companyId,
        employeeId: 'emp-1',
        shiftId: null,
        shift: null,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        revisionReason: 'Initial',
        notes: null,
        createdByUserId: adminActor.id,
        createdByUser: { fullName: adminActor.fullName },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];

    const empRecord: any = {
      id: 'emp-1',
      companyId,
      employeeCode: 'EMP-101',
      fullName: 'Ravi Kumar',
      email: 'emp@alpha.local',
      phone: null,
      address: null,
      photoUrl: null,
      dateOfBirth: null,
      dateOfJoining: new Date('2026-01-01T00:00:00.000Z'),
      departmentId: null,
      designationId: null,
      department: null,
      designation: null,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      notes: null,
      biometricDeviceId: null,
      userId: empActor.id,
      user: { email: 'emp@alpha.local', isActive: true },
      ledgerId: null,
      ledger: null,
      shiftId: null,
      shift: null,
      dailyWorkingHours: 8,
      monthlyLeaveAllowance: 4,
      salaryRevisions: [{ fixedSalary: 30000 }],
      _count: { salaryRevisions: 1 },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(empRecord);
    vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
    vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);

    vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockImplementation((async () =>
      revRows.slice().sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())
    ) as any);
    vi.spyOn(prisma.employeeWorkPolicyRevision, 'update').mockImplementation((async ({ where, data }: any) => {
      const idx = revRows.findIndex((r) => r.id === where.id);
      revRows[idx] = { ...revRows[idx], ...data };
      return revRows[idx];
    }) as any);
    vi.spyOn(prisma.employeeWorkPolicyRevision, 'deleteMany').mockImplementation((async ({ where }: any) => {
      const gte = where?.effectiveFrom?.gte;
      for (let i = revRows.length - 1; i >= 0; i--) {
        if (!gte || revRows[i].effectiveFrom.getTime() >= gte.getTime()) revRows.splice(i, 1);
      }
      return { count: 1 } as any;
    }) as any);
    vi.spyOn(prisma.employeeWorkPolicyRevision, 'create').mockImplementation((async ({ data }: any) => {
      const rec = {
        id: `rev-${revRows.length + 1}`,
        ...data,
        shift: null,
        createdByUser: { fullName: adminActor.fullName },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      revRows.push(rec);
      return rec;
    }) as any);
    vi.spyOn(prisma.employee, 'update').mockImplementation((async ({ data }: any) => {
      Object.assign(empRecord, data);
      return empRecord;
    }) as any);

    const salaryUpdateSpy = vi.spyOn(prisma.salaryRevision, 'create');
    const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcileForEmployeeMapping');

    const updated = await EmployeeService.updateEmployee(adminActor, 'emp-1', {
      dailyWorkingHours: 7,
      policyEffectiveFrom: '2026-11-10',
    });

    expect(updated.configuredDailyWorkingHours).toBe(7);
    expect(revRows).toHaveLength(2);
    expect(revRows[0].effectiveTo.toISOString().split('T')[0]).toBe('2026-11-09');
    expect(revRows[1].effectiveFrom.toISOString().split('T')[0]).toBe('2026-11-10');
    expect(Number(revRows[1].dailyWorkingHours)).toBe(7);
    expect(salaryUpdateSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('enforces tenant isolation and blocks EMPLOYEE from creating work policy revisions', async () => {
    await expect(
      EmployeeService.createWorkPolicyRevision(empActor, 'emp-1', { dailyWorkingHours: 6 })
    ).rejects.toThrow(/not authorized/i);

    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      id: 'emp-other',
      companyId: otherCompanyId,
      userId: 'other-user',
    } as any);

    await expect(EmployeeService.listWorkPolicyRevisions(adminActor, 'emp-other')).rejects.toThrow(
      /not found in this company/i
    );
  });

  it('propagates a valid later policyEffectiveFrom into initial revision without creating an earlier revision (direct service)', async () => {
    const revRows: any[] = [];
    let createdEmp: any = null;

    vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
      if (args.where?.companyId_employeeCode) return null;
      return createdEmp;
    }) as any);
    vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.employee, 'create').mockImplementation((async ({ data }: any) => {
      createdEmp = {
        id: 'emp-p14-svc-1',
        ...data,
        department: null,
        designation: null,
        shift: null,
        user: null,
        ledger: null,
        salaryRevisions: [],
        _count: { salaryRevisions: 0 },
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      };
      return createdEmp;
    }) as any);
    vi.spyOn(prisma.employeeWorkPolicyRevision, 'create').mockImplementation((async ({ data }: any) => {
      const r = {
        id: `rev-svc-${revRows.length + 1}`,
        ...data,
        shift: null,
        createdByUser: { fullName: adminActor.fullName },
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      };
      revRows.push(r);
      return r;
    }) as any);
    vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockImplementation((async () => revRows) as any);

    await EmployeeService.createEmployee(adminActor, {
      employeeCode: 'EMP-P14-SVC',
      fullName: 'Direct Service Later Policy',
      dateOfJoining: '2026-10-01',
      policyEffectiveFrom: '2026-11-01',
      dailyWorkingHours: 8,
      monthlyLeaveAllowance: 5,
    });

    expect(revRows).toHaveLength(1);
    expect(revRows[0].effectiveFrom.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(revRows[0].effectiveTo).toBeNull();
  });

  it('rejects policyEffectiveFrom earlier than dateOfJoining in direct EmployeeService.createEmployee call with status 400', async () => {
    const txSpy = vi.spyOn(prisma, '$transaction');

    await expect(
      EmployeeService.createEmployee(adminActor, {
        employeeCode: 'EMP-P14-SVC-BAD',
        fullName: 'Invalid Earlier Policy',
        dateOfJoining: '2026-10-10',
        policyEffectiveFrom: '2026-10-01',
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 5,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/cannot be earlier than employee date of joining/i),
    });

    expect(txSpy).not.toHaveBeenCalled();
  });

  describe('Decision 1 (P1-2): Service-Layer Company-Permitted Monthly Leave Allowance Enforcement', () => {
    const buildExistingEmployee = (overrides: Record<string, any> = {}) => ({
      id: 'emp-p12-1',
      companyId,
      employeeCode: 'EMP-P12',
      fullName: 'Asha Nair',
      email: 'asha@alpha.local',
      phone: '9999999999',
      address: null,
      photoUrl: null,
      dateOfBirth: null,
      dateOfJoining: new Date('2026-01-01T00:00:00.000Z'),
      departmentId: null,
      designationId: null,
      department: null,
      designation: null,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      notes: null,
      biometricDeviceId: null,
      userId: null,
      user: null,
      ledgerId: null,
      ledger: null,
      shiftId: null,
      shift: null,
      dailyWorkingHours: 8,
      monthlyLeaveAllowance: 4,
      salaryRevisions: [{ fixedSalary: 35000 }],
      _count: { salaryRevisions: 1 },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    });

    const mockCompanyPermittedAllowances = (values: number[] | null) => {
      vi.spyOn(prisma.companySetting, 'findUnique').mockImplementation((async (args: any) => {
        if (args?.where?.companyId_key?.key === 'PERMITTED_MONTHLY_LEAVE_ALLOWANCES_V1') {
          if (values === null) return null;
          return {
            companyId,
            key: 'PERMITTED_MONTHLY_LEAVE_ALLOWANCES_V1',
            value: JSON.stringify(values),
          };
        }
        return null;
      }) as any);
    };

    const setupCreateEmployeeMocks = () => {
      const revRows: any[] = [];
      let createdEmp: any = null;

      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where?.companyId_employeeCode) return null;
        return createdEmp;
      }) as any);
      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.employee, 'create').mockImplementation((async ({ data }: any) => {
        createdEmp = {
          ...buildExistingEmployee({ id: 'emp-p12-created', ...data }),
          salaryRevisions: [],
          _count: { salaryRevisions: 0 },
        };
        return createdEmp;
      }) as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'create').mockImplementation((async ({ data }: any) => {
        const r = {
          id: `rev-p12-${revRows.length + 1}`,
          ...data,
          shift: null,
          createdByUser: { fullName: adminActor.fullName },
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        };
        revRows.push(r);
        return r;
      }) as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockImplementation((async () => revRows) as any);

      return { revRows };
    };

    const setupPolicyRevisionMocks = (empRecord: any) => {
      const revRows: any[] = [
        {
          id: 'rev-p12-init',
          companyId,
          employeeId: empRecord.id,
          shiftId: null,
          shift: null,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: empRecord.monthlyLeaveAllowance,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          effectiveTo: null,
          revisionReason: 'Initial',
          notes: null,
          createdByUserId: adminActor.id,
          createdByUser: { fullName: adminActor.fullName },
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ];

      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(empRecord);
      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockImplementation((async () =>
        revRows.slice().sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())
      ) as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'update').mockImplementation((async ({ where, data }: any) => {
        const idx = revRows.findIndex((r) => r.id === where.id);
        revRows[idx] = { ...revRows[idx], ...data };
        return revRows[idx];
      }) as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'deleteMany').mockImplementation((async ({ where }: any) => {
        const gte = where?.effectiveFrom?.gte;
        for (let i = revRows.length - 1; i >= 0; i--) {
          if (!gte || revRows[i].effectiveFrom.getTime() >= gte.getTime()) revRows.splice(i, 1);
        }
        return { count: 1 } as any;
      }) as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'create').mockImplementation((async ({ data }: any) => {
        const rec = {
          id: `rev-p12-${revRows.length + 1}`,
          ...data,
          shift: null,
          createdByUser: { fullName: adminActor.fullName },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        revRows.push(rec);
        return rec;
      }) as any);
      vi.spyOn(prisma.employee, 'update').mockImplementation((async ({ data }: any) => {
        Object.assign(empRecord, data);
        return empRecord;
      }) as any);

      return { revRows };
    };

    it('createEmployee rejects omitted monthlyLeaveAllowance when default 4 is disallowed by company policy [5, 6]', async () => {
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(null);
      mockCompanyPermittedAllowances([5, 6]);
      const txSpy = vi.spyOn(prisma, '$transaction');

      await expect(
        EmployeeService.createEmployee(adminActor, {
          employeeCode: 'EMP-P12-OMIT',
          fullName: 'Omitted Allowance',
          dateOfJoining: '2026-10-01',
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/Monthly leave allowance is required because the default \(4 days\) is not permitted.*5, 6 days/i),
      });

      expect(txSpy).not.toHaveBeenCalled();
    });

    it('createEmployee rejects explicit null monthlyLeaveAllowance with status 400', async () => {
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(null);
      mockCompanyPermittedAllowances([4, 5, 6]);
      const txSpy = vi.spyOn(prisma, '$transaction');

      await expect(
        EmployeeService.createEmployee(adminActor, {
          employeeCode: 'EMP-P12-NULL',
          fullName: 'Null Allowance',
          dateOfJoining: '2026-10-01',
          monthlyLeaveAllowance: null,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/cannot be null/i),
      });

      expect(txSpy).not.toHaveBeenCalled();
    });

    it('createEmployee rejects disallowed integer monthlyLeaveAllowance (4 under [5, 6] and 3 under default [4, 5, 6])', async () => {
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(null);
      const txSpy = vi.spyOn(prisma, '$transaction');

      mockCompanyPermittedAllowances([5, 6]);
      await expect(
        EmployeeService.createEmployee(adminActor, {
          employeeCode: 'EMP-P12-FOUR',
          fullName: 'Disallowed Four',
          dateOfJoining: '2026-10-01',
          monthlyLeaveAllowance: 4,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/must be one of the company-permitted options: 5, 6 days/i),
      });

      mockCompanyPermittedAllowances(null);
      await expect(
        EmployeeService.createEmployee(adminActor, {
          employeeCode: 'EMP-P12-THREE',
          fullName: 'Disallowed Three',
          dateOfJoining: '2026-10-01',
          monthlyLeaveAllowance: 3,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/must be one of the company-permitted options: 4, 5, 6 days/i),
      });

      expect(txSpy).not.toHaveBeenCalled();
    });

    it('createEmployee accepts permitted values under restricted policy [5, 6] and preserves default [4, 5, 6] when setting is absent', async () => {
      const { revRows } = setupCreateEmployeeMocks();
      mockCompanyPermittedAllowances([5, 6]);

      const createdWithRestricted = await EmployeeService.createEmployee(adminActor, {
        employeeCode: 'EMP-P12-OK5',
        fullName: 'Permitted Five',
        dateOfJoining: '2026-10-01',
        monthlyLeaveAllowance: 5,
      });

      expect(createdWithRestricted.monthlyLeaveAllowance).toBe(5);
      expect(revRows[0].monthlyLeaveAllowance).toBe(5);

      mockCompanyPermittedAllowances(null);
      const createdWithDefaultOmitted = await EmployeeService.createEmployee(adminActor, {
        employeeCode: 'EMP-P12-DEF4',
        fullName: 'Default Omitted',
        dateOfJoining: '2026-10-01',
      });

      expect(createdWithDefaultOmitted.monthlyLeaveAllowance).toBe(4);
    });

    it('updateEmployee rejects explicit null and disallowed integer monthlyLeaveAllowance before starting a transaction', async () => {
      const empRecord = buildExistingEmployee();
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(empRecord as any);
      mockCompanyPermittedAllowances([5, 6]);
      const txSpy = vi.spyOn(prisma, '$transaction');

      await expect(
        EmployeeService.updateEmployee(adminActor, empRecord.id, {
          monthlyLeaveAllowance: null,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/cannot be null/i),
      });

      await expect(
        EmployeeService.updateEmployee(adminActor, empRecord.id, {
          monthlyLeaveAllowance: 4,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/must be one of the company-permitted options: 5, 6 days/i),
      });

      expect(txSpy).not.toHaveBeenCalled();
    });

    it('updateEmployee allows permitted allowance [6] and preserves unrelated updates omitting monthlyLeaveAllowance', async () => {
      const empRecord = buildExistingEmployee();
      const { revRows } = setupPolicyRevisionMocks(empRecord);
      mockCompanyPermittedAllowances([5, 6]);
      const getPermittedSpy = vi.spyOn(CompanyService, 'getPermittedMonthlyLeaveAllowances');

      const renamed = await EmployeeService.updateEmployee(adminActor, empRecord.id, {
        fullName: 'Asha Nair Updated',
      });

      expect(renamed.fullName).toBe('Asha Nair Updated');
      expect(getPermittedSpy).not.toHaveBeenCalled();

      await EmployeeService.updateEmployee(adminActor, empRecord.id, {
        monthlyLeaveAllowance: 6,
      });

      expect(getPermittedSpy).toHaveBeenCalledWith(companyId);
      expect(revRows.some((r) => Number(r.monthlyLeaveAllowance) === 6)).toBe(true);
    });

    it('createWorkPolicyRevision rejects explicit null and disallowed integer monthlyLeaveAllowance before transaction', async () => {
      const empRecord = buildExistingEmployee();
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(empRecord as any);
      mockCompanyPermittedAllowances([5, 6]);
      const txSpy = vi.spyOn(prisma, '$transaction');

      await expect(
        EmployeeService.createWorkPolicyRevision(adminActor, empRecord.id, {
          monthlyLeaveAllowance: null,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/cannot be null/i),
      });

      await expect(
        EmployeeService.createWorkPolicyRevision(adminActor, empRecord.id, {
          monthlyLeaveAllowance: 4,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/must be one of the company-permitted options: 5, 6 days/i),
      });

      expect(txSpy).not.toHaveBeenCalled();
    });

    it('createWorkPolicyRevision accepts permitted allowance [5] and allows dailyWorkingHours-only revision omitting monthlyLeaveAllowance', async () => {
      const empRecord = buildExistingEmployee();
      const { revRows } = setupPolicyRevisionMocks(empRecord);
      mockCompanyPermittedAllowances([5, 6]);
      const getPermittedSpy = vi.spyOn(CompanyService, 'getPermittedMonthlyLeaveAllowances');

      const hoursOnlyResult = await EmployeeService.createWorkPolicyRevision(adminActor, empRecord.id, {
        dailyWorkingHours: 7,
        effectiveFrom: '2026-11-10',
      });

      expect(hoursOnlyResult.workPolicyEffectiveFrom).toBe('2026-11-10');
      expect(getPermittedSpy).not.toHaveBeenCalled();

      const allowanceResult = await EmployeeService.createWorkPolicyRevision(adminActor, empRecord.id, {
        monthlyLeaveAllowance: 5,
      });

      expect(allowanceResult.allowanceEffectiveFrom).toBeTruthy();
      expect(getPermittedSpy).toHaveBeenCalledWith(companyId);
      expect(revRows.some((r) => Number(r.monthlyLeaveAllowance) === 5)).toBe(true);
    });

    it('keeps WorkPolicyService.validateMonthlyLeaveAllowance [0, 31] range validation unchanged', () => {
      expect(WorkPolicyService.validateMonthlyLeaveAllowance(0)).toBe(0);
      expect(WorkPolicyService.validateMonthlyLeaveAllowance(3)).toBe(3);
      expect(WorkPolicyService.validateMonthlyLeaveAllowance(31)).toBe(31);
      expect(WorkPolicyService.validateMonthlyLeaveAllowance(null)).toBeNull();
      expect(() => WorkPolicyService.validateMonthlyLeaveAllowance(-1)).toThrow(/between 0 and 31/i);
      expect(() => WorkPolicyService.validateMonthlyLeaveAllowance(32)).toThrow(/between 0 and 31/i);
    });
  });
});


