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

    // Strict file ownership: .env NEVER contains STAGING_DATABASE_URL or TEST_DATABASE_URL
    expect(mainEnv.STAGING_DATABASE_URL).toBeUndefined();
    expect(mainEnv.TEST_DATABASE_URL).toBeUndefined();

    // Staging lives exclusively in .env.staging (port 5435 / core_erp_staging)
    expect(stagingEnv.STAGING_DATABASE_URL).toContain(':5435/core_erp_staging');
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
      mismatchRes.issues.some(
        (i) => i.includes('[.env :: STAGING_DATABASE_URL]') && i.includes('Misplaced variable in .env')
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

  it('13. Misplaced STAGING_DATABASE_URL (including port 5433) and TEST_DATABASE_URL in .env are rejected with exact [file :: VAR] reporting and zero secret leakage', async () => {
    const projectRoot = createTempProjectDir();
    const misplacedStagingSecret = 'MisplacedStaging5433Secret_9988!';
    const misplacedTestSecret = 'MisplacedTestEnvSecret_7766!';
    const validStagingSecret = 'ValidStagingSecret_554433221100!';
    const validIntSecret = 'ValidIntSecret_112233445566!';

    fs.writeFileSync(
      path.join(projectRoot, '.env'),
      [
        'POSTGRES_USER="erp_user"',
        'POSTGRES_PASSWORD="erp_password_dev"',
        'POSTGRES_DB="core_erp"',
        'DATABASE_URL="postgresql://erp_user:erp_password_dev@localhost:5432/core_erp?schema=public"',
        `STAGING_DATABASE_URL="postgresql://erp_test_user:${misplacedStagingSecret}@localhost:5433/core_erp_test?schema=public"`,
        `TEST_DATABASE_URL="postgresql://erp_integration_user:${misplacedTestSecret}@localhost:5434/core_erp_integration_test?schema=public"`,
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectRoot, '.env.staging'),
      [
        'STAGING_POSTGRES_USER="erp_staging_user"',
        `STAGING_POSTGRES_PASSWORD="${validStagingSecret}"`,
        'STAGING_POSTGRES_DB="core_erp_staging"',
        `STAGING_DATABASE_URL="postgresql://erp_staging_user:${validStagingSecret}@localhost:5435/core_erp_staging?schema=public"`,
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectRoot, '.env.integration-test'),
      [
        `POSTGRES_PASSWORD="${validIntSecret}"`,
        `TEST_DATABASE_URL="postgresql://erp_integration_user:${validIntSecret}@localhost:5434/core_erp_integration_test?schema=public"`,
        '',
      ].join('\n'),
      'utf-8'
    );

    const { logger, logs } = createSilentLogger();
    const res = await runDatabaseEnvironmentSetup({
      projectRoot,
      checkOnly: true,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });

    expect(res.exitCode).toBe(1);
    expect(
      res.issues.some(
        (i) => i.includes('[.env :: STAGING_DATABASE_URL]') && i.includes('127.0.0.1:5433/core_erp_test')
      )
    ).toBe(true);
    expect(
      res.issues.some(
        (i) => i.includes('[.env :: TEST_DATABASE_URL]') && i.includes('UNIT_TEST_DATABASE_URL')
      )
    ).toBe(true);

    const combined = `${logs.join('\n')}\n${res.issues.join('\n')}`;
    expect(combined).not.toContain(misplacedStagingSecret);
    expect(combined).not.toContain(misplacedTestSecret);
    expect(combined).not.toContain(validStagingSecret);
    expect(combined).not.toContain(validIntSecret);
  });

  it('14. Backward-safe partial setup preserves existing .env and .env.integration-test byte-for-byte and creates ONLY missing .env.staging', async () => {
    const projectRoot = createTempProjectDir();
    const existingIntSecret = 'ExistingIntegrationPassword_KeepMe_2026!';
    const existingMainContent = [
      '# Preserved local dev .env',
      'PORT=3000',
      'NODE_ENV=development',
      'POSTGRES_USER="erp_user"',
      'POSTGRES_PASSWORD="erp_password_dev"',
      'POSTGRES_DB="core_erp"',
      'DATABASE_URL="postgresql://erp_user:erp_password_dev@localhost:5432/core_erp?schema=public"',
      'SHADOW_POSTGRES_USER="erp_shadow_user"',
      'SHADOW_POSTGRES_PASSWORD="ExistingShadowPassword_KeepMe_2026!"',
      'SHADOW_POSTGRES_DB="core_erp_shadow"',
      'SHADOW_DATABASE_URL="postgresql://erp_shadow_user:ExistingShadowPassword_KeepMe_2026!@localhost:5436/core_erp_shadow?schema=public"',
      '',
    ].join('\n');
    const existingIntegrationContent = [
      '# Preserved local .env.integration-test',
      `POSTGRES_PASSWORD="${existingIntSecret}"`,
      `TEST_DATABASE_URL="postgresql://erp_integration_user:${existingIntSecret}@localhost:5434/core_erp_integration_test?schema=public"`,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(projectRoot, '.env'), existingMainContent, 'utf-8');
    fs.writeFileSync(
      path.join(projectRoot, '.env.integration-test'),
      existingIntegrationContent,
      'utf-8'
    );

    // 1. db:setup:check is strictly read-only and reports missing .env.staging without creating it
    const { logger: checkLogger } = createSilentLogger();
    const preCheck = await runDatabaseEnvironmentSetup({
      projectRoot,
      checkOnly: true,
      logger: checkLogger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(preCheck.exitCode).toBe(1);
    expect(preCheck.files).toEqual([
      { file: '.env.staging', action: 'MISSING' },
      { file: '.env.integration-test', action: 'PRESERVED' },
      { file: '.env', action: 'PRESERVED' },
    ]);
    expect(fs.existsSync(path.join(projectRoot, '.env.staging'))).toBe(false);

    // 2. db:setup creates ONLY missing .env.staging and preserves existing .env and .env.integration-test byte-for-byte
    const { logger: setupLogger } = createSilentLogger();
    const setupRes = await runDatabaseEnvironmentSetup({
      projectRoot,
      logger: setupLogger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(setupRes.exitCode).toBe(0);
    expect(setupRes.issues).toEqual([]);
    expect(setupRes.files).toEqual([
      { file: '.env.staging', action: 'CREATED' },
      { file: '.env.integration-test', action: 'PRESERVED' },
      { file: '.env', action: 'PRESERVED' },
    ]);
    expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8')).toBe(existingMainContent);
    expect(fs.readFileSync(path.join(projectRoot, '.env.integration-test'), 'utf-8')).toBe(
      existingIntegrationContent
    );
    expect(fs.existsSync(path.join(projectRoot, '.env.staging'))).toBe(true);

    const createdStaging = parseEnvFileContent(
      fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8')
    );
    expect(createdStaging.STAGING_DATABASE_URL).toContain('localhost:5435/core_erp_staging');

    // 3. Subsequent db:setup:check succeeds cleanly and leaves all files untouched
    const postCheck = await runDatabaseEnvironmentSetup({
      projectRoot,
      checkOnly: true,
      logger: checkLogger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(postCheck.exitCode).toBe(0);
    expect(postCheck.issues).toEqual([]);
  });

  it('15. Wrong ports across all five targets and duplicate endpoints fail with exact [source :: VAR] attribution', async () => {
    const projectRoot = createTempProjectDir();
    fs.writeFileSync(
      path.join(projectRoot, '.env'),
      [
        'POSTGRES_USER="erp_user"',
        'POSTGRES_PASSWORD="dev_pass_unique_123456"',
        'POSTGRES_DB="core_erp"',
        'DATABASE_URL="postgresql://erp_user:dev_pass_unique_123456@localhost:5439/core_erp?schema=public"',
        'UNIT_TEST_DATABASE_URL="postgresql://erp_test_user:erp_test_password@localhost:5499/core_erp_test?schema=public"',
        'SHADOW_POSTGRES_USER="erp_shadow_user"',
        'SHADOW_POSTGRES_PASSWORD="shadow_pass_unique_123456"',
        'SHADOW_POSTGRES_DB="core_erp_shadow"',
        'SHADOW_DATABASE_URL="postgresql://erp_shadow_user:shadow_pass_unique_123456@localhost:5435/core_erp_shadow?schema=public"',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectRoot, '.env.staging'),
      [
        'STAGING_POSTGRES_USER="erp_staging_user"',
        'STAGING_POSTGRES_PASSWORD="staging_pass_unique_123456"',
        'STAGING_POSTGRES_DB="core_erp_staging"',
        'STAGING_DATABASE_URL="postgresql://erp_staging_user:staging_pass_unique_123456@localhost:5433/core_erp_staging?schema=public"',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectRoot, '.env.integration-test'),
      [
        'POSTGRES_PASSWORD="int_pass_unique_123456"',
        'TEST_DATABASE_URL="postgresql://erp_integration_user:int_pass_unique_123456@localhost:5432/core_erp_integration_test?schema=public"',
        '',
      ].join('\n'),
      'utf-8'
    );

    const { logger } = createSilentLogger();
    const wrongPortsRes = await runDatabaseEnvironmentSetup({
      projectRoot,
      checkOnly: true,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });

    expect(wrongPortsRes.exitCode).toBe(1);
    expect(wrongPortsRes.issues.some((i) => i.includes('[.env :: DATABASE_URL]') && i.includes('5439'))).toBe(true);
    expect(wrongPortsRes.issues.some((i) => i.includes('[.env :: UNIT_TEST_DATABASE_URL]') && i.includes('5499'))).toBe(true);
    expect(wrongPortsRes.issues.some((i) => i.includes('[.env.integration-test :: TEST_DATABASE_URL]') && i.includes('5432'))).toBe(true);
    expect(wrongPortsRes.issues.some((i) => i.includes('[.env.staging :: STAGING_DATABASE_URL]') && i.includes('reserved for automated testing'))).toBe(true);
    expect(wrongPortsRes.issues.some((i) => i.includes('[.env :: SHADOW_DATABASE_URL]') && i.includes('5435'))).toBe(true);

    // Duplicate endpoints across targets (staging colliding with automated test on 5433/core_erp_test)
    const dupRoot = createTempProjectDir();
    fs.writeFileSync(
      path.join(dupRoot, '.env'),
      [
        'POSTGRES_USER="erp_user"',
        'POSTGRES_PASSWORD="dev_pass_unique_123456"',
        'POSTGRES_DB="core_erp"',
        'DATABASE_URL="postgresql://erp_user:dev_pass_unique_123456@localhost:5432/core_erp?schema=public"',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(dupRoot, '.env.staging'),
      [
        'STAGING_POSTGRES_USER="erp_staging_user"',
        'STAGING_POSTGRES_PASSWORD="staging_pass_unique_123456"',
        'STAGING_POSTGRES_DB="core_erp_staging"',
        'STAGING_DATABASE_URL="postgresql://erp_test_user:erp_test_password@localhost:5433/core_erp_test?schema=public"',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(dupRoot, '.env.integration-test'),
      [
        'POSTGRES_PASSWORD="int_pass_unique_123456"',
        'TEST_DATABASE_URL="postgresql://erp_integration_user:int_pass_unique_123456@localhost:5434/core_erp_integration_test?schema=public"',
        '',
      ].join('\n'),
      'utf-8'
    );

    const dupRes = await runDatabaseEnvironmentSetup({
      projectRoot: dupRoot,
      checkOnly: true,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(dupRes.exitCode).toBe(1);
    expect(
      dupRes.issues.some(
        (i) =>
          i.includes('Duplicate database endpoint detected') &&
          i.includes('[.env.staging :: STAGING_DATABASE_URL]')
      )
    ).toBe(true);
  });

  it('16. Conflicting shell environment overrides are detected with exact [shell environment :: VAR] reporting and zero secret leakage', async () => {
    const projectRoot = createTempProjectDir();
    const { logger } = createSilentLogger();

    const setup = await runDatabaseEnvironmentSetup({
      projectRoot,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });
    expect(setup.exitCode).toBe(0);

    const shellStagingSecret = 'ShellConflictStagingSecret_999111!';
    const shellDevSecret = 'ShellConflictDevSecret_888222!';
    const { logger: conflictLogger, logs } = createSilentLogger();

    const conflictRes = await runDatabaseEnvironmentSetup({
      projectRoot,
      checkOnly: true,
      shellEnv: {
        DATABASE_URL: `postgresql://erp_user:${shellDevSecret}@localhost:5432/core_erp?schema=public`,
        STAGING_DATABASE_URL: `postgresql://erp_staging_user:${shellStagingSecret}@localhost:5435/core_erp_staging?schema=public`,
        UNIT_TEST_DATABASE_URL:
          'postgresql://erp_test_user:erp_test_password@localhost:5434/core_erp_test?schema=public',
      },
      logger: conflictLogger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });

    expect(conflictRes.exitCode).toBe(1);
    expect(
      conflictRes.issues.some(
        (i) => i.includes('[shell environment :: DATABASE_URL]') && i.includes('[.env :: DATABASE_URL]')
      )
    ).toBe(true);
    expect(
      conflictRes.issues.some(
        (i) =>
          i.includes('[shell environment :: STAGING_DATABASE_URL]') &&
          i.includes('[.env.staging :: STAGING_DATABASE_URL]')
      )
    ).toBe(true);
    expect(
      conflictRes.issues.some((i) => i.includes('[shell environment :: UNIT_TEST_DATABASE_URL]'))
    ).toBe(true);

    const output = `${logs.join('\n')}\n${conflictRes.issues.join('\n')}`;
    expect(output).not.toContain(shellStagingSecret);
    expect(output).not.toContain(shellDevSecret);
  });

  it('17. CLI verify-staging-db.ts and migrate-target-db.ts refuse misplaced .env variables and conflicting shell overrides without leaking secrets', async () => {
    const projectRoot = createTempProjectDir();
    const { logger } = createSilentLogger();
    await runDatabaseEnvironmentSetup({
      projectRoot,
      logger,
      inspectDockerVolumes: vi.fn().mockResolvedValue([]),
    });

    const tsxPath = path.resolve(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs');
    const verifyScript = path.resolve(import.meta.dirname, '../../scripts/verify-staging-db.ts');
    const migrateScript = path.resolve(import.meta.dirname, '../../scripts/migrate-target-db.ts');

    const baseChildEnv: Record<string, string | undefined> = { ...process.env };
    delete baseChildEnv.STAGING_DATABASE_URL;
    delete baseChildEnv.STAGING_POSTGRES_USER;
    delete baseChildEnv.STAGING_POSTGRES_PASSWORD;
    delete baseChildEnv.STAGING_POSTGRES_DB;
    delete baseChildEnv.TEST_DATABASE_URL;
    delete baseChildEnv.DATABASE_URL;
    delete baseChildEnv.UNIT_TEST_DATABASE_URL;
    delete baseChildEnv.SHADOW_DATABASE_URL;
    delete baseChildEnv.VITEST;
    baseChildEnv.NODE_ENV = 'development';

    // Case A: Conflicting shell STAGING_DATABASE_URL vs .env.staging fails closed without leaking secret
    const conflictingShellSecret = 'ConflictingShellStagingSecret_4242!';
    const conflictCli = spawnSync(process.execPath, [tsxPath, verifyScript], {
      cwd: projectRoot,
      env: {
        ...baseChildEnv,
        STAGING_DATABASE_URL: `postgresql://erp_staging_user:${conflictingShellSecret}@localhost:5435/core_erp_staging?schema=public`,
      },
      encoding: 'utf-8',
    });
    const conflictOut = `${conflictCli.stdout}\n${conflictCli.stderr}`;
    expect(conflictCli.status).toBe(1);
    expect(conflictOut).toContain('[shell environment :: STAGING_DATABASE_URL]');
    expect(conflictOut).toContain('[.env.staging :: STAGING_DATABASE_URL]');
    expect(conflictOut).not.toContain(conflictingShellSecret);

    // Case B: Misplaced STAGING_DATABASE_URL (port 5433) and TEST_DATABASE_URL in .env fail both CLI runners
    const misplacedPass = 'MisplacedDotEnvSecret_5353!';
    fs.appendFileSync(
      path.join(projectRoot, '.env'),
      [
        `STAGING_DATABASE_URL="postgresql://erp_test_user:${misplacedPass}@localhost:5433/core_erp_test?schema=public"`,
        `TEST_DATABASE_URL="postgresql://erp_integration_user:${misplacedPass}@localhost:5434/core_erp_integration_test?schema=public"`,
        '',
      ].join('\n'),
      'utf-8'
    );

    const misplacedVerify = spawnSync(process.execPath, [tsxPath, verifyScript], {
      cwd: projectRoot,
      env: baseChildEnv,
      encoding: 'utf-8',
    });
    const misplacedVerifyOut = `${misplacedVerify.stdout}\n${misplacedVerify.stderr}`;
    expect(misplacedVerify.status).toBe(1);
    expect(misplacedVerifyOut).toContain('[.env :: STAGING_DATABASE_URL]');
    expect(misplacedVerifyOut).not.toContain(misplacedPass);

    const misplacedMigrateInt = spawnSync(
      process.execPath,
      [tsxPath, migrateScript, '--target', 'integration'],
      {
        cwd: projectRoot,
        env: baseChildEnv,
        encoding: 'utf-8',
      }
    );
    const misplacedMigrateOut = `${misplacedMigrateInt.stdout}\n${misplacedMigrateInt.stderr}`;
    expect(misplacedMigrateInt.status).toBe(1);
    expect(misplacedMigrateOut).toContain('[.env :: TEST_DATABASE_URL]');
    expect(misplacedMigrateOut).not.toContain(misplacedPass);
  });
});
