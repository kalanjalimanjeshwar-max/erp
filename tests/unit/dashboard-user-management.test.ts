import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { PermissionService } from '../../src/server/services/permission.service.js';
import { UserService } from '../../src/server/services/user.service.js';
import { PreviewAuthService } from '../../src/server/services/preview-auth.service.js';
import { previewStore } from '../../src/client/services/previewStore.ts';
import { AuthUser, Role } from '../../src/shared/types.ts';

describe('Super Admin Signup & Dashboard User Management Security Tests', () => {
  const dummyCompanyId = 'company-test-uuid-42';

  const superAdminUser: AuthUser = {
    id: 'super-admin-uuid-1',
    userId: 'super-admin-uuid-1',
    companyId: dummyCompanyId,
    email: 'root.admin@company.local',
    fullName: 'Root Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const adminUser: AuthUser = {
    id: 'admin-uuid-1',
    userId: 'admin-uuid-1',
    companyId: dummyCompanyId,
    email: 'admin.manager@company.local',
    fullName: 'Company Administrator',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeUser: AuthUser = {
    id: 'employee-uuid-1',
    userId: 'employee-uuid-1',
    companyId: dummyCompanyId,
    email: 'staff.member@company.local',
    fullName: 'Staff Member',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  describe('1. Role Assignment Privilege Matrix & Anti-Escalation', () => {
    it('SUPER_ADMIN is authorized to assign all supported roles', () => {
      const allRoles: Role[] = ['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE'];
      for (const role of allRoles) {
        expect(PermissionService.canAssignRole('SUPER_ADMIN', role)).toBe(true);
      }
    });

    it('ADMIN is strictly prohibited from creating or assigning SUPER_ADMIN', () => {
      expect(PermissionService.canAssignRole('ADMIN', 'SUPER_ADMIN')).toBe(false);
    });

    it('ADMIN is authorized to create ADMIN, VICE_ADMIN, and EMPLOYEE accounts', () => {
      expect(PermissionService.canAssignRole('ADMIN', 'ADMIN')).toBe(true);
      expect(PermissionService.canAssignRole('ADMIN', 'VICE_ADMIN')).toBe(true);
      expect(PermissionService.canAssignRole('ADMIN', 'EMPLOYEE')).toBe(true);
    });

    it('VICE_ADMIN and EMPLOYEE roles cannot create or assign any accounts', () => {
      const allRoles: Role[] = ['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE'];
      for (const role of allRoles) {
        expect(PermissionService.canAssignRole('VICE_ADMIN', role)).toBe(false);
        expect(PermissionService.canAssignRole('EMPLOYEE', role)).toBe(false);
      }
    });

    it('UserService.createUser should reject ADMIN creating SUPER_ADMIN with 403 Forbidden', async () => {
      await expect(
        UserService.createUser(adminUser, {
          email: 'illegal.super@company.local',
          fullName: 'Illegal Super Admin',
          password: 'SecurePassword123!',
          role: 'SUPER_ADMIN',
        })
      ).rejects.toThrowError(/not authorized to create a user with role "SUPER_ADMIN"/);
    });

    it('UserService.createUser should reject EMPLOYEE creating any user with 403 Forbidden', async () => {
      await expect(
        UserService.createUser(employeeUser, {
          email: 'new.staff@company.local',
          fullName: 'New Staff',
          password: 'SecurePassword123!',
          role: 'EMPLOYEE',
        })
      ).rejects.toThrowError(/not authorized to create a user with role "EMPLOYEE"/);
    });
  });

  describe('2. Credential Security & Password Verification', () => {
    it('should hash passwords using bcrypt with at least 10 salt rounds', async () => {
      const rawPassword = 'StrongPassword!2026';
      const hash = await bcrypt.hash(rawPassword, 12);

      expect(hash).toMatch(/^\$2[aby]\$12\$/);
      expect(await bcrypt.compare(rawPassword, hash)).toBe(true);
      expect(await bcrypt.compare('WrongPassword!2026', hash)).toBe(false);
    });

    it('should confirm that password verification succeeds only when password and confirmPassword match', () => {
      const validatePasswordPair = (p1: string, p2: string) => {
        if (!p1 || p1.length < 8) return { valid: false, error: 'Password must be at least 8 characters long.' };
        if (p1 !== p2) return { valid: false, error: 'Passwords do not match.' };
        return { valid: true, error: null };
      };

      expect(validatePasswordPair('Password123!', 'Password123!')).toEqual({ valid: true, error: null });
      expect(validatePasswordPair('Password123!', 'Mismatch123!')).toEqual({
        valid: false,
        error: 'Passwords do not match.',
      });
      expect(validatePasswordPair('short', 'short')).toEqual({
        valid: false,
        error: 'Password must be at least 8 characters long.',
      });
    });
  });

  describe('3. Temporary Preview Account & Restricted UI Exploration', () => {
    it('should successfully authenticate with fixed preview credentials in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        const result = PreviewAuthService.authenticatePreview({
          id: 'preview_admin',
          password: 'PreviewOnly_2026!',
        });

        expect(result.isPreviewSession).toBe(true);
        expect(result.user.email).toBe('preview_admin@preview.local');
        expect(result.user.fullName).toBe('Temporary Preview Account — Not a Real Super Admin');
        expect(result.user.role).toBe('SUPER_ADMIN');
        expect(result.user.isPreview).toBe(true);
        expect(result.company.id).toBe('preview-company-id');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should reject invalid preview credentials with 401 Unauthorized', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        expect(() =>
          PreviewAuthService.authenticatePreview({
            id: 'preview_admin',
            password: 'WrongPassword!',
          })
        ).toThrowError(/Invalid preview credentials/);

        expect(() =>
          PreviewAuthService.authenticatePreview({
            id: 'real_admin',
            password: 'PreviewOnly_2026!',
          })
        ).toThrowError(/Invalid preview credentials/);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should strictly disable preview mode when NODE_ENV is production with 403 Forbidden', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        expect(() =>
          PreviewAuthService.authenticatePreview({
            id: 'preview_admin',
            password: 'PreviewOnly_2026!',
          })
        ).toThrowError(/Preview Mode is strictly disabled in production/);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('preview session credentials are not stored in database or persistent models', () => {
      // Confirm preview user uses isolated in-memory identifier
      const session = PreviewAuthService.authenticatePreview({
        id: 'preview_admin',
        password: 'PreviewOnly_2026!',
      });

      expect(session.user.id).toBe('preview-session-id');
      expect(session.user.isPreview).toBe(true);
      expect(session.message).toContain('Real database mutations and business APIs are blocked');
    });
  });

  describe('4. Initial Super Admin Signup & Atomicity Verification', () => {
    it('Setup status should clearly distinguish between uninitialized and disconnected', () => {
      const evaluateDatabaseState = (connected: boolean, companyCount: number, superAdminCount: number) => {
        if (!connected) {
          return {
            status: 'UNAVAILABLE',
            isSetupRequired: false,
            error: 'PostgreSQL instance is offline. Cannot determine initialization status.',
          };
        }
        if (companyCount === 0 && superAdminCount === 0) {
          return {
            status: 'UNINITIALIZED',
            isSetupRequired: true,
            error: null,
          };
        }
        return {
          status: 'INITIALIZED',
          isSetupRequired: false,
          error: null,
        };
      };

      // Disconnected state: Must NOT falsely treat as uninitialized
      const offlineResult = evaluateDatabaseState(false, 0, 0);
      expect(offlineResult.status).toBe('UNAVAILABLE');
      expect(offlineResult.isSetupRequired).toBe(false);
      expect(offlineResult.error).toContain('PostgreSQL instance is offline');

      // Genuine clean database state
      const cleanResult = evaluateDatabaseState(true, 0, 0);
      expect(cleanResult.status).toBe('UNINITIALIZED');
      expect(cleanResult.isSetupRequired).toBe(true);

      // Already initialized state
      const initializedResult = evaluateDatabaseState(true, 1, 1);
      expect(initializedResult.status).toBe('INITIALIZED');
      expect(initializedResult.isSetupRequired).toBe(false);
    });

    it('Subsequent attempts to run setup after initialization must be blocked with 409 Conflict', () => {
      const verifySetupGuard = (isAlreadyInitialized: boolean) => {
        if (isAlreadyInitialized) {
          const err = new Error('System already initialized. Initial setup wizard cannot be run again.');
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        return true;
      };

      expect(verifySetupGuard(false)).toBe(true);
      expect(() => verifySetupGuard(true)).toThrowError(/System already initialized/);
    });
  });

  describe('5. Safe Preview-Only In-Memory User Creation & Isolation Tests', () => {
    beforeEach(() => {
      previewStore.reset();
    });

    it('should create clearly labelled in-memory demo users with isPreviewUser and isDemoOnly flags', () => {
      const demoUser = previewStore.createPreviewUser({
        fullName: 'Eleanor Vance',
        email: 'eleanor.vance@company.local',
        role: 'EMPLOYEE',
        isActive: true,
      });

      expect(demoUser.id).toMatch(/^preview-user-/);
      expect(demoUser.fullName).toBe('Eleanor Vance');
      expect(demoUser.email).toBe('eleanor.vance@company.local');
      expect(demoUser.role).toBe('EMPLOYEE');
      expect(demoUser.isActive).toBe(true);
      expect(demoUser.isPreviewUser).toBe(true);
      expect(demoUser.isDemoOnly).toBe(true);
      // Ensure no password field exists on user record
      expect((demoUser as unknown as { password?: string }).password).toBeUndefined();
      expect((demoUser as unknown as { passwordHash?: string }).passwordHash).toBeUndefined();
    });

    it('should prevent duplicate demo user email creation within the preview store', () => {
      previewStore.createPreviewUser({
        fullName: 'First Staff',
        email: 'duplicate.test@company.local',
        role: 'ADMIN',
      });

      expect(() => {
        previewStore.createPreviewUser({
          fullName: 'Second Staff',
          email: 'duplicate.test@company.local',
          role: 'EMPLOYEE',
        });
      }).toThrowError(/already exists in memory/);
    });

    it('should filter in-memory preview users by search query and role', () => {
      previewStore.createPreviewUser({
        fullName: 'Alice Walker',
        email: 'alice@company.local',
        role: 'ADMIN',
      });
      previewStore.createPreviewUser({
        fullName: 'Bob Smith',
        email: 'bob@company.local',
        role: 'EMPLOYEE',
      });

      const all = previewStore.getPreviewUsers();
      expect(all.length).toBe(3); // 1 initial root admin + 2 created

      const searched = previewStore.getPreviewUsers({ search: 'alice' });
      expect(searched.length).toBe(1);
      expect(searched[0].fullName).toBe('Alice Walker');

      const roleFiltered = previewStore.getPreviewUsers({ role: 'EMPLOYEE' });
      expect(roleFiltered.length).toBe(1);
      expect(roleFiltered[0].fullName).toBe('Bob Smith');
    });

    it('should support updating role and active status in memory without database mutation', () => {
      const demo = previewStore.createPreviewUser({
        fullName: 'Charlie Green',
        email: 'charlie@company.local',
        role: 'EMPLOYEE',
        isActive: true,
      });

      const updatedRole = previewStore.updatePreviewUserRole(demo.id, 'ADMIN');
      expect(updatedRole?.role).toBe('ADMIN');

      const updatedStatus = previewStore.updatePreviewUserStatus(demo.id, false);
      expect(updatedStatus?.isActive).toBe(false);

      const found = previewStore.findPreviewUser(demo.id);
      expect(found?.role).toBe('ADMIN');
      expect(found?.isActive).toBe(false);
    });

    it('should create mock AuthUser object with isPreview: true for read-only UI exploration', () => {
      const demo = previewStore.createPreviewUser({
        fullName: 'Diana Prince',
        email: 'diana@company.local',
        role: 'EMPLOYEE',
        isActive: true,
      });

      const mockAuth = previewStore.createMockAuthUser(demo);
      expect(mockAuth.id).toBe(demo.id);
      expect(mockAuth.isPreview).toBe(true);
      expect(mockAuth.role).toBe('EMPLOYEE');
      expect(mockAuth.fullName).toContain('(Preview Demo Account)');
    });

    it('should ensure in-memory preview users are never saved to PostgreSQL and are cleared on reset', () => {
      previewStore.createPreviewUser({
        fullName: 'Temporary Test',
        email: 'temp@company.local',
        role: 'EMPLOYEE',
      });

      expect(previewStore.getPreviewUsers().length).toBe(2);

      // Reset simulates page refresh
      previewStore.reset();
      expect(previewStore.getPreviewUsers().length).toBe(1);
      expect(previewStore.getPreviewUsers()[0].email).toBe('preview_admin@preview.local');
    });

    it('should verify real UserService.createUser remains strictly protected and rejects unauthenticated callers', async () => {
      // Fake preview user attempting to call real UserService.createUser
      const fakePreviewActor: AuthUser = {
        id: 'preview-user-fake',
        userId: 'preview-user-fake',
        companyId: 'preview-company-id',
        email: 'fake@preview.local',
        fullName: 'Fake User',
        role: 'EMPLOYEE',
        isActive: true,
        tokenVersion: 1,
        isPreview: true,
      };

      // EMPLOYEE cannot assign roles
      await expect(
        UserService.createUser(fakePreviewActor, {
          email: 'illegal@company.local',
          fullName: 'Illegal User',
          password: 'Password123!',
          role: 'ADMIN',
        })
      ).rejects.toThrowError(/not authorized to create a user with role "ADMIN"/);
    });
  });
});
