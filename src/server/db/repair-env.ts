import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  COREERP_DB_ENVIRONMENTS,
  areDatabaseEndpointsEqual,
  normalizeDatabaseUrl,
  sanitizeDatabaseUrl,
  validateStagingDatabaseUrl,
} from './staging-safety.js';
import { redactSensitiveText } from './staging-verifier.js';
import {
  buildPostgresConnectionUrl,
  generateSecureSecret,
  isPlaceholderOrWeak,
  parseEnvFileContent,
  renderIntegrationEnvFile,
  renderStagingEnvFile,
  runDatabaseEnvironmentSetup,
} from './setup-env.js';
import {
  PROHIBITED_PRODUCTION_CONTAINERS,
  PROHIBITED_PRODUCTION_VOLUMES,
} from './clean-reset.js';

export const REQUIRED_REPAIR_CONFIRMATION_FLAG = '--confirm-local-env-repair';

export type RepairMode = 'CHECK' | 'DRY_RUN' | 'REPAIR';
export type RepairSafetyStatus = 'SAFE' | 'NO_OP' | 'MANUAL_ONLY' | 'BLOCKED';
export type EnvOverrideScope = 'Process' | 'User' | 'Machine' | 'Process+User' | 'Process+Machine' | 'User+Machine' | 'Process+User+Machine';

export interface RepairLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface PersistentEnvScopeEntry {
  variable: string;
  userValue?: string;
  machineValue?: string;
}

export interface ShellOverrideFinding {
  variable: string;
  scopes: Array<'Process' | 'User' | 'Machine'>;
  scopeLabel: EnvOverrideScope;
  expectedTarget: string;
  resolvedEndpoint: string;
  status: 'CONFLICTING_OR_WRONG_TARGET' | 'MATCHES_TARGET';
  remediationCommands: string[];
}

export interface DockerContainerOwnership {
  name: string;
  state: string;
  ownership: 'COREERP_LOCAL' | 'PRODUCTION_PROTECTED' | 'UNRELATED_UNTOUCHED';
  environment?: keyof typeof COREERP_DB_ENVIRONMENTS;
}

export interface DockerVolumeOwnership {
  name: string;
  ownership: 'COREERP_LOCAL' | 'PRODUCTION_PROTECTED' | 'UNRELATED_UNTOUCHED';
  environment?: keyof typeof COREERP_DB_ENVIRONMENTS;
}

export interface DockerEnvironmentSnapshot {
  available: boolean;
  error?: string;
  containers: DockerContainerOwnership[];
  volumes: DockerVolumeOwnership[];
}

export interface RepairActionPlan {
  id: string;
  target: '.env' | '.env.integration-test' | '.env.staging' | 'shell-environment';
  operation:
    | 'STRIP_MISPLACED_KEYS'
    | 'APPEND_INTEGRATION_URL'
    | 'CREATE_INTEGRATION_ENV'
    | 'CREATE_STAGING_ENV'
    | 'PRESERVE_NO_OP'
    | 'MANUAL_SHELL_CLEANUP'
    | 'BLOCKED';
  safety: RepairSafetyStatus;
  summary: string;
  details?: string;
  keysAffected?: string[];
  willModifyFile: boolean;
}

export interface FileBackupRecord {
  file: string;
  backupPath: string;
}

export interface RepairFinding {
  category:
    | 'MISPLACED_VARIABLE'
    | 'MISSING_FILE'
    | 'MISSING_VARIABLE'
    | 'INVALID_ENDPOINT'
    | 'CREDENTIAL_ISSUE'
    | 'SHELL_OVERRIDE'
    | 'DOCKER_UNAVAILABLE';
  source: string;
  variable?: string;
  message: string;
  safety: RepairSafetyStatus;
}

export interface LocalEnvRepairOptions {
  projectRoot?: string;
  mode?: RepairMode;
  confirmed?: boolean;
  shellEnv?: Record<string, string | undefined>;
  logger?: RepairLogger;
  inspectDocker?: () => Promise<DockerEnvironmentSnapshot>;
  inspectPersistentEnvScopes?: (
    variables: readonly string[]
  ) => Promise<PersistentEnvScopeEntry[] | null>;
  generateSecret?: (bytes?: number) => string;
  createBackup?: (filePath: string, backupPath: string) => void;
  writeFileAtomically?: (filePath: string, content: string) => void;
  now?: () => Date;
}

export interface LocalEnvRepairResult {
  exitCode: 0 | 1;
  mode: RepairMode;
  executed: boolean;
  blocked: boolean;
  docker: DockerEnvironmentSnapshot;
  findings: RepairFinding[];
  shellOverrides: ShellOverrideFinding[];
  actions: RepairActionPlan[];
  backups: FileBackupRecord[];
  modifiedFiles: string[];
  createdFiles: string[];
  blockers: string[];
  warnings: string[];
  manualRemediation: string[];
  verificationPassed: boolean | null;
}

export const CANONICAL_REPAIR_TARGETS = [
  {
    environment: 'development',
    label: 'Development',
    variable: 'DATABASE_URL',
    file: '.env',
    target: 'localhost:5432/core_erp',
    port: COREERP_DB_ENVIRONMENTS.development.port,
    database: COREERP_DB_ENVIRONMENTS.development.database,
    user: COREERP_DB_ENVIRONMENTS.development.user,
  },
  {
    environment: 'automatedTest',
    label: 'Automated Test',
    variable: 'UNIT_TEST_DATABASE_URL',
    file: '.env or documented test configuration',
    target: 'localhost:5433/core_erp_test',
    port: COREERP_DB_ENVIRONMENTS.automatedTest.port,
    database: COREERP_DB_ENVIRONMENTS.automatedTest.database,
    user: COREERP_DB_ENVIRONMENTS.automatedTest.user,
  },
  {
    environment: 'integrationTest',
    label: 'Integration Test',
    variable: 'TEST_DATABASE_URL',
    file: '.env.integration-test',
    target: 'localhost:5434/core_erp_integration_test',
    port: COREERP_DB_ENVIRONMENTS.integrationTest.port,
    database: COREERP_DB_ENVIRONMENTS.integrationTest.database,
    user: COREERP_DB_ENVIRONMENTS.integrationTest.user,
  },
  {
    environment: 'staging',
    label: 'Staging',
    variable: 'STAGING_DATABASE_URL',
    file: '.env.staging',
    target: 'localhost:5435/core_erp_staging',
    port: COREERP_DB_ENVIRONMENTS.staging.port,
    database: COREERP_DB_ENVIRONMENTS.staging.database,
    user: COREERP_DB_ENVIRONMENTS.staging.user,
  },
  {
    environment: 'shadow',
    label: 'Shadow',
    variable: 'SHADOW_DATABASE_URL',
    file: '.env',
    target: 'localhost:5436/core_erp_shadow',
    port: COREERP_DB_ENVIRONMENTS.shadow.port,
    database: COREERP_DB_ENVIRONMENTS.shadow.database,
    user: COREERP_DB_ENVIRONMENTS.shadow.user,
  },
] as const;

const TRACKED_DB_ENV_VARS = [
  'DATABASE_URL',
  'UNIT_TEST_DATABASE_URL',
  'TEST_DATABASE_URL',
  'STAGING_DATABASE_URL',
  'SHADOW_DATABASE_URL',
] as const;

const AUTO_REMOVABLE_MISPLACED_ENV_KEYS = new Set(['STAGING_DATABASE_URL', 'TEST_DATABASE_URL']);

const BLOCKING_MISPLACED_ENV_KEYS = [
  'STAGING_POSTGRES_USER',
  'STAGING_POSTGRES_PASSWORD',
  'STAGING_POSTGRES_DB',
] as const;

const FORBIDDEN_IN_STAGING_ENV = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'UNIT_TEST_DATABASE_URL',
  'SHADOW_DATABASE_URL',
] as const;

const FORBIDDEN_IN_INTEGRATION_ENV = [
  'DATABASE_URL',
  'STAGING_DATABASE_URL',
  'UNIT_TEST_DATABASE_URL',
  'SHADOW_DATABASE_URL',
] as const;

const DEFAULT_UNIT_TEST_DATABASE_URL =
  'postgresql://erp_test_user:erp_test_password@localhost:5433/core_erp_test?schema=public';

function parseUrlCredentialsSafe(urlStr: string): { username: string; password: string } | null {
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

function collectSecretsFromMap(map: Record<string, string | undefined> | null): string[] {
  if (!map) return [];
  const secrets: string[] = [];
  const secretKeys = [
    'POSTGRES_PASSWORD',
    'STAGING_POSTGRES_PASSWORD',
    'SHADOW_POSTGRES_PASSWORD',
    'SESSION_SECRET',
    'BANK_ENCRYPTION_KEY',
    'BIOMETRIC_BRIDGE_TOKEN',
    'BOOTSTRAP_SUPER_ADMIN_PASSWORD',
    'DATABASE_URL',
    'UNIT_TEST_DATABASE_URL',
    'STAGING_DATABASE_URL',
    'TEST_DATABASE_URL',
    'SHADOW_DATABASE_URL',
  ];
  for (const key of secretKeys) {
    const val = map[key]?.trim();
    if (!val) continue;
    secrets.push(val);
    try {
      const parsed = new URL(val);
      if (parsed.password) {
        secrets.push(parsed.password);
        const decoded = decodeURIComponent(parsed.password);
        if (decoded) secrets.push(decoded);
      }
    } catch {
      // Not a URL
    }
  }
  return secrets;
}

function formatBackupTimestamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '-',
    pad(date.getMilliseconds(), 3),
  ].join('');
}

function detectDominantEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Surgically removes ONLY the specified variable assignment lines from an env file
 * while preserving every other line, comment, blank line, quoting style, and EOL byte-for-byte.
 */
export function stripMisplacedVarsFromEnvContent(
  content: string,
  keysToRemove: ReadonlySet<string>
): { updatedContent: string; removedKeys: string[]; removedLineCount: number } {
  const linePattern = /([^\r\n]*)(\r\n|\n|$)/g;
  const keptChunks: string[] = [];
  const removedKeys = new Set<string>();
  let removedLineCount = 0;

  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(content)) !== null) {
    const fullChunk = match[0];
    const lineText = match[1];
    if (fullChunk === '' && linePattern.lastIndex === content.length) {
      break;
    }

    const trimmed = lineText.trim();
    let matchedKey: string | null = null;
    if (trimmed && !trimmed.startsWith('#')) {
      const assignMatch = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
      if (assignMatch && keysToRemove.has(assignMatch[1])) {
        matchedKey = assignMatch[1];
      }
    }

    if (matchedKey) {
      removedKeys.add(matchedKey);
      removedLineCount += 1;
    } else {
      keptChunks.push(fullChunk);
    }

    if (linePattern.lastIndex === content.length) {
      break;
    }
  }

  return {
    updatedContent: keptChunks.join(''),
    removedKeys: Array.from(removedKeys),
    removedLineCount,
  };
}

/**
 * Appends a single KEY="VALUE" assignment to an existing env file while preserving
 * every existing byte and matching the file's dominant line ending (\r\n or \n).
 */
export function appendEnvAssignmentPreservingContent(
  existingContent: string,
  key: string,
  value: string
): string {
  const eol = detectDominantEol(existingContent);
  const assignment = `${key}="${value}"${eol}`;
  if (existingContent.length === 0) {
    return assignment;
  }
  const endsWithNewline = existingContent.endsWith('\n') || existingContent.endsWith('\r');
  return endsWithNewline ? `${existingContent}${assignment}` : `${existingContent}${eol}${assignment}`;
}

/**
 * Checks whether a key is defined anywhere in raw env file content (even if assigned an empty value).
 */
function hasEnvKeyDefinition(content: string, key: string): boolean {
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (match && match[1] === key) {
      return true;
    }
  }
  return false;
}

/**
 * Strict atomic file write: writes to a unique temp file in the same directory,
 * flushes via fsync, and renames atomically. Cleans up temp files on any failure.
 */
export function writeFileAtomicallyStrict(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error during cleanup
      }
    }
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore temp cleanup error
    }
    throw err;
  }
}

export function defaultCreateFileBackup(filePath: string, backupPath: string): void {
  const rawContent = fs.readFileSync(filePath);
  const dir = path.dirname(backupPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(backupPath, rawContent, { mode: 0o600 });
}

function execFileReadOnly(
  command: string,
  args: string[],
  timeoutMs = 4_000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            stdout: String(stdout || ''),
            stderr: String(stderr || error.message || ''),
          });
          return;
        }
        resolve({
          ok: true,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      }
    );
  });
}

function classifyDockerContainer(name: string, state: string): DockerContainerOwnership {
  const cleanName = name.replace(/^\//, '').trim();
  if (PROHIBITED_PRODUCTION_CONTAINERS.has(cleanName)) {
    return { name: cleanName, state, ownership: 'PRODUCTION_PROTECTED' };
  }
  const envKeys = Object.keys(COREERP_DB_ENVIRONMENTS) as Array<keyof typeof COREERP_DB_ENVIRONMENTS>;
  for (const envKey of envKeys) {
    if (COREERP_DB_ENVIRONMENTS[envKey].container === cleanName) {
      return {
        name: cleanName,
        state,
        ownership: 'COREERP_LOCAL',
        environment: envKey,
      };
    }
  }
  return { name: cleanName, state, ownership: 'UNRELATED_UNTOUCHED' };
}

function classifyDockerVolume(name: string): DockerVolumeOwnership {
  const cleanName = name.trim();
  for (const prodVol of PROHIBITED_PRODUCTION_VOLUMES) {
    if (cleanName === prodVol || cleanName.endsWith(`_${prodVol}`)) {
      return { name: cleanName, ownership: 'PRODUCTION_PROTECTED' };
    }
  }
  const envKeys = Object.keys(COREERP_DB_ENVIRONMENTS) as Array<keyof typeof COREERP_DB_ENVIRONMENTS>;
  for (const envKey of envKeys) {
    const expectedVol = COREERP_DB_ENVIRONMENTS[envKey].volume;
    if (cleanName === expectedVol || cleanName.endsWith(`_${expectedVol}`)) {
      return {
        name: cleanName,
        ownership: 'COREERP_LOCAL',
        environment: envKey,
      };
    }
  }
  return { name: cleanName, ownership: 'UNRELATED_UNTOUCHED' };
}

/**
 * Strictly read-only Docker daemon, container, and volume ownership inspection.
 * NEVER creates, starts, stops, removes, or mutates any Docker resource.
 */
export async function defaultInspectDockerEnvironment(): Promise<DockerEnvironmentSnapshot> {
  const infoRes = await execFileReadOnly('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (!infoRes.ok) {
    return {
      available: false,
      error:
        infoRes.stderr.trim() ||
        'Docker daemon could not be queried (Docker Desktop or dockerd may not be running).',
      containers: [],
      volumes: [],
    };
  }

  const [psRes, volRes] = await Promise.all([
    execFileReadOnly('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}']),
    execFileReadOnly('docker', ['volume', 'ls', '--format', '{{.Name}}']),
  ]);

  if (!psRes.ok || !volRes.ok) {
    return {
      available: false,
      error:
        (psRes.stderr || volRes.stderr).trim() ||
        'Docker daemon responded to info, but container/volume listing failed.',
      containers: [],
      volumes: [],
    };
  }

  const containers = psRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, state = 'unknown'] = line.split('\t');
      return classifyDockerContainer(name, state);
    });

  const volumes = volRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => classifyDockerVolume(name));

  return {
    available: true,
    containers,
    volumes,
  };
}

/**
 * Strictly read-only Windows User/Machine environment variable scope inspection.
 * NEVER modifies Windows User or Machine environment variables.
 * Returns null on non-Windows platforms or if PowerShell cannot be queried.
 */
export async function detectPersistentWindowsEnvOverrides(
  variables: readonly string[]
): Promise<PersistentEnvScopeEntry[] | null> {
  if (process.platform !== 'win32') {
    return null;
  }

  // Strictly allow only safe uppercase identifier names before invoking PowerShell
  const safeVars = variables.filter((v) => /^[A-Z0-9_]+$/.test(v));
  if (safeVars.length === 0) return [];

  const listLiteral = safeVars.map((v) => `'${v}'`).join(',');
  const psScript = [
    `$vars = @(${listLiteral})`,
    '$out = foreach ($v in $vars) {',
    '  [PSCustomObject]@{',
    '    variable = $v',
    '    userValue = [Environment]::GetEnvironmentVariable($v, "User")',
    '    machineValue = [Environment]::GetEnvironmentVariable($v, "Machine")',
    '  }',
    '}',
    '$out | ConvertTo-Json -Compress',
  ].join('; ');

  const res = await execFileReadOnly(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    4_000
  );
  if (!res.ok || !res.stdout.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(res.stdout.trim());
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        variable: String(item.variable || ''),
        userValue: typeof item.userValue === 'string' && item.userValue.trim() ? item.userValue : undefined,
        machineValue:
          typeof item.machineValue === 'string' && item.machineValue.trim()
            ? item.machineValue
            : undefined,
      }))
      .filter((entry) => entry.variable.length > 0);
  } catch {
    return null;
  }
}

function buildScopeLabel(scopes: Array<'Process' | 'User' | 'Machine'>): EnvOverrideScope {
  const hasProcess = scopes.includes('Process');
  const hasUser = scopes.includes('User');
  const hasMachine = scopes.includes('Machine');
  if (hasProcess && hasUser && hasMachine) return 'Process+User+Machine';
  if (hasProcess && hasUser) return 'Process+User';
  if (hasProcess && hasMachine) return 'Process+Machine';
  if (hasUser && hasMachine) return 'User+Machine';
  if (hasUser) return 'User';
  if (hasMachine) return 'Machine';
  return 'Process';
}

function buildManualOverrideCommands(
  variable: string,
  scopes: Array<'Process' | 'User' | 'Machine'>
): string[] {
  const commands: string[] = [];
  if (scopes.includes('Process')) {
    commands.push(`Remove-Item Env:${variable} -ErrorAction SilentlyContinue`);
  }
  if (scopes.includes('User')) {
    commands.push(
      `[Environment]::SetEnvironmentVariable('${variable}', $null, 'User')  # Then open a new PowerShell window`
    );
  }
  if (scopes.includes('Machine')) {
    commands.push(
      `[Environment]::SetEnvironmentVariable('${variable}', $null, 'Machine')  # Run in Administrator PowerShell, then open a new window`
    );
  }
  return commands;
}

function formatEndpointSummary(rawUrl: string): string {
  const ep = normalizeDatabaseUrl(rawUrl);
  if (ep) {
    return `${ep.hostname}:${ep.port}/${ep.database}`;
  }
  return sanitizeDatabaseUrl(rawUrl);
}

