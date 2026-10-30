import { describe, it, expect } from 'vitest';
import { PermissionService } from '../../src/server/services/permission.service.js';
import { UserService } from '../../src/server/services/user.service.js';
import { AuthUser, Role } from '../../src/shared/types.ts';

describe('Phase 3 Permission Matrix & RBAC Hierarchy Tests', () => {
  const dummyCompanyId = 'company-test-uuid-1';

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

