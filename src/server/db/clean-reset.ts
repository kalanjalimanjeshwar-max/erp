import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  COREERP_DB_ENVIRONMENTS,
  normalizeDatabaseUrl,
} from './staging-safety.js';
import {
  parseEnvFileContent,
  runDatabaseEnvironmentSetup,
  type DatabaseSetupResult,
} from './setup-env.js';
import {
  runIsolatedTargetMigration,
  type IsolatedMigrationResult,
  type IsolatedMigratorDeps,
} from './isolated-migrator.js';
import {
  redactSensitiveText,
  runStagingVerification,
  type CommandExecutionResult,
  type StagingVerificationRunResult,
  type StagingVerifierDeps,
} from './staging-verifier.js';

export type CleanResetTarget = 'dev' | 'test' | 'integration' | 'staging' | 'shadow';

export const ALLOWED_LOCAL_RESET_TARGETS: readonly CleanResetTarget[] = [
  'dev',
  'test',
  'integration',
  'staging',
  'shadow',
] as const;

export const REQUIRED_CONFIRMATION_FLAG = '--confirm-coreerp-local-reset';

export interface TargetResourceSpec {
  target: CleanResetTarget;
  envKey: keyof typeof COREERP_DB_ENVIRONMENTS;
  container: string;
  volume: string;
  composeFile: string;
  service: string;
  profile?: string;
  envFile?: string;
  database: string;
  defaultUser: string;
  port: number;
  applyMigrations: boolean;
}

export const COREERP_LOCAL_RESET_SPECS: Readonly<Record<CleanResetTarget, TargetResourceSpec>> = {
  dev: {
    target: 'dev',
    envKey: 'development',
    container: COREERP_DB_ENVIRONMENTS.development.container,
    volume: COREERP_DB_ENVIRONMENTS.development.volume,
    composeFile: COREERP_DB_ENVIRONMENTS.development.composeFile,
    service: COREERP_DB_ENVIRONMENTS.development.service,
    database: COREERP_DB_ENVIRONMENTS.development.database,
    defaultUser: COREERP_DB_ENVIRONMENTS.development.user,
    port: COREERP_DB_ENVIRONMENTS.development.port,
    applyMigrations: true,
  },
  test: {
    target: 'test',
    envKey: 'automatedTest',
    container: COREERP_DB_ENVIRONMENTS.automatedTest.container,
    volume: COREERP_DB_ENVIRONMENTS.automatedTest.volume,
    composeFile: COREERP_DB_ENVIRONMENTS.automatedTest.composeFile,
    service: COREERP_DB_ENVIRONMENTS.automatedTest.service,
    database: COREERP_DB_ENVIRONMENTS.automatedTest.database,
    defaultUser: COREERP_DB_ENVIRONMENTS.automatedTest.user,
    port: COREERP_DB_ENVIRONMENTS.automatedTest.port,
    applyMigrations: true,
  },
  integration: {
    target: 'integration',
    envKey: 'integrationTest',
    container: COREERP_DB_ENVIRONMENTS.integrationTest.container,
    volume: COREERP_DB_ENVIRONMENTS.integrationTest.volume,
    composeFile: COREERP_DB_ENVIRONMENTS.integrationTest.composeFile,
    service: COREERP_DB_ENVIRONMENTS.integrationTest.service,
    envFile: '.env.integration-test',
    database: COREERP_DB_ENVIRONMENTS.integrationTest.database,
    defaultUser: COREERP_DB_ENVIRONMENTS.integrationTest.user,
    port: COREERP_DB_ENVIRONMENTS.integrationTest.port,
    applyMigrations: true,
  },
  staging: {
    target: 'staging',
    envKey: 'staging',
    container: COREERP_DB_ENVIRONMENTS.staging.container,
    volume: COREERP_DB_ENVIRONMENTS.staging.volume,
    composeFile: COREERP_DB_ENVIRONMENTS.staging.composeFile,
    service: COREERP_DB_ENVIRONMENTS.staging.service,
    envFile: '.env.staging',
    database: COREERP_DB_ENVIRONMENTS.staging.database,
    defaultUser: COREERP_DB_ENVIRONMENTS.staging.user,
    port: COREERP_DB_ENVIRONMENTS.staging.port,
    applyMigrations: true,
  },
  shadow: {
    target: 'shadow',
    envKey: 'shadow',
    container: COREERP_DB_ENVIRONMENTS.shadow.container,
    volume: COREERP_DB_ENVIRONMENTS.shadow.volume,
    composeFile: COREERP_DB_ENVIRONMENTS.shadow.composeFile,
    service: COREERP_DB_ENVIRONMENTS.shadow.service,
    profile: 'shadow',
    database: COREERP_DB_ENVIRONMENTS.shadow.database,
    defaultUser: COREERP_DB_ENVIRONMENTS.shadow.user,
    port: COREERP_DB_ENVIRONMENTS.shadow.port,
    // Prisma manages core_erp_shadow internally during `prisma migrate dev`; do not deploy schema migrations to shadow.
    applyMigrations: false,
  },
};

export const ALLOWED_LOCAL_CONTAINERS: ReadonlySet<string> = new Set(
  Object.values(COREERP_LOCAL_RESET_SPECS).map((s) => s.container)
);

