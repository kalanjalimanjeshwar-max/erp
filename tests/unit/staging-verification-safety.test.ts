import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import {
  validateStagingDatabaseUrl,
  getStagingVerificationSteps,
  getExpectedPrismaMigrations,
  validateAppliedMigrations,
  validateSchemaInvariants,
  REQUIRED_STAGING_UNIQUE_INDEXES,
  REQUIRED_STAGING_DECIMAL_COLUMNS,
  REQUIRED_ATTENDANCE_SOURCE_VALUES,
  normalizeDatabaseUrl,
  areDatabaseEndpointsEqual,
  validateDisposableDatabaseName,
  type AppliedMigrationRecord,
  type SchemaDecimalColumnRecord,
  type SchemaIndexRecord,
} from '../../src/server/db/staging-safety.js';
import {
  runStagingVerification,
  buildIsolatedPrismaEnv,
  buildIsolatedServerEnv,
  redactSensitiveText,
  type StagingDatabaseInspector,
  type StagingServerHandle,
  type StagingVerifierDeps,
  type StagingVerifierLogger,
} from '../../src/server/db/staging-verifier.js';

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
      const validTarget = 'postgresql://erp_staging_user:pass@localhost:5435/core_erp_staging?schema=public';
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

    it('should accept only dedicated core_erp_staging databases on non-reserved ports differing from primary', () => {
      const primaryUrl = 'postgresql://erp_user:pass@localhost:5432/core_erp?schema=public';
      const validUrls = [
        'postgresql://erp_staging_user:pass@localhost:5435/core_erp_staging?schema=public',
        'postgresql://erp_staging_user:pass@127.0.0.1:5435/core_erp_staging?schema=public',
        'postgresql://erp_staging_user:pass@staging.db.internal:5432/core_erp_staging?schema=public',
      ];

      for (const url of validUrls) {
        const result = validateStagingDatabaseUrl(url, primaryUrl);
        expect(result.valid).toBe(true);
        expect(result.url).toBe(url);
        expect(result.databaseName).toBe('core_erp_staging');
      }
    });

    it('should strictly reject non-staging database names and reserved local ports (5432/5433/5434/5436)', () => {
      const primaryUrl = 'postgresql://erp_user:pass@localhost:5432/core_erp?schema=public';
      const rejectedUrls = [
        // Non-staging reserved database names
        'postgresql://erp_test_user:pass@localhost:5433/core_erp_test?schema=public',
        'postgresql://erp_integration_user:pass@localhost:5434/core_erp_integration_test?schema=public',
        'postgresql://erp_shadow_user:pass@localhost:5436/core_erp_shadow?schema=public',
        // Non-canonical disposable names are rejected for staging
        'postgresql://user:pass@localhost:5435/disposable_db_temp?schema=public',
        'postgresql://user:pass@localhost:5435/sandbox_erp?schema=public',
        // Reserved localhost ports even with core_erp_staging DB name
        'postgresql://erp_staging_user:pass@localhost:5432/core_erp_staging?schema=public',
        'postgresql://erp_staging_user:pass@localhost:5433/core_erp_staging?schema=public',
        'postgresql://erp_staging_user:pass@localhost:5434/core_erp_staging?schema=public',
        'postgresql://erp_staging_user:pass@localhost:5436/core_erp_staging?schema=public',
      ];

      for (const url of rejectedUrls) {
        const result = validateStagingDatabaseUrl(url, primaryUrl);
        expect(result.valid, `Expected staging validator to reject: ${url}`).toBe(false);
      }
    });

    it('should reject collisions against TEST_DATABASE_URL and SHADOW_DATABASE_URL', () => {
      const stagingUrl = 'postgresql://erp_staging_user:pass@staging.internal:5435/core_erp_staging';
      const testCollision = validateStagingDatabaseUrl(stagingUrl, undefined, {
        testDatabaseUrl: stagingUrl,
      });
      expect(testCollision.valid).toBe(false);
      expect(testCollision.error).toContain('TEST_DATABASE_URL');

      const shadowCollision = validateStagingDatabaseUrl(stagingUrl, undefined, {
        shadowDatabaseUrl: stagingUrl,
      });
      expect(shadowCollision.valid).toBe(false);
      expect(shadowCollision.error).toContain('SHADOW_DATABASE_URL');
    });

    it('should return complete structured verification steps reflecting actual migration count', () => {
      const expectedMigrations = getExpectedPrismaMigrations();
      expect(expectedMigrations.length).toBe(17);
      expect(expectedMigrations).toContain('20261011000000_init');
      expect(expectedMigrations).toContain('20261126000000_attendance_auto_checkout_system_generated');

      const steps = getStagingVerificationSteps();
      expect(steps.length).toBe(6);

      const stepNames = steps.map((s) => s.name);
      expect(stepNames.some((n) => n.includes('Safety'))).toBe(true);
      expect(stepNames.some((n) => n.includes('Migration'))).toBe(true);
      expect(stepNames.some((n) => n.includes('Health'))).toBe(true);
      expect(stepNames.some((n) => n.includes('Constraint'))).toBe(true);
      expect(stepNames.some((n) => n.includes('Shutdown'))).toBe(true);

      const migrationStep = steps.find((s) => s.name.includes('Migration'));
      expect(migrationStep?.description).toContain(`all ${expectedMigrations.length} versioned migrations`);
      expect(migrationStep?.description).not.toContain('all 8 versioned migrations');
    });
  });

  describe('Migration History & Schema Invariant Validators', () => {
    const validIndexes: SchemaIndexRecord[] = REQUIRED_STAGING_UNIQUE_INDEXES.map((r) => ({
      tablename: r.table,
      indexname: r.indexName,
      indexdef: `CREATE UNIQUE INDEX "${r.indexName}" ON public."${r.table}" USING btree (id)`,
    }));

    const validDecimals: SchemaDecimalColumnRecord[] = REQUIRED_STAGING_DECIMAL_COLUMNS.map((c) => ({
      table_name: c.table,
      column_name: c.column,
      data_type: 'numeric',
      numeric_precision: c.precision,
      numeric_scale: c.scale,
    }));

    it('should pass when _prisma_migrations matches all 17 repository migrations cleanly', () => {
      const expected = getExpectedPrismaMigrations();
      const rows: AppliedMigrationRecord[] = expected.map((name) => ({
        migration_name: name,
        finished_at: new Date('2026-11-26T00:00:00Z'),
        rolled_back_at: null,
        applied_steps_count: 1,
      }));

      const result = validateAppliedMigrations(expected, rows);
      expect(result.valid).toBe(true);
      expect(result.expectedCount).toBe(17);
      expect(result.appliedCount).toBe(17);
      expect(result.missingMigrations).toEqual([]);
      expect(result.unexpectedMigrations).toEqual([]);
      expect(result.failedMigrations).toEqual([]);
    });

    it('should fail on wrong migration count / missing migrations', () => {
      const expected = getExpectedPrismaMigrations();
      const partialRows: AppliedMigrationRecord[] = expected.slice(0, 16).map((name) => ({
        migration_name: name,
        finished_at: new Date('2026-11-26T00:00:00Z'),
        rolled_back_at: null,
      }));

      const result = validateAppliedMigrations(expected, partialRows);
      expect(result.valid).toBe(false);
      expect(result.missingMigrations).toEqual(['20261126000000_attendance_auto_checkout_system_generated']);
      expect(result.error).toContain('missing migrations (1)');
      expect(result.error).toContain('expected 17, found 16');
    });

    it('should fail on failed/incomplete migrations in _prisma_migrations', () => {
      const expected = getExpectedPrismaMigrations();
      const rows: AppliedMigrationRecord[] = expected.map((name, idx) => ({
        migration_name: name,
        finished_at: idx === expected.length - 1 ? null : new Date('2026-11-26T00:00:00Z'),
        rolled_back_at: null,
      }));

      const result = validateAppliedMigrations(expected, rows);
      expect(result.valid).toBe(false);
      expect(result.failedMigrations).toEqual(['20261126000000_attendance_auto_checkout_system_generated']);
      expect(result.error).toContain('failed/incomplete migrations');
    });

    it('should fail on unexpected extra migrations in _prisma_migrations', () => {
      const expected = getExpectedPrismaMigrations();
      const rows: AppliedMigrationRecord[] = [
        ...expected.map((name) => ({
          migration_name: name,
          finished_at: new Date('2026-11-26T00:00:00Z'),
          rolled_back_at: null,
        })),
        {
          migration_name: '20261201000000_untracked_manual_migration',
          finished_at: new Date('2026-12-01T00:00:00Z'),
          rolled_back_at: null,
        },
      ];

      const result = validateAppliedMigrations(expected, rows);
      expect(result.valid).toBe(false);
      expect(result.unexpectedMigrations).toEqual(['20261201000000_untracked_manual_migration']);
      expect(result.error).toContain('unexpected migrations (1)');
    });

    it('should validate required unique indexes, Decimal precisions, and AttendanceSource enum values', () => {
      const pass = validateSchemaInvariants({
        indexes: validIndexes,
        decimalColumns: validDecimals,
        attendanceSourceValues: [...REQUIRED_ATTENDANCE_SOURCE_VALUES],
      });
      expect(pass.valid).toBe(true);

      const missingIdx = validateSchemaInvariants({
        indexes: validIndexes.filter((i) => i.indexname !== 'Company_code_key'),
        decimalColumns: validDecimals,
        attendanceSourceValues: [...REQUIRED_ATTENDANCE_SOURCE_VALUES],
      });
      expect(missingIdx.valid).toBe(false);
      expect(missingIdx.missingIndexes).toEqual(['Company.Company_code_key']);

      const wrongPrecision = validateSchemaInvariants({
        indexes: validIndexes,
        decimalColumns: validDecimals.map((c) =>
          c.table_name === 'CurrencyConfig' && c.column_name === 'exchangeRate'
            ? { ...c, numeric_scale: 4 }
            : c
        ),
        attendanceSourceValues: [...REQUIRED_ATTENDANCE_SOURCE_VALUES],
      });
      expect(wrongPrecision.valid).toBe(false);
      expect(wrongPrecision.precisionMismatches[0]).toContain('CurrencyConfig.exchangeRate');

      const missingEnum = validateSchemaInvariants({
        indexes: validIndexes,
        decimalColumns: validDecimals,
        attendanceSourceValues: ['MANUAL', 'BIOMETRIC'],
      });
      expect(missingEnum.valid).toBe(false);
      expect(missingEnum.missingEnumValues).toEqual(['SYSTEM_GENERATED']);
    });
  });

  describe('Staging Verifier Runner (Isolated Mocked Execution)', () => {
    const STAGING_SECRET = 'StagingRunnerSecret_2026!';
    const PROD_SECRET = 'ProdRunnerSecret_2026!';
    const STAGING_URL = `postgresql://erp_staging_user:${STAGING_SECRET}@localhost:5435/core_erp_staging?schema=public`;
    const PROD_URL = `postgresql://erp_prod_user:${PROD_SECRET}@localhost:5432/core_erp?schema=public`;

    function createSilentLogger(): { logger: StagingVerifierLogger; messages: string[] } {
      const messages: string[] = [];
      return {
        messages,
        logger: {
          log: (m) => messages.push(m),
          warn: (m) => messages.push(m),
          error: (m) => messages.push(m),
        },
      };
    }

    function createMockInspector(
      expectedMigrations: string[],
      overrides?: Partial<StagingDatabaseInspector>
    ): StagingDatabaseInspector & { disconnectMock: ReturnType<typeof vi.fn> } {
      const disconnectMock = vi.fn().mockResolvedValue(undefined);
      return {
        disconnectMock,
        verifyConnectivityAndIdentity: vi.fn().mockResolvedValue({
          alive: 1,
          databaseName: 'core_erp_staging',
          schemaName: 'public',
        }),
        listAppliedMigrations: vi.fn().mockResolvedValue(
          expectedMigrations.map((name) => ({
            migration_name: name,
            finished_at: new Date('2026-11-26T00:00:00Z'),
            rolled_back_at: null,
            applied_steps_count: 1,
          }))
        ),
        listUniqueIndexes: vi.fn().mockResolvedValue(
          REQUIRED_STAGING_UNIQUE_INDEXES.map((r) => ({
            tablename: r.table,
            indexname: r.indexName,
            indexdef: `CREATE UNIQUE INDEX "${r.indexName}" ON public."${r.table}" USING btree (id)`,
          }))
        ),
        listDecimalColumns: vi.fn().mockResolvedValue(
          REQUIRED_STAGING_DECIMAL_COLUMNS.map((c) => ({
            table_name: c.table,
            column_name: c.column,
            data_type: 'numeric',
            numeric_precision: c.precision,
            numeric_scale: c.scale,
          }))
        ),
        listAttendanceSourceEnumValues: vi
          .fn()
          .mockResolvedValue([...REQUIRED_ATTENDANCE_SOURCE_VALUES]),
        disconnect: disconnectMock,
        ...overrides,
      };
    }

    function createMockServerHandle(
      overrides?: Partial<StagingServerHandle>
    ): StagingServerHandle & {
      shutdownMock: ReturnType<typeof vi.fn>;
      forceKillMock: ReturnType<typeof vi.fn>;
    } {
      let exited = false;
      const shutdownMock = vi.fn().mockImplementation(async () => {
        exited = true;
        return {
          exited: true,
          exitCode: 0,
          signal: null,
          logs: '[CoreERP] HTTP server closed.\n[CoreERP] PostgreSQL connections closed.\n',
        };
      });
      const forceKillMock = vi.fn().mockImplementation(() => {
        exited = true;
      });
      return {
        port: 43210,
        baseUrl: 'http://127.0.0.1:43210',
        hasExited: () => exited,
        getExitCode: () => (exited ? 0 : null),
        getCombinedLogs: () => '[CoreERP] Server running\n',
        requestGracefulShutdown: shutdownMock,
        forceKill: forceKillMock,
        shutdownMock,
        forceKillMock,
        ...overrides,
      };
    }

    it('should isolate subprocess environments and redact credentials completely', () => {
      const prismaEnv = buildIsolatedPrismaEnv(STAGING_URL, {
        PATH: '/usr/bin',
        DATABASE_URL: PROD_URL,
        STAGING_DATABASE_URL: STAGING_URL,
        TEST_DATABASE_URL: STAGING_URL,
        COREERP_INTEGRATION_TEST_MODE: 'true',
        POSTGRES_PASSWORD: PROD_SECRET,
        BOOTSTRAP_SUPER_ADMIN_PASSWORD: 'AdminPassword123!',
      });
      expect(prismaEnv.DATABASE_URL).toBe(STAGING_URL);
      expect(prismaEnv.STAGING_DATABASE_URL).toBeUndefined();
      expect(prismaEnv.TEST_DATABASE_URL).toBeUndefined();
      expect(prismaEnv.COREERP_INTEGRATION_TEST_MODE).toBeUndefined();
      expect(prismaEnv.POSTGRES_PASSWORD).toBeUndefined();
      expect(prismaEnv.BOOTSTRAP_SUPER_ADMIN_PASSWORD).toBeUndefined();

      const built = buildIsolatedServerEnv(STAGING_URL, 43210, {
        PATH: '/usr/bin',
        DATABASE_URL: PROD_URL,
        SESSION_SECRET: 'prod_session_secret_value_should_not_leak',
        BANK_ENCRYPTION_KEY: 'a'.repeat(64),
        BANK_HISTORICAL_KEYS: '{"k1":"' + 'b'.repeat(64) + '"}',
      });
      expect(built.env.DATABASE_URL).toBe(STAGING_URL);
      expect(built.env.NODE_ENV).toBe('production');
      expect(built.env.PORT).toBe('43210');
      expect(built.env.DISABLE_AUTO_CHECKOUT_SCHEDULER).toBe('true');
      expect(built.env.BANK_HISTORICAL_KEYS).toBe('');
      expect(built.env.SESSION_SECRET).not.toBe('prod_session_secret_value_should_not_leak');
      expect(built.env.BANK_ENCRYPTION_KEY).not.toBe('a'.repeat(64));

      const scrubbed = redactSensitiveText(
        `Error connecting to ${STAGING_URL} with secret ${STAGING_SECRET}`,
        [STAGING_URL, STAGING_SECRET]
      );
      expect(scrubbed).not.toContain(STAGING_SECRET);
      expect(scrubbed).not.toContain(STAGING_URL);
    });

    it('should execute all 6 verification steps cleanly on a valid mocked staging target without leaking secrets', async () => {
      const expected = getExpectedPrismaMigrations();
      const inspector = createMockInspector(expected);
      const serverHandle = createMockServerHandle();
      const runPrismaCommand = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'migrate' && args[1] === 'deploy') {
          return { exitCode: 0, stdout: 'All migrations have been successfully applied.', stderr: '' };
        }
        return { exitCode: 0, stdout: 'Database schema is up to date!', stderr: '' };
      });
      const startStagingServer = vi.fn().mockResolvedValue(serverHandle);
      const fetchEndpoint = vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/api/health')) {
          return { status: 200, body: { status: 'ok' }, rawText: '{"status":"ok"}' };
        }
        return {
          status: 200,
          body: { status: 'ready', checks: { postgres: { status: 'connected' } } },
          rawText: '{"status":"ready","checks":{"postgres":{"status":"connected"}}}',
        };
      });

      const { logger, messages } = createSilentLogger();
      const result = await runStagingVerification({
        execute: true,
        env: {
          STAGING_DATABASE_URL: STAGING_URL,
          DATABASE_URL: PROD_URL,
          POSTGRES_PASSWORD: PROD_SECRET,
        },
        logger,
        deps: {
          checkPortReachable: vi.fn().mockResolvedValue(true),
          getExpectedMigrations: () => expected,
          runPrismaCommand,
          createDatabaseInspector: () => inspector,
          allocatePort: vi.fn().mockResolvedValue(43210),
          startStagingServer,
          fetchEndpoint,
          sleep: vi.fn().mockResolvedValue(undefined),
          platform: 'linux',
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.steps).toHaveLength(6);
      expect(result.steps.every((s) => s.status === 'PASSED')).toBe(true);
      expect(runPrismaCommand).toHaveBeenNthCalledWith(
        1,
        ['migrate', 'deploy'],
        expect.objectContaining({ DATABASE_URL: STAGING_URL })
      );
      expect(runPrismaCommand).toHaveBeenNthCalledWith(
        2,
        ['migrate', 'status'],
        expect.objectContaining({ DATABASE_URL: STAGING_URL })
      );
      expect(inspector.disconnectMock).toHaveBeenCalledTimes(1);
      expect(startStagingServer).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseUrl: STAGING_URL,
          port: 43210,
          env: expect.objectContaining({
            DATABASE_URL: STAGING_URL,
            DISABLE_AUTO_CHECKOUT_SCHEDULER: 'true',
          }),
        })
      );
      expect(serverHandle.shutdownMock).toHaveBeenCalledTimes(1);

      const fullLog = messages.join('\n');
      expect(fullLog).not.toContain(STAGING_SECRET);
      expect(fullLog).not.toContain(PROD_SECRET);
    });

    it('should fail closed with exit code 2 when PostgreSQL is unavailable and never invoke Prisma or server', async () => {
      const runPrismaCommand = vi.fn();
      const startStagingServer = vi.fn();
      const { logger } = createSilentLogger();

      const result = await runStagingVerification({
        execute: true,
        env: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: PROD_URL },
        logger,
        deps: {
          checkPortReachable: vi.fn().mockResolvedValue(false),
          runPrismaCommand,
          startStagingServer,
        },
      });

      expect(result.exitCode).toBe(2);
      expect(runPrismaCommand).not.toHaveBeenCalled();
      expect(startStagingServer).not.toHaveBeenCalled();
      expect(result.steps.find((s) => s.step === 2)?.status).toBe('FAILED');
    });

    it('should fail closed when connected PostgreSQL current_database() mismatches expected staging database', async () => {
      const expected = getExpectedPrismaMigrations();
      const inspector = createMockInspector(expected, {
        verifyConnectivityAndIdentity: vi.fn().mockResolvedValue({
          alive: 1,
          databaseName: 'core_erp',
          schemaName: 'public',
        }),
      });
      const startStagingServer = vi.fn();
      const { logger } = createSilentLogger();

      const result = await runStagingVerification({
        execute: true,
        env: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: PROD_URL },
        logger,
        deps: {
          checkPortReachable: vi.fn().mockResolvedValue(true),
          getExpectedMigrations: () => expected,
          runPrismaCommand: vi.fn().mockResolvedValue({
            exitCode: 0,
            stdout: 'Database schema is up to date!',
            stderr: '',
          }),
          createDatabaseInspector: () => inspector,
          startStagingServer,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('database identity mismatch');
      expect(inspector.disconnectMock).toHaveBeenCalledTimes(1);
      expect(startStagingServer).not.toHaveBeenCalled();
    });

    it('should fail when prisma migrate deploy fails or prisma migrate status is not up to date', async () => {
      const { logger } = createSilentLogger();
      const startStagingServer = vi.fn();

      const deployFail = await runStagingVerification({
        execute: true,
        env: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: PROD_URL },
        logger,
        deps: {
          checkPortReachable: vi.fn().mockResolvedValue(true),
          runPrismaCommand: vi.fn().mockResolvedValue({
            exitCode: 1,
            stdout: '',
            stderr: `Error P1000: Authentication failed against ${STAGING_URL}`,
          }),
          startStagingServer,
        },
      });
      expect(deployFail.exitCode).toBe(1);
      expect(deployFail.error).toContain('prisma migrate deploy failed');
      expect(deployFail.error).toContain('P1000 Auth Hint');
      expect(deployFail.error).not.toContain(STAGING_SECRET);
      expect(startStagingServer).not.toHaveBeenCalled();

      const statusFail = await runStagingVerification({
        execute: true,
        env: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: PROD_URL },
        logger,
        deps: {
          checkPortReachable: vi.fn().mockResolvedValue(true),
          runPrismaCommand: vi
            .fn()
            .mockResolvedValueOnce({ exitCode: 0, stdout: 'Applied', stderr: '' })
            .mockResolvedValueOnce({
              exitCode: 0,
              stdout: 'Following migration have not yet been applied',
              stderr: '',
            }),
          startStagingServer,
        },
      });
      expect(statusFail.exitCode).toBe(1);
      expect(statusFail.error).toContain('prisma migrate status did not confirm an up-to-date schema');
      expect(startStagingServer).not.toHaveBeenCalled();
    });

    it('should never fall back to TEST_DATABASE_URL or DATABASE_URL and should reject STAGING_POSTGRES_PASSWORD mismatch', async () => {
      const { logger } = createSilentLogger();
      const checkPortReachable = vi.fn();

      const noFallback = await runStagingVerification({
        execute: true,
        env: {
          STAGING_DATABASE_URL: '',
          TEST_DATABASE_URL: 'postgresql://erp_integration_user:secret@localhost:5434/core_erp_integration_test',
          DATABASE_URL: PROD_URL,
        },
        logger,
        deps: { checkPortReachable },
      });
      expect(noFallback.exitCode).toBe(1);
      expect(noFallback.error).toContain('No explicit staging database URL provided');
      expect(checkPortReachable).not.toHaveBeenCalled();

      const conflictRes = await runStagingVerification({
        execute: true,
        env: {
          STAGING_DATABASE_URL: STAGING_URL,
          STAGING_POSTGRES_PASSWORD: 'DifferentStagingPassword_999!',
          DATABASE_URL: PROD_URL,
        },
        logger,
        deps: { checkPortReachable },
      });
      expect(conflictRes.exitCode).toBe(1);
      expect(conflictRes.error).toContain('Conflicting staging credentials');
      expect(conflictRes.error).not.toContain('DifferentStagingPassword_999!');
      expect(conflictRes.error).not.toContain(STAGING_SECRET);
      expect(checkPortReachable).not.toHaveBeenCalled();
    });

    it('should fail on wrong migration count or failed migration in _prisma_migrations and disconnect inspector', async () => {
      const expected = getExpectedPrismaMigrations();
      const inspector = createMockInspector(expected, {
        listAppliedMigrations: vi.fn().mockResolvedValue(
          expected.slice(0, 16).map((name) => ({
            migration_name: name,
            finished_at: new Date('2026-11-26T00:00:00Z'),
            rolled_back_at: null,
          }))
        ),
      });
      const startStagingServer = vi.fn();
      const { logger } = createSilentLogger();

      const result = await runStagingVerification({
        execute: true,
        env: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: PROD_URL },
        logger,
        deps: {
          checkPortReachable: vi.fn().mockResolvedValue(true),
          getExpectedMigrations: () => expected,
          runPrismaCommand: vi.fn().mockResolvedValue({
            exitCode: 0,
            stdout: 'Database schema is up to date!',
            stderr: '',
          }),
          createDatabaseInspector: () => inspector,
          startStagingServer,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('expected 17, found 16');
      expect(inspector.disconnectMock).toHaveBeenCalledTimes(1);
      expect(startStagingServer).not.toHaveBeenCalled();
    });

    it('should fail on schema precision/index/enum mismatch before starting staging server', async () => {
      const expected = getExpectedPrismaMigrations();
      const inspector = createMockInspector(expected, {
        listAttendanceSourceEnumValues: vi.fn().mockResolvedValue(['MANUAL', 'BIOMETRIC']),
      });
      const startStagingServer = vi.fn();
      const { logger } = createSilentLogger();

      const result = await runStagingVerification({
        execute: true,
        env: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: PROD_URL },
        logger,
        deps: {
          checkPortReachable: vi.fn().mockResolvedValue(true),
          getExpectedMigrations: () => expected,
          runPrismaCommand: vi.fn().mockResolvedValue({
            exitCode: 0,
            stdout: 'Database schema is up to date!',
            stderr: '',
          }),
          createDatabaseInspector: () => inspector,
          startStagingServer,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.steps.find((s) => s.step === 4)?.status).toBe('FAILED');
      expect(result.error).toContain('SYSTEM_GENERATED');
      expect(inspector.disconnectMock).toHaveBeenCalledTimes(1);
      expect(startStagingServer).not.toHaveBeenCalled();
    });

    it('should fail and cleanly terminate staging server when /api/health or /api/ready fails', async () => {
      const expected = getExpectedPrismaMigrations();
      const inspector = createMockInspector(expected);
      const serverHandle = createMockServerHandle();
      const { logger } = createSilentLogger();

      const readyFail = await runStagingVerification({
        execute: true,
        env: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: PROD_URL },
        logger,
        deps: {
          checkPortReachable: vi.fn().mockResolvedValue(true),
          getExpectedMigrations: () => expected,
          runPrismaCommand: vi.fn().mockResolvedValue({
            exitCode: 0,
            stdout: 'Database schema is up to date!',
            stderr: '',
          }),
          createDatabaseInspector: () => inspector,
          allocatePort: vi.fn().mockResolvedValue(43210),
          startStagingServer: vi.fn().mockResolvedValue(serverHandle),
          fetchEndpoint: vi.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/api/health')) {
              return { status: 200, body: { status: 'ok' }, rawText: '{"status":"ok"}' };
            }
            return {
              status: 503,
              body: { status: 'degraded', checks: { postgres: { status: 'disconnected' } } },
              rawText: '{"status":"degraded"}',
            };
          }),
          sleep: vi.fn().mockResolvedValue(undefined),
          platform: 'linux',
        },
      });

      expect(readyFail.exitCode).toBe(1);
      expect(readyFail.steps.find((s) => s.step === 5)?.status).toBe('FAILED');
      expect(readyFail.error).toContain('GET /api/ready failed');
      expect(serverHandle.shutdownMock).toHaveBeenCalledTimes(1);
      expect(serverHandle.forceKillMock).toHaveBeenCalledTimes(1);
    });

    it('should fail when graceful shutdown times out or omits Prisma pool disconnect confirmation', async () => {
      const expected = getExpectedPrismaMigrations();
      const baseDeps = (serverHandle: StagingServerHandle): StagingVerifierDeps => ({
        checkPortReachable: vi.fn().mockResolvedValue(true),
        getExpectedMigrations: () => expected,
        runPrismaCommand: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'Database schema is up to date!',
          stderr: '',
        }),
        createDatabaseInspector: () => createMockInspector(expected),
        allocatePort: vi.fn().mockResolvedValue(43210),
        startStagingServer: vi.fn().mockResolvedValue(serverHandle),
        fetchEndpoint: vi.fn().mockImplementation(async (url: string) => {
          if (url.endsWith('/api/health')) {
            return { status: 200, body: { status: 'ok' }, rawText: '{"status":"ok"}' };
          }
          return {
            status: 200,
            body: { status: 'ready', checks: { postgres: { status: 'connected' } } },
            rawText: '{"status":"ready","checks":{"postgres":{"status":"connected"}}}',
          };
        }),
        sleep: vi.fn().mockResolvedValue(undefined),
        platform: 'linux',
      });

      const { logger } = createSilentLogger();

      const timeoutServer = createMockServerHandle({
        requestGracefulShutdown: vi.fn().mockResolvedValue({
          exited: false,
          exitCode: null,
          signal: null,
          logs: '[CoreERP] HTTP server closed.\n',
        }),
      });
      const timeoutRes = await runStagingVerification({
        execute: true,
        env: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: PROD_URL },
        logger,
        deps: baseDeps(timeoutServer),
        shutdownTimeoutMs: 50,
      });
      expect(timeoutRes.exitCode).toBe(1);
      expect(timeoutRes.steps.find((s) => s.step === 6)?.status).toBe('FAILED');
      expect(timeoutRes.error).toContain('did not exit cleanly');
      expect(timeoutServer.forceKillMock).toHaveBeenCalled();

      const missingLogServer = createMockServerHandle({
        requestGracefulShutdown: vi.fn().mockResolvedValue({
          exited: true,
          exitCode: 0,
          signal: null,
          logs: '[CoreERP] HTTP server closed.\n',
        }),
      });
      const missingLogRes = await runStagingVerification({
        execute: true,
        env: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: PROD_URL },
        logger,
        deps: baseDeps(missingLogServer),
      });
      expect(missingLogRes.exitCode).toBe(1);
      expect(missingLogRes.steps.find((s) => s.step === 6)?.status).toBe('FAILED');
      expect(missingLogRes.error).toContain('Prisma pool disconnect');
    });
  });

  describe('CLI Subprocess Safety & Exit Code Tests', () => {
    const tsxPath = path.resolve(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs');
    const scriptPath = path.resolve(import.meta.dirname, '../../scripts/verify-staging-db.ts');
    const cliTempDirs: string[] = [];

    const makeIsolatedCwd = (): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coreerp-staging-cli-'));
      cliTempDirs.push(dir);
      return dir;
    };

    afterEach(() => {
      while (cliTempDirs.length > 0) {
        const dir = cliTempDirs.pop()!;
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it('Case 1: Missing target URL fails safely with exit code 1 and safe error message', () => {
      const result = spawnSync(process.execPath, [tsxPath, scriptPath], {
        cwd: makeIsolatedCwd(),
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
        cwd: makeIsolatedCwd(),
        env: {
          ...process.env,
          STAGING_DATABASE_URL: `postgresql://erp_staging_user:${testSecret}@localhost:5435/core_erp_staging?schema=public`,
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
        cwd: makeIsolatedCwd(),
        env: {
          ...process.env,
          STAGING_DATABASE_URL: `postgresql://erp_user:${testSecret}@localhost:5435/core_erp`,
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
        cwd: makeIsolatedCwd(),
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
        cwd: makeIsolatedCwd(),
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
      expect(content).toContain('20261126000000_attendance_auto_checkout_system_generated');

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
