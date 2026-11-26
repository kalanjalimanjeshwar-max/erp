import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runDatabaseEnvironmentSetup,
  buildPostgresConnectionUrl,
  parseEnvFileContent,
  matchCoreErpDockerVolumes,
  type SetupLogger,
} from '../../src/server/db/setup-env.js';
import {
  COREERP_DB_ENVIRONMENTS,
  validateStagingDatabaseUrl,
} from '../../src/server/db/staging-safety.js';
import { runStagingVerification } from '../../src/server/db/staging-verifier.js';
import { runIsolatedTargetMigration } from '../../src/server/db/isolated-migrator.js';
import { validateEnv } from '../../src/server/config/env.js';

const tempDirs: string[] = [];

function createTempProjectDir(prefix = 'coreerp-fresh-install-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createSilentLogger(): { logger: SetupLogger; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    logger: {
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Permanent Database Environment & Fresh Installation Reliability', () => {
  it('1. Fresh install with no existing .env creates .env, .env.staging, and .env.integration-test cleanly without leaking secrets', async () => {
    const projectRoot = createTempProjectDir();
    const { logger, logs } = createSilentLogger();

    const result = await runDatabaseEnvironmentSetup({
      projectRoot,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });

    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe('SETUP');
    expect(result.issues).toEqual([]);
    expect(result.files).toEqual([
      { file: '.env.staging', action: 'CREATED' },
      { file: '.env.integration-test', action: 'CREATED' },
      { file: '.env', action: 'CREATED' },
    ]);

    const mainEnv = parseEnvFileContent(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8'));
    const stagingEnv = parseEnvFileContent(
      fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8')
    );
    const integrationEnv = parseEnvFileContent(
      fs.readFileSync(path.join(projectRoot, '.env.integration-test'), 'utf-8')
    );

    // Generated .env passes strict Zod validateEnv() with zero errors
    expect(() => validateEnv({ ...mainEnv, NODE_ENV: 'development' })).not.toThrow();

    // Staging URL in .env is synchronized with .env.staging
    expect(mainEnv.STAGING_DATABASE_URL).toBe(stagingEnv.STAGING_DATABASE_URL);
    expect(stagingEnv.STAGING_POSTGRES_DB).toBe('core_erp_staging');
    expect(stagingEnv.STAGING_POSTGRES_USER).toBe('erp_staging_user');
    expect(stagingEnv.STAGING_POSTGRES_PASSWORD.length).toBeGreaterThanOrEqual(32);

    // Integration env targets port 5434 and core_erp_integration_test
    expect(integrationEnv.TEST_DATABASE_URL).toContain(':5434/core_erp_integration_test');
    expect(integrationEnv.POSTGRES_PASSWORD.length).toBeGreaterThanOrEqual(32);

    // Shadow DB targets port 5436 and core_erp_shadow
    expect(mainEnv.SHADOW_DATABASE_URL).toContain(':5436/core_erp_shadow');
    expect(mainEnv.SHADOW_POSTGRES_DB).toBe('core_erp_shadow');

    // No raw secrets appear in any setup log output
    const combinedLogs = logs.join('\n');
    expect(combinedLogs).not.toContain(stagingEnv.STAGING_POSTGRES_PASSWORD);
    expect(combinedLogs).not.toContain(integrationEnv.POSTGRES_PASSWORD);
    expect(combinedLogs).not.toContain(mainEnv.SHADOW_POSTGRES_PASSWORD);
    expect(combinedLogs).not.toContain(mainEnv.SESSION_SECRET);
    expect(combinedLogs).not.toContain(mainEnv.BANK_ENCRYPTION_KEY);
    expect(combinedLogs).toContain('*****');
  });

  it('2. Existing .env, .env.staging, and .env.integration-test are preserved byte-for-byte (never overwritten)', async () => {
    const projectRoot = createTempProjectDir();

    const customStagingPass = 'ExistingStagingSecret_abcdef1234567890';
    const customIntegrationPass = 'ExistingIntegrationSecret_abcdef1234567890';
    const customDevPass = 'ExistingDevSecret_abcdef1234567890';
    const customShadowPass = 'ExistingShadowSecret_abcdef1234567890';

    const originalStaging = [
      '# Custom Staging Comment Preserved',
      'STAGING_POSTGRES_USER="erp_staging_user"',
      `STAGING_POSTGRES_PASSWORD="${customStagingPass}"`,
      'STAGING_POSTGRES_DB="core_erp_staging"',
      `STAGING_DATABASE_URL="postgresql://erp_staging_user:${customStagingPass}@localhost:5435/core_erp_staging?schema=public"`,
      '',
    ].join('\n');

    const originalIntegration = [
      '# Custom Integration Comment Preserved',
      `POSTGRES_PASSWORD="${customIntegrationPass}"`,
      `TEST_DATABASE_URL="postgresql://erp_integration_user:${customIntegrationPass}@localhost:5434/core_erp_integration_test?schema=public"`,
      '',
    ].join('\n');

    const originalMain = [
      '# Custom Dev Comment Preserved',
      'PORT=3000',
      'NODE_ENV=development',
      'POSTGRES_USER="erp_user"',
      `POSTGRES_PASSWORD="${customDevPass}"`,
      'POSTGRES_DB="core_erp"',
      `DATABASE_URL="postgresql://erp_user:${customDevPass}@localhost:5432/core_erp?schema=public"`,
      `STAGING_DATABASE_URL="postgresql://erp_staging_user:${customStagingPass}@localhost:5435/core_erp_staging?schema=public"`,
      'SHADOW_POSTGRES_USER="erp_shadow_user"',
      `SHADOW_POSTGRES_PASSWORD="${customShadowPass}"`,
      'SHADOW_POSTGRES_DB="core_erp_shadow"',
      `SHADOW_DATABASE_URL="postgresql://erp_shadow_user:${customShadowPass}@localhost:5436/core_erp_shadow?schema=public"`,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(projectRoot, '.env.staging'), originalStaging, 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.env.integration-test'), originalIntegration, 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.env'), originalMain, 'utf-8');

    const { logger } = createSilentLogger();
    const result = await runDatabaseEnvironmentSetup({
      projectRoot,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });

    expect(result.exitCode).toBe(0);
    expect(result.files).toEqual([
      { file: '.env.staging', action: 'PRESERVED' },
      { file: '.env.integration-test', action: 'PRESERVED' },
      { file: '.env', action: 'PRESERVED' },
    ]);

    expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8')).toBe(originalMain);
    expect(fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8')).toBe(originalStaging);
    expect(fs.readFileSync(path.join(projectRoot, '.env.integration-test'), 'utf-8')).toBe(
      originalIntegration
    );
  });

  it('3. Repeated setup runs are strictly idempotent without altering generated credentials', async () => {
    const projectRoot = createTempProjectDir();
    const { logger } = createSilentLogger();

    const first = await runDatabaseEnvironmentSetup({
      projectRoot,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(first.exitCode).toBe(0);

    const snapshotEnv = fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8');
    const snapshotStaging = fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8');
    const snapshotInt = fs.readFileSync(path.join(projectRoot, '.env.integration-test'), 'utf-8');

    const second = await runDatabaseEnvironmentSetup({
      projectRoot,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(second.exitCode).toBe(0);
    expect(second.files.every((f) => f.action === 'PRESERVED')).toBe(true);

    const checkRun = await runDatabaseEnvironmentSetup({
      projectRoot,
      checkOnly: true,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(checkRun.exitCode).toBe(0);
    expect(checkRun.issues).toEqual([]);

    expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8')).toBe(snapshotEnv);
    expect(fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8')).toBe(snapshotStaging);
    expect(fs.readFileSync(path.join(projectRoot, '.env.integration-test'), 'utf-8')).toBe(
      snapshotInt
    );
  });

  it('4. All five environments remain strictly isolated with unique ports, DB names, users, passwords, and volumes', async () => {
    const envs = Object.values(COREERP_DB_ENVIRONMENTS);
    expect(envs).toHaveLength(5);
    expect(new Set(envs.map((e) => e.port)).size).toBe(5);
    expect(new Set(envs.map((e) => e.database)).size).toBe(5);
    expect(new Set(envs.map((e) => e.user)).size).toBe(5);
    expect(new Set(envs.map((e) => e.container)).size).toBe(5);
    expect(new Set(envs.map((e) => e.volume)).size).toBe(5);

    const projectRoot = createTempProjectDir();
    const { logger } = createSilentLogger();
    const res = await runDatabaseEnvironmentSetup({
      projectRoot,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(res.exitCode).toBe(0);

    const mainEnv = parseEnvFileContent(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8'));
    const stagingEnv = parseEnvFileContent(
      fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8')
    );
    const integrationEnv = parseEnvFileContent(
      fs.readFileSync(path.join(projectRoot, '.env.integration-test'), 'utf-8')
    );

    const passwords = [
      mainEnv.POSTGRES_PASSWORD,
      stagingEnv.STAGING_POSTGRES_PASSWORD,
      integrationEnv.POSTGRES_PASSWORD,
      mainEnv.SHADOW_POSTGRES_PASSWORD,
    ];
    expect(new Set(passwords).size).toBe(4);
  });

  it('5. Staging uses its own .env.staging file and verify-staging-db loads it when STAGING_DATABASE_URL is unset', async () => {
    const projectRoot = createTempProjectDir();
    const { logger } = createSilentLogger();
    await runDatabaseEnvironmentSetup({
      projectRoot,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });

    const stagingEnv = parseEnvFileContent(
      fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8')
    );
    const tsxPath = path.resolve(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs');
    const scriptPath = path.resolve(import.meta.dirname, '../../scripts/verify-staging-db.ts');

    const childEnv: Record<string, string | undefined> = { ...process.env };
    delete childEnv.STAGING_DATABASE_URL;
    delete childEnv.STAGING_POSTGRES_USER;
    delete childEnv.STAGING_POSTGRES_PASSWORD;
    delete childEnv.STAGING_POSTGRES_DB;
    delete childEnv.TEST_DATABASE_URL;
    delete childEnv.SHADOW_DATABASE_URL;
    delete childEnv.VITEST;
    childEnv.NODE_ENV = 'development';
    childEnv.DATABASE_URL = 'postgresql://erp_user:dev_only_secret@localhost:5432/core_erp?schema=public';

    // Remove .env in temp dir so we prove verify-staging-db.ts loads strictly from .env.staging (not .env)
    fs.unlinkSync(path.join(projectRoot, '.env'));

    const cliRes = spawnSync(process.execPath, [tsxPath, scriptPath], {
      cwd: projectRoot,
      env: childEnv,
      encoding: 'utf-8',
    });

    const output = `${cliRes.stdout}\n${cliRes.stderr}`;
    expect(cliRes.status, `CLI exited with ${cliRes.status}:\n${output}`).toBe(0);
    expect(output).toContain('Safety validation PASSED for database "core_erp_staging"');
    expect(output).toContain('PREPARATION-ONLY mode');
    expect(output).not.toContain(stagingEnv.STAGING_POSTGRES_PASSWORD);
  });

  it('6. Passwords containing special URI characters (@:/#%!&?+=) are losslessly percent-encoded and remain consistent across Compose and Prisma', async () => {
    const trickyPassword = "P@ss:w/rd#2026%!&?+= 'quote";
    const builtUrl = buildPostgresConnectionUrl({
      user: 'erp_staging_user',
      password: trickyPassword,
      host: 'localhost',
      port: 5435,
      database: 'core_erp_staging',
    });

    // URL must parse cleanly and round-trip decode back to exact password
    const parsed = new URL(builtUrl);
    expect(decodeURIComponent(parsed.password)).toBe(trickyPassword);
    expect(parsed.hostname).toBe('localhost');
    expect(parsed.port).toBe('5435');
    expect(parsed.pathname).toBe('/core_erp_staging');

    // Should pass both validateStagingDatabaseUrl and validateEnv consistency checks
    const stagingValidation = validateStagingDatabaseUrl(
      builtUrl,
      'postgresql://erp_user:devpass@localhost:5432/core_erp'
    );
    expect(stagingValidation.valid).toBe(true);

    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://erp_user:devpass@localhost:5432/core_erp?schema=public',
        STAGING_POSTGRES_USER: 'erp_staging_user',
        STAGING_POSTGRES_PASSWORD: trickyPassword,
        STAGING_POSTGRES_DB: 'core_erp_staging',
        STAGING_DATABASE_URL: builtUrl,
      })
    ).not.toThrow();
  });

  it('7. Missing variables and credential mismatches fail with clear actionable instructions and zero secret leakage', async () => {
    // 7a. --check on empty directory fails cleanly with actionable instructions
    const emptyDir = createTempProjectDir();
    const { logger: emptyLogger } = createSilentLogger();
    const emptyAudit = await runDatabaseEnvironmentSetup({
      projectRoot: emptyDir,
      checkOnly: true,
      logger: emptyLogger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(emptyAudit.exitCode).toBe(1);
    expect(emptyAudit.files.every((f) => f.action === 'MISSING')).toBe(true);
    expect(emptyAudit.issues.some((i) => i.includes('Missing .env.staging'))).toBe(true);
    expect(emptyAudit.issues.some((i) => i.includes('Missing .env.integration-test'))).toBe(true);
    expect(emptyAudit.issues.some((i) => i.includes('Missing .env file'))).toBe(true);

    // 7b. Credential mismatches between Compose vars and URLs fail without leaking secrets
    const mismatchDir = createTempProjectDir();
    const devComposeSecret = 'DevComposeSecret_9911!';
    const devUrlSecret = 'DevUrlSecret_Different_8822!';
    const sharedSecret = 'SharedStagingAndDevSecret_7733!';

    fs.writeFileSync(
      path.join(mismatchDir, '.env.staging'),
      [
        'STAGING_POSTGRES_USER="erp_staging_user"',
        `STAGING_POSTGRES_PASSWORD="${sharedSecret}"`,
        'STAGING_POSTGRES_DB="core_erp_staging"',
        `STAGING_DATABASE_URL="postgresql://erp_staging_user:${sharedSecret}@localhost:5435/core_erp_staging?schema=public"`,
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(mismatchDir, '.env.integration-test'),
      [
        `POSTGRES_PASSWORD="${sharedSecret}"`,
        `TEST_DATABASE_URL="postgresql://erp_integration_user:${sharedSecret}@localhost:5434/core_erp_integration_test?schema=public"`,
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(mismatchDir, '.env'),
      [
        'POSTGRES_USER="erp_user"',
        `POSTGRES_PASSWORD="${devComposeSecret}"`,
        'POSTGRES_DB="core_erp"',
        `DATABASE_URL="postgresql://erp_user:${devUrlSecret}@localhost:5432/core_erp?schema=public"`,
        `STAGING_DATABASE_URL="postgresql://erp_staging_user:DriftedStagingPass_6644!@localhost:5435/core_erp_staging?schema=public"`,
      ].join('\n'),
      'utf-8'
    );

    const { logger: mismatchLogger, logs: mismatchLogs } = createSilentLogger();
    const mismatchRes = await runDatabaseEnvironmentSetup({
      projectRoot: mismatchDir,
      checkOnly: true,
      logger: mismatchLogger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });

    expect(mismatchRes.exitCode).toBe(1);
    expect(
      mismatchRes.issues.some((i) => i.includes('DATABASE_URL password does not match POSTGRES_PASSWORD'))
    ).toBe(true);
    expect(
      mismatchRes.issues.some((i) =>
        i.includes('Staging credential mismatch between .env (STAGING_DATABASE_URL) and .env.staging')
      )
    ).toBe(true);
    expect(
      mismatchRes.issues.some((i) => i.includes('matches integration-test password'))
    ).toBe(true);

    const joined = `${mismatchLogs.join('\n')}\n${mismatchRes.issues.join('\n')}`;
    expect(joined).not.toContain(devComposeSecret);
    expect(joined).not.toContain(devUrlSecret);
    expect(joined).not.toContain(sharedSecret);
    expect(joined).not.toContain('DriftedStagingPass_6644!');
  });

  it('8. Invalid database targets are rejected by staging verification, validateEnv, and isolated migrator', async () => {
    // 8a. validateEnv rejects non-staging DB name in STAGING_DATABASE_URL and non-shadow DB in SHADOW_DATABASE_URL
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://erp_user:devpass@localhost:5432/core_erp?schema=public',
        STAGING_DATABASE_URL: 'postgresql://erp_test_user:pass@localhost:5433/core_erp_test',
      })
    ).toThrow(/core_erp_staging/);

    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://erp_user:devpass@localhost:5432/core_erp?schema=public',
        SHADOW_DATABASE_URL: 'postgresql://erp_user:devpass@localhost:5432/core_erp',
      })
    ).toThrow(/core_erp_shadow/);

    // 8b. Isolated migrator rejects wrong port/host/db for dev and integration
    const { logger } = createSilentLogger();
    const badDev = await runIsolatedTargetMigration({
      target: 'dev',
      execute: false,
      env: { DATABASE_URL: 'postgresql://erp_user:pass@prod.db.internal:5432/core_erp' },
      logger,
    });
    expect(badDev.exitCode).toBe(1);
    expect(badDev.error).toContain('localhost:5432/core_erp');

    const badIntegration = await runIsolatedTargetMigration({
      target: 'integration',
      execute: false,
      env: { TEST_DATABASE_URL: 'postgresql://erp_user:pass@localhost:5432/core_erp' },
      logger,
    });
    expect(badIntegration.exitCode).toBe(1);
    expect(badIntegration.error).toContain('localhost:5434/core_erp_integration_test');

    const badStagingPort = await runIsolatedTargetMigration({
      target: 'staging',
      execute: false,
      env: {
        STAGING_DATABASE_URL: 'postgresql://erp_staging_user:pass@localhost:5433/core_erp_staging',
      },
      logger,
    });
    expect(badStagingPort.exitCode).toBe(1);
    expect(badStagingPort.error).toContain('reserved for automated testing');
  });

  it('9. Existing Docker volumes are detected safely (with P1000 persistence warnings) and NEVER deleted or reset', async () => {
    const detected = matchCoreErpDockerVolumes([
      'coreerp_postgres_dev_data',
      'coreerp_postgres_staging_data',
      'unrelated_volume',
    ]);
    expect(detected).toEqual([
      {
        environment: 'development',
        expectedVolume: 'postgres_dev_data',
        matchedDockerVolume: 'coreerp_postgres_dev_data',
      },
      {
        environment: 'staging',
        expectedVolume: 'postgres_staging_data',
        matchedDockerVolume: 'coreerp_postgres_staging_data',
      },
    ]);

    const projectRoot = createTempProjectDir();
    const { logger } = createSilentLogger();
    const inspectMock = vi.fn().mockResolvedValue([
      'coreerp_postgres_dev_data',
      'coreerp_postgres_staging_data',
      'coreerp_postgres_integration_test_data',
    ]);

    const res = await runDatabaseEnvironmentSetup({
      projectRoot,
      logger,
      inspectDockerVolumes: inspectMock,
    });

    expect(res.exitCode).toBe(0);
    expect(inspectMock).toHaveBeenCalledTimes(1);
    expect(res.detectedVolumes).toHaveLength(3);
    expect(res.warnings.some((w) => w.includes('coreerp_postgres_staging_data') && w.includes('P1000'))).toBe(
      true
    );
    expect(res.warnings.some((w) => w.includes('coreerp_postgres_dev_data') && w.includes('db:sync:dev-credentials'))).toBe(
      true
    );
    expect(
      res.warnings.some((w) => w.includes('coreerp_postgres_integration_test_data') && w.includes('P1000'))
    ).toBe(true);
  });

  it('10. Staging verification cannot fall back to DATABASE_URL or TEST_DATABASE_URL', async () => {
    const { logger } = createSilentLogger();
    const checkPortReachable = vi.fn();
    const runPrismaCommand = vi.fn();

    const res = await runStagingVerification({
      execute: true,
      env: {
        DATABASE_URL: 'postgresql://erp_user:devpass@localhost:5432/core_erp?schema=public',
        TEST_DATABASE_URL:
          'postgresql://erp_integration_user:intpass@localhost:5434/core_erp_integration_test?schema=public',
        STAGING_DATABASE_URL: undefined,
      },
      logger,
      deps: {
        checkPortReachable,
        runPrismaCommand,
      },
    });

    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('No explicit staging database URL provided');
    expect(checkPortReachable).not.toHaveBeenCalled();
    expect(runPrismaCommand).not.toHaveBeenCalled();
  });

  it('11. Production database URLs and production migration targets are always rejected', async () => {
    const prodLikeUrls = [
      'postgresql://erp_user:pass@localhost:5435/core_erp',
      'postgresql://erp_user:pass@prod.db.internal:5432/production',
      'postgresql://erp_user:pass@prod.db.internal:5432/prod_staging',
      'postgresql://erp_user:pass@localhost:5435/core_erp_staging_backup',
      'postgresql://erp_user:pass@staging.internal:5435/core_erp_staging_copy',
    ];

    for (const url of prodLikeUrls) {
      const val = validateStagingDatabaseUrl(url);
      expect(val.valid, `Expected production-like URL to be rejected: ${url}`).toBe(false);
    }

    const { logger } = createSilentLogger();
    const runPrismaCommand = vi.fn();
    for (const target of ['prod', 'production', 'PROD']) {
      const res = await runIsolatedTargetMigration({
        target,
        execute: true,
        env: { DATABASE_URL: 'postgresql://erp_user:pass@prod.db:5432/core_erp' },
        logger,
        deps: { runPrismaCommand },
      });
      expect(res.exitCode).toBe(1);
      expect(res.error).toContain('prohibited');
    }
    expect(runPrismaCommand).not.toHaveBeenCalled();
  });

  it('12. Migration execution requires explicit --execute; dry-run never connects to PostgreSQL or spawns Prisma', async () => {
    const { logger } = createSilentLogger();
    const checkPortReachable = vi.fn();
    const runPrismaCommand = vi.fn();

    const dryStaging = await runStagingVerification({
      execute: false,
      env: {
        STAGING_DATABASE_URL:
          'postgresql://erp_staging_user:validpass@localhost:5435/core_erp_staging?schema=public',
        DATABASE_URL: 'postgresql://erp_user:devpass@localhost:5432/core_erp?schema=public',
      },
      logger,
      deps: {
        checkPortReachable,
        runPrismaCommand,
      },
    });
    expect(dryStaging.exitCode).toBe(0);
    expect(dryStaging.mode).toBe('DRY_RUN');
    expect(checkPortReachable).not.toHaveBeenCalled();
    expect(runPrismaCommand).not.toHaveBeenCalled();

    const dryMigrator = await runIsolatedTargetMigration({
      target: 'staging',
      execute: false,
      env: {
        STAGING_DATABASE_URL:
          'postgresql://erp_staging_user:validpass@localhost:5435/core_erp_staging?schema=public',
        DATABASE_URL: 'postgresql://erp_user:devpass@localhost:5432/core_erp?schema=public',
      },
      logger,
      deps: {
        checkPortReachable,
        runPrismaCommand,
      },
    });
    expect(dryMigrator.exitCode).toBe(0);
    expect(dryMigrator.mode).toBe('DRY_RUN');
    expect(dryMigrator.expectedMigrationsCount).toBe(17);
    expect(checkPortReachable).not.toHaveBeenCalled();
    expect(runPrismaCommand).not.toHaveBeenCalled();

    // When execute: true is explicitly requested on an isolated mocked target, prisma migrate deploy & status run cleanly
    const mockRunPrisma = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Applied 17 migrations', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Database schema is up to date!', stderr: '' });
    const execMigrator = await runIsolatedTargetMigration({
      target: 'staging',
      execute: true,
      env: {
        STAGING_DATABASE_URL:
          'postgresql://erp_staging_user:validpass@localhost:5435/core_erp_staging?schema=public',
        DATABASE_URL: 'postgresql://erp_user:devpass@localhost:5432/core_erp?schema=public',
      },
      logger,
      deps: {
        checkPortReachable: vi.fn().mockResolvedValue(true),
        runPrismaCommand: mockRunPrisma,
      },
    });
    expect(execMigrator.exitCode).toBe(0);
    expect(execMigrator.mode).toBe('EXECUTE');
    expect(mockRunPrisma).toHaveBeenNthCalledWith(
      1,
      ['migrate', 'deploy'],
      expect.objectContaining({
        DATABASE_URL:
          'postgresql://erp_staging_user:validpass@localhost:5435/core_erp_staging?schema=public',
      })
    );
    expect(mockRunPrisma).toHaveBeenNthCalledWith(
      2,
      ['migrate', 'status'],
      expect.objectContaining({
        DATABASE_URL:
          'postgresql://erp_staging_user:validpass@localhost:5435/core_erp_staging?schema=public',
      })
    );
  });
});
