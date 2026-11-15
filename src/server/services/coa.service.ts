import { prisma } from '../db/client.js';
import {
  AccountRootType,
  BalanceType,
  AccountGroupItem,
  AccountLedgerItem,
  CreateAccountGroupRequest,
  CreateAccountLedgerRequest,
  UpdateAccountLedgerRequest,
  SuggestedLedgerCodeResponse,
  AuthUser,
} from '../../shared/types.js';
import { AccountingMath } from '../accounting/decimal-math.js';
import { AuditService } from './audit.service.js';
import { CompanyService } from './company.service.js';
import { getDefaultAccountNature } from '../../shared/account-nature.js';
import {
  AccountGroupCodeRef,
  getAllowedCodeRangeLabel,
  getDefaultRootCodeForType,
  suggestNextLedgerCode,
  validateLedgerCodeForGroup,
} from '../../shared/account-code.js';

const companyLedgerCreationLocks = new Map<string, Promise<unknown>>();

async function withCompanyLedgerLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const prev = companyLedgerCreationLocks.get(companyId) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate, () => gate);
  companyLedgerCreationLocks.set(companyId, chained);

  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (companyLedgerCreationLocks.get(companyId) === chained) {
      companyLedgerCreationLocks.delete(companyId);
    }
  }
}

function isPrismaUniqueConstraintError(err: unknown): err is { code: string; meta?: { target?: unknown } } {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002');
}

function getUniqueConstraintTarget(err: { meta?: { target?: unknown } }): string[] {
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.map((t) => String(t).toLowerCase());
  if (typeof target === 'string') return [target.toLowerCase()];
  return [];
}

export class CoaService {
  /**
   * Initializes standard root account groups for a company if they do not exist
   * Includes standard root types and the Employees parent group requested in Phase 4 Section 2
   */
  static async ensureDefaultGroups(companyId: string): Promise<void> {
    const existingCount = await prisma.accountGroup.count({
      where: { companyId },
    });

    if (existingCount > 0) return;

    // Create 5 standard root groups + Employees sub-group
    const rootGroups: Array<{ code: string; name: string; rootType: AccountRootType }> = [
      { code: '1000', name: 'Assets', rootType: 'ASSET' },
      { code: '2000', name: 'Liabilities', rootType: 'LIABILITY' },
      { code: '3000', name: 'Equity', rootType: 'EQUITY' },
      { code: '4000', name: 'Income', rootType: 'INCOME' },
      { code: '5000', name: 'Expenses', rootType: 'EXPENSE' },
    ];

    await prisma.$transaction(async (tx) => {
      const createdGroups = new Map<string, string>();

      for (const g of rootGroups) {
        const created = await tx.accountGroup.create({
          data: {
            companyId,
            code: g.code,
            name: g.name,
            rootType: g.rootType,
            isSystem: true,
          },
        });
        createdGroups.set(g.name, created.id);
      }

      // Prepare Employees parent group under Liabilities (for future payroll payable and advances)
      const liabilitiesId = createdGroups.get('Liabilities');
      if (liabilitiesId) {
        await tx.accountGroup.create({
          data: {
            companyId,
            code: '2100',
            name: 'Employees & Payroll',
            rootType: 'LIABILITY',
            parentGroupId: liabilitiesId,
            isSystem: true,
          },
        });
      }
    });
  }

  /**
   * Lists all account groups for the authenticated company
   */
  static async listGroups(companyId: string): Promise<AccountGroupItem[]> {
    await this.ensureDefaultGroups(companyId);

    const groups = await prisma.accountGroup.findMany({
      where: { companyId },
      include: { parentGroup: { select: { name: true } } },
      orderBy: [{ rootType: 'asc' }, { code: 'asc' }],
    });

    return groups.map((g) => ({
      id: g.id,
      companyId: g.companyId,
      code: g.code,
      name: g.name,
      rootType: g.rootType,
      parentGroupId: g.parentGroupId,
      parentGroupName: g.parentGroup?.name || null,
      isSystem: g.isSystem,
      createdAt: g.createdAt.toISOString(),
    }));
  }

