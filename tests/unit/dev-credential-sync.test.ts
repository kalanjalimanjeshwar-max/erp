import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateDevSyncPreconditions,
  verifyEnvFileWritable,
  syncEnvFileDatabaseUrl,
  generateRoleSyncSql,
  generateRoleVerificationSql,
  verifyPostgresRoleViaStdin,
  syncPostgresRoleViaStdin,
  executeDevCredentialSync,
  CANONICAL_DEV_USER,
  CANONICAL_DEV_PASSWORD,
  CANONICAL_DEV_DB,
  CANONICAL_DEV_PORT,
  CANONICAL_DEV_CONTAINER,
  StdinCommandRunner,
} from '../../src/server/db/dev-credential-sync.js';

describe('Development PostgreSQL Credential Synchronization Tests', () => {
  let tempDir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coreerp-dev-sync-'));
    process.env = { ...origEnv };
    process.env.NODE_ENV = 'development';
    delete process.env.COREERP_INTEGRATION_TEST_MODE;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================================================
  // 1. Safety Precondition Enforcement
  // ==========================================================================
  describe('1. Safety Precondition Enforcement', () => {
    const validDevUrl = `postgresql://${CANONICAL_DEV_USER}:temp_pass@localhost:${CANONICAL_DEV_PORT}/${CANONICAL_DEV_DB}?schema=public`;

    it('should strictly reject production environment (NODE_ENV=production)', () => {
      const result = validateDevSyncPreconditions({
        nodeEnv: 'production',
        databaseUrl: validDevUrl,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('strictly forbidden in production mode');
    });

    it('should strictly reject integration-test mode (COREERP_INTEGRATION_TEST_MODE=true)', () => {
      const result = validateDevSyncPreconditions({
        integrationMode: 'true',
        databaseUrl: validDevUrl,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('strictly forbidden in integration-test mode');
    });

    it('should reject unapproved container names', () => {
      const result = validateDevSyncPreconditions({
        containerName: 'coreerp-postgres-prod',
        databaseUrl: validDevUrl,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain(`Target container must be exactly "${CANONICAL_DEV_CONTAINER}"`);
    });

    it('should reject integration database port 5434', () => {
      const result = validateDevSyncPreconditions({
        databaseUrl: `postgresql://${CANONICAL_DEV_USER}:temp_pass@localhost:5434/${CANONICAL_DEV_DB}?schema=public`,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Port must be development port 5432');
    });

    it('should reject staging/test database port 5433', () => {
      const result = validateDevSyncPreconditions({
        databaseUrl: `postgresql://${CANONICAL_DEV_USER}:temp_pass@localhost:5433/${CANONICAL_DEV_DB}?schema=public`,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Port must be development port 5432');
    });

    it('should reject non-development database names', () => {
      const result = validateDevSyncPreconditions({
        databaseUrl: `postgresql://${CANONICAL_DEV_USER}:temp_pass@localhost:5432/core_erp_integration_test?schema=public`,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain(`Target database must be exactly "${CANONICAL_DEV_DB}"`);
    });

    it('should reject non-development role names and never assume postgres role', () => {
      const result = validateDevSyncPreconditions({
        databaseUrl: `postgresql://postgres:temp_pass@localhost:5432/${CANONICAL_DEV_DB}?schema=public`,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain(`Target role must be exactly "${CANONICAL_DEV_USER}"`);
      expect(result.error).toContain('Do not assume a postgres role exists');
    });

    it('should reject remote host endpoints', () => {
      const result = validateDevSyncPreconditions({
        databaseUrl: `postgresql://${CANONICAL_DEV_USER}:temp_pass@db.production.internal:5432/${CANONICAL_DEV_DB}?schema=public`,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Remote hosts are strictly forbidden');
    });

    it('should pass cleanly for valid canonical development environment', () => {
      const result = validateDevSyncPreconditions({
        nodeEnv: 'development',
        integrationMode: 'false',
        containerName: CANONICAL_DEV_CONTAINER,
        databaseUrl: validDevUrl,
      });

      expect(result.valid).toBe(true);
      expect(result.details?.containerName).toBe(CANONICAL_DEV_CONTAINER);
      expect(result.details?.database).toBe(CANONICAL_DEV_DB);
      expect(result.details?.role).toBe(CANONICAL_DEV_USER);
      expect(result.details?.port).toBe(CANONICAL_DEV_PORT);
      expect(result.sanitizedEndpoint).toContain('erp_user:*****@localhost:5432/core_erp');
      expect(result.sanitizedEndpoint).not.toMatch(/temp_pass/);
    });
  });

  // ==========================================================================
  // 2. Initialized Role 'erp_user' & Privilege Verification
  // ==========================================================================
  describe("2. Initialized Role 'erp_user' & Privilege Verification", () => {
    it('should generate role verification SQL targeting erp_user (never postgres)', () => {
      const sql = generateRoleVerificationSql(CANONICAL_DEV_USER);
      expect(sql).toContain(`WHERE rolname = '${CANONICAL_DEV_USER}'`);
      expect(sql).not.toContain('postgres');
    });

    it('should verify erp_user when superuser and login privileges are confirmed', async () => {
      const mockRunner: StdinCommandRunner = async (args, stdin) => {
        // Confirm arguments target erp_user, never postgres
        expect(args).toContain('-U');
        expect(args).toContain('erp_user');
        expect(args).not.toContain('postgres');
        expect(stdin).toContain("WHERE rolname = 'erp_user'");

        return {
          code: 0,
          stdout: 'erp_user|t|t\n',
          stderr: '',
        };
      };

      const result = await verifyPostgresRoleViaStdin({ runner: mockRunner });

      expect(result.verified).toBe(true);
      expect(result.role).toBe('erp_user');
      expect(result.isSuperuser).toBe(true);
      expect(result.canLogin).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should fail verification if role does not have superuser privileges', async () => {
      const mockRunner: StdinCommandRunner = async () => ({
        code: 0,
        stdout: 'erp_user|f|t\n', // rolsuper is false
        stderr: '',
      });

      const result = await verifyPostgresRoleViaStdin({ runner: mockRunner });

      expect(result.verified).toBe(false);
      expect(result.isSuperuser).toBe(false);
      expect(result.error).toContain('does not have superuser privileges');
    });

    it('should fail verification if role was not found in pg_roles', async () => {
      const mockRunner: StdinCommandRunner = async () => ({
        code: 0,
        stdout: '',
        stderr: '',
      });

      const result = await verifyPostgresRoleViaStdin({ runner: mockRunner });

      expect(result.verified).toBe(false);
      expect(result.error).toContain('was not found in pg_roles');
    });

    it('should fail verification if docker execution returns non-zero exit code', async () => {
      const mockRunner: StdinCommandRunner = async () => ({
        code: 1,
        stdout: '',
        stderr: 'Error: No such container: coreerp-postgres-dev',
      });

      const result = await verifyPostgresRoleViaStdin({ runner: mockRunner });

      expect(result.verified).toBe(false);
      expect(result.error).toContain('No such container');
    });
  });

  // ==========================================================================
  // 3. Secure Stdin Role Password Synchronization
  // ==========================================================================
  describe('3. Secure Stdin Role Password Synchronization', () => {
    it('should execute ALTER ROLE using user erp_user through stdin only', async () => {
      let capturedArgs: string[] = [];
      let capturedStdin = '';

      const mockRunner: StdinCommandRunner = async (args, stdin) => {
        capturedArgs = args;
        capturedStdin = stdin;
        return { code: 0, stdout: 'ALTER ROLE', stderr: '' };
      };

      const result = await syncPostgresRoleViaStdin({ runner: mockRunner });

      expect(result.success).toBe(true);
      expect(result.executed).toBe(true);

      // Verify command line arguments: ZERO password or ALTER SQL in argv!
      expect(capturedArgs).toContain('-U');
      expect(capturedArgs).toContain('erp_user');
      expect(capturedArgs).not.toContain('postgres');
      expect(capturedArgs.join(' ')).not.toContain(CANONICAL_DEV_PASSWORD);
      expect(capturedArgs.join(' ')).not.toContain('ALTER');

      // Verify SQL was passed strictly through stdin
      expect(capturedStdin).toBe(`ALTER ROLE "erp_user" WITH PASSWORD '${CANONICAL_DEV_PASSWORD}';\n`);
    });

    it('should handle SQL execution errors and redact credentials in error message', async () => {
      const secretPass = 'super_secret_dev_pass_123';
      const mockRunner: StdinCommandRunner = async () => ({
        code: 1,
        stdout: '',
        stderr: `ERROR: syntax error at or near "${secretPass}"`,
      });

      const result = await syncPostgresRoleViaStdin({
        password: secretPass,
        runner: mockRunner,
      });

      expect(result.success).toBe(false);
      expect(result.executed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).not.toContain(secretPass);
      expect(result.error).toContain('*****');
    });
  });

  // ==========================================================================
  // 4. Atomic .env File Synchronization & Transaction Ordering
  // ==========================================================================
  describe('4. Atomic .env File Synchronization & Transaction Ordering', () => {
    it('should verify file write permissions before performing database changes', () => {
      const testEnvFile = path.join(tempDir, '.env');
      const check = verifyEnvFileWritable(testEnvFile);
      expect(check.writable).toBe(true);
    });

    it('should update DATABASE_URL and POSTGRES_PASSWORD while preserving formatting and comments', () => {
      const testEnvFile = path.join(tempDir, '.env');
      const initialContent = [
        '# CoreERP Dev Configuration',
        'PORT=3000',
        'NODE_ENV=development',
        '',
        '# Database settings',
        'POSTGRES_USER="erp_user"',
        'POSTGRES_PASSWORD="old_different_password"',
        'DATABASE_URL="postgresql://erp_user:old_different_password@localhost:5432/core_erp?schema=public"',
        'STAGING_DATABASE_URL="postgresql://erp_test_user:pass@localhost:5433/core_erp_staging?schema=public"',
        '',
        '# Secret Keys',
        'SESSION_SECRET="a_test_session_secret_min_32_characters_here"',
        'BIOMETRIC_BRIDGE_TOKEN="bridge_token_12345"',
      ].join('\n');

      fs.writeFileSync(testEnvFile, initialContent, 'utf-8');

      const result = syncEnvFileDatabaseUrl(testEnvFile);

      expect(result.updated).toBe(true);
      expect(result.alreadySynchronized).toBe(false);
      expect(result.sanitizedPreviousUrl).toContain('erp_user:*****@localhost:5432/core_erp');
      expect(result.sanitizedCurrentUrl).toContain('erp_user:*****@localhost:5432/core_erp');
      expect(result.sanitizedPreviousUrl).not.toMatch(/old_different_password/);

      // Verify file content after update
      const updatedContent = fs.readFileSync(testEnvFile, 'utf-8');
      expect(updatedContent).toContain('# CoreERP Dev Configuration');
      expect(updatedContent).toContain('PORT=3000');
      expect(updatedContent).toContain('SESSION_SECRET="a_test_session_secret_min_32_characters_here"');
      expect(updatedContent).toContain('BIOMETRIC_BRIDGE_TOKEN="bridge_token_12345"');
      expect(updatedContent).toContain(
        `DATABASE_URL="postgresql://erp_user:${CANONICAL_DEV_PASSWORD}@localhost:5432/core_erp?schema=public"`
      );
      expect(updatedContent).toContain(`POSTGRES_PASSWORD="${CANONICAL_DEV_PASSWORD}"`);
    });

    it('should be completely idempotent when rerun on already-synchronized .env', () => {
      const testEnvFile = path.join(tempDir, '.env');
      const initialContent = [
        'PORT=3000',
        'NODE_ENV=development',
        `DATABASE_URL="postgresql://${CANONICAL_DEV_USER}:${CANONICAL_DEV_PASSWORD}@localhost:5432/core_erp?schema=public"`,
      ].join('\n');

      fs.writeFileSync(testEnvFile, initialContent, 'utf-8');

      const result = syncEnvFileDatabaseUrl(testEnvFile);

      expect(result.updated).toBe(false);
      expect(result.alreadySynchronized).toBe(true);

      const postContent = fs.readFileSync(testEnvFile, 'utf-8');
      expect(postContent).toBe(initialContent);
    });
  });

  // ==========================================================================
  // 5. Phased Orchestrator & Failure-Safe Rollback Invariant
  // ==========================================================================
  describe('5. Phased Orchestrator & Failure-Safe Rollback Invariant', () => {
    it('should NOT modify .env file if role verification fails', async () => {
      const testEnvFile = path.join(tempDir, '.env');
      const initialContent = 'DATABASE_URL="postgresql://erp_user:unmodified_pass@localhost:5432/core_erp"\n';
      fs.writeFileSync(testEnvFile, initialContent, 'utf-8');

      const mockFailingVerifyRunner: StdinCommandRunner = async () => ({
        code: 1,
        stdout: '',
        stderr: 'Docker daemon connection failed',
      });

      const result = await executeDevCredentialSync({
        envFilePath: testEnvFile,
        databaseUrl: 'postgresql://erp_user:unmodified_pass@localhost:5432/core_erp',
        runner: mockFailingVerifyRunner,
      });

      expect(result.success).toBe(false);
      expect(result.roleVerified).toBe(false);
      expect(result.roleUpdated).toBe(false);
      expect(result.envUpdated).toBe(false);

      // Verify .env was NOT modified
      const currentContent = fs.readFileSync(testEnvFile, 'utf-8');
      expect(currentContent).toBe(initialContent);
    });

    it('should NOT modify .env file if role password update fails', async () => {
      const testEnvFile = path.join(tempDir, '.env');
      const initialContent = 'DATABASE_URL="postgresql://erp_user:unmodified_pass@localhost:5432/core_erp"\n';
      fs.writeFileSync(testEnvFile, initialContent, 'utf-8');

      const mockRunner: StdinCommandRunner = async (_args, stdin) => {
        if (stdin.includes('SELECT rolname')) {
          // Verification succeeds
          return { code: 0, stdout: 'erp_user|t|t\n', stderr: '' };
        }
        // Role password update fails
        return { code: 1, stdout: '', stderr: 'PostgreSQL connection terminated abnormally' };
      };

      const result = await executeDevCredentialSync({
        envFilePath: testEnvFile,
        databaseUrl: 'postgresql://erp_user:unmodified_pass@localhost:5432/core_erp',
        runner: mockRunner,
      });

      expect(result.success).toBe(false);
      expect(result.roleVerified).toBe(true);
      expect(result.roleUpdated).toBe(false);
      expect(result.envUpdated).toBe(false);
      expect(result.error).toContain('Local .env was NOT modified to prevent split-brain state');

      // Verify .env was NOT modified
      const currentContent = fs.readFileSync(testEnvFile, 'utf-8');
      expect(currentContent).toBe(initialContent);
    });

    it('should update .env ONLY after role verification and password update succeed', async () => {
      const testEnvFile = path.join(tempDir, '.env');
      const initialContent = 'DATABASE_URL="postgresql://erp_user:old_pass@localhost:5432/core_erp"\n';
      fs.writeFileSync(testEnvFile, initialContent, 'utf-8');

      const mockSuccessRunner: StdinCommandRunner = async (_args, stdin) => {
        if (stdin.includes('SELECT rolname')) {
          return { code: 0, stdout: 'erp_user|t|t\n', stderr: '' };
        }
        return { code: 0, stdout: 'ALTER ROLE', stderr: '' };
      };

      const result = await executeDevCredentialSync({
        envFilePath: testEnvFile,
        databaseUrl: 'postgresql://erp_user:old_pass@localhost:5432/core_erp',
        runner: mockSuccessRunner,
      });

      expect(result.success).toBe(true);
      expect(result.preconditionsValid).toBe(true);
      expect(result.envWritable).toBe(true);
      expect(result.roleVerified).toBe(true);
      expect(result.roleUpdated).toBe(true);
      expect(result.envUpdated).toBe(true);

      // Verify .env was atomically updated
      const updatedContent = fs.readFileSync(testEnvFile, 'utf-8');
      expect(updatedContent).toContain(
        `DATABASE_URL="postgresql://erp_user:${CANONICAL_DEV_PASSWORD}@localhost:5432/core_erp"`
      );
    });
  });
});
