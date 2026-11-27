import crypto from 'crypto';
import net from 'net';
import type { PrismaClient } from '@prisma/client';

export const INTEGRATION_TEST_PORT = 5434;
export const INTEGRATION_TEST_DB_NAME = 'core_erp_integration_test';
export const APPROVED_INTEGRATION_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Protected database names that integration tests must NEVER target.
 */
export const FORBIDDEN_INTEGRATION_DB_NAMES = new Set([
  'core_erp',
  'core_erp_dev',
  'core_erp_prod',
  'core_erp_test',
  'core_erp_staging',
  'core_erp_shadow',
  'postgres',
  'production',
  'development',
  'staging',
]);

/**
 * Legacy fixed-UUID prefix previously used by unsafe fixtures.
 * Rejected proactively so fixed colliding tenant/user fixtures cannot regress.
 */
const FORBIDDEN_FIXED_UUID_PREFIX = '00000000-0000-4000-a000-';

let globalFixtureSequence = 0;

function nextFixtureSequence(): number {
  globalFixtureSequence += 1;
  return globalFixtureSequence;
}

export interface IntegrationTargetValidationInput {
  integrationMode?: string;
  testDatabaseUrl?: string;
  databaseUrl?: string;
  suiteLabel?: string;
}

export type IntegrationTargetValidationResult =
  | {
      status: 'blocked';
      reason: string;
    }
  | {
      status: 'valid';
      cleanedUrl: string;
      host: string;
      port: number;
      databaseName: string;
    };

/**
 * Strictly validates that integration tests ONLY target the dedicated local
 * PostgreSQL 16 integration database (`localhost` / `127.0.0.1`, port `5434`,
 * database `core_erp_integration_test`) with `COREERP_INTEGRATION_TEST_MODE=true`
 * and `DATABASE_URL` completely unset.
 *
 * Security invariants:
 * - Never includes raw URLs or credentials in error messages.
 * - Throws `[SECURITY FATAL]` on any misconfigured or non-integration target.
 * - Returns `{ status: 'blocked', reason }` only when integration mode is not enabled
 *   or `TEST_DATABASE_URL` is absent.
 */
export function validateIntegrationDatabaseTarget(
  input: IntegrationTargetValidationInput
): IntegrationTargetValidationResult {
  const suiteLabel = input.suiteLabel || 'PostgreSQL 16 integration test';
  const isIntegrationMode = input.integrationMode === 'true';
  const cleanedUrl = input.testDatabaseUrl?.trim().replace(/^["']|["']$/g, '') || '';

  if (!isIntegrationMode || cleanedUrl === '') {
    return {
      status: 'blocked',
      reason:
        `[BLOCKED / NOT RUN] ${suiteLabel} requires explicit ` +
        `COREERP_INTEGRATION_TEST_MODE=true and TEST_DATABASE_URL targeting ` +
        `localhost:${INTEGRATION_TEST_PORT}/${INTEGRATION_TEST_DB_NAME}.`,
    };
  }

  // Reject ANY defined DATABASE_URL in integration mode to prevent split-brain routing.
  if (input.databaseUrl && input.databaseUrl.trim() !== '') {
    throw new Error(
      '[SECURITY FATAL] Integration test refused: Conflicting DATABASE_URL detected in integration test mode. DATABASE_URL must remain unset.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(cleanedUrl);
  } catch {
    throw new Error('[SECURITY FATAL] Invalid database URL format for TEST_DATABASE_URL.');
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      '[SECURITY FATAL] Forbidden database protocol in TEST_DATABASE_URL. PostgreSQL is required.'
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!APPROVED_INTEGRATION_HOSTS.has(host)) {
    throw new Error(
      '[SECURITY FATAL] Integration test refused: Unapproved host in TEST_DATABASE_URL. ' +
        'Remote and production hosts are strictly forbidden. Expected localhost or 127.0.0.1.'
    );
  }

  // Omitting port defaults PostgreSQL to 5432; enforce explicit port 5434.
  const effectivePort = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
  if (!Number.isFinite(effectivePort) || effectivePort !== INTEGRATION_TEST_PORT) {
    throw new Error(
      `[SECURITY FATAL] Integration test refused: Dedicated integration test must run on port ${INTEGRATION_TEST_PORT}.`
    );
  }

  const databaseName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (FORBIDDEN_INTEGRATION_DB_NAMES.has(databaseName.toLowerCase())) {
    throw new Error(
      '[SECURITY FATAL] Integration test refused: Target database matches a protected development, test, staging, shadow, or production database.'
    );
  }

  if (databaseName !== INTEGRATION_TEST_DB_NAME) {
    throw new Error(
      `[SECURITY FATAL] Integration test refused: Dedicated database name must strictly be "${INTEGRATION_TEST_DB_NAME}".`
    );
  }

  return {
    status: 'valid',
    cleanedUrl,
    host,
    port: effectivePort,
    databaseName,
  };
}

/**
 * Probes TCP reachability for the dedicated local integration PostgreSQL endpoint
 * before attempting Prisma `$connect()`.
 */
export function checkTcpPortReachable(
  host: string,
  port: number,
  timeoutMs = 1000
): Promise<{ reachable: boolean; code?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: { reachable: boolean; code?: string }) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true }));
    socket.once('timeout', () => finish({ reachable: false, code: 'TIMEOUT' }));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish({ reachable: false, code: err.code || 'SOCKET_ERROR' })
    );
    socket.connect(port, host);
  });
}

