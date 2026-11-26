import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { EmployeeService } from '../../src/server/services/employee.service.js';
import {
  BIOMETRIC_DEVICE_USERS_SETTING_KEY,
  BIOMETRIC_MAPPINGS_SETTING_KEY,
  BiometricMappingService,
} from '../../src/server/services/biometric-mapping.service.js';
import { WorkPolicyService } from '../../src/server/services/work-policy.service.js';
import { installUnitPrismaGuard } from '../helpers/unit-prisma-guard.js';

describe('Employee Directory & Biometric Options RBAC Regression Tests', () => {
  const app = createApp();

  const COMPANY_A_ID = '11111111-1111-4111-8111-111111111111';
  const COMPANY_B_ID = '99999999-9999-4999-8999-999999999999';

  const EMPLOYEE_USER_ID = '22222222-2222-4222-8222-222222222222';
  const OTHER_EMPLOYEE_USER_ID = '23232323-2323-4232-8232-232323232323';
  const ADMIN_USER_ID = '33333333-3333-4333-8333-333333333333';
  const VICE_ADMIN_USER_ID = '34343434-3434-4343-8343-343434343434';
  const SUPER_ADMIN_USER_ID = '35353535-3535-4353-8353-353535353535';

  const EMP_SELF_ID = '44444444-4444-4444-8444-444444444444';
  const EMP_OTHER_A_ID = '55555555-5555-4555-8555-555555555555';
  const EMP_COMPANY_B_ID = '66666666-6666-4666-8666-666666666666';

  const TERM_A_ID = '71111111-1111-4111-8111-111111111111';
  const TERM_B_ID = '79999999-9999-4999-8999-999999999999';

  const employeeUserRecord = {
    id: EMPLOYEE_USER_ID,
    companyId: COMPANY_A_ID,
    email: 'alice.emp@companya.local',
    fullName: 'Alice Employee',
    role: 'EMPLOYEE' as const,
    isActive: true,
    tokenVersion: 1,
    lastLoginAt: new Date('2026-11-20T09:00:00.000Z'),
  };

  const adminUserRecord = {
    id: ADMIN_USER_ID,
    companyId: COMPANY_A_ID,
    email: 'admin@companya.local',
    fullName: 'Company A Admin',
    role: 'ADMIN' as const,
    isActive: true,
    tokenVersion: 1,
    lastLoginAt: new Date('2026-11-20T09:00:00.000Z'),
  };

  const viceAdminUserRecord = {
    id: VICE_ADMIN_USER_ID,
    companyId: COMPANY_A_ID,
    email: 'viceadmin@companya.local',
    fullName: 'Company A Vice Admin',
    role: 'VICE_ADMIN' as const,
    isActive: true,
    tokenVersion: 1,
    lastLoginAt: new Date('2026-11-20T09:00:00.000Z'),
  };

  const superAdminUserRecord = {
    id: SUPER_ADMIN_USER_ID,
    companyId: COMPANY_A_ID,
    email: 'superadmin@companya.local',
    fullName: 'Company A Super Admin',
    role: 'SUPER_ADMIN' as const,
    isActive: true,
    tokenVersion: 1,
    lastLoginAt: new Date('2026-11-20T09:00:00.000Z'),
  };

  function makePrismaEmployeeRow(overrides: Partial<{
    id: string;
    companyId: string;
    employeeCode: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    userId: string | null;
    salary: string;
    status: 'ACTIVE' | 'INACTIVE' | 'EXITED';
    notes: string | null;
  }> = {}) {
    const id = overrides.id ?? EMP_SELF_ID;
    const companyId = overrides.companyId ?? COMPANY_A_ID;
    const salary = overrides.salary ?? '5000.00';

    return {
      id,
      companyId,
      employeeCode: overrides.employeeCode ?? 'EMP-101',
      fullName: overrides.fullName ?? 'Alice Employee',
      email: overrides.email ?? 'alice.emp@companya.local',
      phone: overrides.phone ?? '+1-555-0101',
      address: '100 Main St',
      photoUrl: null,
      dateOfBirth: new Date('1994-05-10T00:00:00.000Z'),
      dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
      departmentId: null,
      designationId: null,
      shiftId: null,
      dailyWorkingHours: 8,
      monthlyLeaveAllowance: 4,
      employmentType: 'FULL_TIME' as const,
      status: overrides.status ?? ('ACTIVE' as const),
      notes: overrides.notes !== undefined ? overrides.notes : null,
      biometricDeviceId: null,
      userId: overrides.userId !== undefined ? overrides.userId : EMPLOYEE_USER_ID,
      ledgerId: null,
      department: null,
      designation: null,
      shift: null,
      user:
        overrides.userId === null
          ? null
          : { email: overrides.email ?? 'alice.emp@companya.local', isActive: true },
      ledger: null,
      salaryRevisions: [{ fixedSalary: salary }],
      _count: { salaryRevisions: 1 },
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-20T00:00:00.000Z'),
    };
  }

  function makePrismaTerminalRow(overrides: {
    id: string;
    companyId: string;
    deviceSerialNumber: string;
    name: string;
    registeredByUserId: string;
    registeredByName: string;
  }) {
    return {
      id: overrides.id,
      companyId: overrides.companyId,
      deviceSerialNumber: overrides.deviceSerialNumber,
      name: overrides.name,
      terminalModel: 'eSSL X2008',
      ipAddress: overrides.companyId === COMPANY_A_ID ? '192.168.1.50' : '10.99.0.50',
      port: 4370,
      location: overrides.companyId === COMPANY_A_ID ? 'Company A Lobby' : 'Company B Vault',
      apiKeyPrefix: overrides.companyId === COMPANY_A_ID ? 'bio_a01' : 'bio_b99',
      status: 'ONLINE' as const,
      lastHeartbeatAt: null,
      lastSyncAt: null,
      firmwareVersion: null,
      registeredByUserId: overrides.registeredByUserId,
      registeredByUser: { fullName: overrides.registeredByName },
      isActive: true,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
  }

  function issueToken(
    user:
      | typeof employeeUserRecord
      | typeof adminUserRecord
      | typeof viceAdminUserRecord
      | typeof superAdminUserRecord
  ): string {
    return AuthService.generateSessionToken({
      userId: user.id,
      companyId: user.companyId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });
  }

  beforeEach(() => {
    installUnitPrismaGuard();
    AuthService.resetRateLimitsForTesting();

    vi.spyOn(prisma.user, 'findUnique').mockImplementation((async (args: any) => {
      if (args?.where?.id === EMPLOYEE_USER_ID) return employeeUserRecord as any;
      if (args?.where?.id === ADMIN_USER_ID) return adminUserRecord as any;
      if (args?.where?.id === VICE_ADMIN_USER_ID) return viceAdminUserRecord as any;
      if (args?.where?.id === SUPER_ADMIN_USER_ID) return superAdminUserRecord as any;
      return null;
    }) as any);

    vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    AuthService.resetRateLimitsForTesting();
  });

  it('rejects unauthenticated requests to employee read endpoints with HTTP 401 UNAUTHENTICATED', async () => {
    const listServiceSpy = vi.spyOn(EmployeeService, 'listEmployees');
    const prismaFindManySpy = vi.spyOn(prisma.employee, 'findMany');
    const empFindUniqueSpy = vi.spyOn(prisma.employee, 'findUnique');
    const salaryFindManySpy = vi.spyOn(prisma.salaryRevision, 'findMany');
    const optionsSpy = vi.spyOn(BiometricMappingService, 'getEnrollmentOptionsForCompany');
    const terminalFindManySpy = vi.spyOn(prisma.biometricTerminal, 'findMany');

    const listRes = await request(app).get('/api/employees');
    expect(listRes.status).toBe(401);
    expect(listRes.body.error.code).toBe('UNAUTHENTICATED');
    expect(listRes.body.items).toBeUndefined();

    const bioRes = await request(app).get('/api/employees/biometric-options');
    expect(bioRes.status).toBe(401);
    expect(bioRes.body.error.code).toBe('UNAUTHENTICATED');
    expect(bioRes.body.terminals).toBeUndefined();

    const detailRes = await request(app).get(`/api/employees/${EMP_SELF_ID}`);
    expect(detailRes.status).toBe(401);
    expect(detailRes.body.error.code).toBe('UNAUTHENTICATED');
    expect(detailRes.body.id).toBeUndefined();

    const salariesRes = await request(app).get(`/api/employees/${EMP_SELF_ID}/salaries`);
    expect(salariesRes.status).toBe(401);
    expect(salariesRes.body.error.code).toBe('UNAUTHENTICATED');
    expect(Array.isArray(salariesRes.body)).toBe(false);

    expect(listServiceSpy).not.toHaveBeenCalled();
    expect(prismaFindManySpy).not.toHaveBeenCalled();
    expect(empFindUniqueSpy).not.toHaveBeenCalled();
    expect(salaryFindManySpy).not.toHaveBeenCalled();
    expect(optionsSpy).not.toHaveBeenCalled();
    expect(terminalFindManySpy).not.toHaveBeenCalled();
  });

  it('denies authenticated EMPLOYEE access to GET /api/employees with HTTP 403 even when search and foreign companyId query parameters are supplied', async () => {
    const listServiceSpy = vi.spyOn(EmployeeService, 'listEmployees');
    const prismaFindManySpy = vi.spyOn(prisma.employee, 'findMany');
    const prismaCountSpy = vi.spyOn(prisma.employee, 'count');
    const token = issueToken(employeeUserRecord);

    const baseRes = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${token}`);

    expect(baseRes.status).toBe(403);
    expect(baseRes.body.error.code).toBe('FORBIDDEN');
    expect(baseRes.body.items).toBeUndefined();
    expect(baseRes.body.total).toBeUndefined();

    const paramRes = await request(app)
      .get(`/api/employees?search=EMP&status=ACTIVE&companyId=${COMPANY_B_ID}&page=1&limit=50`)
      .set('Authorization', `Bearer ${token}`);

    expect(paramRes.status).toBe(403);
    expect(paramRes.body.error.code).toBe('FORBIDDEN');
    expect(paramRes.body.items).toBeUndefined();
    expect(paramRes.body.total).toBeUndefined();

    expect(listServiceSpy).not.toHaveBeenCalled();
    expect(prismaFindManySpy).not.toHaveBeenCalled();
    expect(prismaCountSpy).not.toHaveBeenCalled();
  });

  it('denies authenticated EMPLOYEE access to GET /api/employees/biometric-options with HTTP 403 and invokes no biometric or database lookups', async () => {
    const optionsSpy = vi.spyOn(BiometricMappingService, 'getEnrollmentOptionsForCompany');
    const terminalFindManySpy = vi.spyOn(prisma.biometricTerminal, 'findMany');
    const settingFindUniqueSpy = vi.spyOn(prisma.companySetting, 'findUnique');
    const token = issueToken(employeeUserRecord);

    const res = await request(app)
      .get(`/api/employees/biometric-options?companyId=${COMPANY_B_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.terminals).toBeUndefined();
    expect(res.body.deviceUsersByTerminal).toBeUndefined();
    expect(res.body.activeMappings).toBeUndefined();

    expect(optionsSpy).not.toHaveBeenCalled();
    expect(terminalFindManySpy).not.toHaveBeenCalled();
    expect(settingFindUniqueSpy).not.toHaveBeenCalled();
  });

  it('denies ADMIN with explicit RolePermission DENY (isGranted: false) for EMPLOYEE:VIEW on GET /api/employees and GET /api/employees/biometric-options', async () => {
    vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
      const key = args?.where?.companyId_role_module_action;
      if (
        key?.companyId === COMPANY_A_ID &&
        key?.role === 'ADMIN' &&
        key?.module === 'EMPLOYEE' &&
        key?.action === 'VIEW'
      ) {
        return { isGranted: false } as any;
      }
      return null;
    }) as any);

    const listServiceSpy = vi.spyOn(EmployeeService, 'listEmployees');
    const prismaFindManySpy = vi.spyOn(prisma.employee, 'findMany');
    const optionsSpy = vi.spyOn(BiometricMappingService, 'getEnrollmentOptionsForCompany');
    const terminalFindManySpy = vi.spyOn(prisma.biometricTerminal, 'findMany');
    const adminToken = issueToken(adminUserRecord);

    const listRes = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(403);
    expect(listRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(listRes.body.items).toBeUndefined();

    const bioRes = await request(app)
      .get('/api/employees/biometric-options')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(bioRes.status).toBe(403);
    expect(bioRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(bioRes.body.terminals).toBeUndefined();

    expect(listServiceSpy).not.toHaveBeenCalled();
    expect(prismaFindManySpy).not.toHaveBeenCalled();
    expect(optionsSpy).not.toHaveBeenCalled();
    expect(terminalFindManySpy).not.toHaveBeenCalled();
  });

  it('denies ADMIN with explicit RolePermission DENY (isGranted: false) for EMPLOYEE:VIEW on GET /api/employees/:id and GET /api/employees/:id/salaries without invoking employee or salary queries', async () => {
    vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
      const key = args?.where?.companyId_role_module_action;
      if (
        key?.companyId === COMPANY_A_ID &&
        key?.role === 'ADMIN' &&
        key?.module === 'EMPLOYEE' &&
        key?.action === 'VIEW'
      ) {
        return { isGranted: false } as any;
      }
      return null;
    }) as any);

    const getByIdServiceSpy = vi.spyOn(EmployeeService, 'getEmployeeById');
    const listSalariesServiceSpy = vi.spyOn(EmployeeService, 'listSalaryRevisions');
    const empFindUniqueSpy = vi.spyOn(prisma.employee, 'findUnique');
    const salaryFindManySpy = vi.spyOn(prisma.salaryRevision, 'findMany');
    const adminToken = issueToken(adminUserRecord);

    const detailRes = await request(app)
      .get(`/api/employees/${EMP_SELF_ID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(detailRes.status).toBe(403);
    expect(detailRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(detailRes.body.error.message).toContain('ADMIN');
    expect(detailRes.body.error.message).toContain('VIEW');
    expect(detailRes.body.error.message).toContain('EMPLOYEE');
    expect(detailRes.body.id).toBeUndefined();

    const salariesRes = await request(app)
      .get(`/api/employees/${EMP_SELF_ID}/salaries`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(salariesRes.status).toBe(403);
    expect(salariesRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(salariesRes.body.error.message).toContain('ADMIN');
    expect(Array.isArray(salariesRes.body)).toBe(false);

    expect(getByIdServiceSpy).not.toHaveBeenCalled();
    expect(listSalariesServiceSpy).not.toHaveBeenCalled();
    expect(empFindUniqueSpy).not.toHaveBeenCalled();
    expect(salaryFindManySpy).not.toHaveBeenCalled();
  });

  it('denies VICE_ADMIN with explicit RolePermission DENY (isGranted: false) for EMPLOYEE:VIEW on GET /api/employees/:id and GET /api/employees/:id/salaries without invoking employee or salary queries', async () => {
    vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
      const key = args?.where?.companyId_role_module_action;
      if (
        key?.companyId === COMPANY_A_ID &&
        key?.role === 'VICE_ADMIN' &&
        key?.module === 'EMPLOYEE' &&
        key?.action === 'VIEW'
      ) {
        return { isGranted: false } as any;
      }
      return null;
    }) as any);

    const getByIdServiceSpy = vi.spyOn(EmployeeService, 'getEmployeeById');
    const listSalariesServiceSpy = vi.spyOn(EmployeeService, 'listSalaryRevisions');
    const empFindUniqueSpy = vi.spyOn(prisma.employee, 'findUnique');
    const salaryFindManySpy = vi.spyOn(prisma.salaryRevision, 'findMany');
    const viceAdminToken = issueToken(viceAdminUserRecord);

    const detailRes = await request(app)
      .get(`/api/employees/${EMP_SELF_ID}`)
      .set('Authorization', `Bearer ${viceAdminToken}`);

    expect(detailRes.status).toBe(403);
    expect(detailRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(detailRes.body.error.message).toContain('VICE_ADMIN');
    expect(detailRes.body.id).toBeUndefined();

    const salariesRes = await request(app)
      .get(`/api/employees/${EMP_SELF_ID}/salaries`)
      .set('Authorization', `Bearer ${viceAdminToken}`);

    expect(salariesRes.status).toBe(403);
    expect(salariesRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    expect(salariesRes.body.error.message).toContain('VICE_ADMIN');
    expect(Array.isArray(salariesRes.body)).toBe(false);

    expect(getByIdServiceSpy).not.toHaveBeenCalled();
    expect(listSalariesServiceSpy).not.toHaveBeenCalled();
    expect(empFindUniqueSpy).not.toHaveBeenCalled();
    expect(salaryFindManySpy).not.toHaveBeenCalled();
  });

  it('retains GET /api/employees/:id and GET /api/employees/:id/salaries access for authorized ADMIN, default VICE_ADMIN, and SUPER_ADMIN', async () => {
    const empRowA1 = makePrismaEmployeeRow({
      id: EMP_SELF_ID,
      companyId: COMPANY_A_ID,
      employeeCode: 'EMP-101',
      fullName: 'Alice Employee',
    });

    vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
      if (args?.where?.id === EMP_SELF_ID) return empRowA1 as any;
      return null;
    }) as any);
    vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
    vi.spyOn(prisma.salaryRevision, 'findMany').mockResolvedValue([
      {
        id: 'sal-rev-1',
        companyId: COMPANY_A_ID,
        employeeId: EMP_SELF_ID,
        fixedSalary: '5000.00',
        effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
        effectiveTo: null,
        revisionReason: 'Initial salary',
        notes: null,
        createdByUserId: ADMIN_USER_ID,
        createdByUser: { fullName: 'Company A Admin' },
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      },
    ] as any);

    const rolePermSpy = vi.spyOn(prisma.rolePermission, 'findUnique');

    for (const actorRecord of [adminUserRecord, viceAdminUserRecord, superAdminUserRecord]) {
      rolePermSpy.mockClear();
      const token = issueToken(actorRecord);

      const detailRes = await request(app)
        .get(`/api/employees/${EMP_SELF_ID}`)
        .set('Authorization', `Bearer ${token}`);

      expect(detailRes.status).toBe(200);
      expect(detailRes.body.id).toBe(EMP_SELF_ID);
      expect(detailRes.body.employeeCode).toBe('EMP-101');

      const salariesRes = await request(app)
        .get(`/api/employees/${EMP_SELF_ID}/salaries`)
        .set('Authorization', `Bearer ${token}`);

      expect(salariesRes.status).toBe(200);
      expect(salariesRes.body).toHaveLength(1);
      expect(salariesRes.body[0].employeeId).toBe(EMP_SELF_ID);
      expect(salariesRes.body[0].fixedSalary).toBe('5000.00');

      if (actorRecord.role === 'SUPER_ADMIN') {
        expect(rolePermSpy).not.toHaveBeenCalled();
      } else {
        expect(rolePermSpy).toHaveBeenCalledTimes(2);
      }
    }
  });

  it('fails closed with HTTP 403 FORBIDDEN_PERMISSION_DENIED on GET /api/employees/:id and GET /api/employees/:id/salaries when RolePermission lookup throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(prisma.rolePermission, 'findUnique').mockRejectedValue(
      new Error('Simulated DB error during permission evaluation')
    );

    const empFindUniqueSpy = vi.spyOn(prisma.employee, 'findUnique');
    const salaryFindManySpy = vi.spyOn(prisma.salaryRevision, 'findMany');
    const adminToken = issueToken(adminUserRecord);

    const detailRes = await request(app)
      .get(`/api/employees/${EMP_SELF_ID}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detailRes.status).toBe(403);
    expect(detailRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');

    const salariesRes = await request(app)
      .get(`/api/employees/${EMP_SELF_ID}/salaries`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(salariesRes.status).toBe(403);
    expect(salariesRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');

    expect(empFindUniqueSpy).not.toHaveBeenCalled();
    expect(salaryFindManySpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('preserves EMPLOYEE self-service access and ignores spoofed identity query parameters on GET /api/employees/self', async () => {
    const selfRow = makePrismaEmployeeRow({
      id: EMP_SELF_ID,
      companyId: COMPANY_A_ID,
      employeeCode: 'EMP-101',
      fullName: 'Alice Employee',
      email: 'alice.emp@companya.local',
      userId: EMPLOYEE_USER_ID,
    });
    const otherRow = makePrismaEmployeeRow({
      id: EMP_OTHER_A_ID,
      companyId: COMPANY_A_ID,
      employeeCode: 'EMP-102',
      fullName: 'Bob Staff',
      email: 'bob.staff@companya.local',
      userId: OTHER_EMPLOYEE_USER_ID,
      salary: '7500.00',
    });

    const empFindUniqueSpy = vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
      if (args?.where?.userId === EMPLOYEE_USER_ID || args?.where?.id === EMP_SELF_ID) {
        return selfRow as any;
      }
      if (args?.where?.userId === OTHER_EMPLOYEE_USER_ID || args?.where?.id === EMP_OTHER_A_ID) {
        return otherRow as any;
      }
      return null;
    }) as any);

    vi.spyOn(BiometricMappingService, 'listMappingsForEmployee').mockResolvedValue([]);
    vi.spyOn(WorkPolicyService, 'listRevisionsForEmployee').mockResolvedValue([]);
    vi.spyOn(WorkPolicyService, 'resolveCompanyTimezone').mockResolvedValue('UTC');
    vi.spyOn(prisma.salaryRevision, 'findMany').mockResolvedValue([
      {
        id: 'sal-rev-1',
        companyId: COMPANY_A_ID,
        employeeId: EMP_SELF_ID,
        fixedSalary: '5000.00',
        effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
        effectiveTo: null,
        revisionReason: 'Initial salary',
        notes: null,
        createdByUserId: ADMIN_USER_ID,
        createdByUser: { fullName: 'Company A Admin' },
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      },
    ] as any);

    const token = issueToken(employeeUserRecord);

    // Attempt identity spoofing via query parameters on /api/employees/self
    const selfRes = await request(app)
      .get(
        `/api/employees/self?userId=${OTHER_EMPLOYEE_USER_ID}&employeeId=${EMP_OTHER_A_ID}&id=${EMP_OTHER_A_ID}&companyId=${COMPANY_B_ID}`
      )
      .set('Authorization', `Bearer ${token}`);

    expect(selfRes.status).toBe(200);
    expect(selfRes.body.id).toBe(EMP_SELF_ID);
    expect(selfRes.body.employeeCode).toBe('EMP-101');
    expect(selfRes.body.companyId).toBe(COMPANY_A_ID);
    expect(JSON.stringify(selfRes.body)).not.toContain('Bob Staff');
    expect(JSON.stringify(selfRes.body)).not.toContain('EMP-102');
    expect(empFindUniqueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: EMPLOYEE_USER_ID },
      })
    );

    const ownByIdRes = await request(app)
      .get(`/api/employees/${EMP_SELF_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(ownByIdRes.status).toBe(200);
    expect(ownByIdRes.body.id).toBe(EMP_SELF_ID);

    const ownSalariesRes = await request(app)
      .get(`/api/employees/${EMP_SELF_ID}/salaries`)
      .set('Authorization', `Bearer ${token}`);

    expect(ownSalariesRes.status).toBe(200);
    expect(ownSalariesRes.body).toHaveLength(1);
    expect(ownSalariesRes.body[0].employeeId).toBe(EMP_SELF_ID);
  });

  it('blocks EMPLOYEE from accessing another employee profile or salary history through self-service endpoints', async () => {
    const selfRow = makePrismaEmployeeRow({
      id: EMP_SELF_ID,
      userId: EMPLOYEE_USER_ID,
    });
    const otherRow = makePrismaEmployeeRow({
      id: EMP_OTHER_A_ID,
      employeeCode: 'EMP-102',
      fullName: 'Bob Staff',
      email: 'bob.staff@companya.local',
      userId: OTHER_EMPLOYEE_USER_ID,
      salary: '7500.00',
    });

    vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
      if (args?.where?.userId === EMPLOYEE_USER_ID || args?.where?.id === EMP_SELF_ID) {
        return selfRow as any;
      }
      if (args?.where?.userId === OTHER_EMPLOYEE_USER_ID || args?.where?.id === EMP_OTHER_A_ID) {
        return otherRow as any;
      }
      return null;
    }) as any);
    vi.spyOn(BiometricMappingService, 'listMappingsForEmployee').mockResolvedValue([]);
    vi.spyOn(WorkPolicyService, 'listRevisionsForEmployee').mockResolvedValue([]);
    vi.spyOn(WorkPolicyService, 'resolveCompanyTimezone').mockResolvedValue('UTC');
    const salaryFindManySpy = vi.spyOn(prisma.salaryRevision, 'findMany');

    const token = issueToken(employeeUserRecord);

    const otherProfileRes = await request(app)
      .get(`/api/employees/${EMP_OTHER_A_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(otherProfileRes.status).toBe(403);
    expect(otherProfileRes.body.error.code).toBe('FORBIDDEN');
    expect(otherProfileRes.body.id).toBeUndefined();
    expect(JSON.stringify(otherProfileRes.body)).not.toContain('Bob Staff');
    expect(JSON.stringify(otherProfileRes.body)).not.toContain('EMP-102');

    const otherSalaryRes = await request(app)
      .get(`/api/employees/${EMP_OTHER_A_ID}/salaries`)
      .set('Authorization', `Bearer ${token}`);

    expect(otherSalaryRes.status).toBe(403);
    expect(otherSalaryRes.body.error.code).toBe('FORBIDDEN');
    expect(salaryFindManySpy).not.toHaveBeenCalled();
  });

  it('retains permitted GET /api/employees directory and biometric-options access for authorized ADMIN', async () => {
    const empRowA1 = makePrismaEmployeeRow({
      id: EMP_SELF_ID,
      companyId: COMPANY_A_ID,
      employeeCode: 'EMP-101',
      fullName: 'Alice Employee',
    });
    const empRowA2 = makePrismaEmployeeRow({
      id: EMP_OTHER_A_ID,
      companyId: COMPANY_A_ID,
      employeeCode: 'EMP-102',
      fullName: 'Bob Staff',
      email: 'bob.staff@companya.local',
      userId: null,
      salary: '6200.00',
    });
    const termA = makePrismaTerminalRow({
      id: TERM_A_ID,
      companyId: COMPANY_A_ID,
      deviceSerialNumber: 'SN-A-001',
      name: 'Front Gate A',
      registeredByUserId: ADMIN_USER_ID,
      registeredByName: 'Company A Admin',
    });

    vi.spyOn(prisma.employee, 'count').mockResolvedValue(2);
    vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([empRowA1, empRowA2] as any);
    vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([termA] as any);
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);

    const adminToken = issueToken(adminUserRecord);

    const listRes = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.total).toBe(2);
    expect(listRes.body.items).toHaveLength(2);
    expect(listRes.body.items.map((e: any) => e.employeeCode)).toEqual(['EMP-101', 'EMP-102']);

    const bioRes = await request(app)
      .get('/api/employees/biometric-options')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(bioRes.status).toBe(200);
    expect(bioRes.body.terminals).toHaveLength(1);
    expect(bioRes.body.terminals[0].id).toBe(TERM_A_ID);
    expect(bioRes.body.terminals[0].companyId).toBe(COMPANY_A_ID);
  });

  it('enforces multi-tenant isolation across two-company datasets for directory, biometric options, and detail lookups even when foreign companyId is passed', async () => {
    // Realistic two-company in-memory dataset: if any query omits companyId filtering,
    // Company B records will be returned and fail the assertions below.
    const companyAEmployees = [
      makePrismaEmployeeRow({
        id: EMP_SELF_ID,
        companyId: COMPANY_A_ID,
        employeeCode: 'EMP-A01',
        fullName: 'Alice CompanyA',
        email: 'alice@companya.local',
        userId: EMPLOYEE_USER_ID,
        salary: '5000.00',
      }),
      makePrismaEmployeeRow({
        id: EMP_OTHER_A_ID,
        companyId: COMPANY_A_ID,
        employeeCode: 'EMP-A02',
        fullName: 'Bob CompanyA',
        email: 'bob@companya.local',
        userId: null,
        salary: '6100.00',
      }),
    ];
    const companyBEmployees = [
      makePrismaEmployeeRow({
        id: EMP_COMPANY_B_ID,
        companyId: COMPANY_B_ID,
        employeeCode: 'EMP-B01',
        fullName: 'Company B Secret Staff',
        email: 'secret@companyb.local',
        userId: null,
        salary: '9999.00',
      }),
    ];
    const allEmployees = [...companyAEmployees, ...companyBEmployees];

    const allTerminals = [
      makePrismaTerminalRow({
        id: TERM_A_ID,
        companyId: COMPANY_A_ID,
        deviceSerialNumber: 'SN-A-001',
        name: 'Company A Gate',
        registeredByUserId: ADMIN_USER_ID,
        registeredByName: 'Company A Admin',
      }),
      makePrismaTerminalRow({
        id: TERM_B_ID,
        companyId: COMPANY_B_ID,
        deviceSerialNumber: 'SN-B-999',
        name: 'Company B Secret Terminal',
        registeredByUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        registeredByName: 'Company B Admin',
      }),
    ];

    const mappingsByCompany: Record<string, any[]> = {
      [COMPANY_A_ID]: [
        {
          id: 'map-a-1',
          companyId: COMPANY_A_ID,
          employeeId: EMP_SELF_ID,
          terminalId: TERM_A_ID,
          enrollmentId: '101',
          isActive: true,
          source: 'EXPLICIT',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      [COMPANY_B_ID]: [
        {
          id: 'map-b-1',
          companyId: COMPANY_B_ID,
          employeeId: EMP_COMPANY_B_ID,
          terminalId: TERM_B_ID,
          enrollmentId: '999',
          isActive: true,
          source: 'EXPLICIT',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    const deviceUsersByCompany: Record<string, Record<string, any[]>> = {
      [COMPANY_A_ID]: {
        [TERM_A_ID]: [
          { uid: 1, enrollmentId: '101', name: 'Alice DeviceUser', cardNo: 'C-A1', syncedAt: '2026-11-20T00:00:00.000Z' },
        ],
      },
      [COMPANY_B_ID]: {
        [TERM_B_ID]: [
          { uid: 9, enrollmentId: '999', name: 'Secret B DeviceUser', cardNo: 'C-B9', syncedAt: '2026-11-20T00:00:00.000Z' },
        ],
      },
    };

    const employeeCountSpy = vi.spyOn(prisma.employee, 'count').mockImplementation((async (args: any) => {
      const targetCompanyId = args?.where?.companyId;
      const matched = targetCompanyId
        ? allEmployees.filter((e) => e.companyId === targetCompanyId)
        : allEmployees;
      return matched.length;
    }) as any);

    const employeeFindManySpy = vi.spyOn(prisma.employee, 'findMany').mockImplementation((async (args: any) => {
      const targetCompanyId = args?.where?.companyId;
      const matched = targetCompanyId
        ? allEmployees.filter((e) => e.companyId === targetCompanyId)
        : allEmployees;
      return matched as any;
    }) as any);

    vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
      return (allEmployees.find((e) => e.id === args?.where?.id) || null) as any;
    }) as any);

    const terminalFindManySpy = vi
      .spyOn(prisma.biometricTerminal, 'findMany')
      .mockImplementation((async (args: any) => {
        const targetCompanyId = args?.where?.companyId;
        const matched = targetCompanyId
          ? allTerminals.filter((t) => t.companyId === targetCompanyId)
          : allTerminals;
        return matched as any;
      }) as any);

    const companySettingSpy = vi
      .spyOn(prisma.companySetting, 'findUnique')
      .mockImplementation((async (args: any) => {
        const { companyId, key } = args?.where?.companyId_key || {};
        if (key === BIOMETRIC_MAPPINGS_SETTING_KEY && mappingsByCompany[companyId]) {
          return {
            companyId,
            key,
            value: JSON.stringify(mappingsByCompany[companyId]),
          } as any;
        }
        if (key === BIOMETRIC_DEVICE_USERS_SETTING_KEY && deviceUsersByCompany[companyId]) {
          return {
            companyId,
            key,
            value: JSON.stringify(deviceUsersByCompany[companyId]),
          } as any;
        }
        return null;
      }) as any);

    const policyFindManySpy = vi
      .spyOn(prisma.employeeWorkPolicyRevision, 'findMany')
      .mockResolvedValue([]);
    vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);

    const adminToken = issueToken(adminUserRecord);

    // 1. Cross-tenant detail and salary lookups return 404 and leak zero Company B fields
    const salaryFindManySpy = vi.spyOn(prisma.salaryRevision, 'findMany');
    const crossTenantRes = await request(app)
      .get(`/api/employees/${EMP_COMPANY_B_ID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(crossTenantRes.status).toBe(404);
    expect(JSON.stringify(crossTenantRes.body)).not.toContain('Company B Secret Staff');
    expect(JSON.stringify(crossTenantRes.body)).not.toContain('EMP-B01');
    expect(JSON.stringify(crossTenantRes.body)).not.toContain('secret@companyb.local');

    const crossTenantSalariesRes = await request(app)
      .get(`/api/employees/${EMP_COMPANY_B_ID}/salaries`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(crossTenantSalariesRes.status).toBe(404);
    expect(JSON.stringify(crossTenantSalariesRes.body)).not.toContain('9999');
    expect(salaryFindManySpy).not.toHaveBeenCalled();

    // 2. Directory list with spoofed foreign companyId returns ONLY Company A employees & mappings
    const listRes = await request(app)
      .get(`/api/employees?companyId=${COMPANY_B_ID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.total).toBe(2);
    expect(listRes.body.items).toHaveLength(2);
    expect(listRes.body.items.map((e: any) => e.employeeCode)).toEqual(['EMP-A01', 'EMP-A02']);
    expect(listRes.body.items.every((e: any) => e.companyId === COMPANY_A_ID)).toBe(true);
    expect(listRes.body.items[0].biometricMappings).toHaveLength(1);
    expect(listRes.body.items[0].biometricMappings[0].terminalId).toBe(TERM_A_ID);

    const listJson = JSON.stringify(listRes.body);
    expect(listJson).not.toContain(COMPANY_B_ID);
    expect(listJson).not.toContain('EMP-B01');
    expect(listJson).not.toContain('Company B Secret Staff');
    expect(listJson).not.toContain('SN-B-999');

    expect(employeeCountSpy).toHaveBeenCalledWith({ where: { companyId: COMPANY_A_ID } });
    expect(employeeFindManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: COMPANY_A_ID },
      })
    );
    expect(policyFindManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: COMPANY_A_ID }),
      })
    );

    // 3. Biometric options with spoofed foreign companyId exercises real BiometricMappingService
    //    and returns ONLY Company A terminals, device users, and active mappings
    const bioRes = await request(app)
      .get(`/api/employees/biometric-options?companyId=${COMPANY_B_ID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(bioRes.status).toBe(200);
    expect(bioRes.body.terminals).toHaveLength(1);
    expect(bioRes.body.terminals[0].id).toBe(TERM_A_ID);
    expect(bioRes.body.terminals[0].companyId).toBe(COMPANY_A_ID);
    expect(bioRes.body.deviceUsersByTerminal[TERM_A_ID]).toHaveLength(1);
    expect(bioRes.body.deviceUsersByTerminal[TERM_B_ID]).toBeUndefined();
    expect(bioRes.body.activeMappings).toHaveLength(1);
    expect(bioRes.body.activeMappings[0]).toMatchObject({
      employeeId: EMP_SELF_ID,
      employeeCode: 'EMP-A01',
      terminalId: TERM_A_ID,
      enrollmentId: '101',
    });

    const bioJson = JSON.stringify(bioRes.body);
    expect(bioJson).not.toContain(COMPANY_B_ID);
    expect(bioJson).not.toContain(TERM_B_ID);
    expect(bioJson).not.toContain('Company B Secret Terminal');
    expect(bioJson).not.toContain('SN-B-999');
    expect(bioJson).not.toContain('Secret B DeviceUser');
    expect(bioJson).not.toContain('EMP-B01');
    expect(bioJson).not.toContain('999');

    // Confirm every terminal, employee, and CompanySetting query was scoped to COMPANY_A_ID and never COMPANY_B_ID
    for (const call of terminalFindManySpy.mock.calls) {
      expect((call[0] as any)?.where?.companyId).toBe(COMPANY_A_ID);
    }
    for (const call of employeeFindManySpy.mock.calls) {
      expect((call[0] as any)?.where?.companyId).toBe(COMPANY_A_ID);
    }
    for (const call of companySettingSpy.mock.calls) {
      expect((call[0] as any)?.where?.companyId_key?.companyId).toBe(COMPANY_A_ID);
    }
  });

  describe('PATCH /api/employees/:id Status Deactivation Permission Enforcement', () => {
    function setupEmployeeStateStore(initialRows: ReturnType<typeof makePrismaEmployeeRow>[]) {
      const store = new Map(initialRows.map((row) => [row.id, { ...row }]));

      const findUniqueSpy = vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args?.where?.id) {
          const found = store.get(args.where.id);
          return (found ? { ...found } : null) as any;
        }
        return null;
      }) as any);
      findUniqueSpy.mockClear();

      const updateSpy = vi.spyOn(prisma.employee, 'update').mockImplementation((async (args: any) => {
        const existing = store.get(args?.where?.id);
        if (!existing) {
          throw new Error(`Unexpected employee.update for missing id=${args?.where?.id}`);
        }
        const next = { ...existing, ...args.data };
        store.set(existing.id, next);
        return { ...next } as any;
      }) as any);
      updateSpy.mockClear();

      const transactionSpy = vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => {
        return cb(prisma);
      }) as any);
      transactionSpy.mockClear();

      const workPolicyTxSpy = vi.spyOn(WorkPolicyService, 'applyWorkPolicyUpdateTx');
      workPolicyTxSpy.mockClear();
      const biometricReplaceSpy = vi.spyOn(BiometricMappingService, 'replaceEmployeeMappings');
      biometricReplaceSpy.mockClear();
      const auditLogSpy = vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as any);
      auditLogSpy.mockClear();
      const auditCreateSpy = vi.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as any);
      auditCreateSpy.mockClear();

      vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([]);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockResolvedValue([]);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);

      return {
        store,
        findUniqueSpy,
        updateSpy,
        transactionSpy,
        workPolicyTxSpy,
        biometricReplaceSpy,
        auditLogSpy,
        auditCreateSpy,
      };
    }

    it('denies ADMIN with EMPLOYEE:EDIT allowed and EMPLOYEE:DEACTIVATE explicitly denied across all deactivation and lateral transitions and combined payloads with zero writes', async () => {
      vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
        const key = args?.where?.companyId_role_module_action;
        if (
          key?.companyId === COMPANY_A_ID &&
          key?.role === 'ADMIN' &&
          key?.module === 'EMPLOYEE' &&
          key?.action === 'DEACTIVATE'
        ) {
          return { isGranted: false } as any;
        }
        return null;
      }) as any);

      const adminToken = issueToken(adminUserRecord);
      const transitions: Array<{ from: 'ACTIVE' | 'INACTIVE' | 'EXITED'; to: 'INACTIVE' | 'EXITED'; payload?: Record<string, unknown> }> = [
        { from: 'ACTIVE', to: 'INACTIVE' },
        { from: 'ACTIVE', to: 'EXITED' },
        { from: 'INACTIVE', to: 'EXITED' },
        { from: 'EXITED', to: 'INACTIVE' },
        {
          from: 'ACTIVE',
          to: 'INACTIVE',
          payload: {
            fullName: 'Renamed During Denied Deactivation',
            phone: '+1-555-9999',
            notes: 'Must not persist',
            dailyWorkingHours: 7.5,
            biometricMappings: [{ terminalId: TERM_A_ID, enrollmentId: '101', isActive: true }],
          },
        },
      ];

      for (const tc of transitions) {
        const spies = setupEmployeeStateStore([
          makePrismaEmployeeRow({ id: EMP_OTHER_A_ID, status: tc.from, userId: null }),
        ]);

        const res = await request(app)
          .patch(`/api/employees/${EMP_OTHER_A_ID}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ ...(tc.payload || {}), status: tc.to });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
        expect(res.body.error.message).toContain('ADMIN');
        expect(res.body.error.message).toContain('DEACTIVATE');
        expect(res.body.error.message).toContain('EMPLOYEE');
        expect(res.body.error.timestamp).toBeTruthy();

        // Zero writes of any kind occurred
        expect(spies.updateSpy).not.toHaveBeenCalled();
        expect(spies.transactionSpy).not.toHaveBeenCalled();
        expect(spies.workPolicyTxSpy).not.toHaveBeenCalled();
        expect(spies.biometricReplaceSpy).not.toHaveBeenCalled();
        expect(spies.auditLogSpy).not.toHaveBeenCalled();
        expect(spies.auditCreateSpy).not.toHaveBeenCalled();
        expect(spies.store.get(EMP_OTHER_A_ID)?.status).toBe(tc.from);
      }
    });

    it('denies VICE_ADMIN with EMPLOYEE:EDIT granted and EMPLOYEE:DEACTIVATE denied across all deactivation and lateral transitions and combined payloads with zero writes', async () => {
      vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
        const key = args?.where?.companyId_role_module_action;
        if (key?.companyId === COMPANY_A_ID && key?.role === 'VICE_ADMIN' && key?.module === 'EMPLOYEE') {
          if (key.action === 'EDIT') return { isGranted: true } as any;
          if (key.action === 'DEACTIVATE') return { isGranted: false } as any;
        }
        return null;
      }) as any);

      const viceAdminToken = issueToken(viceAdminUserRecord);
      const transitions: Array<{ from: 'ACTIVE' | 'INACTIVE' | 'EXITED'; to: 'INACTIVE' | 'EXITED'; combined?: boolean }> = [
        { from: 'ACTIVE', to: 'INACTIVE' },
        { from: 'ACTIVE', to: 'EXITED' },
        { from: 'INACTIVE', to: 'EXITED' },
        { from: 'EXITED', to: 'INACTIVE' },
        { from: 'ACTIVE', to: 'EXITED', combined: true },
      ];

      for (const tc of transitions) {
        const spies = setupEmployeeStateStore([
          makePrismaEmployeeRow({ id: EMP_OTHER_A_ID, status: tc.from, userId: null }),
        ]);

        const body = tc.combined
          ? {
              phone: '+1-555-8888',
              notes: 'Combined update should abort atomically',
              dailyWorkingHours: 7,
              biometricMappings: [{ terminalId: TERM_A_ID, enrollmentId: '102', isActive: true }],
              status: tc.to,
            }
          : { status: tc.to };

        const res = await request(app)
          .patch(`/api/employees/${EMP_OTHER_A_ID}`)
          .set('Authorization', `Bearer ${viceAdminToken}`)
          .send(body);

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
        expect(res.body.error.message).toContain('VICE_ADMIN');
        expect(res.body.error.message).toContain('DEACTIVATE');

        expect(spies.updateSpy).not.toHaveBeenCalled();
        expect(spies.transactionSpy).not.toHaveBeenCalled();
        expect(spies.workPolicyTxSpy).not.toHaveBeenCalled();
        expect(spies.biometricReplaceSpy).not.toHaveBeenCalled();
        expect(spies.auditLogSpy).not.toHaveBeenCalled();
        expect(spies.auditCreateSpy).not.toHaveBeenCalled();
        expect(spies.store.get(EMP_OTHER_A_ID)?.status).toBe(tc.from);
      }
    });

    it('allows deactivation and lateral transitions with audit logging for authorized ADMIN, explicitly granted VICE_ADMIN, and SUPER_ADMIN', async () => {
      const rolePermSpy = vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
        const key = args?.where?.companyId_role_module_action;
        if (key?.companyId === COMPANY_A_ID && key?.role === 'VICE_ADMIN' && key?.module === 'EMPLOYEE') {
          if (key.action === 'EDIT' || key.action === 'DEACTIVATE') {
            return { isGranted: true } as any;
          }
        }
        return null;
      }) as any);

      const cases: Array<{
        actor: typeof adminUserRecord | typeof viceAdminUserRecord | typeof superAdminUserRecord;
        from: 'ACTIVE' | 'INACTIVE' | 'EXITED';
        to: 'INACTIVE' | 'EXITED';
      }> = [
        { actor: adminUserRecord, from: 'ACTIVE', to: 'INACTIVE' },
        { actor: adminUserRecord, from: 'ACTIVE', to: 'EXITED' },
        { actor: viceAdminUserRecord, from: 'INACTIVE', to: 'EXITED' },
        { actor: superAdminUserRecord, from: 'EXITED', to: 'INACTIVE' },
      ];

      for (const tc of cases) {
        rolePermSpy.mockClear();
        const spies = setupEmployeeStateStore([
          makePrismaEmployeeRow({ id: EMP_OTHER_A_ID, status: tc.from, userId: null }),
        ]);

        const token = issueToken(tc.actor);
        const res = await request(app)
          .patch(`/api/employees/${EMP_OTHER_A_ID}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ status: tc.to });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe(tc.to);
        expect(spies.updateSpy).toHaveBeenCalledTimes(1);
        expect(spies.auditLogSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            companyId: COMPANY_A_ID,
            action: 'EMPLOYEE_DEACTIVATE',
            entity: 'Employee',
            entityId: EMP_OTHER_A_ID,
            details: expect.objectContaining({
              status: tc.to,
              previousStatus: tc.from,
            }),
          })
        );

        if (tc.actor.role === 'SUPER_ADMIN') {
          expect(rolePermSpy).not.toHaveBeenCalled();
        }
      }
    });

    it('allows EDIT-only user (DEACTIVATE denied) to update unrelated fields with unchanged INACTIVE, EXITED, or ACTIVE status', async () => {
      const rolePermSpy = vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
        const key = args?.where?.companyId_role_module_action;
        if (
          key?.companyId === COMPANY_A_ID &&
          key?.role === 'ADMIN' &&
          key?.module === 'EMPLOYEE' &&
          key?.action === 'DEACTIVATE'
        ) {
          return { isGranted: false } as any;
        }
        return null;
      }) as any);

      const adminToken = issueToken(adminUserRecord);

      for (const unchangedStatus of ['INACTIVE', 'EXITED', 'ACTIVE'] as const) {
        rolePermSpy.mockClear();
        const spies = setupEmployeeStateStore([
          makePrismaEmployeeRow({
            id: EMP_OTHER_A_ID,
            status: unchangedStatus,
            phone: '+1-555-0101',
            notes: 'Old note',
            userId: null,
          }),
        ]);

        const res = await request(app)
          .patch(`/api/employees/${EMP_OTHER_A_ID}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            phone: '+1-555-7777',
            notes: `Updated while ${unchangedStatus}`,
            status: unchangedStatus,
          });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe(unchangedStatus);
        expect(res.body.phone).toBe('+1-555-7777');
        expect(res.body.notes).toBe(`Updated while ${unchangedStatus}`);
        expect(spies.updateSpy).toHaveBeenCalledTimes(1);
        expect(spies.auditLogSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'EMPLOYEE_UPDATE',
            entityId: EMP_OTHER_A_ID,
          })
        );

        // DEACTIVATE permission was never queried for unchanged status
        const queriedDeactivate = rolePermSpy.mock.calls.some(
          (c) => (c[0] as any)?.where?.companyId_role_module_action?.action === 'DEACTIVATE'
        );
        expect(queriedDeactivate).toBe(false);
      }
    });

    it('preserves EMPLOYEE denial, dedicated activate/deactivate endpoints, and cross-tenant/nonexistent 404 isolation', async () => {
      // 1. EMPLOYEE cannot edit or deactivate even if RolePermission overrides exist
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue({ isGranted: true } as any);
      const empSpies = setupEmployeeStateStore([
        makePrismaEmployeeRow({ id: EMP_SELF_ID, status: 'ACTIVE', userId: EMPLOYEE_USER_ID }),
      ]);
      const empToken = issueToken(employeeUserRecord);

      const empPatchRes = await request(app)
        .patch(`/api/employees/${EMP_SELF_ID}`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ status: 'INACTIVE' });
      expect(empPatchRes.status).toBe(403);
      expect(empPatchRes.body.error.code).toBe('FORBIDDEN');

      const empDeactRes = await request(app)
        .post(`/api/employees/${EMP_SELF_ID}/deactivate`)
        .set('Authorization', `Bearer ${empToken}`);
      expect(empDeactRes.status).toBe(403);
      expect(empSpies.updateSpy).not.toHaveBeenCalled();
      expect(empSpies.auditLogSpy).not.toHaveBeenCalled();

      // 2. Dedicated POST /deactivate respects explicit DENY and preserves authorized behavior;
      //    POST /activate continues to work with EDIT only.
      vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
        const key = args?.where?.companyId_role_module_action;
        if (
          key?.companyId === COMPANY_A_ID &&
          key?.role === 'ADMIN' &&
          key?.module === 'EMPLOYEE' &&
          key?.action === 'DEACTIVATE'
        ) {
          return { isGranted: false } as any;
        }
        return null;
      }) as any);

      const adminToken = issueToken(adminUserRecord);
      const deniedSpies = setupEmployeeStateStore([
        makePrismaEmployeeRow({ id: EMP_OTHER_A_ID, status: 'ACTIVE', userId: null }),
        makePrismaEmployeeRow({ id: EMP_COMPANY_B_ID, companyId: COMPANY_B_ID, status: 'ACTIVE', userId: null }),
      ]);

      const deniedDedicatedDeact = await request(app)
        .post(`/api/employees/${EMP_OTHER_A_ID}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(deniedDedicatedDeact.status).toBe(403);
      expect(deniedDedicatedDeact.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
      expect(deniedSpies.updateSpy).not.toHaveBeenCalled();

      // Cross-tenant and nonexistent IDs preserve 404 consistently
      const foreignPatchRes = await request(app)
        .patch(`/api/employees/${EMP_COMPANY_B_ID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'INACTIVE' });
      expect(foreignPatchRes.status).toBe(404);
      expect(foreignPatchRes.body.error.code).toBe('EMPLOYEE_NOT_FOUND');

      const missingPatchRes = await request(app)
        .patch('/api/employees/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'EXITED' });
      expect(missingPatchRes.status).toBe(404);
      expect(missingPatchRes.body.error.code).toBe('EMPLOYEE_NOT_FOUND');
      expect(deniedSpies.updateSpy).not.toHaveBeenCalled();
      expect(deniedSpies.auditLogSpy).not.toHaveBeenCalled();

      // Authorized POST /activate succeeds for EDIT-only ADMIN on INACTIVE employee
      const activateSpies = setupEmployeeStateStore([
        makePrismaEmployeeRow({ id: EMP_OTHER_A_ID, status: 'INACTIVE', userId: null }),
      ]);
      const activateRes = await request(app)
        .post(`/api/employees/${EMP_OTHER_A_ID}/activate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(activateRes.status).toBe(200);
      expect(activateRes.body.status).toBe('ACTIVE');
      expect(activateSpies.auditLogSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'EMPLOYEE_ACTIVATE', entityId: EMP_OTHER_A_ID })
      );

      // Authorized POST /deactivate succeeds when DEACTIVATE is permitted (default ADMIN)
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
      const deactSpies = setupEmployeeStateStore([
        makePrismaEmployeeRow({ id: EMP_OTHER_A_ID, status: 'ACTIVE', userId: null }),
      ]);
      const allowedDedicatedDeact = await request(app)
        .post(`/api/employees/${EMP_OTHER_A_ID}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(allowedDedicatedDeact.status).toBe(200);
      expect(allowedDedicatedDeact.body.status).toBe('INACTIVE');
      expect(deactSpies.auditLogSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'EMPLOYEE_DEACTIVATE', entityId: EMP_OTHER_A_ID })
      );
    });

    it('fails closed with HTTP 403 FORBIDDEN_PERMISSION_DENIED and zero writes when RolePermission lookup throws during DEACTIVATE check', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
        const key = args?.where?.companyId_role_module_action;
        if (key?.action === 'DEACTIVATE') {
          throw new Error('Simulated DB connectivity failure during DEACTIVATE check');
        }
        return null;
      }) as any);

      const spies = setupEmployeeStateStore([
        makePrismaEmployeeRow({ id: EMP_OTHER_A_ID, status: 'ACTIVE', userId: null }),
      ]);
      const adminToken = issueToken(adminUserRecord);

      const res = await request(app)
        .patch(`/api/employees/${EMP_OTHER_A_ID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ phone: '+1-555-0000', status: 'INACTIVE' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
      expect(spies.updateSpy).not.toHaveBeenCalled();
      expect(spies.transactionSpy).not.toHaveBeenCalled();
      expect(spies.workPolicyTxSpy).not.toHaveBeenCalled();
      expect(spies.biometricReplaceSpy).not.toHaveBeenCalled();
      expect(spies.auditLogSpy).not.toHaveBeenCalled();
      expect(spies.auditCreateSpy).not.toHaveBeenCalled();
      expect(spies.store.get(EMP_OTHER_A_ID)?.status).toBe('ACTIVE');

      consoleErrorSpy.mockRestore();
    });

    it('preserves service-level FORBIDDEN_PERMISSION_DENIED with ISO timestamp in EmployeeController.deactivate() while keeping EMPLOYEE_DEACTIVATE_FAILED for other errors', async () => {
      // Simulate permission passing route middleware, then being revoked before service check
      let deactivatePermCalls = 0;
      vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async (args: any) => {
        const key = args?.where?.companyId_role_module_action;
        if (
          key?.companyId === COMPANY_A_ID &&
          key?.role === 'ADMIN' &&
          key?.module === 'EMPLOYEE' &&
          key?.action === 'DEACTIVATE'
        ) {
          deactivatePermCalls += 1;
          return (deactivatePermCalls === 1 ? null : { isGranted: false }) as any;
        }
        return null;
      }) as any);

      const spies = setupEmployeeStateStore([
        makePrismaEmployeeRow({ id: EMP_OTHER_A_ID, status: 'ACTIVE', userId: null }),
      ]);
      const adminToken = issueToken(adminUserRecord);

      const permDeniedRes = await request(app)
        .post(`/api/employees/${EMP_OTHER_A_ID}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(deactivatePermCalls).toBe(2);
      expect(permDeniedRes.status).toBe(403);
      expect(permDeniedRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
      expect(permDeniedRes.body.error.message).toContain('ADMIN');
      expect(permDeniedRes.body.error.message).toContain('DEACTIVATE');
      expect(permDeniedRes.body.error.message).toContain('EMPLOYEE');
      expect(typeof permDeniedRes.body.error.timestamp).toBe('string');
      expect(Number.isNaN(Date.parse(permDeniedRes.body.error.timestamp))).toBe(false);
      expect(spies.updateSpy).not.toHaveBeenCalled();
      expect(spies.auditLogSpy).not.toHaveBeenCalled();

      // Non-permission errors (e.g., 404 not found) still return EMPLOYEE_DEACTIVATE_FAILED
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
      const notFoundRes = await request(app)
        .post('/api/employees/00000000-0000-4000-8000-000000000000/deactivate')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.body.error.code).toBe('EMPLOYEE_DEACTIVATE_FAILED');
      expect(notFoundRes.body.error.timestamp).toBeUndefined();
    });
  });
});
