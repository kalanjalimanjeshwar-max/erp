import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionService } from '../../src/server/services/permission.service.js';
import { UserService } from '../../src/server/services/user.service.js';
import { AuthUser, Role } from '../../src/shared/types.ts';
import { prisma } from '../../src/server/db/client.js';

vi.mock('../../src/server/db/client.js', () => ({
  prisma: {
    rolePermission: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

describe('Phase 3 Permission Matrix & RBAC Hierarchy Tests', () => {
  const dummyCompanyId = 'company-test-uuid-1';

  beforeEach(() => {
    vi.mocked(prisma.rolePermission.findUnique).mockReset();
    vi.mocked(prisma.rolePermission.findUnique).mockResolvedValue(null);
  });

  it('SUPER_ADMIN should have full permissions across all modules and actions', async () => {
    const modules = ['COMPANY', 'USER', 'ROLE_PERMISSION', 'AUDIT_LOG', 'ACCOUNTING', 'PAYROLL'] as const;
    const actions = ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'] as const;

    for (const mod of modules) {
      for (const act of actions) {
        const isGranted = await PermissionService.hasPermission(dummyCompanyId, 'SUPER_ADMIN', mod, act);
        expect(isGranted).toBe(true);
      }
    }
  });

  it('ADMIN role should have operational management but restricted administrative ceilings', async () => {
    // ADMIN can view, create, edit users and deactive
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'USER', 'VIEW')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'USER', 'CREATE')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'USER', 'EDIT')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'USER', 'DEACTIVATE')).toBe(true);

    // ADMIN cannot delete users (only soft deactivation allowed)
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'USER', 'DELETE')).toBe(false);

    // ADMIN cannot delete company or grant role permissions
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'COMPANY', 'DELETE')).toBe(false);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'ROLE_PERMISSION', 'DELETE')).toBe(false);
  });

  it('VICE_ADMIN role should be restricted to baseline view and explicit grants', async () => {
    // Cannot delete or create users by default
    expect(await PermissionService.hasPermission(dummyCompanyId, 'VICE_ADMIN', 'USER', 'DELETE')).toBe(false);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'VICE_ADMIN', 'USER', 'CREATE')).toBe(false);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'VICE_ADMIN', 'ROLE_PERMISSION', 'EDIT')).toBe(false);
  });

  it('EMPLOYEE role must be blocked from all administrative modules', async () => {
    // Cannot view or edit other users
    expect(await PermissionService.hasPermission(dummyCompanyId, 'EMPLOYEE', 'USER', 'VIEW')).toBe(false);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'EMPLOYEE', 'USER', 'CREATE')).toBe(false);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'EMPLOYEE', 'USER', 'EDIT')).toBe(false);

    // Cannot access audit logs or company configuration
    expect(await PermissionService.hasPermission(dummyCompanyId, 'EMPLOYEE', 'AUDIT_LOG', 'VIEW')).toBe(false);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'EMPLOYEE', 'COMPANY', 'EDIT')).toBe(false);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'EMPLOYEE', 'ROLE_PERMISSION', 'VIEW')).toBe(false);
  });

  it('should enforce role assignment hierarchy (ADMIN cannot create/assign SUPER_ADMIN)', () => {
    // SUPER_ADMIN can assign any role
    expect(PermissionService.canAssignRole('SUPER_ADMIN', 'SUPER_ADMIN')).toBe(true);
    expect(PermissionService.canAssignRole('SUPER_ADMIN', 'ADMIN')).toBe(true);
    expect(PermissionService.canAssignRole('SUPER_ADMIN', 'VICE_ADMIN')).toBe(true);
    expect(PermissionService.canAssignRole('SUPER_ADMIN', 'EMPLOYEE')).toBe(true);

    // ADMIN cannot assign SUPER_ADMIN
    expect(PermissionService.canAssignRole('ADMIN', 'SUPER_ADMIN')).toBe(false);
    expect(PermissionService.canAssignRole('ADMIN', 'ADMIN')).toBe(true);
    expect(PermissionService.canAssignRole('ADMIN', 'VICE_ADMIN')).toBe(true);
    expect(PermissionService.canAssignRole('ADMIN', 'EMPLOYEE')).toBe(true);

    // VICE_ADMIN and EMPLOYEE cannot assign any roles
    expect(PermissionService.canAssignRole('VICE_ADMIN', 'EMPLOYEE')).toBe(false);
    expect(PermissionService.canAssignRole('EMPLOYEE', 'EMPLOYEE')).toBe(false);
  });

  it('should prevent self-escalation when modifying user role', async () => {
    const adminUser: AuthUser = {
      id: 'admin-uuid-1',
      userId: 'admin-uuid-1',
      companyId: dummyCompanyId,
      email: 'admin@corp.local',
      fullName: 'Admin User',
      role: 'ADMIN',
      isActive: true,
      tokenVersion: 1,
    };

    // Attempting to elevate own role from ADMIN to SUPER_ADMIN
    await expect(
      UserService.updateUserRole(adminUser, adminUser.id, 'SUPER_ADMIN')
    ).rejects.toThrowError(/not permitted to elevate or change their own role/);
  });

  it('should enforce Phase 8.1 BIOMETRIC permissions across all roles', async () => {
    // SUPER_ADMIN has full biometric permissions
    expect(await PermissionService.hasPermission(dummyCompanyId, 'SUPER_ADMIN', 'BIOMETRIC', 'VIEW')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'SUPER_ADMIN', 'BIOMETRIC', 'CREATE')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'SUPER_ADMIN', 'BIOMETRIC', 'EDIT')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'SUPER_ADMIN', 'BIOMETRIC', 'DEACTIVATE')).toBe(true);

    // ADMIN has operational device management
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'BIOMETRIC', 'VIEW')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'BIOMETRIC', 'CREATE')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'BIOMETRIC', 'EDIT')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'BIOMETRIC', 'DEACTIVATE')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'ADMIN', 'BIOMETRIC', 'DELETE')).toBe(false);

    // VICE_ADMIN has view only
    expect(await PermissionService.hasPermission(dummyCompanyId, 'VICE_ADMIN', 'BIOMETRIC', 'VIEW')).toBe(true);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'VICE_ADMIN', 'BIOMETRIC', 'CREATE')).toBe(false);

    // EMPLOYEE is blocked from biometric management
    expect(await PermissionService.hasPermission(dummyCompanyId, 'EMPLOYEE', 'BIOMETRIC', 'VIEW')).toBe(false);
    expect(await PermissionService.hasPermission(dummyCompanyId, 'EMPLOYEE', 'BIOMETRIC', 'CREATE')).toBe(false);
  });
});

