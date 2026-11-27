import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ALLOWED_LOCAL_RESET_TARGETS,
  COREERP_LOCAL_RESET_SPECS,
  REQUIRED_CONFIRMATION_FLAG,
  assertNeverGlobalDockerPrune,
  assertSafeCoreErpContainerName,
  classifyCoreErpLocalVolume,
  generateDistinctSecret,
  parseCleanResetTargets,
  runCoreErpCleanReset,
  validateAllFiveEnvironmentsPreflight,
  verifyCoreErpContainerOwnership,
  type CleanResetLogger,
  type CleanResetTarget,
  type DockerContainerMetadata,
  type DockerVolumeMetadata,
} from '../../src/server/db/clean-reset.js';
import { parseEnvFileContent } from '../../src/server/db/setup-env.js';

const tempDirs: string[] = [];

function createTempDir(prefix = 'coreerp-clean-reset-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createSilentLogger(): { logger: CleanResetLogger; logs: string[] } {
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

/**
 * Helper that writes a complete, valid local 3-file CoreERP environment bundle (.env, .env.staging, .env.integration-test)
 * with distinct strong credentials per environment. Individual fields can be overridden per test.
 */
function writeValidLocalEnvFiles(
  projectRoot: string,
  overrides?: {
    devUrl?: string;
    devUser?: string;
    devPassword?: string;
    devDb?: string;
    shadowUrl?: string;
    shadowUser?: string;
    shadowPassword?: string;
    shadowDb?: string;
    envStagingUrlRef?: string;
    envTestUrlRef?: string;
    stagingUrl?: string;
    stagingUser?: string;
    stagingPassword?: string;
    stagingDb?: string;
    integrationUrl?: string;
    integrationPassword?: string;
    sessionSecret?: string;
    bankEncryptionKey?: string;
    bankActiveKeyId?: string;
    bankHistoricalKeys?: string;
    biometricBridgeToken?: string;
  }
): {
  devPassword: string;
  shadowPassword: string;
  stagingPassword: string;
  integrationPassword: string;
  sessionSecret: string;
  bankEncryptionKey: string;
  bankActiveKeyId: string;
  bankHistoricalKeys: string;
  biometricBridgeToken: string;
} {
  const devUser = overrides?.devUser ?? 'erp_user';
  const devPassword = overrides?.devPassword ?? 'erp_password_dev_valid_9876543210';
  const devDb = overrides?.devDb ?? 'core_erp';
  const devUrl =
    overrides?.devUrl ??
    `postgresql://${devUser}:${devPassword}@localhost:5432/${devDb}?schema=public`;

  const shadowUser = overrides?.shadowUser ?? 'erp_shadow_user';
  const shadowPassword = overrides?.shadowPassword ?? 'shadow_secret_valid_9876543210abcdef';
  const shadowDb = overrides?.shadowDb ?? 'core_erp_shadow';
  const shadowUrl =
    overrides?.shadowUrl ??
    `postgresql://${shadowUser}:${shadowPassword}@localhost:5436/${shadowDb}?schema=public`;

  const stagingUser = overrides?.stagingUser ?? 'erp_staging_user';
  const stagingPassword = overrides?.stagingPassword ?? 'staging_secret_valid_1234567890abcdef';
  const stagingDb = overrides?.stagingDb ?? 'core_erp_staging';
  const stagingUrl =
    overrides?.stagingUrl ??
    `postgresql://${stagingUser}:${stagingPassword}@localhost:5435/${stagingDb}?schema=public`;

  const integrationPassword =
    overrides?.integrationPassword ?? 'integration_secret_valid_abcdef123456';
  const integrationUrl =
    overrides?.integrationUrl ??
    `postgresql://erp_integration_user:${integrationPassword}@localhost:5434/core_erp_integration_test?schema=public`;

  const sessionSecret =
    overrides?.sessionSecret ?? 'valid_session_secret_0123456789abcdef0123456789abcdef';
  const bankEncryptionKey =
    overrides?.bankEncryptionKey ??
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const bankActiveKeyId = overrides?.bankActiveKeyId ?? 'k1';
  const bankHistoricalKeys = overrides?.bankHistoricalKeys ?? '{}';
  const biometricBridgeToken =
    overrides?.biometricBridgeToken ?? 'valid_bridge_token_0123456789abcdef';

  const mainEnvLines = [
    'NODE_ENV=development',
    `POSTGRES_USER="${devUser}"`,
    `POSTGRES_PASSWORD="${devPassword}"`,
    `POSTGRES_DB="${devDb}"`,
    `DATABASE_URL="${devUrl}"`,
    `SHADOW_POSTGRES_USER="${shadowUser}"`,
    `SHADOW_POSTGRES_PASSWORD="${shadowPassword}"`,
    `SHADOW_POSTGRES_DB="${shadowDb}"`,
    `SHADOW_DATABASE_URL="${shadowUrl}"`,
    ...(overrides?.envStagingUrlRef
      ? [`STAGING_DATABASE_URL="${overrides.envStagingUrlRef}"`]
      : []),
    ...(overrides?.envTestUrlRef ? [`TEST_DATABASE_URL="${overrides.envTestUrlRef}"`] : []),
    `SESSION_SECRET="${sessionSecret}"`,
    `BANK_ENCRYPTION_KEY="${bankEncryptionKey}"`,
    ...(overrides?.bankActiveKeyId !== undefined
      ? [`BANK_ACTIVE_KEY_ID="${bankActiveKeyId}"`]
      : []),
    ...(overrides?.bankHistoricalKeys !== undefined
      ? [`BANK_HISTORICAL_KEYS='${bankHistoricalKeys}'`]
      : []),
    `BIOMETRIC_BRIDGE_TOKEN="${biometricBridgeToken}"`,
  ];

  fs.writeFileSync(path.join(projectRoot, '.env'), mainEnvLines.join('\n') + '\n', 'utf-8');

  fs.writeFileSync(
    path.join(projectRoot, '.env.staging'),
    [
      `STAGING_POSTGRES_USER="${stagingUser}"`,
      `STAGING_POSTGRES_PASSWORD="${stagingPassword}"`,
      `STAGING_POSTGRES_DB="${stagingDb}"`,
      `STAGING_DATABASE_URL="${stagingUrl}"`,
    ].join('\n') + '\n',
    'utf-8'
  );

  fs.writeFileSync(
    path.join(projectRoot, '.env.integration-test'),
    [
      `POSTGRES_PASSWORD="${integrationPassword}"`,
      `TEST_DATABASE_URL="${integrationUrl}"`,
    ].join('\n') + '\n',
    'utf-8'
  );

  return {
    devPassword,
    shadowPassword,
    stagingPassword,
    integrationPassword,
    sessionSecret,
    bankEncryptionKey,
    bankActiveKeyId,
    bankHistoricalKeys,
    biometricBridgeToken,
  };
}

/**
 * Helper that builds verified Docker Compose container metadata for the given targets in `projectRoot`.
 */
function buildVerifiedContainers(
  projectRoot: string,
  targets: readonly CleanResetTarget[] = ALLOWED_LOCAL_RESET_TARGETS,
  composeProject = 'coreerp'
): DockerContainerMetadata[] {
  return targets.map((t) => {
    const spec = COREERP_LOCAL_RESET_SPECS[t];
    return {
      name: spec.container,
      labels: {
        'com.docker.compose.project': composeProject,
        'com.docker.compose.service': spec.service,
        'com.docker.compose.project.working_dir': projectRoot,
        'com.docker.compose.project.config_files': path.join(projectRoot, spec.composeFile),
      },
    };
  });
}

/**
 * Helper that builds verified Docker Compose volume metadata for the given targets in `projectRoot`.
 */
function buildVerifiedVolumes(
  projectRoot: string,
  targets: readonly CleanResetTarget[] = ALLOWED_LOCAL_RESET_TARGETS,
  composeProject = 'coreerp'
): DockerVolumeMetadata[] {
  return targets.map((t) => {
    const spec = COREERP_LOCAL_RESET_SPECS[t];
    return {
      name: `${composeProject}_${spec.volume}`,
      labels: {
        'com.docker.compose.project': composeProject,
        'com.docker.compose.volume': spec.volume,
        'com.docker.compose.project.working_dir': projectRoot,
        'com.docker.compose.project.config_files': path.join(projectRoot, spec.composeFile),
      },
    };
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('CoreERP Clean-Reset Pre-Deletion Safety & Scoped Fresh-Install Workflow', () => {
  it('0. Hard safety guards block global Docker prune, image deletion, compose down -v, and production/unrelated containers', () => {
    expect(() => assertNeverGlobalDockerPrune(['system', 'prune', '--volumes', '-f'])).toThrow(
      /DOCKER SAFETY VIOLATION/
    );
    expect(() => assertNeverGlobalDockerPrune(['volume', 'prune', '-f'])).toThrow(
      /DOCKER SAFETY VIOLATION/
    );
    expect(() => assertNeverGlobalDockerPrune(['container', 'prune', '-f'])).toThrow(
      /DOCKER SAFETY VIOLATION/
    );
    expect(() =>
      assertNeverGlobalDockerPrune(['compose', '-f', 'docker-compose.dev.yml', 'down', '-v'])
    ).toThrow(/DOCKER SAFETY VIOLATION/);
    expect(() => assertNeverGlobalDockerPrune(['rmi', 'postgres:16-alpine'])).toThrow(
      /DOCKER SAFETY VIOLATION/
    );
    expect(() => assertNeverGlobalDockerPrune(['rm', '-f', 'coreerp-postgres-dev'])).not.toThrow();

    expect(() => assertSafeCoreErpContainerName('coreerp-postgres')).toThrow(/production container/);
    expect(() => assertSafeCoreErpContainerName('coreerp-app')).toThrow(/production container/);
    expect(() => assertSafeCoreErpContainerName('coreerp-migration')).toThrow(/production container/);
    expect(() => assertSafeCoreErpContainerName('other-company-postgres')).toThrow(
      /unrelated container/
    );
    expect(() => assertSafeCoreErpContainerName('coreerp-postgres-staging')).not.toThrow();
  });

  it('1. Remote DATABASE_URL (in .env or shell override) blocks strictly BEFORE any Docker deletion', async () => {
    // Case A: remote DATABASE_URL inside .env
    const projectRootA = createTempDir();
    writeValidLocalEnvFiles(projectRootA, {
      devUrl: 'postgresql://erp_user:erp_password_dev_valid_9876543210@prod-db.cloud.example.com:5432/core_erp',
    });
    const runDockerA = vi.fn();
    const { logger: loggerA } = createSilentLogger();

    const resA = await runCoreErpCleanReset({
      projectRoot: projectRootA,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger: loggerA,
      deps: {
        runDockerCommand: runDockerA,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRootA)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRootA)),
      },
    });
    expect(resA.exitCode).toBe(1);
    expect(resA.removedContainers).toEqual([]);
    expect(resA.removedVolumes).toEqual([]);
    expect(runDockerA).not.toHaveBeenCalled();

    // Case B: valid local .env, but shell DATABASE_URL overrides with a remote host
    const projectRootB = createTempDir();
    writeValidLocalEnvFiles(projectRootB);
    const runDockerB = vi.fn();
    const { logger: loggerB } = createSilentLogger();

    const resB = await runCoreErpCleanReset({
      projectRoot: projectRootB,
      execute: true,
      confirmed: true,
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://erp_user:secret@cloud-sql.example.com:5432/core_erp',
      },
      logger: loggerB,
      deps: {
        runDockerCommand: runDockerB,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRootB)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRootB)),
      },
    });
    expect(resB.exitCode).toBe(1);
    expect(resB.error).toContain('remote host');
    expect(resB.removedContainers).toEqual([]);
    expect(resB.removedVolumes).toEqual([]);
    expect(runDockerB).not.toHaveBeenCalled();
  });

  it('2. Remote STAGING_DATABASE_URL (in .env.staging or shell override) blocks strictly BEFORE any Docker deletion', async () => {
    const projectRoot = createTempDir();
    const remoteStagingUrl =
      'postgresql://erp_staging_user:staging_secret_valid_1234567890abcdef@staging-rds.example.com:5435/core_erp_staging';
    writeValidLocalEnvFiles(projectRoot, {
      stagingUrl: remoteStagingUrl,
    });
    const runDocker = vi.fn();
    const { logger } = createSilentLogger();

    const resFile = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDocker,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRoot)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRoot)),
      },
    });
    expect(resFile.exitCode).toBe(1);
    expect(resFile.error).toContain('staging');
    expect(resFile.removedContainers).toEqual([]);
    expect(resFile.removedVolumes).toEqual([]);
    expect(runDocker).not.toHaveBeenCalled();

    // Shell override with remote STAGING_DATABASE_URL
    const projectRootShell = createTempDir();
    writeValidLocalEnvFiles(projectRootShell);
    const runDockerShell = vi.fn();
    const resShell = await runCoreErpCleanReset({
      projectRoot: projectRootShell,
      execute: true,
      confirmed: true,
      env: {
        NODE_ENV: 'development',
        STAGING_DATABASE_URL: remoteStagingUrl,
      },
      logger,
      deps: {
        runDockerCommand: runDockerShell,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRootShell)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRootShell)),
      },
    });
    expect(resShell.exitCode).toBe(1);
    expect(resShell.error).toContain('remote host');
    expect(runDockerShell).not.toHaveBeenCalled();
  });

  it('3. Remote TEST_DATABASE_URL (in .env.integration-test or shell override) blocks strictly BEFORE any Docker deletion', async () => {
    const projectRoot = createTempDir();
    writeValidLocalEnvFiles(projectRoot, {
      integrationUrl:
        'postgresql://erp_integration_user:integration_secret_valid_abcdef123456@remote-ci-pg.example.com:5434/core_erp_integration_test',
    });
    const runDocker = vi.fn();
    const { logger } = createSilentLogger();

    const res = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDocker,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRoot)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRoot)),
      },
    });
    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('integration');
    expect(res.removedContainers).toEqual([]);
    expect(res.removedVolumes).toEqual([]);
    expect(runDocker).not.toHaveBeenCalled();

    // Shell override with remote TEST_DATABASE_URL
    const projectRootShell = createTempDir();
    writeValidLocalEnvFiles(projectRootShell);
    const runDockerShell = vi.fn();
    const resShell = await runCoreErpCleanReset({
      projectRoot: projectRootShell,
      execute: true,
      confirmed: true,
      env: {
        NODE_ENV: 'development',
        TEST_DATABASE_URL:
          'postgresql://erp_integration_user:integration_secret_valid_abcdef123456@remote-ci.example.com:5434/core_erp_integration_test',
      },
      logger,
      deps: { runDockerCommand: runDockerShell },
    });
    expect(resShell.exitCode).toBe(1);
    expect(resShell.error).toContain('remote host');
    expect(runDockerShell).not.toHaveBeenCalled();
  });

  it('4. Invalid or remote SHADOW_DATABASE_URL blocks strictly BEFORE any Docker deletion', async () => {
    const { logger } = createSilentLogger();

    // Case A: Remote shadow host
    const rootRemote = createTempDir();
    writeValidLocalEnvFiles(rootRemote, {
      shadowUrl:
        'postgresql://erp_shadow_user:shadow_secret_valid_9876543210abcdef@remote-shadow.example.com:5436/core_erp_shadow',
    });
    const runDockerA = vi.fn();
    const resA = await runCoreErpCleanReset({
      projectRoot: rootRemote,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: { runDockerCommand: runDockerA },
    });
    expect(resA.exitCode).toBe(1);
    expect(resA.error).toContain('shadow');
    expect(runDockerA).not.toHaveBeenCalled();

    // Case B: Malformed SHADOW_DATABASE_URL
    const rootMalformed = createTempDir();
    writeValidLocalEnvFiles(rootMalformed, {
      shadowUrl: 'not-a-valid-postgres-url',
    });
    const runDockerB = vi.fn();
    const resB = await runCoreErpCleanReset({
      projectRoot: rootMalformed,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: { runDockerCommand: runDockerB },
    });
    expect(resB.exitCode).toBe(1);
    expect(resB.error).toContain('SHADOW_DATABASE_URL');
    expect(runDockerB).not.toHaveBeenCalled();
  });

  it('5. Incorrect port on any of the five targets blocks strictly BEFORE any Docker deletion', async () => {
    const { logger } = createSilentLogger();

    const wrongPortCases: Array<{
      name: string;
      overrides?: Parameters<typeof writeValidLocalEnvFiles>[1];
      shellEnv?: Record<string, string | undefined>;
    }> = [
      {
        name: 'dev on port 5439',
        overrides: {
          devUrl: 'postgresql://erp_user:erp_password_dev_valid_9876543210@localhost:5439/core_erp',
        },
      },
      {
        name: 'test on port 5499',
        shellEnv: {
          UNIT_TEST_DATABASE_URL:
            'postgresql://erp_test_user:erp_test_password@localhost:5499/core_erp_test',
        },
      },
      {
        name: 'integration on port 5432',
        overrides: {
          integrationUrl:
            'postgresql://erp_integration_user:integration_secret_valid_abcdef123456@localhost:5432/core_erp_integration_test',
        },
      },
      {
        name: 'staging on port 5433',
        overrides: {
          stagingUrl:
            'postgresql://erp_staging_user:staging_secret_valid_1234567890abcdef@localhost:5433/core_erp_staging',
        },
      },
      {
        name: 'shadow on port 5435',
        overrides: {
          shadowUrl:
            'postgresql://erp_shadow_user:shadow_secret_valid_9876543210abcdef@localhost:5435/core_erp_shadow',
        },
      },
    ];

    for (const tc of wrongPortCases) {
      const root = createTempDir();
      writeValidLocalEnvFiles(root, tc.overrides);
      const runDocker = vi.fn();

      const res = await runCoreErpCleanReset({
        projectRoot: root,
        execute: true,
        confirmed: true,
        env: { NODE_ENV: 'development', ...tc.shellEnv },
        logger,
        deps: {
          runDockerCommand: runDocker,
          listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(root)),
          listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(root)),
        },
      });
      expect(res.exitCode, `Expected failure for ${tc.name}`).toBe(1);
      expect(res.removedContainers).toEqual([]);
      expect(res.removedVolumes).toEqual([]);
      expect(runDocker, `Expected zero Docker calls for ${tc.name}`).not.toHaveBeenCalled();
    }
  });

  it('6. Incorrect database name on any target blocks strictly BEFORE any Docker deletion', async () => {
    const { logger } = createSilentLogger();

    const wrongDbCases: Array<Parameters<typeof writeValidLocalEnvFiles>[1]> = [
      {
        devDb: 'core_erp_wrong',
        devUrl:
          'postgresql://erp_user:erp_password_dev_valid_9876543210@localhost:5432/core_erp_wrong',
      },
      {
        stagingDb: 'core_erp',
        stagingUrl:
          'postgresql://erp_staging_user:staging_secret_valid_1234567890abcdef@localhost:5435/core_erp',
      },
      {
        integrationUrl:
          'postgresql://erp_integration_user:integration_secret_valid_abcdef123456@localhost:5434/production',
      },
      {
        shadowDb: 'core_erp_prod_shadow',
        shadowUrl:
          'postgresql://erp_shadow_user:shadow_secret_valid_9876543210abcdef@localhost:5436/core_erp_prod_shadow',
      },
    ];

    for (const overrides of wrongDbCases) {
      const root = createTempDir();
      writeValidLocalEnvFiles(root, overrides);
      const runDocker = vi.fn();

      const res = await runCoreErpCleanReset({
        projectRoot: root,
        execute: true,
        confirmed: true,
        env: { NODE_ENV: 'development' },
        logger,
        deps: { runDockerCommand: runDocker },
      });
      expect(res.exitCode).toBe(1);
      expect(res.removedContainers).toEqual([]);
      expect(res.removedVolumes).toEqual([]);
      expect(runDocker).not.toHaveBeenCalled();
    }
  });

  it('7. Credential mismatch (Compose vars vs URLs, .env vs .env.staging drift, or shared staging/dev password) blocks BEFORE deletion without leaking secrets', async () => {
    // Case A: POSTGRES_PASSWORD !== DATABASE_URL password
    const rootA = createTempDir();
    const leakedSecretA = 'SuperSecret_Dev_Mismatch_Password_999';
    writeValidLocalEnvFiles(rootA, {
      devPassword: leakedSecretA,
      devUrl: 'postgresql://erp_user:DifferentPassword_123456789@localhost:5432/core_erp',
    });
    const runDockerA = vi.fn();
    const { logger: loggerA, logs: logsA } = createSilentLogger();

    const resA = await runCoreErpCleanReset({
      projectRoot: rootA,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger: loggerA,
      deps: { runDockerCommand: runDockerA },
    });
    expect(resA.exitCode).toBe(1);
    expect(resA.error).toContain('POSTGRES_PASSWORD');
    expect(runDockerA).not.toHaveBeenCalled();
    expect(logsA.join('\n')).not.toContain(leakedSecretA);
    expect(logsA.join('\n')).not.toContain('DifferentPassword_123456789');

    // Case B: STAGING_POSTGRES_PASSWORD !== STAGING_DATABASE_URL password
    const rootB = createTempDir();
    writeValidLocalEnvFiles(rootB, {
      stagingPassword: 'staging_compose_pass_1234567890',
      stagingUrl:
        'postgresql://erp_staging_user:staging_url_mismatch_9876543210@localhost:5435/core_erp_staging',
    });
    const runDockerB = vi.fn();
    const { logger: loggerB } = createSilentLogger();
    const resB = await runCoreErpCleanReset({
      projectRoot: rootB,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger: loggerB,
      deps: { runDockerCommand: runDockerB },
    });
    expect(resB.exitCode).toBe(1);
    expect(resB.error).toContain('STAGING_POSTGRES_PASSWORD');
    expect(runDockerB).not.toHaveBeenCalled();

    // Case C: Staging password equals development password (isolation violation)
    const rootC = createTempDir();
    const sharedPass = 'same_password_shared_dev_and_staging_1234';
    writeValidLocalEnvFiles(rootC, {
      devPassword: sharedPass,
      stagingPassword: sharedPass,
    });
    const runDockerC = vi.fn();
    const resC = await runCoreErpCleanReset({
      projectRoot: rootC,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger: loggerB,
      deps: { runDockerCommand: runDockerC },
    });
    expect(resC.exitCode).toBe(1);
    expect(resC.error).toContain('isolated credentials');
    expect(runDockerC).not.toHaveBeenCalled();

    // Case D: Misplaced STAGING_DATABASE_URL (port 5433) or TEST_DATABASE_URL inside .env blocks BEFORE any deletion without leaking secrets
    const rootD = createTempDir();
    const misplacedPassD = 'misplaced_secret_never_leak_5433!';
    writeValidLocalEnvFiles(rootD, {
      envStagingUrlRef: `postgresql://erp_test_user:${misplacedPassD}@localhost:5433/core_erp_test`,
      envTestUrlRef: `postgresql://erp_integration_user:${misplacedPassD}@localhost:5434/core_erp_integration_test`,
    });
    const runDockerD = vi.fn();
    const { logger: loggerD, logs: logsD } = createSilentLogger();
    const resD = await runCoreErpCleanReset({
      projectRoot: rootD,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger: loggerD,
      deps: { runDockerCommand: runDockerD },
    });
    expect(resD.exitCode).toBe(1);
    expect(resD.error).toContain('[.env :: STAGING_DATABASE_URL]');
    expect(resD.error).toContain('[.env :: TEST_DATABASE_URL]');
    expect(resD.error).not.toContain(misplacedPassD);
    expect(logsD.join('\n')).not.toContain(misplacedPassD);
    expect(runDockerD).not.toHaveBeenCalled();
  });

  it('8. Duplicate database endpoints across targets block strictly BEFORE any Docker deletion', async () => {
    const root = createTempDir();
    const devEndpointUrl =
      'postgresql://erp_user:erp_password_dev_valid_9876543210@localhost:5432/core_erp?schema=public';
    writeValidLocalEnvFiles(root, {
      devUrl: devEndpointUrl,
      stagingUrl: devEndpointUrl,
    });
    const runDocker = vi.fn();
    const { logger } = createSilentLogger();

    const res = await runCoreErpCleanReset({
      projectRoot: root,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDocker,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(root)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(root)),
      },
    });
    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('Duplicate database endpoint detected');
    expect(res.removedContainers).toEqual([]);
    expect(res.removedVolumes).toEqual([]);
    expect(runDocker).not.toHaveBeenCalled();

    // Direct check on shadow colliding with staging endpoint
    const dupCheck = validateAllFiveEnvironmentsPreflight({
      shellEnv: { NODE_ENV: 'development' },
      mainEnv: {
        POSTGRES_USER: 'erp_user',
        POSTGRES_PASSWORD: 'erp_password_dev_valid_9876543210',
        POSTGRES_DB: 'core_erp',
        DATABASE_URL: devEndpointUrl,
        SHADOW_POSTGRES_USER: 'erp_shadow_user',
        SHADOW_POSTGRES_PASSWORD: 'shadow_secret_valid_9876543210abcdef',
        SHADOW_POSTGRES_DB: 'core_erp_shadow',
        SHADOW_DATABASE_URL:
          'postgresql://erp_staging_user:staging_secret_valid_1234567890abcdef@localhost:5435/core_erp_staging',
      },
      stagingEnv: {
        STAGING_POSTGRES_USER: 'erp_staging_user',
        STAGING_POSTGRES_PASSWORD: 'staging_secret_valid_1234567890abcdef',
        STAGING_POSTGRES_DB: 'core_erp_staging',
        STAGING_DATABASE_URL:
          'postgresql://erp_staging_user:staging_secret_valid_1234567890abcdef@localhost:5435/core_erp_staging',
      },
      integrationEnv: {
        POSTGRES_PASSWORD: 'integration_secret_valid_abcdef123456',
        TEST_DATABASE_URL:
          'postgresql://erp_integration_user:integration_secret_valid_abcdef123456@localhost:5434/core_erp_integration_test',
      },
      recreateEnv: false,
    });
    expect(dupCheck.issues.some((i) => i.includes('Duplicate database endpoint detected'))).toBe(true);
  });

  it('9. Production environment (NODE_ENV=production and prod/production targets) blocks all destructive operations', async () => {
    const projectRoot = createTempDir();
    writeValidLocalEnvFiles(projectRoot);
    const runDocker = vi.fn();
    const { logger } = createSilentLogger();

    const prodNodeEnv = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'production' },
      logger,
      deps: { runDockerCommand: runDocker },
    });
    expect(prodNodeEnv.exitCode).toBe(1);
    expect(prodNodeEnv.error).toContain('NODE_ENV=production');
    expect(runDocker).not.toHaveBeenCalled();

    expect(parseCleanResetTargets(['dev', 'prod']).valid).toBe(false);
    const prodTargetRes = await runCoreErpCleanReset({
      projectRoot,
      targets: ['production'],
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: { runDockerCommand: runDocker },
    });
    expect(prodTargetRes.exitCode).toBe(1);
    expect(prodTargetRes.error).toContain('Production target');
    expect(runDocker).not.toHaveBeenCalled();
  });

  it('10. Missing environment files are prepared and validated safely in memory (zero files written in dry-run; written only in Stage 8 after preflight passes)', async () => {
    const emptyRoot = createTempDir();
    const { logger } = createSilentLogger();
    const runDocker = vi.fn();

    // Dry-run with completely missing .env, .env.staging, .env.integration-test
    const dryRes = await runCoreErpCleanReset({
      projectRoot: emptyRoot,
      execute: false,
      confirmed: false,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDocker,
        listDockerContainers: vi.fn().mockResolvedValue([]),
        listDockerVolumes: vi.fn().mockResolvedValue([]),
      },
    });
    expect(dryRes.exitCode).toBe(0);
    expect(dryRes.mode).toBe('DRY_RUN');
    expect(dryRes.plan?.envActions).toEqual([
      { file: '.env.staging', action: 'CREATE' },
      { file: '.env.integration-test', action: 'CREATE' },
      { file: '.env', action: 'CREATE' },
    ]);
    // Zero files written on disk during dry-run
    expect(fs.existsSync(path.join(emptyRoot, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(emptyRoot, '.env.staging'))).toBe(false);
    expect(fs.existsSync(path.join(emptyRoot, '.env.integration-test'))).toBe(false);
    expect(runDocker).not.toHaveBeenCalled();
  });

  it('11. Failed environment setup hook (deps.runSetupEnv returning exitCode 1 or throwing) NEVER deletes containers or volumes', async () => {
    const projectRoot = createTempDir();
    writeValidLocalEnvFiles(projectRoot);
    const { logger } = createSilentLogger();

    // Case A: runSetupEnv returns exitCode 1
    const runDockerA = vi.fn();
    const resA = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDockerA,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRoot)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRoot)),
        runSetupEnv: vi.fn().mockResolvedValue({
          exitCode: 1,
          createdFiles: [],
          preservedFiles: [],
          issues: ['Simulated setup validation failure'],
          warnings: [],
          sanitizedUrls: {},
        }),
      },
    });
    expect(resA.exitCode).toBe(1);
    expect(resA.error).toContain('Simulated setup validation failure');
    expect(resA.removedContainers).toEqual([]);
    expect(resA.removedVolumes).toEqual([]);
    expect(runDockerA).not.toHaveBeenCalled();

    // Case B: runSetupEnv throws
    const runDockerB = vi.fn();
    const resB = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDockerB,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRoot)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRoot)),
        runSetupEnv: vi.fn().mockRejectedValue(new Error('Disk permission denied during setup')),
      },
    });
    expect(resB.exitCode).toBe(1);
    expect(resB.error).toContain('Disk permission denied during setup');
    expect(resB.removedContainers).toEqual([]);
    expect(resB.removedVolumes).toEqual([]);
    expect(runDockerB).not.toHaveBeenCalled();
  });

  it('12. Failed preflight NEVER renames, backs up, or overwrites existing environment files — even with --recreate-env', async () => {
    const projectRoot = createTempDir();
    const originalEnv = 'DATABASE_URL="postgresql://erp_user:old_pass@localhost:5432/core_erp"\n';
    const originalStaging = 'STAGING_POSTGRES_PASSWORD="old_staging_pass"\n';
    const originalIntegration = 'POSTGRES_PASSWORD="old_integration_pass"\n';

    fs.writeFileSync(path.join(projectRoot, '.env'), originalEnv, 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.env.staging'), originalStaging, 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.env.integration-test'), originalIntegration, 'utf-8');

    const runDocker = vi.fn();
    const { logger } = createSilentLogger();

    // Trigger preflight failure via remote shell override while --recreate-env is TRUE
    const res = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://erp_user:secret@remote-prod.example.com:5432/core_erp',
      },
      logger,
      deps: {
        runDockerCommand: runDocker,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRoot)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRoot)),
      },
    });

    expect(res.exitCode).toBe(1);
    expect(res.backedUpEnvFiles).toEqual([]);
    expect(res.removedContainers).toEqual([]);
    expect(res.removedVolumes).toEqual([]);
    expect(runDocker).not.toHaveBeenCalled();

    // Existing files must remain byte-for-byte identical, with ZERO .backup.* files created
    expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8')).toBe(originalEnv);
    expect(fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8')).toBe(originalStaging);
    expect(fs.readFileSync(path.join(projectRoot, '.env.integration-test'), 'utf-8')).toBe(
      originalIntegration
    );
    const filesInDir = fs.readdirSync(projectRoot);
    expect(filesInDir.filter((f) => f.includes('.backup.'))).toEqual([]);
  });

  it('13. Docker ownership mismatch (missing labels, wrong service, wrong working_dir/config_files, unlabeled/colliding volumes) blocks BEFORE any deletion', async () => {
    const projectRoot = createTempDir();
    const otherWorkspace = createTempDir('other-workspace-');
    writeValidLocalEnvFiles(projectRoot);
    const { logger } = createSilentLogger();

    // Unit-level verification of verifyCoreErpContainerOwnership
    expect(
      verifyCoreErpContainerOwnership({
        container: { name: 'coreerp-postgres-dev', labels: {} },
        spec: COREERP_LOCAL_RESET_SPECS.dev,
        projectRoot,
      }).verified
    ).toBe(false);

    expect(
      verifyCoreErpContainerOwnership({
        container: {
          name: 'coreerp-postgres-dev',
          labels: {
            'com.docker.compose.project': 'coreerp',
            'com.docker.compose.service': 'wrong-service',
            'com.docker.compose.project.working_dir': projectRoot,
          },
        },
        spec: COREERP_LOCAL_RESET_SPECS.dev,
        projectRoot,
      }).verified
    ).toBe(false);

    // Unit-level verification of classifyCoreErpLocalVolume (fail closed without Compose labels)
    const allowedVols = new Set(['postgres_dev_data', 'postgres_staging_data']);
    expect(
      classifyCoreErpLocalVolume({
        volume: { name: 'coreerp_postgres_dev_data', labels: {} },
        allowedVolumeNames: allowedVols,
        projectRoot,
      })
    ).toBe('UNVERIFIED_OWNERSHIP');
    expect(
      classifyCoreErpLocalVolume({
        volume: { name: 'coreerp_postgres_data', labels: {} },
        allowedVolumeNames: allowedVols,
        projectRoot,
      })
    ).toBe('REJECT');
    expect(
      classifyCoreErpLocalVolume({
        volume: {
          name: 'otherproj_postgres_dev_data',
          labels: {
            'com.docker.compose.project': 'otherproj',
            'com.docker.compose.volume': 'postgres_dev_data',
            'com.docker.compose.project.working_dir': otherWorkspace,
          },
        },
        allowedVolumeNames: allowedVols,
        projectRoot,
      })
    ).toBe('FOREIGN_PROJECT');

    // Case A: Container has matching name only (no Compose labels) -> blocks with zero deletions
    const runDockerA = vi.fn();
    const resA = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDockerA,
        listDockerContainers: vi.fn().mockResolvedValue(['coreerp-postgres-dev']),
        listDockerVolumes: vi.fn().mockResolvedValue([]),
      },
    });
    expect(resA.exitCode).toBe(1);
    expect(resA.error).toContain('ownership');
    expect(runDockerA).not.toHaveBeenCalled();

    // Case B: Container belongs to a different working directory -> blocks with zero deletions
    const runDockerB = vi.fn();
    const resB = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDockerB,
        listDockerContainers: vi.fn().mockResolvedValue([
          {
            name: 'coreerp-postgres-dev',
            labels: {
              'com.docker.compose.project': 'coreerp',
              'com.docker.compose.service': COREERP_LOCAL_RESET_SPECS.dev.service,
              'com.docker.compose.project.working_dir': otherWorkspace,
            },
          },
        ]),
        listDockerVolumes: vi.fn().mockResolvedValue([]),
      },
    });
    expect(resB.exitCode).toBe(1);
    expect(resB.error).toContain('working directory');
    expect(runDockerB).not.toHaveBeenCalled();

    // Case C: Volume matches CoreERP suffix but lacks Compose labels -> blocks with zero deletions
    const runDockerC = vi.fn();
    const resC = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDockerC,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRoot)),
        listDockerVolumes: vi.fn().mockResolvedValue([
          { name: 'coreerp_postgres_dev_data', labels: {} },
        ]),
      },
    });
    expect(resC.exitCode).toBe(1);
    expect(resC.error).toContain('name-only deletion');
    expect(runDockerC).not.toHaveBeenCalled();

    // Case D: Bare canonical volume name points to another project -> ownership collision blocks
    const runDockerD = vi.fn();
    const resD = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: runDockerD,
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRoot)),
        listDockerVolumes: vi.fn().mockResolvedValue([
          {
            name: 'postgres_dev_data',
            labels: {
              'com.docker.compose.project': 'otherproj',
              'com.docker.compose.volume': 'postgres_dev_data',
              'com.docker.compose.project.working_dir': otherWorkspace,
            },
          },
        ]),
      },
    });
    expect(resD.exitCode).toBe(1);
    expect(resD.error).toContain('ownership');
    expect(runDockerD).not.toHaveBeenCalled();
  });

  it('14. Valid local config + verified Docker ownership executes full reset cleanly, preserves foreign/prod resources, supports --recreate-env backups, and reports post-deletion failure accurately', async () => {
    const projectRoot = createTempDir();
    const otherWorkspace = createTempDir('foreign-project-');

    const dockerInvocations: string[][] = [];
    const runDockerCommand = vi.fn().mockImplementation(async (args: string[]) => {
      dockerInvocations.push(args);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });

    const verifiedContainers = buildVerifiedContainers(projectRoot);
    const verifiedVolumes = buildVerifiedVolumes(projectRoot);
    const mockContainers: DockerContainerMetadata[] = [
      ...verifiedContainers,
      // Production & unrelated containers — MUST NEVER BE TOUCHED
      { name: 'coreerp-postgres', labels: {} },
      { name: 'coreerp-app', labels: {} },
      { name: 'other-service-postgres', labels: {} },
    ];
    const mockVolumes: DockerVolumeMetadata[] = [
      ...verifiedVolumes,
      // Production & unrelated volumes — MUST NEVER BE TOUCHED
      { name: 'coreerp_postgres_data', labels: {} },
      { name: 'coreerp_storage', labels: {} },
      { name: 'unrelated_analytics_pgdata', labels: {} },
      // Distinct foreign workspace volume — safely skipped and NEVER deleted
      {
        name: 'foreignproj_postgres_dev_data',
        labels: {
          'com.docker.compose.project': 'foreignproj',
          'com.docker.compose.volume': 'postgres_dev_data',
          'com.docker.compose.project.working_dir': otherWorkspace,
        },
      },
    ];

    const readyContainers: string[] = [];
    const migratedOrder: string[] = [];
    const runTargetMigration = vi.fn().mockImplementation(async (opts: { target: string }) => {
      migratedOrder.push(opts.target);
      return {
        exitCode: 0 as const,
        target: opts.target,
        mode: 'EXECUTE' as const,
        expectedMigrationsCount: 17,
        databaseName: opts.target,
      };
    });
    const runStagingVerify = vi.fn().mockResolvedValue({
      exitCode: 0 as const,
      mode: 'EXECUTE' as const,
      databaseName: 'core_erp_staging',
      steps: [],
    });

    const { logger, logs } = createSilentLogger();
    const res = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand,
        listDockerContainers: vi.fn().mockResolvedValue(mockContainers),
        listDockerVolumes: vi.fn().mockResolvedValue(mockVolumes),
        waitForPostgresReady: vi.fn().mockImplementation(async ({ container }) => {
          readyContainers.push(container);
          return true;
        }),
        runTargetMigration,
        runStagingVerify,
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.mode).toBe('EXECUTE');
    expect(res.targets).toEqual([...ALLOWED_LOCAL_RESET_TARGETS]);
    expect(res.removedContainers).toEqual([
      'coreerp-postgres-dev',
      'coreerp-postgres-test',
      'coreerp-postgres-integration-test',
      'coreerp-postgres-staging',
      'coreerp-postgres-shadow',
    ]);
    expect(res.removedVolumes).toEqual([
      'coreerp_postgres_dev_data',
      'coreerp_postgres_test_data',
      'coreerp_postgres_integration_test_data',
      'coreerp_postgres_staging_data',
      'coreerp_postgres_shadow_data',
    ]);
    expect(res.skippedForeignVolumes).toEqual(['foreignproj_postgres_dev_data']);
    expect(res.plan?.migrationTargets).toEqual(['dev', 'test', 'integration', 'staging']);
    expect(res.completedSteps).toContain('PREFLIGHT_STAGES_1_TO_7_PASSED');
    expect(res.completedSteps).toContain('STAGING_VERIFIED');

    // Verify NO global prune, NO production deletion, NO foreign volume deletion
    for (const cmd of dockerInvocations) {
      const joined = cmd.join(' ');
      expect(joined).not.toContain('prune');
      expect(joined).not.toContain('system');
      expect(joined).not.toContain('coreerp-postgres ');
      expect(joined).not.toContain('coreerp-app');
      expect(joined).not.toContain('other-service-postgres');
      expect(joined).not.toContain('coreerp_postgres_data');
      expect(joined).not.toContain('coreerp_storage');
      expect(joined).not.toContain('unrelated_analytics_pgdata');
      expect(joined).not.toContain('foreignproj_postgres_dev_data');
    }

    // All 3 fresh env files created cleanly only after Stage 1–7 preflight passed
    expect(fs.existsSync(path.join(projectRoot, '.env'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.env.staging'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.env.integration-test'))).toBe(true);

    // All 5 containers recreated and waited for pg_isready
    expect(res.recreatedTargets).toEqual(['dev', 'test', 'shadow', 'integration', 'staging']);
    expect(readyContainers).toEqual([
      'coreerp-postgres-dev',
      'coreerp-postgres-test',
      'coreerp-postgres-shadow',
      'coreerp-postgres-integration-test',
      'coreerp-postgres-staging',
    ]);

    // Migrations strictly applied to dev, test, integration, staging (never shadow)
    expect(migratedOrder).toEqual(['dev', 'test', 'integration', 'staging']);
    expect(res.migratedTargets).toEqual(['dev', 'test', 'integration', 'staging']);
    expect(runStagingVerify).toHaveBeenCalledTimes(1);
    expect(res.stagingVerified).toBe(true);

    // Zero secrets leaked into logs
    const stagingContent = fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8');
    const passMatch = stagingContent.match(/STAGING_POSTGRES_PASSWORD="([^"]+)"/);
    expect(passMatch).not.toBeNull();
    expect(logs.join('\n')).not.toContain(passMatch![1]);

    // Sub-case B: Valid --recreate-env backs up ONLY env files owned by selected targets in Stage 8
    const backupRoot = createTempDir();
    const seededBackupSecrets = writeValidLocalEnvFiles(backupRoot);
    const originalIntegrationBytes = fs.readFileSync(
      path.join(backupRoot, '.env.integration-test')
    );
    const backupRes = await runCoreErpCleanReset({
      projectRoot: backupRoot,
      targets: ['dev', 'staging'],
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
        listDockerContainers: vi.fn().mockResolvedValue([]),
        listDockerVolumes: vi.fn().mockResolvedValue([]),
        waitForPostgresReady: vi.fn().mockResolvedValue(true),
        runTargetMigration: vi.fn().mockResolvedValue({
          exitCode: 0,
          target: 'dev',
          mode: 'EXECUTE',
          expectedMigrationsCount: 17,
        }),
        runStagingVerify: vi.fn().mockResolvedValue({
          exitCode: 0,
          mode: 'EXECUTE',
          databaseName: 'core_erp_staging',
          steps: [],
        }),
      },
    });
    expect(backupRes.exitCode).toBe(0);
    // Only .env (owned by dev) and .env.staging (owned by staging) are backed up & recreated;
    // .env.integration-test belongs to unselected target "integration" and remains byte-for-byte untouched.
    expect(backupRes.backedUpEnvFiles).toHaveLength(2);
    expect(backupRes.backedUpEnvFiles.some((f) => f.startsWith('.env.staging.backup.'))).toBe(true);
    expect(backupRes.backedUpEnvFiles.some((f) => f.startsWith('.env.backup.'))).toBe(true);
    expect(
      backupRes.backedUpEnvFiles.some((f) => f.startsWith('.env.integration-test.backup.'))
    ).toBe(false);
    for (const backupFile of backupRes.backedUpEnvFiles) {
      expect(fs.existsSync(path.join(backupRoot, backupFile))).toBe(true);
    }
    expect(
      fs.readFileSync(path.join(backupRoot, '.env.integration-test')).equals(originalIntegrationBytes)
    ).toBe(true);
    const updatedBackupMainEnv = parseEnvFileContent(
      fs.readFileSync(path.join(backupRoot, '.env'), 'utf-8')
    );
    expect(updatedBackupMainEnv.SHADOW_POSTGRES_PASSWORD).toBe(seededBackupSecrets.shadowPassword);
    expect(updatedBackupMainEnv.SESSION_SECRET).toBe(seededBackupSecrets.sessionSecret);
    expect(updatedBackupMainEnv.BANK_ENCRYPTION_KEY).toBe(seededBackupSecrets.bankEncryptionKey);
    expect(updatedBackupMainEnv.BIOMETRIC_BRIDGE_TOKEN).toBe(
      seededBackupSecrets.biometricBridgeToken
    );

    // Sub-case C: Post-deletion failure stops immediately, reports completedSteps, and notes no rollback
    const failRoot = createTempDir();
    writeValidLocalEnvFiles(failRoot);
    const failRes = await runCoreErpCleanReset({
      projectRoot: failRoot,
      targets: ['dev', 'staging'],
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: vi.fn().mockImplementation(async (args: string[]) => {
          if (args.includes('docker-compose.staging.yml')) {
            return { exitCode: 1, stdout: '', stderr: 'port 5435 already allocated' };
          }
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        }),
        listDockerContainers: vi
          .fn()
          .mockResolvedValue(buildVerifiedContainers(failRoot, ['dev', 'staging'])),
        listDockerVolumes: vi
          .fn()
          .mockResolvedValue(buildVerifiedVolumes(failRoot, ['dev', 'staging'])),
        waitForPostgresReady: vi.fn().mockResolvedValue(true),
      },
    });
    expect(failRes.exitCode).toBe(1);
    expect(failRes.error).toContain('No automatic rollback was performed');
    expect(failRes.removedContainers).toEqual([
      'coreerp-postgres-dev',
      'coreerp-postgres-staging',
    ]);
    expect(failRes.recreatedTargets).toEqual(['dev']);
    expect(failRes.completedSteps).toContain('REMOVED_CONTAINER:coreerp-postgres-dev');
    expect(failRes.completedSteps).toContain('RECREATED_TARGET:dev');
    expect(failRes.completedSteps).not.toContain('RECREATED_TARGET:staging');
  });

  it('15. --execute without --confirm-coreerp-local-reset remains blocked (both API and CLI subprocess)', async () => {
    const projectRoot = createTempDir();
    writeValidLocalEnvFiles(projectRoot);
    const runDocker = vi.fn();
    const { logger } = createSilentLogger();

    const apiRes = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: false,
      env: { NODE_ENV: 'development' },
      logger,
      deps: { runDockerCommand: runDocker },
    });
    expect(apiRes.exitCode).toBe(1);
    expect(apiRes.error).toContain(REQUIRED_CONFIRMATION_FLAG);
    expect(runDocker).not.toHaveBeenCalled();

    // CLI subprocess check
    const tsxPath = path.resolve(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs');
    const scriptPath = path.resolve(import.meta.dirname, '../../scripts/clean-reset-db.ts');
    const emptyDir = createTempDir();

    const childEnv: Record<string, string | undefined> = { ...process.env };
    delete childEnv.DATABASE_URL;
    delete childEnv.VITEST;
    childEnv.NODE_ENV = 'development';

    const cliRes = spawnSync(process.execPath, [tsxPath, scriptPath, '--execute'], {
      cwd: emptyDir,
      env: childEnv,
      encoding: 'utf-8',
    });

    expect(cliRes.status).toBe(1);
    const output = `${cliRes.stdout}\n${cliRes.stderr}`;
    expect(output).toContain('CONFIRMATION REQUIRED');
    expect(output).toContain(REQUIRED_CONFIRMATION_FLAG);
    expect(fs.existsSync(path.join(emptyDir, '.env'))).toBe(false);
  });

  it('16. Dry-run never modifies Docker resources or environment files, and normal lifecycle scripts never invoke clean-reset', async () => {
    const projectRoot = createTempDir();
    const { logger, logs } = createSilentLogger();
    const runDockerCommand = vi.fn();
    const runTargetMigration = vi.fn();
    const runStagingVerify = vi.fn();

    const result = await runCoreErpCleanReset({
      projectRoot,
      execute: false,
      confirmed: false,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand,
        listDockerContainers: vi.fn().mockResolvedValue([
          ...buildVerifiedContainers(projectRoot, ['dev', 'staging']),
          { name: 'coreerp-postgres', labels: {} },
          { name: 'unrelated-redis', labels: {} },
        ]),
        listDockerVolumes: vi.fn().mockResolvedValue([
          ...buildVerifiedVolumes(projectRoot, ['dev', 'staging']),
          { name: 'coreerp_postgres_data', labels: {} },
          { name: 'unrelated_app_data', labels: {} },
        ]),
        runTargetMigration,
        runStagingVerify,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe('DRY_RUN');
    expect(result.matchedContainers).toEqual([
      'coreerp-postgres-dev',
      'coreerp-postgres-staging',
    ]);
    expect(result.matchedVolumes).toEqual([
      'coreerp_postgres_dev_data',
      'coreerp_postgres_staging_data',
    ]);
    expect(result.removedContainers).toEqual([]);
    expect(result.removedVolumes).toEqual([]);
    expect(runDockerCommand).not.toHaveBeenCalled();
    expect(runTargetMigration).not.toHaveBeenCalled();
    expect(runStagingVerify).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(projectRoot, '.env'))).toBe(false);
    expect(logs.join('\n')).toContain('DRY-RUN COMPLETE');
    expect(logs.join('\n')).toContain('USER_SYNC_ONLY');

    // Verify package.json lifecycle scripts never invoke clean-reset or Docker deletion
    const pkgPath = path.resolve(import.meta.dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.scripts['db:clean-reset']).toBe('tsx scripts/clean-reset-db.ts');
    expect(pkg.scripts['db:clean-reset:dry-run']).toBe('tsx scripts/clean-reset-db.ts');
    for (const scriptName of [
      'postinstall',
      'predev',
      'dev',
      'start',
      'prebuild',
      'build',
      'pretest',
      'test',
      'prelint',
      'lint',
      'db:setup',
      'db:setup:check',
    ]) {
      const cmd = String(pkg.scripts[scriptName] || '');
      expect(cmd).not.toContain('clean-reset');
      expect(cmd).not.toContain('docker');
      expect(cmd).not.toContain('prune');
    }
  });

  it('17. Existing eSSL X2008 biometric bridge config, checkpoint/watermark data, and USER_SYNC_ONLY mode remain completely untouched', async () => {
    const projectRoot = createTempDir();
    writeValidLocalEnvFiles(projectRoot);

    const bridgeDir = path.join(projectRoot, 'bridges', 'essl-x2008-bridge');
    const bridgeDataDir = path.join(bridgeDir, 'data');
    fs.mkdirSync(bridgeDataDir, { recursive: true });

    const bridgeConfigPath = path.join(bridgeDir, 'bridge.config.json');
    const checkpointPath = path.join(bridgeDataDir, 'checkpoint.json');
    const watermarkPath = path.join(bridgeDataDir, 'watermark.json');

    const originalBridgeConfig = JSON.stringify(
      {
        mode: 'USER_SYNC_ONLY',
        deviceIp: '192.168.1.201',
        devicePort: 4370,
        companyId: 'company-1',
      },
      null,
      2
    );
    const originalCheckpoint = JSON.stringify({
      lastSyncedAt: '2026-11-26T00:00:00.000Z',
      mode: 'USER_SYNC_ONLY',
    });
    const originalWatermark = JSON.stringify({
      lastUid: 412,
      lastRecordTime: '2026-11-26T08:30:00.000Z',
    });

    fs.writeFileSync(bridgeConfigPath, originalBridgeConfig, 'utf-8');
    fs.writeFileSync(checkpointPath, originalCheckpoint, 'utf-8');
    fs.writeFileSync(watermarkPath, originalWatermark, 'utf-8');

    const { logger } = createSilentLogger();
    const res = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRoot)),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRoot)),
        waitForPostgresReady: vi.fn().mockResolvedValue(true),
        runTargetMigration: vi.fn().mockResolvedValue({
          exitCode: 0,
          target: 'dev',
          mode: 'EXECUTE',
          expectedMigrationsCount: 17,
        }),
        runStagingVerify: vi.fn().mockResolvedValue({
          exitCode: 0,
          mode: 'EXECUTE',
          databaseName: 'core_erp_staging',
          steps: [],
        }),
      },
    });

    expect(res.exitCode).toBe(0);
    expect(fs.readFileSync(bridgeConfigPath, 'utf-8')).toBe(originalBridgeConfig);
    expect(fs.readFileSync(checkpointPath, 'utf-8')).toBe(originalCheckpoint);
    expect(fs.readFileSync(watermarkPath, 'utf-8')).toBe(originalWatermark);
    expect(JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf-8')).mode).toBe('USER_SYNC_ONLY');
  });

  it('18. Target isolation (dev only + --recreate-env): updates ONLY .env, preserves shadow credentials and all app secrets/encryption metadata, and keeps .env.staging and .env.integration-test byte-for-byte unchanged', async () => {
    const projectRoot = createTempDir();
    const customHistoricalKeys =
      '{"k1":"1111111111111111111111111111111111111111111111111111111111111111","k2":"2222222222222222222222222222222222222222222222222222222222222222"}';
    const seeded = writeValidLocalEnvFiles(projectRoot, {
      devPassword: 'custom_old_dev_password_to_replace',
      shadowUser: 'custom_shadow_user',
      shadowPassword: 'preserved_shadow_secret_abcdef9876543210',
      sessionSecret: 'preserved_session_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      bankEncryptionKey: '3333333333333333333333333333333333333333333333333333333333333333',
      bankActiveKeyId: 'k3',
      bankHistoricalKeys: customHistoricalKeys,
      biometricBridgeToken: 'preserved_bridge_token_bbbbbbbbbbbbbbbbbbbb',
    });

    const originalStagingBytes = fs.readFileSync(path.join(projectRoot, '.env.staging'));
    const originalIntegrationBytes = fs.readFileSync(
      path.join(projectRoot, '.env.integration-test')
    );

    const { logger, logs } = createSilentLogger();
    const res = await runCoreErpCleanReset({
      projectRoot,
      targets: ['dev'],
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
        listDockerContainers: vi.fn().mockResolvedValue(buildVerifiedContainers(projectRoot, ['dev'])),
        listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(projectRoot, ['dev'])),
        waitForPostgresReady: vi.fn().mockResolvedValue(true),
        runTargetMigration: vi.fn().mockResolvedValue({
          exitCode: 0,
          target: 'dev',
          mode: 'EXECUTE',
          expectedMigrationsCount: 17,
        }),
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.plan?.envActions).toEqual([
      { file: '.env.staging', action: 'PRESERVE' },
      { file: '.env.integration-test', action: 'PRESERVE' },
      { file: '.env', action: 'BACKUP_AND_RECREATE' },
    ]);
    expect(res.backedUpEnvFiles).toHaveLength(1);
    expect(res.backedUpEnvFiles[0]).toMatch(/^\.env\.backup\./);

    // Unselected env files remain byte-for-byte unchanged
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.staging')).equals(originalStagingBytes)
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.integration-test')).equals(originalIntegrationBytes)
    ).toBe(true);

    // .env refreshed dev credentials while preserving unselected shadow credentials and all app secrets/encryption metadata
    const updatedMain = parseEnvFileContent(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8'));
    expect(updatedMain.POSTGRES_USER).toBe('erp_user');
    expect(updatedMain.POSTGRES_PASSWORD).toBe('erp_password_dev');
    expect(updatedMain.DATABASE_URL).toBe(
      'postgresql://erp_user:erp_password_dev@localhost:5432/core_erp?schema=public'
    );
    expect(updatedMain.SHADOW_POSTGRES_USER).toBe('custom_shadow_user');
    expect(updatedMain.SHADOW_POSTGRES_PASSWORD).toBe(seeded.shadowPassword);
    expect(updatedMain.SHADOW_POSTGRES_DB).toBe('core_erp_shadow');
    expect(updatedMain.SHADOW_DATABASE_URL).toBe(
      `postgresql://custom_shadow_user:${seeded.shadowPassword}@localhost:5436/core_erp_shadow?schema=public`
    );
    expect(updatedMain.SESSION_SECRET).toBe(seeded.sessionSecret);
    expect(updatedMain.BANK_ENCRYPTION_KEY).toBe(seeded.bankEncryptionKey);
    expect(updatedMain.BANK_ACTIVE_KEY_ID).toBe('k3');
    expect(updatedMain.BANK_HISTORICAL_KEYS).toBe(customHistoricalKeys);
    expect(updatedMain.BIOMETRIC_BRIDGE_TOKEN).toBe(seeded.biometricBridgeToken);

    // Zero secrets leaked into logs
    const combinedLogs = logs.join('\n');
    expect(combinedLogs).not.toContain(seeded.shadowPassword);
    expect(combinedLogs).not.toContain(seeded.sessionSecret);
    expect(combinedLogs).not.toContain(seeded.bankEncryptionKey);
    expect(combinedLogs).not.toContain(
      '1111111111111111111111111111111111111111111111111111111111111111'
    );
    expect(combinedLogs).not.toContain(seeded.biometricBridgeToken);
  });

  it('19. Target isolation (shadow only + --recreate-env): updates ONLY .env, preserves dev credentials and all app secrets/encryption metadata, and keeps .env.staging and .env.integration-test byte-for-byte unchanged', async () => {
    const projectRoot = createTempDir();
    const customHistoricalKeys =
      '{"k1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
    const seeded = writeValidLocalEnvFiles(projectRoot, {
      devUser: 'custom_dev_user',
      devPassword: 'preserved_dev_secret_1234567890abcdef',
      shadowPassword: 'old_shadow_secret_to_rotate_00000000',
      sessionSecret: 'preserved_session_for_shadow_reset_1234567890',
      bankEncryptionKey: '4444444444444444444444444444444444444444444444444444444444444444',
      bankActiveKeyId: 'k2',
      bankHistoricalKeys: customHistoricalKeys,
      biometricBridgeToken: 'preserved_bridge_for_shadow_reset_1234567890',
    });

    const originalStagingBytes = fs.readFileSync(path.join(projectRoot, '.env.staging'));
    const originalIntegrationBytes = fs.readFileSync(
      path.join(projectRoot, '.env.integration-test')
    );

    const { logger } = createSilentLogger();
    const res = await runCoreErpCleanReset({
      projectRoot,
      targets: ['shadow'],
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
        listDockerContainers: vi
          .fn()
          .mockResolvedValue(buildVerifiedContainers(projectRoot, ['shadow'])),
        listDockerVolumes: vi
          .fn()
          .mockResolvedValue(buildVerifiedVolumes(projectRoot, ['shadow'])),
        waitForPostgresReady: vi.fn().mockResolvedValue(true),
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.plan?.envActions).toEqual([
      { file: '.env.staging', action: 'PRESERVE' },
      { file: '.env.integration-test', action: 'PRESERVE' },
      { file: '.env', action: 'BACKUP_AND_RECREATE' },
    ]);
    expect(res.backedUpEnvFiles).toHaveLength(1);
    expect(res.backedUpEnvFiles[0]).toMatch(/^\.env\.backup\./);

    // Unselected env files remain byte-for-byte unchanged
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.staging')).equals(originalStagingBytes)
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.integration-test')).equals(originalIntegrationBytes)
    ).toBe(true);

    // .env rotated shadow credentials while preserving unselected dev credentials & app secrets
    const updatedMain = parseEnvFileContent(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8'));
    expect(updatedMain.POSTGRES_USER).toBe('custom_dev_user');
    expect(updatedMain.POSTGRES_PASSWORD).toBe(seeded.devPassword);
    expect(updatedMain.POSTGRES_DB).toBe('core_erp');
    expect(updatedMain.DATABASE_URL).toBe(
      `postgresql://custom_dev_user:${seeded.devPassword}@localhost:5432/core_erp?schema=public`
    );
    expect(updatedMain.SHADOW_POSTGRES_USER).toBe('erp_shadow_user');
    expect(updatedMain.SHADOW_POSTGRES_PASSWORD).not.toBe(seeded.shadowPassword);
    expect(updatedMain.SHADOW_DATABASE_URL).toContain(updatedMain.SHADOW_POSTGRES_PASSWORD);
    expect(updatedMain.SESSION_SECRET).toBe(seeded.sessionSecret);
    expect(updatedMain.BANK_ENCRYPTION_KEY).toBe(seeded.bankEncryptionKey);
    expect(updatedMain.BANK_ACTIVE_KEY_ID).toBe('k2');
    expect(updatedMain.BANK_HISTORICAL_KEYS).toBe(customHistoricalKeys);
    expect(updatedMain.BIOMETRIC_BRIDGE_TOKEN).toBe(seeded.biometricBridgeToken);
  });

  it('20. Target isolation (staging only + --recreate-env): recreates ONLY .env.staging and leaves .env and .env.integration-test byte-for-byte unchanged', async () => {
    const projectRoot = createTempDir();
    const seeded = writeValidLocalEnvFiles(projectRoot);
    const originalMainBytes = fs.readFileSync(path.join(projectRoot, '.env'));
    const originalIntegrationBytes = fs.readFileSync(
      path.join(projectRoot, '.env.integration-test')
    );

    const { logger } = createSilentLogger();
    const res = await runCoreErpCleanReset({
      projectRoot,
      targets: ['staging'],
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
        listDockerContainers: vi
          .fn()
          .mockResolvedValue(buildVerifiedContainers(projectRoot, ['staging'])),
        listDockerVolumes: vi
          .fn()
          .mockResolvedValue(buildVerifiedVolumes(projectRoot, ['staging'])),
        waitForPostgresReady: vi.fn().mockResolvedValue(true),
        runTargetMigration: vi.fn().mockResolvedValue({
          exitCode: 0,
          target: 'staging',
          mode: 'EXECUTE',
          expectedMigrationsCount: 17,
        }),
        runStagingVerify: vi.fn().mockResolvedValue({
          exitCode: 0,
          mode: 'EXECUTE',
          databaseName: 'core_erp_staging',
          steps: [],
        }),
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.plan?.envActions).toEqual([
      { file: '.env.staging', action: 'BACKUP_AND_RECREATE' },
      { file: '.env.integration-test', action: 'PRESERVE' },
      { file: '.env', action: 'PRESERVE' },
    ]);
    expect(res.backedUpEnvFiles).toHaveLength(1);
    expect(res.backedUpEnvFiles[0]).toMatch(/^\.env\.staging\.backup\./);

    expect(fs.readFileSync(path.join(projectRoot, '.env')).equals(originalMainBytes)).toBe(true);
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.integration-test')).equals(originalIntegrationBytes)
    ).toBe(true);
    const updatedStaging = parseEnvFileContent(
      fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8')
    );
    expect(updatedStaging.STAGING_POSTGRES_PASSWORD).not.toBe(seeded.stagingPassword);
    expect(updatedStaging.STAGING_DATABASE_URL).toContain(updatedStaging.STAGING_POSTGRES_PASSWORD);
  });

  it('21. Target isolation (integration only + --recreate-env): recreates ONLY .env.integration-test and leaves .env and .env.staging byte-for-byte unchanged', async () => {
    const projectRoot = createTempDir();
    const seeded = writeValidLocalEnvFiles(projectRoot);
    const originalMainBytes = fs.readFileSync(path.join(projectRoot, '.env'));
    const originalStagingBytes = fs.readFileSync(path.join(projectRoot, '.env.staging'));

    const { logger } = createSilentLogger();
    const res = await runCoreErpCleanReset({
      projectRoot,
      targets: ['integration'],
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
        listDockerContainers: vi
          .fn()
          .mockResolvedValue(buildVerifiedContainers(projectRoot, ['integration'])),
        listDockerVolumes: vi
          .fn()
          .mockResolvedValue(buildVerifiedVolumes(projectRoot, ['integration'])),
        waitForPostgresReady: vi.fn().mockResolvedValue(true),
        runTargetMigration: vi.fn().mockResolvedValue({
          exitCode: 0,
          target: 'integration',
          mode: 'EXECUTE',
          expectedMigrationsCount: 17,
        }),
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.plan?.envActions).toEqual([
      { file: '.env.staging', action: 'PRESERVE' },
      { file: '.env.integration-test', action: 'BACKUP_AND_RECREATE' },
      { file: '.env', action: 'PRESERVE' },
    ]);
    expect(res.backedUpEnvFiles).toHaveLength(1);
    expect(res.backedUpEnvFiles[0]).toMatch(/^\.env\.integration-test\.backup\./);

    expect(fs.readFileSync(path.join(projectRoot, '.env')).equals(originalMainBytes)).toBe(true);
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.staging')).equals(originalStagingBytes)
    ).toBe(true);
    const updatedInt = parseEnvFileContent(
      fs.readFileSync(path.join(projectRoot, '.env.integration-test'), 'utf-8')
    );
    expect(updatedInt.POSTGRES_PASSWORD).not.toBe(seeded.integrationPassword);
    expect(updatedInt.TEST_DATABASE_URL).toContain(updatedInt.POSTGRES_PASSWORD);
  });

  it('22. Target isolation (test only): NEVER modifies or backs up ANY environment file — even when --recreate-env is true', async () => {
    for (const recreateEnv of [false, true]) {
      const projectRoot = createTempDir();
      writeValidLocalEnvFiles(projectRoot);
      const originalMainBytes = fs.readFileSync(path.join(projectRoot, '.env'));
      const originalStagingBytes = fs.readFileSync(path.join(projectRoot, '.env.staging'));
      const originalIntegrationBytes = fs.readFileSync(
        path.join(projectRoot, '.env.integration-test')
      );

      const { logger } = createSilentLogger();
      const res = await runCoreErpCleanReset({
        projectRoot,
        targets: ['test'],
        execute: true,
        confirmed: true,
        recreateEnv,
        env: { NODE_ENV: 'development' },
        logger,
        deps: {
          runDockerCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
          listDockerContainers: vi
            .fn()
            .mockResolvedValue(buildVerifiedContainers(projectRoot, ['test'])),
          listDockerVolumes: vi
            .fn()
            .mockResolvedValue(buildVerifiedVolumes(projectRoot, ['test'])),
          waitForPostgresReady: vi.fn().mockResolvedValue(true),
          runTargetMigration: vi.fn().mockResolvedValue({
            exitCode: 0,
            target: 'test',
            mode: 'EXECUTE',
            expectedMigrationsCount: 17,
          }),
        },
      });

      expect(res.exitCode).toBe(0);
      expect(res.plan?.envActions).toEqual([
        { file: '.env.staging', action: 'PRESERVE' },
        { file: '.env.integration-test', action: 'PRESERVE' },
        { file: '.env', action: 'PRESERVE' },
      ]);
      expect(res.backedUpEnvFiles).toEqual([]);
      expect(fs.readdirSync(projectRoot).filter((f) => f.includes('.backup.'))).toEqual([]);
      expect(fs.readFileSync(path.join(projectRoot, '.env')).equals(originalMainBytes)).toBe(true);
      expect(
        fs.readFileSync(path.join(projectRoot, '.env.staging')).equals(originalStagingBytes)
      ).toBe(true);
      expect(
        fs
          .readFileSync(path.join(projectRoot, '.env.integration-test'))
          .equals(originalIntegrationBytes)
      ).toBe(true);
    }
  });

  it('23. Target isolation (dev + shadow + --recreate-env): refreshes both dev and shadow in .env while preserving app secrets & bank encryption metadata and leaving staging/integration files byte-for-byte unchanged', async () => {
    const projectRoot = createTempDir();
    const customHistoricalKeys =
      '{"k1":"5555555555555555555555555555555555555555555555555555555555555555","k2":"6666666666666666666666666666666666666666666666666666666666666666"}';
    const seeded = writeValidLocalEnvFiles(projectRoot, {
      devPassword: 'old_dev_password_both_selected',
      shadowPassword: 'old_shadow_password_both_selected',
      sessionSecret: 'preserved_session_both_dev_shadow_0123456789abcdef',
      bankEncryptionKey: '7777777777777777777777777777777777777777777777777777777777777777',
      bankActiveKeyId: 'k4',
      bankHistoricalKeys: customHistoricalKeys,
      biometricBridgeToken: 'preserved_bridge_both_dev_shadow_0123456789abcdef',
    });
    const originalStagingBytes = fs.readFileSync(path.join(projectRoot, '.env.staging'));
    const originalIntegrationBytes = fs.readFileSync(
      path.join(projectRoot, '.env.integration-test')
    );

    const { logger } = createSilentLogger();
    const res = await runCoreErpCleanReset({
      projectRoot,
      targets: ['dev', 'shadow'],
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
        listDockerContainers: vi
          .fn()
          .mockResolvedValue(buildVerifiedContainers(projectRoot, ['dev', 'shadow'])),
        listDockerVolumes: vi
          .fn()
          .mockResolvedValue(buildVerifiedVolumes(projectRoot, ['dev', 'shadow'])),
        waitForPostgresReady: vi.fn().mockResolvedValue(true),
        runTargetMigration: vi.fn().mockResolvedValue({
          exitCode: 0,
          target: 'dev',
          mode: 'EXECUTE',
          expectedMigrationsCount: 17,
        }),
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.backedUpEnvFiles).toHaveLength(1);
    expect(res.backedUpEnvFiles[0]).toMatch(/^\.env\.backup\./);
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.staging')).equals(originalStagingBytes)
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.integration-test')).equals(originalIntegrationBytes)
    ).toBe(true);

    const updatedMain = parseEnvFileContent(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8'));
    expect(updatedMain.POSTGRES_PASSWORD).toBe('erp_password_dev');
    expect(updatedMain.SHADOW_POSTGRES_PASSWORD).not.toBe(seeded.shadowPassword);
    expect(updatedMain.SESSION_SECRET).toBe(seeded.sessionSecret);
    expect(updatedMain.BANK_ENCRYPTION_KEY).toBe(seeded.bankEncryptionKey);
    expect(updatedMain.BANK_ACTIVE_KEY_ID).toBe('k4');
    expect(updatedMain.BANK_HISTORICAL_KEYS).toBe(customHistoricalKeys);
    expect(updatedMain.BIOMETRIC_BRIDGE_TOKEN).toBe(seeded.biometricBridgeToken);
  });

  it('24. Fail-safe pre-deletion errors block BEFORE any Docker deletion or file mutation when unselected target credentials cannot be safely preserved', async () => {
    const cases: Array<{
      name: string;
      targets: CleanResetTarget[];
      recreateEnv: boolean;
      setup: (root: string) => void;
      expectedErrorPattern: RegExp;
    }> = [
      {
        name: 'dev-only when .env is missing (cannot preserve unselected shadow)',
        targets: ['dev'],
        recreateEnv: true,
        setup: (root) => {
          writeValidLocalEnvFiles(root);
          fs.unlinkSync(path.join(root, '.env'));
        },
        expectedErrorPattern: /unselected target "shadow" cannot be preserved/,
      },
      {
        name: 'dev-only with --recreate-env when SHADOW_POSTGRES_PASSWORD mismatches SHADOW_DATABASE_URL',
        targets: ['dev'],
        recreateEnv: true,
        setup: (root) => {
          writeValidLocalEnvFiles(root, {
            shadowPassword: 'shadow_pass_a_valid_1234567890',
            shadowUrl:
              'postgresql://erp_shadow_user:shadow_pass_b_mismatch_123456@localhost:5436/core_erp_shadow?schema=public',
          });
        },
        expectedErrorPattern: /SHADOW_POSTGRES_PASSWORD does not match SHADOW_DATABASE_URL/,
      },
      {
        name: 'dev-only with --recreate-env when SHADOW_POSTGRES_PASSWORD is placeholder',
        targets: ['dev'],
        recreateEnv: true,
        setup: (root) => {
          writeValidLocalEnvFiles(root, {
            shadowPassword: 'replace_with_shadow_password',
          });
        },
        expectedErrorPattern: /SHADOW_DATABASE_URL has missing or placeholder credentials/,
      },
      {
        name: 'shadow-only when .env is missing (cannot preserve unselected dev)',
        targets: ['shadow'],
        recreateEnv: true,
        setup: (root) => {
          writeValidLocalEnvFiles(root);
          fs.unlinkSync(path.join(root, '.env'));
        },
        expectedErrorPattern: /unselected target "dev" cannot be preserved/,
      },
      {
        name: 'shadow-only with --recreate-env when POSTGRES_PASSWORD mismatches DATABASE_URL',
        targets: ['shadow'],
        recreateEnv: true,
        setup: (root) => {
          writeValidLocalEnvFiles(root, {
            devPassword: 'dev_pass_a_valid_1234567890',
            devUrl:
              'postgresql://erp_user:dev_pass_b_mismatch_123456@localhost:5432/core_erp?schema=public',
          });
        },
        expectedErrorPattern: /POSTGRES_PASSWORD does not match DATABASE_URL/,
      },
      {
        name: 'staging-only when unselected .env.integration-test is missing',
        targets: ['staging'],
        recreateEnv: true,
        setup: (root) => {
          writeValidLocalEnvFiles(root);
          fs.unlinkSync(path.join(root, '.env.integration-test'));
        },
        expectedErrorPattern: /Cannot preserve unselected target "integration"/,
      },
      {
        name: 'test-only when unselected .env.staging is missing',
        targets: ['test'],
        recreateEnv: false,
        setup: (root) => {
          writeValidLocalEnvFiles(root);
          fs.unlinkSync(path.join(root, '.env.staging'));
        },
        expectedErrorPattern: /Cannot preserve unselected target "staging"/,
      },
      {
        name: 'integration-only when unselected .env is missing',
        targets: ['integration'],
        recreateEnv: true,
        setup: (root) => {
          writeValidLocalEnvFiles(root);
          fs.unlinkSync(path.join(root, '.env'));
        },
        expectedErrorPattern: /Cannot preserve unselected targets "dev" and "shadow"/,
      },
    ];

    for (const tc of cases) {
      const root = createTempDir();
      tc.setup(root);
      const snapshotBefore = Object.fromEntries(
        fs
          .readdirSync(root)
          .sort()
          .map((file) => [file, fs.readFileSync(path.join(root, file), 'utf-8')])
      );

      const runDocker = vi.fn();
      const { logger } = createSilentLogger();
      const res = await runCoreErpCleanReset({
        projectRoot: root,
        targets: tc.targets,
        execute: true,
        confirmed: true,
        recreateEnv: tc.recreateEnv,
        env: { NODE_ENV: 'development' },
        logger,
        deps: {
          runDockerCommand: runDocker,
          listDockerContainers: vi
            .fn()
            .mockResolvedValue(buildVerifiedContainers(root, tc.targets)),
          listDockerVolumes: vi.fn().mockResolvedValue(buildVerifiedVolumes(root, tc.targets)),
        },
      });

      expect(res.exitCode, tc.name).toBe(1);
      expect(res.error, tc.name).toMatch(tc.expectedErrorPattern);
      expect(res.removedContainers, tc.name).toEqual([]);
      expect(res.removedVolumes, tc.name).toEqual([]);
      expect(res.backedUpEnvFiles, tc.name).toEqual([]);
      expect(runDocker, tc.name).not.toHaveBeenCalled();

      const snapshotAfter = Object.fromEntries(
        fs
          .readdirSync(root)
          .sort()
          .map((file) => [file, fs.readFileSync(path.join(root, file), 'utf-8')])
      );
      expect(snapshotAfter, tc.name).toEqual(snapshotBefore);
    }
  });

  it('25. Shell override conflicts for unselected preserved targets still block BEFORE deletion even when --recreate-env is set for another target', async () => {
    const projectRoot = createTempDir();
    writeValidLocalEnvFiles(projectRoot, {
      devPassword: 'file_dev_password_preserved_123456',
    });
    const originalMainBytes = fs.readFileSync(path.join(projectRoot, '.env'));
    const originalStagingBytes = fs.readFileSync(path.join(projectRoot, '.env.staging'));

    const runDocker = vi.fn();
    const { logger } = createSilentLogger();
    const res = await runCoreErpCleanReset({
      projectRoot,
      targets: ['staging'],
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: {
        NODE_ENV: 'development',
        DATABASE_URL:
          'postgresql://erp_user:conflicting_shell_dev_password@localhost:5432/core_erp?schema=public',
      },
      logger,
      deps: {
        runDockerCommand: runDocker,
        listDockerContainers: vi
          .fn()
          .mockResolvedValue(buildVerifiedContainers(projectRoot, ['staging'])),
        listDockerVolumes: vi
          .fn()
          .mockResolvedValue(buildVerifiedVolumes(projectRoot, ['staging'])),
      },
    });

    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('[shell environment :: DATABASE_URL]');
    expect(res.error).not.toContain('conflicting_shell_dev_password');
    expect(res.removedContainers).toEqual([]);
    expect(res.removedVolumes).toEqual([]);
    expect(res.backedUpEnvFiles).toEqual([]);
    expect(runDocker).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(projectRoot, '.env')).equals(originalMainBytes)).toBe(true);
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.staging')).equals(originalStagingBytes)
    ).toBe(true);
  });

  it('26. generateDistinctSecret retries forbidden collisions, never returns a forbidden value, and throws a non-sensitive error when all attempts collide', async () => {
    const forbiddenSecretA = 'forbidden_secret_value_alpha_1234567890';
    const forbiddenSecretB = 'forbidden_secret_value_beta_0987654321';
    const validUniqueSecret = 'valid_unique_secret_value_abcdef123456';
    const forbidden = new Set<string>([forbiddenSecretA, forbiddenSecretB]);

    // Case A: forbidden value(s) followed by a valid unique value
    const sequence = [forbiddenSecretA, forbiddenSecretB, validUniqueSecret];
    let idx = 0;
    const seqGenerator = vi.fn(() => sequence[idx++]);
    const result = generateDistinctSecret(seqGenerator, 32, forbidden);

    expect(result).toBe(validUniqueSecret);
    expect(forbidden.has(result)).toBe(false);
    expect(seqGenerator).toHaveBeenCalledTimes(3);

    // Case B: all attempts return forbidden values -> throws clear, non-sensitive error (no unchecked fallback)
    const alwaysForbidden = vi.fn(() => forbiddenSecretA);
    let caughtError: Error | null = null;
    try {
      generateDistinctSecret(alwaysForbidden, 32, forbidden);
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toMatch(/Failed to generate a unique secret/i);
    expect(caughtError!.message).not.toContain(forbiddenSecretA);
    expect(caughtError!.message).not.toContain(forbiddenSecretB);
    expect(alwaysForbidden).toHaveBeenCalledTimes(8);

    // Case C: end-to-end clean-reset aborts cleanly in Stage 4 with zero mutations when secret generator keeps colliding
    const projectRoot = createTempDir();
    const seeded = writeValidLocalEnvFiles(projectRoot, {
      devPassword: 'dev_secret_collision_test_1234567890',
    });
    const originalMainBytes = fs.readFileSync(path.join(projectRoot, '.env'));
    const originalStagingBytes = fs.readFileSync(path.join(projectRoot, '.env.staging'));
    const originalIntegrationBytes = fs.readFileSync(
      path.join(projectRoot, '.env.integration-test')
    );
    const runDocker = vi.fn();
    const { logger } = createSilentLogger();

    const resetRes = await runCoreErpCleanReset({
      projectRoot,
      targets: ['staging'],
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        generateSecret: vi.fn(() => seeded.devPassword),
        runDockerCommand: runDocker,
        listDockerContainers: vi
          .fn()
          .mockResolvedValue(buildVerifiedContainers(projectRoot, ['staging'])),
        listDockerVolumes: vi
          .fn()
          .mockResolvedValue(buildVerifiedVolumes(projectRoot, ['staging'])),
      },
    });

    expect(resetRes.exitCode).toBe(1);
    expect(resetRes.error).toMatch(/Failed to generate a unique secret/i);
    expect(resetRes.error).not.toContain(seeded.devPassword);
    expect(resetRes.removedContainers).toEqual([]);
    expect(resetRes.removedVolumes).toEqual([]);
    expect(resetRes.backedUpEnvFiles).toEqual([]);
    expect(runDocker).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(projectRoot, '.env')).equals(originalMainBytes)).toBe(true);
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.staging')).equals(originalStagingBytes)
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(projectRoot, '.env.integration-test')).equals(originalIntegrationBytes)
    ).toBe(true);
  });
});