export interface UniqueFixtureIdentifiers {
  runToken: string;
  sequence: number;
  companyId: string;
  companyCode: string;
  userId: string;
  userEmail: string;
  employeeId: string;
  employeeCode: string;
  terminalId: string;
  deviceSerialNumber: string;
}

/**
 * Generates collision-proof, per-run unique identifiers for test-owned fixtures.
 * Uses `crypto.randomUUID()` combined with a monotonic sequence number so rapid
 * sequential or concurrent runs can never collide on IDs, codes, emails, or serials.
 */
export function generateUniqueFixtureIdentifiers(prefix = 'INT'): UniqueFixtureIdentifiers {
  const sanitizedPrefix =
    prefix
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6) || 'INT';
  const sequence = nextFixtureSequence();
  const companyId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const employeeId = crypto.randomUUID();
  const terminalId = crypto.randomUUID();

  const shortToken = `${companyId.slice(0, 8)}-${sequence.toString(36)}`;
  const compactToken = `${companyId.replace(/-/g, '').slice(0, 10)}${sequence.toString(36)}`.toUpperCase();

  return {
    runToken: shortToken,
    sequence,
    companyId,
    companyCode: `${sanitizedPrefix}-${compactToken}`,
    userId,
    userEmail: `${sanitizedPrefix.toLowerCase()}-${userId.slice(0, 8)}-${sequence}@coreerp.local`,
    employeeId,
    employeeCode: `EMP-${employeeId.slice(0, 8)}-${sequence}`,
    terminalId,
    deviceSerialNumber: `INT-${sanitizedPrefix}-${terminalId.slice(0, 8)}-${sequence}`,
  };
}

function assertNotFixedFixtureUuid(id: string, fieldName: string): void {
  if (id.toLowerCase().startsWith(FORBIDDEN_FIXED_UUID_PREFIX)) {
    throw new Error(
      `[FIXTURE SAFETY VIOLATION] Refusing fixed legacy UUID for ${fieldName}. ` +
        'Integration tests must generate unique per-run identifiers.'
    );
  }
}

export interface OwnedCleanupStep {
  label: string;
  run: () => Promise<unknown>;
}

/**
 * Executes an explicit foreign-key-ordered sequence of cleanup operations for a
 * single test-owned tenant. Collects EVERY error instead of swallowing failures
 * or aborting early, and returns the formatted error list.
 */
export async function runOwnedCleanupSteps(
  ownerLabel: string,
  steps: OwnedCleanupStep[]
): Promise<string[]> {
  const errors: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${ownerLabel} -> ${step.label}: ${message}`);
    }
  }
  return errors;
}

/**
 * Safely disconnects one or more Prisma clients independently and collects any
 * disconnect errors rather than swallowing them in empty `catch {}` blocks.
 */
export async function disconnectIntegrationClients(
  clients: Array<{
    label: string;
    client: Pick<PrismaClient, '$disconnect'> | null | undefined;
  }>
): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of clients) {
    if (!entry.client) continue;
    try {
      await entry.client.$disconnect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${entry.label}.$disconnect failed: ${message}`);
    }
  }
  return errors;
}

