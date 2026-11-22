import { Request, Response } from 'express';
import { EmployeeService } from '../services/employee.service.js';
import { BiometricMappingService } from '../services/biometric-mapping.service.js';
import { CompanyService } from '../services/company.service.js';
import { PermissionService } from '../services/permission.service.js';
import { DEFAULT_MONTHLY_LEAVE_ALLOWANCE } from '../services/work-policy.service.js';
import { AuthUser, EmployeeStatus } from '../../shared/types.js';

const VALID_EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] as const;
const VALID_EMPLOYEE_STATUSES = ['ACTIVE', 'INACTIVE', 'EXITED'] as const;

function validationError(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseStrictCalendarDate(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw validationError(`Invalid '${fieldName}': expected calendar date string in YYYY-MM-DD format.`);
  }
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw validationError(`Invalid '${fieldName}': expected calendar date in YYYY-MM-DD format.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw validationError(`Invalid calendar date for '${fieldName}': '${trimmed}'.`);
  }
  return trimmed;
}

function validateOptionalString(value: unknown, fieldName: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    throw validationError(`Field '${fieldName}' must be a string or null.`);
  }
}

function validateDailyWorkingHoursField(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationError(`Field 'dailyWorkingHours' must be a finite number or null.`);
  }
  if (value <= 0 || value > 24) {
    throw validationError('Daily required working hours must be greater than 0 and at most 24 hours.');
  }
}

function validateMonthlyLeaveAllowanceField(
  value: unknown,
  permittedOptions: number[],
  options?: { requireIfDefaultDisallowed?: boolean }
): void {
  if (value === undefined) {
    if (
      options?.requireIfDefaultDisallowed &&
      !permittedOptions.includes(DEFAULT_MONTHLY_LEAVE_ALLOWANCE)
    ) {
      throw validationError(
        `Monthly leave allowance is required because the default (${DEFAULT_MONTHLY_LEAVE_ALLOWANCE} days) is not permitted by company policy. Select one of the company-permitted options: ${permittedOptions.join(', ')} days.`
      );
    }
    return;
  }
  if (value === null) {
    throw validationError(
      `Monthly leave allowance cannot be null. It must be one of the company-permitted options: ${permittedOptions.join(', ')} days.`
    );
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationError(
      `Field 'monthlyLeaveAllowance' must be a finite integer from the company-permitted options: ${permittedOptions.join(', ')} days.`
    );
  }
  if (!Number.isInteger(value) || !permittedOptions.includes(value)) {
    throw validationError(
      `Monthly leave allowance must be one of the company-permitted options: ${permittedOptions.join(', ')} days.`
    );
  }
}

function validateInitialSalaryField(value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw validationError('Initial salary must be a non-negative finite number.');
    }
    return;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      throw validationError('Initial salary must be a valid non-negative numeric value.');
    }
    return;
  }
  throw validationError('Initial salary must be a non-negative number or numeric string.');
}

function validateBiometricMappingsField(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw validationError(`Field 'biometricMappings' must be an array.`);
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) {
      throw validationError(`Invalid biometric mapping at index ${i}: expected object.`);
    }
    if (typeof item.terminalId !== 'string' || !item.terminalId.trim()) {
      throw validationError(`Invalid biometric mapping at index ${i}: 'terminalId' must be a non-empty string.`);
    }
    if (typeof item.enrollmentId !== 'string' || !item.enrollmentId.trim()) {
      throw validationError(`Invalid biometric mapping at index ${i}: 'enrollmentId' must be a non-empty string.`);
    }
    if (item.isActive !== undefined && typeof item.isActive !== 'boolean') {
      throw validationError(`Invalid biometric mapping at index ${i}: 'isActive' must be a boolean.`);
    }
  }
}

function validateCreateEmployeePayload(body: unknown, permittedAllowances: number[]): void {
  if (!isPlainObject(body)) {
    throw validationError('Request body must be a JSON object.');
  }
  if (typeof body.employeeCode !== 'string' || !body.employeeCode.trim()) {
    throw validationError('Employee code is required and must be a non-empty string.');
  }
  if (typeof body.fullName !== 'string' || !body.fullName.trim()) {
    throw validationError('Employee full name is required and must be a non-empty string.');
  }

  const joiningStr = parseStrictCalendarDate(body.dateOfJoining, 'dateOfJoining');

  if (body.dateOfBirth !== undefined && body.dateOfBirth !== null && body.dateOfBirth !== '') {
    const birthStr = parseStrictCalendarDate(body.dateOfBirth, 'dateOfBirth');
    if (birthStr >= joiningStr) {
      throw validationError('Date of birth must be prior to date of joining.');
    }
  } else if (body.dateOfBirth !== undefined && body.dateOfBirth !== null && typeof body.dateOfBirth !== 'string') {
    throw validationError(`Field 'dateOfBirth' must be a calendar date string (YYYY-MM-DD) or null.`);
  }

  if (body.policyEffectiveFrom !== undefined) {
    if (body.policyEffectiveFrom === null || body.policyEffectiveFrom === '') {
      throw validationError(`Field 'policyEffectiveFrom' must be a valid calendar date string (YYYY-MM-DD).`);
    }
    const policyEffStr = parseStrictCalendarDate(body.policyEffectiveFrom, 'policyEffectiveFrom');
    if (policyEffStr < joiningStr) {
      throw validationError('Work policy effective date cannot be earlier than employee date of joining.');
    }
  }

  validateOptionalString(body.email, 'email');
  validateOptionalString(body.phone, 'phone');
  validateOptionalString(body.address, 'address');
  validateOptionalString(body.photoUrl, 'photoUrl');
  validateOptionalString(body.notes, 'notes');
  validateOptionalString(body.departmentId, 'departmentId');
  validateOptionalString(body.designationId, 'designationId');
  validateOptionalString(body.shiftId, 'shiftId');
  validateOptionalString(body.biometricDeviceId, 'biometricDeviceId');

  if (
    body.employmentType !== undefined &&
    (typeof body.employmentType !== 'string' ||
      !(VALID_EMPLOYMENT_TYPES as readonly string[]).includes(body.employmentType))
  ) {
    throw validationError(
      `Invalid 'employmentType': must be one of ${VALID_EMPLOYMENT_TYPES.join(', ')}.`
    );
  }

  if (
    body.status !== undefined &&
    (typeof body.status !== 'string' ||
      !(VALID_EMPLOYEE_STATUSES as readonly string[]).includes(body.status))
  ) {
    throw validationError(
      `Invalid 'status': must be one of ${VALID_EMPLOYEE_STATUSES.join(', ')}.`
    );
  }

  validateInitialSalaryField(body.initialSalary);
  validateDailyWorkingHoursField(body.dailyWorkingHours);
  validateMonthlyLeaveAllowanceField(body.monthlyLeaveAllowance, permittedAllowances, {
    requireIfDefaultDisallowed: true,
  });
  validateBiometricMappingsField(body.biometricMappings);
}

function validateUpdateEmployeePayload(body: unknown, permittedAllowances: number[]): void {
  if (!isPlainObject(body)) {
    throw validationError('Request body must be a JSON object.');
  }

  if (body.employeeCode !== undefined && (typeof body.employeeCode !== 'string' || !body.employeeCode.trim())) {
    throw validationError('Employee code must be a non-empty string.');
  }
  if (body.fullName !== undefined && (typeof body.fullName !== 'string' || !body.fullName.trim())) {
    throw validationError('Employee full name must be a non-empty string.');
  }

  if (body.dateOfJoining !== undefined) {
    parseStrictCalendarDate(body.dateOfJoining, 'dateOfJoining');
  }
  if (body.dateOfBirth !== undefined && body.dateOfBirth !== null && body.dateOfBirth !== '') {
    parseStrictCalendarDate(body.dateOfBirth, 'dateOfBirth');
  } else if (body.dateOfBirth !== undefined && body.dateOfBirth !== null && typeof body.dateOfBirth !== 'string') {
    throw validationError(`Field 'dateOfBirth' must be a calendar date string (YYYY-MM-DD) or null.`);
  }

  if (body.policyEffectiveFrom !== undefined) {
    parseStrictCalendarDate(body.policyEffectiveFrom, 'policyEffectiveFrom');
  }

  validateOptionalString(body.email, 'email');
  validateOptionalString(body.phone, 'phone');
  validateOptionalString(body.address, 'address');
  validateOptionalString(body.photoUrl, 'photoUrl');
  validateOptionalString(body.notes, 'notes');
  validateOptionalString(body.departmentId, 'departmentId');
  validateOptionalString(body.designationId, 'designationId');
  validateOptionalString(body.shiftId, 'shiftId');
  validateOptionalString(body.biometricDeviceId, 'biometricDeviceId');
  validateOptionalString(body.policyRevisionReason, 'policyRevisionReason');
  validateOptionalString(body.policyRevisionNotes, 'policyRevisionNotes');

  if (
    body.employmentType !== undefined &&
    (typeof body.employmentType !== 'string' ||
      !(VALID_EMPLOYMENT_TYPES as readonly string[]).includes(body.employmentType))
  ) {
    throw validationError(
      `Invalid 'employmentType': must be one of ${VALID_EMPLOYMENT_TYPES.join(', ')}.`
    );
  }

  if (
    body.status !== undefined &&
    (typeof body.status !== 'string' ||
      !(VALID_EMPLOYEE_STATUSES as readonly string[]).includes(body.status))
  ) {
    throw validationError(
      `Invalid 'status': must be one of ${VALID_EMPLOYEE_STATUSES.join(', ')}.`
    );
  }

  validateDailyWorkingHoursField(body.dailyWorkingHours);
  validateMonthlyLeaveAllowanceField(body.monthlyLeaveAllowance, permittedAllowances);
  validateBiometricMappingsField(body.biometricMappings);
}

function validateCreateWorkPolicyRevisionPayload(body: unknown, permittedAllowances: number[]): void {
  if (!isPlainObject(body)) {
    throw validationError('Request body must be a JSON object.');
  }

  const hasPolicyField =
    body.shiftId !== undefined ||
    body.dailyWorkingHours !== undefined ||
    body.monthlyLeaveAllowance !== undefined;

  if (!hasPolicyField) {
    throw validationError(
      'At least one work policy field (shiftId, dailyWorkingHours, or monthlyLeaveAllowance) must be provided.'
    );
  }

  validateOptionalString(body.shiftId, 'shiftId');
  validateDailyWorkingHoursField(body.dailyWorkingHours);
  validateMonthlyLeaveAllowanceField(body.monthlyLeaveAllowance, permittedAllowances);

  if (body.effectiveFrom !== undefined) {
    parseStrictCalendarDate(body.effectiveFrom, 'effectiveFrom');
  }

  validateOptionalString(body.revisionReason, 'revisionReason');
  validateOptionalString(body.notes, 'notes');
}

function mapErrorCode(status: number, fallback: string): string {
  if (status === 400) return 'VALIDATION_ERROR';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'EMPLOYEE_NOT_FOUND';
  if (status === 409) return 'EMPLOYEE_CONFLICT';
  return fallback;
}

export class EmployeeController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const {
        departmentId,
        designationId,
        status,
        search,
        fromJoiningDate,
        toJoiningDate,
        page,
        limit,
      } = req.query;

      const result = await EmployeeService.listEmployees(
        actor.companyId,
        {
          departmentId: typeof departmentId === 'string' ? departmentId : undefined,
          designationId: typeof designationId === 'string' ? designationId : undefined,
          status: typeof status === 'string' ? (status as EmployeeStatus) : undefined,
          search: typeof search === 'string' ? search : undefined,
          fromJoiningDate: typeof fromJoiningDate === 'string' ? fromJoiningDate : undefined,
          toJoiningDate: typeof toJoiningDate === 'string' ? toJoiningDate : undefined,
        },
        {
          page: typeof page === 'string' ? parseInt(page, 10) : undefined,
          limit: typeof limit === 'string' ? parseInt(limit, 10) : undefined,
        }
      );

      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getBiometricOptions(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const options = await BiometricMappingService.getEnrollmentOptionsForCompany(actor.companyId);
      res.json(options);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_BIOMETRIC_OPTIONS_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      // If EMPLOYEE role, check if they are requesting themselves
      if (actor.role === 'EMPLOYEE') {
        const selfProfile = await EmployeeService.getEmployeeForSelf(actor.companyId, actor.userId || actor.id);
        if (selfProfile.id !== req.params.id) {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: 'Employees are only permitted to view their own profile.',
            },
          });
          return;
        }
        res.json(selfProfile);
        return;
      }

      const employee = await EmployeeService.getEmployeeById(actor.companyId, req.params.id);
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  /**
   * Self-service profile endpoint: derives identity exclusively from authenticated session
   */
  static async getSelf(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const profile = await EmployeeService.getEmployeeForSelf(actor.companyId, actor.userId || actor.id);
      res.json(profile);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_SELF_NOT_FOUND',
          message: (err as Error).message,
        },
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      if (actor.role === 'EMPLOYEE') {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Employees are not authorized to create employee records.',
          },
        });
        return;
      }

      const permittedAllowances = isPlainObject(req.body)
        ? await CompanyService.getPermittedMonthlyLeaveAllowances(actor.companyId)
        : [4, 5, 6];

      validateCreateEmployeePayload(req.body, permittedAllowances);

      const employee = await EmployeeService.createEmployee(
        actor,
        req.body,
        req.correlationId || (req.headers['x-correlation-id'] as string)
      );
      res.status(201).json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: mapErrorCode(status, 'EMPLOYEE_CREATE_FAILED'),
          message: (err as Error).message,
        },
      });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      if (actor.role === 'EMPLOYEE') {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Employees are not authorized to update official employee records or working schedules.',
          },
        });
        return;
      }

      if (!req.params.id || !req.params.id.trim()) {
        throw validationError('Employee ID is required.');
      }

      const permittedAllowances =
        isPlainObject(req.body) && req.body.monthlyLeaveAllowance !== undefined
          ? await CompanyService.getPermittedMonthlyLeaveAllowances(actor.companyId)
          : [4, 5, 6];

      validateUpdateEmployeePayload(req.body, permittedAllowances);

      const employee = await EmployeeService.updateEmployee(
        actor,
        req.params.id.trim(),
        req.body,
        req.correlationId || (req.headers['x-correlation-id'] as string)
      );
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: mapErrorCode(status, 'EMPLOYEE_UPDATE_FAILED'),
          message: (err as Error).message,
        },
      });
    }
  }

  static async activate(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employee = await EmployeeService.activateEmployee(
        actor,
        req.params.id,
        req.correlationId || (req.headers['x-correlation-id'] as string)
      );
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_ACTIVATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async updateBiometricMappings(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const mappings = Array.isArray(req.body) ? req.body : req.body?.mappings;
      const result = await EmployeeService.updateEmployeeBiometricMappings(
        actor,
        req.params.id,
        mappings,
        req.correlationId || (req.headers['x-correlation-id'] as string)
      );
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 409 ? 'BIOMETRIC_MAPPING_CONFLICT' : 'EMPLOYEE_BIOMETRIC_MAPPING_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async deactivate(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employee = await EmployeeService.deactivateEmployee(
        actor,
        req.params.id,
        req.correlationId || (req.headers['x-correlation-id'] as string)
      );
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_DEACTIVATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async createLogin(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employee = await EmployeeService.createEmployeeLogin(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_LOGIN_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async toggleLogin(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const isActive = req.body.isActive === true;
      const employee = await EmployeeService.toggleEmployeeLoginStatus(
        actor,
        req.params.id,
        isActive,
        req.headers['x-correlation-id'] as string
      );
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_LOGIN_TOGGLE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async linkLedger(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employee = await EmployeeService.linkEmployeeLedger(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.json(employee);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'EMPLOYEE_LEDGER_LINK_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async listSalaries(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;

      // If EMPLOYEE role, can only view own salary
      if (actor.role === 'EMPLOYEE') {
        const selfProfile = await EmployeeService.getEmployeeForSelf(actor.companyId, actor.userId || actor.id);
        if (selfProfile.id !== req.params.id) {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: 'Employees are only permitted to view their own salary history.',
            },
          });
          return;
        }
      }

      const salaries = await EmployeeService.listSalaryRevisions(actor.companyId, req.params.id);
      res.json(salaries);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'SALARY_LIST_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async createSalaryRevision(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;

      // Ordinary employees cannot edit salary
      if (actor.role === 'EMPLOYEE') {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Employees cannot create or alter salary structure.',
          },
        });
        return;
      }

      const rev = await EmployeeService.createSalaryRevision(
        actor,
        req.params.id,
        req.body,
        req.headers['x-correlation-id'] as string
      );
      res.status(201).json(rev);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: 'SALARY_REVISION_CREATE_FAILED',
          message: (err as Error).message,
        },
      });
    }
  }

  static async listWorkPolicies(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;
      const employeeId = req.params.id;
      if (!employeeId || !employeeId.trim()) {
        throw validationError('Employee ID is required.');
      }

      if (actor.role !== 'EMPLOYEE') {
        const canView = await PermissionService.hasPermission(
          actor.companyId,
          actor.role,
          'EMPLOYEE',
          'VIEW'
        );
        if (!canView) {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN_PERMISSION_DENIED',
              message: `Access denied. Role "${actor.role}" does not have permission "VIEW" on module "EMPLOYEE".`,
            },
          });
          return;
        }
      }

      const revisions = await EmployeeService.listWorkPolicyRevisions(actor, employeeId.trim());
      res.json(revisions);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: mapErrorCode(status, 'WORK_POLICY_LIST_FAILED'),
          message: (err as Error).message,
        },
      });
    }
  }

  static async createWorkPolicyRevision(req: Request, res: Response): Promise<void> {
    try {
      const actor = req.user as AuthUser;

      if (actor.role === 'EMPLOYEE') {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Employees are not authorized to modify work policy revisions.',
          },
        });
        return;
      }

      const employeeId = req.params.id;
      if (!employeeId || !employeeId.trim()) {
        throw validationError('Employee ID is required.');
      }

      const permittedAllowances =
        isPlainObject(req.body) && req.body.monthlyLeaveAllowance !== undefined
          ? await CompanyService.getPermittedMonthlyLeaveAllowances(actor.companyId)
          : [4, 5, 6];

      validateCreateWorkPolicyRevisionPayload(req.body, permittedAllowances);

      const result = await EmployeeService.createWorkPolicyRevision(
        actor,
        employeeId.trim(),
        req.body,
        req.correlationId || (req.headers['x-correlation-id'] as string)
      );
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: {
          code: status === 409 ? 'WORK_POLICY_CONFLICT' : mapErrorCode(status, 'WORK_POLICY_REVISION_CREATE_FAILED'),
          message: (err as Error).message,
        },
      });
    }
  }
}
