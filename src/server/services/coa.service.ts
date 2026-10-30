import { prisma } from '../db/client.js';
import {
  AccountRootType,
  BalanceType,
  AccountGroupItem,
  AccountLedgerItem,
  CreateAccountGroupRequest,
  CreateAccountLedgerRequest,
  UpdateAccountLedgerRequest,
  AuthUser,
} from '../../shared/types.js';
import { AccountingMath } from '../accounting/decimal-math.js';
import { AuditService } from './audit.service.js';

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
   * Creates a new individual general ledger under an authorized AccountGroup
   */
  static async createLedger(
    actor: AuthUser,
    input: CreateAccountLedgerRequest,
    correlationId?: string
  ): Promise<AccountLedgerItem> {
    const name = input.name.trim();
    const code = input.code ? input.code.trim() : null;

    if (!name) {
      const err = new Error('Ledger name is required.');
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

    // Check duplicate name within company
    const existing = await prisma.accountLedger.findFirst({
      where: {
        companyId: actor.companyId,
        OR: [
          { name },
          ...(code ? [{ code }] : []),
        ],
      },
    });

    if (existing) {
      const err = new Error(
        `A ledger with name "${name}" ${code ? `or code "${code}" ` : ''}already exists in this company.`
      );
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

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

    const openingBalance = AccountingMath.from(input.openingBalance || '0');
    const openingBalanceType: BalanceType = input.openingBalanceType || 'DEBIT';

    const ledger = await prisma.accountLedger.create({
      data: {
        companyId: actor.companyId,
        groupId: input.groupId,
        code,
        name,
        description: input.description?.trim() || null,
        currency: input.currency?.trim() || 'USD',
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

    if (input.name) updates.name = input.name.trim();
    if (input.code !== undefined) updates.code = input.code ? input.code.trim() : null;
    if (input.description !== undefined) updates.description = input.description?.trim() || null;
    if (input.currency) updates.currency = input.currency.trim();
    if (input.openingBalance !== undefined) {
      updates.openingBalance = AccountingMath.from(input.openingBalance).toString();
    }
    if (input.openingBalanceType) updates.openingBalanceType = input.openingBalanceType;

    if (input.groupId && input.groupId !== ledger.groupId) {
      const targetGroup = await prisma.accountGroup.findUnique({
        where: { id: input.groupId },
      });
      if (!targetGroup || targetGroup.companyId !== actor.companyId) {
        const err = new Error('Target group not found.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      updates.groupId = input.groupId;
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
