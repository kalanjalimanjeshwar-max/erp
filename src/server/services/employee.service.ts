import bcrypt from 'bcryptjs';
import { prisma } from '../db/client.js';
import {
  AuthUser,
  EmployeeItem,
  CreateEmployeeRequest,
  UpdateEmployeeRequest,
  CreateEmployeeLoginRequest,
  LinkEmployeeLedgerRequest,
  SalaryRevisionItem,
  CreateSalaryRevisionRequest,
  EmployeeWorkPolicyRevisionItem,
  CreateEmployeeWorkPolicyRevisionRequest,
  EmployeeStatus,
  EmploymentType,
  EmployeeBiometricMappingInput,
  PunchReconciliationResponse,
} from '../../shared/types.js';
import { AccountingMath, Decimal } from '../accounting/decimal-math.js';
import { AuditService } from './audit.service.js';
import { BiometricMappingService } from './biometric-mapping.service.js';
import { CompanyService } from './company.service.js';
import { PermissionService } from './permission.service.js';
import { PunchReconciliationService } from './punch-reconciliation.service.js';
import {
  DEFAULT_MONTHLY_LEAVE_ALLOWANCE,
  WorkPolicyService,
  WorkPolicyRevisionRecord,
  calculateShiftDurationHours,
  formatUtcDateOnly,
  getLocalCalendarDateStr,
  parseUtcDateOnly,
  toNullablePolicyNumber,
} from './work-policy.service.js';
import { getDefaultAccountNature } from '../../shared/account-nature.js';

const VALID_EMPLOYEE_STATUSES: EmployeeStatus[] = ['ACTIVE', 'INACTIVE', 'EXITED'];

export { calculateShiftDurationHours };

