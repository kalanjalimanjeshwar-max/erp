import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  COREERP_DB_ENVIRONMENTS,
  areDatabaseEndpointsEqual,
  normalizeDatabaseUrl,
  sanitizeDatabaseUrl,
  validateStagingDatabaseUrl,
  type NormalizedDatabaseEndpoint,
} from './staging-safety.js';
import {
  buildPostgresConnectionUrl,
  generateSecureSecret,
  isPlaceholderOrWeak,
  parseEnvFileContent,
  renderIntegrationEnvFile,
  renderMainDevEnvFile,
  renderStagingEnvFile,
  writeEnvFileAtomically,
  type DatabaseSetupResult,
} from './setup-env.js';
import {
  DEFAULT_UNIT_TEST_DATABASE_URL,
  resolveAndValidateTargetUrl,
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

export interface DockerContainerMetadata {
  name: string;
  labels: Record<string, string>;
}

export interface DockerVolumeMetadata {
  name: string;
  labels: Record<string, string>;
}

export interface CleanResetLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface PlannedEnvFileAction {
  file: '.env' | '.env.staging' | '.env.integration-test';
  action: 'PRESERVE' | 'CREATE' | 'BACKUP_AND_RECREATE';
  content?: string;
}

export interface CleanResetPlan {
  targets: CleanResetTarget[];
  containersToRemove: string[];
  volumesToRemove: string[];
  envActions: Array<{
    file: '.env' | '.env.staging' | '.env.integration-test';
    action: 'PRESERVE' | 'CREATE' | 'BACKUP_AND_RECREATE';
  }>;
  recreateTargets: CleanResetTarget[];
  migrationTargets: CleanResetTarget[];
  willVerifyStaging: boolean;
}

export interface CleanResetDeps {
  runDockerCommand?: (
    args: string[],
    cwd: string,
    timeoutMs?: number
  ) => Promise<CommandExecutionResult>;
  listDockerContainers?: (cwd: string) => Promise<Array<string | DockerContainerMetadata>>;
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
  generateSecret?: (bytes?: number) => string;
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
  completedSteps: string[];
  plan?: CleanResetPlan;
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
 * Computes Docker Compose's normalized default project name for a workspace directory.
 */
export function deriveExpectedComposeProjectName(
  projectRoot: string,
  composeProjectNameEnv?: string
): string {
  const raw = (composeProjectNameEnv?.trim() || path.basename(path.resolve(projectRoot))).toLowerCase();
  return raw.replace(/[^a-z0-9_-]/g, '');
}

function parseComposeConfigFilesLabel(rawConfigFiles: string | undefined): string[] {
  if (!rawConfigFiles || rawConfigFiles.trim() === '') return [];
  return rawConfigFiles
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(normalizePathForCompare);
}

/**
 * Verifies strict Docker Compose project, service, and working-directory/config-file ownership
 * for a candidate CoreERP local container. Never approves deletion based on matching name alone.
 */
export function verifyCoreErpContainerOwnership(params: {
  container: DockerContainerMetadata;
  spec: TargetResourceSpec;
  projectRoot: string;
}): { verified: true; composeProject: string } | { verified: false; reason: string } {
  const { container, spec, projectRoot } = params;
  const name = container.name.trim();

  if (PROHIBITED_PRODUCTION_CONTAINERS.has(name) || name !== spec.container) {
    return {
      verified: false,
      reason: `Container "${name}" is not the allowlisted container "${spec.container}".`,
    };
  }

  const labels = container.labels || {};
  const composeProject = labels['com.docker.compose.project']?.trim();
  const composeService = labels['com.docker.compose.service']?.trim();
  const workingDir = labels['com.docker.compose.project.working_dir']?.trim();
  const configFiles = parseComposeConfigFilesLabel(labels['com.docker.compose.project.config_files']);

  if (!composeProject) {
    return {
      verified: false,
      reason: `Container "${name}" is missing required "com.docker.compose.project" ownership label. Refusing name-only deletion.`,
    };
  }

  if (composeService !== spec.service) {
    return {
      verified: false,
      reason: `Container "${name}" service label "${composeService || '(missing)'}" does not match expected CoreERP service "${spec.service}".`,
    };
  }

  if (!workingDir && configFiles.length === 0) {
    return {
      verified: false,
      reason: `Container "${name}" is missing both "com.docker.compose.project.working_dir" and "com.docker.compose.project.config_files" labels. Refusing unverified deletion.`,
    };
  }

  const expectedRoot = normalizePathForCompare(projectRoot);
  if (workingDir && normalizePathForCompare(workingDir) !== expectedRoot) {
    return {
      verified: false,
      reason: `Container "${name}" belongs to a different Compose working directory ("${workingDir}" !== "${projectRoot}").`,
    };
  }

  const expectedComposeFile = normalizePathForCompare(path.join(projectRoot, spec.composeFile));
  if (configFiles.length > 0 && !configFiles.includes(expectedComposeFile)) {
    return {
      verified: false,
      reason: `Container "${name}" config_files label does not reference "${spec.composeFile}" in this workspace.`,
    };
  }

  return { verified: true, composeProject };
}

/**
 * Classifies and verifies ownership of a Docker named volume against the selected local CoreERP targets
 * in THIS workspace. Never approves deletion based on matching name alone without Compose ownership labels.
 */
export function classifyCoreErpLocalVolume(params: {
  volume: DockerVolumeMetadata;
  allowedVolumeNames: ReadonlySet<string>;
  projectRoot: string;
  expectedComposeProject?: string;
  verifiedComposeProjects?: ReadonlySet<string>;
}): 'ALLOW' | 'FOREIGN_PROJECT' | 'UNVERIFIED_OWNERSHIP' | 'REJECT' {
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

  const labels = params.volume.labels || {};
  const composeProject = labels['com.docker.compose.project']?.trim();
  const composeVolLabel = labels['com.docker.compose.volume']?.trim();
  const workingDirLabel = labels['com.docker.compose.project.working_dir']?.trim();
  const configFiles = parseComposeConfigFilesLabel(labels['com.docker.compose.project.config_files']);

  // Fail closed: require explicit Docker Compose project & volume labels (never delete by name alone)
  if (!composeProject || !composeVolLabel) {
    return 'UNVERIFIED_OWNERSHIP';
  }

  if (composeVolLabel !== matchedCanonical) {
    return 'UNVERIFIED_OWNERSHIP';
  }

  // Find matching spec to verify compose config file when present
  const spec = Object.values(COREERP_LOCAL_RESET_SPECS).find((s) => s.volume === matchedCanonical);
  const expectedRoot = normalizePathForCompare(params.projectRoot);

  if (workingDirLabel) {
    if (normalizePathForCompare(workingDirLabel) !== expectedRoot) {
      return 'FOREIGN_PROJECT';
    }
  }

  if (configFiles.length > 0 && spec) {
    const expectedComposeFile = normalizePathForCompare(path.join(params.projectRoot, spec.composeFile));
    if (!configFiles.includes(expectedComposeFile)) {
      return 'FOREIGN_PROJECT';
    }
  }

  // If neither working_dir nor config_files was stored on the volume (standard Docker Compose v2 behavior
  // for named volumes), verify the Compose project label matches either a verified workspace container's
  // Compose project or this workspace's derived Compose project name.
  if (!workingDirLabel && configFiles.length === 0) {
    const expectedProject =
      params.expectedComposeProject ?? deriveExpectedComposeProjectName(params.projectRoot);
    const matchesVerifiedContainerProject =
      params.verifiedComposeProjects?.has(composeProject) ?? false;
    const matchesWorkspaceProject =
      expectedProject !== '' && composeProject.toLowerCase() === expectedProject.toLowerCase();

    if (!matchesVerifiedContainerProject && !matchesWorkspaceProject) {
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
): Promise<DockerContainerMetadata[]> {
  const res = await runDocker(['ps', '-a', '--format', '{{.Names}}'], cwd, 10_000);
  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to inspect Docker containers (is Docker daemon running?): ${(res.stderr || res.stdout).trim()}`
    );
  }
  const names = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (names.length === 0) return [];

  const candidateNames = names.filter(
    (n) => ALLOWED_LOCAL_CONTAINERS.has(n) && !PROHIBITED_PRODUCTION_CONTAINERS.has(n)
  );

  const labelMap = new Map<string, Record<string, string>>();
  if (candidateNames.length > 0) {
    const inspectRes = await runDocker(['inspect', ...candidateNames], cwd, 10_000);
    if (inspectRes.exitCode === 0 && inspectRes.stdout.trim()) {
      try {
        const parsed = JSON.parse(inspectRes.stdout) as Array<{
          Name?: string;
          Config?: { Labels?: Record<string, string> | null };
        }>;
        for (const item of parsed) {
          const cleanName = (item.Name || '').replace(/^\/+/, '');
          if (cleanName) {
            labelMap.set(cleanName, item.Config?.Labels ?? {});
          }
        }
      } catch {
        // Leave labels empty -> fail-closed in ownership verification
      }
    }
  }

  return names.map((name) => ({
    name,
    labels: labelMap.get(name) ?? {},
  }));
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
        // Leave labels empty -> fail-closed in ownership verification
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

function readEnvFileOrNull(filePath: string): Record<string, string> | null {
  if (!fs.existsSync(filePath)) return null;
  return parseEnvFileContent(fs.readFileSync(filePath, 'utf-8'));
}

function collectSecrets(envMaps: Array<Record<string, string | undefined> | null>): string[] {
  const secrets = new Set<string>();
  const keys = [
    'DATABASE_URL',
    'UNIT_TEST_DATABASE_URL',
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
    if (!map) continue;
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

interface InMemoryEnvironmentBundle {
  mainEnv: Record<string, string>;
  stagingEnv: Record<string, string>;
  integrationEnv: Record<string, string>;
  plannedFileActions: PlannedEnvFileAction[];
}

/**
 * STAGE 4 helper: Prepares all five database environments strictly in memory without creating,
 * renaming, or modifying any files on disk.
 */
function prepareEnvironmentsInMemory(params: {
  existingMainEnv: Record<string, string> | null;
  existingStagingEnv: Record<string, string> | null;
  existingIntegrationEnv: Record<string, string> | null;
  recreateEnv: boolean;
  generateSecret: (bytes?: number) => string;
}): InMemoryEnvironmentBundle {
  const { existingMainEnv, existingStagingEnv, existingIntegrationEnv, recreateEnv, generateSecret } =
    params;

  const plannedFileActions: PlannedEnvFileAction[] = [];

  // 1. Staging environment (.env.staging)
  let stagingEnv: Record<string, string>;
  if (existingStagingEnv && !recreateEnv) {
    stagingEnv = { ...existingStagingEnv };
    plannedFileActions.push({ file: '.env.staging', action: 'PRESERVE' });
  } else {
    const user = COREERP_DB_ENVIRONMENTS.staging.user;
    const password = generateSecret(32);
    const database = COREERP_DB_ENVIRONMENTS.staging.database;
    const stagingUrl = buildPostgresConnectionUrl({
      user,
      password,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.staging.port,
      database,
    });
    const content = renderStagingEnvFile({ user, password, database, stagingUrl });
    stagingEnv = parseEnvFileContent(content);
    plannedFileActions.push({
      file: '.env.staging',
      action: existingStagingEnv ? 'BACKUP_AND_RECREATE' : 'CREATE',
      content,
    });
  }

  // 2. Integration test environment (.env.integration-test)
  let integrationEnv: Record<string, string>;
  if (existingIntegrationEnv && !recreateEnv) {
    integrationEnv = { ...existingIntegrationEnv };
    plannedFileActions.push({ file: '.env.integration-test', action: 'PRESERVE' });
  } else {
    const password = generateSecret(32);
    const testUrl = buildPostgresConnectionUrl({
      user: COREERP_DB_ENVIRONMENTS.integrationTest.user,
      password,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.integrationTest.port,
      database: COREERP_DB_ENVIRONMENTS.integrationTest.database,
    });
    const content = renderIntegrationEnvFile({ password, testUrl });
    integrationEnv = parseEnvFileContent(content);
    plannedFileActions.push({
      file: '.env.integration-test',
      action: existingIntegrationEnv ? 'BACKUP_AND_RECREATE' : 'CREATE',
      content,
    });
  }

  // 3. Main development + shadow + staging ref (.env)
  let mainEnv: Record<string, string>;
  if (existingMainEnv && !recreateEnv) {
    mainEnv = { ...existingMainEnv };
    plannedFileActions.push({ file: '.env', action: 'PRESERVE' });
  } else {
    const devUser = COREERP_DB_ENVIRONMENTS.development.user;
    const devPassword = 'erp_password_dev';
    const devDatabase = COREERP_DB_ENVIRONMENTS.development.database;
    const devUrl = buildPostgresConnectionUrl({
      user: devUser,
      password: devPassword,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.development.port,
      database: devDatabase,
    });

    const shadowUser = COREERP_DB_ENVIRONMENTS.shadow.user;
    const shadowPassword = generateSecret(32);
    const shadowDatabase = COREERP_DB_ENVIRONMENTS.shadow.database;
    const shadowUrl = buildPostgresConnectionUrl({
      user: shadowUser,
      password: shadowPassword,
      host: 'localhost',
      port: COREERP_DB_ENVIRONMENTS.shadow.port,
      database: shadowDatabase,
    });

    const content = renderMainDevEnvFile({
      devUser,
      devPassword,
      devDatabase,
      devUrl,
      shadowUser,
      shadowPassword,
      shadowDatabase,
      shadowUrl,
      stagingUrl: stagingEnv.STAGING_DATABASE_URL || '',
      sessionSecret: generateSecret(32),
      bankEncryptionKey: generateSecret(32),
      biometricBridgeToken: generateSecret(24),
    });
    mainEnv = parseEnvFileContent(content);
    plannedFileActions.push({
      file: '.env',
      action: existingMainEnv ? 'BACKUP_AND_RECREATE' : 'CREATE',
      content,
    });
  }

  return { mainEnv, stagingEnv, integrationEnv, plannedFileActions };
}

function parseUrlCredentialsSafe(
  urlStr: string
): { username: string; password: string } | null {
  try {
    const parsed = new URL(urlStr);
    return {
      username: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || ''),
    };
  } catch {
    return null;
  }
}

interface ValidatedFiveEnvironments {
  issues: string[];
  resolvedUrls: Partial<Record<CleanResetTarget, string>>;
  resolvedEndpoints: Partial<Record<CleanResetTarget, NormalizedDatabaseEndpoint>>;
}

/**
 * STAGE 5 helper: Validates ALL FIVE database targets (dev, test, integration, staging, shadow),
 * shell override safety, credential consistency, local endpoint confinement, and cross-target uniqueness.
 */
export function validateAllFiveEnvironmentsPreflight(params: {
  shellEnv: Record<string, string | undefined>;
  mainEnv: Record<string, string>;
  stagingEnv: Record<string, string>;
  integrationEnv: Record<string, string>;
  recreateEnv: boolean;
}): ValidatedFiveEnvironments {
  const { shellEnv, mainEnv, stagingEnv, integrationEnv, recreateEnv } = params;
  const issues: string[] = [];
  const resolvedUrls: Partial<Record<CleanResetTarget, string>> = {};
  const resolvedEndpoints: Partial<Record<CleanResetTarget, NormalizedDatabaseEndpoint>> = {};

  // Helper to verify shell URLs cannot silently override validated local targets with remote/wrong endpoints
  const checkShellUrlOverride = (
    varName: string,
    shellVal: string | undefined,
    fileVal: string | undefined,
    expectedPort: number,
    expectedDb: string
  ): void => {
    const trimmed = shellVal?.trim();
    if (!trimmed) return;

    const ep = normalizeDatabaseUrl(trimmed);
    if (!ep) {
      issues.push(`Shell ${varName} is malformed or unparseable.`);
      return;
    }
    if (ep.hostname !== '127.0.0.1') {
      issues.push(
        `Shell ${varName} points to remote host "${ep.hostname}". Local Docker clean-reset strictly requires localhost/127.0.0.1.`
      );
      return;
    }
    if (ep.port !== expectedPort || ep.database !== expectedDb) {
      issues.push(
        `Shell ${varName} targets ${ep.hostname}:${ep.port}/${ep.database}, but expected localhost:${expectedPort}/${expectedDb}.`
      );
      return;
    }
    if (!recreateEnv && fileVal?.trim()) {
      const fileEp = normalizeDatabaseUrl(fileVal.trim());
      const shellCreds = parseUrlCredentialsSafe(trimmed);
      const fileCreds = parseUrlCredentialsSafe(fileVal.trim());
      if (
        fileEp &&
        (!areDatabaseEndpointsEqual(ep, fileEp) ||
          (shellCreds &&
            fileCreds &&
            (shellCreds.username !== fileCreds.username ||
              shellCreds.password !== fileCreds.password)))
      ) {
        issues.push(
          `Shell ${varName} conflicts with the local environment file configuration. Unset conflicting shell overrides or align both.`
        );
      }
    }
  };

  // Check shell overrides for all five targets BEFORE resolving effective target URLs
  checkShellUrlOverride(
    'DATABASE_URL',
    shellEnv.DATABASE_URL,
    mainEnv.DATABASE_URL,
    COREERP_DB_ENVIRONMENTS.development.port,
    COREERP_DB_ENVIRONMENTS.development.database
  );
  checkShellUrlOverride(
    'UNIT_TEST_DATABASE_URL',
    shellEnv.UNIT_TEST_DATABASE_URL,
    undefined,
    COREERP_DB_ENVIRONMENTS.automatedTest.port,
    COREERP_DB_ENVIRONMENTS.automatedTest.database
  );
  checkShellUrlOverride(
    'TEST_DATABASE_URL',
    shellEnv.TEST_DATABASE_URL,
    integrationEnv.TEST_DATABASE_URL,
    COREERP_DB_ENVIRONMENTS.integrationTest.port,
    COREERP_DB_ENVIRONMENTS.integrationTest.database
  );
  checkShellUrlOverride(
    'STAGING_DATABASE_URL',
    shellEnv.STAGING_DATABASE_URL,
    stagingEnv.STAGING_DATABASE_URL,
    COREERP_DB_ENVIRONMENTS.staging.port,
    COREERP_DB_ENVIRONMENTS.staging.database
  );
  checkShellUrlOverride(
    'SHADOW_DATABASE_URL',
    shellEnv.SHADOW_DATABASE_URL,
    mainEnv.SHADOW_DATABASE_URL,
    COREERP_DB_ENVIRONMENTS.shadow.port,
    COREERP_DB_ENVIRONMENTS.shadow.database
  );

  // Resolve effective URLs for all five targets
  const devUrl = mainEnv.DATABASE_URL?.trim() || shellEnv.DATABASE_URL?.trim() || '';
  const unitTestUrl =
    shellEnv.UNIT_TEST_DATABASE_URL?.trim() ||
    mainEnv.UNIT_TEST_DATABASE_URL?.trim() ||
    DEFAULT_UNIT_TEST_DATABASE_URL;
  const integrationUrl =
    integrationEnv.TEST_DATABASE_URL?.trim() || shellEnv.TEST_DATABASE_URL?.trim() || '';
  const stagingUrl =
    stagingEnv.STAGING_DATABASE_URL?.trim() || shellEnv.STAGING_DATABASE_URL?.trim() || '';

  const explicitShadowUrl =
    mainEnv.SHADOW_DATABASE_URL?.trim() || shellEnv.SHADOW_DATABASE_URL?.trim();
  const shadowFallbackUser =
    mainEnv.SHADOW_POSTGRES_USER?.trim() || COREERP_DB_ENVIRONMENTS.shadow.user;
  const shadowFallbackPass =
    mainEnv.SHADOW_POSTGRES_PASSWORD?.trim() || 'erp_shadow_password_dev';
  const shadowFallbackDb =
    mainEnv.SHADOW_POSTGRES_DB?.trim() || COREERP_DB_ENVIRONMENTS.shadow.database;
  const shadowUrl =
    explicitShadowUrl !== undefined && explicitShadowUrl !== ''
      ? explicitShadowUrl
      : buildPostgresConnectionUrl({
          user: shadowFallbackUser,
          password: shadowFallbackPass,
          host: 'localhost',
          port: COREERP_DB_ENVIRONMENTS.shadow.port,
          database: shadowFallbackDb,
        });

  // 1. Validate DEV (port 5432 / core_erp)
  let devPassword = '';
  const devCheck = resolveAndValidateTargetUrl('dev', {
    NODE_ENV: shellEnv.NODE_ENV,
    DATABASE_URL: devUrl,
  });
  if (devCheck.valid === false) {
    issues.push(`Target "dev" validation failed: ${devCheck.error}`);
  } else {
    resolvedUrls.dev = devCheck.url;
    const devEp = normalizeDatabaseUrl(devCheck.url);
    if (devEp) resolvedEndpoints.dev = devEp;
    const creds = parseUrlCredentialsSafe(devCheck.url);
    if (!creds) {
      issues.push('Target "dev" DATABASE_URL credentials could not be parsed.');
    } else {
      devPassword = creds.password;
      if (isPlaceholderOrWeak(creds.password)) {
        issues.push('Target "dev" DATABASE_URL uses an empty or placeholder password.');
      }
      if (mainEnv.POSTGRES_USER?.trim() && creds.username !== mainEnv.POSTGRES_USER.trim()) {
        issues.push('Target "dev" DATABASE_URL username does not match POSTGRES_USER in .env.');
      }
      if (mainEnv.POSTGRES_PASSWORD?.trim() && creds.password !== mainEnv.POSTGRES_PASSWORD.trim()) {
        issues.push(
          'Target "dev" DATABASE_URL password does not match POSTGRES_PASSWORD in .env (would cause P1000).'
        );
      }
      if (
        shellEnv.POSTGRES_PASSWORD?.trim() &&
        !recreateEnv &&
        creds.password !== shellEnv.POSTGRES_PASSWORD.trim()
      ) {
        issues.push('Shell POSTGRES_PASSWORD conflicts with target "dev" DATABASE_URL password.');
      }
      if (
        mainEnv.POSTGRES_DB?.trim() &&
        mainEnv.POSTGRES_DB.trim().toLowerCase() !== COREERP_DB_ENVIRONMENTS.development.database
      ) {
        issues.push(
          `Target "dev" POSTGRES_DB in .env must be "${COREERP_DB_ENVIRONMENTS.development.database}".`
        );
      }
    }
  }

  // 2. Validate TEST (port 5433 / core_erp_test)
  const testCheck = resolveAndValidateTargetUrl('test', {
    UNIT_TEST_DATABASE_URL: unitTestUrl,
  });
  if (testCheck.valid === false) {
    issues.push(`Target "test" validation failed: ${testCheck.error}`);
  } else {
    resolvedUrls.test = testCheck.url;
    const testEp = normalizeDatabaseUrl(testCheck.url);
    if (testEp) resolvedEndpoints.test = testEp;
  }

  // 3. Validate INTEGRATION (port 5434 / core_erp_integration_test)
  let integrationPassword = '';
  const intCheck = resolveAndValidateTargetUrl('integration', {
    TEST_DATABASE_URL: integrationUrl,
  });
  if (intCheck.valid === false) {
    issues.push(`Target "integration" validation failed: ${intCheck.error}`);
  } else {
    resolvedUrls.integration = intCheck.url;
    const intEp = normalizeDatabaseUrl(intCheck.url);
    if (intEp) resolvedEndpoints.integration = intEp;
    const creds = parseUrlCredentialsSafe(intCheck.url);
    const composeIntPass = integrationEnv.POSTGRES_PASSWORD?.trim() || '';
    if (isPlaceholderOrWeak(composeIntPass)) {
      issues.push(
        'Target "integration" .env.integration-test has a missing or placeholder POSTGRES_PASSWORD.'
      );
    }
    if (!creds) {
      issues.push('Target "integration" TEST_DATABASE_URL credentials could not be parsed.');
    } else {
      integrationPassword = creds.password;
      if (creds.username !== COREERP_DB_ENVIRONMENTS.integrationTest.user) {
        issues.push(
          `Target "integration" TEST_DATABASE_URL username must be "${COREERP_DB_ENVIRONMENTS.integrationTest.user}".`
        );
      }
      if (isPlaceholderOrWeak(creds.password)) {
        issues.push('Target "integration" TEST_DATABASE_URL uses an empty or placeholder password.');
      }
      if (composeIntPass && creds.password !== composeIntPass) {
        issues.push(
          'Target "integration" TEST_DATABASE_URL password does not match POSTGRES_PASSWORD in .env.integration-test (would cause P1000).'
        );
      }
    }
  }

  // 4. Validate STAGING (port 5435 / core_erp_staging) — reusing validateStagingDatabaseUrl + strict local host/port check
  let stagingPassword = '';
  const stagingSafety = validateStagingDatabaseUrl(stagingUrl, devUrl || undefined, {
    testDatabaseUrl: integrationUrl || undefined,
    shadowDatabaseUrl: shadowUrl || undefined,
  });
  if (!stagingSafety.valid || !stagingSafety.endpoint || !stagingSafety.url) {
    issues.push(`Target "staging" validation failed: ${stagingSafety.error}`);
  } else if (
    stagingSafety.endpoint.hostname !== '127.0.0.1' ||
    stagingSafety.endpoint.port !== COREERP_DB_ENVIRONMENTS.staging.port ||
    stagingSafety.endpoint.database !== COREERP_DB_ENVIRONMENTS.staging.database
  ) {
    issues.push(
      `Target "staging" must resolve strictly to localhost:${COREERP_DB_ENVIRONMENTS.staging.port}/${COREERP_DB_ENVIRONMENTS.staging.database} for local Docker clean-reset (found ${stagingSafety.endpoint.hostname}:${stagingSafety.endpoint.port}/${stagingSafety.endpoint.database}).`
    );
  } else {
    resolvedUrls.staging = stagingSafety.url;
    resolvedEndpoints.staging = stagingSafety.endpoint;
    const creds = parseUrlCredentialsSafe(stagingSafety.url);
    const sUser = stagingEnv.STAGING_POSTGRES_USER?.trim() || '';
    const sPass = stagingEnv.STAGING_POSTGRES_PASSWORD?.trim() || '';
    const sDb = stagingEnv.STAGING_POSTGRES_DB?.trim() || '';

    if (!sUser) {
      issues.push('Target "staging" .env.staging is missing STAGING_POSTGRES_USER.');
    }
    if (isPlaceholderOrWeak(sPass)) {
      issues.push('Target "staging" .env.staging has a missing or placeholder STAGING_POSTGRES_PASSWORD.');
    }
    if (sDb.toLowerCase() !== COREERP_DB_ENVIRONMENTS.staging.database) {
      issues.push(
        `Target "staging" .env.staging STAGING_POSTGRES_DB must be "${COREERP_DB_ENVIRONMENTS.staging.database}".`
      );
    }
    if (!creds) {
      issues.push('Target "staging" STAGING_DATABASE_URL credentials could not be parsed.');
    } else {
      stagingPassword = creds.password;
      if (isPlaceholderOrWeak(creds.password)) {
        issues.push('Target "staging" STAGING_DATABASE_URL uses an empty or placeholder password.');
      }
      if (sUser && creds.username !== sUser) {
        issues.push(
          'Target "staging" STAGING_DATABASE_URL username does not match STAGING_POSTGRES_USER in .env.staging.'
        );
      }
      if (sPass && creds.password !== sPass) {
        issues.push(
          'Target "staging" STAGING_DATABASE_URL password does not match STAGING_POSTGRES_PASSWORD in .env.staging (would cause P1000).'
        );
      }
      if (
        shellEnv.STAGING_POSTGRES_PASSWORD?.trim() &&
        !recreateEnv &&
        creds.password !== shellEnv.STAGING_POSTGRES_PASSWORD.trim()
      ) {
        issues.push(
          'Shell STAGING_POSTGRES_PASSWORD conflicts with target "staging" STAGING_DATABASE_URL password.'
        );
      }
    }

    // If .env also specifies STAGING_DATABASE_URL, ensure full parity with .env.staging
    if (mainEnv.STAGING_DATABASE_URL?.trim()) {
      const envStagingEp = normalizeDatabaseUrl(mainEnv.STAGING_DATABASE_URL.trim());
      const envStagingCreds = parseUrlCredentialsSafe(mainEnv.STAGING_DATABASE_URL.trim());
      if (
        !envStagingEp ||
        !areDatabaseEndpointsEqual(envStagingEp, stagingSafety.endpoint) ||
        !envStagingCreds ||
        !creds ||
        envStagingCreds.username !== creds.username ||
        envStagingCreds.password !== creds.password
      ) {
        issues.push(
          'Staging configuration mismatch between .env (STAGING_DATABASE_URL) and .env.staging.'
        );
      }
    }
  }

  // 5. Validate SHADOW (port 5436 / core_erp_shadow)
  const shadowEp = normalizeDatabaseUrl(shadowUrl);
  if (!shadowEp) {
    issues.push('Target "shadow" SHADOW_DATABASE_URL is malformed or unparseable.');
  } else if (
    shadowEp.hostname !== '127.0.0.1' ||
    shadowEp.port !== COREERP_DB_ENVIRONMENTS.shadow.port ||
    shadowEp.database !== COREERP_DB_ENVIRONMENTS.shadow.database
  ) {
    issues.push(
      `Target "shadow" SHADOW_DATABASE_URL must resolve strictly to localhost:${COREERP_DB_ENVIRONMENTS.shadow.port}/${COREERP_DB_ENVIRONMENTS.shadow.database} (found ${shadowEp.hostname}:${shadowEp.port}/${shadowEp.database}).`
    );
  } else {
    resolvedUrls.shadow = shadowUrl;
    resolvedEndpoints.shadow = shadowEp;
    const creds = parseUrlCredentialsSafe(shadowUrl);
    if (!creds) {
      issues.push('Target "shadow" SHADOW_DATABASE_URL credentials could not be parsed.');
    } else {
      if (isPlaceholderOrWeak(creds.password)) {
        issues.push('Target "shadow" SHADOW_DATABASE_URL uses an empty or placeholder password.');
      }
      if (
        mainEnv.SHADOW_POSTGRES_USER?.trim() &&
        creds.username !== mainEnv.SHADOW_POSTGRES_USER.trim()
      ) {
        issues.push(
          'Target "shadow" SHADOW_DATABASE_URL username does not match SHADOW_POSTGRES_USER in .env.'
        );
      }
      if (
        mainEnv.SHADOW_POSTGRES_PASSWORD?.trim() &&
        creds.password !== mainEnv.SHADOW_POSTGRES_PASSWORD.trim()
      ) {
        issues.push(
          'Target "shadow" SHADOW_DATABASE_URL password does not match SHADOW_POSTGRES_PASSWORD in .env (would cause P1000).'
        );
      }
      if (
        mainEnv.SHADOW_POSTGRES_DB?.trim() &&
        mainEnv.SHADOW_POSTGRES_DB.trim().toLowerCase() !== COREERP_DB_ENVIRONMENTS.shadow.database
      ) {
        issues.push(
          `Target "shadow" SHADOW_POSTGRES_DB in .env must be "${COREERP_DB_ENVIRONMENTS.shadow.database}".`
        );
      }
    }
  }

  // 6. Cross-environment credential isolation (staging never shares password with dev or integration)
  if (stagingPassword && devPassword && stagingPassword === devPassword) {
    issues.push(
      'Staging password matches development password. Staging must use dedicated isolated credentials.'
    );
  }
  if (stagingPassword && integrationPassword && stagingPassword === integrationPassword) {
    issues.push(
      'Staging password matches integration-test password. Staging must use dedicated isolated credentials.'
    );
  }

  // 7. Cross-target physical endpoint uniqueness across all five environments (including raw parsed URLs)
  const rawCandidateEndpoints: Array<[CleanResetTarget, NormalizedDatabaseEndpoint]> = [];
  const rawPairs: Array<[CleanResetTarget, string]> = [
    ['dev', devUrl],
    ['test', unitTestUrl],
    ['integration', integrationUrl],
    ['staging', stagingUrl],
    ['shadow', shadowUrl],
  ];
  for (const [targetName, rawUrl] of rawPairs) {
    const ep = normalizeDatabaseUrl(rawUrl);
    if (ep) rawCandidateEndpoints.push([targetName, ep]);
  }
  for (let i = 0; i < rawCandidateEndpoints.length; i += 1) {
    for (let j = i + 1; j < rawCandidateEndpoints.length; j += 1) {
      const [targetA, epA] = rawCandidateEndpoints[i];
      const [targetB, epB] = rawCandidateEndpoints[j];
      if (areDatabaseEndpointsEqual(epA, epB)) {
        issues.push(
          `Duplicate database endpoint detected: targets "${targetA}" and "${targetB}" both resolve to ${epA.hostname}:${epA.port}/${epA.database}.`
        );
      }
    }
  }

  return { issues, resolvedUrls, resolvedEndpoints };
}

/**
 * Executes CoreERP's explicitly confirmed, strictly scoped local Docker clean-reset
 * and fresh-installation workflow with complete pre-deletion preflight validation.
 *
 * Strict 8-Stage Execution Order:
 * - STAGE 1: Parse requested targets.
 * - STAGE 2: Validate production protection and explicit confirmation.
 * - STAGE 3: Read existing environment files (read-only).
 * - STAGE 4: Prepare and validate all five database environments in memory.
 * - STAGE 5: Validate every target URL, port, database name, host, credential, and uniqueness.
 * - STAGE 6: Validate Docker container and volume Compose ownership (never delete by name alone).
 * - STAGE 7: Produce a complete sanitized pre-deletion execution plan.
 * - STAGE 8: Only after Stages 1–7 succeed, execute destructive Docker removal, env commit,
 *            container recreation, readiness wait, ordered migrations, and staging verification.
 */
export async function runCoreErpCleanReset(
  options: CleanResetOptions
): Promise<CleanResetResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const verifyStaging = options.verifyStaging ?? true;
  const recreateEnv = options.recreateEnv ?? false;
  const generateSecret = options.deps?.generateSecret ?? generateSecureSecret;
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

  const makeFailure = (
    error: string,
    partial?: Partial<CleanResetResult>
  ): CleanResetResult => ({
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
    completedSteps: [],
    ...partial,
    error,
  });

  // =========================================================================
  // STAGE 1 — Parse requested targets
  // =========================================================================
  const targetParse = parseCleanResetTargets(options.targets);
  if (targetParse.valid === false) {
    logger.error(`\n❌ [STAGE 1 FAILED — TARGET VALIDATION]: ${targetParse.error}\n`);
    return makeFailure(targetParse.error);
  }
  const targets = targetParse.targets;
  const specs = targets.map((t) => COREERP_LOCAL_RESET_SPECS[t]);

  // =========================================================================
  // STAGE 2 — Validate production protection and explicit confirmation
  // =========================================================================
  if ((env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    const err =
      'Refusing clean-reset: NODE_ENV=production is active. Clean reset is strictly restricted to local non-production Docker environments.';
    logger.error(`\n❌ [STAGE 2 FAILED — PRODUCTION PROTECTION]: ${err}\n`);
    return makeFailure(err, { targets });
  }

  if (options.execute && !options.confirmed) {
    const err = `Refusing destructive clean-reset without explicit confirmation flag (${REQUIRED_CONFIRMATION_FLAG}). Run without --execute to preview safely, or pass both --execute and ${REQUIRED_CONFIRMATION_FLAG}.`;
    logger.error(`\n❌ [CONFIRMATION REQUIRED]: ${err}\n`);
    return makeFailure(err, { targets });
  }

  // =========================================================================
  // STAGE 3 — Read existing environment files (strictly read-only)
  // =========================================================================
  const existingMainEnv = readEnvFileOrNull(path.join(projectRoot, '.env'));
  const existingStagingEnv = readEnvFileOrNull(path.join(projectRoot, '.env.staging'));
  const existingIntegrationEnv = readEnvFileOrNull(
    path.join(projectRoot, '.env.integration-test')
  );

  // =========================================================================
  // STAGE 4 — Prepare & validate all five database environments IN MEMORY
  // =========================================================================
  let inMemoryBundle: InMemoryEnvironmentBundle;
  try {
    inMemoryBundle = prepareEnvironmentsInMemory({
      existingMainEnv,
      existingStagingEnv,
      existingIntegrationEnv,
      recreateEnv,
      generateSecret,
    });
  } catch (err: unknown) {
    const safeMsg = redactSensitiveText(
      err instanceof Error ? err.message : String(err),
      collectSecrets([env, existingMainEnv, existingStagingEnv, existingIntegrationEnv])
    );
    logger.error(`\n❌ [STAGE 4 FAILED — IN-MEMORY ENV PREPARATION]: ${safeMsg}\n`);
    return makeFailure(safeMsg, { targets });
  }

  const redact = (text: string) =>
    redactSensitiveText(
      text,
      collectSecrets([
        env,
        existingMainEnv,
        existingStagingEnv,
        existingIntegrationEnv,
        inMemoryBundle.mainEnv,
        inMemoryBundle.stagingEnv,
        inMemoryBundle.integrationEnv,
      ])
    );

  // Verify project directory is writable if any env file needs to be created or backed up
  const needsEnvDiskWrite = inMemoryBundle.plannedFileActions.some(
    (a) => a.action === 'CREATE' || a.action === 'BACKUP_AND_RECREATE'
  );
  if (options.execute && needsEnvDiskWrite) {
    try {
      fs.accessSync(projectRoot, fs.constants.W_OK);
    } catch {
      const err = `Project directory "${projectRoot}" is not writable; cannot safely write validated environment files.`;
      logger.error(`\n❌ [STAGE 4 FAILED — FILESYSTEM CHECK]: ${err}\n`);
      return makeFailure(err, { targets });
    }
  }

  // If caller injected a custom setup validator/hook, run it BEFORE any destructive Docker operation
  if (options.deps?.runSetupEnv) {
    try {
      const preflightSetupRes = await options.deps.runSetupEnv({
        projectRoot,
        checkOnly: true,
        logger,
        inspectDockerVolumes: async () => [],
      });
      if (preflightSetupRes.exitCode !== 0) {
        const msg = redact(
          `Environment setup preflight failed before any deletion: ${preflightSetupRes.issues.join(' | ') || 'exit code 1'}`
        );
        logger.error(`\n❌ [STAGE 4 FAILED — ENV SETUP PREFLIGHT]: ${msg}\n`);
        return makeFailure(msg, { targets });
      }
    } catch (err: unknown) {
      const msg = redact(
        `Environment setup preflight threw before any deletion: ${err instanceof Error ? err.message : String(err)}`
      );
      logger.error(`\n❌ [STAGE 4 FAILED — ENV SETUP PREFLIGHT]: ${msg}\n`);
      return makeFailure(msg, { targets });
    }
  }

  // =========================================================================
  // STAGE 5 — Validate EVERY target URL, port, DB name, host, credential & uniqueness
  // =========================================================================
  const envValidation = validateAllFiveEnvironmentsPreflight({
    shellEnv: env,
    mainEnv: inMemoryBundle.mainEnv,
    stagingEnv: inMemoryBundle.stagingEnv,
    integrationEnv: inMemoryBundle.integrationEnv,
    recreateEnv,
  });

  if (envValidation.issues.length > 0) {
    const safeIssues = envValidation.issues.map(redact);
    const err = `Preflight database validation failed (ZERO Docker resources or files modified): ${safeIssues.join(' | ')}`;
    logger.error(`\n❌ [STAGE 5 FAILED — ENVIRONMENT & TARGET SAFETY VALIDATION]:`);
    for (const issue of safeIssues) {
      logger.error(`   - ${issue}`);
    }
    logger.error('');
    return makeFailure(err, { targets });
  }

  // =========================================================================
  // STAGE 6 — Validate Docker container and volume Compose ownership (read-only)
  // =========================================================================
  let rawContainers: Array<string | DockerContainerMetadata> = [];
  let existingVolumes: DockerVolumeMetadata[] = [];
  try {
    [rawContainers, existingVolumes] = await Promise.all([
      listContainers(projectRoot),
      listVolumes(projectRoot),
    ]);
  } catch (err: unknown) {
    const msg = redact(err instanceof Error ? err.message : String(err));
    logger.error(`\n❌ [STAGE 6 FAILED — DOCKER INSPECTION]: ${msg}\n`);
    return makeFailure(msg, { targets });
  }

  const normalizedContainers: DockerContainerMetadata[] = rawContainers.map((entry) =>
    typeof entry === 'string' ? { name: entry, labels: {} } : entry
  );

  const allowedContainerSet = new Set(specs.map((s) => s.container));
  const allowedVolumeSet = new Set(specs.map((s) => s.volume));

  const matchedContainers: string[] = [];
  const verifiedComposeProjects = new Set<string>();
  const ownershipErrors: string[] = [];

  for (const containerMeta of normalizedContainers) {
    const name = containerMeta.name.trim();
    if (!allowedContainerSet.has(name) || PROHIBITED_PRODUCTION_CONTAINERS.has(name)) {
      continue;
    }
    const spec = specs.find((s) => s.container === name);
    if (!spec) continue;

    const ownership = verifyCoreErpContainerOwnership({
      container: containerMeta,
      spec,
      projectRoot,
    });
    if (ownership.verified === false) {
      ownershipErrors.push(ownership.reason);
    } else {
      matchedContainers.push(name);
      verifiedComposeProjects.add(ownership.composeProject);
    }
  }

  const expectedComposeProject = deriveExpectedComposeProjectName(
    projectRoot,
    env.COMPOSE_PROJECT_NAME
  );

  const matchedVolumes: string[] = [];
  const skippedForeignVolumes: string[] = [];

  for (const vol of existingVolumes) {
    const decision = classifyCoreErpLocalVolume({
      volume: vol,
      allowedVolumeNames: allowedVolumeSet,
      projectRoot,
      expectedComposeProject,
      verifiedComposeProjects,
    });
    if (decision === 'ALLOW') {
      matchedVolumes.push(vol.name);
    } else if (decision === 'FOREIGN_PROJECT') {
      skippedForeignVolumes.push(vol.name);
      const lowerVolName = vol.name.toLowerCase();
      const collidesWithWorkspacePrefix =
        expectedComposeProject !== '' &&
        lowerVolName.startsWith(`${expectedComposeProject.toLowerCase()}_`);
      const collidesWithVerifiedProject = Array.from(verifiedComposeProjects).some((proj) =>
        lowerVolName.startsWith(`${proj.toLowerCase()}_`)
      );
      const isBareCanonicalName = allowedVolumeSet.has(vol.name);

      if (collidesWithWorkspacePrefix || collidesWithVerifiedProject || isBareCanonicalName) {
        ownershipErrors.push(
          `Volume "${vol.name}" matches this workspace's CoreERP volume name but its Docker Compose ownership labels point to a different project or directory.`
        );
      }
    } else if (decision === 'UNVERIFIED_OWNERSHIP') {
      ownershipErrors.push(
        `Volume "${vol.name}" matches a CoreERP volume suffix but lacks verified Docker Compose ownership labels (com.docker.compose.project / com.docker.compose.volume). Refusing name-only deletion.`
      );
    }
  }

  if (ownershipErrors.length > 0) {
    const err = `Docker ownership verification failed (ZERO Docker resources or files modified): ${ownershipErrors.join(' | ')}`;
    logger.error(`\n❌ [STAGE 6 FAILED — DOCKER OWNERSHIP VERIFICATION]:`);
    for (const oe of ownershipErrors) {
      logger.error(`   - ${oe}`);
    }
    logger.error('');
    return makeFailure(err, {
      targets,
      matchedContainers,
      matchedVolumes,
      skippedForeignVolumes,
    });
  }

  // =========================================================================
  // STAGE 7 — Produce complete sanitized pre-deletion execution plan
  // =========================================================================
  const recreateOrder: CleanResetTarget[] = [];
  if (targets.includes('dev')) recreateOrder.push('dev');
  if (targets.includes('test')) recreateOrder.push('test');
  if (targets.includes('shadow')) recreateOrder.push('shadow');
  if (targets.includes('integration')) recreateOrder.push('integration');
  if (targets.includes('staging')) recreateOrder.push('staging');

  const migrationOrder = recreateOrder.filter((t) => COREERP_LOCAL_RESET_SPECS[t].applyMigrations);
  const willVerifyStaging = verifyStaging && recreateOrder.includes('staging');

  const plan: CleanResetPlan = {
    targets,
    containersToRemove: [...matchedContainers],
    volumesToRemove: [...matchedVolumes],
    envActions: inMemoryBundle.plannedFileActions.map(({ file, action }) => ({ file, action })),
    recreateTargets: recreateOrder,
    migrationTargets: migrationOrder,
    willVerifyStaging,
  };

  logger.log('\n================================================================');
  logger.log(
    options.execute
      ? '   CoreERP Scoped Local Docker Clean-Reset & Fresh Install'
      : '   CoreERP Scoped Local Docker Clean-Reset (DRY-RUN PREVIEW)'
  );
  logger.log('================================================================\n');
  logger.log('Preflight Validation (Stages 1–6): PASSED (all 5 local targets & Docker ownership verified)');
  logger.log(`1. Validated Local Endpoints (Sanitized):`);
  logger.log(`   - dev:         ${sanitizeDatabaseUrl(envValidation.resolvedUrls.dev)}`);
  logger.log(`   - test:        ${sanitizeDatabaseUrl(envValidation.resolvedUrls.test)}`);
  logger.log(`   - integration: ${sanitizeDatabaseUrl(envValidation.resolvedUrls.integration)}`);
  logger.log(`   - staging:     ${sanitizeDatabaseUrl(envValidation.resolvedUrls.staging)}`);
  logger.log(`   - shadow:      ${sanitizeDatabaseUrl(envValidation.resolvedUrls.shadow)}`);
  logger.log(`2. Pre-Deletion Execution Plan for Selected Targets (${targets.join(', ')}):`);
  logger.log(
    `   - Verified CoreERP Containers to Remove (${plan.containersToRemove.length}): ${plan.containersToRemove.length > 0 ? plan.containersToRemove.join(', ') : '(none currently exist)'}`
  );
  logger.log(
    `   - Verified CoreERP Volumes to Remove (${plan.volumesToRemove.length}): ${plan.volumesToRemove.length > 0 ? plan.volumesToRemove.join(', ') : '(none currently exist)'}`
  );
  logger.log(
    `   - Environment Files: ${plan.envActions.map((a) => `${a.file}=${a.action}`).join(', ')}`
  );
  logger.log(`   - Containers to Recreate: ${plan.recreateTargets.join(', ')}`);
  logger.log(
    `   - Targets Receiving Ordered Migrations: ${plan.migrationTargets.length > 0 ? plan.migrationTargets.join(', ') : '(none)'}`
  );
  logger.log(`   - Post-Reset Staging Verification: ${plan.willVerifyStaging ? 'YES' : 'NO'}`);
  logger.log('   - Strictly Preserved (NEVER touched):');
  logger.log(
    '     • All source code, Git history, bridges/essl-x2008-bridge/bridge.config.json, bridges/essl-x2008-bridge/data/, and USER_SYNC_ONLY mode'
  );
  logger.log(
    '     • Production containers/volumes (coreerp-postgres, coreerp-app, coreerp-migration, postgres_data, coreerp_storage)'
  );
  logger.log('     • All unrelated Docker containers, images, networks, and volumes');

  if (!options.execute) {
    logger.log('\n----------------------------------------------------------------');
    logger.log('DRY-RUN COMPLETE: No Docker resources, files, or databases were modified.');
    logger.log('To execute this scoped local clean-reset, run:');
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
      completedSteps: ['PREFLIGHT_STAGES_1_TO_7_PASSED'],
      plan,
    };
  }

  // =========================================================================
  // STAGE 8 — Destructive Reset & Fresh Recreation (ONLY after Stages 1–7 passed)
  // =========================================================================
  const completedSteps: string[] = ['PREFLIGHT_STAGES_1_TO_7_PASSED'];
  const removedContainers: string[] = [];
  const removedVolumes: string[] = [];
  const backedUpEnvFiles: string[] = [];
  const recreatedTargets: CleanResetTarget[] = [];
  const migratedTargets: CleanResetTarget[] = [];

  const failAfterDestruction = (rawReason: string): CleanResetResult => {
    const safeReason = redact(rawReason);
    const fullError = `${safeReason} [No automatic rollback was performed; inspect completedSteps for exact state.]`;
    logger.error(`\n❌ [STAGE 8 EXECUTION STOPPED]: ${fullError}\n`);
    return makeFailure(fullError, {
      targets,
      matchedContainers,
      matchedVolumes,
      skippedForeignVolumes,
      removedContainers,
      removedVolumes,
      backedUpEnvFiles,
      recreatedTargets,
      migratedTargets,
      completedSteps,
      plan,
    });
  };

  // 8.1 Remove ONLY verified allowlisted CoreERP local containers
  for (const container of matchedContainers) {
    assertSafeCoreErpContainerName(container, allowedContainerSet);
    const rmRes = await runDocker(['rm', '-f', container], projectRoot, 30_000);
    if (rmRes.exitCode !== 0) {
      return failAfterDestruction(
        `Failed to remove CoreERP container "${container}": ${(rmRes.stderr || rmRes.stdout).trim()}`
      );
    }
    removedContainers.push(container);
    completedSteps.push(`REMOVED_CONTAINER:${container}`);
    logger.log(`   ✔ Removed verified CoreERP local container: ${container}`);
  }

  // 8.2 Remove ONLY verified allowlisted CoreERP local volumes
  for (const volName of matchedVolumes) {
    const volMeta = existingVolumes.find((v) => v.name === volName);
    if (
      !volMeta ||
      classifyCoreErpLocalVolume({
        volume: volMeta,
        allowedVolumeNames: allowedVolumeSet,
        projectRoot,
        expectedComposeProject,
        verifiedComposeProjects,
      }) !== 'ALLOW'
    ) {
      throw new Error(`[DOCKER SAFETY VIOLATION] Refusing to delete unverified volume "${volName}".`);
    }
    const rmVolRes = await runDocker(['volume', 'rm', volName], projectRoot, 30_000);
    if (rmVolRes.exitCode !== 0) {
      return failAfterDestruction(
        `Failed to remove CoreERP volume "${volName}": ${(rmVolRes.stderr || rmVolRes.stdout).trim()}`
      );
    }
    removedVolumes.push(volName);
    completedSteps.push(`REMOVED_VOLUME:${volName}`);
    logger.log(`   ✔ Removed verified CoreERP local volume: ${volName}`);
  }

  // 8.3 Prepare / commit the pre-validated environment files (preserving existing files unless --recreate-env)
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const actionItem of inMemoryBundle.plannedFileActions) {
      const fullPath = path.join(projectRoot, actionItem.file);
      if (actionItem.action === 'PRESERVE') {
        completedSteps.push(`PRESERVED_ENV:${actionItem.file}`);
        continue;
      }
      if (actionItem.action === 'BACKUP_AND_RECREATE' && fs.existsSync(fullPath)) {
        const backupPath = `${fullPath}.backup.${stamp}`;
        fs.renameSync(fullPath, backupPath);
        backedUpEnvFiles.push(path.basename(backupPath));
        completedSteps.push(`BACKED_UP_ENV:${path.basename(backupPath)}`);
        logger.log(`   ✔ Backed up existing ${actionItem.file} -> ${path.basename(backupPath)}`);
      }
      if (actionItem.content !== undefined) {
        writeEnvFileAtomically(fullPath, actionItem.content);
        completedSteps.push(`WRITTEN_ENV:${actionItem.file}`);
        logger.log(`   ✔ Wrote validated ${actionItem.file}`);
      }
    }
  } catch (err: unknown) {
    return failAfterDestruction(
      `Failed writing validated environment files: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 8.4 Recreate selected CoreERP local PostgreSQL containers via isolated Compose commands
  const devBaseServices: CleanResetTarget[] = targets.filter((t) => t === 'dev' || t === 'test');
  if (devBaseServices.length > 0) {
    const serviceNames = devBaseServices.map((t) => COREERP_LOCAL_RESET_SPECS[t].service);
    const upRes = await runDocker(
      ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d', ...serviceNames],
      projectRoot,
      120_000
    );
    if (upRes.exitCode !== 0) {
      return failAfterDestruction(
        `Failed to start docker-compose.dev.yml (${serviceNames.join(', ')}): ${(upRes.stderr || upRes.stdout).trim()}`
      );
    }
    recreatedTargets.push(...devBaseServices);
    for (const t of devBaseServices) completedSteps.push(`RECREATED_TARGET:${t}`);
  }

  if (targets.includes('shadow')) {
    const upShadow = await runDocker(
      ['compose', '-f', 'docker-compose.dev.yml', '--profile', 'shadow', 'up', '-d', 'postgres-shadow'],
      projectRoot,
      120_000
    );
    if (upShadow.exitCode !== 0) {
      return failAfterDestruction(
        `Failed to start postgres-shadow: ${(upShadow.stderr || upShadow.stdout).trim()}`
      );
    }
    recreatedTargets.push('shadow');
    completedSteps.push('RECREATED_TARGET:shadow');
  }

  if (targets.includes('integration')) {
    const upInt = await runDocker(
      ['compose', '--env-file', '.env.integration-test', '-f', 'docker-compose.integration-test.yml', 'up', '-d'],
      projectRoot,
      120_000
    );
    if (upInt.exitCode !== 0) {
      return failAfterDestruction(
        `Failed to start docker-compose.integration-test.yml: ${(upInt.stderr || upInt.stdout).trim()}`
      );
    }
    recreatedTargets.push('integration');
    completedSteps.push('RECREATED_TARGET:integration');
  }

  if (targets.includes('staging')) {
    const upStaging = await runDocker(
      ['compose', '--env-file', '.env.staging', '-f', 'docker-compose.staging.yml', 'up', '-d'],
      projectRoot,
      120_000
    );
    if (upStaging.exitCode !== 0) {
      return failAfterDestruction(
        `Failed to start docker-compose.staging.yml: ${(upStaging.stderr || upStaging.stdout).trim()}`
      );
    }
    recreatedTargets.push('staging');
    completedSteps.push('RECREATED_TARGET:staging');
  }

  // 8.5 Wait for PostgreSQL container readiness
  for (const target of recreatedTargets) {
    const spec = COREERP_LOCAL_RESET_SPECS[target];
    const resolvedUser =
      target === 'dev'
        ? inMemoryBundle.mainEnv.POSTGRES_USER || spec.defaultUser
        : target === 'staging'
          ? inMemoryBundle.stagingEnv.STAGING_POSTGRES_USER || spec.defaultUser
          : target === 'shadow'
            ? inMemoryBundle.mainEnv.SHADOW_POSTGRES_USER || spec.defaultUser
            : spec.defaultUser;
    const resolvedDb =
      target === 'dev'
        ? inMemoryBundle.mainEnv.POSTGRES_DB || spec.database
        : target === 'staging'
          ? inMemoryBundle.stagingEnv.STAGING_POSTGRES_DB || spec.database
          : target === 'shadow'
            ? inMemoryBundle.mainEnv.SHADOW_POSTGRES_DB || spec.database
            : spec.database;

    const ready = await waitForReady({
      container: spec.container,
      user: resolvedUser,
      database: resolvedDb,
      cwd: projectRoot,
      timeoutMs: options.readinessTimeoutMs,
    });
    if (!ready) {
      return failAfterDestruction(
        `Container "${spec.container}" (${target}) did not become PostgreSQL-ready before timeout.`
      );
    }
    completedSteps.push(`READY_CONTAINER:${spec.container}`);
    logger.log(`   ✔ Container "${spec.container}" is healthy and accepting connections.`);
  }

  // 8.6 Apply ordered Prisma migrations to the validated migratable targets (never shadow)
  const mergedEnvForMigrations: Record<string, string | undefined> = {
    ...env,
    DATABASE_URL: envValidation.resolvedUrls.dev,
    UNIT_TEST_DATABASE_URL: envValidation.resolvedUrls.test,
    TEST_DATABASE_URL: envValidation.resolvedUrls.integration,
    STAGING_DATABASE_URL: envValidation.resolvedUrls.staging,
    STAGING_POSTGRES_USER: inMemoryBundle.stagingEnv.STAGING_POSTGRES_USER,
    STAGING_POSTGRES_PASSWORD: inMemoryBundle.stagingEnv.STAGING_POSTGRES_PASSWORD,
    STAGING_POSTGRES_DB: inMemoryBundle.stagingEnv.STAGING_POSTGRES_DB,
    SHADOW_DATABASE_URL: envValidation.resolvedUrls.shadow,
  };

  for (const target of recreatedTargets) {
    const spec = COREERP_LOCAL_RESET_SPECS[target];
    if (!spec.applyMigrations) {
      logger.log(
        `   ℹ Skipping direct schema migration for "${target}" (${spec.database}): Prisma manages the shadow database automatically.`
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
      return failAfterDestruction(
        `Migration failed for target "${target}": ${migRes.error || `exit code ${migRes.exitCode}`}`
      );
    }
    migratedTargets.push(target);
    completedSteps.push(`MIGRATED_TARGET:${target}`);
  }

  // 8.7 Run full staging verification when staging is included
  let stagingVerified = false;
  if (willVerifyStaging) {
    const verifyRes = await runStagingVerify({
      execute: true,
      env: mergedEnvForMigrations,
      logger,
    });
    if (verifyRes.exitCode !== 0) {
      return failAfterDestruction(
        `Post-reset staging verification failed: ${verifyRes.error || `exit code ${verifyRes.exitCode}`}`
      );
    }
    stagingVerified = true;
    completedSteps.push('STAGING_VERIFIED');
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
    completedSteps,
    plan,
  };
}