/**
 * Throws a consolidated `[INTEGRATION CLEANUP FAILED]` error whenever any
 * fixture deletion or client disconnect error occurred.
 */
export function throwIfCleanupErrors(errors: string[], contextLabel?: string): void {
  if (errors.length === 0) return;
  const header = contextLabel
    ? `[INTEGRATION CLEANUP FAILED] (${contextLabel}) ${errors.length} error(s) occurred while cleaning up test fixtures:`
    : `[INTEGRATION CLEANUP FAILED] ${errors.length} error(s) occurred while cleaning up test fixtures:`;
  throw new Error(`${header}\n${errors.map((e) => `  - ${e}`).join('\n')}`);
}

export interface FixturePrismaSubset {
  company: {
    create: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<any>;
  };
  user: {
    create: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<any>;
  };
  companyBankAccount?: {
    create: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<any>;
  };
  biometricTerminal?: {
    create: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<any>;
  };
  employee?: {
    create: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<any>;
  };
  shift?: {
    create: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<any>;
  };
  rawPunchLog?: {
    create?: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<any>;
  };
  companySetting?: {
    deleteMany: (args: any) => Promise<any>;
  };
  companySettingsChangeRequest?: {
    deleteMany: (args: any) => Promise<any>;
  };
  attendanceInterval?: {
    deleteMany: (args: any) => Promise<any>;
  };
  attendancePunchEvent?: {
    deleteMany: (args: any) => Promise<any>;
  };
  attendance?: {
    deleteMany: (args: any) => Promise<any>;
  };
  payslip?: {
    deleteMany: (args: any) => Promise<any>;
  };
  payrollPeriod?: {
    deleteMany: (args: any) => Promise<any>;
  };
  rolePermission?: {
    deleteMany: (args: any) => Promise<any>;
  };
  employeeWorkPolicyRevision?: {
    deleteMany: (args: any) => Promise<any>;
  };
  auditLog?: {
    deleteMany: (args: any) => Promise<any>;
  };
}

export interface CreateCompanyFixtureInput {
  id?: string;
  code?: string;
  name: string;
  legalName?: string;
  currency?: string;
  timezone?: string;
}

export interface CreateUserFixtureInput {
  id?: string;
  companyId: string;
  email?: string;
  fullName: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'VICE_ADMIN' | 'EMPLOYEE';
  passwordHash?: string;
  isActive?: boolean;
  tokenVersion?: number;
}

export interface CreateBankAccountFixtureInput {
  id?: string;
  companyId: string;
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface CreateBiometricTerminalFixtureInput {
  id?: string;
  companyId: string;
  deviceSerialNumber?: string;
  name: string;
  terminalModel?: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
  registeredByUserId: string;
  isActive?: boolean;
}

export interface CleanupScopeOptions {
  /**
   * Include service-generated side-effect tables (such as `auditLog`, `companySetting`,
   * `rawPunchLog`, `attendance*`, etc.) scoped strictly to the newly created owned
   * `companyIds`. Defaults to `true`.
   */
  includeOwnedTenantSideEffects?: boolean;
  /**
   * If true, returns collected errors instead of throwing immediately so callers
   * (e.g. `afterAll`) can merge them with disconnect errors before throwing.
   * Defaults to `false` (throws immediately on any cleanup failure).
   */
  returnErrors?: boolean;
}

/**
 * Ownership-tracked fixture scope for a single integration test (or isolated
 * sub-scenario). Guarantees:
 * 1. Every created fixture uses unique generated identifiers (never fixed IDs).
 * 2. Fixtures are created via `.create()` (never `.upsert()` reusing pre-existing data).
 * 3. Ownership is recorded immediately so partial fixture creation failures still
 *    clean up already-created records cleanly.
 * 4. Cleanup deletes ONLY records owned by this scope in explicit foreign-key-safe
 *    order, NEVER performs pre-test destructive deletes, NEVER truncates tables,
 *    and NEVER swallows cleanup errors.
 */
export class IntegrationFixtureScope {
  readonly label: string;
  readonly tokens: UniqueFixtureIdentifiers;

