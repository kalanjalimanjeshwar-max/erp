import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import {
  validateStagingDatabaseUrl,
  getStagingVerificationSteps,
  normalizeDatabaseUrl,
  areDatabaseEndpointsEqual,
  validateDisposableDatabaseName,
} from '../../src/server/db/staging-safety.js';

describe('Staging Verification Safety & Isolation (Phase 8.7A)', () => {
  describe('Database URL Normalization & Endpoint Comparison', () => {
    it('should normalize hostnames, default ports, and decoded database names', () => {
      const endpointA = normalizeDatabaseUrl('postgresql://user:pass@localhost/core_erp_test');
      expect(endpointA).toEqual({
        protocol: 'postgresql',
        hostname: '127.0.0.1',
        port: 5432,
        database: 'core_erp_test',
      });

      const endpointB = normalizeDatabaseUrl('postgresql://other:secret@127.0.0.1:5432/core_erp_test?schema=public');
      expect(endpointB).toEqual({
        protocol: 'postgresql',
        hostname: '127.0.0.1',
        port: 5432,
        database: 'core_erp_test',
      });

      expect(areDatabaseEndpointsEqual(endpointA!, endpointB!)).toBe(true);
    });

    it('should detect endpoint equality despite different query params, credentials, and casing', () => {
      const primaryUrl = 'postgresql://admin:super_secret_p%40ss@localhost:5432/Core_ERP_Test?schema=private';
      const targetUrl = 'postgresql://readonly:different_pass@127.0.0.1/core_erp_test?sslmode=require&connect_timeout=10';

      const result = validateStagingDatabaseUrl(targetUrl, primaryUrl);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('resolves to the same database endpoint as primary DATABASE_URL');
      expect(result.error).toContain('127.0.0.1:5432/core_erp_test');
    });

    it('should unconditionally reject target when equal to DATABASE_URL even if name is test/staging', () => {
      const primaryUrl = 'postgresql://erp_user:pass@staging.internal:5432/core_erp_staging?schema=public';
      const targetUrl = 'postgresql://erp_admin:other_pass@staging.internal:5432/core_erp_staging';

      const result = validateStagingDatabaseUrl(targetUrl, primaryUrl);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('resolves to the same database endpoint as primary DATABASE_URL');
    });

    it('should fail closed if primary DATABASE_URL is malformed or ambiguous', () => {
      const validTarget = 'postgresql://test_user:pass@localhost:5433/core_erp_staging?schema=public';
      const malformedPrimary = 'not_a_valid_postgres_url';

      const result = validateStagingDatabaseUrl(validTarget, malformedPrimary);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Primary DATABASE_URL is malformed or ambiguous');
    });

    it('should fail closed if target URL has subdirectories or invalid ports', () => {
      const invalidPath = normalizeDatabaseUrl('postgresql://user:pass@localhost:5432/core_erp_staging/subpath');
      expect(invalidPath).toBeNull();

      const invalidPort = normalizeDatabaseUrl('postgresql://user:pass@localhost:99999/core_erp_staging');
      expect(invalidPort).toBeNull();
    });
  });

  describe('Disposable Database Naming Policy & Policy Enforcement', () => {
    it('should preserve explicitly approved standard test/staging names', () => {
      const approved = ['core_erp_test', 'core_erp_staging', 'coreerp_test', 'coreerp_staging'];
      for (const name of approved) {
        const check = validateDisposableDatabaseName(name);
        expect(check.valid).toBe(true);
      }
    });

    it('should reject unadorned production system names', () => {
      const unadorned = ['core_erp', 'coreerp', 'erp', 'main', 'primary', 'production', 'prod', 'live'];
      for (const name of unadorned) {
        const check = validateDisposableDatabaseName(name);
        expect(check.valid).toBe(false);
        expect(check.error).toMatch(/appears to be a production or default database|prohibited production indicator/);
      }
    });

    it('should strictly reject production combinations and ambiguous variants (prod_test, test_production, etc.)', () => {
      const dangerousVariants = [
        'prod_test',
        'test_production',
        'production_staging',
        'live_test',
        'primary_staging',
        'core_erp_staging_copy',
        'core_erp_backup_test',
        'core_erp_snapshot_temp',
        'staging_prod',
      ];

      for (const name of dangerousVariants) {
        const check = validateDisposableDatabaseName(name);
        expect(check.valid).toBe(false);
        expect(check.error).toMatch(/prohibited production indicator|backup\/copy indicator|unrecognized or ambiguous/);
      }
    });

    it('should reject ambiguous names lacking disposable indicators', () => {
      const ambiguous = ['company_db', 'accounting', 'custom_erp', 'warehouse_v1'];
      for (const name of ambiguous) {
        const check = validateDisposableDatabaseName(name);
        expect(check.valid).toBe(false);
        expect(check.error).toContain('does not contain an approved disposable keyword');
      }
    });

    it('should accept non-standard names that strictly follow disposable naming rules', () => {
      const safeCustom = ['disposable_db_temp', 'sandbox_erp', 'custom_staging_db', 'unit_test_isolated'];
      for (const name of safeCustom) {
        const check = validateDisposableDatabaseName(name);
        expect(check.valid).toBe(true);
      }
    });
  });

  describe('Staging Database Target Safety Validator (Integration API)', () => {
    it('should strictly reject missing or undefined target database URL', () => {
      const resultUndefined = validateStagingDatabaseUrl(undefined);
      expect(resultUndefined.valid).toBe(false);
      expect(resultUndefined.error).toContain('No explicit staging database URL provided');

      const resultEmpty = validateStagingDatabaseUrl('   ');
      expect(resultEmpty.valid).toBe(false);
      expect(resultEmpty.error).toContain('No explicit staging database URL provided');
    });

    it('should strictly reject invalid protocols (non-PostgreSQL)', () => {
      const resultSqlite = validateStagingDatabaseUrl('sqlite://localhost/test.db');
      expect(resultSqlite.valid).toBe(false);
      expect(resultSqlite.error).toContain('Invalid URL protocol');

      const resultMysql = validateStagingDatabaseUrl('mysql://root:pass@localhost:3306/core_erp_test');
      expect(resultMysql.valid).toBe(false);
      expect(resultMysql.error).toContain('Invalid URL protocol');
    });

    it('should accept valid, explicitly disposable test and staging databases differing from primary', () => {
      const primaryUrl = 'postgresql://erp_user:pass@localhost:5432/core_erp?schema=public';
      const validUrls = [
        'postgresql://erp_test_user:pass@localhost:5433/core_erp_test?schema=public',
        'postgresql://erp_staging_user:pass@staging.db.internal:5432/core_erp_staging?schema=public',
        'postgresql://user:pass@localhost:5432/disposable_db_temp?schema=public',
        'postgresql://user:pass@localhost:5432/sandbox_erp?schema=public',
      ];

      for (const url of validUrls) {
        const result = validateStagingDatabaseUrl(url, primaryUrl);
        expect(result.valid).toBe(true);
        expect(result.url).toBe(url);
        expect(result.databaseName).toBeDefined();
      }
    });

    it('should return complete structured verification steps', () => {
      const steps = getStagingVerificationSteps();
      expect(steps.length).toBeGreaterThanOrEqual(5);

      const stepNames = steps.map((s) => s.name);
      expect(stepNames.some((n) => n.includes('Safety'))).toBe(true);
      expect(stepNames.some((n) => n.includes('Migration'))).toBe(true);
      expect(stepNames.some((n) => n.includes('Health'))).toBe(true);
      expect(stepNames.some((n) => n.includes('Constraint'))).toBe(true);
      expect(stepNames.some((n) => n.includes('Shutdown'))).toBe(true);
    });
  });

  describe('CLI Subprocess Safety & Exit Code Tests', () => {
    const tsxPath = path.resolve(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs');
    const scriptPath = path.resolve(import.meta.dirname, '../../scripts/verify-staging-db.ts');

    it('Case 1: Missing target URL fails safely with exit code 1 and safe error message', () => {
      const result = spawnSync(process.execPath, [tsxPath, scriptPath], {
        env: {
          ...process.env,
          STAGING_DATABASE_URL: '',
          TEST_DATABASE_URL: '',
        },
        encoding: 'utf-8',
      });

      expect(result.status).toBe(1);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('SAFETY CHECK FAILED');
      expect(output).toContain('No explicit staging database URL provided');
      expect(output).not.toContain('erp_test_password');
      expect(output).not.toContain('SuperSecret');
    });

    it('Case 2: Valid pre-flight configuration succeeds with exit code 0 and redacts secrets', () => {
      const testSecret = 'SuperSecretTestPass123!';
      const prodSecret = 'SuperSecretProdPass456!';
      const result = spawnSync(process.execPath, [tsxPath, scriptPath], {
        env: {
          ...process.env,
          STAGING_DATABASE_URL: `postgresql://test_user:${testSecret}@localhost:5433/core_erp_staging?schema=public`,
          DATABASE_URL: `postgresql://prod_user:${prodSecret}@localhost:5432/core_erp?schema=public`,
        },
        encoding: 'utf-8',
      });

      expect(result.status).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('Safety validation PASSED for database "core_erp_staging"');
      expect(output).toContain('Target is confirmed isolated and disposable');
      expect(output).toContain('PREPARATION-ONLY mode');

      // Credentials must be strictly redacted
      expect(output).not.toContain(testSecret);
      expect(output).not.toContain(prodSecret);
      expect(output).toContain('*****');
    });

    it('Case 3: Production database rejection fails with exit code 1 and redacts secrets', () => {
      const testSecret = 'SensitiveDbPass789!';
      const result = spawnSync(process.execPath, [tsxPath, scriptPath], {
        env: {
          ...process.env,
          STAGING_DATABASE_URL: `postgresql://erp_user:${testSecret}@localhost:5433/core_erp`,
          DATABASE_URL: 'postgresql://erp_user:another_pass@localhost:5432/core_erp',
        },
        encoding: 'utf-8',
      });

      expect(result.status).toBe(1);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('SAFETY CHECK FAILED');
      expect(output).toMatch(/appears to be a production or default database|resolves to the same database endpoint/);
      expect(output).not.toContain(testSecret);
    });

    it('Case 4: Target resolving to same database endpoint as DATABASE_URL fails with exit code 1', () => {
      const result = spawnSync(process.execPath, [tsxPath, scriptPath], {
        env: {
          ...process.env,
          // Target and primary point to same endpoint despite different query params, casing, and user
          DATABASE_URL: 'postgresql://primary_admin:pass1@localhost:5432/core_erp_staging?schema=public',
          STAGING_DATABASE_URL: 'postgresql://staging_user:pass2@127.0.0.1:5432/core_erp_staging?sslmode=require',
        },
        encoding: 'utf-8',
      });

      expect(result.status).toBe(1);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('SAFETY CHECK FAILED');
      expect(output).toContain('resolves to the same database endpoint as primary DATABASE_URL');
      expect(output).toContain('127.0.0.1:5432/core_erp_staging');
      expect(output).not.toContain('pass1');
      expect(output).not.toContain('pass2');
    });

    it('Case 5: Unreachable loopback port with --execute fails safely with exit code 2 without running SQL', () => {
      // Use loopback 127.0.0.1 on unused high port (59998)
      const secret = 'UnreachableProbeSecret99!';
      const result = spawnSync(process.execPath, [tsxPath, scriptPath, '--execute'], {
        env: {
          ...process.env,
          STAGING_DATABASE_URL: `postgresql://test_user:${secret}@127.0.0.1:59998/core_erp_staging?schema=public`,
          DATABASE_URL: 'postgresql://prod_user:pass@localhost:5432/core_erp?schema=public',
        },
        encoding: 'utf-8',
      });

      // Exit code 2 indicates probe ran and detected target is unreachable
      expect(result.status).toBe(2);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('PostgreSQL target at 127.0.0.1:59998 is not currently reachable');
      // Confirms no migrations or SQL statements were executed in execution phase
      const execSection = output.split('3. Executing Staging Checks against Disposable Target...')[1] || '';
      expect(execSection).not.toContain('Applying migration');
      expect(execSection).not.toContain('prisma');
      expect(output).not.toContain(secret);
      expect(output).toContain('*****');
    });
  });

  describe('Staging Documentation & Hardware Contract Integrity', () => {
    it('should verify docs/staging-verification-guide.md exists with all required verification sections', () => {
      const guidePath = path.resolve(import.meta.dirname, '../../docs/staging-verification-guide.md');
      expect(fs.existsSync(guidePath)).toBe(true);

      const content = fs.readFileSync(guidePath, 'utf-8');

      // 1. Prohibited operations
      expect(content).toContain('prisma migrate reset');
      expect(content).toContain('prisma db push');

      // 2. Migration verification & history
      expect(content).toContain('prisma migrate status');
      expect(content).toContain('prisma migrate deploy');
      expect(content).toContain('20261011000000_init');
      expect(content).toContain('20261019000000_biometric_terminals_and_raw_punches');

      // 3. Health & readiness endpoints
      expect(content).toContain('/api/health');
      expect(content).toContain('/api/ready');

      // 4. Invariant checks
      expect(content).toContain('Company_code_key');
      expect(content).toContain('User_companyId_email_key');
      expect(content).toContain('Decimal Precision (18, 6)');
      expect(content).toContain('Double-Entry Balance');
      expect(content).toContain('Fiscal Period Locking');

      // 5. Graceful shutdown
      expect(content).toContain('SIGTERM');
      expect(content).toContain('prisma.$disconnect()');

      // 6. Distinction between mocked and real tests
      expect(content).toContain('Distinction: Mocked Tests vs. Real Database Tests');
      expect(content).toContain('Live PostgreSQL Staging Verification');
    });

    it('should verify services/biometric-bridge/README.md documents hardware model and protocol specs', () => {
      const readmePath = path.resolve(import.meta.dirname, '../../services/biometric-bridge/README.md');
      const content = fs.readFileSync(readmePath, 'utf-8');

      // Hardware models & architectures
      expect(content).toContain('ZKTeco F22');
      expect(content).toContain('Standalone Pull SDK');
      expect(content).toContain('Push SDK / ADMS');

      // Transport & port
      expect(content).toContain('4370');
      expect(content).toContain('UDP');
      expect(content).toContain('TCP');

      // Binary command codes
      expect(content).toContain('CMD_CONNECT');
      expect(content).toContain('CMD_AUTH');
      expect(content).toContain('CMD_ATTLOG_RRQ');

      // Payload mapping
      expect(content).toContain('User Enrollment ID');
      expect(content).toContain('Check-In');
      expect(content).toContain('Check-Out');
    });

    it('should verify package.json includes db:verify:staging script', () => {
      const pkgPath = path.resolve(import.meta.dirname, '../../package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

      expect(pkg.scripts['db:verify:staging']).toBe('tsx scripts/verify-staging-db.ts');
    });
  });
});