export const ALLOWED_LOCAL_VOLUME_SUFFIXES: ReadonlySet<string> = new Set(
  Object.values(COREERP_LOCAL_RESET_SPECS).map((s) => s.volume)
);

// Explicit production resource blocklist (defense-in-depth; NEVER removable by local clean-reset)
export const PROHIBITED_PRODUCTION_CONTAINERS: ReadonlySet<string> = new Set([
  'coreerp-postgres',
  'coreerp-app',
  'coreerp-migration',
]);

export const PROHIBITED_PRODUCTION_VOLUMES: ReadonlySet<string> = new Set([
  'postgres_data',
  'coreerp_storage',
]);

export interface DockerVolumeMetadata {
  name: string;
  labels: Record<string, string>;
}

export interface CleanResetLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface CleanResetDeps {
  runDockerCommand?: (
    args: string[],
    cwd: string,
    timeoutMs?: number
  ) => Promise<CommandExecutionResult>;
  listDockerContainers?: (cwd: string) => Promise<string[]>;
  listDockerVolumes?: (cwd: string) => Promise<DockerVolumeMetadata[]>;
  waitForPostgresReady?: (params: {
    container: string;
    user: string;
    database: string;
    cwd: string;
    timeoutMs?: number;
  }) => Promise<boolean>;
  runSetupEnv?: (options: {
    projectRoot: string;
    checkOnly?: boolean;
    logger: CleanResetLogger;
    inspectDockerVolumes: () => Promise<string[] | null>;
  }) => Promise<DatabaseSetupResult>;
  runTargetMigration?: (options: {
    target: CleanResetTarget;
    execute: boolean;
    env: Record<string, string | undefined>;
    logger: CleanResetLogger;
    deps?: IsolatedMigratorDeps;
  }) => Promise<IsolatedMigrationResult>;
  runStagingVerify?: (options: {
    execute: boolean;
    env: Record<string, string | undefined>;
    logger: CleanResetLogger;
    deps?: StagingVerifierDeps;
  }) => Promise<StagingVerificationRunResult>;
  sleep?: (ms: number) => Promise<void>;
}

export interface CleanResetOptions {
  projectRoot?: string;
  targets?: string[];
  execute: boolean;
  confirmed: boolean;
  recreateEnv?: boolean;
  verifyStaging?: boolean;
  env?: Record<string, string | undefined>;
  logger?: CleanResetLogger;
  deps?: CleanResetDeps;
  readinessTimeoutMs?: number;
}

export interface CleanResetResult {
  exitCode: 0 | 1;
  mode: 'DRY_RUN' | 'EXECUTE';
  targets: CleanResetTarget[];
  matchedContainers: string[];
  matchedVolumes: string[];
  skippedForeignVolumes: string[];
  removedContainers: string[];
  removedVolumes: string[];
  backedUpEnvFiles: string[];
  recreatedTargets: CleanResetTarget[];
  migratedTargets: CleanResetTarget[];
  stagingVerified: boolean;
  error?: string;
}

/**
 * Hard safety guard preventing global Docker cleanup commands, image deletion,
 * or compose-wide volume destruction from EVER being invoked.
 */
export function assertNeverGlobalDockerPrune(args: readonly string[]): void {
  const lowered = args.map((a) => a.toLowerCase());
  const joined = lowered.join(' ');

  if (lowered.includes('prune')) {
    throw new Error(
      `[DOCKER SAFETY VIOLATION] Global Docker prune commands are strictly prohibited ("docker ${args.join(' ')}").`
    );
  }
  if (lowered[0] === 'system') {
    throw new Error(
      `[DOCKER SAFETY VIOLATION] Global "docker system" commands are strictly prohibited ("docker ${args.join(' ')}").`
    );
  }
  if (lowered[0] === 'rmi' || lowered[0] === 'image' || lowered[0] === 'images') {
    throw new Error(
      `[DOCKER SAFETY VIOLATION] Docker image deletion/mutation commands are prohibited during clean-reset ("docker ${args.join(' ')}").`
    );
  }
  if (lowered.includes('down') && (lowered.includes('-v') || lowered.includes('--volumes'))) {
    throw new Error(
      `[DOCKER SAFETY VIOLATION] Compose-wide "down -v/--volumes" is prohibited; remove only explicitly allowlisted CoreERP volumes individually.`
    );
  }
  if (joined.includes('rm -rf') || joined.includes('--all')) {
    throw new Error(
      `[DOCKER SAFETY VIOLATION] Broad "--all" Docker deletion flags are strictly prohibited.`
    );
  }
}

/**
 * Verifies a container name is strictly one of the five local CoreERP PostgreSQL containers
 * and NEVER a production or unrelated container.
 */
export function assertSafeCoreErpContainerName(
  containerName: string,
  allowedContainers: ReadonlySet<string> = ALLOWED_LOCAL_CONTAINERS
): void {
  const normalized = containerName.trim();
  if (PROHIBITED_PRODUCTION_CONTAINERS.has(normalized)) {
    throw new Error(
      `[DOCKER SAFETY VIOLATION] Refusing to touch protected production container "${normalized}".`
    );
  }
  if (!ALLOWED_LOCAL_CONTAINERS.has(normalized) || !allowedContainers.has(normalized)) {
    throw new Error(
      `[DOCKER SAFETY VIOLATION] Refusing to touch non-allowlisted or unrelated container "${normalized}".`
    );
  }
}