  private readonly ownedCompanyIds = new Set<string>();
  private readonly ownedUserIds = new Set<string>();
  private readonly ownedBankAccountIds = new Set<string>();
  private readonly ownedTerminalIds = new Set<string>();
  private readonly ownedEmployeeIds = new Set<string>();
  private readonly ownedShiftIds = new Set<string>();
  private readonly ownedRawPunchLogIds = new Set<string>();

  constructor(prefix = 'INT', label?: string) {
    this.tokens = generateUniqueFixtureIdentifiers(prefix);
    this.label = label || `${prefix}:${this.tokens.runToken}`;
  }

  getTrackedSnapshot() {
    return {
      companyIds: Array.from(this.ownedCompanyIds),
      userIds: Array.from(this.ownedUserIds),
      bankAccountIds: Array.from(this.ownedBankAccountIds),
      terminalIds: Array.from(this.ownedTerminalIds),
      employeeIds: Array.from(this.ownedEmployeeIds),
      shiftIds: Array.from(this.ownedShiftIds),
      rawPunchLogIds: Array.from(this.ownedRawPunchLogIds),
    };
  }

  hasTrackedRecords(): boolean {
    return (
      this.ownedCompanyIds.size > 0 ||
      this.ownedUserIds.size > 0 ||
      this.ownedBankAccountIds.size > 0 ||
      this.ownedTerminalIds.size > 0 ||
      this.ownedEmployeeIds.size > 0 ||
      this.ownedShiftIds.size > 0 ||
      this.ownedRawPunchLogIds.size > 0
    );
  }

  trackCompanyId(id: string): void {
    assertNotFixedFixtureUuid(id, 'company.id');
    this.ownedCompanyIds.add(id);
  }

  trackUserId(id: string): void {
    assertNotFixedFixtureUuid(id, 'user.id');
    this.ownedUserIds.add(id);
  }

  trackBankAccountId(id: string): void {
    assertNotFixedFixtureUuid(id, 'companyBankAccount.id');
    this.ownedBankAccountIds.add(id);
  }

  trackTerminalId(id: string): void {
    assertNotFixedFixtureUuid(id, 'biometricTerminal.id');
    this.ownedTerminalIds.add(id);
  }

  trackEmployeeId(id: string): void {
    assertNotFixedFixtureUuid(id, 'employee.id');
    this.ownedEmployeeIds.add(id);
  }

  trackShiftId(id: string): void {
    assertNotFixedFixtureUuid(id, 'shift.id');
    this.ownedShiftIds.add(id);
  }

  trackRawPunchLogId(id: string): void {
    assertNotFixedFixtureUuid(id, 'rawPunchLog.id');
    this.ownedRawPunchLogIds.add(id);
  }

  async createCompany<T = any>(
    client: FixturePrismaSubset,
    input: CreateCompanyFixtureInput
  ): Promise<T> {
    const id = input.id ?? (this.ownedCompanyIds.size === 0 ? this.tokens.companyId : crypto.randomUUID());
    assertNotFixedFixtureUuid(id, 'company.id');
    const code =
      input.code ??
      (this.ownedCompanyIds.size === 0
        ? this.tokens.companyCode
        : `${this.tokens.companyCode.split('-')[0]}-${id.replace(/-/g, '').slice(0, 10).toUpperCase()}`);

    const created = await client.company.create({
      data: {
        id,
        code,
        name: input.name,
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        currency: input.currency ?? 'USD',
        timezone: input.timezone ?? 'UTC',
      },
    });
    this.ownedCompanyIds.add(created?.id ?? id);
    return created;
  }

  async createUser<T = any>(
    client: FixturePrismaSubset,
    input: CreateUserFixtureInput
  ): Promise<T> {
    const id = input.id ?? (this.ownedUserIds.size === 0 ? this.tokens.userId : crypto.randomUUID());
    assertNotFixedFixtureUuid(id, 'user.id');
    const email =
      input.email ??
      (this.ownedUserIds.size === 0
        ? this.tokens.userEmail
        : `user-${id.slice(0, 8)}-${nextFixtureSequence()}@coreerp.local`);

    const created = await client.user.create({
      data: {
        id,
        companyId: input.companyId,
        email,
        fullName: input.fullName,
        role: input.role,
        isActive: input.isActive ?? true,
        ...(input.tokenVersion !== undefined ? { tokenVersion: input.tokenVersion } : {}),
        passwordHash:
          input.passwordHash ?? '$2a$10$abcdefghijklmnopqrstuuNOPASSWORDHASHFORTESTONLY123456',
      },
    });
    this.ownedUserIds.add(created?.id ?? id);
    return created;
  }