/**
 * Generates a cryptographically strong unique staging password guaranteed not to match
 * any existing development, integration, or shadow secret.
 */
function generateUniqueStagingPassword(
  generateSecret: (bytes?: number) => string,
  forbiddenPasswords: ReadonlySet<string>
): string | null {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateSecret(32);
    if (!isPlaceholderOrWeak(candidate) && !forbiddenPasswords.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Permanent, safe, repeatable local database environment audit & repair workflow.
 *
 * Guarantees:
 * - `CHECK` mode (`db:repair:check`) is 100% read-only.
 * - `DRY_RUN` mode (`db:repair:local` default) is 100% read-only.
 * - `REPAIR` mode requires explicit confirmation (`confirmed: true` / `--confirm-local-env-repair`).
 * - Stops BEFORE changing any file if any unsafe/blocked condition is detected.
 * - Backs up every existing file before modifying it.
 * - Writes atomically with temp-file cleanup and rollback on mid-repair write failure.
 * - Preserves unrelated `.env` entries and `.env.integration-test` `POSTGRES_PASSWORD` byte-for-byte.
 * - Never exposes passwords or raw connection URLs in logs or returned findings.
 * - Never modifies Windows User/Machine environment variables automatically.
 * - Never runs migrations, clean-reset, or mutating Docker commands.
 * - Never touches biometric bridge files (`USER_SYNC_ONLY`).
 */
export async function runLocalDatabaseEnvRepair(
  options: LocalEnvRepairOptions = {}
): Promise<LocalEnvRepairResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const requestedMode: RepairMode =
    options.mode ?? (options.confirmed ? 'REPAIR' : 'DRY_RUN');
  // Safety invariant: CHECK always stays CHECK; REPAIR requires explicit confirmation
  const mode: RepairMode =
    requestedMode === 'CHECK'
      ? 'CHECK'
      : requestedMode === 'REPAIR' && options.confirmed === true
        ? 'REPAIR'
        : 'DRY_RUN';

  const shellEnv: Record<string, string | undefined> =
    options.shellEnv ?? (process.env.VITEST === 'true' ? {} : process.env);
  const generateSecret = options.generateSecret ?? generateSecureSecret;
  const inspectDocker = options.inspectDocker ?? defaultInspectDockerEnvironment;
  const inspectPersistentEnvScopes =
    options.inspectPersistentEnvScopes ??
    (process.env.VITEST === 'true'
      ? async () => null
      : detectPersistentWindowsEnvOverrides);
  const createBackup = options.createBackup ?? defaultCreateFileBackup;
  const writeFileAtomically = options.writeFileAtomically ?? writeFileAtomicallyStrict;
  const now = options.now ?? (() => new Date());
  const logger: RepairLogger = options.logger ?? {
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };

  const envPath = path.join(projectRoot, '.env');
  const integrationEnvPath = path.join(projectRoot, '.env.integration-test');
  const stagingEnvPath = path.join(projectRoot, '.env.staging');

  const findings: RepairFinding[] = [];
  const shellOverrides: ShellOverrideFinding[] = [];
  const actions: RepairActionPlan[] = [];
  const backups: FileBackupRecord[] = [];
  const modifiedFiles: string[] = [];
  const createdFiles: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const manualRemediation: string[] = [];
  const sensitiveValues = new Set<string>();

  const trackSecrets = (values: Array<string | undefined>) => {
    for (const v of values) {
      if (!v) continue;
      const trimmed = v.trim();
      if (trimmed.length >= 4) {
        sensitiveValues.add(trimmed);
      }
      try {
        const parsed = new URL(trimmed);
        if (parsed.password) {
          sensitiveValues.add(parsed.password);
          const decoded = decodeURIComponent(parsed.password);
          if (decoded.length >= 4) sensitiveValues.add(decoded);
        }
      } catch {
        // Not a URL
      }
    }
  };
  const redact = (msg: string): string =>
    redactSensitiveText(msg, Array.from(sensitiveValues));

  trackSecrets(collectSecretsFromMap(shellEnv));

  logger.log('\n====================================================================');
  logger.log(
    mode === 'CHECK'
      ? '   CoreERP Local Database Environment Repair Audit (Read-Only)'
      : mode === 'DRY_RUN'
        ? '   CoreERP Local Database Environment Repair (DRY-RUN — Zero Changes)'
        : '   CoreERP Local Database Environment Repair (CONFIRMED EXECUTION)'
  );
  logger.log('====================================================================\n');

  // 1. Read-only Docker daemon, container & volume ownership inspection
  const docker = await inspectDocker();
  if (!docker.available) {
    const dockerMsg =
      docker.error ||
      'Docker daemon could not be queried (Docker may not be running).';
    const punctuatedDockerMsg = dockerMsg.endsWith('.') ? dockerMsg : `${dockerMsg}.`;
    warnings.push(
      `Docker daemon unavailable: ${punctuatedDockerMsg} Configuration file inspection and repair remain safe without Docker; no containers or volumes will be created, started, or deleted.`
    );
    findings.push({
      category: 'DOCKER_UNAVAILABLE',
      source: 'docker-daemon',
      message: `Docker daemon unavailable: ${dockerMsg}`,
      safety: 'MANUAL_ONLY',
    });
    logger.log('1. Docker Daemon & Ownership (Read-Only):');
    logger.log('   - Status: UNAVAILABLE (Docker daemon could not be queried; zero Docker mutations performed)');
  } else {
    logger.log('1. Docker Daemon & Ownership (Read-Only — Zero Mutations):');
    logger.log('   - Status: AVAILABLE');
    const localContainers = docker.containers.filter((c) => c.ownership === 'COREERP_LOCAL');
    const prodContainers = docker.containers.filter((c) => c.ownership === 'PRODUCTION_PROTECTED');
    const otherContainers = docker.containers.filter((c) => c.ownership === 'UNRELATED_UNTOUCHED');
    const localVolumes = docker.volumes.filter((v) => v.ownership === 'COREERP_LOCAL');
    const prodVolumes = docker.volumes.filter((v) => v.ownership === 'PRODUCTION_PROTECTED');
    const otherVolumes = docker.volumes.filter((v) => v.ownership === 'UNRELATED_UNTOUCHED');

    logger.log(
      `   - CoreERP local containers (${localContainers.length}): ${localContainers.length > 0 ? localContainers.map((c) => `${c.name} [${c.state}]`).join(', ') : 'none'}`
    );
    logger.log(
      `   - CoreERP local volumes (${localVolumes.length}): ${localVolumes.length > 0 ? localVolumes.map((v) => `${v.name} (${v.environment})`).join(', ') : 'none'}`
    );
    if (prodContainers.length > 0 || prodVolumes.length > 0) {
      logger.log(
        `   - Production-protected resources (NEVER touched): containers=[${prodContainers.map((c) => c.name).join(', ')}], volumes=[${prodVolumes.map((v) => v.name).join(', ')}]`
      );
    }
    if (otherContainers.length > 0 || otherVolumes.length > 0) {
      logger.log(
        `   - Unrelated Docker resources (NEVER touched): ${otherContainers.length} container(s), ${otherVolumes.length} volume(s)`
      );
    }
  }

  // 2. Read existing local env files safely (zero mutations during inspection)
  const readRawFileSafe = (
    filePath: string,
    label: string
  ): { exists: boolean; raw: string | null; parsed: Record<string, string> | null; error?: string } => {
    if (!fs.existsSync(filePath)) {
      return { exists: false, raw: null, parsed: null };
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return {
          exists: true,
          raw: null,
          parsed: null,
          error: `[${label}] Path exists but is not a regular file.`,
        };
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      return { exists: true, raw, parsed: parseEnvFileContent(raw) };
    } catch (err) {
      return {
        exists: true,
        raw: null,
        parsed: null,
        error: `[${label}] Could not read file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  const mainFile = readRawFileSafe(envPath, '.env');
  const integrationFile = readRawFileSafe(integrationEnvPath, '.env.integration-test');
  const stagingFile = readRawFileSafe(stagingEnvPath, '.env.staging');

  trackSecrets(collectSecretsFromMap(mainFile.parsed));
  trackSecrets(collectSecretsFromMap(integrationFile.parsed));
  trackSecrets(collectSecretsFromMap(stagingFile.parsed));

  if (mainFile.error) blockers.push(mainFile.error);
  if (integrationFile.error) blockers.push(integrationFile.error);
  if (stagingFile.error) blockers.push(stagingFile.error);

  // 3. Inspect shell & persistent Windows User/Machine environment overrides (strictly read-only)
  const persistentEntries = await inspectPersistentEnvScopes(TRACKED_DB_ENV_VARS);
  const persistentMap = new Map<string, PersistentEnvScopeEntry>();
  if (persistentEntries) {
    for (const entry of persistentEntries) {
      persistentMap.set(entry.variable, entry);
      trackSecrets([entry.userValue, entry.machineValue]);
    }
  }

  const targetMetaByVar = new Map<
    string,
    { port: number; database: string; target: string; file: string; fileValue?: string }
  >([
    [
      'DATABASE_URL',
      {
        port: COREERP_DB_ENVIRONMENTS.development.port,
        database: COREERP_DB_ENVIRONMENTS.development.database,
        target: 'localhost:5432/core_erp',
        file: '.env',
        fileValue: mainFile.parsed?.DATABASE_URL,
      },
    ],
    [
      'UNIT_TEST_DATABASE_URL',
      {
        port: COREERP_DB_ENVIRONMENTS.automatedTest.port,
        database: COREERP_DB_ENVIRONMENTS.automatedTest.database,
        target: 'localhost:5433/core_erp_test',
        file: '.env',
        fileValue: mainFile.parsed?.UNIT_TEST_DATABASE_URL,
      },
    ],
    [
      'TEST_DATABASE_URL',
      {
        port: COREERP_DB_ENVIRONMENTS.integrationTest.port,
        database: COREERP_DB_ENVIRONMENTS.integrationTest.database,
        target: 'localhost:5434/core_erp_integration_test',
        file: '.env.integration-test',
        fileValue: integrationFile.parsed?.TEST_DATABASE_URL,
      },
    ],
    [
      'STAGING_DATABASE_URL',
      {
        port: COREERP_DB_ENVIRONMENTS.staging.port,
        database: COREERP_DB_ENVIRONMENTS.staging.database,
        target: 'localhost:5435/core_erp_staging',
        file: '.env.staging',
        fileValue: stagingFile.parsed?.STAGING_DATABASE_URL,
      },
    ],
    [
      'SHADOW_DATABASE_URL',
      {
        port: COREERP_DB_ENVIRONMENTS.shadow.port,
        database: COREERP_DB_ENVIRONMENTS.shadow.database,
        target: 'localhost:5436/core_erp_shadow',
        file: '.env',
        fileValue: mainFile.parsed?.SHADOW_DATABASE_URL,
      },
    ],
  ]);

  for (const varName of TRACKED_DB_ENV_VARS) {
    const meta = targetMetaByVar.get(varName)!;
    const processVal = shellEnv[varName]?.trim();
    const persistent = persistentMap.get(varName);
    const userVal = persistent?.userValue?.trim();
    const machineVal = persistent?.machineValue?.trim();

    const activeScopes: Array<'Process' | 'User' | 'Machine'> = [];
    if (processVal) activeScopes.push('Process');
    if (userVal) activeScopes.push('User');
    if (machineVal) activeScopes.push('Machine');

    if (activeScopes.length === 0) continue;

    const effectiveValue = processVal || userVal || machineVal || '';
    const ep = normalizeDatabaseUrl(effectiveValue);
    const wrongEndpoint =
      !ep ||
      ep.hostname !== '127.0.0.1' ||
      ep.port !== meta.port ||
      ep.database !== meta.database;

    // Also flag if any persistent scope (User/Machine) holds a wrong endpoint even if Process differs
    const persistentWrong = [userVal, machineVal].some((val) => {
      if (!val) return false;
      const pEp = normalizeDatabaseUrl(val);
      return !pEp || pEp.hostname !== '127.0.0.1' || pEp.port !== meta.port || pEp.database !== meta.database;
    });

    // Also flag conflict against file value when present
    let conflictsWithFile = false;
    if (meta.fileValue?.trim() && ep) {
      const fileEp = normalizeDatabaseUrl(meta.fileValue.trim());
      const envCreds = parseUrlCredentialsSafe(effectiveValue);
      const fileCreds = parseUrlCredentialsSafe(meta.fileValue.trim());
      if (
        fileEp &&
        (!areDatabaseEndpointsEqual(ep, fileEp) ||
          (envCreds &&
            fileCreds &&
            (envCreds.username !== fileCreds.username ||
              envCreds.password !== fileCreds.password)))
      ) {
        conflictsWithFile = true;
      }
    }

    // For TEST_DATABASE_URL and STAGING_DATABASE_URL, shell overrides always shadow target env files
    const isShadowingTargetFile =
      varName === 'TEST_DATABASE_URL' || varName === 'STAGING_DATABASE_URL';
    const isProblematic =
      wrongEndpoint || persistentWrong || conflictsWithFile || isShadowingTargetFile;

    if (isProblematic) {
      const scopeLabel = buildScopeLabel(activeScopes);
      const remediationCommands = buildManualOverrideCommands(varName, activeScopes);
      const resolvedEndpoint = formatEndpointSummary(effectiveValue);
      const finding: ShellOverrideFinding = {
        variable: varName,
        scopes: activeScopes,
        scopeLabel,
        expectedTarget: meta.target,
        resolvedEndpoint,
        status:
          wrongEndpoint || persistentWrong || conflictsWithFile
            ? 'CONFLICTING_OR_WRONG_TARGET'
            : 'MATCHES_TARGET',
        remediationCommands,
      };
      shellOverrides.push(finding);
      findings.push({
        category: 'SHELL_OVERRIDE',
        source: `shell environment (${scopeLabel})`,
        variable: varName,
        message: `[shell environment (${scopeLabel}) :: ${varName}] Active override resolves to ${resolvedEndpoint} (expected ${meta.target} from ${meta.file}). CoreERP will NOT modify Windows User/Machine environment variables automatically.`,
        safety: 'MANUAL_ONLY',
      });
      for (const cmd of remediationCommands) {
        if (!manualRemediation.includes(cmd)) {
          manualRemediation.push(cmd);
        }
      }
    }
  }

  if (shellOverrides.length > 0) {
    actions.push({
      id: 'shell-overrides-manual',
      target: 'shell-environment',
      operation: 'MANUAL_SHELL_CLEANUP',
      safety: 'MANUAL_ONLY',
      summary: `Manual cleanup required for ${shellOverrides.length} shell/persistent environment override(s): ${shellOverrides.map((o) => `${o.variable} [${o.scopeLabel}]`).join(', ')}.`,
      details:
        'CoreERP never modifies Windows User or Machine environment variables automatically. Run the reported PowerShell removal commands manually.',
      keysAffected: shellOverrides.map((o) => o.variable),
      willModifyFile: false,
    });
  }

  // 4. Plan & validate `.env` repair
  let plannedMainEnvContent: string | null = null;
  let devPassword = '';
  let shadowPassword = '';
  const devUrl = mainFile.parsed?.DATABASE_URL?.trim() || '';
  const shadowUrl = mainFile.parsed?.SHADOW_DATABASE_URL?.trim() || '';
  const unitTestUrlInEnv = mainFile.parsed?.UNIT_TEST_DATABASE_URL?.trim() || '';

  if (!mainFile.exists) {
    const msg =
      '[.env :: DATABASE_URL] Missing .env file. Local repair will not invent development credentials automatically; run `npm run db:setup` for initial setup.';
    blockers.push(msg);
    findings.push({
      category: 'MISSING_FILE',
      source: '.env',
      variable: 'DATABASE_URL',
      message: msg,
      safety: 'BLOCKED',
    });
    actions.push({
      id: 'env-missing',
      target: '.env',
      operation: 'BLOCKED',
      safety: 'BLOCKED',
      summary: 'Cannot repair missing .env safely.',
      details: msg,
      willModifyFile: false,
    });
  } else if (mainFile.raw !== null && mainFile.parsed !== null) {
    const mainEnv = mainFile.parsed;
    const dUser = mainEnv.POSTGRES_USER?.trim() || '';
    const dPass = mainEnv.POSTGRES_PASSWORD?.trim() || '';
    const dDb = mainEnv.POSTGRES_DB?.trim() || '';

    // 4a. Validate development DATABASE_URL (must be safe & valid; never auto-overwrite dev credentials)
    if (!devUrl) {
      const msg =
        '[.env :: DATABASE_URL] Missing DATABASE_URL in .env (expected localhost:5432/core_erp). Repair blocked to avoid fabricating dev credentials.';
      blockers.push(msg);
      findings.push({
        category: 'MISSING_VARIABLE',
        source: '.env',
        variable: 'DATABASE_URL',
        message: msg,
        safety: 'BLOCKED',
      });
    } else {
      const devEp = normalizeDatabaseUrl(devUrl);
      if (!devEp) {
        const msg = '[.env :: DATABASE_URL] Malformed PostgreSQL URL in .env.';
        blockers.push(msg);
        findings.push({
          category: 'INVALID_ENDPOINT',
          source: '.env',
          variable: 'DATABASE_URL',
          message: msg,
          safety: 'BLOCKED',
        });
      } else {
        if (devEp.hostname !== '127.0.0.1') {
          const msg = `[.env :: DATABASE_URL] Targets remote host "${devEp.hostname}"; local development requires localhost:5432/core_erp.`;
          blockers.push(msg);
          findings.push({
            category: 'INVALID_ENDPOINT',
            source: '.env',
            variable: 'DATABASE_URL',
            message: msg,
            safety: 'BLOCKED',
          });
        }
        if (devEp.port !== COREERP_DB_ENVIRONMENTS.development.port) {
          const msg = `[.env :: DATABASE_URL] Targets port ${devEp.port}, but development must use port ${COREERP_DB_ENVIRONMENTS.development.port}.`;
          blockers.push(msg);
          findings.push({
            category: 'INVALID_ENDPOINT',
            source: '.env',
            variable: 'DATABASE_URL',
            message: msg,
            safety: 'BLOCKED',
          });
        }
        if (devEp.database !== COREERP_DB_ENVIRONMENTS.development.database) {
          const msg = `[.env :: DATABASE_URL] Targets database "${devEp.database}", but development must target "${COREERP_DB_ENVIRONMENTS.development.database}".`;
          blockers.push(msg);
          findings.push({
            category: 'INVALID_ENDPOINT',
            source: '.env',
            variable: 'DATABASE_URL',
            message: msg,
            safety: 'BLOCKED',
          });
        }
        const devCreds = parseUrlCredentialsSafe(devUrl);
        if (!devCreds || isPlaceholderOrWeak(devCreds.password)) {
          const msg =
            '[.env :: DATABASE_URL] Uses an empty, malformed, or placeholder password in .env.';
          blockers.push(msg);
          findings.push({
            category: 'CREDENTIAL_ISSUE',
            source: '.env',
            variable: 'DATABASE_URL',
            message: msg,
            safety: 'BLOCKED',
          });
        } else {
          devPassword = devCreds.password;
          if (dPass && devCreds.password !== dPass) {
            const msg =
              '[.env :: DATABASE_URL vs POSTGRES_PASSWORD] DATABASE_URL password does not match POSTGRES_PASSWORD in .env. Align dev credentials first (`npm run db:sync:dev-credentials -- --confirm`) before running local repair.';
            blockers.push(msg);
            findings.push({
              category: 'CREDENTIAL_ISSUE',
              source: '.env',
              variable: 'DATABASE_URL',
              message: msg,
              safety: 'BLOCKED',
            });
          }
          if (dUser && devCreds.username !== dUser) {
            const msg =
              '[.env :: DATABASE_URL] Username does not match [.env :: POSTGRES_USER].';
            blockers.push(msg);
            findings.push({
              category: 'CREDENTIAL_ISSUE',
              source: '.env',
              variable: 'DATABASE_URL',
              message: msg,
              safety: 'BLOCKED',
            });
          }
          if (dDb && devEp.database !== dDb.toLowerCase()) {
            const msg =
              '[.env :: DATABASE_URL] Database name does not match [.env :: POSTGRES_DB].';
            blockers.push(msg);
            findings.push({
              category: 'INVALID_ENDPOINT',
              source: '.env',
              variable: 'DATABASE_URL',
              message: msg,
              safety: 'BLOCKED',
            });
          }
        }
      }
    }

    // 4b. Validate optional UNIT_TEST_DATABASE_URL and SHADOW_DATABASE_URL if present in .env
    if (unitTestUrlInEnv) {
      const unitEp = normalizeDatabaseUrl(unitTestUrlInEnv);
      if (
        !unitEp ||
        unitEp.hostname !== '127.0.0.1' ||
        unitEp.port !== COREERP_DB_ENVIRONMENTS.automatedTest.port ||
        unitEp.database !== COREERP_DB_ENVIRONMENTS.automatedTest.database
      ) {
        const msg =
          '[.env :: UNIT_TEST_DATABASE_URL] Must target localhost:5433/core_erp_test when set in .env.';
        blockers.push(msg);
        findings.push({
          category: 'INVALID_ENDPOINT',
          source: '.env',
          variable: 'UNIT_TEST_DATABASE_URL',
          message: msg,
          safety: 'BLOCKED',
        });
      }
    }

    if (shadowUrl) {
      const shadowEp = normalizeDatabaseUrl(shadowUrl);
      if (
        !shadowEp ||
        shadowEp.hostname !== '127.0.0.1' ||
        shadowEp.port !== COREERP_DB_ENVIRONMENTS.shadow.port ||
        shadowEp.database !== COREERP_DB_ENVIRONMENTS.shadow.database
      ) {
        const msg =
          '[.env :: SHADOW_DATABASE_URL] Must target localhost:5436/core_erp_shadow when set in .env.';
        blockers.push(msg);
        findings.push({
          category: 'INVALID_ENDPOINT',
          source: '.env',
          variable: 'SHADOW_DATABASE_URL',
          message: msg,
          safety: 'BLOCKED',
        });
      } else {
        const shadowCreds = parseUrlCredentialsSafe(shadowUrl);
        if (shadowCreds?.password) {
          shadowPassword = shadowCreds.password;
        }
        if (
          mainEnv.SHADOW_POSTGRES_PASSWORD?.trim() &&
          shadowCreds &&
          shadowCreds.password !== mainEnv.SHADOW_POSTGRES_PASSWORD.trim()
        ) {
          const msg =
            '[.env :: SHADOW_DATABASE_URL] Password does not match [.env :: SHADOW_POSTGRES_PASSWORD].';
          blockers.push(msg);
          findings.push({
            category: 'CREDENTIAL_ISSUE',
            source: '.env',
            variable: 'SHADOW_DATABASE_URL',
            message: msg,
            safety: 'BLOCKED',
          });
        }
      }
    }

    // 4c. Non-auto-removable misplaced staging compose variables in .env must block rather than be silently dropped
    for (const stagingKey of BLOCKING_MISPLACED_ENV_KEYS) {
      if (hasEnvKeyDefinition(mainFile.raw, stagingKey)) {
        const msg = `[.env :: ${stagingKey}] Misplaced staging Compose variable found in .env. Remove ${stagingKey} manually from .env before running repair (repair only removes STAGING_DATABASE_URL and TEST_DATABASE_URL from .env).`;
        blockers.push(msg);
        findings.push({
          category: 'MISPLACED_VARIABLE',
          source: '.env',
          variable: stagingKey,
          message: msg,
          safety: 'BLOCKED',
        });
      }
    }

    // 4d. Auto-removable misplaced STAGING_DATABASE_URL and TEST_DATABASE_URL in .env
    const stripped = stripMisplacedVarsFromEnvContent(
      mainFile.raw,
      AUTO_REMOVABLE_MISPLACED_ENV_KEYS
    );
    for (const removedKey of stripped.removedKeys) {
      const val = mainEnv[removedKey]?.trim() || '';
      const epNote = val ? ` (currently targets ${formatEndpointSummary(val)})` : '';
      findings.push({
        category: 'MISPLACED_VARIABLE',
        source: '.env',
        variable: removedKey,
        message: `[.env :: ${removedKey}] Misplaced variable in .env${epNote}. Safe to remove from .env while preserving all other entries byte-for-byte.`,
        safety: 'SAFE',
      });
    }

    if (stripped.removedLineCount > 0) {
      plannedMainEnvContent = stripped.updatedContent;
      actions.push({
        id: 'env-strip-misplaced',
        target: '.env',
        operation: 'STRIP_MISPLACED_KEYS',
        safety: 'SAFE',
        summary: `Remove only misplaced ${stripped.removedKeys.join(' and ')} line(s) from .env (${stripped.removedLineCount} line(s)); preserve all other .env entries byte-for-byte.`,
        keysAffected: stripped.removedKeys,
        willModifyFile: true,
      });
    } else {
      actions.push({
        id: 'env-clean',
        target: '.env',
        operation: 'PRESERVE_NO_OP',
        safety: 'NO_OP',
        summary: '.env contains no misplaced STAGING_DATABASE_URL or TEST_DATABASE_URL entries (preserved untouched).',
        willModifyFile: false,
      });
    }
  }

  // 5. Plan & validate `.env.integration-test` repair
  let plannedIntegrationEnvContent: string | null = null;
  let integrationActionWillCreate = false;
  let integrationPassword = '';
  let plannedIntegrationUrl = '';

  if (!integrationFile.exists) {
    // Missing .env.integration-test -> safe to create with unique credentials
    const existingIntVol = docker.volumes.find(
      (v) => v.ownership === 'COREERP_LOCAL' && v.environment === 'integrationTest'
    );
    if (existingIntVol) {
      warnings.push(
        `Existing integration Docker volume "${existingIntVol.name}" detected while .env.integration-test is missing. Creating .env.integration-test will not touch the volume, but you may need to align the PostgreSQL role password if P1000 occurs.`
      );
    }

    const forbiddenForIntegration = new Set<string>(
      [devPassword, shadowPassword].filter(Boolean)
    );
    const newIntPassword = generateUniqueStagingPassword(
      generateSecret,
      forbiddenForIntegration
    );
    if (!newIntPassword) {
      const msg =
        '[.env.integration-test :: POSTGRES_PASSWORD] Failed to generate a unique non-colliding integration password.';
      blockers.push(msg);
      findings.push({
        category: 'CREDENTIAL_ISSUE',
        source: '.env.integration-test',
        variable: 'POSTGRES_PASSWORD',
        message: msg,
        safety: 'BLOCKED',
      });
    } else {
      integrationPassword = newIntPassword;
      plannedIntegrationUrl = buildPostgresConnectionUrl({
        user: COREERP_DB_ENVIRONMENTS.integrationTest.user,
        password: newIntPassword,
        host: 'localhost',
        port: COREERP_DB_ENVIRONMENTS.integrationTest.port,
        database: COREERP_DB_ENVIRONMENTS.integrationTest.database,
      });
      trackSecrets([newIntPassword, plannedIntegrationUrl]);
      plannedIntegrationEnvContent = renderIntegrationEnvFile({
        password: newIntPassword,
        testUrl: plannedIntegrationUrl,
      });
      integrationActionWillCreate = true;
      findings.push({
        category: 'MISSING_FILE',
        source: '.env.integration-test',
        variable: 'TEST_DATABASE_URL',
        message:
          '[.env.integration-test] File is missing. Safe to create dedicated integration test config targeting localhost:5434/core_erp_integration_test.',
        safety: 'SAFE',
      });
      actions.push({
        id: 'integration-create',
        target: '.env.integration-test',
        operation: 'CREATE_INTEGRATION_ENV',
        safety: 'SAFE',
        summary:
          'Create missing .env.integration-test with unique POSTGRES_PASSWORD and TEST_DATABASE_URL (localhost:5434/core_erp_integration_test).',
        keysAffected: ['POSTGRES_PASSWORD', 'TEST_DATABASE_URL'],
        willModifyFile: true,
      });
    }
  } else if (integrationFile.raw !== null && integrationFile.parsed !== null) {
    const intEnv = integrationFile.parsed;

    // 5a. Reject forbidden non-integration keys in .env.integration-test
    for (const forbiddenKey of FORBIDDEN_IN_INTEGRATION_ENV) {
      if (hasEnvKeyDefinition(integrationFile.raw, forbiddenKey)) {
        const msg = `[.env.integration-test :: ${forbiddenKey}] Non-integration variable found in .env.integration-test. Remove it manually before running repair.`;
        blockers.push(msg);
        findings.push({
          category: 'MISPLACED_VARIABLE',
          source: '.env.integration-test',
          variable: forbiddenKey,
          message: msg,
          safety: 'BLOCKED',
        });
      }
    }

    const existingIntPass = intEnv.POSTGRES_PASSWORD?.trim() || '';
    const existingIntUrl = intEnv.TEST_DATABASE_URL?.trim() || '';
    const hasTestUrlKey = hasEnvKeyDefinition(integrationFile.raw, 'TEST_DATABASE_URL');

    if (isPlaceholderOrWeak(existingIntPass)) {
      const msg =
        '[.env.integration-test :: POSTGRES_PASSWORD] Missing or placeholder POSTGRES_PASSWORD in existing .env.integration-test. Repair will NOT fabricate or replace an integration password automatically.';
      blockers.push(msg);
      findings.push({
        category: 'MISSING_VARIABLE',
        source: '.env.integration-test',
        variable: 'POSTGRES_PASSWORD',
        message: msg,
        safety: 'BLOCKED',
      });
      actions.push({
        id: 'integration-blocked-password',
        target: '.env.integration-test',
        operation: 'BLOCKED',
        safety: 'BLOCKED',
        summary: 'Cannot repair .env.integration-test because POSTGRES_PASSWORD is missing or placeholder.',
        details: msg,
        willModifyFile: false,
      });
    } else {
      integrationPassword = existingIntPass;

      if (!hasTestUrlKey) {
        // SAFE REPAIR: preserve existing file & POSTGRES_PASSWORD, append canonical TEST_DATABASE_URL
        plannedIntegrationUrl = buildPostgresConnectionUrl({
          user: COREERP_DB_ENVIRONMENTS.integrationTest.user,
          password: existingIntPass,
          host: 'localhost',
          port: COREERP_DB_ENVIRONMENTS.integrationTest.port,
          database: COREERP_DB_ENVIRONMENTS.integrationTest.database,
        });
        trackSecrets([plannedIntegrationUrl]);
        plannedIntegrationEnvContent = appendEnvAssignmentPreservingContent(
          integrationFile.raw,
          'TEST_DATABASE_URL',
          plannedIntegrationUrl
        );
        findings.push({
          category: 'MISSING_VARIABLE',
          source: '.env.integration-test',
          variable: 'TEST_DATABASE_URL',
          message:
            '[.env.integration-test :: TEST_DATABASE_URL] Missing TEST_DATABASE_URL. Safe to append canonical integration URL (localhost:5434/core_erp_integration_test, user erp_integration_user) using existing POSTGRES_PASSWORD without regenerating credentials.',
          safety: 'SAFE',
        });
        actions.push({
          id: 'integration-append-url',
          target: '.env.integration-test',
          operation: 'APPEND_INTEGRATION_URL',
          safety: 'SAFE',
          summary:
            'Preserve existing .env.integration-test and POSTGRES_PASSWORD; append TEST_DATABASE_URL targeting localhost:5434/core_erp_integration_test (user erp_integration_user).',
          keysAffected: ['TEST_DATABASE_URL'],
          willModifyFile: true,
        });
      } else {
        // Key exists — validate it strictly and NEVER silently overwrite existing user values
        const intEp = normalizeDatabaseUrl(existingIntUrl);
        const intCreds = existingIntUrl ? parseUrlCredentialsSafe(existingIntUrl) : null;
        let intValid = true;

        if (!existingIntUrl || !intEp) {
          intValid = false;
          const msg =
            '[.env.integration-test :: TEST_DATABASE_URL] Existing TEST_DATABASE_URL is empty or malformed. Repair will not overwrite an existing assignment automatically.';
          blockers.push(msg);
          findings.push({
            category: 'INVALID_ENDPOINT',
            source: '.env.integration-test',
            variable: 'TEST_DATABASE_URL',
            message: msg,
            safety: 'BLOCKED',
          });
        } else {
          if (
            intEp.hostname !== '127.0.0.1' ||
            intEp.port !== COREERP_DB_ENVIRONMENTS.integrationTest.port ||
            intEp.database !== COREERP_DB_ENVIRONMENTS.integrationTest.database
          ) {
            intValid = false;
            const msg = `[.env.integration-test :: TEST_DATABASE_URL] Existing TEST_DATABASE_URL targets ${intEp.hostname}:${intEp.port}/${intEp.database} (expected localhost:5434/core_erp_integration_test). Repair will not overwrite an existing assignment automatically.`;
            blockers.push(msg);
            findings.push({
              category: 'INVALID_ENDPOINT',
              source: '.env.integration-test',
              variable: 'TEST_DATABASE_URL',
              message: msg,
              safety: 'BLOCKED',
            });
          }
          if (!intCreds || intCreds.username !== COREERP_DB_ENVIRONMENTS.integrationTest.user) {
            intValid = false;
            const msg = `[.env.integration-test :: TEST_DATABASE_URL] Username must be "${COREERP_DB_ENVIRONMENTS.integrationTest.user}".`;
            blockers.push(msg);
            findings.push({
              category: 'CREDENTIAL_ISSUE',
              source: '.env.integration-test',
              variable: 'TEST_DATABASE_URL',
              message: msg,
              safety: 'BLOCKED',
            });
          } else if (intCreds.password !== existingIntPass) {
            intValid = false;
            const msg =
              '[.env.integration-test :: TEST_DATABASE_URL] Password does not match [.env.integration-test :: POSTGRES_PASSWORD]. Align manually to avoid P1000.';
            blockers.push(msg);
            findings.push({
              category: 'CREDENTIAL_ISSUE',
              source: '.env.integration-test',
              variable: 'TEST_DATABASE_URL',
              message: msg,
              safety: 'BLOCKED',
            });
          }
        }

        if (intValid) {
          plannedIntegrationUrl = existingIntUrl;
          actions.push({
            id: 'integration-clean',
            target: '.env.integration-test',
            operation: 'PRESERVE_NO_OP',
            safety: 'NO_OP',
            summary:
              '.env.integration-test already has valid POSTGRES_PASSWORD and TEST_DATABASE_URL (preserved untouched).',
            willModifyFile: false,
          });
        } else {
          actions.push({
            id: 'integration-blocked-invalid',
            target: '.env.integration-test',
            operation: 'BLOCKED',
            safety: 'BLOCKED',
            summary: 'Existing TEST_DATABASE_URL in .env.integration-test is invalid or mismatched; refusing to overwrite.',
            willModifyFile: false,
          });
        }
      }
    }
  }

  // 6. Plan & validate `.env.staging` repair
  let plannedStagingEnvContent: string | null = null;
  let stagingUrlForChecks = '';
  let stagingPasswordForChecks = '';

  if (!stagingFile.exists) {
    const existingStagingVol = docker.volumes.find(
      (v) => v.ownership === 'COREERP_LOCAL' && v.environment === 'staging'
    );
    if (existingStagingVol) {
      warnings.push(
        `Existing staging Docker volume "${existingStagingVol.name}" detected while creating .env.staging. Creating .env.staging will not delete or touch the volume; if P1000 occurs against staging, align the staging role password inside the container.`
      );
    }

    const forbiddenStagingPasswords = new Set<string>(
      [
        devPassword,
        mainFile.parsed?.POSTGRES_PASSWORD?.trim(),
        integrationPassword,
        shadowPassword,
      ].filter((v): v is string => Boolean(v))
    );
    const uniqueStagingPassword = generateUniqueStagingPassword(
      generateSecret,
      forbiddenStagingPasswords
    );

    if (!uniqueStagingPassword) {
      const msg =
        '[.env.staging :: STAGING_POSTGRES_PASSWORD] Could not generate a unique staging password distinct from development and integration credentials.';
      blockers.push(msg);
      findings.push({
        category: 'CREDENTIAL_ISSUE',
        source: '.env.staging',
        variable: 'STAGING_POSTGRES_PASSWORD',
        message: msg,
        safety: 'BLOCKED',
      });
      actions.push({
        id: 'staging-blocked-secret',
        target: '.env.staging',
        operation: 'BLOCKED',
        safety: 'BLOCKED',
        summary: 'Failed to generate unique isolated staging credentials.',
        details: msg,
        willModifyFile: false,
      });
    } else {
      const stagingUser = COREERP_DB_ENVIRONMENTS.staging.user;
      const stagingDb = COREERP_DB_ENVIRONMENTS.staging.database;
      const stagingUrl = buildPostgresConnectionUrl({
        user: stagingUser,
        password: uniqueStagingPassword,
        host: 'localhost',
        port: COREERP_DB_ENVIRONMENTS.staging.port,
        database: stagingDb,
      });
      stagingPasswordForChecks = uniqueStagingPassword;
      stagingUrlForChecks = stagingUrl;
      trackSecrets([uniqueStagingPassword, stagingUrl]);

      plannedStagingEnvContent = renderStagingEnvFile({
        user: stagingUser,
        password: uniqueStagingPassword,
        database: stagingDb,
        stagingUrl,
      });

      findings.push({
        category: 'MISSING_FILE',
        source: '.env.staging',
        variable: 'STAGING_DATABASE_URL',
        message:
          '[.env.staging] Missing staging configuration file. Safe to create dedicated .env.staging targeting localhost:5435/core_erp_staging with unique isolated credentials.',
        safety: 'SAFE',
      });
      actions.push({
        id: 'staging-create',
        target: '.env.staging',
        operation: 'CREATE_STAGING_ENV',
        safety: 'SAFE',
        summary:
          'Create missing .env.staging with unique isolated credentials targeting localhost:5435/core_erp_staging (user erp_staging_user).',
        keysAffected: [
          'STAGING_POSTGRES_USER',
          'STAGING_POSTGRES_PASSWORD',
          'STAGING_POSTGRES_DB',
          'STAGING_DATABASE_URL',
        ],
        willModifyFile: true,
      });
    }
  } else if (stagingFile.raw !== null && stagingFile.parsed !== null) {
    const sEnv = stagingFile.parsed;
    let stagingValid = true;

    for (const forbiddenKey of FORBIDDEN_IN_STAGING_ENV) {
      if (hasEnvKeyDefinition(stagingFile.raw, forbiddenKey)) {
        stagingValid = false;
        const msg = `[.env.staging :: ${forbiddenKey}] Non-staging variable found in .env.staging. Repair will not overwrite existing .env.staging automatically.`;
        blockers.push(msg);
        findings.push({
          category: 'MISPLACED_VARIABLE',
          source: '.env.staging',
          variable: forbiddenKey,
          message: msg,
          safety: 'BLOCKED',
        });
      }
    }

    const sUser = sEnv.STAGING_POSTGRES_USER?.trim() || '';
    const sPass = sEnv.STAGING_POSTGRES_PASSWORD?.trim() || '';
    const sDb = sEnv.STAGING_POSTGRES_DB?.trim() || '';
    const sUrl = sEnv.STAGING_DATABASE_URL?.trim() || '';
    stagingPasswordForChecks = sPass;
    stagingUrlForChecks = sUrl;

    if (!sUser || isPlaceholderOrWeak(sPass) || sDb !== COREERP_DB_ENVIRONMENTS.staging.database || !sUrl) {
      stagingValid = false;
      const msg =
        '[.env.staging] Existing .env.staging is incomplete or uses invalid/placeholder values. Repair will not overwrite an existing .env.staging automatically.';
      blockers.push(msg);
      findings.push({
        category: 'MISSING_VARIABLE',
        source: '.env.staging',
        variable: 'STAGING_DATABASE_URL',
        message: msg,
        safety: 'BLOCKED',
      });
    } else {
      const stagingValidation = validateStagingDatabaseUrl(sUrl, devUrl || undefined, {
        testDatabaseUrl: plannedIntegrationUrl || undefined,
        shadowDatabaseUrl: shadowUrl || undefined,
      });
      const sCreds = parseUrlCredentialsSafe(sUrl);
      if (
        !stagingValidation.valid ||
        !stagingValidation.endpoint ||
        stagingValidation.endpoint.hostname !== '127.0.0.1' ||
        stagingValidation.endpoint.port !== COREERP_DB_ENVIRONMENTS.staging.port ||
        !sCreds ||
        sCreds.username !== sUser ||
        sCreds.password !== sPass
      ) {
        stagingValid = false;
        const msg =
          '[.env.staging :: STAGING_DATABASE_URL] Existing .env.staging fails endpoint or credential consistency validation (expected localhost:5435/core_erp_staging). Repair will not overwrite an existing .env.staging automatically.';
        blockers.push(msg);
        findings.push({
          category: 'INVALID_ENDPOINT',
          source: '.env.staging',
          variable: 'STAGING_DATABASE_URL',
          message: msg,
          safety: 'BLOCKED',
        });
      }
    }

    if (stagingPasswordForChecks && devPassword && stagingPasswordForChecks === devPassword) {
      stagingValid = false;
      const msg =
        '[.env.staging :: STAGING_POSTGRES_PASSWORD] Staging password matches development password. Rotate staging credentials manually so staging remains isolated.';
      blockers.push(msg);
      findings.push({
        category: 'CREDENTIAL_ISSUE',
        source: '.env.staging',
        variable: 'STAGING_POSTGRES_PASSWORD',
        message: msg,
        safety: 'BLOCKED',
      });
    }
    if (
      stagingPasswordForChecks &&
      integrationPassword &&
      stagingPasswordForChecks === integrationPassword
    ) {
      stagingValid = false;
      const msg =
        '[.env.staging :: STAGING_POSTGRES_PASSWORD] Staging password matches integration-test password. Rotate staging credentials manually so staging remains isolated.';
      blockers.push(msg);
      findings.push({
        category: 'CREDENTIAL_ISSUE',
        source: '.env.staging',
        variable: 'STAGING_POSTGRES_PASSWORD',
        message: msg,
        safety: 'BLOCKED',
      });
    }

    if (stagingValid) {
      actions.push({
        id: 'staging-clean',
        target: '.env.staging',
        operation: 'PRESERVE_NO_OP',
        safety: 'NO_OP',
        summary: '.env.staging already exists and passes strict staging isolation validation (preserved untouched).',
        willModifyFile: false,
      });
    } else {
      actions.push({
        id: 'staging-blocked-existing',
        target: '.env.staging',
        operation: 'BLOCKED',
        safety: 'BLOCKED',
        summary: 'Existing .env.staging has configuration or isolation issues; refusing to overwrite automatically.',
        willModifyFile: false,
      });
    }
  }

  // 7. Pairwise duplicate endpoint safety check across the planned post-repair state
  const plannedTargets: Array<{ source: string; url: string }> = [
    { source: '.env :: DATABASE_URL', url: devUrl },
    {
      source: unitTestUrlInEnv ? '.env :: UNIT_TEST_DATABASE_URL' : 'default :: UNIT_TEST_DATABASE_URL',
      url: unitTestUrlInEnv || DEFAULT_UNIT_TEST_DATABASE_URL,
    },
    { source: '.env.integration-test :: TEST_DATABASE_URL', url: plannedIntegrationUrl },
    { source: '.env.staging :: STAGING_DATABASE_URL', url: stagingUrlForChecks },
    {
      source: shadowUrl ? '.env :: SHADOW_DATABASE_URL' : 'default :: SHADOW_DATABASE_URL',
      url:
        shadowUrl ||
        'postgresql://erp_shadow_user:shadow_default_placeholder@localhost:5436/core_erp_shadow?schema=public',
    },
  ];
  const parsedPlanned = plannedTargets
    .map((t) => {
      const ep = normalizeDatabaseUrl(t.url);
      return ep ? { source: t.source, ep } : null;
    })
    .filter((e): e is { source: string; ep: NonNullable<ReturnType<typeof normalizeDatabaseUrl>> } => e !== null);

  for (let i = 0; i < parsedPlanned.length; i += 1) {
    for (let j = i + 1; j < parsedPlanned.length; j += 1) {
      if (areDatabaseEndpointsEqual(parsedPlanned[i].ep, parsedPlanned[j].ep)) {
        const msg = `Duplicate database endpoint detected: [${parsedPlanned[i].source}] and [${parsedPlanned[j].source}] both resolve to ${parsedPlanned[i].ep.hostname}:${parsedPlanned[i].ep.port}/${parsedPlanned[i].ep.database}.`;
        blockers.push(msg);
        findings.push({
          category: 'INVALID_ENDPOINT',
          source: `${parsedPlanned[i].source} vs ${parsedPlanned[j].source}`,
          message: msg,
          safety: 'BLOCKED',
        });
      }
    }
  }

  // 8. Print canonical target table, findings, and repair plan (fully redacted)
  logger.log('\n2. Required Five-Environment Ownership:');
  for (const target of CANONICAL_REPAIR_TARGETS) {
    logger.log(
      `   - ${target.label.padEnd(16)} | ${target.variable.padEnd(22)} | ${target.file.padEnd(36)} | ${target.target}`
    );
  }

  logger.log('\n3. Audit Findings & Safety Classification:');
  if (findings.length === 0) {
    logger.log('   - No configuration issues or shell overrides detected.');
  } else {
    for (const f of findings) {
      logger.log(`   - [${f.safety}] ${redact(f.message)}`);
    }
  }

  logger.log('\n4. Planned Actions:');
  for (const action of actions) {
    logger.log(`   - [${action.safety}] ${action.target}: ${redact(action.summary)}`);
  }

  if (shellOverrides.length > 0) {
    logger.log('\n5. Shell / Persistent Environment Overrides (Manual Remediation Required):');
    for (const ov of shellOverrides) {
      logger.log(
        `   - ${ov.variable} [Scope: ${ov.scopeLabel}] -> currently resolves to ${redact(ov.resolvedEndpoint)} (expected ${ov.expectedTarget})`
      );
      for (const cmd of ov.remediationCommands) {
        logger.log(`       PowerShell: ${cmd}`);
      }
    }
    logger.log(
      '   - Note: Also check your PowerShell profile (`notepad $PROFILE`) if these variables reappear in new terminal windows.'
    );
  }

  const isBlocked = blockers.length > 0;
  const hasFileMutationsPlanned = actions.some((a) => a.willModifyFile && a.safety === 'SAFE');

  // Helper to sanitize all output arrays before returning
  const finalizeResult = (params: {
    exitCode: 0 | 1;
    executed: boolean;
    verificationPassed: boolean | null;
  }): LocalEnvRepairResult => ({
    exitCode: params.exitCode,
    mode,
    executed: params.executed,
    blocked: isBlocked,
    docker: {
      ...docker,
      error: docker.error ? redact(docker.error) : undefined,
    },
    findings: findings.map((f) => ({ ...f, message: redact(f.message) })),
    shellOverrides: shellOverrides.map((ov) => ({
      ...ov,
      resolvedEndpoint: redact(ov.resolvedEndpoint),
    })),
    actions: actions.map((a) => ({
      ...a,
      summary: redact(a.summary),
      details: a.details ? redact(a.details) : undefined,
    })),
    backups,
    modifiedFiles,
    createdFiles,
    blockers: blockers.map(redact),
    warnings: warnings.map(redact),
    manualRemediation: manualRemediation.map(redact),
    verificationPassed: params.verificationPassed,
  });

  // 9. Handle CHECK mode (strictly read-only)
  if (mode === 'CHECK') {
    const hasActionableIssues =
      isBlocked ||
      hasFileMutationsPlanned ||
      shellOverrides.length > 0;

    if (warnings.length > 0) {
      logger.log('\nWarnings:');
      for (const w of warnings) logger.warn(`   - ${redact(w)}`);
    }

    if (hasActionableIssues) {
      logger.log('\n[AUDIT RESULT] Issues detected (read-only check; zero files modified).');
      if (!isBlocked && hasFileMutationsPlanned) {
        logger.log('   Next safe step (dry-run preview): npm run db:repair:local');
        logger.log(
          `   To apply safe file repairs:        npm run db:repair:local -- ${REQUIRED_REPAIR_CONFIRMATION_FLAG}`
        );
      }
      logger.log('');
      return finalizeResult({ exitCode: 1, executed: false, verificationPassed: null });
    }

    logger.log('\n[AUDIT RESULT] All local database environment files and shell checks PASSED (zero changes needed).\n');
    return finalizeResult({ exitCode: 0, executed: false, verificationPassed: true });
  }

  // 10. Block BEFORE modifying any file if unsafe conditions were detected
  if (isBlocked) {
    logger.error('\n[REPAIR BLOCKED] Stopping before creating backups or modifying any files:');
    for (const b of blockers) {
      logger.error(`   - ${redact(b)}`);
    }
    logger.log('');
    return finalizeResult({ exitCode: 1, executed: false, verificationPassed: null });
  }

  // 11. Handle DRY_RUN mode (default — zero file mutations)
  if (mode === 'DRY_RUN') {
    if (warnings.length > 0) {
      logger.log('\nWarnings:');
      for (const w of warnings) logger.warn(`   - ${redact(w)}`);
    }
    if (!hasFileMutationsPlanned) {
      logger.log('\n[DRY-RUN] All local environment files are already clean (0 file changes planned).');
      if (shellOverrides.length > 0) {
        logger.log('   Clear the reported PowerShell overrides manually, then re-run `npm run db:setup:check`.');
      }
      logger.log('');
      return finalizeResult({ exitCode: 0, executed: false, verificationPassed: null });
    }

    logger.log('\n[DRY-RUN COMPLETE] Zero files, backups, containers, or volumes were modified.');
    logger.log(
      `   To execute this repair safely with automatic backups, run:\n   npm run db:repair:local -- ${REQUIRED_REPAIR_CONFIRMATION_FLAG}\n`
    );
    return finalizeResult({ exitCode: 0, executed: false, verificationPassed: null });
  }

  // 12. CONFIRMED REPAIR EXECUTION (mode === 'REPAIR')
  if (!hasFileMutationsPlanned) {
    logger.log('\n[REPAIR NO-OP] All local environment files are already valid and clean. Zero files modified; zero backups created.\n');
    return finalizeResult({ exitCode: 0, executed: false, verificationPassed: true });
  }

  // Build ordered list of file writes
  interface PendingFileWrite {
    label: '.env' | '.env.integration-test' | '.env.staging';
    filePath: string;
    content: string;
    existedBefore: boolean;
    backupPath: string | null;
  }

  const timestamp = formatBackupTimestamp(now());
  const pendingWrites: PendingFileWrite[] = [];

  if (plannedMainEnvContent !== null) {
    pendingWrites.push({
      label: '.env',
      filePath: envPath,
      content: plannedMainEnvContent,
      existedBefore: true,
      backupPath: path.join(projectRoot, `.env.backup.${timestamp}`),
    });
  }
  if (plannedIntegrationEnvContent !== null) {
    pendingWrites.push({
      label: '.env.integration-test',
      filePath: integrationEnvPath,
      content: plannedIntegrationEnvContent,
      existedBefore: !integrationActionWillCreate,
      backupPath: integrationActionWillCreate
        ? null
        : path.join(projectRoot, `.env.integration-test.backup.${timestamp}`),
    });
  }
  if (plannedStagingEnvContent !== null) {
    pendingWrites.push({
      label: '.env.staging',
      filePath: stagingEnvPath,
      content: plannedStagingEnvContent,
      existedBefore: false,
      backupPath: null,
    });
  }

  // Phase A: Create ALL backups BEFORE mutating ANY target file
  logger.log('\n6. Creating Pre-Repair Backups:');
  try {
    for (const item of pendingWrites) {
      if (item.existedBefore && item.backupPath) {
        createBackup(item.filePath, item.backupPath);
        backups.push({ file: item.label, backupPath: item.backupPath });
        logger.log(`   - Backed up ${item.label} -> ${path.basename(item.backupPath)}`);
      }
    }
    if (backups.length === 0) {
      logger.log('   - No existing files required modification (new file creation only).');
    }
  } catch (err) {
    const errMsg = redact(err instanceof Error ? err.message : String(err));
    const blockerMsg = `Backup creation failed before modifying any files: ${errMsg}. Aborting repair with zero changes to live environment files.`;
    blockers.push(blockerMsg);
    logger.error(`   - [ABORTED] ${blockerMsg}`);
    return finalizeResult({ exitCode: 1, executed: false, verificationPassed: false });
  }

  // Phase B: Atomic writes with rollback on mid-flight failure
  logger.log('\n7. Applying Atomic File Repairs:');
  const completedWrites: PendingFileWrite[] = [];
  try {
    for (const item of pendingWrites) {
      writeFileAtomically(item.filePath, item.content);
      completedWrites.push(item);
      if (item.existedBefore) {
        modifiedFiles.push(item.label);
        logger.log(`   - Updated ${item.label} atomically`);
      } else {
        createdFiles.push(item.label);
        logger.log(`   - Created ${item.label} atomically`);
      }
    }
  } catch (err) {
    const errMsg = redact(err instanceof Error ? err.message : String(err));
    logger.error(`   - [WRITE FAILURE] Atomic write failed: ${errMsg}. Attempting rollback from backups...`);

    // Best-effort rollback of any files written earlier in this batch
    for (const done of completedWrites.reverse()) {
      try {
        if (done.existedBefore && done.backupPath && fs.existsSync(done.backupPath)) {
          const originalBytes = fs.readFileSync(done.backupPath, 'utf-8');
          writeFileAtomicallyStrict(done.filePath, originalBytes);
          logger.log(`   - Rolled back ${done.label} from ${path.basename(done.backupPath)}`);
        } else if (!done.existedBefore && fs.existsSync(done.filePath)) {
          fs.unlinkSync(done.filePath);
          logger.log(`   - Removed newly created ${done.label} during rollback`);
        }
      } catch (rbErr) {
        const rbMsg = redact(rbErr instanceof Error ? rbErr.message : String(rbErr));
        warnings.push(`Rollback of ${done.label} encountered an error: ${rbMsg}`);
      }
    }

    modifiedFiles.length = 0;
    createdFiles.length = 0;
    blockers.push(`Atomic write failed during repair: ${errMsg}`);
    return finalizeResult({ exitCode: 1, executed: false, verificationPassed: false });
  }

  // Phase C: Post-write file verification (re-read from disk and validate all 5 file targets)
  logger.log('\n8. Verifying Repaired Files on Disk:');
  const silentLogger: RepairLogger = { log: () => {}, warn: () => {}, error: () => {} };
  const postVerify = await runDatabaseEnvironmentSetup({
    projectRoot,
    checkOnly: true,
    shellEnv: {},
    logger: silentLogger,
    inspectDockerVolumes: async () =>
      docker.available ? docker.volumes.map((v) => v.name) : null,
  });

  if (postVerify.exitCode !== 0) {
    for (const issue of postVerify.issues) {
      blockers.push(`Post-repair verification issue: ${redact(issue)}`);
    }
    logger.error('   - [VERIFICATION FAILED] Resulting files failed five-environment validation:');
    for (const issue of postVerify.issues) {
      logger.error(`       * ${redact(issue)}`);
    }
    return finalizeResult({ exitCode: 1, executed: true, verificationPassed: false });
  }

  logger.log('   - Verified: .env, .env.integration-test, and .env.staging pass five-environment isolation checks.');
  logger.log('   - Verified: Zero containers, volumes, databases, or biometric bridge files were modified.');

  if (shellOverrides.length > 0) {
    logger.log('\n[REPAIR COMPLETE — MANUAL SHELL CLEANUP REMAINING]');
    logger.log(
      '   Local environment files are repaired and verified. Clear the reported PowerShell environment overrides manually, then run `npm run db:setup:check`.\n'
    );
  } else {
    logger.log('\n[REPAIR COMPLETE] Local database environment files repaired and verified successfully.\n');
  }

  return finalizeResult({ exitCode: 0, executed: true, verificationPassed: true });
}