function normalizePathForCompare(rawPath: string): string {
  const resolved = path.resolve(rawPath).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Determines whether a Docker volume strictly belongs to the selected local CoreERP targets
 * in THIS project directory.
 * - Rejects production volumes (`postgres_data`, `*_postgres_data`, `coreerp_storage`, `*_coreerp_storage`).
 * - Rejects unrelated volumes.
 * - If Docker Compose attached a `com.docker.compose.project.working_dir` label belonging to a
 *   different workspace directory, treats it as a foreign project's volume and refuses to delete it.
 */
export function classifyCoreErpLocalVolume(params: {
  volume: DockerVolumeMetadata;
  allowedVolumeNames: ReadonlySet<string>;
  projectRoot: string;
}): 'ALLOW' | 'FOREIGN_PROJECT' | 'REJECT' {
  const name = params.volume.name.trim();
  if (!name) return 'REJECT';

  // Unconditionally protect production volumes (exact or compose-prefixed)
  for (const prodVol of PROHIBITED_PRODUCTION_VOLUMES) {
    if (name === prodVol || name.endsWith(`_${prodVol}`)) {
      return 'REJECT';
    }
  }

  // Must match one of the canonical CoreERP local volume names (exact or `<project>_<canonical>`)
  let matchedCanonical: string | null = null;
  for (const allowed of params.allowedVolumeNames) {
    if (!ALLOWED_LOCAL_VOLUME_SUFFIXES.has(allowed)) continue;
    if (name === allowed || name.endsWith(`_${allowed}`)) {
      matchedCanonical = allowed;
      break;
    }
  }
  if (!matchedCanonical) {
    return 'REJECT';
  }

  // If Compose recorded a volume label, verify it agrees with the canonical volume name
  const composeVolLabel = params.volume.labels['com.docker.compose.volume'];
  if (composeVolLabel && composeVolLabel !== matchedCanonical) {
    return 'REJECT';
  }

  // If Compose recorded a project working_dir label, verify it belongs to THIS workspace
  const workingDirLabel = params.volume.labels['com.docker.compose.project.working_dir'];
  if (workingDirLabel && workingDirLabel.trim() !== '') {
    if (normalizePathForCompare(workingDirLabel) !== normalizePathForCompare(params.projectRoot)) {
      return 'FOREIGN_PROJECT';
    }
  }

  return 'ALLOW';
}

/**
 * Parses and validates requested clean-reset targets. Unconditionally rejects `prod` / `production`.
 */
export function parseCleanResetTargets(
  rawTargets?: readonly string[]
): { valid: true; targets: CleanResetTarget[] } | { valid: false; error: string } {
  if (!rawTargets || rawTargets.length === 0) {
    return { valid: true, targets: [...ALLOWED_LOCAL_RESET_TARGETS] };
  }

  const parsed: CleanResetTarget[] = [];
  const seen = new Set<CleanResetTarget>();

  for (const raw of rawTargets) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;

    if (normalized === 'prod' || normalized === 'production') {
      return {
        valid: false,
        error:
          'Production target ("prod"/"production") is strictly prohibited in db:clean-reset. Clean reset applies ONLY to local CoreERP dev, test, integration, staging, and shadow Docker databases.',
      };
    }

    if (!(ALLOWED_LOCAL_RESET_TARGETS as readonly string[]).includes(normalized)) {
      return {
        valid: false,
        error: `Unknown clean-reset target "${raw}". Approved local targets: ${ALLOWED_LOCAL_RESET_TARGETS.join(', ')}.`,
      };
    }

    const typed = normalized as CleanResetTarget;
    if (!seen.has(typed)) {
      seen.add(typed);
      parsed.push(typed);
    }
  }

  if (parsed.length === 0) {
    return { valid: true, targets: [...ALLOWED_LOCAL_RESET_TARGETS] };
  }

  return { valid: true, targets: parsed };
}

async function defaultRunDockerCommand(
  args: string[],
  cwd: string,
  timeoutMs = 120_000
): Promise<CommandExecutionResult> {
  assertNeverGlobalDockerPrune(args);
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
          return;
        }
        const numericCode =
          typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? Number((error as { code?: unknown }).code)
            : 1;
        resolve({
          exitCode: numericCode === 0 ? 1 : numericCode,
          stdout: String(stdout || ''),
          stderr: String(stderr || error.message || ''),
        });
      }
    );
  });
}