  async createCompanyBankAccount<T = any>(
    client: FixturePrismaSubset,
    input: CreateBankAccountFixtureInput
  ): Promise<T> {
    if (!client.companyBankAccount) {
      throw new Error('[FIXTURE ERROR] Prisma client does not expose companyBankAccount delegate.');
    }
    const id = input.id ?? crypto.randomUUID();
    assertNotFixedFixtureUuid(id, 'companyBankAccount.id');

    const created = await client.companyBankAccount.create({
      data: {
        id,
        companyId: input.companyId,
        bankName: input.bankName,
        accountHolderName: input.accountHolderName,
        accountNumber: input.accountNumber,
        isDefault: input.isDefault ?? false,
        isActive: input.isActive ?? true,
      },
    });
    this.ownedBankAccountIds.add(created?.id ?? id);
    return created;
  }

  async createBiometricTerminal<T = any>(
    client: FixturePrismaSubset,
    input: CreateBiometricTerminalFixtureInput
  ): Promise<T> {
    if (!client.biometricTerminal) {
      throw new Error('[FIXTURE ERROR] Prisma client does not expose biometricTerminal delegate.');
    }
    const id = input.id ?? (this.ownedTerminalIds.size === 0 ? this.tokens.terminalId : crypto.randomUUID());
    assertNotFixedFixtureUuid(id, 'biometricTerminal.id');
    const deviceSerialNumber =
      input.deviceSerialNumber ??
      (this.ownedTerminalIds.size === 0
        ? this.tokens.deviceSerialNumber
        : `INT-TERM-${id.slice(0, 8)}-${nextFixtureSequence()}`);

    const created = await client.biometricTerminal.create({
      data: {
        id,
        companyId: input.companyId,
        deviceSerialNumber,
        name: input.name,
        terminalModel: input.terminalModel ?? 'eSSL X2008',
        apiKeyHash: input.apiKeyHash,
        apiKeyPrefix: input.apiKeyPrefix,
        registeredByUserId: input.registeredByUserId,
        isActive: input.isActive ?? true,
      },
    });
    this.ownedTerminalIds.add(created?.id ?? id);
    return created;
  }

  /**
   * Deletes ONLY records owned by this scope in explicit foreign-key-safe order.
   * - Performs zero database operations if no records were tracked.
   * - Never deletes pre-existing unowned records.
   * - Collects all cleanup errors and throws `[INTEGRATION CLEANUP FAILED]`
   *   unless `options.returnErrors === true`.
   */
  async cleanup(
    client: FixturePrismaSubset,
    options: CleanupScopeOptions = {}
  ): Promise<string[]> {
    const includeSideEffects = options.includeOwnedTenantSideEffects !== false;
    const errors: string[] = [];

    if (!this.hasTrackedRecords()) {
      return errors;
    }

    const companyIds = Array.from(this.ownedCompanyIds);
    const bankAccountIds = Array.from(this.ownedBankAccountIds);
    const terminalIds = Array.from(this.ownedTerminalIds);
    const rawPunchLogIds = Array.from(this.ownedRawPunchLogIds);
    const employeeIds = Array.from(this.ownedEmployeeIds);
    const shiftIds = Array.from(this.ownedShiftIds);
    const userIds = Array.from(this.ownedUserIds);

    const runStep = async (
      label: string,
      fn: () => Promise<unknown>,
      onSuccess?: () => void
    ) => {
      try {
        await fn();
        onSuccess?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`scope=${this.label} -> ${label}: ${message}`);
      }
    };

