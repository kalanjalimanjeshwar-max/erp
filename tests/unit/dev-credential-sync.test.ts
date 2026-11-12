import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateDevSyncPreconditions,
  syncEnvFileDatabaseUrl,
  generateRoleSyncSql,
  CANONICAL_DEV_USER,
  CANONICAL_DEV_PASSWORD,
  CANONICAL_DEV_DB,
  CANONICAL_DEV_PORT,
  CANONICAL_DEV_CONTAINER,
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

    it('should reject non-development role names', () => {
      const result = validateDevSyncPreconditions({
        databaseUrl: `postgresql://postgres:temp_pass@localhost:5432/${CANONICAL_DEV_DB}?schema=public`,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain(`Target role must be exactly "${CANONICAL_DEV_USER}"`);
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
  // 2. .env File Synchronization & Formatting Preservation
  // ==========================================================================
  describe('2. .env File Synchronization & Formatting Preservation', () => {
    it('should update DATABASE_URL and POSTGRES_PASSWORD while preserving comments and other settings', () => {
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
      expect(updatedContent).toContain(`DATABASE_URL="postgresql://erp_user:${CANONICAL_DEV_PASSWORD}@localhost:5432/core_erp?schema=public"`);
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

    it('should create a fresh .env file with canonical credentials if missing', () => {
      const testEnvFile = path.join(tempDir, '.env');

      const result = syncEnvFileDatabaseUrl(testEnvFile);

      expect(result.updated).toBe(true);
      expect(fs.existsSync(testEnvFile)).toBe(true);

      const createdContent = fs.readFileSync(testEnvFile, 'utf-8');
      expect(createdContent).toContain(`DATABASE_URL="postgresql://${CANONICAL_DEV_USER}:${CANONICAL_DEV_PASSWORD}@localhost:5432/core_erp?schema=public"`);
      expect(createdContent).toContain(`POSTGRES_PASSWORD="${CANONICAL_DEV_PASSWORD}"`);
    });
  });

  // ==========================================================================
  // 3. SQL Role Statement Generation & Redaction
  // ==========================================================================
  describe('3. SQL Role Statement Generation & Redaction', () => {
    it('should generate properly quoted ALTER ROLE statement', () => {
      const sql = generateRoleSyncSql(CANONICAL_DEV_USER, CANONICAL_DEV_PASSWORD);
      expect(sql).toBe(`ALTER ROLE "${CANONICAL_DEV_USER}" WITH PASSWORD '${CANONICAL_DEV_PASSWORD}';\n`);
    });

    it('should safely escape embedded quotes in role or password', () => {
      const sql = generateRoleSyncSql('user"name', "p'ass");
      expect(sql).toBe(`ALTER ROLE "user""name" WITH PASSWORD 'p''ass';\n`);
    });
  });
});
