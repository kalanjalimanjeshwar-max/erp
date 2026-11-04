import { Role, AppModule, AppAction } from '../../shared/types.js';
import { prisma } from '../db/client.js';

export interface PermissionRule {
  module: AppModule;
  action: AppAction;
}

/**
 * Baseline permission matrix defining default boundaries for all roles
 */
const DEFAULT_ROLE_PERMISSIONS: Record<Role, Record<AppModule, AppAction[]>> = {
  SUPER_ADMIN: {
    COMPANY: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    USER: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    ROLE_PERMISSION: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    AUDIT_LOG: ['VIEW'],
    FISCAL_PERIOD: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    CURRENCY: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    ACCOUNTING: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    QUOTATION: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    CUSTOMER: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    INVOICE: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    RECEIPT: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    EMPLOYEE: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    DEPARTMENT: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    DESIGNATION: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    PAYROLL: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    ATTENDANCE: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
    BIOMETRIC: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'],
  },
  ADMIN: {
    COMPANY: ['VIEW', 'EDIT'],
    USER: ['VIEW', 'CREATE', 'EDIT', 'DEACTIVATE'],
    ROLE_PERMISSION: ['VIEW'],
    AUDIT_LOG: ['VIEW'],
    FISCAL_PERIOD: ['VIEW', 'CREATE', 'EDIT', 'APPROVE'],
    CURRENCY: ['VIEW', 'CREATE', 'EDIT'],
    ACCOUNTING: ['VIEW', 'CREATE', 'EDIT', 'APPROVE'],
    QUOTATION: ['VIEW', 'CREATE', 'EDIT', 'APPROVE'],
    CUSTOMER: ['VIEW', 'CREATE', 'EDIT'],
    INVOICE: ['VIEW', 'CREATE', 'EDIT', 'APPROVE'],
    RECEIPT: ['VIEW', 'CREATE', 'APPROVE'],
    EMPLOYEE: ['VIEW', 'CREATE', 'EDIT', 'DEACTIVATE'],
    DEPARTMENT: ['VIEW', 'CREATE', 'EDIT', 'DEACTIVATE'],
    DESIGNATION: ['VIEW', 'CREATE', 'EDIT', 'DEACTIVATE'],
    PAYROLL: ['VIEW', 'CREATE', 'EDIT', 'APPROVE'],
    ATTENDANCE: ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE'],
    BIOMETRIC: ['VIEW', 'CREATE', 'EDIT', 'DEACTIVATE'],
  },
  VICE_ADMIN: {
    COMPANY: ['VIEW'],
    USER: ['VIEW'],
    ROLE_PERMISSION: ['VIEW'],
    AUDIT_LOG: ['VIEW'],
    FISCAL_PERIOD: ['VIEW'],
    CURRENCY: ['VIEW'],
    ACCOUNTING: ['VIEW'],
    QUOTATION: ['VIEW'],
    CUSTOMER: ['VIEW'],
    INVOICE: ['VIEW'],
    RECEIPT: ['VIEW'],
    EMPLOYEE: ['VIEW'],
    DEPARTMENT: ['VIEW'],
    DESIGNATION: ['VIEW'],
    PAYROLL: ['VIEW'],
    ATTENDANCE: ['VIEW'],
    BIOMETRIC: ['VIEW'],
  },
  EMPLOYEE: {
    COMPANY: ['VIEW'],
    USER: [], // Cannot view or administer other users
    ROLE_PERMISSION: [],
    AUDIT_LOG: [],
    FISCAL_PERIOD: [],
    CURRENCY: ['VIEW'],
    ACCOUNTING: [],
    QUOTATION: [],
    CUSTOMER: [],
    INVOICE: [],
    RECEIPT: [],
    EMPLOYEE: ['VIEW'], // Access own profile only via resource-level check
    DEPARTMENT: ['VIEW'],
    DESIGNATION: ['VIEW'],
    PAYROLL: ['VIEW'], // View own payslip (controlled at resource level)
    ATTENDANCE: ['VIEW', 'CREATE'], // View own attendance / clock in
    BIOMETRIC: [],
  },
};