describe('SEC-11-01 Critical Fail-Closed RBAC & Override Precedence Tests', () => {
  const companyA = 'company-tenant-alpha-uuid';
  const companyB = 'company-tenant-beta-uuid';

  beforeEach(() => {
    vi.mocked(prisma.rolePermission.findUnique).mockReset();
    vi.mocked(prisma.rolePermission.findUnique).mockResolvedValue(null);
  });

  it('Requirement A: Existing default permission is granted when no override exists and DB query succeeds', async () => {
    // ADMIN has USER:VIEW by default in DEFAULT_ROLE_PERMISSIONS
    vi.mocked(prisma.rolePermission.findUnique).mockResolvedValue(null);
    const result = await PermissionService.hasPermission(companyA, 'ADMIN', 'USER', 'VIEW');
    expect(result).toBe(true);
    expect(prisma.rolePermission.findUnique).toHaveBeenCalledWith({
      where: {
        companyId_role_module_action: {
          companyId: companyA,
          role: 'ADMIN',
          module: 'USER',
          action: 'VIEW',
        },
      },
    });
  });

  it('Requirement B: Explicit isGranted=false overrides a permission that would otherwise be granted by static defaults', async () => {
    // ADMIN normally has USER:VIEW (default true), but company A explicitly DENIES it
    vi.mocked(prisma.rolePermission.findUnique).mockResolvedValue({
      id: 'override-1',
      companyId: companyA,
      role: 'ADMIN',
      module: 'USER',
      action: 'VIEW',
      isGranted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const result = await PermissionService.hasPermission(companyA, 'ADMIN', 'USER', 'VIEW');
    expect(result).toBe(false);
  });

  it('Requirement C: Explicit isGranted=true grants a permission not included in static defaults', async () => {
    // EMPLOYEE normally cannot VIEW AUDIT_LOG (default false), but company A explicitly GRANTS it
    vi.mocked(prisma.rolePermission.findUnique).mockResolvedValue({
      id: 'override-2',
      companyId: companyA,
      role: 'EMPLOYEE',
      module: 'AUDIT_LOG',
      action: 'VIEW',
      isGranted: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const result = await PermissionService.hasPermission(companyA, 'EMPLOYEE', 'AUDIT_LOG', 'VIEW');
    expect(result).toBe(true);
  });

  it('Requirement D: A database query exception causes hasPermission() to return false (Fail-Closed)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.rolePermission.findUnique).mockRejectedValue(
      new Error('Connection terminated unexpectedly: ECONNRESET')
    );

    // ADMIN normally has USER:VIEW in defaults, but under DB error it MUST FAIL CLOSED (false)
    const result = await PermissionService.hasPermission(companyA, 'ADMIN', 'USER', 'VIEW');
    expect(result).toBe(false);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedMessage = consoleErrorSpy.mock.calls[0]?.[0] || '';
    expect(loggedMessage).toContain('[SECURITY ERROR]');
    expect(loggedMessage).toContain('ECONNRESET');
    expect(loggedMessage).toContain('Failing closed (DENY)');

    consoleErrorSpy.mockRestore();
  });

  it('Requirement E: Database timeout/unavailable conditions also fail closed', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.rolePermission.findUnique).mockRejectedValue(
      new Error('PrismaClientKnownRequestError: Can\'t reach database server at localhost:5432')
    );

    const result = await PermissionService.hasPermission(companyA, 'ADMIN', 'ACCOUNTING', 'APPROVE');
    expect(result).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it('Requirement F: A database error never causes fallback to DEFAULT_ROLE_PERMISSIONS', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.rolePermission.findUnique).mockRejectedValue(
      new Error('Deadlock detected during lock acquisition')
    );

    // Multiple modules normally granted to ADMIN must all evaluate to false
    expect(await PermissionService.hasPermission(companyA, 'ADMIN', 'COMPANY', 'VIEW')).toBe(false);
    expect(await PermissionService.hasPermission(companyA, 'ADMIN', 'ACCOUNTING', 'VIEW')).toBe(false);
    expect(await PermissionService.hasPermission(companyA, 'ADMIN', 'PAYROLL', 'VIEW')).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it('Requirement G: Company A permission overrides do not affect Company B', async () => {
    // Company A has an explicit DENY on USER:VIEW for ADMIN
    // Company B has NO override (null)
    (prisma.rolePermission.findUnique as any).mockImplementation(async (args: any) => {
      if (args.where.companyId_role_module_action.companyId === companyA) {
        return { isGranted: false };
      }
      return null;
    });

    const companyAResult = await PermissionService.hasPermission(companyA, 'ADMIN', 'USER', 'VIEW');
    const companyBResult = await PermissionService.hasPermission(companyB, 'ADMIN', 'USER', 'VIEW');

    expect(companyAResult).toBe(false); // Denied by Company A's explicit override
    expect(companyBResult).toBe(true);  // Allowed by default for Company B
  });

  it('Requirement H: Existing SUPER_ADMIN behavior remains unconditionally granted without reaching DB', async () => {
    // Even if DB throws or is down, SUPER_ADMIN must bypass without querying DB
    vi.mocked(prisma.rolePermission.findUnique).mockRejectedValue(
      new Error('Fatal DB crash that would block normal users')
    );

    const result = await PermissionService.hasPermission(companyA, 'SUPER_ADMIN', 'COMPANY', 'DELETE');
    expect(result).toBe(true);
    expect(prisma.rolePermission.findUnique).not.toHaveBeenCalled();
  });

  it('Safe error logging: Database error logs do not expose secrets or personal tokens', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(prisma.rolePermission.findUnique).mockRejectedValue(
      new Error('Connection failure on pool socket')
    );

    await PermissionService.hasPermission(companyA, 'ADMIN', 'USER', 'EDIT');

    expect(consoleErrorSpy).toHaveBeenCalled();
    const logOutput = consoleErrorSpy.mock.calls[0]?.[0] as string;
    expect(logOutput).not.toMatch(/password/i);
    expect(logOutput).not.toMatch(/token/i);
    expect(logOutput).not.toMatch(/secret/i);
    expect(logOutput).toContain(`companyId=${companyA}`);
    expect(logOutput).toContain('role=ADMIN');
    expect(logOutput).toContain('module=USER');
    expect(logOutput).toContain('action=EDIT');

    consoleErrorSpy.mockRestore();
  });
});

describe('SEC-11-02 Complete Permission Matrix Module Coverage Tests', () => {
  const companyTestId = 'company-test-matrix-uuid';

  const ALL_17_MODULES = [
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
  ] as const;

  const PREVIOUSLY_MISSING_7_MODULES = [
    'QUOTATION',
    'CUSTOMER',
    'INVOICE',
    'RECEIPT',
    'EMPLOYEE',
    'DEPARTMENT',
    'DESIGNATION',
  ] as const;

  const ORIGINAL_10_MODULES = [
    'COMPANY',
    'USER',
    'ROLE_PERMISSION',
    'AUDIT_LOG',
    'FISCAL_PERIOD',
    'CURRENCY',
    'ACCOUNTING',
    'PAYROLL',
    'ATTENDANCE',
    'BIOMETRIC',
  ] as const;

  const ALL_6_ACTIONS = ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'DEACTIVATE', 'DELETE'] as const;

  beforeEach(() => {
    vi.mocked(prisma.rolePermission.findMany).mockReset();
    vi.mocked(prisma.rolePermission.findMany).mockResolvedValue([]);
  });

  it('Requirement A & B: getCompanyPermissionMatrix returns all 17 registered modules including the 7 missing ones', async () => {
    const matrix = await PermissionService.getCompanyPermissionMatrix(companyTestId);

    for (const role of ['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE'] as const) {
      expect(matrix).toHaveProperty(role);
      const roleModules = Object.keys(matrix[role]);
      expect(roleModules).toHaveLength(17);

      for (const mod of ALL_17_MODULES) {
        expect(matrix[role]).toHaveProperty(mod);
      }

      for (const missingMod of PREVIOUSLY_MISSING_7_MODULES) {
        expect(matrix[role]).toHaveProperty(missingMod);
      }
    }
  });

  it('Requirement C: None of the original 10 modules disappeared', async () => {
    const matrix = await PermissionService.getCompanyPermissionMatrix(companyTestId);

    for (const origMod of ORIGINAL_10_MODULES) {
      expect(matrix.ADMIN).toHaveProperty(origMod);
      expect(matrix.SUPER_ADMIN).toHaveProperty(origMod);
      expect(matrix.VICE_ADMIN).toHaveProperty(origMod);
      expect(matrix.EMPLOYEE).toHaveProperty(origMod);
    }
  });

  it('Requirement D: Each of the 17 modules contains all 6 AppAction keys', async () => {
    const matrix = await PermissionService.getCompanyPermissionMatrix(companyTestId);

    for (const mod of ALL_17_MODULES) {
      for (const act of ALL_6_ACTIONS) {
        expect(typeof matrix.ADMIN[mod][act]).toBe('boolean');
        expect(typeof matrix.EMPLOYEE[mod][act]).toBe('boolean');
        expect(typeof matrix.VICE_ADMIN[mod][act]).toBe('boolean');
        expect(typeof matrix.SUPER_ADMIN[mod][act]).toBe('boolean');
      }
    }
  });

  it('Requirement E & F: Company-specific overrides on previously missing modules are correctly reflected (including explicit DENY)', async () => {
    // Override: Company explicitly DENIES INVOICE:APPROVE for ADMIN and GRANTS CUSTOMER:VIEW to EMPLOYEE
    vi.mocked(prisma.rolePermission.findMany).mockResolvedValue([
      {
        id: 'ov-1',
        companyId: companyTestId,
        role: 'ADMIN',
        module: 'INVOICE',
        action: 'APPROVE',
        isGranted: false, // Explicit DENY
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
      {
        id: 'ov-2',
        companyId: companyTestId,
        role: 'EMPLOYEE',
        module: 'CUSTOMER',
        action: 'VIEW',
        isGranted: true, // Explicit GRANT
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
    ]);

    const matrix = await PermissionService.getCompanyPermissionMatrix(companyTestId);

    // Overridden action is DENIED
    expect(matrix.ADMIN.INVOICE.APPROVE).toBe(false);

    // Overridden action is GRANTED
    expect(matrix.EMPLOYEE.CUSTOMER.VIEW).toBe(true);

    // Unoverridden action remains default (INVOICE:VIEW is true for ADMIN)
    expect(matrix.ADMIN.INVOICE.VIEW).toBe(true);
  });

  it('Requirement G & H: Inherited defaults and reset-to-default accurately match DEFAULT_ROLE_PERMISSIONS', async () => {
    // When no overrides exist in DB (empty list)
    vi.mocked(prisma.rolePermission.findMany).mockResolvedValue([]);

    const matrix = await PermissionService.getCompanyPermissionMatrix(companyTestId);

    // Check newly exposed modules against defaults:
    // ADMIN has QUOTATION: ['VIEW', 'CREATE', 'EDIT', 'APPROVE']
    expect(matrix.ADMIN.QUOTATION.VIEW).toBe(true);
    expect(matrix.ADMIN.QUOTATION.CREATE).toBe(true);
    expect(matrix.ADMIN.QUOTATION.EDIT).toBe(true);
    expect(matrix.ADMIN.QUOTATION.APPROVE).toBe(true);
    expect(matrix.ADMIN.QUOTATION.DEACTIVATE).toBe(false);
    expect(matrix.ADMIN.QUOTATION.DELETE).toBe(false);

    // EMPLOYEE has no QUOTATION permissions by default
    expect(matrix.EMPLOYEE.QUOTATION.VIEW).toBe(false);
    expect(matrix.EMPLOYEE.QUOTATION.CREATE).toBe(false);

    // SUPER_ADMIN has true for all actions across all modules except AUDIT_LOG where only VIEW is granted (immutable audit trail)
    for (const mod of ALL_17_MODULES) {
      for (const act of ALL_6_ACTIONS) {
        if (mod === 'AUDIT_LOG' && act !== 'VIEW') {
          expect(matrix.SUPER_ADMIN[mod][act]).toBe(false);
        } else {
          expect(matrix.SUPER_ADMIN[mod][act]).toBe(true);
        }
      }
    }
  });
});



