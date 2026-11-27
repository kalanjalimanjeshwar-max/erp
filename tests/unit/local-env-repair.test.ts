import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REQUIRED_REPAIR_CONFIRMATION_FLAG,
  appendEnvAssignmentPreservingContent,
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
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')
    );
    expect(pkg.scripts['db:repair:check']).toBe('tsx scripts/repair-db-env.ts --check');
    expect(pkg.scripts['db:repair:local']).toBe('tsx scripts/repair-db-env.ts');
    expect(pkg.scripts['db:setup:check']).toBe('tsx scripts/setup-db-env.ts --check');

    const dir = makeTempProject();
    const seeded = seedWindowsAuditScenario(dir);
    const scriptPath = path.join(process.cwd(), 'scripts', 'repair-db-env.ts');
    const tsxBin = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
    );

    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      NODE_ENV: 'development',
    };

    // Default dry-run (`db:repair:local` with no confirmation flag) exits 0 and mutates ZERO files
    const dryRunOut = execFileSync(tsxBin, [scriptPath], {
      cwd: dir,
      env: cleanEnv,
      encoding: 'utf-8',
      timeout: 15_000,
    });
    expect(dryRunOut).toContain('DRY-RUN COMPLETE');
    expect(dryRunOut).toContain(REQUIRED_REPAIR_CONFIRMATION_FLAG);
    expect(dryRunOut).not.toContain(seeded.devPass);
    expect(dryRunOut).not.toContain(seeded.integrationPass);
    expect(fs.readdirSync(dir).sort()).toEqual(['.env', '.env.integration-test']);

    // `--check` exits 1 when issues exist, even if confirmation flag is also passed, and mutates ZERO files
    let checkExitCode = 0;
    let checkOut = '';
    try {
      execFileSync(tsxBin, [scriptPath, '--check', REQUIRED_REPAIR_CONFIRMATION_FLAG], {
        cwd: dir,
        env: cleanEnv,
        encoding: 'utf-8',
        timeout: 15_000,
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      checkExitCode = e.status ?? 1;
      checkOut = `${e.stdout || ''}\n${e.stderr || ''}`;
    }
    expect(checkExitCode).toBe(1);
    expect(checkOut).toContain('Read-Only');
    expect(checkOut).toContain('STAGING_DATABASE_URL');
    expect(checkOut).toContain('TEST_DATABASE_URL');
    expect(checkOut).not.toContain(seeded.devPass);
    expect(checkOut).not.toContain(seeded.integrationPass);
    expect(fs.readdirSync(dir).sort()).toEqual(['.env', '.env.integration-test']);
  });
});