export class EmployeeService {
  private static validateCompanyPermittedMonthlyLeaveAllowance(
    value: unknown,
    permittedOptions: number[],
    options?: { requireIfDefaultDisallowed?: boolean }
  ): number | undefined {
    if (value === undefined) {
      if (
        options?.requireIfDefaultDisallowed &&
        !permittedOptions.includes(DEFAULT_MONTHLY_LEAVE_ALLOWANCE)
      ) {
        const err = new Error(
          `Monthly leave allowance is required because the default (${DEFAULT_MONTHLY_LEAVE_ALLOWANCE} days) is not permitted by company policy. Select one of the company-permitted options: ${permittedOptions.join(', ')} days.`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      return undefined;
    }

    if (value === null) {
      const err = new Error(
        `Monthly leave allowance cannot be null. It must be one of the company-permitted options: ${permittedOptions.join(', ')} days.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      const err = new Error(
        `Field 'monthlyLeaveAllowance' must be a finite integer from the company-permitted options: ${permittedOptions.join(', ')} days.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!Number.isInteger(value) || !permittedOptions.includes(value)) {
      const err = new Error(
        `Monthly leave allowance must be one of the company-permitted options: ${permittedOptions.join(', ')} days.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const validated = WorkPolicyService.validateMonthlyLeaveAllowance(value);
    return validated ?? value;
  }

  private static mapEmployeeToItem(
    e: any,
    biometricMappings: EmployeeItem['biometricMappings'],
    policyRevisions: WorkPolicyRevisionRecord[],
    todayStr: string
  ): EmployeeItem {
    const resolvedPolicy = WorkPolicyService.resolvePolicyForDate({
      date: todayStr,
      employee: e,
      revisions: policyRevisions,
    });
    const effectiveShift = resolvedPolicy.shift || null;

    return {
      id: e.id,
      companyId: e.companyId,
      employeeCode: e.employeeCode,
      fullName: e.fullName,
      email: e.email,
      phone: e.phone,
      address: e.address,
      photoUrl: e.photoUrl,
      dateOfBirth: e.dateOfBirth ? e.dateOfBirth.toISOString().split('T')[0] : null,
      dateOfJoining: e.dateOfJoining.toISOString().split('T')[0],
      departmentId: e.departmentId,
      departmentName: e.department?.name || null,
      designationId: e.designationId,
      designationName: e.designation?.name || null,
      employmentType: e.employmentType,
      status: e.status,
      notes: e.notes,
      biometricDeviceId: e.biometricDeviceId,
      biometricMappings: biometricMappings || [],
      userId: e.userId,
      userEmail: e.user?.email || null,
      userActive: e.user?.isActive ?? false,
      ledgerId: e.ledgerId,
      ledgerCode: e.ledger?.code || null,
      ledgerName: e.ledger?.name || null,
      currentSalary: e.salaryRevisions?.[0]
        ? AccountingMath.format(e.salaryRevisions[0].fixedSalary, 2)
        : null,
      salaryRevisionsCount: e._count?.salaryRevisions ?? 0,
      shiftId: resolvedPolicy.shiftId || null,
      shiftName: effectiveShift?.name || null,
      shiftStartTime: effectiveShift?.startTime || null,
      shiftEndTime: effectiveShift?.endTime || null,
      shiftIsOvernight: effectiveShift?.isOvernight ?? null,
      configuredDailyWorkingHours: resolvedPolicy.effectiveDailyWorkingHours,
      dailyWorkingHours: resolvedPolicy.configuredDailyWorkingHours,
      monthlyLeaveAllowance: toNullablePolicyNumber(
        resolvedPolicy.source === 'REVISION'
          ? resolvedPolicy.monthlyLeaveAllowance
          : e.monthlyLeaveAllowance
      ),
      effectiveWorkPolicy: resolvedPolicy.effectiveFrom
        ? {
            dailyWorkingHours: resolvedPolicy.effectiveDailyWorkingHours,
            monthlyLeaveAllowance: resolvedPolicy.monthlyLeaveAllowance,
            shiftId: resolvedPolicy.shiftId,
            effectiveFrom: resolvedPolicy.effectiveFrom,
            effectiveTo: resolvedPolicy.effectiveTo,
            source: resolvedPolicy.source,
          }
        : {
            dailyWorkingHours: resolvedPolicy.effectiveDailyWorkingHours,
            monthlyLeaveAllowance: resolvedPolicy.monthlyLeaveAllowance,
            shiftId: resolvedPolicy.shiftId,
            effectiveFrom: e.dateOfJoining.toISOString().split('T')[0],
            effectiveTo: null,
            source: resolvedPolicy.source,
          },
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }
  /**
   * Helper: Validates safe photo URL (prevents javascript:, data:, or unsafe schemes)
   */
  private static validatePhotoUrl(url?: string | null): string | null {
    if (!url || !url.trim()) return null;
    const trimmed = url.trim();
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('/')) {
      return trimmed;
    }
    const err = new Error('Photo URL must be a valid HTTPS URL or internal asset path.');
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }

  /**
   * Lists employees scoped to company with search, filtering and pagination
   */
  static async listEmployees(
    companyId: string,
    filters?: {
      departmentId?: string;
      designationId?: string;
      status?: EmployeeStatus;
      search?: string;
      fromJoiningDate?: string;
      toJoiningDate?: string;
    },
    pagination?: {
      page?: number;
      limit?: number;
    }
  ): Promise<{ items: EmployeeItem[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, pagination?.page || 1);
    const limit = Math.min(100, Math.max(1, pagination?.limit || 20));
    const skip = (page - 1) * limit;

    const where: {
      companyId: string;
      departmentId?: string;
      designationId?: string;
      status?: EmployeeStatus;
      dateOfJoining?: { gte?: Date; lte?: Date };
      OR?: Array<{
        employeeCode?: { contains: string; mode: 'insensitive' };
        fullName?: { contains: string; mode: 'insensitive' };
        email?: { contains: string; mode: 'insensitive' };
        phone?: { contains: string; mode: 'insensitive' };
      }>;
    } = { companyId };

    if (filters?.departmentId) where.departmentId = filters.departmentId;
    if (filters?.designationId) where.designationId = filters.designationId;
    if (filters?.status) where.status = filters.status;

    if (filters?.fromJoiningDate || filters?.toJoiningDate) {
      where.dateOfJoining = {};
      if (filters.fromJoiningDate) where.dateOfJoining.gte = new Date(filters.fromJoiningDate);
      if (filters.toJoiningDate) where.dateOfJoining.lte = new Date(filters.toJoiningDate);
    }

    if (filters?.search && filters.search.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { employeeCode: { contains: term, mode: 'insensitive' } },
        { fullName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [total, records] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
        include: {
          department: { select: { name: true } },
          designation: { select: { name: true } },
          shift: { select: { id: true, name: true, code: true, startTime: true, endTime: true, isOvernight: true } },
          user: { select: { email: true, isActive: true } },
          ledger: { select: { code: true, name: true } },
          salaryRevisions: {
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
            select: { fixedSalary: true },
          },
          _count: { select: { salaryRevisions: true } },
        },
      }),
    ]);

    const [mappingsMap, policyRevsMap, timezone] = await Promise.all([
      BiometricMappingService.getMappingsMapForEmployees(
        companyId,
        records.map((r) => r.id)
      ),
      WorkPolicyService.listRevisionsForEmployees(
        companyId,
        records.map((r) => r.id)
      ),
      WorkPolicyService.resolveCompanyTimezone(companyId),
    ]);

    const todayStr = getLocalCalendarDateStr(timezone);

    const items: EmployeeItem[] = records.map((e) =>
      this.mapEmployeeToItem(e, mappingsMap.get(e.id) || [], policyRevsMap.get(e.id) || [], todayStr)
    );

    return { items, total, page, limit };
  }

  /**
   * Gets single employee by ID
   */
  static async getEmployeeById(companyId: string, id: string): Promise<EmployeeItem> {
    const e = await prisma.employee.findUnique({
      where: { id },
      include: {
        department: { select: { name: true } },
        designation: { select: { name: true } },
        shift: { select: { id: true, name: true, code: true, startTime: true, endTime: true, isOvernight: true } },
        user: { select: { email: true, isActive: true } },
        ledger: { select: { code: true, name: true } },
        salaryRevisions: {
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
          select: { fixedSalary: true },
        },
        _count: { select: { salaryRevisions: true } },
      },
    });

    if (!e || e.companyId !== companyId) {
      const err = new Error('Employee record not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const [biometricMappings, policyRevisions, timezone] = await Promise.all([
      BiometricMappingService.listMappingsForEmployee(companyId, e.id),
      WorkPolicyService.listRevisionsForEmployee(companyId, e.id),
      WorkPolicyService.resolveCompanyTimezone(companyId),
    ]);

    const todayStr = getLocalCalendarDateStr(timezone);
    return this.mapEmployeeToItem(e, biometricMappings, policyRevisions, todayStr);
  }

  /**
   * Gets employee self profile derived strictly from the authenticated session userId
   */
  static async getEmployeeForSelf(companyId: string, userId: string): Promise<EmployeeItem> {
    const e = await prisma.employee.findUnique({
      where: { userId },
      include: {
        department: { select: { name: true } },
        designation: { select: { name: true } },
        shift: { select: { id: true, name: true, code: true, startTime: true, endTime: true, isOvernight: true } },
        user: { select: { email: true, isActive: true } },
        ledger: { select: { code: true, name: true } },
        salaryRevisions: {
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
          select: { fixedSalary: true },
        },
        _count: { select: { salaryRevisions: true } },
      },
    });

    if (!e || e.companyId !== companyId) {
      const err = new Error('No employee record is linked to your user account.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const [biometricMappings, policyRevisions, timezone] = await Promise.all([
      BiometricMappingService.listMappingsForEmployee(companyId, e.id),
      WorkPolicyService.listRevisionsForEmployee(companyId, e.id),
      WorkPolicyService.resolveCompanyTimezone(companyId),
    ]);

    const todayStr = getLocalCalendarDateStr(timezone);
    return this.mapEmployeeToItem(e, biometricMappings, policyRevisions, todayStr);
  }

  /**
   * Creates a new Employee record with company scoping and optional initial salary revision
   * CRITICAL: Does NOT create journal entries or alter accounting balances
   */
  static async createEmployee(
    actor: AuthUser,
    input: CreateEmployeeRequest,
    correlationId?: string
  ): Promise<EmployeeItem> {
    const trimmedCode = input.employeeCode.trim().toUpperCase();
    const trimmedName = input.fullName.trim();

    if (!trimmedCode) {
      const err = new Error('Employee code is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!trimmedName) {
      const err = new Error('Employee full name is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!input.dateOfJoining) {
      const err = new Error('Date of joining is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const joiningDate = new Date(input.dateOfJoining);
    if (isNaN(joiningDate.getTime())) {
      const err = new Error('Invalid date of joining format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    let policyEffectiveFromDate: Date | undefined;
    if (input.policyEffectiveFrom !== undefined) {
      if (typeof input.policyEffectiveFrom !== 'string' || !input.policyEffectiveFrom.trim()) {
        const err = new Error(`Field 'policyEffectiveFrom' must be a valid calendar date string (YYYY-MM-DD).`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      const joiningDateOnly = parseUtcDateOnly(joiningDate, 'date of joining');
      policyEffectiveFromDate = parseUtcDateOnly(input.policyEffectiveFrom, 'work policy effective date');
      if (policyEffectiveFromDate.getTime() < joiningDateOnly.getTime()) {
        const err = new Error(
          `Work policy effective date (${formatUtcDateOnly(policyEffectiveFromDate)}) cannot be earlier than employee date of joining (${formatUtcDateOnly(joiningDateOnly)}).`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    let birthDate: Date | null = null;
    if (input.dateOfBirth) {
      birthDate = new Date(input.dateOfBirth);
      if (isNaN(birthDate.getTime())) {
        const err = new Error('Invalid date of birth format.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (birthDate >= joiningDate) {
        const err = new Error('Date of birth must be prior to date of joining.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    // Check unique employeeCode within company
    const existing = await prisma.employee.findUnique({
      where: { companyId_employeeCode: { companyId: actor.companyId, employeeCode: trimmedCode } },
    });
    if (existing) {
      const err = new Error(`Employee code '${trimmedCode}' already exists in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    // Validate department reference belongs to company
    if (input.departmentId) {
      const dept = await prisma.department.findUnique({ where: { id: input.departmentId } });
      if (!dept || dept.companyId !== actor.companyId) {
        const err = new Error('Referenced department is invalid or belongs to another company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    // Validate designation reference belongs to company
    if (input.designationId) {
      const desig = await prisma.designation.findUnique({ where: { id: input.designationId } });
      if (!desig || desig.companyId !== actor.companyId) {
        const err = new Error('Referenced designation is invalid or belongs to another company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    // Validate shift reference if provided
    let shiftIdToAssign: string | null = null;
    if (input.shiftId && input.shiftId.trim()) {
      const shiftRecord = await prisma.shift.findUnique({ where: { id: input.shiftId.trim() } });
      if (!shiftRecord || shiftRecord.companyId !== actor.companyId) {
        const err = new Error('Referenced shift is invalid or belongs to another company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      shiftIdToAssign = shiftRecord.id;
    }

    const photoUrl = this.validatePhotoUrl(input.photoUrl);

    // Initial salary validation if provided
    let initialSalaryDecimal: Decimal | null = null;
    if (input.initialSalary !== undefined && input.initialSalary !== null && input.initialSalary !== '') {
      initialSalaryDecimal = AccountingMath.from(input.initialSalary);
      if (AccountingMath.lt(initialSalaryDecimal, 0)) {
        const err = new Error('Initial salary cannot be negative.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    const dailyWorkingHoursToAssign =
      input.dailyWorkingHours !== undefined
        ? WorkPolicyService.validateDailyWorkingHours(input.dailyWorkingHours)
        : null;
    const permittedMonthlyLeaveAllowances = await CompanyService.getPermittedMonthlyLeaveAllowances(
      actor.companyId
    );
    const validatedMonthlyLeaveAllowance = this.validateCompanyPermittedMonthlyLeaveAllowance(
      input.monthlyLeaveAllowance,
      permittedMonthlyLeaveAllowances,
      { requireIfDefaultDisallowed: true }
    );
    const monthlyLeaveAllowanceToAssign =
      validatedMonthlyLeaveAllowance !== undefined ? validatedMonthlyLeaveAllowance : null;

    // Validate initial status if provided (default ACTIVE)
    const initialStatus: EmployeeStatus = input.status || 'ACTIVE';
    if (!VALID_EMPLOYEE_STATUSES.includes(initialStatus)) {
      const err = new Error(`Invalid employee status '${input.status}'. Must be ACTIVE, INACTIVE, or EXITED.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Single database transaction
    const created = await prisma.$transaction(async (tx) => {
      const emp = await tx.employee.create({
        data: {
          companyId: actor.companyId,
          employeeCode: trimmedCode,
          fullName: trimmedName,
          email: input.email?.trim() || null,
          phone: input.phone?.trim() || null,
          address: input.address?.trim() || null,
          photoUrl,
          dateOfBirth: birthDate,
          dateOfJoining: joiningDate,
          departmentId: input.departmentId || null,
          designationId: input.designationId || null,
          shiftId: shiftIdToAssign,
          ...(dailyWorkingHoursToAssign !== null ? { dailyWorkingHours: dailyWorkingHoursToAssign } : {}),
          ...(monthlyLeaveAllowanceToAssign !== null ? { monthlyLeaveAllowance: monthlyLeaveAllowanceToAssign } : {}),
          employmentType: input.employmentType || 'FULL_TIME',
          status: initialStatus,
          notes: input.notes?.trim() || null,
          biometricDeviceId: input.biometricDeviceId?.trim() || null,
        },
      });

      await WorkPolicyService.createInitialRevisionTx(tx, {
        companyId: actor.companyId,
        employeeId: emp.id,
        dateOfJoining: joiningDate,
        ...(policyEffectiveFromDate !== undefined ? { effectiveFrom: policyEffectiveFromDate } : {}),
        shiftId: shiftIdToAssign,
        dailyWorkingHours: dailyWorkingHoursToAssign,
        monthlyLeaveAllowance: monthlyLeaveAllowanceToAssign,
        createdByUserId: actor.userId || actor.id,
      });

      if (initialSalaryDecimal) {
        await tx.salaryRevision.create({
          data: {
            companyId: actor.companyId,
            employeeId: emp.id,
            fixedSalary: initialSalaryDecimal,
            effectiveFrom: joiningDate,
            effectiveTo: null,
            revisionReason: 'Initial salary upon joining',
            notes: 'Established on employee creation',
            createdByUserId: actor.userId || actor.id,
          },
        });
      }

      if (Array.isArray(input.biometricMappings) && input.biometricMappings.length > 0) {
        await BiometricMappingService.replaceEmployeeMappings(
          actor,
          emp.id,
          input.biometricMappings,
          {
            tx,
            correlationId,
            skipAudit: true,
            syncEmployeeBiometricField: true,
          }
        );
      }

      return emp;
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'EMPLOYEE_CREATE',
      entity: 'Employee',
      entityId: created.id,
      correlationId,
      details: {
        employeeCode: created.employeeCode,
        fullName: created.fullName,
        status: created.status,
        hasInitialSalary: !!initialSalaryDecimal,
        biometricMappingsCount: Array.isArray(input.biometricMappings) ? input.biometricMappings.length : 0,
      },
    });

    const employeeItem = await this.getEmployeeById(actor.companyId, created.id);

    // Trigger targeted punch reconciliation only for the newly mapped (terminalId, enrollmentId) pairs if ACTIVE
    if (employeeItem.status === 'ACTIVE' && employeeItem.biometricMappings?.length) {
      await this.reconcileMappingsForEmployee(actor, employeeItem, correlationId);
    }

    return employeeItem;
  }

  /**
   * Updates an existing Employee record
   */
  static async updateEmployee(
    actor: AuthUser,
    id: string,
    input: UpdateEmployeeRequest,
    correlationId?: string
  ): Promise<EmployeeItem> {
    const existing = await prisma.employee.findUnique({ where: { id } });
    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Employee record not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (actor.role === 'EMPLOYEE') {
      const err = new Error('Employees are not authorized to update official employee records or working schedules.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const updateData: {
      employeeCode?: string;
      fullName?: string;
      email?: string | null;
      phone?: string | null;
      address?: string | null;
      photoUrl?: string | null;
      dateOfBirth?: Date | null;
      dateOfJoining?: Date;
      departmentId?: string | null;
      designationId?: string | null;
      shiftId?: string | null;
      employmentType?: EmploymentType;
      status?: EmployeeStatus;
      notes?: string | null;
      biometricDeviceId?: string | null;
    } = {};

    if (input.employeeCode !== undefined) {
      const trimmedCode = input.employeeCode.trim().toUpperCase();
      if (!trimmedCode) {
        const err = new Error('Employee code cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmedCode !== existing.employeeCode) {
        const duplicate = await prisma.employee.findUnique({
          where: { companyId_employeeCode: { companyId: actor.companyId, employeeCode: trimmedCode } },
        });
        if (duplicate) {
          const err = new Error(`Employee code '${trimmedCode}' already exists in this company.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        updateData.employeeCode = trimmedCode;
      }
    }

    if (input.fullName !== undefined) {
      const trimmedName = input.fullName.trim();
      if (!trimmedName) {
        const err = new Error('Employee full name cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      updateData.fullName = trimmedName;
    }

    if (input.email !== undefined) {
      updateData.email = input.email?.trim() || null;
    }

    if (input.phone !== undefined) {
      updateData.phone = input.phone?.trim() || null;
    }

    if (input.address !== undefined) {
      updateData.address = input.address?.trim() || null;
    }

    if (input.photoUrl !== undefined) {
      updateData.photoUrl = this.validatePhotoUrl(input.photoUrl);
    }

    if (input.dateOfJoining !== undefined) {
      const d = new Date(input.dateOfJoining);
      if (isNaN(d.getTime())) {
        const err = new Error('Invalid date of joining format.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      updateData.dateOfJoining = d;
    }

    if (input.dateOfBirth !== undefined) {
      if (input.dateOfBirth) {
        const d = new Date(input.dateOfBirth);
        if (isNaN(d.getTime())) {
          const err = new Error('Invalid date of birth format.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        updateData.dateOfBirth = d;
      } else {
        updateData.dateOfBirth = null;
      }
    }

    if (input.departmentId !== undefined) {
      if (input.departmentId) {
        const dept = await prisma.department.findUnique({ where: { id: input.departmentId } });
        if (!dept || dept.companyId !== actor.companyId) {
          const err = new Error('Referenced department is invalid or belongs to another company.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        updateData.departmentId = input.departmentId;
      } else {
        updateData.departmentId = null;
      }
    }

    if (input.designationId !== undefined) {
      if (input.designationId) {
        const desig = await prisma.designation.findUnique({ where: { id: input.designationId } });
        if (!desig || desig.companyId !== actor.companyId) {
          const err = new Error('Referenced designation is invalid or belongs to another company.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        updateData.designationId = input.designationId;
      } else {
        updateData.designationId = null;
      }
    }

    if (input.employmentType !== undefined) {
      updateData.employmentType = input.employmentType;
    }

    if (input.status !== undefined) {
      if (!VALID_EMPLOYEE_STATUSES.includes(input.status)) {
        const err = new Error(`Invalid employee status '${input.status}'. Must be ACTIVE, INACTIVE, or EXITED.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      updateData.status = input.status;
    }

    if (input.notes !== undefined) {
      updateData.notes = input.notes?.trim() || null;
    }

    if (input.biometricDeviceId !== undefined) {
      updateData.biometricDeviceId = input.biometricDeviceId?.trim() || null;
    }

    let nextShiftIdParam: string | null | undefined = undefined;
    if (input.shiftId !== undefined) {
      if (input.shiftId === null || input.shiftId === '') {
        nextShiftIdParam = null;
      } else {
        const trimmedShiftId = input.shiftId.trim();
        const s = await prisma.shift.findUnique({ where: { id: trimmedShiftId } });
        if (!s || s.companyId !== actor.companyId) {
          const err = new Error('Referenced shift is invalid or belongs to another company.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        nextShiftIdParam = trimmedShiftId;
      }
    }

    const nextDailyHoursParam =
      input.dailyWorkingHours !== undefined
        ? WorkPolicyService.validateDailyWorkingHours(input.dailyWorkingHours)
        : undefined;
    let nextMonthlyAllowanceParam: number | undefined = undefined;
    if (input.monthlyLeaveAllowance !== undefined) {
      const permittedMonthlyLeaveAllowances = await CompanyService.getPermittedMonthlyLeaveAllowances(
        actor.companyId
      );
      nextMonthlyAllowanceParam = this.validateCompanyPermittedMonthlyLeaveAllowance(
        input.monthlyLeaveAllowance,
        permittedMonthlyLeaveAllowances,
        { requireIfDefaultDisallowed: false }
      );
    }

    const hasPolicyInput =
      nextShiftIdParam !== undefined ||
      nextDailyHoursParam !== undefined ||
      nextMonthlyAllowanceParam !== undefined;

    const isAllowanceOnlyUpdate =
      nextMonthlyAllowanceParam !== undefined &&
      nextShiftIdParam === undefined &&
      nextDailyHoursParam === undefined &&
      input.biometricMappings === undefined &&
      Object.keys(updateData).length === 0 &&
      input.employeeCode === undefined;

    let policyResult: Awaited<ReturnType<typeof WorkPolicyService.applyWorkPolicyUpdateTx>> | null = null;

    if (input.biometricMappings !== undefined || hasPolicyInput) {
      await prisma.$transaction(async (tx) => {
        if (Object.keys(updateData).length > 0) {
          await tx.employee.update({
            where: { id },
            data: updateData,
          });
        }

        if (hasPolicyInput) {
          policyResult = await WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
            companyId: actor.companyId,
            employee: {
              id: existing.id,
              dateOfJoining: updateData.dateOfJoining || existing.dateOfJoining,
              shiftId: existing.shiftId,
              dailyWorkingHours: (existing as any).dailyWorkingHours,
              monthlyLeaveAllowance: (existing as any).monthlyLeaveAllowance,
            },
            nextShiftId: nextShiftIdParam,
            nextDailyWorkingHours: nextDailyHoursParam,
            nextMonthlyLeaveAllowance: nextMonthlyAllowanceParam,
            allowAllowanceReversionToCurrent: isAllowanceOnlyUpdate,
            workPolicyEffectiveFrom: input.policyEffectiveFrom,
            revisionReason: input.policyRevisionReason,
            notes: input.policyRevisionNotes,
            createdByUserId: actor.userId || actor.id,
          });
        }

        if (input.biometricMappings !== undefined) {
          await BiometricMappingService.replaceEmployeeMappings(
            actor,
            id,
            input.biometricMappings!,
            {
              tx,
              correlationId,
              skipAudit: true,
              syncEmployeeBiometricField: true,
            }
          );
        }
      });
    } else if (Object.keys(updateData).length > 0) {
      await prisma.employee.update({
        where: { id },
        data: updateData,
      });
    }

    const statusChanged = input.status !== undefined && input.status !== existing.status;
    const actionName = statusChanged && input.status === 'ACTIVE'
      ? 'EMPLOYEE_ACTIVATE'
      : statusChanged && (input.status === 'INACTIVE' || input.status === 'EXITED')
      ? 'EMPLOYEE_DEACTIVATE'
      : 'EMPLOYEE_UPDATE';

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: actionName,
      entity: 'Employee',
      entityId: id,
      correlationId,
      details: {
        ...updateData,
        previousStatus: existing.status,
        biometricMappingsUpdated: input.biometricMappings !== undefined,
        workPolicyUpdated: policyResult?.applied ?? false,
        workPolicyEffectiveFrom: policyResult?.workPolicyEffectiveFrom ?? null,
        allowanceEffectiveFrom: policyResult?.allowanceEffectiveFrom ?? null,
      },
    });

    const updatedEmployee = await this.getEmployeeById(actor.companyId, id);

    // If employee is ACTIVE and either newly activated OR biometric mappings were updated,
    // reconcile eligible punches ONLY for this employee's exact mapped (terminalId, enrollmentId) pairs.
    const activatedNow = existing.status !== 'ACTIVE' && updatedEmployee.status === 'ACTIVE';
    if (
      updatedEmployee.status === 'ACTIVE' &&
      (activatedNow || input.biometricMappings !== undefined) &&
      updatedEmployee.biometricMappings?.length
    ) {
      await this.reconcileMappingsForEmployee(actor, updatedEmployee, correlationId);
    }

    return updatedEmployee;
  }

  /**
   * Reconciles pending/error punches strictly for each (terminalId, enrollmentId) mapped to an ACTIVE employee.
   */
  private static async reconcileMappingsForEmployee(
    actor: AuthUser,
    employee: EmployeeItem,
    correlationId?: string
  ): Promise<PunchReconciliationResponse> {
    const aggregate: PunchReconciliationResponse = {
      success: true,
      totalEvaluated: 0,
      processed: 0,
      pending: 0,
      ignored: 0,
      errors: 0,
      results: [],
    };

    if (employee.status !== 'ACTIVE' || !employee.biometricMappings?.length) {
      return aggregate;
    }

    if (typeof prisma.rawPunchLog?.findMany !== 'function') {
      return aggregate;
    }

    for (const mapping of employee.biometricMappings) {
      if (!mapping.isActive || !mapping.terminalId || !mapping.enrollmentId) continue;
      try {
        const res = await PunchReconciliationService.reconcileForEmployeeMapping(
          actor.companyId,
          mapping.terminalId,
          mapping.enrollmentId,
          actor,
          correlationId
        );
        aggregate.totalEvaluated += res.totalEvaluated;
        aggregate.processed += res.processed;
        aggregate.pending = (aggregate.pending || 0) + (res.pending || 0);
        aggregate.ignored += res.ignored;
        aggregate.errors += res.errors;
        aggregate.results.push(...res.results);
      } catch {
        // Non-fatal: reconciliation can be re-triggered safely without corrupting employee save
      }
    }

    return aggregate;
  }

  /**
   * Explicitly updates biometric terminal enrollment mappings for an employee and runs
   * targeted punch reconciliation if the employee is ACTIVE.
   */
  static async updateEmployeeBiometricMappings(
    actor: AuthUser,
    id: string,
    mappings: EmployeeBiometricMappingInput[],
    correlationId?: string
  ): Promise<{ employee: EmployeeItem; reconciliation: PunchReconciliationResponse }> {
    if (actor.role === 'EMPLOYEE') {
      const err = new Error('Employees are not authorized to modify biometric terminal mappings.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    await BiometricMappingService.replaceEmployeeMappings(actor, id, mappings, {
      correlationId,
      syncEmployeeBiometricField: true,
    });

    const employee = await this.getEmployeeById(actor.companyId, id);
    const reconciliation = await this.reconcileMappingsForEmployee(actor, employee, correlationId);
    return { employee, reconciliation };
  }

  /**
   * Safe activation of employee (transitions status to ACTIVE and reconciles mapped pending punches)
   */
  static async activateEmployee(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<EmployeeItem> {
    return this.updateEmployee(actor, id, { status: 'ACTIVE' }, correlationId);
  }

  /**
   * Safe deactivation of employee (preserving historical accounting, payroll & salary records)
   */
  static async deactivateEmployee(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<EmployeeItem> {
    return this.updateEmployee(actor, id, { status: 'INACTIVE' }, correlationId);
  }

  /**
   * Creates an employee user login account linked to the employee
   * Never exposes password hash; validates unique email in company
   */
  static async createEmployeeLogin(
    actor: AuthUser,
    employeeId: string,
    input: CreateEmployeeLoginRequest,
    correlationId?: string
  ): Promise<EmployeeItem> {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { user: true },
    });

    if (!employee || employee.companyId !== actor.companyId) {
      const err = new Error('Employee not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (employee.userId) {
      const err = new Error('This employee already has a linked user account.');
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const trimmedEmail = input.email.trim().toLowerCase();
    if (!trimmedEmail) {
      const err = new Error('Email is required for employee login.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!input.password || input.password.length < 8) {
      const err = new Error('Password must be at least 8 characters.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Role verification
    const targetRole = input.role || 'EMPLOYEE';
    if (!PermissionService.canAssignRole(actor.role, targetRole)) {
      const err = new Error(`Role '${actor.role}' is not authorized to assign role '${targetRole}'.`);
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // Check email uniqueness within company
    const existingUser = await prisma.user.findUnique({
      where: { companyId_email: { companyId: actor.companyId, email: trimmedEmail } },
    });
    if (existingUser) {
      const err = new Error(`User email '${trimmedEmail}' is already registered in this company.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          companyId: actor.companyId,
          email: trimmedEmail,
          fullName: employee.fullName,
          passwordHash,
          role: targetRole,
          isActive: true,
        },
      });

      await tx.employee.update({
        where: { id: employeeId },
        data: { userId: newUser.id },
      });
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'EMPLOYEE_LOGIN_CREATE',
      entity: 'Employee',
      entityId: employeeId,
      correlationId,
      details: { email: trimmedEmail, role: targetRole },
    });

    return this.getEmployeeById(actor.companyId, employeeId);
  }

  /**
   * Toggles activation of the employee's linked login account
   */
  static async toggleEmployeeLoginStatus(
    actor: AuthUser,
    employeeId: string,
    isActive: boolean,
    correlationId?: string
  ): Promise<EmployeeItem> {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { user: true },
    });

    if (!employee || employee.companyId !== actor.companyId) {
      const err = new Error('Employee not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!employee.userId || !employee.user) {
      const err = new Error('This employee does not have a linked user account.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    await prisma.user.update({
      where: { id: employee.userId },
      data: {
        isActive,
        tokenVersion: { increment: 1 },
      },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: isActive ? 'EMPLOYEE_LOGIN_ACTIVATE' : 'EMPLOYEE_LOGIN_DEACTIVATE',
      entity: 'Employee',
      entityId: employeeId,
      correlationId,
      details: { userId: employee.userId, isActive },
    });

    return this.getEmployeeById(actor.companyId, employeeId);
  }

  /**
   * Links or creates an accounting ledger for an employee
   * Enforces 1-to-1 company-scoped employee-ledger relationship
   * CRITICAL: Does NOT create journal entries
   */
  static async linkEmployeeLedger(
    actor: AuthUser,
    employeeId: string,
    input: LinkEmployeeLedgerRequest,
    correlationId?: string
  ): Promise<EmployeeItem> {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { ledger: true },
    });

    if (!employee || employee.companyId !== actor.companyId) {
      const err = new Error('Employee not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    let targetLedgerId: string;

    if (input.createLedger) {
      // Find or require appropriate group
      let groupId = input.groupId;
      let resolvedGroup: { id: string; companyId: string; code: string; name: string; rootType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE' } | null = null;
      if (!groupId) {
        // Find existing "Payroll" or "Employees" or "Current Liabilities" group
        const group = await prisma.accountGroup.findFirst({
          where: {
            companyId: actor.companyId,
            OR: [
              { name: { contains: 'Employee', mode: 'insensitive' } },
              { name: { contains: 'Payroll', mode: 'insensitive' } },
              { rootType: 'LIABILITY' },
            ],
          },
        });
        if (group) {
          groupId = group.id;
          resolvedGroup = group;
        }
      } else if (typeof prisma.accountGroup?.findUnique === 'function') {
        const group = await prisma.accountGroup.findUnique({
          where: { id: groupId },
        });
        if (!group || group.companyId !== actor.companyId) {
          const err = new Error('Target account group not found in this company.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        resolvedGroup = group;
      }

      if (!groupId) {
        const err = new Error(
          'Missing accounting configuration: Please create or select an Account Group under Liabilities or Expenses before creating an employee ledger.'
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      const ledgerName = `${employee.fullName} (${employee.employeeCode})`;
      const ledgerCode = `EMP-${employee.employeeCode}`;

      // Check duplicate ledger name or code
      const duplicate = await prisma.accountLedger.findFirst({
        where: {
          companyId: actor.companyId,
          OR: [{ name: ledgerName }, { code: ledgerCode }],
        },
      });

      if (duplicate) {
        targetLedgerId = duplicate.id;
      } else {
        const derivedNature = resolvedGroup ? getDefaultAccountNature(resolvedGroup) : 'CREDIT';
        const newLedger = await prisma.accountLedger.create({
          data: {
            companyId: actor.companyId,
            groupId,
            code: ledgerCode,
            name: ledgerName,
            description: `Employee ledger for ${employee.fullName} (${employee.employeeCode})`,
            isActive: true,
            openingBalance: new Decimal(0),
            openingBalanceType: derivedNature,
            employeeId: employee.id,
          },
        });
        targetLedgerId = newLedger.id;
      }
    } else if (input.ledgerId) {
      const ledger = await prisma.accountLedger.findUnique({
        where: { id: input.ledgerId },
      });

      if (!ledger || ledger.companyId !== actor.companyId) {
        const err = new Error('Specified ledger is invalid or belongs to another company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      if (!ledger.isActive) {
        const err = new Error('Cannot link to an inactive accounting ledger.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      // Check if ledger is already linked to another employee
      if (ledger.employeeId && ledger.employeeId !== employee.id) {
        const err = new Error('This ledger is already linked to another employee.');
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      targetLedgerId = ledger.id;
    } else {
      const err = new Error('Please specify a ledgerId or request createLedger: true.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Atomically link both sides
    await prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id: employeeId },
        data: { ledgerId: targetLedgerId },
      });

      await tx.accountLedger.update({
        where: { id: targetLedgerId },
        data: { employeeId: employee.id },
      });
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'EMPLOYEE_LEDGER_LINK',
      entity: 'Employee',
      entityId: employeeId,
      correlationId,
      details: { ledgerId: targetLedgerId },
    });

    return this.getEmployeeById(actor.companyId, employeeId);
  }

  /**
   * Lists historical salary revisions for an employee
   */
  static async listSalaryRevisions(
    companyId: string,
    employeeId: string
  ): Promise<SalaryRevisionItem[]> {
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee || employee.companyId !== companyId) {
      const err = new Error('Employee not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const revisions = await prisma.salaryRevision.findMany({
      where: { companyId, employeeId },
      orderBy: { effectiveFrom: 'desc' },
      include: {
        createdByUser: { select: { fullName: true } },
      },
    });

    return revisions.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      employeeId: r.employeeId,
      fixedSalary: AccountingMath.format(r.fixedSalary, 2),
      effectiveFrom: r.effectiveFrom.toISOString().split('T')[0],
      effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().split('T')[0] : null,
      revisionReason: r.revisionReason,
      notes: r.notes,
      createdByUserId: r.createdByUserId,
      createdByUserName: r.createdByUser.fullName,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Creates a new salary revision with effective-dating and non-overlapping rule
   * Preserves all historical revisions; does NOT create journal entries
   */
  static async createSalaryRevision(
    actor: AuthUser,
    employeeId: string,
    input: CreateSalaryRevisionRequest,
    correlationId?: string
  ): Promise<SalaryRevisionItem> {
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee || employee.companyId !== actor.companyId) {
      const err = new Error('Employee not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const salaryDecimal = AccountingMath.from(input.fixedSalary);
    if (AccountingMath.lt(salaryDecimal, 0)) {
      const err = new Error('Fixed monthly salary cannot be negative.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!input.effectiveFrom) {
      const err = new Error('Effective date is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const effFrom = new Date(input.effectiveFrom);
    if (isNaN(effFrom.getTime())) {
      const err = new Error('Invalid effective date format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Joining date validation rule
    if (effFrom < employee.dateOfJoining) {
      const err = new Error(
        `Salary effective date (${input.effectiveFrom}) cannot be earlier than employee date of joining (${employee.dateOfJoining.toISOString().split('T')[0]}).`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    let effTo: Date | null = null;
    if (input.effectiveTo) {
      effTo = new Date(input.effectiveTo);
      if (isNaN(effTo.getTime())) {
        const err = new Error('Invalid effective-to date format.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (effTo <= effFrom) {
        const err = new Error('Effective-to date must be strictly after effective-from date.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    // Check for identical effectiveFrom date conflict
    const conflict = await prisma.salaryRevision.findFirst({
      where: {
        companyId: actor.companyId,
        employeeId,
        effectiveFrom: effFrom,
      },
    });
    if (conflict) {
      const err = new Error(
        `A salary revision already exists with effective date '${input.effectiveFrom}'.`
      );
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    // Atomically close previous open revision and insert new revision
    const created = await prisma.$transaction(async (tx) => {
      // Find open revision (effectiveTo is null or >= effFrom)
      const previousOpen = await tx.salaryRevision.findFirst({
        where: {
          companyId: actor.companyId,
          employeeId,
          effectiveFrom: { lt: effFrom },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: effFrom } }],
        },
        orderBy: { effectiveFrom: 'desc' },
      });

      if (previousOpen) {
        // Set previous open revision's effectiveTo to 1 day before new effectiveFrom
        const dayBefore = new Date(effFrom);
        dayBefore.setDate(dayBefore.getDate() - 1);

        await tx.salaryRevision.update({
          where: { id: previousOpen.id },
          data: { effectiveTo: dayBefore },
        });
      }

      return tx.salaryRevision.create({
        data: {
          companyId: actor.companyId,
          employeeId,
          fixedSalary: salaryDecimal,
          effectiveFrom: effFrom,
          effectiveTo: effTo,
          revisionReason: input.revisionReason?.trim() || 'Salary Revision',
          notes: input.notes?.trim() || null,
          createdByUserId: actor.userId || actor.id,
        },
        include: {
          createdByUser: { select: { fullName: true } },
        },
      });
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId || actor.id,
      action: 'SALARY_REVISION_CREATE',
      entity: 'SalaryRevision',
      entityId: created.id,
      correlationId,
      details: {
        employeeId,
        fixedSalary: AccountingMath.format(created.fixedSalary, 2),
        effectiveFrom: input.effectiveFrom,
      },
    });

    return {
      id: created.id,
      companyId: created.companyId,
      employeeId: created.employeeId,
      fixedSalary: AccountingMath.format(created.fixedSalary, 2),
      effectiveFrom: created.effectiveFrom.toISOString().split('T')[0],
      effectiveTo: created.effectiveTo ? created.effectiveTo.toISOString().split('T')[0] : null,
      revisionReason: created.revisionReason,
      notes: created.notes,
      createdByUserId: created.createdByUserId,
      createdByUserName: (created as unknown as { createdByUser?: { fullName: string } }).createdByUser?.fullName || actor.fullName,
      createdAt: created.createdAt.toISOString(),
    };
  }

  /**
   * Lists effective-dated work policy revisions (daily working hours, shift, monthly leave allowance)
   * with strict tenant isolation.
   */
  static async listWorkPolicyRevisions(
    actor: AuthUser,
    employeeId: string
  ): Promise<EmployeeWorkPolicyRevisionItem[]> {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, companyId: true, userId: true },
    });

    if (!employee || employee.companyId !== actor.companyId) {
      const err = new Error('Employee not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (actor.role === 'EMPLOYEE' && employee.userId !== (actor.userId || actor.id)) {
      const err = new Error('Employees are only permitted to view their own work policy history.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const revisions = await WorkPolicyService.listRevisionsForEmployee(actor.companyId, employeeId);
    return revisions.map((rev) => WorkPolicyService.toRevisionItem(rev));
  }

  /**
   * Creates an effective-dated work policy revision for an employee.
   * Never modifies SalaryRevision and never triggers biometric punch reconciliation.
   */
  static async createWorkPolicyRevision(
    actor: AuthUser,
    employeeId: string,
    input: CreateEmployeeWorkPolicyRevisionRequest,
    correlationId?: string
  ): Promise<{
    employee: EmployeeItem;
    revisions: EmployeeWorkPolicyRevisionItem[];
    workPolicyEffectiveFrom: string | null;
    allowanceEffectiveFrom: string | null;
  }> {
    if (actor.role === 'EMPLOYEE') {
      const err = new Error('Employees are not authorized to modify work policy revisions.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee || employee.companyId !== actor.companyId) {
      const err = new Error('Employee not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    let nextShiftIdParam: string | null | undefined = undefined;
    if (input.shiftId !== undefined) {
      if (input.shiftId === null || input.shiftId === '') {
        nextShiftIdParam = null;
      } else {
        const trimmedShiftId = input.shiftId.trim();
        const s = await prisma.shift.findUnique({ where: { id: trimmedShiftId } });
        if (!s || s.companyId !== actor.companyId) {
          const err = new Error('Referenced shift is invalid or belongs to another company.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        nextShiftIdParam = trimmedShiftId;
      }
    }

    const nextDailyHoursParam =
      input.dailyWorkingHours !== undefined
        ? WorkPolicyService.validateDailyWorkingHours(input.dailyWorkingHours)
        : undefined;
    let nextMonthlyAllowanceParam: number | undefined = undefined;
    if (input.monthlyLeaveAllowance !== undefined) {
      const permittedMonthlyLeaveAllowances = await CompanyService.getPermittedMonthlyLeaveAllowances(
        actor.companyId
      );
      nextMonthlyAllowanceParam = this.validateCompanyPermittedMonthlyLeaveAllowance(
        input.monthlyLeaveAllowance,
        permittedMonthlyLeaveAllowances,
        { requireIfDefaultDisallowed: false }
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      return WorkPolicyService.applyWorkPolicyUpdateTx(tx, {
        companyId: actor.companyId,
        employee: {
          id: employee.id,
          dateOfJoining: employee.dateOfJoining,
          shiftId: employee.shiftId,
          dailyWorkingHours: (employee as any).dailyWorkingHours,
          monthlyLeaveAllowance: (employee as any).monthlyLeaveAllowance,
        },
        nextShiftId: nextShiftIdParam,
        nextDailyWorkingHours: nextDailyHoursParam,
        nextMonthlyLeaveAllowance: nextMonthlyAllowanceParam,
        allowAllowanceReversionToCurrent: true,
        workPolicyEffectiveFrom: input.effectiveFrom,
        revisionReason: input.revisionReason,
        notes: input.notes,
        createdByUserId: actor.userId || actor.id,
      });
    });

    if (result.applied) {
      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.userId || actor.id,
        action: 'EMPLOYEE_WORK_POLICY_REVISION_CREATE',
        entity: 'EmployeeWorkPolicyRevision',
        entityId: employeeId,
        correlationId,
        details: {
          shiftId: nextShiftIdParam,
          dailyWorkingHours: nextDailyHoursParam,
          monthlyLeaveAllowance: nextMonthlyAllowanceParam,
          workPolicyEffectiveFrom: result.workPolicyEffectiveFrom,
          allowanceEffectiveFrom: result.allowanceEffectiveFrom,
        },
      });
    }

    const [updatedEmployee, revisions] = await Promise.all([
      this.getEmployeeById(actor.companyId, employeeId),
      this.listWorkPolicyRevisions(actor, employeeId),
    ]);

    return {
      employee: updatedEmployee,
      revisions,
      workPolicyEffectiveFrom: result.workPolicyEffectiveFrom,
      allowanceEffectiveFrom: result.allowanceEffectiveFrom,
    };
  }
}