    // 1. Service-generated side-effect rows scoped strictly to freshly created owned companies
    if (includeSideEffects && companyIds.length > 0) {
      if (client.auditLog) {
        await runStep('auditLog.deleteMany(owned companies)', () =>
          client.auditLog!.deleteMany({ where: { companyId: { in: companyIds } } })
        );
      }
      if (client.attendanceInterval) {
        await runStep('attendanceInterval.deleteMany(owned companies)', () =>
          client.attendanceInterval!.deleteMany({ where: { companyId: { in: companyIds } } })
        );
      }
      if (client.attendancePunchEvent) {
        await runStep('attendancePunchEvent.deleteMany(owned companies)', () =>
          client.attendancePunchEvent!.deleteMany({ where: { companyId: { in: companyIds } } })
        );
      }
      if (client.attendance) {
        await runStep('attendance.deleteMany(owned companies)', () =>
          client.attendance!.deleteMany({ where: { companyId: { in: companyIds } } })
        );
      }
      if (client.rawPunchLog) {
        await runStep('rawPunchLog.deleteMany(owned companies)', () =>
          client.rawPunchLog!.deleteMany({ where: { companyId: { in: companyIds } } })
        );
      }
      if (client.payslip) {
        await runStep('payslip.deleteMany(owned companies)', () =>
          client.payslip!.deleteMany({ where: { companyId: { in: companyIds } } })
        );
      }
      if (client.payrollPeriod) {
        await runStep('payrollPeriod.deleteMany(owned companies)', () =>
          client.payrollPeriod!.deleteMany({ where: { companyId: { in: companyIds } } })
        );
      }
      if (client.companySettingsChangeRequest) {
        await runStep('companySettingsChangeRequest.deleteMany(owned companies)', () =>
          client.companySettingsChangeRequest!.deleteMany({
            where: { companyId: { in: companyIds } },
          })
        );
      }
      if (client.companySetting) {
        await runStep('companySetting.deleteMany(owned companies)', () =>
          client.companySetting!.deleteMany({ where: { companyId: { in: companyIds } } })
        );
      }
      if (client.rolePermission) {
        await runStep('rolePermission.deleteMany(owned companies)', () =>
          client.rolePermission!.deleteMany({ where: { companyId: { in: companyIds } } })
        );
      }
      if (client.employeeWorkPolicyRevision) {
        await runStep('employeeWorkPolicyRevision.deleteMany(owned companies)', () =>
          client.employeeWorkPolicyRevision!.deleteMany({
            where: { companyId: { in: companyIds } },
          })
        );
      }
    }

    // 2. Explicitly tracked child records deleted strictly by tracked IDs
    if (rawPunchLogIds.length > 0 && client.rawPunchLog) {
      await runStep(
        'rawPunchLog.deleteMany(tracked ids)',
        () => client.rawPunchLog!.deleteMany({ where: { id: { in: rawPunchLogIds } } }),
        () => this.ownedRawPunchLogIds.clear()
      );
    }

    if (bankAccountIds.length > 0 && client.companyBankAccount) {
      await runStep(
        'companyBankAccount.deleteMany(tracked ids)',
        () => client.companyBankAccount!.deleteMany({ where: { id: { in: bankAccountIds } } }),
        () => this.ownedBankAccountIds.clear()
      );
    }

    if (terminalIds.length > 0 && client.biometricTerminal) {
      await runStep(
        'biometricTerminal.deleteMany(tracked ids)',
        () => client.biometricTerminal!.deleteMany({ where: { id: { in: terminalIds } } }),
        () => this.ownedTerminalIds.clear()
      );
    }

    if (employeeIds.length > 0 && client.employee) {
      await runStep(
        'employee.deleteMany(tracked ids)',
        () => client.employee!.deleteMany({ where: { id: { in: employeeIds } } }),
        () => this.ownedEmployeeIds.clear()
      );
    }

    if (shiftIds.length > 0 && client.shift) {
      await runStep(
        'shift.deleteMany(tracked ids)',
        () => client.shift!.deleteMany({ where: { id: { in: shiftIds } } }),
        () => this.ownedShiftIds.clear()
      );
    }

    if (userIds.length > 0) {
      await runStep(
        'user.deleteMany(tracked ids)',
        () => client.user.deleteMany({ where: { id: { in: userIds } } }),
        () => this.ownedUserIds.clear()
      );
    }

    if (companyIds.length > 0) {
      await runStep(
        'company.deleteMany(tracked ids)',
        () => client.company.deleteMany({ where: { id: { in: companyIds } } }),
        () => this.ownedCompanyIds.clear()
      );
    }

    if (!options.returnErrors) {
      throwIfCleanupErrors(errors, this.label);
    }

    return errors;
  }
}

export function createIntegrationFixtureScope(
  prefix = 'INT',
  label?: string
): IntegrationFixtureScope {
  return new IntegrationFixtureScope(prefix, label);
}