async function defaultListDockerContainers(
  cwd: string,
  runDocker: (args: string[], cwd: string, timeoutMs?: number) => Promise<CommandExecutionResult>
): Promise<string[]> {
  const res = await runDocker(['ps', '-a', '--format', '{{.Names}}'], cwd, 10_000);
  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to inspect Docker containers (is Docker daemon running?): ${(res.stderr || res.stdout).trim()}`
    );
  }
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function defaultListDockerVolumes(
  cwd: string,
  runDocker: (args: string[], cwd: string, timeoutMs?: number) => Promise<CommandExecutionResult>
): Promise<DockerVolumeMetadata[]> {
  const res = await runDocker(['volume', 'ls', '--format', '{{.Name}}'], cwd, 10_000);
  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to inspect Docker volumes (is Docker daemon running?): ${(res.stderr || res.stdout).trim()}`
    );
  }
  const names = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (names.length === 0) return [];

  // Only inspect candidate volumes that match one of the canonical local CoreERP suffixes
  const candidateNames = names.filter((n) => {
    for (const prod of PROHIBITED_PRODUCTION_VOLUMES) {
      if (n === prod || n.endsWith(`_${prod}`)) return false;
    }
    for (const allowed of ALLOWED_LOCAL_VOLUME_SUFFIXES) {
      if (n === allowed || n.endsWith(`_${allowed}`)) return true;
    }
    return false;
  });

  const labelMap = new Map<string, Record<string, string>>();
  if (candidateNames.length > 0) {
    const inspectRes = await runDocker(['volume', 'inspect', ...candidateNames], cwd, 10_000);
    if (inspectRes.exitCode === 0 && inspectRes.stdout.trim()) {
      try {
        const parsed = JSON.parse(inspectRes.stdout) as Array<{
          Name?: string;
          Labels?: Record<string, string> | null;
        }>;
        for (const item of parsed) {
          if (item.Name) {
            labelMap.set(item.Name, item.Labels ?? {});
          }
        }
      } catch {
        // Best-effort label parsing
      }
    }
  }

  return names.map((name) => ({
    name,
    labels: labelMap.get(name) ?? {},
  }));
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultWaitForPostgresReady(
  params: {
    container: string;
    user: string;
    database: string;
    cwd: string;
    timeoutMs?: number;
  },
  runDocker: (args: string[], cwd: string, timeoutMs?: number) => Promise<CommandExecutionResult>,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  assertSafeCoreErpContainerName(params.container);
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const res = await runDocker(
      ['exec', params.container, 'pg_isready', '-U', params.user, '-d', params.database],
      params.cwd,
      5_000
    );
    if (res.exitCode === 0) {
      return true;
    }
    await sleep(1_000);
  }
  return false;
}

function readLocalEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return parseEnvFileContent(fs.readFileSync(filePath, 'utf-8'));
}

function collectSecrets(envMaps: Array<Record<string, string | undefined>>): string[] {
  const secrets = new Set<string>();
  const keys = [
    'DATABASE_URL',
    'STAGING_DATABASE_URL',
    'TEST_DATABASE_URL',
    'SHADOW_DATABASE_URL',
    'POSTGRES_PASSWORD',
    'STAGING_POSTGRES_PASSWORD',
    'SHADOW_POSTGRES_PASSWORD',
    'SESSION_SECRET',
    'BANK_ENCRYPTION_KEY',
    'BIOMETRIC_BRIDGE_TOKEN',
  ];
  for (const map of envMaps) {
    for (const k of keys) {
      const val = map[k]?.trim();
      if (!val) continue;
      secrets.add(val);
      try {
        const parsed = new URL(val);
        if (parsed.password) {
          secrets.add(parsed.password);
          const decoded = decodeURIComponent(parsed.password);
          if (decoded) secrets.add(decoded);
        }
      } catch {
        // Not a URL
      }
    }
  }
  return Array.from(secrets);
}

/**
 * Executes CoreERP's explicitly confirmed, strictly scoped local Docker clean-reset
 * and fresh-installation workflow.
 *
 * Guarantees:
 * - Dry-run by default; requires BOTH `execute: true` and `confirmed: true` (`--execute --confirm-coreerp-local-reset`).
 * - Refuses execution when NODE_ENV=production or when DATABASE_URL points to a remote host.
 * - Removes ONLY explicitly allowlisted CoreERP local containers & volumes (never production `coreerp-postgres`/`postgres_data`, never unrelated containers/images/volumes, never `docker system prune`).
 * - Preserves all source code, Git history, `bridges/essl-x2008-bridge`, Windows biometric bridge data, and `USER_SYNC_ONLY` mode.
 * - Recreates CoreERP PostgreSQL containers cleanly, waits for readiness, applies all versioned migrations in exact chronological order, and verifies staging when included.
 */
