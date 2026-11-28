import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REQUIRED_REPAIR_CONFIRMATION_FLAG,
  appendEnvAssignmentPreservingContent,
  defaultCreateFileBackup,
  defaultRestoreFileFromBackup,
  runLocalDatabaseEnvRepair,
  stripMisplacedVarsFromEnvContent,
  writeFileAtomicallyStrict,
  type DockerEnvironmentSnapshot,
  type PersistentEnvScopeEntry,
  type RepairLogger,
} from '../../src/server/db/repair-env.js';
import {
  parseEnvFileContent,
  runDatabaseEnvironmentSetup,
} from '../../src/server/db/setup-env.js';

function createSilentLogger(): { logger: RepairLogger; logs: string[] } {
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

const DOCKER_UNAVAILABLE: DockerEnvironmentSnapshot = {
  available: false,
  error: 'error during connect: docker daemon is not running',
  containers: [],
  volumes: [],
};

const DOCKER_AVAILABLE_MIXED: DockerEnvironmentSnapshot = {
  available: true,
  containers: [
    {
      name: 'coreerp-postgres-dev',
      state: 'running',
      ownership: 'COREERP_LOCAL',
      environment: 'development',
    },
    {
      name: 'coreerp-postgres-integration-test',
      state: 'running',
      ownership: 'COREERP_LOCAL',
      environment: 'integrationTest',
    },
    {
      name: 'coreerp-postgres',
      state: 'running',
      ownership: 'PRODUCTION_PROTECTED',
    },
    {
      name: 'unrelated-redis',
      state: 'running',
      ownership: 'UNRELATED_UNTOUCHED',
    },
  ],
  volumes: [
    {
      name: 'coreerp_postgres_dev_data',
      ownership: 'COREERP_LOCAL',
      environment: 'development',
    },
    {
      name: 'coreerp_postgres_integration_test_data',
      ownership: 'COREERP_LOCAL',
      environment: 'integrationTest',
    },
    {
      name: 'postgres_data',
      ownership: 'PRODUCTION_PROTECTED',
    },
    {
      name: 'other_project_volume',
      ownership: 'UNRELATED_UNTOUCHED',
    },
  ],
};

describe('CoreERP Permanent Local Database Environment Repair', () => {
  const tempDirs: string[] = [];

  function makeTempProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coreerp-repair-env-'));
    tempDirs.push(dir);
    return dir;
  }

  /**
   * Mirrors the exact verified Windows audit failure state:
   * - .env contains valid dev + shadow + custom keys, PLUS misplaced STAGING_DATABASE_URL and TEST_DATABASE_URL
   * - .env.integration-test exists with existing POSTGRES_PASSWORD, missing TEST_DATABASE_URL
   * - .env.staging is missing
   */
  function seedWindowsAuditScenario(dir: string, options?: { crlf?: boolean }) {
    const eol = options?.crlf ? '\r\n' : '\n';
    const devPass = 'DevLocalSecret_9911!';
    const shadowPass = 'ShadowLocalSecret_4422!';
    const integrationPass = 'IntExisting@Pass#55%88!';
    const misplacedStagingPass = 'MisplacedStaging_5433_Secret!';
    const misplacedTestPass = 'MisplacedTest_5433_Secret!';

    const originalEnv = [
      '# CoreERP local development config (user comment preserved)',
      'PORT=3000',
      'NODE_ENV=development',
      'CUSTOM_FEATURE_FLAG="enabled_exact_value"',
      'POSTGRES_USER="erp_user"',
      `POSTGRES_PASSWORD="${devPass}"`,
      'POSTGRES_DB="core_erp"',
      `DATABASE_URL="postgresql://erp_user:${encodeURIComponent(devPass)}@localhost:5432/core_erp?schema=public"`,
      `STAGING_DATABASE_URL="postgresql://erp_test_user:${encodeURIComponent(misplacedStagingPass)}@localhost:5433/core_erp_staging?schema=public"`,
      `TEST_DATABASE_URL="postgresql://erp_test_user:${encodeURIComponent(misplacedTestPass)}@localhost:5433/core_erp_test?schema=public"`,
      'SHADOW_POSTGRES_USER="erp_shadow_user"',
      `SHADOW_POSTGRES_PASSWORD="${shadowPass}"`,
      'SHADOW_POSTGRES_DB="core_erp_shadow"',
      `SHADOW_DATABASE_URL="postgresql://erp_shadow_user:${encodeURIComponent(shadowPass)}@localhost:5436/core_erp_shadow?schema=public"`,
      'SESSION_SECRET="session_secret_preserved_exactly_1234567890abcdef"',
      'BIOMETRIC_BRIDGE_TOKEN="bridge_token_preserved_exactly_1234567890"',
      '',
    ].join(eol);

    const originalIntegration = [
      '# Existing integration env file — preserve existing password',
      `POSTGRES_PASSWORD="${integrationPass}"`,
      'CUSTOM_INTEGRATION_NOTE="keep_me_intact"',
      '',
    ].join(eol);

    fs.writeFileSync(path.join(dir, '.env'), originalEnv, 'utf-8');
    fs.writeFileSync(path.join(dir, '.env.integration-test'), originalIntegration, 'utf-8');

    return {
      devPass,
      shadowPass,
      integrationPass,
      misplacedStagingPass,
      misplacedTestPass,
      originalEnv,
      originalIntegration,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1. Repairs incomplete .env.integration-test preserving existing password (including special chars) and appending canonical TEST_DATABASE_URL', async () => {
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);
    const { logger } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      now: () => new Date(2026, 10, 27, 1, 30, 0, 123),
    });

    expect(res.exitCode).toBe(0);
    expect(res.executed).toBe(true);
    expect(res.blocked).toBe(false);
    expect(res.verificationPassed).toBe(true);
    expect(res.modifiedFiles).toEqual(['.env', '.env.integration-test']);
    expect(res.createdFiles).toEqual(['.env.staging']);

    // Verify .env.integration-test preserved original bytes & existing POSTGRES_PASSWORD
    const repairedIntRaw = fs.readFileSync(path.join(dir, '.env.integration-test'), 'utf-8');
    expect(repairedIntRaw.startsWith(seeded.originalIntegration)).toBe(true);

    const parsedInt = parseEnvFileContent(repairedIntRaw);
    expect(parsedInt.POSTGRES_PASSWORD).toBe(seeded.integrationPass);
    expect(parsedInt.CUSTOM_INTEGRATION_NOTE).toBe('keep_me_intact');
    expect(parsedInt.TEST_DATABASE_URL).toBe(
      `postgresql://erp_integration_user:${encodeURIComponent(seeded.integrationPass)}@localhost:5434/core_erp_integration_test?schema=public`
    );

    // Round-trip URL decode verifies password matches byte-for-byte
    const parsedUrl = new URL(parsedInt.TEST_DATABASE_URL);
    expect(parsedUrl.username).toBe('erp_integration_user');
    expect(decodeURIComponent(parsedUrl.password)).toBe(seeded.integrationPass);
    expect(parsedUrl.hostname).toBe('localhost');
    expect(parsedUrl.port).toBe('5434');
    expect(parsedUrl.pathname).toBe('/core_erp_integration_test');
  });

  it('2. Removes ONLY misplaced STAGING_DATABASE_URL and TEST_DATABASE_URL from .env while preserving unrelated entries and Windows CRLF byte-for-byte', async () => {
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir, { crlf: true });
    const { logger } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(res.exitCode).toBe(0);

    const repairedEnvRaw = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    const expectedEnv = seeded.originalEnv
      .split('\r\n')
      .filter(
        (line) =>
          !line.startsWith('STAGING_DATABASE_URL=') && !line.startsWith('TEST_DATABASE_URL=')
      )
      .join('\r\n');

    expect(repairedEnvRaw).toBe(expectedEnv);
    expect(repairedEnvRaw).toContain('\r\n');
    expect(repairedEnvRaw).toContain('# CoreERP local development config (user comment preserved)');
    expect(repairedEnvRaw).toContain('CUSTOM_FEATURE_FLAG="enabled_exact_value"');
    expect(repairedEnvRaw).toContain('SESSION_SECRET="session_secret_preserved_exactly_1234567890abcdef"');
    expect(repairedEnvRaw).toContain('BIOMETRIC_BRIDGE_TOKEN="bridge_token_preserved_exactly_1234567890"');
    expect(repairedEnvRaw).not.toContain('STAGING_DATABASE_URL=');
    expect(repairedEnvRaw).not.toContain('TEST_DATABASE_URL=');

    // Pure helper unit check on edge cases (export prefix, no trailing newline)
    const stripped = stripMisplacedVarsFromEnvContent(
      'KEEP_A=1\nexport STAGING_DATABASE_URL=bad\nKEEP_B="2"\nTEST_DATABASE_URL=bad2',
      new Set(['STAGING_DATABASE_URL', 'TEST_DATABASE_URL'])
    );
    expect(stripped.removedKeys).toEqual(['STAGING_DATABASE_URL', 'TEST_DATABASE_URL']);
    expect(stripped.updatedContent).toBe('KEEP_A=1\nKEEP_B="2"\n');

    const appended = appendEnvAssignmentPreservingContent(
      'POSTGRES_PASSWORD="abc"',
      'TEST_DATABASE_URL',
      'postgresql://u:p@localhost:5434/core_erp_integration_test?schema=public'
    );
    expect(appended).toBe(
      'POSTGRES_PASSWORD="abc"\nTEST_DATABASE_URL="postgresql://u:p@localhost:5434/core_erp_integration_test?schema=public"\n'
    );
  });

  it('3. Creates missing .env.staging with unique isolated credentials distinct from development and integration passwords', async () => {
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);
    const { logger } = createSilentLogger();

    // First two calls intentionally collide with devPass and integrationPass; third call returns unique secret
    const secretQueue = [
      seeded.devPass,
      seeded.integrationPass,
      'unique_staging_secret_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d',
    ];
    let idx = 0;

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      generateSecret: () => secretQueue[Math.min(idx++, secretQueue.length - 1)],
    });

    expect(res.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, '.env.staging'))).toBe(true);

    const parsedStaging = parseEnvFileContent(
      fs.readFileSync(path.join(dir, '.env.staging'), 'utf-8')
    );
    expect(parsedStaging.STAGING_POSTGRES_USER).toBe('erp_staging_user');
    expect(parsedStaging.STAGING_POSTGRES_DB).toBe('core_erp_staging');
    expect(parsedStaging.STAGING_POSTGRES_PASSWORD).toBe(
      'unique_staging_secret_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d'
    );
    expect(parsedStaging.STAGING_POSTGRES_PASSWORD).not.toBe(seeded.devPass);
    expect(parsedStaging.STAGING_POSTGRES_PASSWORD).not.toBe(seeded.integrationPass);
    expect(parsedStaging.STAGING_DATABASE_URL).toBe(
      'postgresql://erp_staging_user:unique_staging_secret_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d@localhost:5435/core_erp_staging?schema=public'
    );

    // Also verify existing .env.staging reusing dev password is BLOCKED (never overwritten)
    const collisionDir = makeTempProject();
    const s2 = seedWindowsAuditScenario(collisionDir);
    const collidingStagingRaw = [
      'STAGING_POSTGRES_USER="erp_staging_user"',
      `STAGING_POSTGRES_PASSWORD="${s2.devPass}"`,
      'STAGING_POSTGRES_DB="core_erp_staging"',
      `STAGING_DATABASE_URL="postgresql://erp_staging_user:${encodeURIComponent(s2.devPass)}@localhost:5435/core_erp_staging?schema=public"`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(collisionDir, '.env.staging'), collidingStagingRaw, 'utf-8');

    const blockedRes = await runLocalDatabaseEnvRepair({
      projectRoot: collisionDir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(blockedRes.exitCode).toBe(1);
    expect(blockedRes.blocked).toBe(true);
    expect(blockedRes.executed).toBe(false);
    expect(fs.readFileSync(path.join(collisionDir, '.env.staging'), 'utf-8')).toBe(
      collidingStagingRaw
    );
    // Stop before modifying .env or .env.integration-test too!
    expect(fs.readFileSync(path.join(collisionDir, '.env'), 'utf-8')).toBe(s2.originalEnv);
    expect(fs.readFileSync(path.join(collisionDir, '.env.integration-test'), 'utf-8')).toBe(
      s2.originalIntegration
    );
  });

  it('4. Detects Process, User, and Machine shell overrides with exact manual PowerShell remediation and zero automatic env modification', async () => {
    const dir = makeTempProject();
    seedWindowsAuditScenario(dir);
    const { logger, logs } = createSilentLogger();

    const shellTestSecret = 'ShellTestOverrideSecret_1111!';
    const shellStagingSecret = 'ShellStagingOverrideSecret_2222!';
    const machineStagingSecret = 'MachineStagingOverrideSecret_3333!';

    const fakeShellEnv: Record<string, string | undefined> = {
      TEST_DATABASE_URL: `postgresql://erp_test_user:${shellTestSecret}@localhost:5433/core_erp_test?schema=public`,
      STAGING_DATABASE_URL: `postgresql://erp_test_user:${shellStagingSecret}@localhost:5433/core_erp_staging?schema=public`,
    };
    const fakePersistent: PersistentEnvScopeEntry[] = [
      {
        variable: 'TEST_DATABASE_URL',
        userValue: `postgresql://erp_test_user:${shellTestSecret}@localhost:5433/core_erp_test?schema=public`,
      },
      {
        variable: 'STAGING_DATABASE_URL',
        machineValue: `postgresql://erp_test_user:${machineStagingSecret}@localhost:5433/core_erp_staging?schema=public`,
      },
    ];

    const snapshotShell = { ...fakeShellEnv };

    const checkRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: fakeShellEnv,
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => fakePersistent,
    });

    expect(checkRes.exitCode).toBe(1);
    expect(checkRes.executed).toBe(false);
    expect(checkRes.shellOverrides).toHaveLength(2);

    const testOverride = checkRes.shellOverrides.find((o) => o.variable === 'TEST_DATABASE_URL');
    const stagingOverride = checkRes.shellOverrides.find(
      (o) => o.variable === 'STAGING_DATABASE_URL'
    );

    expect(testOverride?.scopeLabel).toBe('Process+User');
    expect(testOverride?.remediationCommands).toContain(
      'Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue'
    );
    expect(
      testOverride?.remediationCommands.some((c) =>
        c.includes("[Environment]::SetEnvironmentVariable('TEST_DATABASE_URL', $null, 'User')")
      )
    ).toBe(true);

    expect(stagingOverride?.scopeLabel).toBe('Process+Machine');
    expect(stagingOverride?.remediationCommands).toContain(
      'Remove-Item Env:STAGING_DATABASE_URL -ErrorAction SilentlyContinue'
    );
    expect(
      stagingOverride?.remediationCommands.some((c) =>
        c.includes(
          "[Environment]::SetEnvironmentVariable('STAGING_DATABASE_URL', $null, 'Machine')"
        )
      )
    ).toBe(true);

    // Shell env object was NEVER mutated
    expect(fakeShellEnv).toEqual(snapshotShell);

    // Zero shell/persistent secrets leaked into logs or findings
    const allOutput = [
      ...logs,
      ...checkRes.findings.map((f) => f.message),
      ...checkRes.manualRemediation,
      ...checkRes.warnings,
    ].join('\n');
    expect(allOutput).not.toContain(shellTestSecret);
    expect(allOutput).not.toContain(shellStagingSecret);
    expect(allOutput).not.toContain(machineStagingSecret);
  });

  it('5. Enforces dry-run zero mutations for CHECK, default DRY_RUN, and unconfirmed REPAIR calls', async () => {
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);

    for (const opts of [
      { mode: 'CHECK' as const, confirmed: false },
      { mode: 'DRY_RUN' as const, confirmed: false },
      { mode: 'REPAIR' as const, confirmed: false }, // Must downgrade to DRY_RUN without confirmation!
    ]) {
      const { logger } = createSilentLogger();
      const res = await runLocalDatabaseEnvRepair({
        projectRoot: dir,
        ...opts,
        shellEnv: {},
        logger,
        inspectDocker: async () => DOCKER_UNAVAILABLE,
        inspectPersistentEnvScopes: async () => [],
      });

      expect(res.executed).toBe(false);
      expect(res.backups).toHaveLength(0);
      expect(res.modifiedFiles).toHaveLength(0);
      expect(res.createdFiles).toHaveLength(0);
      if (opts.mode === 'CHECK') {
        expect(res.exitCode).toBe(1);
        expect(res.mode).toBe('CHECK');
      } else {
        expect(res.exitCode).toBe(0);
        expect(res.mode).toBe('DRY_RUN');
      }
    }

    // Verify zero files created, zero backups created, zero bytes modified
    const dirEntries = fs.readdirSync(dir).sort();
    expect(dirEntries).toEqual(['.env', '.env.integration-test']);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe(seeded.originalEnv);
    expect(fs.readFileSync(path.join(dir, '.env.integration-test'), 'utf-8')).toBe(
      seeded.originalIntegration
    );
  });

  it('6. Stops BEFORE changing any files when an unsafe/blocked condition exists (missing integration password, invalid existing TEST_DATABASE_URL, missing .env)', async () => {
    // 6a. Existing .env.integration-test has NO POSTGRES_PASSWORD -> must block (never fabricate password)
    const dirNoIntPass = makeTempProject();
    const s1 = seedWindowsAuditScenario(dirNoIntPass);
    const emptyIntRaw = '# Incomplete integration file with no password\n';
    fs.writeFileSync(path.join(dirNoIntPass, '.env.integration-test'), emptyIntRaw, 'utf-8');

    const resNoIntPass = await runLocalDatabaseEnvRepair({
      projectRoot: dirNoIntPass,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(resNoIntPass.exitCode).toBe(1);
    expect(resNoIntPass.blocked).toBe(true);
    expect(resNoIntPass.executed).toBe(false);
    expect(resNoIntPass.backups).toHaveLength(0);
    expect(fs.readFileSync(path.join(dirNoIntPass, '.env'), 'utf-8')).toBe(s1.originalEnv);
    expect(fs.readFileSync(path.join(dirNoIntPass, '.env.integration-test'), 'utf-8')).toBe(
      emptyIntRaw
    );
    expect(fs.existsSync(path.join(dirNoIntPass, '.env.staging'))).toBe(false);

    // 6b. Existing .env.integration-test already has an invalid TEST_DATABASE_URL (wrong port 5433) -> must block
    const dirBadIntUrl = makeTempProject();
    const s2 = seedWindowsAuditScenario(dirBadIntUrl);
    const badIntRaw =
      'POSTGRES_PASSWORD="StrongIntPass_7788!"\nTEST_DATABASE_URL="postgresql://erp_integration_user:StrongIntPass_7788!@localhost:5433/core_erp_test"\n';
    fs.writeFileSync(path.join(dirBadIntUrl, '.env.integration-test'), badIntRaw, 'utf-8');

    const resBadIntUrl = await runLocalDatabaseEnvRepair({
      projectRoot: dirBadIntUrl,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(resBadIntUrl.exitCode).toBe(1);
    expect(resBadIntUrl.blocked).toBe(true);
    expect(fs.readFileSync(path.join(dirBadIntUrl, '.env'), 'utf-8')).toBe(s2.originalEnv);
    expect(fs.readFileSync(path.join(dirBadIntUrl, '.env.integration-test'), 'utf-8')).toBe(
      badIntRaw
    );
    expect(fs.existsSync(path.join(dirBadIntUrl, '.env.staging'))).toBe(false);

    // 6c. Missing .env -> must block without creating .env.staging
    const dirMissingEnv = makeTempProject();
    fs.writeFileSync(
      path.join(dirMissingEnv, '.env.integration-test'),
      'POSTGRES_PASSWORD="StrongIntPass_9988!"\n',
      'utf-8'
    );

    const resMissingEnv = await runLocalDatabaseEnvRepair({
      projectRoot: dirMissingEnv,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(resMissingEnv.exitCode).toBe(1);
    expect(resMissingEnv.blocked).toBe(true);
    expect(fs.existsSync(path.join(dirMissingEnv, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dirMissingEnv, '.env.staging'))).toBe(false);
  });

  it('7. Creates pre-repair backups and aborts cleanly on backup failure or rolls back cleanly on atomic write failure', async () => {
    // 7a. Backup failure aborts BEFORE modifying any live file
    const dirBackupFail = makeTempProject();
    const s1 = seedWindowsAuditScenario(dirBackupFail);

    const resBackupFail = await runLocalDatabaseEnvRepair({
      projectRoot: dirBackupFail,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      createBackup: () => {
        throw new Error('ENOSPC: no space left on device during backup');
      },
    });

    expect(resBackupFail.exitCode).toBe(1);
    expect(resBackupFail.executed).toBe(false);
    expect(resBackupFail.modifiedFiles).toHaveLength(0);
    expect(fs.readFileSync(path.join(dirBackupFail, '.env'), 'utf-8')).toBe(s1.originalEnv);
    expect(fs.readFileSync(path.join(dirBackupFail, '.env.integration-test'), 'utf-8')).toBe(
      s1.originalIntegration
    );
    expect(fs.existsSync(path.join(dirBackupFail, '.env.staging'))).toBe(false);

    // 7b. Atomic write failure on 2nd file rolls back 1st file from backup and leaves zero corrupted state
    const dirWriteFail = makeTempProject();
    const s2 = seedWindowsAuditScenario(dirWriteFail);
    let writeCount = 0;

    const resWriteFail = await runLocalDatabaseEnvRepair({
      projectRoot: dirWriteFail,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      writeFileAtomically: (filePath, content) => {
        writeCount += 1;
        if (writeCount === 2) {
          throw new Error('EACCES: simulated atomic rename failure on second file');
        }
        writeFileAtomicallyStrict(filePath, content);
      },
    });

    expect(resWriteFail.exitCode).toBe(1);
    expect(resWriteFail.executed).toBe(false);
    expect(resWriteFail.verificationPassed).toBe(false);
    // Backups were created before the failure
    expect(resWriteFail.backups).toHaveLength(2);
    // File #1 (.env) was rolled back byte-for-byte to original content
    expect(fs.readFileSync(path.join(dirWriteFail, '.env'), 'utf-8')).toBe(s2.originalEnv);
    expect(fs.readFileSync(path.join(dirWriteFail, '.env.integration-test'), 'utf-8')).toBe(
      s2.originalIntegration
    );
    expect(fs.existsSync(path.join(dirWriteFail, '.env.staging'))).toBe(false);

    // 7c. Direct check that writeFileAtomicallyStrict leaves no orphan .tmp files when rename fails
    const dirTmpCheck = makeTempProject();
    const targetDirAsFile = path.join(dirTmpCheck, 'cannot_overwrite_dir');
    fs.mkdirSync(targetDirAsFile);
    expect(() => writeFileAtomicallyStrict(targetDirAsFile, 'content')).toThrow();
    const leftovers = fs
      .readdirSync(dirTmpCheck)
      .filter((name) => name.includes('.tmp.'));
    expect(leftovers).toHaveLength(0);
  });

  it('8. Is strictly idempotent across repeated executions (no duplicate keys, no regenerated credentials, no redundant backups)', async () => {
    const dir = makeTempProject();
    seedWindowsAuditScenario(dir);
    const { logger: log1 } = createSilentLogger();

    const first = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: log1,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      now: () => new Date(2026, 10, 27, 2, 0, 0, 100),
    });

    expect(first.exitCode).toBe(0);
    expect(first.executed).toBe(true);
    expect(first.backups).toHaveLength(2);

    const envAfterFirst = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    const intAfterFirst = fs.readFileSync(path.join(dir, '.env.integration-test'), 'utf-8');
    const stagingAfterFirst = fs.readFileSync(path.join(dir, '.env.staging'), 'utf-8');
    const filesAfterFirst = fs.readdirSync(dir).sort();

    // Second confirmed run must be a complete NO-OP
    const { logger: log2 } = createSilentLogger();
    const second = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: log2,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      now: () => new Date(2026, 10, 27, 2, 5, 0, 200),
    });

    expect(second.exitCode).toBe(0);
    expect(second.executed).toBe(false);
    expect(second.backups).toHaveLength(0);
    expect(second.modifiedFiles).toHaveLength(0);
    expect(second.createdFiles).toHaveLength(0);
    expect(second.verificationPassed).toBe(true);

    // Byte-for-byte identical files & zero extra backups
    expect(fs.readdirSync(dir).sort()).toEqual(filesAfterFirst);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe(envAfterFirst);
    expect(fs.readFileSync(path.join(dir, '.env.integration-test'), 'utf-8')).toBe(intAfterFirst);
    expect(fs.readFileSync(path.join(dir, '.env.staging'), 'utf-8')).toBe(stagingAfterFirst);

    // Exactly one TEST_DATABASE_URL line in .env.integration-test
    const testUrlMatches = intAfterFirst
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('TEST_DATABASE_URL='));
    expect(testUrlMatches).toHaveLength(1);

    // Subsequent strictly read-only `db:setup:check` passes cleanly
    const setupCheck = await runDatabaseEnvironmentSetup({
      projectRoot: dir,
      checkOnly: true,
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDockerVolumes: async () => null,
    });
    expect(setupCheck.exitCode).toBe(0);
    expect(setupCheck.issues).toEqual([]);
  });

  it('9. Redacts all passwords, encoded passwords, and raw connection URLs across all modes and outputs', async () => {
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);
    const stagingSecret = 'SuperSecretStagingPassword_XYZ987!';
    const { logger, logs } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {
        TEST_DATABASE_URL: `postgresql://erp_test_user:ShellLeakPass_5544!@localhost:5433/core_erp_test`,
      },
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
      generateSecret: () => stagingSecret,
    });

    expect(res.exitCode).toBe(0);

    const combined = JSON.stringify({
      logs,
      findings: res.findings,
      shellOverrides: res.shellOverrides,
      actions: res.actions,
      warnings: res.warnings,
      blockers: res.blockers,
      manualRemediation: res.manualRemediation,
    });

    for (const secret of [
      seeded.devPass,
      encodeURIComponent(seeded.devPass),
      seeded.shadowPass,
      seeded.integrationPass,
      encodeURIComponent(seeded.integrationPass),
      seeded.misplacedStagingPass,
      seeded.misplacedTestPass,
      stagingSecret,
      'ShellLeakPass_5544!',
      'session_secret_preserved_exactly_1234567890abcdef',
      'bridge_token_preserved_exactly_1234567890',
    ]) {
      expect(combined).not.toContain(secret);
    }
  });

  it('10. Handles Docker daemon unavailability safely and classifies container/volume ownership without mutating Docker or databases', async () => {
    const dir = makeTempProject();
    seedWindowsAuditScenario(dir);

    // 10a. Docker unavailable: reported separately, does NOT block safe local file repair
    const inspectDockerUnavailable = vi.fn().mockResolvedValue(DOCKER_UNAVAILABLE);
    const { logger: l1, logs: logs1 } = createSilentLogger();
    const resUnavailable = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'DRY_RUN',
      shellEnv: {},
      logger: l1,
      inspectDocker: inspectDockerUnavailable,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(inspectDockerUnavailable).toHaveBeenCalledTimes(1);
    expect(resUnavailable.docker.available).toBe(false);
    expect(resUnavailable.blocked).toBe(false);
    expect(resUnavailable.exitCode).toBe(0);
    expect(
      resUnavailable.findings.some((f) => f.category === 'DOCKER_UNAVAILABLE')
    ).toBe(true);
    expect(logs1.join('\n')).toContain('UNAVAILABLE');

    // 10b. Docker available: reports CoreERP local, PRODUCTION_PROTECTED, and UNRELATED_UNTOUCHED ownership
    const inspectDockerAvailable = vi.fn().mockResolvedValue(DOCKER_AVAILABLE_MIXED);
    const { logger: l2, logs: logs2 } = createSilentLogger();
    const resAvailable = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {},
      logger: l2,
      inspectDocker: inspectDockerAvailable,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(resAvailable.docker.available).toBe(true);
    expect(
      resAvailable.docker.containers.find((c) => c.name === 'coreerp-postgres')?.ownership
    ).toBe('PRODUCTION_PROTECTED');
    expect(
      resAvailable.docker.volumes.find((v) => v.name === 'postgres_data')?.ownership
    ).toBe('PRODUCTION_PROTECTED');
    expect(
      resAvailable.docker.containers.find((c) => c.name === 'unrelated-redis')?.ownership
    ).toBe('UNRELATED_UNTOUCHED');
    expect(logs2.join('\n')).toContain('Production-protected resources (NEVER touched)');
    expect(logs2.join('\n')).toContain('Unrelated Docker resources (NEVER touched)');

    // 10c. Static safety check: repair engine never invokes mutating Docker, migration, or clean-reset commands
    const repairSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'server', 'db', 'repair-env.ts'),
      'utf-8'
    );
    expect(repairSource).not.toMatch(/execFileReadOnly\(\s*['"]docker['"],\s*\[\s*['"](rm|stop|down|up|create|volume\s+rm)/);
    expect(repairSource).not.toContain('migrate deploy');
    expect(repairSource).not.toContain('runCoreErpCleanReset');
    expect(repairSource).not.toContain('system prune');
  });

  it('11. CLI scripts (db:repair:check & db:repair:local) and package.json wiring work safely in isolated directory without mutating files', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')
    );
    expect(pkg.scripts['db:repair:check']).toBe('tsx scripts/repair-db-env.ts --check');
    expect(pkg.scripts['db:repair:local']).toBe('tsx scripts/repair-db-env.ts');
    expect(pkg.scripts['db:setup:check']).toBe('tsx scripts/setup-db-env.ts --check');

    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);
    const scriptPath = path.join(repoRoot, 'scripts', 'repair-db-env.ts');

    // Resolve installed tsx JS CLI entrypoint from node_modules (never spawn Windows .cmd shims)
    const tsxPkgPath = path.join(repoRoot, 'node_modules', 'tsx', 'package.json');
    const tsxPkg = JSON.parse(fs.readFileSync(tsxPkgPath, 'utf-8')) as {
      bin?: string | Record<string, string>;
    };
    const tsxBinRel =
      typeof tsxPkg.bin === 'string'
        ? tsxPkg.bin
        : tsxPkg.bin?.tsx ?? './dist/cli.mjs';
    const tsxCliPath = path.resolve(path.dirname(tsxPkgPath), tsxBinRel);
    expect(fs.existsSync(tsxCliPath)).toBe(true);

    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      COMSPEC: process.env.COMSPEC,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      NODE_ENV: 'development',
    };

    // Default dry-run (`db:repair:local` with no confirmation flag) exits 0 and mutates ZERO files
    const dryRunRes = spawnSync(process.execPath, [tsxCliPath, scriptPath], {
      cwd: dir,
      env: cleanEnv,
      encoding: 'utf-8',
      timeout: 15_000,
      windowsHide: true,
    });
    const dryRunOut = `${dryRunRes.stdout || ''}\n${dryRunRes.stderr || ''}`;
    expect(dryRunRes.error).toBeUndefined();
    expect(dryRunRes.status, `Dry-run CLI exited with ${dryRunRes.status}:\n${dryRunOut}`).toBe(0);
    expect(dryRunOut).toContain('DRY-RUN COMPLETE');
    expect(dryRunOut).toContain(REQUIRED_REPAIR_CONFIRMATION_FLAG);
    // Clean process environment must never produce false-positive Process-scope shell overrides (even when .env exists)
    expect(dryRunOut).not.toContain('[shell environment (Process)');
    expect(dryRunOut).not.toContain(seeded.devPass);
    expect(dryRunOut).not.toContain(seeded.integrationPass);
    expect(fs.readdirSync(dir).sort()).toEqual(['.env', '.env.integration-test']);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe(seeded.originalEnv);
    expect(fs.readFileSync(path.join(dir, '.env.integration-test'), 'utf-8')).toBe(
      seeded.originalIntegration
    );

    // `--check` exits 1 when issues exist, even if confirmation flag is also passed, and mutates ZERO files
    const checkRes = spawnSync(
      process.execPath,
      [tsxCliPath, scriptPath, '--check', REQUIRED_REPAIR_CONFIRMATION_FLAG],
      {
        cwd: dir,
        env: cleanEnv,
        encoding: 'utf-8',
        timeout: 15_000,
        windowsHide: true,
      }
    );
    const checkOut = `${checkRes.stdout || ''}\n${checkRes.stderr || ''}`;
    expect(checkRes.error).toBeUndefined();
    expect(checkRes.status, `Check CLI exited with ${checkRes.status}:\n${checkOut}`).toBe(1);
    expect(checkOut).toContain('Read-Only');
    expect(checkOut).toContain('STAGING_DATABASE_URL');
    expect(checkOut).toContain('TEST_DATABASE_URL');
    expect(checkOut).not.toContain('[shell environment (Process)');
    expect(checkOut).not.toContain(seeded.devPass);
    expect(checkOut).not.toContain(seeded.integrationPass);
    expect(fs.readdirSync(dir).sort()).toEqual(['.env', '.env.integration-test']);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe(seeded.originalEnv);
    expect(fs.readFileSync(path.join(dir, '.env.integration-test'), 'utf-8')).toBe(
      seeded.originalIntegration
    );
  });

  function seedCleanFiveEnvFiles(dir: string) {
    const devPass = 'CleanDevSecret_1010!';
    const shadowPass = 'CleanShadowSecret_2020!';
    const intPass = 'CleanIntSecret_3030!';
    const stagingPass = 'CleanStagingSecret_4040!';

    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        'PORT=3000',
        'NODE_ENV=development',
        'POSTGRES_USER="erp_user"',
        `POSTGRES_PASSWORD="${devPass}"`,
        'POSTGRES_DB="core_erp"',
        `DATABASE_URL="postgresql://erp_user:${encodeURIComponent(devPass)}@localhost:5432/core_erp?schema=public"`,
        'SHADOW_POSTGRES_USER="erp_shadow_user"',
        `SHADOW_POSTGRES_PASSWORD="${shadowPass}"`,
        'SHADOW_POSTGRES_DB="core_erp_shadow"',
        `SHADOW_DATABASE_URL="postgresql://erp_shadow_user:${encodeURIComponent(shadowPass)}@localhost:5436/core_erp_shadow?schema=public"`,
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(dir, '.env.integration-test'),
      [
        `POSTGRES_PASSWORD="${intPass}"`,
        `TEST_DATABASE_URL="postgresql://erp_integration_user:${encodeURIComponent(intPass)}@localhost:5434/core_erp_integration_test?schema=public"`,
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(dir, '.env.staging'),
      [
        'STAGING_POSTGRES_USER="erp_staging_user"',
        `STAGING_POSTGRES_PASSWORD="${stagingPass}"`,
        'STAGING_POSTGRES_DB="core_erp_staging"',
        `STAGING_DATABASE_URL="postgresql://erp_staging_user:${encodeURIComponent(stagingPass)}@localhost:5435/core_erp_staging?schema=public"`,
        '',
      ].join('\n'),
      'utf-8'
    );

    return { devPass, shadowPass, intPass, stagingPass };
  }

  it('12. [Test A] Reports zero shell override findings when TEST_DATABASE_URL and STAGING_DATABASE_URL are absent from Process, User, and Machine scopes', async () => {
    // A1. Valid target-file configuration alone must pass CHECK with exitCode 0 and zero shell overrides
    const cleanDir = makeTempProject();
    seedCleanFiveEnvFiles(cleanDir);
    const { logger: cleanLogger, logs: cleanLogs } = createSilentLogger();

    const cleanRes = await runLocalDatabaseEnvRepair({
      projectRoot: cleanDir,
      mode: 'CHECK',
      shellEnv: {},
      logger: cleanLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(cleanRes.exitCode).toBe(0);
    expect(cleanRes.shellOverrides).toEqual([]);
    expect(cleanRes.findings.filter((f) => f.category === 'SHELL_OVERRIDE')).toEqual([]);
    expect(cleanRes.manualRemediation).toEqual([]);
    expect(cleanRes.actions.some((a) => a.operation === 'MANUAL_SHELL_CLEANUP')).toBe(false);
    expect(cleanLogs.join('\n')).not.toContain('Shell / Persistent Environment Overrides');

    // A2. Even when .env has misplaced STAGING_DATABASE_URL / TEST_DATABASE_URL, absent shell/persistent scopes must produce zero shell overrides
    const misplacedDir = makeTempProject();
    seedWindowsAuditScenario(misplacedDir);
    const { logger: misplacedLogger, logs: misplacedLogs } = createSilentLogger();

    const misplacedRes = await runLocalDatabaseEnvRepair({
      projectRoot: misplacedDir,
      mode: 'CHECK',
      shellEnv: {},
      logger: misplacedLogger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(misplacedRes.exitCode).toBe(1);
    expect(misplacedRes.shellOverrides).toEqual([]);
    expect(misplacedRes.findings.filter((f) => f.category === 'SHELL_OVERRIDE')).toEqual([]);
    expect(misplacedRes.manualRemediation).toEqual([]);
    expect(misplacedLogs.join('\n')).not.toContain('Shell / Persistent Environment Overrides');

    // A3. Whitespace-only or empty-string values in Process/User/Machine must also be treated as absent
    const wsRes = await runLocalDatabaseEnvRepair({
      projectRoot: cleanDir,
      mode: 'CHECK',
      shellEnv: {
        TEST_DATABASE_URL: '   ',
        STAGING_DATABASE_URL: '',
      },
      logger: createSilentLogger().logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [
        { variable: 'TEST_DATABASE_URL', userValue: '  ', machineValue: '' },
        { variable: 'STAGING_DATABASE_URL', userValue: '', machineValue: '   ' },
      ],
    });
    expect(wsRes.exitCode).toBe(0);
    expect(wsRes.shellOverrides).toEqual([]);
    expect(wsRes.findings.filter((f) => f.category === 'SHELL_OVERRIDE')).toEqual([]);
    expect(wsRes.manualRemediation).toEqual([]);
  });

  it('13. [Test B] Detects genuine TEST_DATABASE_URL in Process scope (both matching-target shadowing and credential conflict) without falsely flagging STAGING_DATABASE_URL', async () => {
    const dir = makeTempProject();
    const { intPass } = seedCleanFiveEnvFiles(dir);
    const { logger, logs } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {
        TEST_DATABASE_URL: `postgresql://erp_integration_user:${encodeURIComponent(intPass)}@localhost:5434/core_erp_integration_test?schema=public`,
      },
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(res.exitCode).toBe(1);
    expect(res.shellOverrides).toHaveLength(1);
    expect(res.shellOverrides[0].variable).toBe('TEST_DATABASE_URL');
    expect(res.shellOverrides[0].scopes).toEqual(['Process']);
    expect(res.shellOverrides[0].scopeLabel).toBe('Process');
    expect(res.shellOverrides[0].status).toBe('MATCHES_TARGET');
    expect(res.shellOverrides[0].remediationCommands).toContain(
      'Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue'
    );
    expect(res.findings.filter((f) => f.category === 'SHELL_OVERRIDE')).toHaveLength(1);
    expect(res.shellOverrides.some((o) => o.variable === 'STAGING_DATABASE_URL')).toBe(false);
    expect(logs.join('\n')).not.toContain(intPass);

    // B2. Same endpoint in Process scope with mismatched password must classify as CONFLICTING_OR_WRONG_TARGET
    const wrongIntCredSecret = 'MismatchedProcessIntSecret_4411!';
    const { logger: conflictLogger, logs: conflictLogs } = createSilentLogger();
    const conflictRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {
        TEST_DATABASE_URL: `postgresql://erp_integration_user:${encodeURIComponent(wrongIntCredSecret)}@localhost:5434/core_erp_integration_test?schema=public`,
      },
      logger: conflictLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(conflictRes.exitCode).toBe(1);
    expect(conflictRes.shellOverrides).toHaveLength(1);
    expect(conflictRes.shellOverrides[0].variable).toBe('TEST_DATABASE_URL');
    expect(conflictRes.shellOverrides[0].scopeLabel).toBe('Process');
    expect(conflictRes.shellOverrides[0].status).toBe('CONFLICTING_OR_WRONG_TARGET');
    expect(conflictLogs.join('\n')).not.toContain(wrongIntCredSecret);
  });

  it('14. [Test C] Detects genuine STAGING_DATABASE_URL in Process scope (both matching-target shadowing and credential conflict) without falsely flagging TEST_DATABASE_URL', async () => {
    const dir = makeTempProject();
    const { stagingPass } = seedCleanFiveEnvFiles(dir);
    const { logger, logs } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {
        STAGING_DATABASE_URL: `postgresql://erp_staging_user:${encodeURIComponent(stagingPass)}@localhost:5435/core_erp_staging?schema=public`,
      },
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(res.exitCode).toBe(1);
    expect(res.shellOverrides).toHaveLength(1);
    expect(res.shellOverrides[0].variable).toBe('STAGING_DATABASE_URL');
    expect(res.shellOverrides[0].scopes).toEqual(['Process']);
    expect(res.shellOverrides[0].scopeLabel).toBe('Process');
    expect(res.shellOverrides[0].status).toBe('MATCHES_TARGET');
    expect(res.shellOverrides[0].remediationCommands).toContain(
      'Remove-Item Env:STAGING_DATABASE_URL -ErrorAction SilentlyContinue'
    );
    expect(res.findings.filter((f) => f.category === 'SHELL_OVERRIDE')).toHaveLength(1);
    expect(res.shellOverrides.some((o) => o.variable === 'TEST_DATABASE_URL')).toBe(false);
    expect(logs.join('\n')).not.toContain(stagingPass);

    // C2. Same endpoint in Process scope with mismatched password must classify as CONFLICTING_OR_WRONG_TARGET
    const wrongStagingCredSecret = 'MismatchedProcessStagingSecret_5522!';
    const { logger: conflictLogger, logs: conflictLogs } = createSilentLogger();
    const conflictRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {
        STAGING_DATABASE_URL: `postgresql://erp_staging_user:${encodeURIComponent(wrongStagingCredSecret)}@localhost:5435/core_erp_staging?schema=public`,
      },
      logger: conflictLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(conflictRes.exitCode).toBe(1);
    expect(conflictRes.shellOverrides).toHaveLength(1);
    expect(conflictRes.shellOverrides[0].variable).toBe('STAGING_DATABASE_URL');
    expect(conflictRes.shellOverrides[0].scopeLabel).toBe('Process');
    expect(conflictRes.shellOverrides[0].status).toBe('CONFLICTING_OR_WRONG_TARGET');
    expect(conflictLogs.join('\n')).not.toContain(wrongStagingCredSecret);
  });

  it('15. [Test D] Flags wrong Process endpoint as CONFLICTING_OR_WRONG_TARGET with exact manual PowerShell remediation and secret redaction', async () => {
    const dir = makeTempProject();
    seedCleanFiveEnvFiles(dir);
    const wrongProcessSecret = 'WrongProcessPort5433Secret_8899!';
    const { logger, logs } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {
        STAGING_DATABASE_URL: `postgresql://erp_test_user:${encodeURIComponent(wrongProcessSecret)}@localhost:5433/core_erp_test?schema=public`,
      },
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(res.exitCode).toBe(1);
    expect(res.shellOverrides).toHaveLength(1);
    expect(res.shellOverrides[0].variable).toBe('STAGING_DATABASE_URL');
    expect(res.shellOverrides[0].scopeLabel).toBe('Process');
    expect(res.shellOverrides[0].status).toBe('CONFLICTING_OR_WRONG_TARGET');
    expect(res.shellOverrides[0].resolvedEndpoint).toBe('127.0.0.1:5433/core_erp_test');
    expect(res.manualRemediation).toContain(
      'Remove-Item Env:STAGING_DATABASE_URL -ErrorAction SilentlyContinue'
    );
    expect(logs.join('\n')).not.toContain(wrongProcessSecret);
  });

  it('16. [Test E] Detects wrong User or Machine persistent overrides when Process scope is empty without falsely claiming Process scope', async () => {
    const dir = makeTempProject();
    seedCleanFiveEnvFiles(dir);
    const userWrongSecret = 'PersistentUserWrongSecret_6611!';
    const machineWrongSecret = 'PersistentMachineWrongSecret_7722!';
    const { logger, logs } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {}, // Empty Process scope — only persistent User/Machine entries exist
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [
        {
          variable: 'TEST_DATABASE_URL',
          userValue: `postgresql://erp_test_user:${encodeURIComponent(userWrongSecret)}@localhost:5433/core_erp_test?schema=public`,
        },
        {
          variable: 'STAGING_DATABASE_URL',
          machineValue: `postgresql://erp_test_user:${encodeURIComponent(machineWrongSecret)}@localhost:5432/core_erp?schema=public`,
        },
      ],
    });

    expect(res.exitCode).toBe(1);
    expect(res.shellOverrides).toHaveLength(2);

    const userOv = res.shellOverrides.find((o) => o.variable === 'TEST_DATABASE_URL');
    const machineOv = res.shellOverrides.find((o) => o.variable === 'STAGING_DATABASE_URL');

    expect(userOv?.scopes).toEqual(['User']);
    expect(userOv?.scopes).not.toContain('Process');
    expect(userOv?.scopeLabel).toBe('User');
    expect(userOv?.status).toBe('CONFLICTING_OR_WRONG_TARGET');
    expect(
      userOv?.remediationCommands.some((c) => c.includes('Remove-Item Env:'))
    ).toBe(false);
    expect(
      userOv?.remediationCommands.some((c) =>
        c.includes("[Environment]::SetEnvironmentVariable('TEST_DATABASE_URL', $null, 'User')")
      )
    ).toBe(true);

    expect(machineOv?.scopes).toEqual(['Machine']);
    expect(machineOv?.scopes).not.toContain('Process');
    expect(machineOv?.scopeLabel).toBe('Machine');
    expect(machineOv?.status).toBe('CONFLICTING_OR_WRONG_TARGET');
    expect(
      machineOv?.remediationCommands.some((c) => c.includes('Remove-Item Env:'))
    ).toBe(false);
    expect(
      machineOv?.remediationCommands.some((c) =>
        c.includes(
          "[Environment]::SetEnvironmentVariable('STAGING_DATABASE_URL', $null, 'Machine')"
        )
      )
    ).toBe(true);

    const combined = `${logs.join('\n')}\n${JSON.stringify(res.findings)}\n${JSON.stringify(res.shellOverrides)}`;
    expect(combined).not.toContain(userWrongSecret);
    expect(combined).not.toContain(machineWrongSecret);
    expect(combined).not.toContain('[shell environment (Process)');
  });

  it('17. [Test F] Preserves existing repair safeguards, finding classifications, secret redaction, and eSSL X2008 USER_SYNC_ONLY biometric bridge files byte-for-byte', async () => {
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);

    // Seed isolated eSSL X2008 biometric bridge files in USER_SYNC_ONLY mode
    const bridgeDir = path.join(dir, 'bridges', 'essl-x2008-bridge');
    const bridgeDataDir = path.join(bridgeDir, 'data');
    fs.mkdirSync(bridgeDataDir, { recursive: true });
    const bridgeConfigPath = path.join(bridgeDir, 'bridge.config.json');
    const checkpointPath = path.join(bridgeDataDir, 'checkpoints.json');
    const originalBridgeConfig = JSON.stringify(
      {
        terminalSerial: 'X2008-PROD-001',
        syncMode: 'USER_SYNC_ONLY',
        pollIntervalMs: 30000,
      },
      null,
      2
    );
    const originalCheckpoints = JSON.stringify(
      { lastSyncedAt: '2026-11-27T00:00:00.000Z', watermark: 42 },
      null,
      2
    );
    fs.writeFileSync(bridgeConfigPath, originalBridgeConfig, 'utf-8');
    fs.writeFileSync(checkpointPath, originalCheckpoints, 'utf-8');

    // 1. DRY_RUN previews safely with zero mutations and zero false-positive shell overrides
    const dryRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'DRY_RUN',
      confirmed: false,
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });
    expect(dryRes.exitCode).toBe(0);
    expect(dryRes.executed).toBe(false);
    expect(dryRes.shellOverrides).toEqual([]);
    expect(dryRes.findings.some((f) => f.category === 'MISPLACED_VARIABLE')).toBe(true);
    expect(dryRes.findings.some((f) => f.category === 'MISSING_VARIABLE')).toBe(true);
    expect(dryRes.findings.some((f) => f.category === 'MISSING_FILE')).toBe(true);
    expect(dryRes.findings.some((f) => f.category === 'SHELL_OVERRIDE')).toBe(false);

    // 2. Confirmed REPAIR creates backups, writes atomically, verifies clean state, and never touches bridge files
    const { logger, logs } = createSilentLogger();
    const repairRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
      now: () => new Date(2026, 10, 27, 9, 30, 0, 0),
    });

    expect(repairRes.exitCode).toBe(0);
    expect(repairRes.executed).toBe(true);
    expect(repairRes.verificationPassed).toBe(true);
    expect(repairRes.backups).toHaveLength(2);
    expect(repairRes.shellOverrides).toEqual([]);
    expect(repairRes.manualRemediation).toEqual([]);

    // Post-repair CHECK passes cleanly with zero shell overrides
    const postCheck = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });
    expect(postCheck.exitCode).toBe(0);
    expect(postCheck.shellOverrides).toEqual([]);
    expect(postCheck.findings).toEqual([]);

    // Biometric bridge config (USER_SYNC_ONLY) and checkpoints remain byte-for-byte untouched
    expect(fs.readFileSync(bridgeConfigPath, 'utf-8')).toBe(originalBridgeConfig);
    expect(fs.readFileSync(checkpointPath, 'utf-8')).toBe(originalCheckpoints);
    expect(JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf-8')).syncMode).toBe('USER_SYNC_ONLY');

    // Zero secret leakage
    const allLogs = logs.join('\n');
    expect(allLogs).not.toContain(seeded.devPass);
    expect(allLogs).not.toContain(seeded.integrationPass);
    expect(allLogs).not.toContain(seeded.shadowPass);
  });

  it('18. Distinguishes successful empty persistent scope inspection ([]) from unavailable inspection (null) without fabricating User/Machine findings', async () => {
    const dir = makeTempProject();
    seedCleanFiveEnvFiles(dir);

    // 18a. Successful empty inspection ([]) -> verified, zero warnings, full CHECK pass
    const { logger: okLogger, logs: okLogs } = createSilentLogger();
    const okRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {},
      logger: okLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(okRes.exitCode).toBe(0);
    expect(okRes.persistentEnvScopesVerified).toBe(true);
    expect(okRes.verificationPassed).toBe(true);
    expect(okRes.warnings).toEqual([]);
    expect(okRes.shellOverrides).toEqual([]);
    expect(okRes.findings).toEqual([]);
    expect(okRes.manualRemediation).toEqual([]);
    expect(okLogs.join('\n')).toContain(
      'All local database environment files and shell checks PASSED (zero changes needed).'
    );
    expect(okLogs.join('\n')).toContain('No configuration issues or shell overrides detected.');

    // 18b. Unavailable inspection (null) -> explicit warning, never claims persistent scopes verified, zero fabricated User/Machine findings
    const { logger: nullLogger, logs: nullLogs } = createSilentLogger();
    const nullRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {},
      logger: nullLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => null,
    });

    expect(nullRes.exitCode).toBe(0);
    expect(nullRes.persistentEnvScopesVerified).toBe(false);
    expect(nullRes.verificationPassed).toBeNull();
    expect(nullRes.shellOverrides).toEqual([]);
    expect(nullRes.findings).toEqual([]);
    expect(nullRes.manualRemediation).toEqual([]);
    expect(nullRes.warnings.length).toBeGreaterThanOrEqual(1);
    expect(
      nullRes.warnings.some((w) =>
        /Windows User\/Machine persistent environment scopes could not be verified/i.test(w)
      )
    ).toBe(true);

    const nullLogText = nullLogs.join('\n');
    expect(nullLogText).toContain(
      'Windows User/Machine persistent environment scopes could not be verified'
    );
    expect(nullLogText).not.toContain(
      'All local database environment files and shell checks PASSED'
    );
    expect(nullLogText).not.toContain('No configuration issues or shell overrides detected.');
    expect(nullLogText).not.toContain('[Environment]::SetEnvironmentVariable');

    // 18c. DRY_RUN and REPAIR no-op also report persistentEnvScopesVerified=false and emit the warning
    const { logger: dryLogger, logs: dryLogs } = createSilentLogger();
    const dryNullRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'DRY_RUN',
      shellEnv: {},
      logger: dryLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => null,
    });
    expect(dryNullRes.persistentEnvScopesVerified).toBe(false);
    expect(dryNullRes.warnings.some((w) => /could not be verified/i.test(w))).toBe(true);
    expect(dryLogs.join('\n')).toContain(
      'Windows User/Machine persistent environment scopes could not be verified'
    );

    const { logger: repairLogger, logs: repairLogs } = createSilentLogger();
    const repairNullRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: repairLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => null,
    });
    expect(repairNullRes.exitCode).toBe(0);
    expect(repairNullRes.executed).toBe(false);
    expect(repairNullRes.persistentEnvScopesVerified).toBe(false);
    expect(repairNullRes.warnings.some((w) => /could not be verified/i.test(w))).toBe(true);
    expect(repairLogs.join('\n')).toContain(
      'Windows User/Machine persistent environment scopes could NOT be verified'
    );
  });

  it('19. Still detects Process-scope overrides (matching target, wrong endpoint, credential conflict) when persistent inspection returns null without fabricating User/Machine findings', async () => {
    const dir = makeTempProject();
    const { intPass } = seedCleanFiveEnvFiles(dir);
    const wrongStagingSecret = 'ProcessWrongEndpointSecret_9012!';
    const mismatchedDevSecret = 'ProcessDevCredConflictSecret_3456!';
    const { logger, logs } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {
        // Matching-target shadowing Process override
        TEST_DATABASE_URL: `postgresql://erp_integration_user:${encodeURIComponent(intPass)}@localhost:5434/core_erp_integration_test?schema=public`,
        // Wrong-endpoint Process override
        STAGING_DATABASE_URL: `postgresql://erp_test_user:${encodeURIComponent(wrongStagingSecret)}@localhost:5433/core_erp_test?schema=public`,
        // Credential-conflict Process override on correct endpoint
        DATABASE_URL: `postgresql://erp_user:${encodeURIComponent(mismatchedDevSecret)}@localhost:5432/core_erp?schema=public`,
      },
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => null,
    });

    expect(res.exitCode).toBe(1);
    expect(res.persistentEnvScopesVerified).toBe(false);
    expect(
      res.warnings.some((w) =>
        /Windows User\/Machine persistent environment scopes could not be verified/i.test(w)
      )
    ).toBe(true);

    expect(res.shellOverrides).toHaveLength(3);

    const testOv = res.shellOverrides.find((o) => o.variable === 'TEST_DATABASE_URL');
    const stagingOv = res.shellOverrides.find((o) => o.variable === 'STAGING_DATABASE_URL');
    const devOv = res.shellOverrides.find((o) => o.variable === 'DATABASE_URL');

    expect(testOv?.scopes).toEqual(['Process']);
    expect(testOv?.scopeLabel).toBe('Process');
    expect(testOv?.status).toBe('MATCHES_TARGET');

    expect(stagingOv?.scopes).toEqual(['Process']);
    expect(stagingOv?.scopeLabel).toBe('Process');
    expect(stagingOv?.status).toBe('CONFLICTING_OR_WRONG_TARGET');
    expect(stagingOv?.resolvedEndpoint).toBe('127.0.0.1:5433/core_erp_test');

    expect(devOv?.scopes).toEqual(['Process']);
    expect(devOv?.scopeLabel).toBe('Process');
    expect(devOv?.status).toBe('CONFLICTING_OR_WRONG_TARGET');

    // Never fabricate User/Machine scopes or persistent remediation commands
    for (const ov of res.shellOverrides) {
      expect(ov.scopes).not.toContain('User');
      expect(ov.scopes).not.toContain('Machine');
      expect(
        ov.remediationCommands.some((c) => c.includes('[Environment]::SetEnvironmentVariable'))
      ).toBe(false);
    }
    expect(res.manualRemediation).toContain(
      'Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue'
    );
    expect(res.manualRemediation).toContain(
      'Remove-Item Env:STAGING_DATABASE_URL -ErrorAction SilentlyContinue'
    );
    expect(res.manualRemediation).toContain(
      'Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue'
    );

    // Zero secret leakage in warnings, findings, shellOverrides, or logs
    const combined = JSON.stringify({
      logs,
      warnings: res.warnings,
      findings: res.findings,
      shellOverrides: res.shellOverrides,
      manualRemediation: res.manualRemediation,
    });
    expect(combined).not.toContain(intPass);
    expect(combined).not.toContain(wrongStagingSecret);
    expect(combined).not.toContain(mismatchedDevSecret);
  });

  it('20. Still detects genuine User and Machine persistent overrides (including credential conflict) when inspection succeeds without emitting unverified-scope warnings', async () => {
    const dir = makeTempProject();
    seedCleanFiveEnvFiles(dir);
    const userCredConflictSecret = 'UserScopeCredMismatchSecret_7788!';
    const machineWrongPortSecret = 'MachineScopeWrongPortSecret_8899!';
    const { logger, logs } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [
        {
          variable: 'TEST_DATABASE_URL',
          // Same endpoint as .env.integration-test but mismatched password -> CONFLICTING_OR_WRONG_TARGET
          userValue: `postgresql://erp_integration_user:${encodeURIComponent(userCredConflictSecret)}@localhost:5434/core_erp_integration_test?schema=public`,
        },
        {
          variable: 'STAGING_DATABASE_URL',
          machineValue: `postgresql://erp_test_user:${encodeURIComponent(machineWrongPortSecret)}@localhost:5433/core_erp_test?schema=public`,
        },
      ],
    });

    expect(res.exitCode).toBe(1);
    expect(res.persistentEnvScopesVerified).toBe(true);
    expect(res.warnings).toEqual([]);
    expect(res.shellOverrides).toHaveLength(2);

    const userOv = res.shellOverrides.find((o) => o.variable === 'TEST_DATABASE_URL');
    const machineOv = res.shellOverrides.find((o) => o.variable === 'STAGING_DATABASE_URL');

    expect(userOv?.scopes).toEqual(['User']);
    expect(userOv?.scopeLabel).toBe('User');
    expect(userOv?.status).toBe('CONFLICTING_OR_WRONG_TARGET');

    expect(machineOv?.scopes).toEqual(['Machine']);
    expect(machineOv?.scopeLabel).toBe('Machine');
    expect(machineOv?.status).toBe('CONFLICTING_OR_WRONG_TARGET');

    const combined = JSON.stringify({
      logs,
      warnings: res.warnings,
      findings: res.findings,
      shellOverrides: res.shellOverrides,
      manualRemediation: res.manualRemediation,
    });
    expect(combined).not.toContain(userCredConflictSecret);
    expect(combined).not.toContain(machineWrongPortSecret);
    expect(combined).not.toContain('could not be verified');
  });

  it('21. Handles persistent scope inspection exceptions safely with zero secret leakage in warnings and preserves USER_SYNC_ONLY biometric bridge files', async () => {
    const dir = makeTempProject();
    const seeded = seedCleanFiveEnvFiles(dir);
    const leakedErrorSecret = 'ThrownInspectorSecret_5566!';

    const bridgeDir = path.join(dir, 'bridges', 'essl-x2008-bridge');
    fs.mkdirSync(bridgeDir, { recursive: true });
    const bridgeConfigPath = path.join(bridgeDir, 'bridge.config.json');
    const originalBridgeConfig = JSON.stringify(
      { terminalSerial: 'X2008-01', syncMode: 'USER_SYNC_ONLY' },
      null,
      2
    );
    fs.writeFileSync(bridgeConfigPath, originalBridgeConfig, 'utf-8');

    const { logger, logs } = createSilentLogger();
    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'CHECK',
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => {
        throw new Error(`PowerShell failed while reading ${leakedErrorSecret}`);
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.persistentEnvScopesVerified).toBe(false);
    expect(res.verificationPassed).toBeNull();
    expect(res.shellOverrides).toEqual([]);
    expect(
      res.warnings.some((w) =>
        /Windows User\/Machine persistent environment scopes could not be verified/i.test(w)
      )
    ).toBe(true);

    const combined = JSON.stringify({ logs, warnings: res.warnings, findings: res.findings });
    expect(combined).not.toContain(leakedErrorSecret);
    expect(combined).not.toContain(seeded.devPass);
    expect(combined).not.toContain(seeded.intPass);
    expect(combined).not.toContain(seeded.stagingPass);
    expect(combined).not.toContain(seeded.shadowPass);
    expect(fs.readFileSync(bridgeConfigPath, 'utf-8')).toBe(originalBridgeConfig);
  });

  it('22. REPAIR NO-OP distinguishes fileVerificationPassed from complete verificationPassed when persistent scope inspection returns null vs []', async () => {
    const dir = makeTempProject();
    const seeded = seedCleanFiveEnvFiles(dir);

    // 22a. REPAIR NO-OP when persistent scope inspection returns null
    const { logger: nullLogger, logs: nullLogs } = createSilentLogger();
    const nullNoOp = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: nullLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => null,
    });

    expect(nullNoOp.exitCode).toBe(0);
    expect(nullNoOp.executed).toBe(false);
    expect(nullNoOp.backups).toHaveLength(0);
    expect(nullNoOp.modifiedFiles).toEqual([]);
    expect(nullNoOp.createdFiles).toEqual([]);
    expect(nullNoOp.fileVerificationPassed).toBe(true);
    expect(nullNoOp.persistentEnvScopesVerified).toBe(false);
    expect(nullNoOp.verificationPassed).toBeNull();
    expect(nullNoOp.shellOverrides).toEqual([]);
    expect(
      nullNoOp.warnings.some((w) =>
        /Windows User\/Machine persistent environment scopes could not be verified/i.test(w)
      )
    ).toBe(true);

    const nullLogText = nullLogs.join('\n');
    expect(nullLogText).toContain('File verification passed');
    expect(nullLogText).toContain(
      'Windows User/Machine persistent environment scopes could NOT be verified'
    );
    expect(nullLogText).not.toContain(seeded.devPass);
    expect(nullLogText).not.toContain(seeded.intPass);
    expect(nullLogText).not.toContain(seeded.stagingPass);

    // 22b. REPAIR NO-OP when persistent scope inspection succeeds with []
    const { logger: okLogger, logs: okLogs } = createSilentLogger();
    const okNoOp = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: okLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(okNoOp.exitCode).toBe(0);
    expect(okNoOp.executed).toBe(false);
    expect(okNoOp.fileVerificationPassed).toBe(true);
    expect(okNoOp.persistentEnvScopesVerified).toBe(true);
    expect(okNoOp.verificationPassed).toBe(true);
    expect(okNoOp.warnings).toEqual([]);
    expect(okLogs.join('\n')).toContain(
      '[REPAIR NO-OP] All local environment files are already valid and clean. Zero files modified; zero backups created.'
    );
  });

  it('23. Successful REPAIR returns fileVerificationPassed=true and verificationPassed=null when persistent scope inspection returns null (with and without Process overrides)', async () => {
    // 23a. Successful REPAIR with null persistent inspection and no Process overrides
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);

    const bridgeDir = path.join(dir, 'bridges', 'essl-x2008-bridge');
    fs.mkdirSync(bridgeDir, { recursive: true });
    const bridgeConfigPath = path.join(bridgeDir, 'bridge.config.json');
    const originalBridgeConfig = JSON.stringify(
      { terminalSerial: 'X2008-REPAIR-01', syncMode: 'USER_SYNC_ONLY' },
      null,
      2
    );
    fs.writeFileSync(bridgeConfigPath, originalBridgeConfig, 'utf-8');

    const { logger, logs } = createSilentLogger();
    const repairRes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => null,
      now: () => new Date(2026, 10, 27, 9, 45, 0, 0),
    });

    expect(repairRes.exitCode).toBe(0);
    expect(repairRes.executed).toBe(true);
    expect(repairRes.backups).toHaveLength(2);
    expect(repairRes.modifiedFiles).toEqual(['.env', '.env.integration-test']);
    expect(repairRes.createdFiles).toEqual(['.env.staging']);
    expect(repairRes.fileVerificationPassed).toBe(true);
    expect(repairRes.persistentEnvScopesVerified).toBe(false);
    expect(repairRes.verificationPassed).toBeNull();
    expect(repairRes.shellOverrides).toEqual([]);
    expect(
      repairRes.warnings.some((w) =>
        /Windows User\/Machine persistent environment scopes could not be verified/i.test(w)
      )
    ).toBe(true);

    const repairLogText = logs.join('\n');
    expect(repairLogText).toContain('File verification passed:');
    expect(repairLogText).toContain('Persistent scope verification: UNVERIFIED');
    expect(repairLogText).toContain(
      '[REPAIR COMPLETE — FILES VERIFIED; PERSISTENT ENV SCOPES UNVERIFIED]'
    );
    expect(repairLogText).not.toContain(
      '[REPAIR COMPLETE] Local database environment files repaired and verified successfully.'
    );
    expect(repairLogText).not.toContain(seeded.devPass);
    expect(repairLogText).not.toContain(seeded.integrationPass);
    expect(repairLogText).not.toContain(seeded.shadowPass);
    expect(fs.readFileSync(bridgeConfigPath, 'utf-8')).toBe(originalBridgeConfig);

    // Repaired files on disk independently pass five-environment setup verification
    const diskVerify = await runDatabaseEnvironmentSetup({
      projectRoot: dir,
      checkOnly: true,
      shellEnv: {},
      logger: createSilentLogger().logger,
      inspectDockerVolumes: async () => null,
    });
    expect(diskVerify.exitCode).toBe(0);
    expect(diskVerify.issues).toEqual([]);

    // 23b. Successful REPAIR with null persistent inspection AND a genuine Process-scope override
    const dirWithProc = makeTempProject();
    seedWindowsAuditScenario(dirWithProc);
    const procOverrideSecret = 'RepairNullProcOverrideSecret_4321!';
    const { logger: procLogger, logs: procLogs } = createSilentLogger();

    const procRepairRes = await runLocalDatabaseEnvRepair({
      projectRoot: dirWithProc,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {
        STAGING_DATABASE_URL: `postgresql://erp_test_user:${encodeURIComponent(procOverrideSecret)}@localhost:5433/core_erp_test?schema=public`,
      },
      logger: procLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => null,
    });

    expect(procRepairRes.exitCode).toBe(0);
    expect(procRepairRes.executed).toBe(true);
    expect(procRepairRes.fileVerificationPassed).toBe(true);
    expect(procRepairRes.persistentEnvScopesVerified).toBe(false);
    expect(procRepairRes.verificationPassed).toBeNull();
    expect(procRepairRes.shellOverrides).toHaveLength(1);
    expect(procRepairRes.shellOverrides[0].scopes).toEqual(['Process']);
    expect(procRepairRes.shellOverrides[0].scopeLabel).toBe('Process');

    const procCombined = JSON.stringify({
      logs: procLogs,
      warnings: procRepairRes.warnings,
      shellOverrides: procRepairRes.shellOverrides,
      findings: procRepairRes.findings,
    });
    expect(procLogs.join('\n')).toContain(
      '[REPAIR COMPLETE — FILES VERIFIED; MANUAL SHELL CLEANUP REMAINING; PERSISTENT ENV SCOPES UNVERIFIED]'
    );
    expect(procCombined).not.toContain(procOverrideSecret);
    expect(procCombined).not.toContain('[Environment]::SetEnvironmentVariable');
  });

  it('24. REPAIR NO-OP returns verificationPassed=null with explicit manual-cleanup status whenever shell overrides remain (for both [] and null persistent inspection), while no overrides + [] remains a complete pass', async () => {
    const dir = makeTempProject();
    const seeded = seedCleanFiveEnvFiles(dir);
    const procOverrideSecret = 'NoOpProcessOverrideSecret_6543!';

    // 24a. REPAIR NO-OP with Process override and successful persistent inspection ([])
    const { logger: okScopeLogger, logs: okScopeLogs } = createSilentLogger();
    const overrideWithVerifiedScopes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {
        STAGING_DATABASE_URL: `postgresql://erp_test_user:${encodeURIComponent(procOverrideSecret)}@localhost:5433/core_erp_test?schema=public`,
      },
      logger: okScopeLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(overrideWithVerifiedScopes.exitCode).toBe(0);
    expect(overrideWithVerifiedScopes.executed).toBe(false);
    expect(overrideWithVerifiedScopes.backups).toHaveLength(0);
    expect(overrideWithVerifiedScopes.fileVerificationPassed).toBe(true);
    expect(overrideWithVerifiedScopes.persistentEnvScopesVerified).toBe(true);
    expect(overrideWithVerifiedScopes.verificationPassed).toBeNull();
    expect(overrideWithVerifiedScopes.shellOverrides).toHaveLength(1);
    expect(overrideWithVerifiedScopes.shellOverrides[0].scopeLabel).toBe('Process');

    const okScopeText = okScopeLogs.join('\n');
    expect(okScopeText).toContain('[REPAIR NO-OP — MANUAL SHELL CLEANUP REMAINING]');
    expect(okScopeText).toContain('manual shell cleanup remains required');
    expect(okScopeText).not.toContain(
      '[REPAIR NO-OP] All local environment files are already valid and clean.'
    );
    const okScopeCombined = JSON.stringify({
      logs: okScopeLogs,
      warnings: overrideWithVerifiedScopes.warnings,
      findings: overrideWithVerifiedScopes.findings,
      shellOverrides: overrideWithVerifiedScopes.shellOverrides,
      manualRemediation: overrideWithVerifiedScopes.manualRemediation,
    });
    expect(okScopeCombined).not.toContain(procOverrideSecret);
    expect(okScopeCombined).not.toContain(seeded.devPass);
    expect(okScopeCombined).not.toContain(seeded.intPass);
    expect(okScopeCombined).not.toContain(seeded.stagingPass);

    // 24b. REPAIR NO-OP with Process override and unavailable persistent inspection (null)
    const { logger: nullScopeLogger, logs: nullScopeLogs } = createSilentLogger();
    const overrideWithNullScopes = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {
        TEST_DATABASE_URL: `postgresql://erp_test_user:${encodeURIComponent(procOverrideSecret)}@localhost:5433/core_erp_test?schema=public`,
      },
      logger: nullScopeLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => null,
    });

    expect(overrideWithNullScopes.exitCode).toBe(0);
    expect(overrideWithNullScopes.executed).toBe(false);
    expect(overrideWithNullScopes.backups).toHaveLength(0);
    expect(overrideWithNullScopes.fileVerificationPassed).toBe(true);
    expect(overrideWithNullScopes.persistentEnvScopesVerified).toBe(false);
    expect(overrideWithNullScopes.verificationPassed).toBeNull();
    expect(overrideWithNullScopes.shellOverrides).toHaveLength(1);
    expect(overrideWithNullScopes.shellOverrides[0].scopes).toEqual(['Process']);
    expect(
      overrideWithNullScopes.warnings.some((w) =>
        /Windows User\/Machine persistent environment scopes could not be verified/i.test(w)
      )
    ).toBe(true);

    const nullScopeText = nullScopeLogs.join('\n');
    expect(nullScopeText).toContain(
      '[REPAIR NO-OP — MANUAL SHELL CLEANUP REMAINING; PERSISTENT ENV SCOPES UNVERIFIED]'
    );
    expect(nullScopeText).toContain('manual shell cleanup remains required');
    expect(nullScopeText).toContain('User/Machine persistent environment scopes remain unverified');
    expect(nullScopeText).not.toContain(
      '[REPAIR NO-OP] All local environment files are already valid and clean.'
    );
    const nullScopeCombined = JSON.stringify({
      logs: nullScopeLogs,
      warnings: overrideWithNullScopes.warnings,
      findings: overrideWithNullScopes.findings,
      shellOverrides: overrideWithNullScopes.shellOverrides,
      manualRemediation: overrideWithNullScopes.manualRemediation,
    });
    expect(nullScopeCombined).not.toContain(procOverrideSecret);
    expect(nullScopeCombined).not.toContain(seeded.devPass);
    expect(nullScopeCombined).not.toContain(seeded.intPass);
    expect(nullScopeCombined).not.toContain(seeded.stagingPass);
    expect(nullScopeCombined).not.toContain('[Environment]::SetEnvironmentVariable');

    // 24c. REPAIR NO-OP with zero shell overrides and successful persistent inspection ([]) remains a complete pass
    const { logger: cleanLogger, logs: cleanLogs } = createSilentLogger();
    const cleanNoOp = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger: cleanLogger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
    });

    expect(cleanNoOp.exitCode).toBe(0);
    expect(cleanNoOp.executed).toBe(false);
    expect(cleanNoOp.fileVerificationPassed).toBe(true);
    expect(cleanNoOp.persistentEnvScopesVerified).toBe(true);
    expect(cleanNoOp.verificationPassed).toBe(true);
    expect(cleanNoOp.shellOverrides).toEqual([]);
    expect(cleanNoOp.warnings).toEqual([]);
    expect(cleanLogs.join('\n')).toContain(
      '[REPAIR NO-OP] All local environment files are already valid and clean. Zero files modified; zero backups created.'
    );
  });

  it('25. Successful REPAIR that modifies files returns verificationPassed=null when a Process-scope override remains even if persistent scope inspection succeeds ([])', async () => {
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);
    const procOverrideSecret = 'RepairExecutedProcOverrideSecret_9876!';
    const { logger, logs } = createSilentLogger();

    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {
        STAGING_DATABASE_URL: `postgresql://erp_test_user:${encodeURIComponent(procOverrideSecret)}@localhost:5433/core_erp_test?schema=public`,
      },
      logger,
      inspectDocker: async () => DOCKER_AVAILABLE_MIXED,
      inspectPersistentEnvScopes: async () => [],
      now: () => new Date(2026, 10, 27, 9, 55, 0, 0),
    });

    expect(res.exitCode).toBe(0);
    expect(res.executed).toBe(true);
    expect(res.modifiedFiles).toEqual(['.env', '.env.integration-test']);
    expect(res.createdFiles).toEqual(['.env.staging']);
    expect(res.fileVerificationPassed).toBe(true);
    expect(res.persistentEnvScopesVerified).toBe(true);
    expect(res.verificationPassed).toBeNull();
    expect(res.shellOverrides).toHaveLength(1);
    expect(res.shellOverrides[0].scopes).toEqual(['Process']);
    expect(res.shellOverrides[0].scopeLabel).toBe('Process');

    const logText = logs.join('\n');
    expect(logText).toContain('[REPAIR COMPLETE — MANUAL SHELL CLEANUP REMAINING]');
    expect(logText).not.toContain(
      '[REPAIR COMPLETE] Local database environment files repaired and verified successfully.'
    );

    const combined = JSON.stringify({
      logs,
      warnings: res.warnings,
      findings: res.findings,
      shellOverrides: res.shellOverrides,
      manualRemediation: res.manualRemediation,
    });
    expect(combined).not.toContain(procOverrideSecret);
    expect(combined).not.toContain(seeded.devPass);
    expect(combined).not.toContain(seeded.integrationPass);
    expect(combined).not.toContain(seeded.shadowPass);
  });

  it('26. Post-write verification failure restores all previously existing files byte-for-byte (preserving UTF-8 BOM and CRLF) and keeps backups intact', async () => {
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir, { crlf: true });

    // Prepend UTF-8 BOM to .env to verify exact byte-for-byte encoding preservation on rollback
    const envWithBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      fs.readFileSync(path.join(dir, '.env')),
    ]);
    fs.writeFileSync(path.join(dir, '.env'), envWithBom);

    // Pre-seed a valid .env.staging so ONLY existing files (.env and .env.integration-test) are modified
    const stagingPass = 'PreExistingStagingSecret_7766!';
    fs.writeFileSync(
      path.join(dir, '.env.staging'),
      [
        'STAGING_POSTGRES_USER="erp_staging_user"',
        `STAGING_POSTGRES_PASSWORD="${stagingPass}"`,
        'STAGING_POSTGRES_DB="core_erp_staging"',
        `STAGING_DATABASE_URL="postgresql://erp_staging_user:${encodeURIComponent(stagingPass)}@localhost:5435/core_erp_staging?schema=public"`,
        '',
      ].join('\r\n'),
      'utf-8'
    );

    const originalEnvBytes = fs.readFileSync(path.join(dir, '.env'));
    const originalIntBytes = fs.readFileSync(path.join(dir, '.env.integration-test'));
    const originalStagingBytes = fs.readFileSync(path.join(dir, '.env.staging'));

    const { logger, logs } = createSilentLogger();
    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      now: () => new Date(2026, 10, 27, 10, 15, 0, 111),
      verifyRepairedFiles: async () => ({
        exitCode: 1,
        mode: 'CHECK',
        files: [],
        detectedVolumes: [],
        issues: ['Simulated post-write verification failure on disk'],
        warnings: [],
      }),
    });

    expect(res.exitCode).toBe(1);
    expect(res.executed).toBe(false);
    expect(res.fileVerificationPassed).toBe(false);
    expect(res.verificationPassed).toBe(false);
    expect(res.modifiedFiles).toEqual([]);
    expect(res.createdFiles).toEqual([]);
    expect(res.backups).toHaveLength(2);
    expect(res.rollback?.attempted).toBe(true);
    expect(res.rollback?.succeeded).toBe(true);
    expect(res.rollback?.records).toHaveLength(2);
    expect(
      res.rollback?.records.find((r) => r.file === '.env')
    ).toMatchObject({ action: 'RESTORE_FROM_BACKUP', success: true });
    expect(
      res.rollback?.records.find((r) => r.file === '.env.integration-test')
    ).toMatchObject({ action: 'RESTORE_FROM_BACKUP', success: true });

    // Original files restored byte-for-byte (including BOM and CRLF)
    expect(fs.readFileSync(path.join(dir, '.env')).equals(originalEnvBytes)).toBe(true);
    expect(
      fs.readFileSync(path.join(dir, '.env.integration-test')).equals(originalIntBytes)
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(dir, '.env.staging')).equals(originalStagingBytes)
    ).toBe(true);

    // Backup files remain completely intact on disk after rollback
    const envBackup = res.backups.find((b) => b.file === '.env')!;
    const intBackup = res.backups.find((b) => b.file === '.env.integration-test')!;
    expect(fs.existsSync(envBackup.backupPath)).toBe(true);
    expect(fs.existsSync(intBackup.backupPath)).toBe(true);
    expect(fs.readFileSync(envBackup.backupPath).equals(originalEnvBytes)).toBe(true);
    expect(fs.readFileSync(intBackup.backupPath).equals(originalIntBytes)).toBe(true);

    const logText = logs.join('\n');
    expect(logText).toContain('[ROLLBACK COMPLETE]');
    expect(logText).toContain('all original files were restored');
    expect(
      res.blockers.some((b) => /Post-repair verification failed.*all original files were restored/i.test(b))
    ).toBe(true);
    expect(logText).not.toContain(seeded.devPass);
    expect(logText).not.toContain(seeded.integrationPass);
  });

  it('27. Post-write verification failure removes all newly created files (.env.integration-test and .env.staging) while leaving clean .env untouched', async () => {
    const dir = makeTempProject();
    const devPass = 'CleanOnlyDevPass_8822!';
    const shadowPass = 'CleanOnlyShadowPass_9933!';
    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        'PORT=3000',
        'NODE_ENV=development',
        'POSTGRES_USER="erp_user"',
        `POSTGRES_PASSWORD="${devPass}"`,
        'POSTGRES_DB="core_erp"',
        `DATABASE_URL="postgresql://erp_user:${encodeURIComponent(devPass)}@localhost:5432/core_erp?schema=public"`,
        'SHADOW_POSTGRES_USER="erp_shadow_user"',
        `SHADOW_POSTGRES_PASSWORD="${shadowPass}"`,
        'SHADOW_POSTGRES_DB="core_erp_shadow"',
        `SHADOW_DATABASE_URL="postgresql://erp_shadow_user:${encodeURIComponent(shadowPass)}@localhost:5436/core_erp_shadow?schema=public"`,
        '',
      ].join('\n'),
      'utf-8'
    );
    const originalEnvBytes = fs.readFileSync(path.join(dir, '.env'));

    const { logger, logs } = createSilentLogger();
    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      verifyRepairedFiles: async () => ({
        exitCode: 1,
        mode: 'CHECK',
        files: [],
        detectedVolumes: [],
        issues: ['Simulated verification failure after creating missing env files'],
        warnings: [],
      }),
    });

    expect(res.exitCode).toBe(1);
    expect(res.executed).toBe(false);
    expect(res.fileVerificationPassed).toBe(false);
    expect(res.verificationPassed).toBe(false);
    expect(res.backups).toHaveLength(0);
    expect(res.modifiedFiles).toEqual([]);
    expect(res.createdFiles).toEqual([]);
    expect(res.rollback?.attempted).toBe(true);
    expect(res.rollback?.succeeded).toBe(true);
    expect(res.rollback?.records).toHaveLength(2);
    expect(
      res.rollback?.records.find((r) => r.file === '.env.integration-test')
    ).toEqual({ file: '.env.integration-test', action: 'REMOVE_CREATED_FILE', success: true });
    expect(
      res.rollback?.records.find((r) => r.file === '.env.staging')
    ).toEqual({ file: '.env.staging', action: 'REMOVE_CREATED_FILE', success: true });

    // Both newly created files were removed; untouched .env remains byte-for-byte identical
    expect(fs.existsSync(path.join(dir, '.env.integration-test'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.env.staging'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.env')).equals(originalEnvBytes)).toBe(true);
    expect(logs.join('\n')).toContain('[ROLLBACK COMPLETE]');
  });

  it('28. Mixed scenario: post-write verification failure (and verification exception) restores existing .env and .env.integration-test byte-for-byte, removes newly created .env.staging, and keeps backups intact', async () => {
    for (const mode of ['NON_ZERO_EXIT', 'THROWN_ERROR'] as const) {
      const dir = makeTempProject();
      seedWindowsAuditScenario(dir, { crlf: true });
      const originalEnvBytes = fs.readFileSync(path.join(dir, '.env'));
      const originalIntBytes = fs.readFileSync(path.join(dir, '.env.integration-test'));

      const { logger, logs } = createSilentLogger();
      const res = await runLocalDatabaseEnvRepair({
        projectRoot: dir,
        mode: 'REPAIR',
        confirmed: true,
        shellEnv: {},
        logger,
        inspectDocker: async () => DOCKER_UNAVAILABLE,
        inspectPersistentEnvScopes: async () => [],
        now: () => new Date(2026, 10, 27, 10, 20, 0, mode === 'NON_ZERO_EXIT' ? 1 : 2),
        verifyRepairedFiles: async () => {
          if (mode === 'THROWN_ERROR') {
            throw new Error('Unexpected I/O failure during post-write verification');
          }
          return {
            exitCode: 1,
            mode: 'CHECK',
            files: [],
            detectedVolumes: [],
            issues: ['Post-write check detected mismatch across repaired files'],
            warnings: [],
          };
        },
      });

      expect(res.exitCode, mode).toBe(1);
      expect(res.executed, mode).toBe(false);
      expect(res.fileVerificationPassed, mode).toBe(false);
      expect(res.verificationPassed, mode).toBe(false);
      expect(res.modifiedFiles, mode).toEqual([]);
      expect(res.createdFiles, mode).toEqual([]);
      expect(res.backups, mode).toHaveLength(2);
      expect(res.rollback?.attempted, mode).toBe(true);
      expect(res.rollback?.succeeded, mode).toBe(true);
      expect(res.rollback?.records, mode).toHaveLength(3);
      expect(
        res.rollback?.records.find((r) => r.file === '.env')
      ).toMatchObject({ action: 'RESTORE_FROM_BACKUP', success: true });
      expect(
        res.rollback?.records.find((r) => r.file === '.env.integration-test')
      ).toMatchObject({ action: 'RESTORE_FROM_BACKUP', success: true });
      expect(
        res.rollback?.records.find((r) => r.file === '.env.staging')
      ).toEqual({ file: '.env.staging', action: 'REMOVE_CREATED_FILE', success: true });

      // Existing files restored byte-for-byte; newly created .env.staging removed
      expect(fs.readFileSync(path.join(dir, '.env')).equals(originalEnvBytes), mode).toBe(true);
      expect(
        fs.readFileSync(path.join(dir, '.env.integration-test')).equals(originalIntBytes),
        mode
      ).toBe(true);
      expect(fs.existsSync(path.join(dir, '.env.staging')), mode).toBe(false);

      // Both backups preserved byte-for-byte
      for (const backup of res.backups) {
        expect(fs.existsSync(backup.backupPath), `${mode}:${backup.file}`).toBe(true);
      }
      expect(
        fs
          .readFileSync(res.backups.find((b) => b.file === '.env')!.backupPath)
          .equals(originalEnvBytes),
        mode
      ).toBe(true);
      expect(
        fs
          .readFileSync(res.backups.find((b) => b.file === '.env.integration-test')!.backupPath)
          .equals(originalIntBytes),
        mode
      ).toBe(true);

      expect(logs.join('\n'), mode).toContain('[ROLLBACK COMPLETE]');
      expect(logs.join('\n'), mode).toContain('all original files were restored');
    }
  });

  it('29. Partial rollback failure is reported accurately, identifies the un-restored file, preserves all backups, and never claims complete restoration', async () => {
    const dir = makeTempProject();
    seedWindowsAuditScenario(dir);
    const originalEnvBytes = fs.readFileSync(path.join(dir, '.env'));
    const originalIntBytes = fs.readFileSync(path.join(dir, '.env.integration-test'));

    const { logger, logs } = createSilentLogger();
    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      now: () => new Date(2026, 10, 27, 10, 25, 0, 500),
      verifyRepairedFiles: async () => ({
        exitCode: 1,
        mode: 'CHECK',
        files: [],
        detectedVolumes: [],
        issues: ['Simulated verification failure triggering partial rollback failure'],
        warnings: [],
      }),
      restoreFileFromBackup: (filePath, backupPath) => {
        if (path.basename(filePath) === '.env.integration-test') {
          throw new Error('EACCES: simulated locked file during .env.integration-test restore');
        }
        defaultRestoreFileFromBackup(filePath, backupPath);
      },
    });

    expect(res.exitCode).toBe(1);
    expect(res.executed).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.fileVerificationPassed).toBe(false);
    expect(res.verificationPassed).toBe(false);
    expect(res.rollback?.attempted).toBe(true);
    expect(res.rollback?.succeeded).toBe(false);
    expect(res.rollback?.records).toHaveLength(3);

    const envRecord = res.rollback?.records.find((r) => r.file === '.env');
    const intRecord = res.rollback?.records.find((r) => r.file === '.env.integration-test');
    const stagingRecord = res.rollback?.records.find((r) => r.file === '.env.staging');

    expect(envRecord).toMatchObject({ action: 'RESTORE_FROM_BACKUP', success: true });
    expect(stagingRecord).toEqual({
      file: '.env.staging',
      action: 'REMOVE_CREATED_FILE',
      success: true,
    });
    expect(intRecord).toMatchObject({
      file: '.env.integration-test',
      action: 'RESTORE_FROM_BACKUP',
      success: false,
    });
    expect(intRecord?.error).toContain('EACCES');

    // Un-restored file remains accurately reflected in modifiedFiles
    expect(res.modifiedFiles).toEqual(['.env.integration-test']);
    expect(res.createdFiles).toEqual([]);

    // .env was restored, .env.staging was removed, and ALL backups remain intact byte-for-byte
    expect(fs.readFileSync(path.join(dir, '.env')).equals(originalEnvBytes)).toBe(true);
    expect(fs.existsSync(path.join(dir, '.env.staging'))).toBe(false);
    expect(res.backups).toHaveLength(2);
    expect(
      fs
        .readFileSync(res.backups.find((b) => b.file === '.env')!.backupPath)
        .equals(originalEnvBytes)
    ).toBe(true);
    expect(
      fs
        .readFileSync(res.backups.find((b) => b.file === '.env.integration-test')!.backupPath)
        .equals(originalIntBytes)
    ).toBe(true);

    // Must clearly identify .env.integration-test and NEVER claim complete rollback
    const logText = logs.join('\n');
    expect(logText).toContain('[ROLLBACK INCOMPLETE]');
    expect(logText).toContain('.env.integration-test');
    expect(logText).not.toContain('[ROLLBACK COMPLETE]');
    expect(logText).not.toContain('all original files were restored');
    expect(
      res.blockers.some((b) => b.includes('.env.integration-test') && /Rollback failed/i.test(b))
    ).toBe(true);
    expect(
      res.blockers.some((b) => /rollback was INCOMPLETE/i.test(b))
    ).toBe(true);
    expect(
      res.blockers.some((b) => /all original files were restored/i.test(b))
    ).toBe(false);
  });

  it('30. Exclusive backup creation (wx) aborts on backup filename collision before modifying any live file and preserves existing backup contents', async () => {
    // 30a. Direct unit test of defaultCreateFileBackup
    const directDir = makeTempProject();
    const srcFile = path.join(directDir, '.env');
    const collidingBackup = path.join(directDir, '.env.backup.existing');
    const sentinelBackupBytes = Buffer.from('# EXISTING BACKUP — MUST NOT BE OVERWRITTEN\r\nKEEP=1\r\n', 'utf-8');
    fs.writeFileSync(srcFile, 'DATABASE_URL="postgresql://u:p@localhost:5432/core_erp"\n', 'utf-8');
    fs.writeFileSync(collidingBackup, sentinelBackupBytes);

    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
    expect(() => defaultCreateFileBackup(srcFile, collidingBackup)).toThrow(
      /Backup file already exists.*refusing to overwrite/i
    );
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(collidingBackup).equals(sentinelBackupBytes)).toBe(true);
    unlinkSpy.mockRestore();

    // 30b. Full REPAIR aborts before modifying ANY live file when second backup filename collides
    const dir = makeTempProject();
    seedWindowsAuditScenario(dir, { crlf: true });
    const originalEnvBytes = fs.readFileSync(path.join(dir, '.env'));
    const originalIntBytes = fs.readFileSync(path.join(dir, '.env.integration-test'));

    // Deterministic timestamp: 2026-11-27 10:30:00.000 -> 20261127-103000-000
    const fixedDate = new Date(2026, 10, 27, 10, 30, 0, 0);
    const collidingIntBackupPath = path.join(dir, '.env.integration-test.backup.20261127-103000-000');
    const existingIntBackupSentinel = Buffer.from('# PRIOR BACKUP CONTENTS — PRESERVE EXACTLY\r\n', 'utf-8');
    fs.writeFileSync(collidingIntBackupPath, existingIntBackupSentinel);

    const { logger, logs } = createSilentLogger();
    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      now: () => fixedDate,
    });

    expect(res.exitCode).toBe(1);
    expect(res.executed).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.fileVerificationPassed).toBe(false);
    expect(res.verificationPassed).toBe(false);
    expect(res.modifiedFiles).toEqual([]);
    expect(res.createdFiles).toEqual([]);
    expect(
      res.blockers.some((b) => /Backup creation failed.*already exists/i.test(b))
    ).toBe(true);
    expect(logs.join('\n')).toContain('[ABORTED]');

    // ZERO live environment files modified or created
    expect(fs.readFileSync(path.join(dir, '.env')).equals(originalEnvBytes)).toBe(true);
    expect(
      fs.readFileSync(path.join(dir, '.env.integration-test')).equals(originalIntBytes)
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, '.env.staging'))).toBe(false);

    // Pre-existing colliding backup preserved byte-for-byte
    expect(fs.readFileSync(collidingIntBackupPath).equals(existingIntBackupSentinel)).toBe(true);
  });

  it('31. Never exposes passwords, encoded passwords, or raw connection URLs during post-write verification failure and rollback failure', async () => {
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);
    const generatedStagingSecret = 'GeneratedStagingSecret_RollbackLeakCheck_9988!';
    const shellOverrideSecret = 'ShellOverrideSecret_RollbackLeakCheck_7766!';
    const rawDevUrl = `postgresql://erp_user:${encodeURIComponent(seeded.devPass)}@localhost:5432/core_erp?schema=public`;
    const rawStagingUrl = `postgresql://erp_staging_user:${encodeURIComponent(generatedStagingSecret)}@localhost:5435/core_erp_staging?schema=public`;

    const { logger, logs } = createSilentLogger();
    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {
        TEST_DATABASE_URL: `postgresql://erp_test_user:${encodeURIComponent(shellOverrideSecret)}@localhost:5433/core_erp_test?schema=public`,
      },
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      generateSecret: () => generatedStagingSecret,
      verifyRepairedFiles: async () => ({
        exitCode: 1,
        mode: 'CHECK',
        files: [],
        detectedVolumes: [],
        issues: [
          `Verification failed for ${rawDevUrl} and ${rawStagingUrl} using secret ${seeded.integrationPass}`,
        ],
        warnings: [],
      }),
      restoreFileFromBackup: (filePath, backupPath) => {
        if (path.basename(filePath) === '.env') {
          throw new Error(
            `Restore error touching ${rawDevUrl} with ${seeded.devPass} and ${seeded.shadowPass}`
          );
        }
        defaultRestoreFileFromBackup(filePath, backupPath);
      },
    });

    expect(res.exitCode).toBe(1);
    expect(res.executed).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.rollback?.attempted).toBe(true);
    expect(res.rollback?.succeeded).toBe(false);

    const combined = JSON.stringify({
      logs,
      blockers: res.blockers,
      warnings: res.warnings,
      findings: res.findings,
      shellOverrides: res.shellOverrides,
      manualRemediation: res.manualRemediation,
      rollback: res.rollback,
    });

    for (const secret of [
      seeded.devPass,
      encodeURIComponent(seeded.devPass),
      seeded.shadowPass,
      encodeURIComponent(seeded.shadowPass),
      seeded.integrationPass,
      encodeURIComponent(seeded.integrationPass),
      seeded.misplacedStagingPass,
      seeded.misplacedTestPass,
      generatedStagingSecret,
      encodeURIComponent(generatedStagingSecret),
      shellOverrideSecret,
      encodeURIComponent(shellOverrideSecret),
      rawDevUrl,
      rawStagingUrl,
      'session_secret_preserved_exactly_1234567890abcdef',
      'bridge_token_preserved_exactly_1234567890',
    ]) {
      expect(combined).not.toContain(secret);
    }
  });

  it('32. Backup write failure cleans up partial backup file, closes descriptor once, aborts repair before live writes, and redacts secrets', async () => {
    // 32a. Direct defaultCreateFileBackup write failure cleans up partial backup and closes fd once
    const directDir = makeTempProject();
    const srcPath = path.join(directDir, '.env');
    const backupPath = path.join(directDir, '.env.backup.writefail');
    fs.writeFileSync(srcPath, 'DATABASE_URL="postgresql://u:p@localhost:5432/core_erp"\n', 'utf-8');

    let backupFd: number | null = null;
    let backupFdCloseCount = 0;
    const origOpenSync = fs.openSync;
    const origCloseSync = fs.closeSync;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((p, flags, mode) => {
      const fd = origOpenSync.call(fs, p, flags, mode);
      if (p === backupPath) {
        backupFd = fd;
      }
      return fd;
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      if (backupFd !== null && fd === backupFd) {
        backupFdCloseCount += 1;
      }
      return origCloseSync.call(fs, fd);
    });
    const origWriteFileSync = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (typeof file === 'number') {
        const err = new Error('ENOSPC: no space left on device while writing backup') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      }
      return origWriteFileSync.call(fs, file, data, options);
    });

    expect(() => defaultCreateFileBackup(srcPath, backupPath)).toThrow(
      /ENOSPC: no space left on device while writing backup/
    );
    expect(backupFd).not.toBeNull();
    expect(backupFdCloseCount).toBe(1);
    expect(fs.existsSync(backupPath)).toBe(false);

    writeSpy.mockRestore();
    closeSpy.mockRestore();
    openSpy.mockRestore();

    // 32b. End-to-end REPAIR aborts before modifying live files, cleans up partial backup, and redacts secrets
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir, { crlf: true });
    const originalEnvBytes = fs.readFileSync(path.join(dir, '.env'));
    const originalIntBytes = fs.readFileSync(path.join(dir, '.env.integration-test'));
    const rawDevUrl = `postgresql://erp_user:${encodeURIComponent(seeded.devPass)}@localhost:5432/core_erp?schema=public`;
    const fixedDate = new Date(2026, 10, 28, 1, 10, 0, 0);
    const expectedEnvBackupPath = path.join(dir, '.env.backup.20261128-011000-000');

    const repairWriteSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (typeof file === 'number') {
        throw new Error(`ENOSPC writing backup for ${rawDevUrl} (${seeded.devPass})`);
      }
      return origWriteFileSync.call(fs, file, data, options);
    });

    const { logger, logs } = createSilentLogger();
    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      now: () => fixedDate,
    });
    repairWriteSpy.mockRestore();

    expect(res.exitCode).toBe(1);
    expect(res.executed).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.fileVerificationPassed).toBe(false);
    expect(res.verificationPassed).toBe(false);
    expect(res.modifiedFiles).toEqual([]);
    expect(res.createdFiles).toEqual([]);

    // Partial backup created by failed write was removed
    expect(fs.existsSync(expectedEnvBackupPath)).toBe(false);

    // Live files remain completely untouched byte-for-byte
    expect(fs.readFileSync(path.join(dir, '.env')).equals(originalEnvBytes)).toBe(true);
    expect(
      fs.readFileSync(path.join(dir, '.env.integration-test')).equals(originalIntBytes)
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, '.env.staging'))).toBe(false);

    const combined = JSON.stringify({ logs, blockers: res.blockers, warnings: res.warnings });
    expect(combined).toContain('ENOSPC');
    expect(combined).not.toContain(seeded.devPass);
    expect(combined).not.toContain(encodeURIComponent(seeded.devPass));
    expect(combined).not.toContain(rawDevUrl);
  });

  it('33. Backup fsync and close failures clean up partial backup without double-closing fd and abort repair before modifying live files', async () => {
    // 33a. Direct fsync failure removes partial backup and closes backup fd exactly once
    const fsyncDir = makeTempProject();
    const srcPath = path.join(fsyncDir, '.env');
    const backupPath = path.join(fsyncDir, '.env.backup.fsyncfail');
    fs.writeFileSync(srcPath, 'DATABASE_URL="postgresql://u:p@localhost:5432/core_erp"\n', 'utf-8');

    let fsyncBackupFd: number | null = null;
    let fsyncBackupFdCloseCount = 0;
    const origOpenSync = fs.openSync;
    const origCloseSync = fs.closeSync;
    const openSpy1 = vi.spyOn(fs, 'openSync').mockImplementation((p, flags, mode) => {
      const fd = origOpenSync.call(fs, p, flags, mode);
      if (p === backupPath) {
        fsyncBackupFd = fd;
      }
      return fd;
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      if (fsyncBackupFd !== null && fd === fsyncBackupFd) {
        fsyncBackupFdCloseCount += 1;
      }
      return origCloseSync.call(fs, fd);
    });
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      const err = new Error('EIO: simulated fsync failure on backup') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });

    expect(() => defaultCreateFileBackup(srcPath, backupPath)).toThrow(
      /EIO: simulated fsync failure on backup/
    );
    expect(fsyncBackupFd).not.toBeNull();
    expect(fsyncBackupFdCloseCount).toBe(1);
    expect(fs.existsSync(backupPath)).toBe(false);

    fsyncSpy.mockRestore();
    closeSpy.mockRestore();
    openSpy1.mockRestore();

    // 33b. Direct close failure on backup fd does NOT double-close fd and still removes partial backup
    const closeFailDir = makeTempProject();
    const srcPath2 = path.join(closeFailDir, '.env');
    const backupPath2 = path.join(closeFailDir, '.env.backup.closefail');
    fs.writeFileSync(srcPath2, 'DATABASE_URL="postgresql://u:p@localhost:5432/core_erp"\n', 'utf-8');

    let closeBackupFd: number | null = null;
    let closeBackupFdCloseCount = 0;
    let backupExistedBeforeClose = false;
    const openSpy2 = vi.spyOn(fs, 'openSync').mockImplementation((p, flags, mode) => {
      const fd = origOpenSync.call(fs, p, flags, mode);
      if (p === backupPath2) {
        closeBackupFd = fd;
      }
      return fd;
    });
    const closeFailSpy = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      // Only fail when closing the newly created backup fd (not readFileSync's source fd)
      if (closeBackupFd !== null && fd === closeBackupFd) {
        closeBackupFdCloseCount += 1;
        backupExistedBeforeClose = fs.existsSync(backupPath2);
        // Close the real descriptor first so OS does not leak it, then simulate close failure
        origCloseSync.call(fs, fd);
        throw new Error('EIO: simulated closeSync failure');
      }
      return origCloseSync.call(fs, fd);
    });

    expect(() => defaultCreateFileBackup(srcPath2, backupPath2)).toThrow(
      /EIO: simulated closeSync failure/
    );
    expect(closeBackupFd).not.toBeNull();
    expect(backupExistedBeforeClose).toBe(true);
    expect(closeBackupFdCloseCount).toBe(1);
    expect(fs.existsSync(backupPath2)).toBe(false);
    closeFailSpy.mockRestore();
    openSpy2.mockRestore();

    // 33c. End-to-end REPAIR aborts on fsync failure before modifying any live env file
    const dir = makeTempProject();
    seedWindowsAuditScenario(dir, { crlf: true });
    const originalEnvBytes = fs.readFileSync(path.join(dir, '.env'));
    const originalIntBytes = fs.readFileSync(path.join(dir, '.env.integration-test'));
    const fixedDate = new Date(2026, 10, 28, 1, 15, 0, 0);
    const expectedEnvBackupPath = path.join(dir, '.env.backup.20261128-011500-000');

    const repairFsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('EIO: disk flush error during backup');
    });

    const { logger } = createSilentLogger();
    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      now: () => fixedDate,
    });
    repairFsyncSpy.mockRestore();

    expect(res.exitCode).toBe(1);
    expect(res.executed).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.modifiedFiles).toEqual([]);
    expect(res.createdFiles).toEqual([]);
    expect(fs.existsSync(expectedEnvBackupPath)).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.env')).equals(originalEnvBytes)).toBe(true);
    expect(
      fs.readFileSync(path.join(dir, '.env.integration-test')).equals(originalIntBytes)
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, '.env.staging'))).toBe(false);
  });

  it('34. Backup cleanup failure reports both original backup error and cleanup failure clearly without hiding original error or leaking secrets', async () => {
    // 34a. Direct defaultCreateFileBackup reports both original fsync error and cleanup failure
    const directDir = makeTempProject();
    const srcPath = path.join(directDir, '.env');
    const backupPath = path.join(directDir, '.env.backup.cleanupfail');
    fs.writeFileSync(srcPath, 'DATABASE_URL="postgresql://u:p@localhost:5432/core_erp"\n', 'utf-8');

    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      const err = new Error('ENOSPC: simulated flush failure') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      const err = new Error('EPERM: simulated unlink lock on partial backup') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    let caught: Error | null = null;
    try {
      defaultCreateFileBackup(srcPath, backupPath);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    fsyncSpy.mockRestore();
    unlinkSpy.mockRestore();

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('ENOSPC: simulated flush failure');
    expect(caught!.message).toContain('partial backup cleanup failed');
    expect(caught!.message).toContain('EPERM: simulated unlink lock on partial backup');
    expect(caught!.message).toContain('.env.backup.cleanupfail');

    // 34b. End-to-end REPAIR reports both original error and cleanup failure, keeps live files untouched, and redacts secrets
    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);
    const originalEnvBytes = fs.readFileSync(path.join(dir, '.env'));
    const originalIntBytes = fs.readFileSync(path.join(dir, '.env.integration-test'));
    const rawDevUrl = `postgresql://erp_user:${encodeURIComponent(seeded.devPass)}@localhost:5432/core_erp?schema=public`;
    const rawIntUrl = `postgresql://erp_integration_user:${encodeURIComponent(seeded.integrationPass)}@localhost:5434/core_erp_integration_test?schema=public`;

    const origWriteFileSync = fs.writeFileSync;
    const repairWriteSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (typeof file === 'number') {
        throw new Error(`ENOSPC writing backup for ${rawDevUrl} with ${seeded.devPass}`);
      }
      return origWriteFileSync.call(fs, file, data, options);
    });
    const repairUnlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error(`EPERM cleaning partial backup for ${rawIntUrl} (${seeded.integrationPass})`);
    });

    const { logger, logs } = createSilentLogger();
    const res = await runLocalDatabaseEnvRepair({
      projectRoot: dir,
      mode: 'REPAIR',
      confirmed: true,
      shellEnv: {},
      logger,
      inspectDocker: async () => DOCKER_UNAVAILABLE,
      inspectPersistentEnvScopes: async () => [],
      now: () => new Date(2026, 10, 28, 1, 20, 0, 0),
    });
    repairWriteSpy.mockRestore();
    repairUnlinkSpy.mockRestore();

    expect(res.exitCode).toBe(1);
    expect(res.executed).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.modifiedFiles).toEqual([]);
    expect(res.createdFiles).toEqual([]);

    // Live environment files remain byte-for-byte unchanged
    expect(fs.readFileSync(path.join(dir, '.env')).equals(originalEnvBytes)).toBe(true);
    expect(
      fs.readFileSync(path.join(dir, '.env.integration-test')).equals(originalIntBytes)
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, '.env.staging'))).toBe(false);

    const combined = JSON.stringify({
      logs,
      blockers: res.blockers,
      warnings: res.warnings,
      findings: res.findings,
    });
    // Both original failure and cleanup failure are reported clearly
    expect(combined).toContain('ENOSPC writing backup');
    expect(combined).toContain('partial backup cleanup failed');
    expect(combined).toContain('EPERM cleaning partial backup');

    // Zero secrets or raw connection URLs leaked anywhere
    for (const secret of [
      seeded.devPass,
      encodeURIComponent(seeded.devPass),
      seeded.integrationPass,
      encodeURIComponent(seeded.integrationPass),
      seeded.shadowPass,
      rawDevUrl,
      rawIntUrl,
    ]) {
      expect(combined).not.toContain(secret);
    }
  });
});
