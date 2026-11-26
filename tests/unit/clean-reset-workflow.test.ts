import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ALLOWED_LOCAL_RESET_TARGETS,
  REQUIRED_CONFIRMATION_FLAG,
  assertNeverGlobalDockerPrune,
  assertSafeCoreErpContainerName,
  classifyCoreErpLocalVolume,
  parseCleanResetTargets,
  runCoreErpCleanReset,
  type CleanResetLogger,
  type DockerVolumeMetadata,
} from '../../src/server/db/clean-reset.js';

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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('CoreERP Explicitly Confirmed Scoped Local Docker Clean-Reset & Fresh-Install Workflow', () => {
  it('1. Hard safety guards strictly block global Docker prune, image deletion, compose down -v, and production/unrelated containers', () => {
    expect(() => assertNeverGlobalDockerPrune(['system', 'prune', '--volumes', '-f'])).toThrow(
      /DOCKER SAFETY VIOLATION/
    );
    expect(() => assertNeverGlobalDockerPrune(['volume', 'prune', '-f'])).toThrow(
      /DOCKER SAFETY VIOLATION/
    );
    expect(() => assertNeverGlobalDockerPrune(['container', 'prune', '-f'])).toThrow(
      /DOCKER SAFETY VIOLATION/
    );
    expect(() => assertNeverGlobalDockerPrune(['compose', '-f', 'docker-compose.dev.yml', 'down', '-v'])).toThrow(
      /DOCKER SAFETY VIOLATION/
    );
    expect(() => assertNeverGlobalDockerPrune(['rmi', 'postgres:16-alpine'])).toThrow(
      /DOCKER SAFETY VIOLATION/
    );
    expect(() => assertNeverGlobalDockerPrune(['rm', '-f', 'coreerp-postgres-dev'])).not.toThrow();

    // Production and unrelated containers must always be rejected
    expect(() => assertSafeCoreErpContainerName('coreerp-postgres')).toThrow(/production container/);
    expect(() => assertSafeCoreErpContainerName('coreerp-app')).toThrow(/production container/);
    expect(() => assertSafeCoreErpContainerName('coreerp-migration')).toThrow(/production container/);
    expect(() => assertSafeCoreErpContainerName('other-company-postgres')).toThrow(/unrelated container/);
    expect(() => assertSafeCoreErpContainerName('coreerp-postgres-staging')).not.toThrow();
  });

  it('2. Volume classifier strictly allows ONLY CoreERP local volumes in the current workspace and protects production & foreign volumes', () => {
    const workspace = createTempDir();
    const otherWorkspace = createTempDir('other-repo-');
    const allowedVolumes = new Set([
      'postgres_dev_data',
      'postgres_test_data',
      'postgres_integration_test_data',
      'postgres_staging_data',
      'postgres_shadow_data',
    ]);

    // Production volumes — unconditionally REJECTED
    expect(
      classifyCoreErpLocalVolume({
        volume: { name: 'postgres_data', labels: {} },
        allowedVolumeNames: allowedVolumes,
        projectRoot: workspace,
      })
    ).toBe('REJECT');
    expect(
      classifyCoreErpLocalVolume({
        volume: { name: 'coreerp_postgres_data', labels: {} },
        allowedVolumeNames: allowedVolumes,
        projectRoot: workspace,
      })
    ).toBe('REJECT');
    expect(
      classifyCoreErpLocalVolume({
        volume: { name: 'coreerp_storage', labels: {} },
        allowedVolumeNames: allowedVolumes,
        projectRoot: workspace,
      })
    ).toBe('REJECT');

    // Unrelated project volume — REJECTED
    expect(
      classifyCoreErpLocalVolume({
        volume: { name: 'crm_app_postgres_data', labels: {} },
        allowedVolumeNames: allowedVolumes,
        projectRoot: workspace,
      })
    ).toBe('REJECT');

    // Same volume name but labeled by a DIFFERENT project working directory — FOREIGN_PROJECT (skipped!)
    expect(
      classifyCoreErpLocalVolume({
        volume: {
          name: 'otherproj_postgres_dev_data',
          labels: {
            'com.docker.compose.volume': 'postgres_dev_data',
            'com.docker.compose.project.working_dir': otherWorkspace,
          },
        },
        allowedVolumeNames: allowedVolumes,
        projectRoot: workspace,
      })
    ).toBe('FOREIGN_PROJECT');

    // CoreERP local volume belonging to THIS workspace — ALLOW
    expect(
      classifyCoreErpLocalVolume({
        volume: {
          name: 'coreerp_postgres_staging_data',
          labels: {
            'com.docker.compose.volume': 'postgres_staging_data',
            'com.docker.compose.project.working_dir': workspace,
          },
        },
        allowedVolumeNames: allowedVolumes,
        projectRoot: workspace,
      })
    ).toBe('ALLOW');
  });

  it('3. Default mode is safe DRY-RUN: discovers scoped resources only and executes ZERO Docker mutations or migrations', async () => {
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
          'coreerp-postgres-dev',
          'coreerp-postgres-staging',
          'coreerp-postgres', // production — must NOT be matched
          'unrelated-redis', // unrelated — must NOT be matched
        ]),
        listDockerVolumes: vi.fn().mockResolvedValue([
          { name: 'coreerp_postgres_dev_data', labels: {} },
          { name: 'coreerp_postgres_staging_data', labels: {} },
          { name: 'coreerp_postgres_data', labels: {} }, // production — must NOT be matched
          { name: 'unrelated_app_data', labels: {} }, // unrelated — must NOT be matched
        ]),
        runTargetMigration,
        runStagingVerify,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe('DRY_RUN');
    expect(result.matchedContainers).toEqual(['coreerp-postgres-dev', 'coreerp-postgres-staging']);
    expect(result.matchedVolumes).toEqual([
      'coreerp_postgres_dev_data',
      'coreerp_postgres_staging_data',
    ]);
    expect(result.removedContainers).toEqual([]);
    expect(result.removedVolumes).toEqual([]);
    expect(runDockerCommand).not.toHaveBeenCalled();
    expect(runTargetMigration).not.toHaveBeenCalled();
    expect(runStagingVerify).not.toHaveBeenCalled();
    // Dry-run must NOT create .env files in an empty directory
    expect(fs.existsSync(path.join(projectRoot, '.env'))).toBe(false);
    expect(logs.join('\n')).toContain('DRY-RUN COMPLETE');
    expect(logs.join('\n')).toContain('USER_SYNC_ONLY');
  });

  it('4. Rejects --execute without explicit --confirm-coreerp-local-reset, NODE_ENV=production, prod target, and remote DATABASE_URL', async () => {
    const projectRoot = createTempDir();
    const { logger } = createSilentLogger();
    const runDockerCommand = vi.fn();

    // Missing confirmation flag
    const noConfirm = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: false,
      env: { NODE_ENV: 'development' },
      logger,
      deps: { runDockerCommand },
    });
    expect(noConfirm.exitCode).toBe(1);
    expect(noConfirm.error).toContain(REQUIRED_CONFIRMATION_FLAG);

    // Production NODE_ENV
    const prodEnv = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'production' },
      logger,
      deps: { runDockerCommand },
    });
    expect(prodEnv.exitCode).toBe(1);
    expect(prodEnv.error).toContain('NODE_ENV=production');

    // Prohibited prod target
    const prodTarget = parseCleanResetTargets(['dev', 'prod']);
    expect(prodTarget.valid).toBe(false);
    const prodTargetRun = await runCoreErpCleanReset({
      projectRoot,
      targets: ['production'],
      execute: true,
      confirmed: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: { runDockerCommand },
    });
    expect(prodTargetRun.exitCode).toBe(1);
    expect(prodTargetRun.error).toContain('Production target');

    // Remote DATABASE_URL
    const remoteDb = await runCoreErpCleanReset({
      projectRoot,
      execute: true,
      confirmed: true,
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://erp_user:secret@cloud-sql.example.com:5432/core_erp',
      },
      logger,
      deps: { runDockerCommand },
    });
    expect(remoteDb.exitCode).toBe(1);
    expect(remoteDb.error).toContain('remote host');
    expect(runDockerCommand).not.toHaveBeenCalled();
  });

  it('5. Full clean-reset simulation: removes ONLY CoreERP local resources, preserves unrelated & biometric bridge files, recreates all 5 DBs, applies migrations in order, and verifies staging', async () => {
    const projectRoot = createTempDir();
    const otherWorkspace = createTempDir('foreign-project-');

    // Simulate preserved repository files (source, git, and eSSL X2008 biometric bridge config in USER_SYNC_ONLY mode)
    const bridgeDir = path.join(projectRoot, 'bridges', 'essl-x2008-bridge');
    fs.mkdirSync(bridgeDir, { recursive: true });
    const bridgeConfigPath = path.join(bridgeDir, '.env.bridge');
    const originalBridgeConfig = 'BRIDGE_MODE=USER_SYNC_ONLY\nDEVICE_IP=192.168.1.201\n';
    fs.writeFileSync(bridgeConfigPath, originalBridgeConfig, 'utf-8');

    const dockerInvocations: string[][] = [];
    const runDockerCommand = vi.fn().mockImplementation(async (args: string[]) => {
      dockerInvocations.push(args);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });

    const mockVolumes: DockerVolumeMetadata[] = [
      {
        name: 'coreerp_postgres_dev_data',
        labels: {
          'com.docker.compose.volume': 'postgres_dev_data',
          'com.docker.compose.project.working_dir': projectRoot,
        },
      },
      {
        name: 'coreerp_postgres_test_data',
        labels: {
          'com.docker.compose.volume': 'postgres_test_data',
          'com.docker.compose.project.working_dir': projectRoot,
        },
      },
      {
        name: 'coreerp_postgres_integration_test_data',
        labels: {
          'com.docker.compose.volume': 'postgres_integration_test_data',
          'com.docker.compose.project.working_dir': projectRoot,
        },
      },
      {
        name: 'coreerp_postgres_staging_data',
        labels: {
          'com.docker.compose.volume': 'postgres_staging_data',
          'com.docker.compose.project.working_dir': projectRoot,
        },
      },
      {
        name: 'coreerp_postgres_shadow_data',
        labels: {
          'com.docker.compose.volume': 'postgres_shadow_data',
          'com.docker.compose.project.working_dir': projectRoot,
        },
      },
      // Must NEVER be deleted:
      { name: 'coreerp_postgres_data', labels: {} },
      { name: 'coreerp_storage', labels: {} },
      { name: 'unrelated_analytics_pgdata', labels: {} },
      {
        name: 'foreign_postgres_dev_data',
        labels: {
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
        listDockerContainers: vi.fn().mockResolvedValue([
          'coreerp-postgres-dev',
          'coreerp-postgres-test',
          'coreerp-postgres-integration-test',
          'coreerp-postgres-staging',
          'coreerp-postgres-shadow',
          'coreerp-postgres', // production — untouched
          'coreerp-app', // production — untouched
          'other-service-postgres', // unrelated — untouched
        ]),
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

    // Strictly ONLY the 5 CoreERP local containers and 5 local volumes removed
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
    expect(res.skippedForeignVolumes).toEqual(['foreign_postgres_dev_data']);

    // Verify NO global prune, NO production container/volume removal, NO unrelated deletion
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
      expect(joined).not.toContain('foreign_postgres_dev_data');
    }

    // All 3 fresh env files created cleanly from empty state
    expect(fs.existsSync(path.join(projectRoot, '.env'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.env.staging'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.env.integration-test'))).toBe(true);

    // All 5 local CoreERP containers recreated and waited for pg_isready
    expect(res.recreatedTargets).toEqual(['dev', 'test', 'shadow', 'integration', 'staging']);
    expect(readyContainers).toEqual([
      'coreerp-postgres-dev',
      'coreerp-postgres-test',
      'coreerp-postgres-shadow',
      'coreerp-postgres-integration-test',
      'coreerp-postgres-staging',
    ]);

    // Migrations applied strictly to dev, test, integration, staging (shadow intentionally left empty for Prisma)
    expect(migratedOrder).toEqual(['dev', 'test', 'integration', 'staging']);
    expect(res.migratedTargets).toEqual(['dev', 'test', 'integration', 'staging']);

    // Full staging verification executed after staging creation + migration
    expect(runStagingVerify).toHaveBeenCalledTimes(1);
    expect(res.stagingVerified).toBe(true);

    // Biometric bridge config & USER_SYNC_ONLY mode completely preserved
    expect(fs.readFileSync(bridgeConfigPath, 'utf-8')).toBe(originalBridgeConfig);

    // Zero secrets leaked into logs
    const stagingContent = fs.readFileSync(path.join(projectRoot, '.env.staging'), 'utf-8');
    const passMatch = stagingContent.match(/STAGING_POSTGRES_PASSWORD="([^"]+)"/);
    expect(passMatch).not.toBeNull();
    expect(logs.join('\n')).not.toContain(passMatch![1]);
  });

  it('6. Clean fresh-install from a completely empty CoreERP Docker host succeeds without errors and --recreate-env backs up existing .env files before regenerating', async () => {
    const projectRoot = createTempDir();
    fs.writeFileSync(path.join(projectRoot, '.env'), 'DATABASE_URL="postgresql://erp_user:old_pass@localhost:5432/core_erp"\n', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.env.staging'), 'STAGING_POSTGRES_PASSWORD="old_staging_pass"\n', 'utf-8');

    const { logger } = createSilentLogger();
    const res = await runCoreErpCleanReset({
      projectRoot,
      targets: ['dev', 'staging'],
      execute: true,
      confirmed: true,
      recreateEnv: true,
      env: { NODE_ENV: 'development' },
      logger,
      deps: {
        runDockerCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
        listDockerContainers: vi.fn().mockResolvedValue([]), // completely empty Docker host
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

    expect(res.exitCode).toBe(0);
    expect(res.removedContainers).toEqual([]);
    expect(res.removedVolumes).toEqual([]);
    expect(res.backedUpEnvFiles).toHaveLength(2);
    expect(res.backedUpEnvFiles.some((f) => f.startsWith('.env.backup.'))).toBe(true);
    expect(res.backedUpEnvFiles.some((f) => f.startsWith('.env.staging.backup.'))).toBe(true);
    for (const backup of res.backedUpEnvFiles) {
      expect(fs.existsSync(path.join(projectRoot, backup))).toBe(true);
    }
    expect(res.recreatedTargets).toEqual(['dev', 'staging']);
    expect(res.migratedTargets).toEqual(['dev', 'staging']);
    expect(res.stagingVerified).toBe(true);
  });

  it('7. Normal startup, install, and setup scripts NEVER automatically invoke clean-reset or Docker deletion', () => {
    const pkgPath = path.resolve(import.meta.dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    expect(pkg.scripts['db:clean-reset']).toBe('tsx scripts/clean-reset-db.ts');
    expect(pkg.scripts['db:clean-reset:dry-run']).toBe('tsx scripts/clean-reset-db.ts');

    const ordinaryLifecycleScripts = [
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
    ];
    for (const scriptName of ordinaryLifecycleScripts) {
      const cmd = String(pkg.scripts[scriptName] || '');
      expect(cmd).not.toContain('clean-reset');
      expect(cmd).not.toContain('docker');
      expect(cmd).not.toContain('prune');
    }
  });

  it('8. CLI subprocess safety: scripts/clean-reset-db.ts refuses --execute without confirmation flag with exit code 1', () => {
    const tsxPath = path.resolve(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs');
    const scriptPath = path.resolve(import.meta.dirname, '../../scripts/clean-reset-db.ts');
    const emptyDir = createTempDir();

    const childEnv: Record<string, string | undefined> = { ...process.env };
    delete childEnv.DATABASE_URL;
    delete childEnv.VITEST;
    childEnv.NODE_ENV = 'development';

    const res = spawnSync(process.execPath, [tsxPath, scriptPath, '--execute'], {
      cwd: emptyDir,
      env: childEnv,
      encoding: 'utf-8',
    });

    expect(res.status).toBe(1);
    const output = `${res.stdout}\n${res.stderr}`;
    expect(output).toContain('CONFIRMATION REQUIRED');
    expect(output).toContain(REQUIRED_CONFIRMATION_FLAG);
    // Must not auto-create any .env files when rejected
    expect(fs.existsSync(path.join(emptyDir, '.env'))).toBe(false);
  });
});
