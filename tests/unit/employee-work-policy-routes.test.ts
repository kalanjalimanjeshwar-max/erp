import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { EmployeeService } from '../../src/server/services/employee.service.js';
import {
  CompanyService,
  PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY,
} from '../../src/server/services/company.service.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { AuthUser, Role } from '../../src/shared/types.js';

describe('Employee APIs, Work Policy Endpoints, RBAC, Tenant Isolation & CompanySetting Allowance', () => {
  const app = createApp();
  const companyA = '11111111-1111-1111-1111-111111111111';
  const companyB = '22222222-2222-2222-2222-222222222222';

  const makeUser = (role: Role, companyId: string, suffix: string): AuthUser => ({
    id: `user-${suffix}`,
    userId: `user-${suffix}`,
    companyId,
    email: `${suffix}@corp.local`,
    fullName: `${role} ${suffix}`,
    role,
    isActive: true,
    tokenVersion: 1,
  });

  const adminA = makeUser('ADMIN', companyA, 'admin-a');
  const superAdminA = makeUser('SUPER_ADMIN', companyA, 'super-a');
  const viceAdminA = makeUser('VICE_ADMIN', companyA, 'vice-a');
  const empA1 = makeUser('EMPLOYEE', companyA, 'emp-a1');
  const empA2 = makeUser('EMPLOYEE', companyA, 'emp-a2');

  const authenticateAs = (user: AuthUser) => {
    vi.spyOn(AuthService, 'verifySessionToken').mockReturnValue({
      userId: user.id,
      email: user.email,
      companyId: user.companyId,
      role: user.role,
      tokenVersion: user.tokenVersion,
      exp: Date.now() + 60_000,
    });
    vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValue(user);
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('1. Authentication & RBAC on /api/employees/:id/work-policies', () => {
    it('returns 401 UNAUTHENTICATED without a session', async () => {
      const getRes = await request(app).get('/api/employees/emp-1/work-policies');
      expect(getRes.status).toBe(401);

      const postRes = await request(app)
        .post('/api/employees/emp-1/work-policies')
        .send({ dailyWorkingHours: 8 });
      expect(postRes.status).toBe(401);
    });

    it('allows EMPLOYEE to read only their own work-policy history and blocks reading another employee (403)', async () => {
      authenticateAs(empA1);

      const ownEmployee = {
        id: 'emp-a1',
        companyId: companyA,
        userId: empA1.id,
      };
      const siblingEmployee = {
        id: 'emp-a2',
        companyId: companyA,
        userId: empA2.id,
      };

      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async ({ where }: any) => {
        if (where.id === 'emp-a1') return ownEmployee;
        if (where.id === 'emp-a2') return siblingEmployee;
        return null;
      }) as any);

      vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockResolvedValue([
        {
          id: 'rev-own-1',
          companyId: companyA,
          employeeId: 'emp-a1',
          shiftId: null,
          shift: null,
          dailyWorkingHours: 7.5,
          monthlyLeaveAllowance: 4,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          effectiveTo: null,
          revisionReason: 'Initial baseline',
          notes: null,
          createdByUserId: adminA.id,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ] as any);

      const ownRes = await request(app)
        .get('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token');

      expect(ownRes.status).toBe(200);
      expect(ownRes.body).toHaveLength(1);
      expect(ownRes.body[0].effectiveDailyWorkingHours).toBe(7.5);
      expect(ownRes.body[0].effectiveMonthlyLeaveAllowance).toBe(4);

      const otherRes = await request(app)
        .get('/api/employees/emp-a2/work-policies')
        .set('Authorization', 'Bearer valid-token');

      expect(otherRes.status).toBe(403);
      expect(otherRes.body.error.code).toBe('FORBIDDEN');
    });

    it('requires EMPLOYEE:VIEW permission for non-employee users to read work-policy history', async () => {
      authenticateAs(viceAdminA);

      // Simulate RolePermission override denying EMPLOYEE:VIEW to VICE_ADMIN
      vi.spyOn(prisma.rolePermission, 'findUnique').mockImplementation((async ({ where }: any) => {
        const key = where?.companyId_role_module_action;
        if (key?.role === 'VICE_ADMIN' && key?.module === 'EMPLOYEE' && key?.action === 'VIEW') {
          return { isGranted: false } as any;
        }
        return null;
      }) as any);

      const findEmpSpy = vi.spyOn(prisma.employee, 'findUnique');

      const deniedRes = await request(app)
        .get('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token');

      expect(deniedRes.status).toBe(403);
      expect(deniedRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
      expect(findEmpSpy).not.toHaveBeenCalled();

      // Default VICE_ADMIN has EMPLOYEE:VIEW -> 200
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
        id: 'emp-a1',
        companyId: companyA,
        userId: empA1.id,
      } as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockResolvedValue([]);

      const allowedRes = await request(app)
        .get('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token');

      expect(allowedRes.status).toBe(200);
      expect(allowedRes.body).toEqual([]);
    });

    it('requires EMPLOYEE:EDIT permission for creating work-policy revisions and always blocks EMPLOYEE role', async () => {
      // VICE_ADMIN lacks EMPLOYEE:EDIT
      authenticateAs(viceAdminA);
      const vicePostRes = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ dailyWorkingHours: 8 });
      expect(vicePostRes.status).toBe(403);
      expect(vicePostRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');

      // EMPLOYEE role is blocked EVEN IF a RolePermission override grants EMPLOYEE:EDIT
      authenticateAs(empA1);
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue({ isGranted: true } as any);
      const empPostRes = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ dailyWorkingHours: 8 });
      expect(empPostRes.status).toBe(403);
      expect(empPostRes.body.error.code).toBe('FORBIDDEN');

      // EMPLOYEE role is also blocked on create/update employee endpoints
      const empCreateRes = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({ employeeCode: 'E999', fullName: 'Test', dateOfJoining: '2026-01-01' });
      expect(empCreateRes.status).toBe(403);

      const empPatchRes = await request(app)
        .patch('/api/employees/emp-a1')
        .set('Authorization', 'Bearer valid-token')
        .send({ fullName: 'Hack Name' });
      expect(empPatchRes.status).toBe(403);
    });
  });

  describe('2. Tenant Isolation Without Existence Leaks', () => {
    it('returns identical 404 EMPLOYEE_NOT_FOUND for foreign-company and nonexistent employees on work-policy routes', async () => {
      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async ({ where }: any) => {
        if (where.id === 'emp-company-b') {
          return {
            id: 'emp-company-b',
            companyId: companyB,
            userId: 'user-b1',
          } as any;
        }
        return null;
      }) as any);

      // Admin from company A
      authenticateAs(adminA);
      const foreignGet = await request(app)
        .get('/api/employees/emp-company-b/work-policies')
        .set('Authorization', 'Bearer valid-token');
      const missingGet = await request(app)
        .get('/api/employees/emp-nonexistent/work-policies')
        .set('Authorization', 'Bearer valid-token');

      expect(foreignGet.status).toBe(404);
      expect(missingGet.status).toBe(404);
      expect(foreignGet.body.error).toEqual(missingGet.body.error);

      const foreignPost = await request(app)
        .post('/api/employees/emp-company-b/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ dailyWorkingHours: 8 });
      const missingPost = await request(app)
        .post('/api/employees/emp-nonexistent/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ dailyWorkingHours: 8 });

      expect(foreignPost.status).toBe(404);
      expect(missingPost.status).toBe(404);
      expect(foreignPost.body.error).toEqual(missingPost.body.error);

      // Employee from company A requesting company B employee gets 404 (never 403 leak)
      authenticateAs(empA1);
      const empForeignGet = await request(app)
        .get('/api/employees/emp-company-b/work-policies')
        .set('Authorization', 'Bearer valid-token');
      expect(empForeignGet.status).toBe(404);
      expect(empForeignGet.body.error).toEqual(missingGet.body.error);
    });

    it('rejects shifts belonging to another company without leaking shift existence', async () => {
      authenticateAs(adminA);

      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
        id: 'emp-a1',
        companyId: companyA,
        dateOfJoining: new Date('2026-01-01T00:00:00.000Z'),
        shiftId: null,
      } as any);
      vi.spyOn(prisma.shift, 'findUnique').mockImplementation((async ({ where }: any) => {
        if (where.id === 'shift-company-b') {
          return { id: 'shift-company-b', companyId: companyB } as any;
        }
        return null;
      }) as any);

      const foreignShiftRes = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ shiftId: 'shift-company-b', effectiveFrom: '2026-11-10' });

      const missingShiftRes = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ shiftId: 'shift-missing', effectiveFrom: '2026-11-10' });

      expect(foreignShiftRes.status).toBe(400);
      expect(missingShiftRes.status).toBe(400);
      expect(foreignShiftRes.body.error.message).toBe(missingShiftRes.body.error.message);
    });
  });

  describe('3. Validation Rules, Optional Shift, and Company-Permitted Allowances', () => {
    it('allows creating employee and work-policy revision with explicit dailyWorkingHours and NO shiftId', async () => {
      authenticateAs(adminA);

      const createSpy = vi.spyOn(EmployeeService, 'createEmployee').mockResolvedValue({
        id: 'emp-new-1',
        companyId: companyA,
        employeeCode: 'EMP-401',
        fullName: 'No Shift Worker',
        email: null,
        phone: null,
        address: null,
        photoUrl: null,
        dateOfBirth: null,
        dateOfJoining: '2026-10-01',
        departmentId: null,
        designationId: null,
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        notes: null,
        biometricDeviceId: null,
        userId: null,
        ledgerId: null,
        shiftId: null,
        configuredDailyWorkingHours: 7.5,
        dailyWorkingHours: 7.5,
        monthlyLeaveAllowance: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const createRes = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-401',
          fullName: 'No Shift Worker',
          dateOfJoining: '2026-10-01',
          dailyWorkingHours: 7.5,
          monthlyLeaveAllowance: 5,
          shiftId: null,
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.shiftId).toBeNull();
      expect(createRes.body.dailyWorkingHours).toBe(7.5);
      expect(createSpy).toHaveBeenCalledTimes(1);

      const policyRevSpy = vi.spyOn(EmployeeService, 'createWorkPolicyRevision').mockResolvedValue({
        employee: createRes.body,
        revisions: [],
        workPolicyEffectiveFrom: '2026-11-10',
        allowanceEffectiveFrom: null,
      });

      const revRes = await request(app)
        .post('/api/employees/emp-new-1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({
          dailyWorkingHours: 9,
          effectiveFrom: '2026-11-10',
        });

      expect(revRes.status).toBe(201);
      expect(revRes.body.workPolicyEffectiveFrom).toBe('2026-11-10');
      expect(policyRevSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid input types, out-of-range numbers, and invalid calendar dates with 400 VALIDATION_ERROR', async () => {
      authenticateAs(adminA);

      // Invalid calendar date (Feb 30) on create
      const badDateCreate = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-402',
          fullName: 'Bad Date',
          dateOfJoining: '2026-02-30',
        });
      expect(badDateCreate.status).toBe(400);
      expect(badDateCreate.body.error.code).toBe('VALIDATION_ERROR');

      // Wrong type for dailyWorkingHours (string instead of number)
      const badHoursType = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-403',
          fullName: 'Bad Hours Type',
          dateOfJoining: '2026-10-01',
          dailyWorkingHours: '8',
        });
      expect(badHoursType.status).toBe(400);
      expect(badHoursType.body.error.code).toBe('VALIDATION_ERROR');

      // Out-of-range dailyWorkingHours (> 24 or <= 0)
      const badHoursRange = await request(app)
        .patch('/api/employees/emp-a1')
        .set('Authorization', 'Bearer valid-token')
        .send({ dailyWorkingHours: 25 });
      expect(badHoursRange.status).toBe(400);

      const zeroHours = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ dailyWorkingHours: 0 });
      expect(zeroHours.status).toBe(400);

      // Invalid policyEffectiveFrom calendar date on update
      const badEffUpdate = await request(app)
        .patch('/api/employees/emp-a1')
        .set('Authorization', 'Bearer valid-token')
        .send({ dailyWorkingHours: 8, policyEffectiveFrom: '2026-13-01' });
      expect(badEffUpdate.status).toBe(400);

      // Empty body on work-policies
      const emptyPolicyPost = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({});
      expect(emptyPolicyPost.status).toBe(400);

      // Null monthlyLeaveAllowance on POST /work-policies
      const nullAllowancePost = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ monthlyLeaveAllowance: null });
      expect(nullAllowancePost.status).toBe(400);

      // Non-permitted default allowance (e.g. 3 or 7) via API
      const unpermittedAllowance = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ monthlyLeaveAllowance: 3 });
      expect(unpermittedAllowance.status).toBe(400);
      expect(unpermittedAllowance.body.error.message).toContain('4, 5, 6');
    });

    it('enforces company-configured subset from PERMITTED_MONTHLY_LEAVE_ALLOWANCES_V1', async () => {
      authenticateAs(adminA);

      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue({
        companyId: companyA,
        key: PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY,
        value: JSON.stringify([5, 6]),
      } as any);

      // 4 is excluded by company subset [5, 6]
      const rejected4 = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ monthlyLeaveAllowance: 4 });
      expect(rejected4.status).toBe(400);
      expect(rejected4.body.error.message).toContain('5, 6');

      const revSpy = vi.spyOn(EmployeeService, 'createWorkPolicyRevision').mockResolvedValue({
        employee: { id: 'emp-a1', monthlyLeaveAllowance: 4 } as any,
        revisions: [],
        workPolicyEffectiveFrom: null,
        allowanceEffectiveFrom: '2026-12-01',
      });

      // 6 is permitted by [5, 6]
      const accepted6 = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ monthlyLeaveAllowance: 6 });
      expect(accepted6.status).toBe(201);
      expect(revSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. CompanySetting PERMITTED_MONTHLY_LEAVE_ALLOWANCES_V1 & Next-Month Local TZ Rule', () => {
    it('reads default [4, 5, 6] and persists SUPER_ADMIN subset updates via CompanySetting', async () => {
      const upserts: any[] = [];

      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({
        id: companyA,
        code: 'ALPHA',
        name: 'Alpha Corp',
        legalName: null,
        taxId: null,
        currency: 'USD',
        timezone: 'Asia/Kolkata',
        logoUrl: null,
        address: null,
        phone: null,
        email: null,
        website: null,
        appHeaderTitle: null,
        defaultDocumentLanguage: 'EN',
      } as any);

      vi.spyOn(prisma.companySetting, 'findMany').mockImplementation((async () => {
        return upserts.map((u) => ({ key: u.key, value: u.value }));
      }) as any);

      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);

      vi.spyOn(prisma.company, 'update').mockResolvedValue({
        id: companyA,
        code: 'ALPHA',
        name: 'Alpha Corp',
        timezone: 'Asia/Kolkata',
        currency: 'USD',
      } as any);

      vi.spyOn(prisma.companySetting, 'upsert').mockImplementation((async ({ create }: any) => {
        const idx = upserts.findIndex((u) => u.key === create.key);
        if (idx >= 0) upserts[idx] = create;
        else upserts.push(create);
        return create;
      }) as any);

      const defaultProfile = await CompanyService.getProfile(companyA);
      expect(defaultProfile.permittedMonthlyLeaveAllowances).toEqual([4, 5, 6]);

      await expect(
        CompanyService.updateProfile(superAdminA, {
          name: 'Alpha Corp',
          timezone: 'Asia/Kolkata',
          currency: 'USD',
          permittedMonthlyLeaveAllowances: [3, 4],
        })
      ).rejects.toThrow(/4, 5, or 6/);

      const updatedProfile = await CompanyService.updateProfile(superAdminA, {
        name: 'Alpha Corp',
        timezone: 'Asia/Kolkata',
        currency: 'USD',
        permittedMonthlyLeaveAllowances: [6, 4],
      });

      expect(upserts).toContainEqual({
        companyId: companyA,
        key: PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY,
        value: '[4,6]',
      });
      expect(updatedProfile.permittedMonthlyLeaveAllowances).toEqual([4, 6]);
    });

    it('applies monthlyLeaveAllowance on 1st of next month in company local timezone without altering SalaryRevision or running punch sync', async () => {
      // 2026-11-30T20:00:00Z is already 2026-12-01 01:30 in Asia/Kolkata (+05:30), so next local month is 2027-01-01
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-30T20:00:00.000Z'));

      authenticateAs(adminA);

      const revRows: any[] = [
        {
          id: 'rev-1',
          companyId: companyA,
          employeeId: 'emp-a1',
          shiftId: null,
          shift: null,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 4,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          effectiveTo: null,
          revisionReason: 'Initial',
          notes: null,
          createdByUserId: adminA.id,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ];

      const empRecord: any = {
        id: 'emp-a1',
        companyId: companyA,
        employeeCode: 'EMP-101',
        fullName: 'Local TZ Employee',
        email: null,
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
        userId: empA1.id,
        user: { email: empA1.email, isActive: true },
        ledgerId: null,
        ledger: null,
        shiftId: null,
        shift: null,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
        salaryRevisions: [{ fixedSalary: 40000 }],
        _count: { salaryRevisions: 1 },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };

      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(empRecord);
      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Asia/Kolkata' } as any);
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
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'deleteMany').mockResolvedValue({ count: 0 } as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'create').mockImplementation((async ({ data }: any) => {
        const created = {
          id: `rev-${revRows.length + 1}`,
          ...data,
          shift: null,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        revRows.push(created);
        return created;
      }) as any);
      vi.spyOn(prisma.employee, 'update').mockImplementation((async ({ data }: any) => {
        Object.assign(empRecord, data);
        return empRecord;
      }) as any);

      const salaryCreateSpy = vi.spyOn(prisma.salaryRevision, 'create');
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');

      const res = await request(app)
        .post('/api/employees/emp-a1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({
          monthlyLeaveAllowance: 6,
          effectiveFrom: '2026-12-01', // Should be ignored for allowance; pinned to 2027-01-01 (next local month)
          revisionReason: 'Annual leave policy upgrade',
        });

      expect(res.status).toBe(201);
      expect(res.body.allowanceEffectiveFrom).toBe('2027-01-01');
      expect(res.body.workPolicyEffectiveFrom).toBeNull();
      expect(revRows).toHaveLength(2);
      expect(revRows[0].effectiveTo.toISOString().split('T')[0]).toBe('2026-12-31');
      expect(revRows[1].effectiveFrom.toISOString().split('T')[0]).toBe('2027-01-01');
      expect(Number(revRows[1].monthlyLeaveAllowance)).toBe(6);
      // Current December snapshot stays 4 until 2027-01-01
      expect(res.body.employee.monthlyLeaveAllowance).toBe(4);
      expect(salaryCreateSpy).not.toHaveBeenCalled();
      expect(reconcileSpy).not.toHaveBeenCalled();
    });
  });

  describe('5. P1-2: Strict monthlyLeaveAllowance Null & Omitted Policy Enforcement', () => {
    const mockPermittedAllowances = (options: number[] | null) => {
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(
        options === null
          ? null
          : ({
              companyId: companyA,
              key: PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY,
              value: JSON.stringify(options),
            } as any)
      );
    };

    const makeMockEmployeeItem = (overrides: Record<string, unknown> = {}) => ({
      id: 'emp-p12-1',
      companyId: companyA,
      employeeCode: 'EMP-512',
      fullName: 'Policy Tested Worker',
      email: null,
      phone: null,
      address: null,
      photoUrl: null,
      dateOfBirth: null,
      dateOfJoining: '2026-10-01',
      departmentId: null,
      designationId: null,
      employmentType: 'FULL_TIME' as const,
      status: 'ACTIVE' as const,
      notes: null,
      biometricDeviceId: null,
      userId: null,
      ledgerId: null,
      shiftId: null,
      configuredDailyWorkingHours: 8,
      dailyWorkingHours: 8,
      monthlyLeaveAllowance: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    });

    it('rejects monthlyLeaveAllowance: null on POST /api/employees, PATCH /api/employees/:id, and POST /work-policies when company permits [5, 6]', async () => {
      authenticateAs(adminA);
      mockPermittedAllowances([5, 6]);

      const createSpy = vi.spyOn(EmployeeService, 'createEmployee');
      const updateSpy = vi.spyOn(EmployeeService, 'updateEmployee');
      const revSpy = vi.spyOn(EmployeeService, 'createWorkPolicyRevision');

      const createNullRes = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-NULL-1',
          fullName: 'Null Allowance Create',
          dateOfJoining: '2026-10-01',
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: null,
        });
      expect(createNullRes.status).toBe(400);
      expect(createNullRes.body.error.code).toBe('VALIDATION_ERROR');
      expect(createNullRes.body.error.message).toContain('5, 6');

      const patchNullRes = await request(app)
        .patch('/api/employees/emp-p12-1')
        .set('Authorization', 'Bearer valid-token')
        .send({
          monthlyLeaveAllowance: null,
        });
      expect(patchNullRes.status).toBe(400);
      expect(patchNullRes.body.error.code).toBe('VALIDATION_ERROR');
      expect(patchNullRes.body.error.message).toContain('5, 6');

      const revNullRes = await request(app)
        .post('/api/employees/emp-p12-1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({
          monthlyLeaveAllowance: null,
        });
      expect(revNullRes.status).toBe(400);
      expect(revNullRes.body.error.code).toBe('VALIDATION_ERROR');
      expect(revNullRes.body.error.message).toContain('5, 6');

      expect(createSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
      expect(revSpy).not.toHaveBeenCalled();
    });

    it('rejects omitted monthlyLeaveAllowance on POST /api/employees when company permits only [5, 6] (default 4 disallowed)', async () => {
      authenticateAs(adminA);
      mockPermittedAllowances([5, 6]);

      const createSpy = vi.spyOn(EmployeeService, 'createEmployee');

      const omittedCreateRes = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-OMIT-1',
          fullName: 'Omitted Allowance Worker',
          dateOfJoining: '2026-10-01',
          dailyWorkingHours: 8,
        });

      expect(omittedCreateRes.status).toBe(400);
      expect(omittedCreateRes.body.error.code).toBe('VALIDATION_ERROR');
      expect(omittedCreateRes.body.error.message).toContain('5, 6');
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('allows omitted monthlyLeaveAllowance on unrelated PATCH /api/employees/:id updates when company permits [5, 6]', async () => {
      authenticateAs(adminA);
      mockPermittedAllowances([5, 6]);

      const updateSpy = vi
        .spyOn(EmployeeService, 'updateEmployee')
        .mockResolvedValue(makeMockEmployeeItem({ fullName: 'Renamed Worker', phone: '9998887777' }));

      const patchUnrelatedRes = await request(app)
        .patch('/api/employees/emp-p12-1')
        .set('Authorization', 'Bearer valid-token')
        .send({
          fullName: 'Renamed Worker',
          phone: '9998887777',
        });

      expect(patchUnrelatedRes.status).toBe(200);
      expect(patchUnrelatedRes.body.fullName).toBe('Renamed Worker');
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0][2].monthlyLeaveAllowance).toBeUndefined();
    });

    it('accepts explicit valid values 5 and 6 and rejects disallowed 4 on POST /api/employees and PATCH /api/employees/:id when company permits [5, 6]', async () => {
      authenticateAs(adminA);
      mockPermittedAllowances([5, 6]);

      const createSpy = vi
        .spyOn(EmployeeService, 'createEmployee')
        .mockImplementation(async (_actor, input) =>
          makeMockEmployeeItem({ monthlyLeaveAllowance: input.monthlyLeaveAllowance ?? 5 })
        );
      const updateSpy = vi
        .spyOn(EmployeeService, 'updateEmployee')
        .mockImplementation(async (_actor, _id, input) =>
          makeMockEmployeeItem({ monthlyLeaveAllowance: input.monthlyLeaveAllowance ?? 5 })
        );

      for (const allowedVal of [5, 6]) {
        const createOk = await request(app)
          .post('/api/employees')
          .set('Authorization', 'Bearer valid-token')
          .send({
            employeeCode: `EMP-ALLOW-${allowedVal}`,
            fullName: `Allowed ${allowedVal}`,
            dateOfJoining: '2026-10-01',
            dailyWorkingHours: 8,
            monthlyLeaveAllowance: allowedVal,
          });
        expect(createOk.status).toBe(201);
        expect(createOk.body.monthlyLeaveAllowance).toBe(allowedVal);

        const patchOk = await request(app)
          .patch('/api/employees/emp-p12-1')
          .set('Authorization', 'Bearer valid-token')
          .send({ monthlyLeaveAllowance: allowedVal });
        expect(patchOk.status).toBe(200);
        expect(patchOk.body.monthlyLeaveAllowance).toBe(allowedVal);
      }

      const create4Rejected = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-DISALLOW-4',
          fullName: 'Disallowed Four',
          dateOfJoining: '2026-10-01',
          monthlyLeaveAllowance: 4,
        });
      expect(create4Rejected.status).toBe(400);
      expect(create4Rejected.body.error.code).toBe('VALIDATION_ERROR');
      expect(create4Rejected.body.error.message).toContain('5, 6');

      const patch4Rejected = await request(app)
        .patch('/api/employees/emp-p12-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ monthlyLeaveAllowance: 4 });
      expect(patch4Rejected.status).toBe(400);
      expect(patch4Rejected.body.error.code).toBe('VALIDATION_ERROR');
      expect(patch4Rejected.body.error.message).toContain('5, 6');

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(updateSpy).toHaveBeenCalledTimes(2);
    });

    it('preserves an already scheduled next-month allowance during unrelated profile and work-hours PATCH updates when company permits [5, 6]', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'));

      authenticateAs(adminA);
      mockPermittedAllowances([5, 6]);

      const revRows: any[] = [
        {
          id: 'rev-nov',
          companyId: companyA,
          employeeId: 'emp-p12-sched',
          shiftId: null,
          shift: null,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 4,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-11-30T00:00:00.000Z'),
          revisionReason: 'Initial',
          notes: null,
          createdByUserId: adminA.id,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'rev-dec-scheduled',
          companyId: companyA,
          employeeId: 'emp-p12-sched',
          shiftId: null,
          shift: null,
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 6,
          effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
          effectiveTo: null,
          revisionReason: 'Scheduled next-month upgrade',
          notes: null,
          createdByUserId: adminA.id,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date('2026-11-05T00:00:00.000Z'),
          updatedAt: new Date('2026-11-05T00:00:00.000Z'),
        },
      ];

      const empRecord: any = {
        id: 'emp-p12-sched',
        companyId: companyA,
        employeeCode: 'EMP-SCHED-1',
        fullName: 'Scheduled Worker',
        email: null,
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
        userId: null,
        user: null,
        ledgerId: null,
        ledger: null,
        shiftId: null,
        shift: null,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
        salaryRevisions: [],
        _count: { salaryRevisions: 0 },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };

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
          if (!gte || revRows[i].effectiveFrom.getTime() >= gte.getTime()) {
            revRows.splice(i, 1);
          }
        }
        return { count: 1 } as any;
      }) as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'create').mockImplementation((async ({ data }: any) => {
        const created = {
          id: `rev-gen-${revRows.length + 1}`,
          ...data,
          shift: null,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        revRows.push(created);
        return created;
      }) as any);
      vi.spyOn(prisma.employee, 'update').mockImplementation((async ({ data }: any) => {
        Object.assign(empRecord, data);
        return empRecord;
      }) as any);

      // 1. Unrelated profile update (monthlyLeaveAllowance omitted) leaves timeline untouched
      const profilePatchRes = await request(app)
        .patch('/api/employees/emp-p12-sched')
        .set('Authorization', 'Bearer valid-token')
        .send({ fullName: 'Scheduled Worker Updated', notes: 'Phone verified' });
      expect(profilePatchRes.status).toBe(200);
      expect(revRows).toHaveLength(2);
      expect(Number(revRows[1].monthlyLeaveAllowance)).toBe(6);

      // 2. Unrelated work-hours update (monthlyLeaveAllowance omitted) preserves scheduled Dec 1 allowance = 6
      const hoursPatchRes = await request(app)
        .patch('/api/employees/emp-p12-sched')
        .set('Authorization', 'Bearer valid-token')
        .send({ dailyWorkingHours: 7, policyEffectiveFrom: '2026-11-15' });
      expect(hoursPatchRes.status).toBe(200);

      const sortedRevs = revRows
        .slice()
        .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
      const decRev = sortedRevs.find(
        (r) => r.effectiveFrom.toISOString().split('T')[0] === '2026-12-01'
      );
      expect(decRev).toBeDefined();
      expect(Number(decRev.monthlyLeaveAllowance)).toBe(6);
      expect(Number(decRev.dailyWorkingHours)).toBe(7);
    });

    it('preserves default [4, 5, 6] compatibility when omitted on create while still rejecting explicit null', async () => {
      authenticateAs(adminA);
      mockPermittedAllowances(null); // Unconfigured company setting -> defaults to [4, 5, 6]

      const createSpy = vi
        .spyOn(EmployeeService, 'createEmployee')
        .mockResolvedValue(makeMockEmployeeItem({ monthlyLeaveAllowance: 4 }));

      const omittedDefaultRes = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-DEF-1',
          fullName: 'Default Allowance Worker',
          dateOfJoining: '2026-10-01',
          dailyWorkingHours: 8,
        });
      expect(omittedDefaultRes.status).toBe(201);
      expect(createSpy).toHaveBeenCalledTimes(1);

      const explicitFourRes = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-DEF-4',
          fullName: 'Explicit Four Worker',
          dateOfJoining: '2026-10-01',
          monthlyLeaveAllowance: 4,
        });
      expect(explicitFourRes.status).toBe(201);
      expect(createSpy).toHaveBeenCalledTimes(2);

      // Explicit null is still rejected even under default [4, 5, 6]
      const nullCreateRes = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-DEF-NULL',
          fullName: 'Null Under Default',
          dateOfJoining: '2026-10-01',
          monthlyLeaveAllowance: null,
        });
      expect(nullCreateRes.status).toBe(400);
      expect(nullCreateRes.body.error.code).toBe('VALIDATION_ERROR');

      const nullPatchRes = await request(app)
        .patch('/api/employees/emp-p12-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ monthlyLeaveAllowance: null });
      expect(nullPatchRes.status).toBe(400);
      expect(nullPatchRes.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('P1-4: POST /api/employees policyEffectiveFrom propagation & initial work-policy timeline', () => {
    const setupCreateEmployeeMocks = () => {
      const revRows: any[] = [];
      let createdEmp: any = null;

      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);
      vi.spyOn(prisma.employee, 'findUnique').mockImplementation((async (args: any) => {
        if (args.where?.companyId_employeeCode) return null;
        if (args.where?.id && createdEmp && args.where.id === createdEmp.id) return createdEmp;
        return null;
      }) as any);

      const empCreateSpy = vi.spyOn(prisma.employee, 'create').mockImplementation((async ({ data }: any) => {
        createdEmp = {
          id: 'emp-p14-1',
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

      const revCreateSpy = vi
        .spyOn(prisma.employeeWorkPolicyRevision, 'create')
        .mockImplementation((async ({ data }: any) => {
          const r = {
            id: `rev-p14-${revRows.length + 1}`,
            ...data,
            shift: null,
            createdByUser: { fullName: adminA.fullName },
            createdAt: new Date('2026-10-01T00:00:00.000Z'),
            updatedAt: new Date('2026-10-01T00:00:00.000Z'),
          };
          revRows.push(r);
          return r;
        }) as any);

      vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockImplementation((async () =>
        revRows.slice().sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())
      ) as any);

      return { revRows, empCreateSpy, revCreateSpy };
    };

    it('creates the initial revision with effectiveFrom equal to dateOfJoining when policyEffectiveFrom equals dateOfJoining', async () => {
      authenticateAs(adminA);
      const { revRows, revCreateSpy } = setupCreateEmployeeMocks();

      const res = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-P14-EQ',
          fullName: 'Equal Effective Date',
          dateOfJoining: '2026-10-01',
          policyEffectiveFrom: '2026-10-01',
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
        });

      expect(res.status).toBe(201);
      expect(revCreateSpy).toHaveBeenCalledTimes(1);
      expect(revRows).toHaveLength(1);
      expect(revRows[0].effectiveFrom.toISOString()).toBe('2026-10-01T00:00:00.000Z');
      expect(revRows[0].effectiveTo).toBeNull();
      expect(revRows[0].dailyWorkingHours).toBe(8);
      expect(revRows[0].monthlyLeaveAllowance).toBe(5);
    });

    it('creates a single initial revision at the later policyEffectiveFrom without creating any unintended pre-effective revision', async () => {
      authenticateAs(adminA);
      const { revRows, revCreateSpy } = setupCreateEmployeeMocks();

      const res = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-P14-LATER',
          fullName: 'Later Policy Effective Date',
          dateOfJoining: '2026-10-01',
          policyEffectiveFrom: '2026-10-15',
          dailyWorkingHours: 7.5,
          monthlyLeaveAllowance: 6,
        });

      expect(res.status).toBe(201);
      expect(revCreateSpy).toHaveBeenCalledTimes(1);
      expect(revRows).toHaveLength(1);
      expect(revRows[0].effectiveFrom.toISOString()).toBe('2026-10-15T00:00:00.000Z');
      expect(revRows[0].effectiveTo).toBeNull();
      expect(revRows[0].dailyWorkingHours).toBe(7.5);
      expect(revRows[0].monthlyLeaveAllowance).toBe(6);

      // Verify timeline endpoint returns only this single revision starting on 2026-10-15
      const timelineRes = await request(app)
        .get('/api/employees/emp-p14-1/work-policies')
        .set('Authorization', 'Bearer valid-token');

      expect(timelineRes.status).toBe(200);
      expect(timelineRes.body).toHaveLength(1);
      expect(timelineRes.body[0].effectiveFrom).toBe('2026-10-15');
      expect(timelineRes.body[0].effectiveTo).toBeNull();
    });

    it('rejects policyEffectiveFrom earlier than dateOfJoining with HTTP 400 and creates no employee or revision', async () => {
      authenticateAs(adminA);
      const { revRows, empCreateSpy, revCreateSpy } = setupCreateEmployeeMocks();

      const res = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-P14-EARLY',
          fullName: 'Earlier Policy Date',
          dateOfJoining: '2026-10-10',
          policyEffectiveFrom: '2026-10-09',
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/cannot be earlier than employee date of joining/i);
      expect(empCreateSpy).not.toHaveBeenCalled();
      expect(revCreateSpy).not.toHaveBeenCalled();
      expect(revRows).toHaveLength(0);
    });

    it('preserves dateOfJoining-based initial revision when policyEffectiveFrom is omitted', async () => {
      authenticateAs(adminA);
      const { revRows, revCreateSpy } = setupCreateEmployeeMocks();

      const res = await request(app)
        .post('/api/employees')
        .set('Authorization', 'Bearer valid-token')
        .send({
          employeeCode: 'EMP-P14-OMIT',
          fullName: 'Omitted Policy Date',
          dateOfJoining: '2026-10-05',
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 4,
        });

      expect(res.status).toBe(201);
      expect(revCreateSpy).toHaveBeenCalledTimes(1);
      expect(revRows).toHaveLength(1);
      expect(revRows[0].effectiveFrom.toISOString()).toBe('2026-10-05T00:00:00.000Z');
      expect(revRows[0].effectiveTo).toBeNull();
    });
  });

  describe('7. P2-3: Raw PATCH /api/employees/:id Preserving Scheduled Next-Month Allowance', () => {
    const setupScheduledAllowanceMocks = () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-15T10:00:00.000Z'));

      const revRows: any[] = [
        {
          id: 'rev-p23-hist',
          companyId: companyA,
          employeeId: 'emp-p23-1',
          shiftId: 'shift-day',
          shift: { id: 'shift-day', name: 'Day Shift', startTime: '09:00', endTime: '17:00' },
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 4,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-09-30T00:00:00.000Z'),
          revisionReason: 'Initial',
          notes: null,
          createdByUserId: adminA.id,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'rev-p23-curr',
          companyId: companyA,
          employeeId: 'emp-p23-1',
          shiftId: 'shift-day',
          shift: { id: 'shift-day', name: 'Day Shift', startTime: '09:00', endTime: '17:00' },
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
          effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-11-30T00:00:00.000Z'),
          revisionReason: 'October allowance',
          notes: null,
          createdByUserId: adminA.id,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
        {
          id: 'rev-p23-next',
          companyId: companyA,
          employeeId: 'emp-p23-1',
          shiftId: 'shift-day',
          shift: { id: 'shift-day', name: 'Day Shift', startTime: '09:00', endTime: '17:00' },
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 6,
          effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
          effectiveTo: null,
          revisionReason: 'Scheduled December upgrade',
          notes: null,
          createdByUserId: adminA.id,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date('2026-11-05T00:00:00.000Z'),
          updatedAt: new Date('2026-11-05T00:00:00.000Z'),
        },
      ];

      const empRecord: any = {
        id: 'emp-p23-1',
        companyId: companyA,
        employeeCode: 'EMP-P23',
        fullName: 'Scheduled Policy Employee',
        email: null,
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
        userId: null,
        user: null,
        ledgerId: null,
        ledger: null,
        shiftId: 'shift-day',
        shift: { id: 'shift-day', name: 'Day Shift', startTime: '09:00', endTime: '17:00' },
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 5,
        salaryRevisions: [],
        _count: { salaryRevisions: 0 },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-11-05T00:00:00.000Z'),
      };

      vi.spyOn(prisma.employee, 'findFirst').mockResolvedValue(empRecord);
      vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue(empRecord);
      vi.spyOn(prisma.shift, 'findUnique').mockImplementation((async ({ where }: any) => {
        if (where?.id === 'shift-night') {
          return { id: 'shift-night', companyId: companyA, name: 'Night Shift', startTime: '22:00', endTime: '06:00' };
        }
        if (where?.id === 'shift-day') {
          return { id: 'shift-day', companyId: companyA, name: 'Day Shift', startTime: '09:00', endTime: '17:00' };
        }
        return null;
      }) as any);
      vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.payrollPeriod, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null); // default [4, 5, 6]
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'findMany').mockImplementation((async () =>
        revRows.slice().sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())
      ) as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'update').mockImplementation((async ({ where, data }: any) => {
        const idx = revRows.findIndex((r) => r.id === where.id);
        if (idx >= 0) {
          revRows[idx] = { ...revRows[idx], ...data };
          return revRows[idx];
        }
        return null;
      }) as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'deleteMany').mockImplementation((async ({ where }: any) => {
        const gte: Date | undefined = where?.effectiveFrom?.gte;
        const before = revRows.length;
        for (let i = revRows.length - 1; i >= 0; i--) {
          if (!gte || revRows[i].effectiveFrom.getTime() >= gte.getTime()) {
            revRows.splice(i, 1);
          }
        }
        return { count: before - revRows.length };
      }) as any);
      vi.spyOn(prisma.employeeWorkPolicyRevision, 'create').mockImplementation((async ({ data }: any) => {
        const created = {
          id: `rev-p23-new-${revRows.length + 1}`,
          ...data,
          shift: null,
          createdByUser: { fullName: adminA.fullName },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        revRows.push(created);
        return created;
      }) as any);
      vi.spyOn(prisma.employee, 'update').mockImplementation((async ({ data }: any) => {
        Object.assign(empRecord, data);
        return empRecord;
      }) as any);

      return { revRows, empRecord };
    };

    it('preserves scheduled next-month allowance of 6 when raw PATCH /api/employees/:id resubmits current allowance 5 with a shift change', async () => {
      authenticateAs(adminA);
      const { revRows } = setupScheduledAllowanceMocks();

      const res = await request(app)
        .patch('/api/employees/emp-p23-1')
        .set('Authorization', 'Bearer valid-token')
        .send({
          shiftId: 'shift-night',
          monthlyLeaveAllowance: 5,
          policyEffectiveFrom: '2026-11-15',
        });

      expect(res.status).toBe(200);
      const decSeg = revRows.find(
        (r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-12-01'
      );
      expect(decSeg).toBeDefined();
      expect(Number(decSeg.monthlyLeaveAllowance)).toBe(6);
      expect(decSeg.shiftId).toBe('shift-night');

      const histSeg = revRows.find(
        (r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-01-01'
      );
      expect(histSeg).toBeDefined();
      expect(Number(histSeg.monthlyLeaveAllowance)).toBe(4);
    });

    it('updates scheduled next-month allowance when raw PATCH /api/employees/:id explicitly selects a different permitted allowance (4)', async () => {
      authenticateAs(adminA);
      const { revRows } = setupScheduledAllowanceMocks();

      const res = await request(app)
        .patch('/api/employees/emp-p23-1')
        .set('Authorization', 'Bearer valid-token')
        .send({
          monthlyLeaveAllowance: 4,
        });

      expect(res.status).toBe(200);
      const decSeg = revRows.find(
        (r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-12-01'
      );
      expect(decSeg).toBeDefined();
      expect(Number(decSeg.monthlyLeaveAllowance)).toBe(4);

      const novSeg = revRows.find(
        (r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-10-01'
      );
      expect(novSeg).toBeDefined();
      expect(Number(novSeg.monthlyLeaveAllowance)).toBe(5);
    });

    it('Decision 2 (P2-3): POST /api/employees/:id/work-policies explicitly reverts scheduled next-month allowance (6 -> 5) without altering current, historical, or later future revisions', async () => {
      authenticateAs(adminA);
      const { revRows } = setupScheduledAllowanceMocks();

      // Add a later future revision (Jan 2027) and close Dec 2026 on 2026-12-31 to verify zero overlap
      revRows[2].effectiveTo = new Date('2026-12-31T00:00:00.000Z');
      revRows.push({
        id: 'rev-p23-jan2027',
        companyId: companyA,
        employeeId: 'emp-p23-1',
        shiftId: 'shift-night',
        shift: { id: 'shift-night', name: 'Night Shift', startTime: '22:00', endTime: '06:00' },
        dailyWorkingHours: 7,
        monthlyLeaveAllowance: 4,
        effectiveFrom: new Date('2027-01-01T00:00:00.000Z'),
        effectiveTo: null,
        revisionReason: 'Scheduled Jan 2027 shift & allowance',
        notes: null,
        createdByUserId: adminA.id,
        createdByUser: { fullName: adminA.fullName },
        createdAt: new Date('2026-11-06T00:00:00.000Z'),
        updatedAt: new Date('2026-11-06T00:00:00.000Z'),
      });

      const res = await request(app)
        .post('/api/employees/emp-p23-1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({
          monthlyLeaveAllowance: 5,
          revisionReason: 'Cancel scheduled December increase',
        });

      expect(res.status).toBe(201);
      expect(res.body.allowanceEffectiveFrom).toBe('2026-12-01');
      expect(res.body.workPolicyEffectiveFrom).toBeNull();

      const sorted = revRows
        .slice()
        .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());

      expect(
        sorted.map((r) => ({
          from: r.effectiveFrom.toISOString().slice(0, 10),
          to: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
          shiftId: r.shiftId,
          hours: Number(r.dailyWorkingHours),
          allow: Number(r.monthlyLeaveAllowance),
        }))
      ).toEqual([
        { from: '2026-01-01', to: '2026-09-30', shiftId: 'shift-day', hours: 8, allow: 4 },
        { from: '2026-10-01', to: '2026-11-30', shiftId: 'shift-day', hours: 8, allow: 5 },
        { from: '2026-12-01', to: '2026-12-31', shiftId: 'shift-day', hours: 8, allow: 5 },
        { from: '2027-01-01', to: null, shiftId: 'shift-night', hours: 7, allow: 4 },
      ]);
    });

    it('Decision 2 (P2-3): allowance-only PATCH /api/employees/:id reverts scheduled next-month allowance (6 -> 5) effective 1st of next month', async () => {
      authenticateAs(adminA);
      const { revRows } = setupScheduledAllowanceMocks();

      const res = await request(app)
        .patch('/api/employees/emp-p23-1')
        .set('Authorization', 'Bearer valid-token')
        .send({
          monthlyLeaveAllowance: 5,
        });

      expect(res.status).toBe(200);

      const sorted = revRows
        .slice()
        .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());

      expect(
        sorted.map((r) => ({
          from: r.effectiveFrom.toISOString().slice(0, 10),
          to: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
          allow: Number(r.monthlyLeaveAllowance),
        }))
      ).toEqual([
        { from: '2026-01-01', to: '2026-09-30', allow: 4 },
        { from: '2026-10-01', to: '2026-11-30', allow: 5 },
        { from: '2026-12-01', to: null, allow: 5 },
      ]);
    });

    it('Decision 2 (P2-3): mixed PATCH with profile/dailyWorkingHours and resubmitted current allowance 5 still preserves scheduled next-month allowance 6', async () => {
      authenticateAs(adminA);
      const { revRows } = setupScheduledAllowanceMocks();

      const mixedProfileRes = await request(app)
        .patch('/api/employees/emp-p23-1')
        .set('Authorization', 'Bearer valid-token')
        .send({
          fullName: 'Renamed Employee',
          monthlyLeaveAllowance: 5,
        });

      expect(mixedProfileRes.status).toBe(200);
      expect(mixedProfileRes.body.fullName).toBe('Renamed Employee');

      const decAfterProfile = revRows.find(
        (r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-12-01'
      );
      expect(Number(decAfterProfile.monthlyLeaveAllowance)).toBe(6);

      const mixedHoursRes = await request(app)
        .patch('/api/employees/emp-p23-1')
        .set('Authorization', 'Bearer valid-token')
        .send({
          dailyWorkingHours: 7,
          monthlyLeaveAllowance: 5,
          policyEffectiveFrom: '2026-11-15',
        });

      expect(mixedHoursRes.status).toBe(200);
      const decAfterHours = revRows.find(
        (r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-12-01'
      );
      expect(Number(decAfterHours.monthlyLeaveAllowance)).toBe(6);
      expect(Number(decAfterHours.dailyWorkingHours)).toBe(7);
    });

    it('Decision 2 (P2-3): enforces Decision 1 company-permitted allowance restrictions [5, 6] during allowance reversion attempts', async () => {
      authenticateAs(adminA);
      const { revRows } = setupScheduledAllowanceMocks();

      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue({
        companyId: companyA,
        key: PERMITTED_MONTHLY_LEAVE_ALLOWANCES_SETTING_KEY,
        value: JSON.stringify([5, 6]),
      } as any);

      // Disallowed 4 must be rejected on both POST /work-policies and allowance-only PATCH without touching scheduled 6
      const rejectedRev = await request(app)
        .post('/api/employees/emp-p23-1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ monthlyLeaveAllowance: 4 });
      expect(rejectedRev.status).toBe(400);
      expect(rejectedRev.body.error.message).toContain('5, 6');

      const rejectedPatch = await request(app)
        .patch('/api/employees/emp-p23-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ monthlyLeaveAllowance: 4 });
      expect(rejectedPatch.status).toBe(400);
      expect(rejectedPatch.body.error.message).toContain('5, 6');

      expect(
        Number(
          revRows.find((r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-12-01')
            .monthlyLeaveAllowance
        )
      ).toBe(6);

      // Permitted 5 reverts scheduled December 6 -> 5 cleanly
      const revertedOk = await request(app)
        .post('/api/employees/emp-p23-1/work-policies')
        .set('Authorization', 'Bearer valid-token')
        .send({ monthlyLeaveAllowance: 5 });
      expect(revertedOk.status).toBe(201);
      expect(revertedOk.body.allowanceEffectiveFrom).toBe('2026-12-01');
      expect(
        Number(
          revRows.find((r) => r.effectiveFrom.toISOString().slice(0, 10) === '2026-12-01')
            .monthlyLeaveAllowance
        )
      ).toBe(5);
    });
  });
});