  /**
   * Creates a custom account group or sub-group
   */
  static async createGroup(
    actor: AuthUser,
    input: CreateAccountGroupRequest,
    correlationId?: string
  ): Promise<AccountGroupItem> {
    const code = input.code.trim();
    const name = input.name.trim();

    if (!code || !name) {
      const err = new Error('Group code and name are required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check unique code & name within company
    const existing = await prisma.accountGroup.findFirst({
      where: {
        companyId: actor.companyId,
        OR: [{ code }, { name }],
      },
    });

    if (existing) {
      const err = new Error(`An account group with code "${code}" or name "${name}" already exists.`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    // If parent group specified, ensure it belongs to the same company and matches rootType
    if (input.parentGroupId) {
      const parent = await prisma.accountGroup.findUnique({
        where: { id: input.parentGroupId },
      });

      if (!parent || parent.companyId !== actor.companyId) {
        const err = new Error('Specified parent group not found in this company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      if (parent.rootType !== input.rootType) {
        const err = new Error(
          `Sub-group root type "${input.rootType}" must match parent group root type "${parent.rootType}".`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    const group = await prisma.accountGroup.create({
      data: {
        companyId: actor.companyId,
        code,
        name,
        rootType: input.rootType,
        parentGroupId: input.parentGroupId || null,
        isSystem: false,
      },
      include: { parentGroup: { select: { name: true } } },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'ACCOUNT_GROUP_CREATED',
      entity: 'AccountGroup',
      entityId: group.id,
      severity: 'INFO',
      correlationId,
      metadata: { code: group.code, name: group.name, rootType: group.rootType },
    });

    return {
      id: group.id,
      companyId: group.companyId,
      code: group.code,
      name: group.name,
      rootType: group.rootType,
      parentGroupId: group.parentGroupId,
      parentGroupName: group.parentGroup?.name || null,
      isSystem: group.isSystem,
      createdAt: group.createdAt.toISOString(),
    };
  }

  /**
   * Lists all ledgers for a company with optional search, group filter, and active filter
   */
  static async listLedgers(
    companyId: string,
    filters?: { groupId?: string; rootType?: AccountRootType; isActive?: boolean; search?: string }
  ): Promise<AccountLedgerItem[]> {
    await this.ensureDefaultGroups(companyId);

    const where: {
      companyId: string;
      groupId?: string;
      isActive?: boolean;
      group?: { rootType: AccountRootType };
      OR?: Array<{ name?: { contains: string; mode: 'insensitive' }; code?: { contains: string; mode: 'insensitive' } }>;
    } = {
      companyId,
    };

    if (filters?.groupId) where.groupId = filters.groupId;
    if (filters?.isActive !== undefined) where.isActive = filters.isActive;
    if (filters?.rootType) where.group = { rootType: filters.rootType };

    if (filters?.search && filters.search.trim()) {
      const term = filters.search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { code: { contains: term, mode: 'insensitive' } },
      ];
    }

    const ledgers = await prisma.accountLedger.findMany({
      where,
      include: {
        group: { select: { name: true, rootType: true } },
      },
      orderBy: [{ group: { rootType: 'asc' } }, { name: 'asc' }],
    });

    return ledgers.map((l) => ({
      id: l.id,
      companyId: l.companyId,
      groupId: l.groupId,
      groupName: l.group.name,
      rootType: l.group.rootType,
      code: l.code,
      name: l.name,
      description: l.description,
      currency: l.currency,
      isActive: l.isActive,
      openingBalance: AccountingMath.format(l.openingBalance),
      openingBalanceType: l.openingBalanceType,
      employeeId: l.employeeId,
      createdAt: l.createdAt.toISOString(),
    }));
  }

  /**
   * Derives default account nature from the Account Group and rejects any client-submitted mismatch.
   */
  static resolveAndValidateLedgerNature(
    group: { code?: string | null; name: string; rootType: AccountRootType },
    submittedNature?: unknown
  ): BalanceType {
    const derivedNature = getDefaultAccountNature(group);

    if (
      submittedNature !== undefined &&
      submittedNature !== null &&
      String(submittedNature).trim() !== ''
    ) {
      const normalizedSubmitted = String(submittedNature).trim().toUpperCase();
      if (normalizedSubmitted !== 'DEBIT' && normalizedSubmitted !== 'CREDIT') {
        const err = new Error(
          `Invalid account nature "${String(submittedNature)}". Account nature for "${group.name}" is automatically derived as ${derivedNature}.`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (normalizedSubmitted !== derivedNature) {
        const err = new Error(
          `Account nature "${normalizedSubmitted}" is not allowed for account group "${group.name}" (${group.rootType}). Default nature must be ${derivedNature}.`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    return derivedNature;
  }

  /**
   * Queries all AccountGroups and existing ledger codes for a company safely
   */
  private static async getCompanyCodeContext(
    companyId: string,
    fallbackGroup: AccountGroupCodeRef
  ): Promise<{ allGroups: AccountGroupCodeRef[]; existingLedgerCodes: string[] }> {
    const rawGroups =
      typeof prisma.accountGroup?.findMany === 'function'
        ? await prisma.accountGroup.findMany({
            where: { companyId },
            select: { id: true, code: true, name: true, rootType: true, parentGroupId: true },
          })
        : null;
    const allGroups: AccountGroupCodeRef[] =
      Array.isArray(rawGroups) && rawGroups.length > 0 ? rawGroups : [fallbackGroup];

    const rawLedgers =
      typeof prisma.accountLedger?.findMany === 'function'
        ? await prisma.accountLedger.findMany({
            where: { companyId, code: { not: null } },
            select: { code: true },
          })
        : null;
    const existingLedgerCodes: string[] = Array.isArray(rawLedgers)
      ? rawLedgers
          .map((l) => l.code)
          .filter((c): c is string => Boolean(c && c.trim()))
      : [];

    return { allGroups, existingLedgerCodes };
  }

  /**
   * Suggests the next available ledger code for the given Account Group
   */
  static async suggestNextCode(
    companyId: string,
    groupId: string
  ): Promise<SuggestedLedgerCodeResponse> {
    if (!groupId || !groupId.trim()) {
      const err = new Error('Account group is required to suggest a ledger code.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    await this.ensureDefaultGroups(companyId);

    const group = await prisma.accountGroup.findUnique({
      where: { id: groupId },
    });

    if (!group || group.companyId !== companyId) {
      const err = new Error('Target account group not found in this company.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const { allGroups, existingLedgerCodes } = await this.getCompanyCodeContext(companyId, group);
    const suggestedCode = suggestNextLedgerCode({
      targetGroup: group,
      allGroups,
      existingLedgerCodes,
    });
    const allowedRangeLabel = getAllowedCodeRangeLabel(group, allGroups);

    return {
      groupId: group.id,
      groupCode: group.code || getDefaultRootCodeForType(group.rootType),
      groupName: group.name,
      suggestedCode,
      allowedRangeLabel,
    };
  }

  /**
   * Creates a new individual general ledger under an authorized AccountGroup
   * Supports unlimited practical ledgers per group, auto-suggested codes, manual code validation,
   * and concurrency-safe unique code allocation.
   */
  static async createLedger(
    actor: AuthUser,
    input: CreateAccountLedgerRequest,
    correlationId?: string
  ): Promise<AccountLedgerItem> {
    const name = input.name.trim();
    const rawCode = input.code ? input.code.trim() : '';
    const isAutoCode = !rawCode || input.codeSource === 'AUTO';

    if (!name) {
      const err = new Error('Ledger name is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!input.groupId || !String(input.groupId).trim()) {
      const err = new Error('Account group is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Verify parent group exists and belongs to actor's company
    const group = await prisma.accountGroup.findUnique({
      where: { id: input.groupId },
    });

    if (!group || group.companyId !== actor.companyId) {
      const err = new Error('Target account group not found in this company.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const openingBalance = AccountingMath.from(input.openingBalance || '0');
    const openingBalanceType = this.resolveAndValidateLedgerNature(group, input.openingBalanceType);

    // Safeguard: if employeeId is specified, ensure it isn't linked to another ledger
    if (input.employeeId) {
      const existingEmployeeLedger = await prisma.accountLedger.findFirst({
        where: {
          companyId: actor.companyId,
          employeeId: input.employeeId,
        },
      });

      if (existingEmployeeLedger) {
        const err = new Error('This employee is already linked to another accounting ledger.');
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }
    }

    const currency =
      input.currency?.trim().toUpperCase() ||
      (await CompanyService.getBaseCurrency(actor.companyId));

    return withCompanyLedgerLock(actor.companyId, async () => {
      const MAX_AUTO_ATTEMPTS = isAutoCode ? 8 : 1;

      for (let attempt = 1; attempt <= MAX_AUTO_ATTEMPTS; attempt += 1) {
        const { allGroups, existingLedgerCodes } = await this.getCompanyCodeContext(
          actor.companyId,
          group
        );

        let resolvedCode: string;
        if (isAutoCode) {
          if (attempt === 1 && rawCode) {
            const validation = validateLedgerCodeForGroup({
              code: rawCode,
              targetGroup: group,
              allGroups,
            });
            if (!validation.valid) {
              const err = new Error(validation.error || 'Invalid ledger code for selected Account Group.');
              (err as { statusCode?: number }).statusCode = 400;
              throw err;
            }
            const usedSet = new Set(existingLedgerCodes.map((c) => c.toUpperCase()));
            resolvedCode = usedSet.has(validation.normalizedCode.toUpperCase())
              ? suggestNextLedgerCode({
                  targetGroup: group,
                  allGroups,
                  existingLedgerCodes,
                })
              : validation.normalizedCode;
          } else {
            resolvedCode = suggestNextLedgerCode({
              targetGroup: group,
              allGroups,
              existingLedgerCodes,
            });
          }
        } else {
          const validation = validateLedgerCodeForGroup({
            code: rawCode,
            targetGroup: group,
            allGroups,
          });
          if (!validation.valid) {
            const err = new Error(validation.error || 'Invalid ledger code for selected Account Group.');
            (err as { statusCode?: number }).statusCode = 400;
            throw err;
          }
          resolvedCode = validation.normalizedCode;
        }

        // Pre-check duplicate name or code within company
        const existing = await prisma.accountLedger.findFirst({
          where: {
            companyId: actor.companyId,
            OR: [{ name }, { code: resolvedCode }],
          },
        });

        if (existing) {
          const existingCodeMatches =
            existing.code && existing.code.toUpperCase() === resolvedCode.toUpperCase();
          if (existingCodeMatches && isAutoCode && attempt < MAX_AUTO_ATTEMPTS && existing.name !== name) {
            continue;
          }
          if (existing.name === name) {
            const err = new Error(`A ledger with name "${name}" already exists in this company.`);
            (err as { statusCode?: number }).statusCode = 409;
            throw err;
          }
          const err = new Error(
            `Ledger code "${resolvedCode}" already exists in this company. Please choose another code.`
          );
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }

        try {
          const ledger = await prisma.accountLedger.create({
            data: {
              companyId: actor.companyId,
              groupId: input.groupId,
              code: resolvedCode,
              name,
              description: input.description?.trim() || null,
              currency,
              openingBalance: openingBalance.toString(),
              openingBalanceType,
              employeeId: input.employeeId || null,
              isActive: true,
            },
            include: { group: { select: { name: true, rootType: true } } },
          });

          await AuditService.log({
            companyId: actor.companyId,
            userId: actor.id,
            action: 'ACCOUNT_LEDGER_CREATED',
            entity: 'AccountLedger',
            entityId: ledger.id,
            severity: 'INFO',
            correlationId,
            metadata: {
              name: ledger.name,
              code: ledger.code,
              group: ledger.group.name,
              openingBalance: ledger.openingBalance.toString(),
              openingBalanceType: ledger.openingBalanceType,
            },
          });

          return {
            id: ledger.id,
            companyId: ledger.companyId,
            groupId: ledger.groupId,
            groupName: ledger.group.name,
            rootType: ledger.group.rootType,
            code: ledger.code,
            name: ledger.name,
            description: ledger.description,
            currency: ledger.currency,
            isActive: ledger.isActive,
            openingBalance: AccountingMath.format(ledger.openingBalance),
            openingBalanceType: ledger.openingBalanceType,
            employeeId: ledger.employeeId,
            createdAt: ledger.createdAt.toISOString(),
          };
        } catch (err) {
          if (isPrismaUniqueConstraintError(err)) {
            const target = getUniqueConstraintTarget(err);
            const isNameConflict = target.includes('name') && !target.includes('code');
            const isEmployeeConflict = target.includes('employeeid') || target.includes('employee_id');

            if (isEmployeeConflict) {
              const conflictErr = new Error('This employee is already linked to another accounting ledger.');
              (conflictErr as { statusCode?: number }).statusCode = 409;
              throw conflictErr;
            }

            if (isNameConflict) {
              const conflictErr = new Error(`A ledger with name "${name}" already exists in this company.`);
              (conflictErr as { statusCode?: number }).statusCode = 409;
              throw conflictErr;
            }

            if (isAutoCode && attempt < MAX_AUTO_ATTEMPTS) {
              // Verify name wasn't the colliding column when mock omits meta.target
              const nameExists = await prisma.accountLedger.findFirst({
                where: { companyId: actor.companyId, name },
              });
              if (nameExists) {
                const conflictErr = new Error(`A ledger with name "${name}" already exists in this company.`);
                (conflictErr as { statusCode?: number }).statusCode = 409;
                throw conflictErr;
              }
              continue;
            }

            const conflictErr = new Error(
              `Ledger code "${resolvedCode}" or name "${name}" already exists in this company.`
            );
            (conflictErr as { statusCode?: number }).statusCode = 409;
            throw conflictErr;
          }
          throw err;
        }
      }

      const exhaustErr = new Error(
        'Unable to allocate a unique ledger code due to concurrent ledger creation. Please try again.'
      );
      (exhaustErr as { statusCode?: number }).statusCode = 409;
      throw exhaustErr;
    });
  }

  /**
   * Updates an existing ledger
   */
  static async updateLedger(
    actor: AuthUser,
    ledgerId: string,
    input: UpdateAccountLedgerRequest,
    correlationId?: string
  ): Promise<AccountLedgerItem> {
    const ledger = await prisma.accountLedger.findUnique({
      where: { id: ledgerId },
      include: { group: true },
    });

    if (!ledger || ledger.companyId !== actor.companyId) {
      const err = new Error('Ledger not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const updates: {
      name?: string;
      code?: string | null;
      description?: string | null;
      currency?: string;
      groupId?: string;
      openingBalance?: string;
      openingBalanceType?: BalanceType;
    } = {};

    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (!trimmedName) {
        const err = new Error('Ledger name cannot be empty.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmedName !== ledger.name && typeof prisma.accountLedger?.findFirst === 'function') {
        const duplicateName = await prisma.accountLedger.findFirst({
          where: {
            companyId: actor.companyId,
            name: trimmedName,
            id: { not: ledgerId },
          },
        });
        if (duplicateName) {
          const err = new Error(`A ledger with name "${trimmedName}" already exists in this company.`);
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
      }
      updates.name = trimmedName;
    }
    if (input.description !== undefined) updates.description = input.description?.trim() || null;
    if (input.currency) updates.currency = input.currency.trim();
    if (input.openingBalance !== undefined) {
      updates.openingBalance = AccountingMath.from(input.openingBalance).toString();
    }

    let targetGroup = ledger.group;
    const groupChanged = Boolean(input.groupId && input.groupId !== ledger.groupId);
    if (groupChanged && input.groupId) {
      const foundGroup = await prisma.accountGroup.findUnique({
        where: { id: input.groupId },
      });
      if (!foundGroup || foundGroup.companyId !== actor.companyId) {
        const err = new Error('Target group not found.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      targetGroup = foundGroup;
      updates.groupId = input.groupId;
    }

    // Validate explicitly provided ledger code change without silently renumbering existing ledgers
    if (input.code !== undefined) {
      const trimmedCode = input.code ? input.code.trim() : '';
      if (!trimmedCode) {
        if (ledger.code) {
          const err = new Error('Existing ledger code cannot be cleared.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
      } else if (trimmedCode !== ledger.code) {
        const { allGroups } = await this.getCompanyCodeContext(actor.companyId, targetGroup);
        const validation = validateLedgerCodeForGroup({
          code: trimmedCode,
          targetGroup,
          allGroups,
        });
        if (!validation.valid) {
          const err = new Error(validation.error || 'Invalid ledger code for selected Account Group.');
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        if (typeof prisma.accountLedger?.findFirst === 'function') {
          const duplicateCode = await prisma.accountLedger.findFirst({
            where: {
              companyId: actor.companyId,
              code: validation.normalizedCode,
              id: { not: ledgerId },
            },
          });
          if (duplicateCode) {
            const err = new Error(
              `Ledger code "${validation.normalizedCode}" already exists in this company.`
            );
            (err as { statusCode?: number }).statusCode = 409;
            throw err;
          }
        }
        updates.code = validation.normalizedCode;
      }
    }

    // Validate any client-submitted nature against the effective Account Group default
    const derivedNature = this.resolveAndValidateLedgerNature(targetGroup, input.openingBalanceType);

    // Only update openingBalanceType when Account Group changes, and never disrupt existing transactions
    if (groupChanged) {
      if (
        derivedNature !== ledger.openingBalanceType &&
        typeof prisma.journalLine?.count === 'function'
      ) {
        const existingTxCount = await prisma.journalLine.count({
          where: { ledgerId },
        });
        if (existingTxCount > 0) {
          const err = new Error(
            `Cannot move ledger "${ledger.name}" to account group "${targetGroup.name}" because it has ${existingTxCount} existing accounting transaction(s) and changing nature from ${ledger.openingBalanceType} to ${derivedNature} would alter historical financial records.`
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
      }
      updates.openingBalanceType = derivedNature;
    }

    const updated = await prisma.accountLedger.update({
      where: { id: ledgerId },
      data: updates,
      include: { group: { select: { name: true, rootType: true } } },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: 'ACCOUNT_LEDGER_UPDATED',
      entity: 'AccountLedger',
      entityId: ledgerId,
      severity: 'INFO',
      correlationId,
      metadata: { name: updated.name, code: updated.code },
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      groupId: updated.groupId,
      groupName: updated.group.name,
      rootType: updated.group.rootType,
      code: updated.code,
      name: updated.name,
      description: updated.description,
      currency: updated.currency,
      isActive: updated.isActive,
      openingBalance: AccountingMath.format(updated.openingBalance),
      openingBalanceType: updated.openingBalanceType,
      employeeId: updated.employeeId,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  /**
   * Toggles ledger active/inactive status
   * In-use ledgers may be deactivated (which prevents new postings) while preserving historical reporting
   */
  static async toggleLedgerStatus(
    actor: AuthUser,
    ledgerId: string,
    isActive: boolean,
    correlationId?: string
  ): Promise<void> {
    const ledger = await prisma.accountLedger.findUnique({
      where: { id: ledgerId },
    });

    if (!ledger || ledger.companyId !== actor.companyId) {
      const err = new Error('Ledger not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    await prisma.accountLedger.update({
      where: { id: ledgerId },
      data: { isActive },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.id,
      action: isActive ? 'ACCOUNT_LEDGER_ACTIVATED' : 'ACCOUNT_LEDGER_DEACTIVATED',
      entity: 'AccountLedger',
      entityId: ledgerId,
      severity: 'WARN',
      correlationId,
      metadata: { name: ledger.name, status: isActive ? 'ACTIVE' : 'INACTIVE' },
    });
  }
}