export class PermissionService {
  /**
   * Checks whether a role has permission for a specific module and action
   * Combines baseline rules with company-specific RolePermission overrides
   */
  static async hasPermission(
    companyId: string,
    role: Role,
    module: AppModule,
    action: AppAction
  ): Promise<boolean> {
    // SUPER_ADMIN has full access to all granted operations
    if (role === 'SUPER_ADMIN') {
      return true;
    }

    // Check company-specific database override if available
    let override: { isGranted: boolean } | null = null;
    try {
      override = await prisma.rolePermission.findUnique({
        where: {
          companyId_role_module_action: {
            companyId,
            role,
            module,
            action,
          },
        },
      });
    } catch (error) {
      // SEC-11-01 FAIL-CLOSED SECURITY FIX:
      // An infrastructure error (connection failure, timeout, pool exhaustion, or database unavailable)
      // must securely fail closed and deny access. Falling back to static defaults after a DB error
      // would bypass explicit company DENY overrides (isGranted: false).
      const safeErrorMessage = error instanceof Error ? error.message : 'Unknown database error';
      console.error(
        `[SECURITY ERROR] Database error evaluating permission for companyId=${companyId}, role=${role}, module=${module}, action=${action}: ${safeErrorMessage}. Failing closed (DENY).`
      );
      return false;
    }

    if (override !== null) {
      return override.isGranted;
    }

    // Default permission lookup when no override exists and database query succeeded
    const roleModuleActions = DEFAULT_ROLE_PERMISSIONS[role]?.[module] || [];
    return roleModuleActions.includes(action);
  }

  /**
   * Evaluates if actor is authorized to assign targetRole to a user
   * Strictly prevents self-escalation and unauthorized SUPER_ADMIN granting
   */
  static canAssignRole(actorRole: Role, targetRole: Role): boolean {
    if (actorRole === 'SUPER_ADMIN') {
      return true;
    }

    if (actorRole === 'ADMIN') {
      // ADMIN can only manage ADMIN, VICE_ADMIN, EMPLOYEE - NEVER SUPER_ADMIN
      return targetRole !== 'SUPER_ADMIN';
    }

    // VICE_ADMIN and EMPLOYEE cannot assign or change roles
    return false;
  }

  /**
   * Returns complete permission matrix for a company across all roles
   */
  static async getCompanyPermissionMatrix(companyId: string) {
    const roles: Role[] = ['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE'];
    const modules: AppModule[] = [
      'COMPANY',
      'USER',
      'ROLE_PERMISSION',
      'AUDIT_LOG',
      'FISCAL_PERIOD',
      'CURRENCY',
      'ACCOUNTING',
      'QUOTATION',
      'CUSTOMER',
      'INVOICE',
      'RECEIPT',
      'EMPLOYEE',
      'DEPARTMENT',
      'DESIGNATION',
      'PAYROLL',
      'ATTENDANCE',
      'BIOMETRIC',
    ];
    const actions: AppAction[] = ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'];

    // Fetch any customized database overrides
    const overrides = await prisma.rolePermission.findMany({
      where: { companyId },
    }).catch(() => []);

    const matrix: Record<Role, Record<AppModule, Record<AppAction, boolean>>> = {
      SUPER_ADMIN: {} as Record<AppModule, Record<AppAction, boolean>>,
      ADMIN: {} as Record<AppModule, Record<AppAction, boolean>>,
      VICE_ADMIN: {} as Record<AppModule, Record<AppAction, boolean>>,
      EMPLOYEE: {} as Record<AppModule, Record<AppAction, boolean>>,
    };

    for (const role of roles) {
      matrix[role] = {} as Record<AppModule, Record<AppAction, boolean>>;
      for (const mod of modules) {
        matrix[role][mod] = {} as Record<AppAction, boolean>;
        for (const act of actions) {
          const custom = overrides.find(
            (o) => o.role === role && o.module === mod && o.action === act
          );

          if (custom !== undefined) {
            matrix[role][mod][act] = custom.isGranted;
          } else {
            const defaults = DEFAULT_ROLE_PERMISSIONS[role]?.[mod] || [];
            matrix[role][mod][act] = defaults.includes(act);
          }
        }
      }
    }

    return matrix;
  }
}