export async function runCoreErpCleanReset(
  options: CleanResetOptions
): Promise<CleanResetResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const verifyStaging = options.verifyStaging ?? true;
  const recreateEnv = options.recreateEnv ?? false;
  const logger: CleanResetLogger = options.logger ?? {
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };

  const rawRunDocker = options.deps?.runDockerCommand ?? defaultRunDockerCommand;
  const runDocker = async (
    args: string[],
    cwd: string,
    timeoutMs?: number
  ): Promise<CommandExecutionResult> => {
    assertNeverGlobalDockerPrune(args);
    return rawRunDocker(args, cwd, timeoutMs);
  };
  const sleep = options.deps?.sleep ?? defaultSleep;
  const listContainers =
    options.deps?.listDockerContainers ?? ((cwd) => defaultListDockerContainers(cwd, runDocker));
  const listVolumes =
    options.deps?.listDockerVolumes ?? ((cwd) => defaultListDockerVolumes(cwd, runDocker));
  const waitForReady =
    options.deps?.waitForPostgresReady ??
    ((params) => defaultWaitForPostgresReady(params, runDocker, sleep));
  const runSetupEnv =
    options.deps?.runSetupEnv ??
    ((opts) =>
      runDatabaseEnvironmentSetup({
        projectRoot: opts.projectRoot,
        checkOnly: opts.checkOnly,
        logger: opts.logger,
        inspectDockerVolumes: opts.inspectDockerVolumes,
      }));
  const runTargetMigration =
    options.deps?.runTargetMigration ??
    ((opts) =>
      runIsolatedTargetMigration({
        target: opts.target,
        execute: opts.execute,
        env: opts.env,
        logger: opts.logger,
        deps: opts.deps,
      }));
  const runStagingVerify =
    options.deps?.runStagingVerify ??
    ((opts) =>
      runStagingVerification({
        execute: opts.execute,
        env: opts.env,
        logger: opts.logger,
        deps: opts.deps,
      }));

  const targetParse = parseCleanResetTargets(options.targets);
  if (targetParse.valid === false) {
    logger.error(`\n❌ [CLEAN RESET SAFETY REJECTED]: ${targetParse.error}\n`);
    return {
      exitCode: 1,
      mode: options.execute ? 'EXECUTE' : 'DRY_RUN',
      targets: [],
      matchedContainers: [],
      matchedVolumes: [],
      skippedForeignVolumes: [],
      removedContainers: [],
      removedVolumes: [],
      backedUpEnvFiles: [],
      recreatedTargets: [],
      migratedTargets: [],
      stagingVerified: false,
      error: targetParse.error,
    };
  }
  const targets = targetParse.targets;
  const specs = targets.map((t) => COREERP_LOCAL_RESET_SPECS[t]);

  // Safety Check 1: Never run in production environment
  if ((env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    const err =
      'Refusing clean-reset: NODE_ENV=production is active. Clean reset is strictly restricted to local non-production Docker environments.';
    logger.error(`\n❌ [CLEAN RESET SAFETY REJECTED]: ${err}\n`);
    return {
      exitCode: 1,
      mode: options.execute ? 'EXECUTE' : 'DRY_RUN',
      targets,
      matchedContainers: [],
      matchedVolumes: [],
      skippedForeignVolumes: [],
      removedContainers: [],
      removedVolumes: [],
      backedUpEnvFiles: [],
      recreatedTargets: [],
      migratedTargets: [],
      stagingVerified: false,
      error: err,
    };
  }

  // Safety Check 2: Refuse if local .env or shell DATABASE_URL targets a non-localhost / remote database
  const existingMainEnv = readLocalEnvFile(path.join(projectRoot, '.env'));
  const existingStagingEnv = readLocalEnvFile(path.join(projectRoot, '.env.staging'));
  const existingIntEnv = readLocalEnvFile(path.join(projectRoot, '.env.integration-test'));
  const redact = (text: string) =>
    redactSensitiveText(
      text,
      collectSecrets([env, existingMainEnv, existingStagingEnv, existingIntEnv])
    );

  const candidatePrimaryUrl = env.DATABASE_URL?.trim() || existingMainEnv.DATABASE_URL?.trim();
  if (candidatePrimaryUrl) {
    const ep = normalizeDatabaseUrl(candidatePrimaryUrl);
    if (ep && ep.hostname !== '127.0.0.1') {
      const err = `Refusing clean-reset: DATABASE_URL points to remote host "${ep.hostname}" instead of localhost/127.0.0.1. Clean reset is strictly restricted to local Docker environments.`;
      logger.error(`\n❌ [CLEAN RESET SAFETY REJECTED]: ${err}\n`);
      return {
        exitCode: 1,
        mode: options.execute ? 'EXECUTE' : 'DRY_RUN',
        targets,
        matchedContainers: [],
        matchedVolumes: [],
        skippedForeignVolumes: [],
        removedContainers: [],
        removedVolumes: [],
        backedUpEnvFiles: [],
        recreatedTargets: [],
        migratedTargets: [],
        stagingVerified: false,
        error: err,
      };
    }
  }

  // Safety Check 3: Explicit double-confirmation gate if --execute was requested
  if (options.execute && !options.confirmed) {
    const err = `Refusing destructive clean-reset without explicit confirmation flag (${REQUIRED_CONFIRMATION_FLAG}). Run without --execute to preview safely, or pass both --execute and ${REQUIRED_CONFIRMATION_FLAG}.`;
    logger.error(`\n❌ [CONFIRMATION REQUIRED]: ${err}\n`);
    return {
      exitCode: 1,
      mode: 'EXECUTE',
      targets,
      matchedContainers: [],
      matchedVolumes: [],
      skippedForeignVolumes: [],
      removedContainers: [],
      removedVolumes: [],
      backedUpEnvFiles: [],
      recreatedTargets: [],
      migratedTargets: [],
      stagingVerified: false,
      error: err,
    };
  }

  logger.log('\n================================================================');
  logger.log(
    options.execute
      ? '   CoreERP Scoped Local Docker Clean-Reset & Fresh Install'
      : '   CoreERP Scoped Local Docker Clean-Reset (DRY-RUN PREVIEW)'
  );
  logger.log('================================================================\n');

  const allowedContainerSet = new Set(specs.map((s) => s.container));
  const allowedVolumeSet = new Set(specs.map((s) => s.volume));

  // Stage 1: Read-only discovery of ONLY allowlisted CoreERP local Docker resources
  let existingContainers: string[] = [];
  let existingVolumes: DockerVolumeMetadata[] = [];
  try {
    [existingContainers, existingVolumes] = await Promise.all([
      listContainers(projectRoot),
      listVolumes(projectRoot),
    ]);
  } catch (err: unknown) {
    const msg = redact(err instanceof Error ? err.message : String(err));
    logger.error(`\n❌ [DOCKER INSPECTION FAILED]: ${msg}\n`);
    return {
      exitCode: 1,
      mode: options.execute ? 'EXECUTE' : 'DRY_RUN',
      targets,
      matchedContainers: [],
      matchedVolumes: [],
      skippedForeignVolumes: [],
      removedContainers: [],
      removedVolumes: [],
      backedUpEnvFiles: [],
      recreatedTargets: [],
      migratedTargets: [],
      stagingVerified: false,
      error: msg,
    };
  }

  const matchedContainers = existingContainers.filter(
    (name) =>
      allowedContainerSet.has(name) &&
      ALLOWED_LOCAL_CONTAINERS.has(name) &&
      !PROHIBITED_PRODUCTION_CONTAINERS.has(name)
  );

  const matchedVolumes: string[] = [];
  const skippedForeignVolumes: string[] = [];
  for (const vol of existingVolumes) {
    const decision = classifyCoreErpLocalVolume({
      volume: vol,
      allowedVolumeNames: allowedVolumeSet,
      projectRoot,
    });
    if (decision === 'ALLOW') {
      matchedVolumes.push(vol.name);
    } else if (decision === 'FOREIGN_PROJECT') {
      skippedForeignVolumes.push(vol.name);
    }
  }

  logger.log(`1. Scoped CoreERP Local Targets: ${targets.join(', ')}`);
  logger.log(
    `   - Matching CoreERP Containers (${matchedContainers.length}): ${matchedContainers.length > 0 ? matchedContainers.join(', ') : '(none currently exist)'}`
  );
  logger.log(
    `   - Matching CoreERP Volumes (${matchedVolumes.length}): ${matchedVolumes.length > 0 ? matchedVolumes.join(', ') : '(none currently exist)'}`
  );
  if (skippedForeignVolumes.length > 0) {
    logger.warn(
      `   ⚠️  Skipped ${skippedForeignVolumes.length} volume(s) belonging to a different Compose workspace: ${skippedForeignVolumes.join(', ')}`
    );
  }
  logger.log('   - Strictly Preserved (NEVER touched):');
  logger.log('     • All source code, Git history, and local biometric bridge files (bridges/essl-x2008-bridge, USER_SYNC_ONLY)');
  logger.log('     • Production containers/volumes (coreerp-postgres, coreerp-app, postgres_data, coreerp_storage)');
  logger.log('     • All unrelated Docker containers, images, networks, and volumes');

  if (!options.execute) {
    logger.log('\n----------------------------------------------------------------');
    logger.log('DRY-RUN COMPLETE: No Docker resources, files, or databases were modified.');
    logger.log(`To execute this scoped local clean-reset, run:`);
    logger.log(`  npm run db:clean-reset -- --execute ${REQUIRED_CONFIRMATION_FLAG}`);
    logger.log('----------------------------------------------------------------\n');
    return {
      exitCode: 0,
      mode: 'DRY_RUN',
      targets,
      matchedContainers,
      matchedVolumes,
      skippedForeignVolumes,
      removedContainers: [],
      removedVolumes: [],
      backedUpEnvFiles: [],
      recreatedTargets: [],
      migratedTargets: [],
      stagingVerified: false,
    };
  }

  // Stage 2: Remove ONLY allowlisted CoreERP local containers & volumes
  const removedContainers: string[] = [];
  const removedVolumes: string[] = [];

  for (const container of matchedContainers) {
    assertSafeCoreErpContainerName(container, allowedContainerSet);
    const rmRes = await runDocker(['rm', '-f', container], projectRoot, 30_000);
    if (rmRes.exitCode !== 0) {
      const msg = redact(
        `Failed to remove CoreERP container "${container}": ${(rmRes.stderr || rmRes.stdout).trim()}`
      );
      logger.error(`\n❌ ${msg}\n`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        targets,
        matchedContainers,
        matchedVolumes,
        skippedForeignVolumes,
        removedContainers,
        removedVolumes,
        backedUpEnvFiles: [],
        recreatedTargets: [],
        migratedTargets: [],
        stagingVerified: false,
        error: msg,
      };
    }
    removedContainers.push(container);
    logger.log(`   ✔ Removed CoreERP local container: ${container}`);
  }

  for (const volName of matchedVolumes) {
    const volMeta = existingVolumes.find((v) => v.name === volName);
    if (
      !volMeta ||
      classifyCoreErpLocalVolume({
        volume: volMeta,
        allowedVolumeNames: allowedVolumeSet,
        projectRoot,
      }) !== 'ALLOW'
    ) {
      throw new Error(`[DOCKER SAFETY VIOLATION] Refusing to delete unverified volume "${volName}".`);
    }
    const rmVolRes = await runDocker(['volume', 'rm', volName], projectRoot, 30_000);
    if (rmVolRes.exitCode !== 0) {
      const msg = redact(
        `Failed to remove CoreERP volume "${volName}": ${(rmVolRes.stderr || rmVolRes.stdout).trim()}`
      );
      logger.error(`\n❌ ${msg}\n`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        targets,
        matchedContainers,
        matchedVolumes,
        skippedForeignVolumes,
        removedContainers,
        removedVolumes,
        backedUpEnvFiles: [],
        recreatedTargets: [],
        migratedTargets: [],
        stagingVerified: false,
        error: msg,
      };
    }
    removedVolumes.push(volName);
    logger.log(`   ✔ Removed CoreERP local volume: ${volName}`);
  }

  // Stage 3: Ensure clean, consistent .env / .env.staging / .env.integration-test
  const backedUpEnvFiles: string[] = [];
  if (recreateEnv) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const relFile of ['.env', '.env.staging', '.env.integration-test']) {
      const fullPath = path.join(projectRoot, relFile);
      if (fs.existsSync(fullPath)) {
        const backupPath = `${fullPath}.backup.${stamp}`;
        fs.renameSync(fullPath, backupPath);
        backedUpEnvFiles.push(path.basename(backupPath));
        logger.log(`   ✔ Backed up existing ${relFile} -> ${path.basename(backupPath)}`);
      }
    }
  }

  const setupRes = await runSetupEnv({
    projectRoot,
    checkOnly: false,
    logger,
    inspectDockerVolumes: async () => [],
  });
  if (setupRes.exitCode !== 0) {
    const msg = redact(
      `Database environment setup/audit failed after cleanup: ${setupRes.issues.join(' | ')}`
    );
    logger.error(`\n❌ ${msg}\n`);
    return {
      exitCode: 1,
      mode: 'EXECUTE',
      targets,
      matchedContainers,
      matchedVolumes,
      skippedForeignVolumes,
      removedContainers,
      removedVolumes,
      backedUpEnvFiles,
      recreatedTargets: [],
      migratedTargets: [],
      stagingVerified: false,
      error: msg,
    };
  }

  // Reload fresh environment files for container startup and isolated migrations
  const freshMainEnv = readLocalEnvFile(path.join(projectRoot, '.env'));
  const freshStagingEnv = readLocalEnvFile(path.join(projectRoot, '.env.staging'));
  const freshIntEnv = readLocalEnvFile(path.join(projectRoot, '.env.integration-test'));
  const redactFresh = (text: string) =>
    redactSensitiveText(
      text,
      collectSecrets([env, freshMainEnv, freshStagingEnv, freshIntEnv])
    );

  // Stage 4: Recreate CoreERP local PostgreSQL containers cleanly via isolated Compose commands
  const recreatedTargets: CleanResetTarget[] = [];

  const devBaseServices: CleanResetTarget[] = targets.filter((t) => t === 'dev' || t === 'test');
  if (devBaseServices.length > 0) {
    const serviceNames = devBaseServices.map((t) => COREERP_LOCAL_RESET_SPECS[t].service);
    const upRes = await runDocker(
      ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d', ...serviceNames],
      projectRoot,
      120_000
    );
    if (upRes.exitCode !== 0) {
      const msg = redactFresh(
        `Failed to start docker-compose.dev.yml (${serviceNames.join(', ')}): ${(upRes.stderr || upRes.stdout).trim()}`
      );
      logger.error(`\n❌ ${msg}\n`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        targets,
        matchedContainers,
        matchedVolumes,
        skippedForeignVolumes,
        removedContainers,
        removedVolumes,
        backedUpEnvFiles,
        recreatedTargets,
        migratedTargets: [],
        stagingVerified: false,
        error: msg,
      };
    }
    recreatedTargets.push(...devBaseServices);
  }

  if (targets.includes('shadow')) {
    const upShadow = await runDocker(
      ['compose', '-f', 'docker-compose.dev.yml', '--profile', 'shadow', 'up', '-d', 'postgres-shadow'],
      projectRoot,
      120_000
    );
    if (upShadow.exitCode !== 0) {
      const msg = redactFresh(
        `Failed to start postgres-shadow: ${(upShadow.stderr || upShadow.stdout).trim()}`
      );
      logger.error(`\n❌ ${msg}\n`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        targets,
        matchedContainers,
        matchedVolumes,
        skippedForeignVolumes,
        removedContainers,
        removedVolumes,
        backedUpEnvFiles,
        recreatedTargets,
        migratedTargets: [],
        stagingVerified: false,
        error: msg,
      };
    }
    recreatedTargets.push('shadow');
  }

  if (targets.includes('integration')) {
    const upInt = await runDocker(
      ['compose', '--env-file', '.env.integration-test', '-f', 'docker-compose.integration-test.yml', 'up', '-d'],
      projectRoot,
      120_000
    );
    if (upInt.exitCode !== 0) {
      const msg = redactFresh(
        `Failed to start docker-compose.integration-test.yml: ${(upInt.stderr || upInt.stdout).trim()}`
      );
      logger.error(`\n❌ ${msg}\n`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        targets,
        matchedContainers,
        matchedVolumes,
        skippedForeignVolumes,
        removedContainers,
        removedVolumes,
        backedUpEnvFiles,
        recreatedTargets,
        migratedTargets: [],
        stagingVerified: false,
        error: msg,
      };
    }
    recreatedTargets.push('integration');
  }

  if (targets.includes('staging')) {
    const upStaging = await runDocker(
      ['compose', '--env-file', '.env.staging', '-f', 'docker-compose.staging.yml', 'up', '-d'],
      projectRoot,
      120_000
    );
    if (upStaging.exitCode !== 0) {
      const msg = redactFresh(
        `Failed to start docker-compose.staging.yml: ${(upStaging.stderr || upStaging.stdout).trim()}`
      );
      logger.error(`\n❌ ${msg}\n`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        targets,
        matchedContainers,
        matchedVolumes,
        skippedForeignVolumes,
        removedContainers,
        removedVolumes,
        backedUpEnvFiles,
        recreatedTargets,
        migratedTargets: [],
        stagingVerified: false,
        error: msg,
      };
    }
    recreatedTargets.push('staging');
  }

  // Stage 5: Wait for each recreated container to accept PostgreSQL connections
  for (const target of recreatedTargets) {
    const spec = COREERP_LOCAL_RESET_SPECS[target];
    const resolvedUser =
      target === 'dev'
        ? freshMainEnv.POSTGRES_USER || spec.defaultUser
        : target === 'staging'
          ? freshStagingEnv.STAGING_POSTGRES_USER || spec.defaultUser
          : target === 'shadow'
            ? freshMainEnv.SHADOW_POSTGRES_USER || spec.defaultUser
            : spec.defaultUser;
    const resolvedDb =
      target === 'dev'
        ? freshMainEnv.POSTGRES_DB || spec.database
        : target === 'staging'
          ? freshStagingEnv.STAGING_POSTGRES_DB || spec.database
          : target === 'shadow'
            ? freshMainEnv.SHADOW_POSTGRES_DB || spec.database
            : spec.database;

    const ready = await waitForReady({
      container: spec.container,
      user: resolvedUser,
      database: resolvedDb,
      cwd: projectRoot,
      timeoutMs: options.readinessTimeoutMs,
    });
    if (!ready) {
      const msg = `Container "${spec.container}" (${target}) did not become PostgreSQL-ready before timeout.`;
      logger.error(`\n❌ ${msg}\n`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        targets,
        matchedContainers,
        matchedVolumes,
        skippedForeignVolumes,
        removedContainers,
        removedVolumes,
        backedUpEnvFiles,
        recreatedTargets,
        migratedTargets: [],
        stagingVerified: false,
        error: msg,
      };
    }
    logger.log(`   ✔ Container "${spec.container}" is healthy and accepting connections.`);
  }

  // Stage 6: Apply all versioned Prisma migrations in exact order to each migratable target
  const migratedTargets: CleanResetTarget[] = [];
  const mergedEnvForMigrations: Record<string, string | undefined> = {
    ...env,
    DATABASE_URL: freshMainEnv.DATABASE_URL,
    TEST_DATABASE_URL: freshIntEnv.TEST_DATABASE_URL,
    STAGING_DATABASE_URL: freshStagingEnv.STAGING_DATABASE_URL,
    STAGING_POSTGRES_USER: freshStagingEnv.STAGING_POSTGRES_USER,
    STAGING_POSTGRES_PASSWORD: freshStagingEnv.STAGING_POSTGRES_PASSWORD,
    STAGING_POSTGRES_DB: freshStagingEnv.STAGING_POSTGRES_DB,
    SHADOW_DATABASE_URL: freshMainEnv.SHADOW_DATABASE_URL,
  };

  for (const target of recreatedTargets) {
    const spec = COREERP_LOCAL_RESET_SPECS[target];
    if (!spec.applyMigrations) {
      logger.log(
        `   ℹ Skipping schema migration for "${target}" (${spec.database}): Prisma manages the shadow database automatically.`
      );
      continue;
    }

    const migRes = await runTargetMigration({
      target,
      execute: true,
      env: mergedEnvForMigrations,
      logger,
    });
    if (migRes.exitCode !== 0) {
      const msg = redactFresh(
        `Migration failed for target "${target}": ${migRes.error || `exit code ${migRes.exitCode}`}`
      );
      logger.error(`\n❌ ${msg}\n`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        targets,
        matchedContainers,
        matchedVolumes,
        skippedForeignVolumes,
        removedContainers,
        removedVolumes,
        backedUpEnvFiles,
        recreatedTargets,
        migratedTargets,
        stagingVerified: false,
        error: msg,
      };
    }
    migratedTargets.push(target);
  }

  // Stage 7: Full staging verification when staging was recreated and verification is enabled
  let stagingVerified = false;
  if (verifyStaging && recreatedTargets.includes('staging')) {
    const verifyRes = await runStagingVerify({
      execute: true,
      env: mergedEnvForMigrations,
      logger,
    });
    if (verifyRes.exitCode !== 0) {
      const msg = redactFresh(
        `Post-reset staging verification failed: ${verifyRes.error || `exit code ${verifyRes.exitCode}`}`
      );
      logger.error(`\n❌ ${msg}\n`);
      return {
        exitCode: 1,
        mode: 'EXECUTE',
        targets,
        matchedContainers,
        matchedVolumes,
        skippedForeignVolumes,
        removedContainers,
        removedVolumes,
        backedUpEnvFiles,
        recreatedTargets,
        migratedTargets,
        stagingVerified: false,
        error: msg,
      };
    }
    stagingVerified = true;
  }

  logger.log('\n✅ CoreERP scoped local Docker clean-reset and fresh installation COMPLETED.\n');
  return {
    exitCode: 0,
    mode: 'EXECUTE',
    targets,
    matchedContainers,
    matchedVolumes,
    skippedForeignVolumes,
    removedContainers,
    removedVolumes,
    backedUpEnvFiles,
    recreatedTargets,
    migratedTargets,
    stagingVerified,
  };
}
