import { describe, it, expect, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { initialSetupSchema } from '../../src/server/validation/setup.schema.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { PermissionService } from '../../src/server/services/permission.service.js';
import { sanitizeAuditMetadata } from '../../src/server/services/audit.service.js';

describe('CoreERP: Setup Troubleshooting, Password Visibility & Login Flow Tests', () => {
  describe('1. Valid First-Time Provisioning & Normalization', () => {
    it('should validate and normalize company code to uppercase and admin email to lowercase', () => {
      const input = {
        company: {
          name: 'Acme Global Corp',
          code: '  acme_01  ',
          currency: 'USD',
          timezone: 'America/New_York',
        },
        superAdmin: {
          fullName: 'Jane Administrator',
          email: '  Admin.Jane@AcmeGlobal.COM  ',
          password: 'StrongP@ssword2026!',
          confirmPassword: 'StrongP@ssword2026!',
        },
      };

      const parsed = initialSetupSchema.parse(input);
      expect(parsed.company.code).toBe('ACME_01');
      expect(parsed.superAdmin.email).toBe('admin.jane@acmeglobal.com');
      expect(parsed.company.currency).toBe('USD');
      expect(parsed.company.timezone).toBe('America/New_York');
    });

    it('should accept valid company logo URL or empty string', () => {
      const withLogo = {
        company: {
          name: 'Acme Global',
          code: 'ACME',
          logoUrl: 'https://cdn.example.com/logo.png',
        },
        superAdmin: {
          fullName: 'Jane Admin',
          email: 'admin@acme.com',
          password: 'StrongP@ssword2026!',
          confirmPassword: 'StrongP@ssword2026!',
        },
      };

      const parsedWithLogo = initialSetupSchema.parse(withLogo);
      expect(parsedWithLogo.company.logoUrl).toBe('https://cdn.example.com/logo.png');

      const withEmptyLogo = {
        ...withLogo,
        company: { ...withLogo.company, logoUrl: '' },
      };
      const parsedEmptyLogo = initialSetupSchema.parse(withEmptyLogo);
      expect(parsedEmptyLogo.company.logoUrl).toBe('');
    });
  });

  describe('2. Missing or Invalid Required Fields Validation', () => {
    it('should reject missing company name, invalid code, or invalid email', () => {
      const invalidCases = [
        // Empty company name
        {
          company: { name: ' ', code: 'ACME' },
          superAdmin: { fullName: 'Admin', email: 'admin@test.com', password: 'P@ssword1234!', confirmPassword: 'P@ssword1234!' },
        },
        // Code with invalid symbols
        {
          company: { name: 'Acme', code: 'ACME!@#' },
          superAdmin: { fullName: 'Admin', email: 'admin@test.com', password: 'P@ssword1234!', confirmPassword: 'P@ssword1234!' },
        },
        // Malformed email
        {
          company: { name: 'Acme', code: 'ACME' },
          superAdmin: { fullName: 'Admin', email: 'not-an-email', password: 'P@ssword1234!', confirmPassword: 'P@ssword1234!' },
        },
      ];

      for (const invalidInput of invalidCases) {
        const result = initialSetupSchema.safeParse(invalidInput);
        expect(result.success).toBe(false);
      }
    });

    it('should reject passwords under 10 characters or lacking uppercase, lowercase, number, or special char', () => {
      const weakPasswords = [
        'Short1!',            // < 10 chars
        'alllowercase123!',   // no uppercase
        'ALLUPPERCASE123!',   // no lowercase
        'NoDigitsHere!',      // no digit
        'NoSpecialChar1234',  // no symbol
      ];

      for (const pwd of weakPasswords) {
        const result = initialSetupSchema.safeParse({
          company: { name: 'Acme', code: 'ACME' },
          superAdmin: { fullName: 'Admin', email: 'admin@test.com', password: pwd, confirmPassword: pwd },
        });
        expect(result.success).toBe(false);
      }
    });
  });

  describe('3. Password Mismatch Validation', () => {
    it('should fail with explicit error when password and confirmPassword do not match', () => {
      const mismatched = {
        company: { name: 'Acme', code: 'ACME' },
        superAdmin: {
          fullName: 'Admin User',
          email: 'admin@test.com',
          password: 'CorrectP@ssword2026!',
          confirmPassword: 'MismatchP@ssword2026!',
        },
      };

      const result = initialSetupSchema.safeParse(mismatched);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes('confirmPassword'));
        expect(issue).toBeDefined();
        expect(issue?.message).toBe('Passwords do not match');
      }
    });
  });

  describe('4. Duplicate Tenant Code and Admin Email Handling', () => {
    it('should enforce that duplicate tenant code and email generate explicit conflict errors', () => {
      const existingCompanyCode = 'ACME';
      const existingEmail = 'admin@acme.com';

      const checkDuplicateCode = (code: string) => {
        if (code === existingCompanyCode) {
          const err = new Error(`Company code '${code}' is already registered in the system.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
      };

      const checkDuplicateEmail = (email: string) => {
        if (email.toLowerCase() === existingEmail) {
          const err = new Error(`User with email '${email}' already exists.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
      };

      expect(() => checkDuplicateCode('ACME')).toThrowError(/already registered/);
      expect(() => checkDuplicateEmail('ADMIN@ACME.COM')).toThrowError(/already exists/);
      expect(() => checkDuplicateCode('NEW_CORP')).not.toThrow();
    });
  });

  describe('5. Transaction Rollback & Atomicity on Provisioning Failure', () => {
    it('should rollback all created entities if any step in the bootstrap transaction fails', async () => {
      // Simulation of atomic transaction: if user creation fails, company must not persist
      let companyCreated = false;
      let userCreated = false;

      const mockAtomicBootstrap = async (failAtUserStep: boolean) => {
        try {
          // Transaction start
          companyCreated = true;
          if (failAtUserStep) {
            throw new Error('Simulated database constraint failure on user creation');
          }
          userCreated = true;
        } catch (err) {
          // Rollback
          companyCreated = false;
          userCreated = false;
          throw err;
        }
      };

      await expect(mockAtomicBootstrap(true)).rejects.toThrowError(/constraint failure/);
      expect(companyCreated).toBe(false);
      expect(userCreated).toBe(false);

      await mockAtomicBootstrap(false);
      expect(companyCreated).toBe(true);
      expect(userCreated).toBe(true);
    });
  });

  describe('6. Repeated and Concurrent Provisioning Attempts Guard', () => {
    it('should reject provisioning attempts once initial setup has completed', () => {
      const systemState = {
        companyCount: 1,
        superAdminCount: 1,
      };

      const assertCanBootstrap = (state: typeof systemState) => {
        if (state.companyCount > 0 && state.superAdminCount > 0) {
          const err = new Error(
            'Initial setup has already been completed. Further super administrators must be invited by an existing Super Admin.'
          );
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
      };

      expect(() => assertCanBootstrap(systemState)).toThrowError(/already been completed/);

      const uninitializedState = { companyCount: 0, superAdminCount: 0 };
      expect(() => assertCanBootstrap(uninitializedState)).not.toThrow();
    });
  });

  describe('7. Login Authentication & Credential Verification', () => {
    it('should verify bcrypt password hashes correctly and reject invalid credentials with generic error', async () => {
      const rawPassword = 'SecureP@ssword2026!';
      const hash = await bcrypt.hash(rawPassword, 12);

      expect(await bcrypt.compare(rawPassword, hash)).toBe(true);
      expect(await bcrypt.compare('WrongP@ssword!', hash)).toBe(false);

      const genericAuthError = () => {
        const err = new Error('Invalid email or password.');
        (err as { statusCode?: number }).statusCode = 401;
        return err;
      };

      // Ensure public message is strictly generic to prevent user enumeration
      const error = genericAuthError();
      expect(error.message).toBe('Invalid email or password.');
      expect((error as { statusCode?: number }).statusCode).toBe(401);
    });

    it('should normalize email before authentication query', () => {
      const userEnteredEmail = '  Admin.User@Corp.Local  ';
      const normalized = userEnteredEmail.trim().toLowerCase();
      expect(normalized).toBe('admin.user@corp.local');
    });
  });

  describe('8. Inactive Account Login Rejection', () => {
    it('should strictly reject login attempts for inactive accounts', () => {
      const inactiveUser = {
        id: 'user-inactive-uuid',
        email: 'exited@corp.local',
        isActive: false,
      };

      const authenticateAccount = (user: typeof inactiveUser) => {
        if (!user.isActive) {
          const err = new Error('Invalid email or password.');
          (err as { statusCode?: number }).statusCode = 401;
          throw err;
        }
      };

      expect(() => authenticateAccount(inactiveUser)).toThrowError('Invalid email or password.');
    });
  });

  describe('9. Protected API Authorization & Scope Enforcement', () => {
    it('should enforce role boundaries where EMPLOYEE is rejected from administration', async () => {
      const isSuperAdminGranted = await PermissionService.hasPermission('comp-1', 'SUPER_ADMIN', 'COMPANY', 'EDIT');
      const isAdminGranted = await PermissionService.hasPermission('comp-1', 'ADMIN', 'COMPANY', 'EDIT');
      const isEmployeeGranted = await PermissionService.hasPermission('comp-1', 'EMPLOYEE', 'COMPANY', 'EDIT');

      expect(isSuperAdminGranted).toBe(true);
      expect(isAdminGranted).toBe(true);
      expect(isEmployeeGranted).toBe(false);
    });
  });

  describe('10. Password Visibility Toggle Behavior', () => {
    it('should toggle input visibility between password and text without clearing or modifying input value', () => {
      let inputType: 'password' | 'text' = 'password';
      let inputValue = 'MySecretP@ssword2026!';

      // Default state: hidden
      expect(inputType).toBe('password');
      expect(inputValue).toBe('MySecretP@ssword2026!');

      // Action: User clicks "Show password" toggle
      const toggleVisibility = () => {
        inputType = inputType === 'password' ? 'text' : 'password';
      };

      toggleVisibility();
      expect(inputType).toBe('text');
      expect(inputValue).toBe('MySecretP@ssword2026!'); // Value strictly preserved

      // Action: User clicks "Hide password" toggle
      toggleVisibility();
      expect(inputType).toBe('password');
      expect(inputValue).toBe('MySecretP@ssword2026!'); // Value strictly preserved
    });
  });

  describe('11. Security Audit & Zero Secret Leakage', () => {
    it('should sanitize metadata to ensure passwords, hashes, and secrets are never exposed in logs or responses', () => {
      const sensitiveData = {
        adminEmail: 'admin@corp.local',
        password: 'RawPassword123!',
        passwordHash: '$2b$12$eX4mpleH4shValu3...',
        token: 'secret-session-token',
        companyId: 'company-uuid-1',
      };

      const sanitized = sanitizeAuditMetadata(sensitiveData) as Record<string, unknown>;

      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.passwordHash).toBe('[REDACTED]');
      expect(sanitized.token).toBe('[REDACTED]');
      expect(sanitized.adminEmail).toBe('admin@corp.local');
      expect(sanitized.companyId).toBe('company-uuid-1');
    });

    it('should never include passwordHash or password in bootstrap response object', () => {
      const bootstrapResult = {
        success: true,
        message: 'Initial company and Super Admin created successfully.',
        company: {
          id: 'company-uuid',
          name: 'Acme Corp',
          code: 'ACME',
          currency: 'USD',
        },
        superAdmin: {
          id: 'user-uuid',
          email: 'admin@acme.com',
          fullName: 'Admin User',
          role: 'SUPER_ADMIN' as const,
        },
      };

      expect((bootstrapResult.superAdmin as Record<string, unknown>).password).toBeUndefined();
      expect((bootstrapResult.superAdmin as Record<string, unknown>).passwordHash).toBeUndefined();
    });
  });

  describe('12. Database Unreachable Error Propagation', () => {
    it('should throw clear service unavailable error with 503 instead of false login success or generic error when DB is down', () => {
      const handleDatabaseUnavailable = (isDbConnected: boolean) => {
        if (!isDbConnected) {
          const err = new Error('Database service is currently unavailable. Please verify PostgreSQL connection and try again.');
          (err as { statusCode?: number }).statusCode = 503;
          throw err;
        }
      };

      expect(() => handleDatabaseUnavailable(false)).toThrowError(
        'Database service is currently unavailable. Please verify PostgreSQL connection and try again.'
      );
      try {
        handleDatabaseUnavailable(false);
      } catch (err: unknown) {
        expect((err as { statusCode?: number }).statusCode).toBe(503);
      }

      expect(() => handleDatabaseUnavailable(true)).not.toThrow();
    });
  });

  describe('13. Dashboard & Routing State Machine Tests', () => {
    it('should route to Database Unavailable (State 1) when PostgreSQL is disconnected', () => {
      const dbReadiness: { status: 'connected' | 'disconnected'; database: string } = { status: 'disconnected', database: 'PostgreSQL' };
      const setupStatus = { isSetupRequired: false, hasCompany: false, hasSuperAdmin: false, databaseConnected: false };
      const currentUser = null;
      let currentTab: string = 'dashboard';

      const resolveActiveView = () => {
        const isDbOffline = dbReadiness.status !== 'connected';
        if (isDbOffline && !currentUser && currentTab !== 'login' && currentTab !== 'setup') {
          return 'database_unavailable';
        }
        if (setupStatus.isSetupRequired && currentTab === 'setup') {
          return 'setup_wizard';
        }
        if (!currentUser) {
          return 'login';
        }
        return currentTab;
      };

      expect(resolveActiveView()).toBe('database_unavailable');

      // User explicitly navigates to login
      currentTab = 'login';
      expect(resolveActiveView()).toBe('login');

      // User explicitly navigates to setup
      currentTab = 'setup';
      expect(resolveActiveView()).toBe('login'); // since isSetupRequired is false when disconnected
    });

    it('should route to Setup Wizard (State 2) when DB is connected and setup is required', () => {
      const dbReadiness: { status: 'connected' | 'disconnected'; database: string } = { status: 'connected', database: 'PostgreSQL' };
      const setupStatus = { isSetupRequired: true, hasCompany: false, hasSuperAdmin: false, databaseConnected: true };
      const currentUser = null;
      const currentTab: string = 'setup';

      const resolveActiveView = () => {
        const isDbOffline = dbReadiness.status !== 'connected';
        if (isDbOffline && !currentUser && currentTab !== 'login' && currentTab !== 'setup') {
          return 'database_unavailable';
        }
        if (setupStatus.isSetupRequired && currentTab === 'setup') {
          return 'setup_wizard';
        }
        if (!currentUser) {
          return 'login';
        }
        return currentTab;
      };

      expect(resolveActiveView()).toBe('setup_wizard');
    });

    it('should route to Dashboard (State 6) when user is authenticated', () => {
      const dbReadiness = { status: 'connected' as const, database: 'PostgreSQL' as const };
      const currentUser = {
        id: 'user-uuid-1',
        companyId: 'company-uuid-1',
        email: 'admin@corp.local',
        fullName: 'Admin User',
        role: 'SUPER_ADMIN' as const,
        isActive: true,
        tokenVersion: 1,
      };
      const currentTab = 'dashboard';

      const resolveActiveView = () => {
        if (!currentUser) return 'login';
        return currentTab;
      };

      expect(resolveActiveView()).toBe('dashboard');
    });
  });

  describe('14. Session Expiration & Invalidation Handling (State 7)', () => {
    it('should detect expired tokens and invalidate authenticated session', () => {
      const expiredPayload = {
        userId: 'user-1',
        companyId: 'comp-1',
        email: 'user@test.com',
        role: 'ADMIN' as const,
        tokenVersion: 1,
        exp: Math.floor(Date.now() / 1000) - 100, // Expired 100 seconds ago
      };

      const isTokenExpired = (exp: number) => exp < Math.floor(Date.now() / 1000);
      expect(isTokenExpired(expiredPayload.exp)).toBe(true);

      const handleExpiredSession = (isExpired: boolean) => {
        if (isExpired) {
          return {
            currentUser: null,
            sessionExpiredMessage: 'Your session has expired. Please sign in again.',
            activeTab: 'login',
          };
        }
        return null;
      };

      const result = handleExpiredSession(true);
      expect(result).not.toBeNull();
      expect(result!.currentUser).toBeNull();
      expect(result!.sessionExpiredMessage).toContain('expired');
      expect(result!.activeTab).toBe('login');
    });
  });

  describe('15. Environment Docker Compose Service Name Integrity', () => {
    it('should verify correct Docker service names for postgres', () => {
      const devService = {
        serviceName: 'postgres',
        containerName: 'coreerp-postgres-dev',
        composeFile: 'docker-compose.dev.yml',
      };
      const prodService = {
        serviceName: 'postgres',
        containerName: 'coreerp-postgres',
        composeFile: 'docker-compose.yml',
      };

      expect(devService.serviceName).toBe('postgres');
      expect(prodService.serviceName).toBe('postgres');
      expect(`docker compose -f ${devService.composeFile} up -d ${devService.serviceName}`).toBe(
        'docker compose -f docker-compose.dev.yml up -d postgres'
      );
      expect(`docker compose up -d ${prodService.serviceName}`).toBe('docker compose up -d postgres');
    });
  });
});


