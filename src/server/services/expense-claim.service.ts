import Decimal from 'decimal.js';
import {
  AuthUser,
  ExpenseCategory,
  ExpenseClaimItem,
  ExpenseClaimStatus,
  ExpensePaymentMethod,
  CreateExpenseClaimRequest,
  UpdateExpenseClaimRequest,
  ReviewExpenseClaimRequest,
  PayExpenseClaimRequest,
  ExpenseSummaryReport,
  ExpenseCapabilitiesResponse,
} from '../../shared/types.js';
import { prisma } from '../db/client.js';
import { AccountingMath } from '../accounting/decimal-math.js';
import { AuditService } from './audit.service.js';
import { DocumentSequenceService } from './document-sequence.service.js';
import { JournalService } from './journal.service.js';
import { PermissionService } from './permission.service.js';

export const formatIsoDate = (d: any): string => {
  if (!d) return new Date().toISOString().slice(0, 10);
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
};

export const formatIsoDateTime = (d: any): string => {
  if (!d) return new Date().toISOString();
  if (typeof d === 'string') return d;
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
};

export class ExpenseClaimService {
  /**
   * Resolves effective RBAC capabilities and employee identity for the Expenses UI
   */
  static async getCapabilities(actor: AuthUser): Promise<ExpenseCapabilitiesResponse> {
    const [
      canManagerApprove,
      canAccountsApprove,
      canViewAccounting,
      canViewCompanyBankAccounts,
      canViewEmployeesPerm,
      currentEmployee,
    ] = await Promise.all([
      PermissionService.hasPermission(actor.companyId, actor.role, 'EXPENSE', 'APPROVE'),
      PermissionService.hasPermission(actor.companyId, actor.role, 'ACCOUNTING', 'APPROVE'),
      PermissionService.hasPermission(actor.companyId, actor.role, 'ACCOUNTING', 'VIEW'),
      PermissionService.hasPermission(actor.companyId, actor.role, 'COMPANY', 'VIEW'),
      PermissionService.hasPermission(actor.companyId, actor.role, 'EMPLOYEE', 'VIEW'),
      this.getEmployeeForUser(actor.companyId, actor.userId || actor.id),
    ]);

    return {
      canManagerApprove,
      canAccountsApprove,
      canViewAccounting,
      canViewCompanyBankAccounts,
      canViewEmployees: canViewEmployeesPerm && actor.role !== 'EMPLOYEE',
      currentEmployeeId: currentEmployee?.id || null,
    };
  }

  /**
   * Helper to resolve the employee record associated with an AuthUser
   */
  static async getEmployeeForUser(companyId: string, userId: string) {
    return prisma.employee.findFirst({
      where: { companyId, userId },
      include: { department: true },
    });
  }

  /**
   * Validates that an explicit AccountLedger belongs to the company, is active, and matches expected rootType
   */
  private static async requireValidLedger(
    companyId: string,
    ledgerId: string,
    expectedRootType: 'ASSET' | 'LIABILITY' | 'EXPENSE',
    fieldName: string
  ) {
    const ledger = await prisma.accountLedger.findFirst({
      where: { id: ledgerId, companyId },
      include: { group: true },
    });

    if (!ledger) {
      const err = new Error(`Invalid ${fieldName}: ledger was not found in this company.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!ledger.isActive) {
      const err = new Error(`Invalid ${fieldName}: ledger "${ledger.name}" is inactive.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (ledger.group?.rootType !== expectedRootType) {
      const err = new Error(
        `Invalid ${fieldName}: ledger "${ledger.name}" must belong to a ${expectedRootType} account group.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    return ledger;
  }

  /**
   * Helper to ensure active default liability and expense ledgers exist
   */
  static async getOrCreateDefaultLedgers(companyId: string, actor: AuthUser) {
    // 1. Find or create Accounts Payable / Reimbursements Payable liability ledger
    let payableLedger = await prisma.accountLedger.findFirst({
      where: {
        companyId,
        isActive: true,
        OR: [
          { name: { contains: 'Reimbursement', mode: 'insensitive' } },
          { name: { contains: 'Accounts Payable', mode: 'insensitive' } },
          { group: { rootType: 'LIABILITY' } },
        ],
      },
      include: { group: true },
    });

    if (!payableLedger) {
      // Find liability group
      let liabilityGroup = await prisma.accountGroup.findFirst({
        where: { companyId, rootType: 'LIABILITY' },
      });

      if (!liabilityGroup) {
        liabilityGroup = await prisma.accountGroup.create({
          data: {
            companyId,
            code: '2100',
            name: 'Current Liabilities',
            rootType: 'LIABILITY',
            isSystem: true,
          },
        });
      }

      payableLedger = await prisma.accountLedger.create({
        data: {
          companyId,
          groupId: liabilityGroup.id,
          code: '2110',
          name: 'Employee Reimbursements Payable',
          description: 'Liabilities for approved employee expense claims awaiting payout',
          isActive: true,
          currency: 'USD',
        },
        include: { group: true },
      });
    }

    // 2. Find or create default Expense ledger
    let expenseLedger = await prisma.accountLedger.findFirst({
      where: {
        companyId,
        isActive: true,
        group: { rootType: 'EXPENSE' },
      },
      include: { group: true },
    });

    if (!expenseLedger) {
      let expenseGroup = await prisma.accountGroup.findFirst({
        where: { companyId, rootType: 'EXPENSE' },
      });

      if (!expenseGroup) {
        expenseGroup = await prisma.accountGroup.create({
          data: {
            companyId,
            code: '5000',
            name: 'Operating Expenses',
            rootType: 'EXPENSE',
            isSystem: true,
          },
        });
      }

      expenseLedger = await prisma.accountLedger.create({
        data: {
          companyId,
          groupId: expenseGroup.id,
          code: '5100',
          name: 'General Operating & Travel Expenses',
          description: 'General employee business expenses',
          isActive: true,
          currency: 'USD',
        },
        include: { group: true },
      });
    }

    return { payableLedger, expenseLedger };
  }

  /**
   * Helper to verify if the accounting period covering the original expense date is open
   */
  static async verifyFiscalPeriodOpen(companyId: string, expenseDate: Date | string) {
    const dateObj = new Date(expenseDate);
    if (isNaN(dateObj.getTime())) {
      const err = new Error('Invalid original expense date format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Look for a covering fiscal period in this company
    const period = await prisma.fiscalPeriod.findFirst({
      where: {
        companyId,
        startDate: { lte: dateObj },
        endDate: { gte: dateObj },
      },
    });

    if (period) {
      if (period.status !== 'OPEN' || period.isLocked) {
        const err = new Error(
          `Cannot process expense claim for date ${dateObj.toISOString().slice(0, 10)}: Linked fiscal period "${period.periodName}" is ${period.status.toLowerCase()}${period.isLocked ? ' and locked' : ''}.`
        );
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    return period;
  }

  /**
   * Allocates the next concurrency-safe claim number (e.g. EXP-2026-00001)
   */
  static async allocateClaimNumber(companyId: string, date: Date | string, tx?: any): Promise<string> {
    try {
      const result = await DocumentSequenceService.allocateNextNumber(companyId, 'EXPENSE_CLAIM', {
        tx,
        date,
      });
      return result.formattedNumber;
    } catch {
      // Fallback if sequence engine encounters unconfigured or missing sequence
      const year = new Date(date).getFullYear() || new Date().getFullYear();
      const count = await prisma.expenseClaim.count({ where: { companyId } });
      return `EXP-${year}-${String(count + 1).padStart(5, '0')}`;
    }
  }

  /**
   * Creates a new Expense Claim (in DRAFT or SUBMITTED status)
   */
  static async createClaim(
    actor: AuthUser,
    input: CreateExpenseClaimRequest,
    correlationId?: string
  ): Promise<ExpenseClaimItem> {
    // 1. Strictly resolve employee linked to the authenticated actor (never attribute to arbitrary employees)
    const employee = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);
    if (!employee) {
      const err = new Error(
        'No employee record found for your user account in this company. Link your user account to an employee profile before creating an expense claim.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    const employeeId = employee.id;

    if (!input.title || !input.title.trim()) {
      const err = new Error('Expense claim title is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Validate optional designated manager belongs to the same company and is not the submitter
    if (input.managerId) {
      if (input.managerId === employeeId) {
        const err = new Error('Separation of Duties violation: You cannot assign yourself as approving manager.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      const managerRecord = await prisma.employee.findFirst({
        where: { id: input.managerId, companyId: actor.companyId },
        select: { id: true },
      });
      if (!managerRecord) {
        const err = new Error('Selected approving manager was not found in this company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    // 2. Validate input lines
    if (!input.lines || input.lines.length === 0) {
      const err = new Error('Expense claim must contain at least one line item.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const originalExpenseDate = new Date(input.originalExpenseDate);
    if (isNaN(originalExpenseDate.getTime())) {
      const err = new Error('Invalid original expense date.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Validate period is not locked if submitting immediately
    if (input.submitImmediately) {
      await this.verifyFiscalPeriodOpen(actor.companyId, originalExpenseDate);
    }

    let totalAmount = new Decimal(0);
    const validatedLines = input.lines.map((line, idx) => {
      const amt = AccountingMath.from(line.amount || 0);
      if (AccountingMath.lte(amt, 0)) {
        const err = new Error(`Line ${idx + 1} amount must be greater than zero.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      totalAmount = totalAmount.plus(amt);

      const lineDate = new Date(line.expenseDate || input.originalExpenseDate);
      if (isNaN(lineDate.getTime())) {
        const err = new Error(`Line ${idx + 1} has an invalid expense date.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      return {
        category: (line.category || 'OTHER') as ExpenseCategory,
        description: line.description?.trim() || 'Expense Item',
        expenseDate: lineDate,
        amount: amt,
        merchant: line.merchant?.trim() || null,
        expenseLedgerId: line.expenseLedgerId || null,
        attachmentId: line.attachmentId || null,
      };
    });

    // Validate any explicitly provided line expense ledgers
    for (let i = 0; i < validatedLines.length; i++) {
      const ledId = validatedLines[i].expenseLedgerId;
      if (ledId) {
        await this.requireValidLedger(actor.companyId, ledId, 'EXPENSE', `lines[${i}].expenseLedgerId`);
      }
    }

    const status: ExpenseClaimStatus = input.submitImmediately ? 'SUBMITTED' : 'DRAFT';

    const claim = await prisma.$transaction(async (tx) => {
      const claimNumber = await this.allocateClaimNumber(actor.companyId, originalExpenseDate, tx);

      const created = await tx.expenseClaim.create({
        data: {
          companyId: actor.companyId,
          claimNumber,
          employeeId,
          title: input.title.trim(),
          description: input.description?.trim() || null,
          originalExpenseDate,
          currency: input.currency || 'USD',
          totalAmount,
          status,
          managerId: input.managerId || null,
          lines: {
            create: validatedLines.map((l) => ({
              companyId: actor.companyId,
              category: l.category,
              description: l.description,
              expenseDate: l.expenseDate,
              amount: l.amount,
              merchant: l.merchant,
              expenseLedgerId: l.expenseLedgerId,
              attachmentId: l.attachmentId,
            })),
          },
        },
        include: {
          lines: true,
          attachments: true,
          events: true,
          employee: { select: { id: true, fullName: true, employeeCode: true, department: true } },
          manager: { select: { id: true, fullName: true } },
        },
      });

      // Link any referenced attachments to this claim
      const attachmentIds = validatedLines
        .map((l) => l.attachmentId)
        .filter((id): id is string => Boolean(id));

      if (attachmentIds.length > 0) {
        await tx.expenseClaimAttachment.updateMany({
          where: {
            id: { in: attachmentIds },
            companyId: actor.companyId,
          },
          data: { claimId: created.id },
        });
      }

      // Record lifecycle event
      await tx.expenseClaimEvent.create({
        data: {
          companyId: actor.companyId,
          claimId: created.id,
          action: input.submitImmediately ? 'SUBMITTED' : 'CREATED_DRAFT',
          fromStatus: null,
          toStatus: status,
          actorUserId: actor.userId || actor.id,
          notes: input.submitImmediately ? 'Claim submitted for manager review' : 'Draft claim created',
        },
      });

      await AuditService.log(
        {
          companyId: actor.companyId,
          userId: actor.userId || actor.id,
          action: status === 'SUBMITTED' ? 'EXPENSE_CLAIM_SUBMIT' : 'EXPENSE_CLAIM_CREATE_DRAFT',
          entity: 'ExpenseClaim',
          entityId: created.id,
          correlationId,
          details: {
            claimNumber: created.claimNumber,
            totalAmount: totalAmount.toNumber(),
            status,
            itemCount: validatedLines.length,
          },
        },
        tx
      );

      return created;
    });

    return this.getClaimById(actor, claim.id);
  }

  /**
   * Updates an existing claim (allowed ONLY in DRAFT status)
   */
  static async updateClaim(
    actor: AuthUser,
    claimId: string,
    input: UpdateExpenseClaimRequest,
    correlationId?: string
  ): Promise<ExpenseClaimItem> {
    const existing = await prisma.expenseClaim.findUnique({
      where: { id: claimId },
      include: { employee: true },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Expense claim not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status !== 'DRAFT') {
      const err = new Error(`Only claims in DRAFT status can be modified. Current status is ${existing.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check ownership: EMPLOYEE can only update their own claims
    if (actor.role === 'EMPLOYEE') {
      const emp = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);
      if (!emp || emp.id !== existing.employeeId) {
        const err = new Error('You can only modify your own expense claims.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }
    }

    if (input.managerId !== undefined && input.managerId !== null) {
      if (input.managerId === existing.employeeId) {
        const err = new Error('Separation of Duties violation: Submitter cannot be assigned as approving manager.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      const managerRecord = await prisma.employee.findFirst({
        where: { id: input.managerId, companyId: actor.companyId },
        select: { id: true },
      });
      if (!managerRecord) {
        const err = new Error('Selected approving manager was not found in this company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    let originalExpenseDate = existing.originalExpenseDate;
    if (input.originalExpenseDate) {
      const parsed = new Date(input.originalExpenseDate);
      if (isNaN(parsed.getTime())) {
        const err = new Error('Invalid original expense date.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      originalExpenseDate = parsed;
    }

    let computedLines:
      | Array<{
          claimId: string;
          companyId: string;
          category: ExpenseCategory;
          description: string;
          expenseDate: Date;
          amount: Decimal;
          merchant: string | null;
          expenseLedgerId: string | null;
          attachmentId: string | null;
        }>
      | undefined;
    let totalAmount = existing.totalAmount;

    if (input.lines && input.lines.length > 0) {
      let sum = new Decimal(0);
      computedLines = input.lines.map((line, idx) => {
        const amt = AccountingMath.from(line.amount || 0);
        if (AccountingMath.lte(amt, 0)) {
          const err = new Error(`Line ${idx + 1} amount must be greater than zero.`);
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }
        sum = sum.plus(amt);

        return {
          claimId,
          companyId: actor.companyId,
          category: (line.category || 'OTHER') as ExpenseCategory,
          description: line.description?.trim() || 'Expense Item',
          expenseDate: new Date(line.expenseDate || originalExpenseDate),
          amount: amt,
          merchant: line.merchant?.trim() || null,
          expenseLedgerId: line.expenseLedgerId || null,
          attachmentId: line.attachmentId || null,
        };
      });
      totalAmount = sum;

      for (let i = 0; i < computedLines.length; i++) {
        const ledId = computedLines[i].expenseLedgerId;
        if (ledId) {
          await this.requireValidLedger(actor.companyId, ledId, 'EXPENSE', `lines[${i}].expenseLedgerId`);
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      const transition = await tx.expenseClaim.updateMany({
        where: { id: claimId, companyId: actor.companyId, status: 'DRAFT' },
        data: {
          title: input.title !== undefined ? input.title.trim() : existing.title,
          description: input.description !== undefined ? input.description?.trim() : existing.description,
          originalExpenseDate,
          managerId: input.managerId !== undefined ? input.managerId : existing.managerId,
          totalAmount,
        },
      });

      if (transition.count !== 1) {
        const err = new Error('Expense claim was concurrently modified or is no longer in DRAFT status.');
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      if (computedLines) {
        await tx.expenseClaimLine.deleteMany({ where: { claimId } });
        await tx.expenseClaimLine.createMany({ data: computedLines });

        const attachmentIds = computedLines
          .map((l) => l.attachmentId)
          .filter((id): id is string => Boolean(id));

        if (attachmentIds.length > 0) {
          await tx.expenseClaimAttachment.updateMany({
            where: { id: { in: attachmentIds }, companyId: actor.companyId },
            data: { claimId },
          });
        }
      }

      await tx.expenseClaimEvent.create({
        data: {
          companyId: actor.companyId,
          claimId,
          action: 'UPDATED_DRAFT',
          fromStatus: 'DRAFT',
          toStatus: 'DRAFT',
          actorUserId: actor.userId || actor.id,
          notes: 'Claim draft modified',
        },
      });

      await AuditService.log(
        {
          companyId: actor.companyId,
          userId: actor.userId || actor.id,
          action: 'EXPENSE_CLAIM_UPDATE',
          entity: 'ExpenseClaim',
          entityId: claimId,
          correlationId,
          details: { claimNumber: existing.claimNumber },
        },
        tx
      );
    });

    return this.getClaimById(actor, claimId);
  }

  /**
   * Submits a DRAFT claim for manager review
   */
  static async submitClaim(actor: AuthUser, claimId: string, correlationId?: string): Promise<ExpenseClaimItem> {
    const existing = await prisma.expenseClaim.findUnique({
      where: { id: claimId },
      include: { employee: true, lines: true },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Expense claim not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status !== 'DRAFT') {
      const err = new Error(`Only DRAFT claims can be submitted. Current status is ${existing.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!existing.lines || existing.lines.length === 0) {
      const err = new Error('Cannot submit an expense claim without any itemized lines.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Check ownership
    if (actor.role === 'EMPLOYEE') {
      const emp = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);
      if (!emp || emp.id !== existing.employeeId) {
        const err = new Error('You can only submit your own expense claims.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }
    }

    // Verify fiscal period
    await this.verifyFiscalPeriodOpen(actor.companyId, existing.originalExpenseDate);

    await prisma.$transaction(async (tx) => {
      const transition = await tx.expenseClaim.updateMany({
        where: { id: claimId, companyId: actor.companyId, status: 'DRAFT' },
        data: { status: 'SUBMITTED', returnReason: null, rejectionReason: null },
      });

      if (transition.count !== 1) {
        const err = new Error('Expense claim was concurrently submitted or modified.');
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      await tx.expenseClaimEvent.create({
        data: {
          companyId: actor.companyId,
          claimId,
          action: 'SUBMITTED',
          fromStatus: 'DRAFT',
          toStatus: 'SUBMITTED',
          actorUserId: actor.userId || actor.id,
          notes: 'Claim submitted for manager review',
        },
      });

      await AuditService.log(
        {
          companyId: actor.companyId,
          userId: actor.userId || actor.id,
          action: 'EXPENSE_CLAIM_SUBMIT',
          entity: 'ExpenseClaim',
          entityId: claimId,
          correlationId,
          details: { claimNumber: existing.claimNumber },
        },
        tx
      );
    });

    return this.getClaimById(actor, claimId);
  }

  /**
   * Cancels a DRAFT or SUBMITTED claim
   */
  static async cancelClaim(actor: AuthUser, claimId: string, reason?: string, correlationId?: string): Promise<ExpenseClaimItem> {
    const existing = await prisma.expenseClaim.findUnique({
      where: { id: claimId },
      include: { employee: true },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Expense claim not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status !== 'DRAFT' && existing.status !== 'SUBMITTED') {
      const err = new Error(`Cannot cancel claim with status ${existing.status}. Only DRAFT or SUBMITTED claims can be cancelled.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (actor.role === 'EMPLOYEE') {
      const emp = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);
      if (!emp || emp.id !== existing.employeeId) {
        const err = new Error('You can only cancel your own expense claims.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }
    }

    await prisma.$transaction(async (tx) => {
      const transition = await tx.expenseClaim.updateMany({
        where: { id: claimId, companyId: actor.companyId, status: existing.status },
        data: { status: 'CANCELLED' },
      });

      if (transition.count !== 1) {
        const err = new Error('Expense claim was concurrently modified and could not be cancelled.');
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      await tx.expenseClaimEvent.create({
        data: {
          companyId: actor.companyId,
          claimId,
          action: 'CANCELLED',
          fromStatus: existing.status,
          toStatus: 'CANCELLED',
          actorUserId: actor.userId || actor.id,
          notes: reason || 'Claim cancelled by user',
        },
      });

      await AuditService.log(
        {
          companyId: actor.companyId,
          userId: actor.userId || actor.id,
          action: 'EXPENSE_CLAIM_CANCEL',
          entity: 'ExpenseClaim',
          entityId: claimId,
          correlationId,
          details: { claimNumber: existing.claimNumber, reason },
        },
        tx
      );
    });

    return this.getClaimById(actor, claimId);
  }

  /**
   * Manager Review: Approve, Reject, or Return for correction
   * Enforces Separation of Duties & Manager Assignment:
   * - Submitter CANNOT approve their own claim as manager.
   * - If claim has an assigned managerId, non-SUPER_ADMIN actors must match that managerId;
   *   EMPLOYEE actors must ALWAYS be explicitly assigned as managerId.
   */
  static async reviewAsManager(
    actor: AuthUser,
    claimId: string,
    input: ReviewExpenseClaimRequest,
    correlationId?: string
  ): Promise<ExpenseClaimItem> {
    const existing = await prisma.expenseClaim.findUnique({
      where: { id: claimId },
      include: { employee: true },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Expense claim not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status !== 'SUBMITTED') {
      const err = new Error(`Manager review can only be performed on SUBMITTED claims. Current status: ${existing.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // STRICT SEPARATION OF DUTIES:
    // Submitter cannot approve their own claim as Manager!
    const actorEmployee = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);
    const isSubmitter =
      existing.employee.userId === (actor.userId || actor.id) ||
      (actorEmployee && actorEmployee.id === existing.employeeId);

    if (isSubmitter) {
      const err = new Error('Separation of Duties violation: Submitter cannot approve their own expense claim as manager.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // MANAGER ASSIGNMENT AUTHORIZATION:
    if (actor.role === 'EMPLOYEE') {
      if (!actorEmployee || !existing.managerId || existing.managerId !== actorEmployee.id) {
        const err = new Error('Forbidden: Employees may only review claims explicitly assigned to them as manager.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }
    } else if (existing.managerId && actor.role !== 'SUPER_ADMIN') {
      if (!actorEmployee || existing.managerId !== actorEmployee.id) {
        const err = new Error('Forbidden: This expense claim is assigned to a different reviewing manager.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }
    }

    if (input.decision === 'REJECT') {
      if (!input.reason?.trim()) {
        const err = new Error('A rejection reason is mandatory when rejecting an expense claim.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      await prisma.$transaction(async (tx) => {
        const transition = await tx.expenseClaim.updateMany({
          where: { id: claimId, companyId: actor.companyId, status: 'SUBMITTED' },
          data: { status: 'REJECTED', rejectionReason: input.reason?.trim() },
        });
        if (transition.count !== 1) {
          const err = new Error('Expense claim has already been reviewed or modified concurrently.');
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }

        await tx.expenseClaimEvent.create({
          data: {
            companyId: actor.companyId,
            claimId,
            action: 'MANAGER_REJECTED',
            fromStatus: 'SUBMITTED',
            toStatus: 'REJECTED',
            actorUserId: actor.userId || actor.id,
            notes: input.reason?.trim(),
          },
        });

        await AuditService.log(
          {
            companyId: actor.companyId,
            userId: actor.userId || actor.id,
            action: `EXPENSE_CLAIM_MANAGER_${input.decision}`,
            entity: 'ExpenseClaim',
            entityId: claimId,
            correlationId,
            details: { claimNumber: existing.claimNumber, decision: input.decision, reason: input.reason },
          },
          tx
        );
      });
    } else if (input.decision === 'RETURN') {
      if (!input.reason?.trim()) {
        const err = new Error('A return reason is mandatory when returning a claim for correction.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      await prisma.$transaction(async (tx) => {
        const transition = await tx.expenseClaim.updateMany({
          where: { id: claimId, companyId: actor.companyId, status: 'SUBMITTED' },
          data: { status: 'DRAFT', returnReason: input.reason?.trim() },
        });
        if (transition.count !== 1) {
          const err = new Error('Expense claim has already been reviewed or modified concurrently.');
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }

        await tx.expenseClaimEvent.create({
          data: {
            companyId: actor.companyId,
            claimId,
            action: 'RETURNED_FOR_CORRECTION',
            fromStatus: 'SUBMITTED',
            toStatus: 'DRAFT',
            actorUserId: actor.userId || actor.id,
            notes: input.reason?.trim(),
          },
        });

        await AuditService.log(
          {
            companyId: actor.companyId,
            userId: actor.userId || actor.id,
            action: `EXPENSE_CLAIM_MANAGER_${input.decision}`,
            entity: 'ExpenseClaim',
            entityId: claimId,
            correlationId,
            details: { claimNumber: existing.claimNumber, decision: input.decision, reason: input.reason },
          },
          tx
        );
      });
    } else if (input.decision === 'APPROVE') {
      await prisma.$transaction(async (tx) => {
        const transition = await tx.expenseClaim.updateMany({
          where: { id: claimId, companyId: actor.companyId, status: 'SUBMITTED' },
          data: {
            status: 'MANAGER_APPROVED',
            managerApprovedAt: new Date(),
            managerApprovedById: actor.userId || actor.id,
            returnReason: null,
            rejectionReason: null,
          },
        });
        if (transition.count !== 1) {
          const err = new Error('Expense claim has already been reviewed or modified concurrently.');
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }

        await tx.expenseClaimEvent.create({
          data: {
            companyId: actor.companyId,
            claimId,
            action: 'MANAGER_APPROVED',
            fromStatus: 'SUBMITTED',
            toStatus: 'MANAGER_APPROVED',
            actorUserId: actor.userId || actor.id,
            notes: input.reason?.trim() || 'Manager approved claim',
          },
        });

        await AuditService.log(
          {
            companyId: actor.companyId,
            userId: actor.userId || actor.id,
            action: `EXPENSE_CLAIM_MANAGER_${input.decision}`,
            entity: 'ExpenseClaim',
            entityId: claimId,
            correlationId,
            details: { claimNumber: existing.claimNumber, decision: input.decision, reason: input.reason },
          },
          tx
        );
      });
    } else {
      const err = new Error(`Unsupported review decision "${input.decision}". Must be APPROVE, REJECT, or RETURN.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    return this.getClaimById(actor, claimId);
  }

  /**
   * Accounts Review: Verify, Approve & Post Double-Entry Journal (or Reject / Return)
   * Enforces Separation of Duties:
   * - Submitter cannot perform accounts approval
   * - Manager approver cannot perform accounts approval on the same claim
   */
  static async reviewAsAccounts(
    actor: AuthUser,
    claimId: string,
    input: ReviewExpenseClaimRequest,
    correlationId?: string
  ): Promise<ExpenseClaimItem> {
    const existing = await prisma.expenseClaim.findUnique({
      where: { id: claimId },
      include: {
        employee: true,
        lines: {
          include: { expenseLedger: true },
        },
      },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Expense claim not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status !== 'MANAGER_APPROVED') {
      const err = new Error(
        `Accounts review can only be performed on MANAGER_APPROVED claims. Current status: ${existing.status}.`
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // STRICT SEPARATION OF DUTIES:
    // 1. Submitter cannot perform accounts approval
    const actorEmployee = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);
    const isSubmitter =
      existing.employee.userId === (actor.userId || actor.id) ||
      (actorEmployee && actorEmployee.id === existing.employeeId);

    if (isSubmitter) {
      const err = new Error('Separation of Duties violation: Submitter cannot perform accounts verification on their own expense claim.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    // 2. Manager who performed manager approval cannot also perform accounts approval on the same claim!
    if (existing.managerApprovedById && existing.managerApprovedById === (actor.userId || actor.id)) {
      const err = new Error('Separation of Duties violation: The manager who approved this claim cannot also perform Accounts approval.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    if (input.decision === 'REJECT') {
      if (!input.reason?.trim()) {
        const err = new Error('A rejection reason is mandatory when rejecting an expense claim.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      await prisma.$transaction(async (tx) => {
        const transition = await tx.expenseClaim.updateMany({
          where: { id: claimId, companyId: actor.companyId, status: 'MANAGER_APPROVED' },
          data: { status: 'REJECTED', rejectionReason: input.reason?.trim() },
        });
        if (transition.count !== 1) {
          const err = new Error('Expense claim has already been reviewed or modified concurrently.');
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }

        await tx.expenseClaimEvent.create({
          data: {
            companyId: actor.companyId,
            claimId,
            action: 'ACCOUNTS_REJECTED',
            fromStatus: 'MANAGER_APPROVED',
            toStatus: 'REJECTED',
            actorUserId: actor.userId || actor.id,
            notes: input.reason?.trim(),
          },
        });

        await AuditService.log(
          {
            companyId: actor.companyId,
            userId: actor.userId || actor.id,
            action: `EXPENSE_CLAIM_ACCOUNTS_${input.decision}`,
            entity: 'ExpenseClaim',
            entityId: claimId,
            correlationId,
            details: { claimNumber: existing.claimNumber, decision: input.decision },
          },
          tx
        );
      });
    } else if (input.decision === 'RETURN') {
      if (!input.reason?.trim()) {
        const err = new Error('A return reason is mandatory when returning a claim for correction.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      await prisma.$transaction(async (tx) => {
        const transition = await tx.expenseClaim.updateMany({
          where: { id: claimId, companyId: actor.companyId, status: 'MANAGER_APPROVED' },
          data: { status: 'DRAFT', returnReason: input.reason?.trim() },
        });
        if (transition.count !== 1) {
          const err = new Error('Expense claim has already been reviewed or modified concurrently.');
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }

        await tx.expenseClaimEvent.create({
          data: {
            companyId: actor.companyId,
            claimId,
            action: 'RETURNED_FOR_CORRECTION',
            fromStatus: 'MANAGER_APPROVED',
            toStatus: 'DRAFT',
            actorUserId: actor.userId || actor.id,
            notes: input.reason?.trim(),
          },
        });

        await AuditService.log(
          {
            companyId: actor.companyId,
            userId: actor.userId || actor.id,
            action: `EXPENSE_CLAIM_ACCOUNTS_${input.decision}`,
            entity: 'ExpenseClaim',
            entityId: claimId,
            correlationId,
            details: { claimNumber: existing.claimNumber, decision: input.decision },
          },
          tx
        );
      });
    } else if (input.decision === 'APPROVE') {
      if (!existing.lines || existing.lines.length === 0) {
        const err = new Error('Cannot approve an expense claim with no itemized lines.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }

      // 1. Verify fiscal period covering original expense date is open and not locked
      const fiscalPeriod = await this.verifyFiscalPeriodOpen(actor.companyId, existing.originalExpenseDate);

      // 2. Strictly validate explicit ledgers (never silently fall back on invalid/wrong-type explicit IDs)
      const { payableLedger: defaultPayableLedger, expenseLedger: defaultExpenseLedger } =
        await this.getOrCreateDefaultLedgers(actor.companyId, actor);

      let payableLedgerId = defaultPayableLedger.id;
      if (input.payableLedgerId) {
        const explicitPayable = await this.requireValidLedger(
          actor.companyId,
          input.payableLedgerId,
          'LIABILITY',
          'payableLedgerId'
        );
        payableLedgerId = explicitPayable.id;
      }

      let fallbackExpenseLedgerId = defaultExpenseLedger.id;
      if (input.expenseLedgerId) {
        const explicitExpense = await this.requireValidLedger(
          actor.companyId,
          input.expenseLedgerId,
          'EXPENSE',
          'expenseLedgerId'
        );
        fallbackExpenseLedgerId = explicitExpense.id;
      }

      // 3. Prepare double-entry journal lines:
      // - Debit: Specific Expense Ledger(s)
      // - Credit: Accounts Payable Liability Ledger
      const journalLines: Array<{
        ledgerId: string;
        debit: string;
        credit: string;
        description?: string;
      }> = [];

      let totalDebit = new Decimal(0);

      for (let i = 0; i < existing.lines.length; i++) {
        const line = existing.lines[i];
        const lineAmount = new Decimal(line.amount);
        totalDebit = totalDebit.plus(lineAmount);

        let targetExpenseLedgerId = fallbackExpenseLedgerId;
        if (line.expenseLedgerId) {
          const lineLedger = await this.requireValidLedger(
            actor.companyId,
            line.expenseLedgerId,
            'EXPENSE',
            `lines[${i}].expenseLedgerId`
          );
          targetExpenseLedgerId = lineLedger.id;
        }

        journalLines.push({
          ledgerId: targetExpenseLedgerId,
          debit: AccountingMath.format(lineAmount),
          credit: '0.0000',
          description: `${line.category}: ${line.description}`,
        });
      }

      // Credit: Accounts Payable Liability Ledger
      journalLines.push({
        ledgerId: payableLedgerId,
        debit: '0.0000',
        credit: AccountingMath.format(totalDebit),
        description: `Payable for ${existing.claimNumber} (${existing.employee.fullName})`,
      });

      // Atomically claim state transition, post idempotent double-entry journal, and record audit trail
      await prisma.$transaction(async (tx) => {
        const transition = await tx.expenseClaim.updateMany({
          where: { id: claimId, companyId: actor.companyId, status: 'MANAGER_APPROVED' },
          data: {
            status: 'ACCOUNTS_APPROVED',
            accountsApprovedAt: new Date(),
            accountsApprovedById: actor.userId || actor.id,
            payableLedgerId,
            returnReason: null,
            rejectionReason: null,
          },
        });

        if (transition.count !== 1) {
          const err = new Error('Expense claim has already been approved or modified concurrently.');
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }

        const journal = await JournalService.createJournal(
          actor,
          {
            entryDate: existing.originalExpenseDate.toISOString().slice(0, 10),
            fiscalPeriodId: fiscalPeriod?.id || null,
            narration: `Approved expense reimbursement claim ${existing.claimNumber}: ${existing.title}`,
            reference: existing.claimNumber,
            idempotencyKey: `EXPENSE_AP:${claimId}`,
            lines: journalLines,
            autoPost: true,
          },
          correlationId,
          tx
        );

        await tx.expenseClaim.update({
          where: { id: claimId },
          data: {
            journalEntryId: journal.id,
          },
        });

        await tx.expenseClaimEvent.create({
          data: {
            companyId: actor.companyId,
            claimId,
            action: 'ACCOUNTS_APPROVED',
            fromStatus: 'MANAGER_APPROVED',
            toStatus: 'ACCOUNTS_APPROVED',
            actorUserId: actor.userId || actor.id,
            notes: `Accounts approved. Posted Journal Voucher: ${journal.voucherNumber}`,
          },
        });

        await AuditService.log(
          {
            companyId: actor.companyId,
            userId: actor.userId || actor.id,
            action: `EXPENSE_CLAIM_ACCOUNTS_${input.decision}`,
            entity: 'ExpenseClaim',
            entityId: claimId,
            correlationId,
            details: {
              claimNumber: existing.claimNumber,
              decision: input.decision,
              journalEntryId: journal.id,
              voucherNumber: journal.voucherNumber,
            },
          },
          tx
        );
      });
    } else {
      const err = new Error(`Unsupported review decision "${input.decision}". Must be APPROVE, REJECT, or RETURN.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    return this.getClaimById(actor, claimId);
  }

  /**
   * Records payment / disbursement for an ACCOUNTS_APPROVED claim
   * Posts reimbursement journal entry:
   * Debit: Accounts Payable Liability Ledger
   * Credit: Bank / Cash Asset Ledger
   * Status -> PAID
   * Enforces Separation of Duties: Submitter CANNOT disburse/record payment for their own claim.
   */
  static async recordPayment(
    actor: AuthUser,
    claimId: string,
    input: PayExpenseClaimRequest,
    correlationId?: string
  ): Promise<ExpenseClaimItem> {
    const existing = await prisma.expenseClaim.findUnique({
      where: { id: claimId },
      include: { employee: true },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Expense claim not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (existing.status !== 'ACCOUNTS_APPROVED') {
      const err = new Error(`Only ACCOUNTS_APPROVED claims can be reimbursed. Current status: ${existing.status}.`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // STRICT SEPARATION OF DUTIES:
    // Submitter cannot disburse/record payment for their own claim!
    const actorEmployee = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);
    const isSubmitter =
      existing.employee.userId === (actor.userId || actor.id) ||
      (actorEmployee && actorEmployee.id === existing.employeeId);

    if (isSubmitter) {
      const err = new Error('Separation of Duties violation: Submitter cannot disburse or record payout for their own expense claim.');
      (err as { statusCode?: number }).statusCode = 403;
      throw err;
    }

    const paymentDate = input.paymentDate ? new Date(input.paymentDate) : new Date();
    if (isNaN(paymentDate.getTime())) {
      const err = new Error('Invalid payment date format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // Verify fiscal period covering payment date is open
    const paymentFiscalPeriod = await this.verifyFiscalPeriodOpen(actor.companyId, paymentDate);

    // Strictly validate explicit bankAccountId and bankLedgerId (never silently fall back on invalid explicit IDs)
    let bankAccountNameHint: string | undefined;
    if (input.bankAccountId) {
      const bankAccount = await prisma.companyBankAccount.findFirst({
        where: { id: input.bankAccountId, companyId: actor.companyId },
      });
      if (!bankAccount) {
        const err = new Error('Invalid bankAccountId: company bank account was not found in this company.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (!bankAccount.isActive) {
        const err = new Error(`Invalid bankAccountId: bank account "${bankAccount.bankName}" is inactive.`);
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      bankAccountNameHint = bankAccount.bankName;
    }

    let bankLedgerId: string | undefined;
    if (input.bankLedgerId) {
      const explicitBankLedger = await this.requireValidLedger(
        actor.companyId,
        input.bankLedgerId,
        'ASSET',
        'bankLedgerId'
      );
      bankLedgerId = explicitBankLedger.id;
    } else if (bankAccountNameHint) {
      const matchingLedger = await prisma.accountLedger.findFirst({
        where: {
          companyId: actor.companyId,
          isActive: true,
          group: { rootType: 'ASSET' },
          OR: [
            { name: { contains: bankAccountNameHint, mode: 'insensitive' } },
            { name: { contains: 'Bank', mode: 'insensitive' } },
            { name: { contains: 'Cash', mode: 'insensitive' } },
          ],
        },
      });
      if (matchingLedger) {
        bankLedgerId = matchingLedger.id;
      }
    }

    if (!bankLedgerId) {
      const defaultAssetLedger = await prisma.accountLedger.findFirst({
        where: {
          companyId: actor.companyId,
          isActive: true,
          group: { rootType: 'ASSET' },
          OR: [
            { name: { contains: 'Bank', mode: 'insensitive' } },
            { name: { contains: 'Cash', mode: 'insensitive' } },
          ],
        },
      });

      if (defaultAssetLedger) {
        bankLedgerId = defaultAssetLedger.id;
      } else {
        // Create standard Bank & Cash asset ledger
        let assetGroup = await prisma.accountGroup.findFirst({
          where: { companyId: actor.companyId, rootType: 'ASSET' },
        });
        if (!assetGroup) {
          assetGroup = await prisma.accountGroup.create({
            data: {
              companyId: actor.companyId,
              code: '1000',
              name: 'Current Assets',
              rootType: 'ASSET',
              isSystem: true,
            },
          });
        }
        const createdLedger = await prisma.accountLedger.create({
          data: {
            companyId: actor.companyId,
            groupId: assetGroup.id,
            code: '1010',
            name: 'Main Operating Bank Account',
            description: 'Default company cash/bank disbursement account',
            isActive: true,
            currency: 'USD',
          },
        });
        bankLedgerId = createdLedger.id;
      }
    }

    const payableLedgerId = existing.payableLedgerId;
    if (!payableLedgerId) {
      const err = new Error('Payable ledger reference missing from accounts approved claim.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const totalAmount = new Decimal(existing.totalAmount || 0);
    if (totalAmount.lte(0)) {
      const err = new Error('Cannot record payout for a zero or negative expense claim amount.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const formattedAmount = AccountingMath.format(totalAmount);
    const paymentMethod: ExpensePaymentMethod = input.paymentMethod || 'BANK_TRANSFER';
    const paymentReference = input.paymentReference?.trim() || `REIMB-${existing.claimNumber}`;

    // Atomically claim state transition, post idempotent reimbursement journal voucher, and record audit trail
    await prisma.$transaction(async (tx) => {
      const transition = await tx.expenseClaim.updateMany({
        where: { id: claimId, companyId: actor.companyId, status: 'ACCOUNTS_APPROVED' },
        data: {
          status: 'PAID',
          paidAt: paymentDate,
          paidById: actor.userId || actor.id,
          paymentReference,
          paymentMethod,
          bankAccountId: input.bankAccountId || null,
          bankLedgerId,
        },
      });

      if (transition.count !== 1) {
        const err = new Error('Expense claim has already been paid or modified concurrently.');
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      // Debit: Accounts Payable Liability Ledger
      // Credit: Bank / Cash Asset Ledger
      const journal = await JournalService.createJournal(
        actor,
        {
          entryDate: paymentDate.toISOString().slice(0, 10),
          fiscalPeriodId: paymentFiscalPeriod?.id || null,
          narration: `Disbursement payout for expense claim ${existing.claimNumber} (${existing.employee.fullName}) via ${paymentMethod}`,
          reference: paymentReference,
          idempotencyKey: `EXPENSE_PAY:${claimId}`,
          lines: [
            {
              ledgerId: payableLedgerId,
              debit: formattedAmount,
              credit: '0.0000',
              description: `Settle payable for ${existing.claimNumber}`,
            },
            {
              ledgerId: bankLedgerId!,
              debit: '0.0000',
              credit: formattedAmount,
              description: `Payment to ${existing.employee.fullName} via ${paymentMethod}`,
            },
          ],
          autoPost: true,
        },
        correlationId,
        tx
      );

      await tx.expenseClaim.update({
        where: { id: claimId },
        data: {
          paymentJournalEntryId: journal.id,
        },
      });

      await tx.expenseClaimEvent.create({
        data: {
          companyId: actor.companyId,
          claimId,
          action: 'PAID',
          fromStatus: 'ACCOUNTS_APPROVED',
          toStatus: 'PAID',
          actorUserId: actor.userId || actor.id,
          notes: `Reimbursement disbursed via ${paymentMethod}. Posted Voucher: ${journal.voucherNumber}. Ref: ${paymentReference}`,
        },
      });

      await AuditService.log(
        {
          companyId: actor.companyId,
          userId: actor.userId || actor.id,
          action: 'EXPENSE_CLAIM_PAID',
          entity: 'ExpenseClaim',
          entityId: claimId,
          correlationId,
          details: {
            claimNumber: existing.claimNumber,
            totalAmount: totalAmount.toNumber(),
            paymentMethod,
            paymentReference,
            voucherNumber: journal.voucherNumber,
          },
        },
        tx
      );
    });

    return this.getClaimById(actor, claimId);
  }

  /**
   * Retrieves a single claim by ID with lines, attachments, events, and names
   */
  static async getClaimById(actor: AuthUser, claimId: string): Promise<ExpenseClaimItem> {
    const claim = await prisma.expenseClaim.findUnique({
      where: { id: claimId },
      include: {
        lines: {
          include: {
            expenseLedger: true,
            attachment: true,
          },
          orderBy: { expenseDate: 'asc' },
        },
        attachments: {
          orderBy: { createdAt: 'desc' },
        },
        events: {
          include: {
            actorUser: { select: { id: true, fullName: true, email: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        employee: {
          include: { department: true },
        },
        manager: true,
        payableLedger: true,
        journalEntry: true,
        paymentJournalEntry: true,
      },
    });

    if (!claim || claim.companyId !== actor.companyId) {
      const err = new Error('Expense claim not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Role check: If EMPLOYEE, must be submitter, assigned manager, or department manager
    if (actor.role === 'EMPLOYEE') {
      const currentEmployee = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);
      const isOwner = currentEmployee && claim.employeeId === currentEmployee.id;
      const isManager = currentEmployee && claim.managerId === currentEmployee.id;

      if (!isOwner && !isManager) {
        const err = new Error('You do not have permission to view this expense claim.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }
    }

    return {
      id: claim.id,
      companyId: claim.companyId,
      claimNumber: claim.claimNumber,
      employeeId: claim.employeeId,
      employeeName: claim.employee.fullName,
      employeeCode: claim.employee.employeeCode,
      departmentName: claim.employee.department?.name,
      title: claim.title,
      description: claim.description,
      originalExpenseDate: formatIsoDate(claim.originalExpenseDate),
      currency: claim.currency,
      totalAmount: new Decimal(claim.totalAmount || 0).toNumber(),
      status: claim.status,
      managerId: claim.managerId,
      managerName: claim.manager?.fullName,
      managerApprovedAt: claim.managerApprovedAt ? formatIsoDateTime(claim.managerApprovedAt) : null,
      managerApprovedById: claim.managerApprovedById,
      accountsApprovedAt: claim.accountsApprovedAt ? formatIsoDateTime(claim.accountsApprovedAt) : null,
      accountsApprovedById: claim.accountsApprovedById,
      payableLedgerId: claim.payableLedgerId,
      payableLedgerName: claim.payableLedger?.name,
      journalEntryId: claim.journalEntryId,
      journalVoucherNumber: claim.journalEntry?.voucherNumber,
      paidAt: claim.paidAt ? formatIsoDateTime(claim.paidAt) : null,
      paidById: claim.paidById,
      paymentJournalEntryId: claim.paymentJournalEntryId,
      paymentJournalVoucherNumber: claim.paymentJournalEntry?.voucherNumber,
      paymentReference: claim.paymentReference,
      paymentMethod: claim.paymentMethod,
      bankAccountId: claim.bankAccountId,
      rejectionReason: claim.rejectionReason,
      returnReason: claim.returnReason,
      lines: (claim.lines || []).map((l) => ({
        id: l.id,
        claimId: l.claimId,
        companyId: l.companyId,
        category: l.category,
        description: l.description,
        expenseDate: formatIsoDate(l.expenseDate),
        amount: new Decimal(l.amount || 0).toNumber(),
        merchant: l.merchant,
        expenseLedgerId: l.expenseLedgerId,
        expenseLedgerName: l.expenseLedger?.name,
        attachmentId: l.attachmentId,
        attachment: l.attachment
          ? {
              id: l.attachment.id,
              claimId: l.attachment.claimId,
              companyId: l.attachment.companyId,
              fileName: l.attachment.fileName,
              mimeType: l.attachment.mimeType,
              fileSizeBytes: l.attachment.fileSizeBytes,
              sha256Hash: l.attachment.sha256Hash,
              uploadedByUserId: l.attachment.uploadedByUserId,
              createdAt: formatIsoDateTime(l.attachment.createdAt),
            }
          : null,
        createdAt: formatIsoDateTime(l.createdAt),
        updatedAt: formatIsoDateTime(l.updatedAt),
      })),
      attachments: (claim.attachments || []).map((a) => ({
        id: a.id,
        claimId: a.claimId,
        companyId: a.companyId,
        fileName: a.fileName,
        mimeType: a.mimeType,
        fileSizeBytes: a.fileSizeBytes,
        sha256Hash: a.sha256Hash,
        uploadedByUserId: a.uploadedByUserId,
        createdAt: formatIsoDateTime(a.createdAt),
      })),
      events: (claim.events || []).map((e) => ({
        id: e.id,
        claimId: e.claimId,
        companyId: e.companyId,
        action: e.action,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorUserId: e.actorUserId,
        actorName: e.actorUser?.fullName,
        notes: e.notes,
        createdAt: formatIsoDateTime(e.createdAt),
      })),
      createdAt: formatIsoDateTime(claim.createdAt),
      updatedAt: formatIsoDateTime(claim.updatedAt),
    };
  }

  /**
   * Lists expense claims with filtering options
   */
  static async listClaims(
    actor: AuthUser,
    filters: {
      status?: ExpenseClaimStatus;
      employeeId?: string;
      departmentId?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
      queue?: 'self' | 'manager' | 'accounts';
    }
  ): Promise<ExpenseClaimItem[]> {
    const where: any = { companyId: actor.companyId };

    // Resolve current employee
    const currentEmployee = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);

    // Queue / role scoping with strict server-side authorization
    const andConditions: any[] = [];

    if (filters.queue === 'manager') {
      const canManagerApprove = await PermissionService.hasPermission(
        actor.companyId,
        actor.role,
        'EXPENSE',
        'APPROVE'
      );
      if (!canManagerApprove) {
        const err = new Error('You do not have permission to access the manager approval queue.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }

      where.status = 'SUBMITTED';
      if (actor.role === 'EMPLOYEE') {
        if (!currentEmployee) return [];
        where.managerId = currentEmployee.id;
      } else if (actor.role !== 'SUPER_ADMIN') {
        if (currentEmployee) {
          andConditions.push({
            OR: [{ managerId: currentEmployee.id }, { managerId: null }],
          });
        } else {
          where.managerId = null;
        }
      }
      if (filters.employeeId) {
        where.employeeId = filters.employeeId;
      }
    } else if (filters.queue === 'accounts') {
      const canAccountsApprove = await PermissionService.hasPermission(
        actor.companyId,
        actor.role,
        'ACCOUNTING',
        'APPROVE'
      );
      if (!canAccountsApprove) {
        const err = new Error('You do not have permission to access the Accounts & Payout queue.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }

      where.status =
        filters.status && ['MANAGER_APPROVED', 'ACCOUNTS_APPROVED', 'PAID'].includes(filters.status)
          ? filters.status
          : { in: ['MANAGER_APPROVED', 'ACCOUNTS_APPROVED'] };
      if (filters.employeeId) {
        where.employeeId = filters.employeeId;
      }
    } else if (actor.role === 'EMPLOYEE' || filters.queue === 'self') {
      if (!currentEmployee) {
        return [];
      }
      // Strictly lock to actor's own employeeId; ignore any filters.employeeId parameter
      where.employeeId = currentEmployee.id;
      if (filters.status) {
        where.status = filters.status;
      }
    } else {
      if (filters.status) {
        where.status = filters.status;
      }
      if (filters.employeeId) {
        where.employeeId = filters.employeeId;
      }
    }

    if (filters.departmentId) {
      where.employee = { departmentId: filters.departmentId };
    }

    if (filters.startDate || filters.endDate) {
      where.originalExpenseDate = {};
      if (filters.startDate) {
        where.originalExpenseDate.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        where.originalExpenseDate.lte = new Date(filters.endDate);
      }
    }

    if (filters.search) {
      andConditions.push({
        OR: [
          { claimNumber: { contains: filters.search, mode: 'insensitive' } },
          { title: { contains: filters.search, mode: 'insensitive' } },
          { employee: { fullName: { contains: filters.search, mode: 'insensitive' } } },
          { employee: { employeeCode: { contains: filters.search, mode: 'insensitive' } } },
        ],
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const claims = await prisma.expenseClaim.findMany({
      where,
      include: {
        lines: {
          include: { expenseLedger: true, attachment: true },
        },
        attachments: true,
        events: {
          include: { actorUser: { select: { fullName: true } } },
          orderBy: { createdAt: 'desc' },
          take: 3,
        },
        employee: { include: { department: true } },
        manager: true,
        payableLedger: true,
        journalEntry: true,
        paymentJournalEntry: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return claims.map((claim) => ({
      id: claim.id,
      companyId: claim.companyId,
      claimNumber: claim.claimNumber,
      employeeId: claim.employeeId,
      employeeName: claim.employee.fullName,
      employeeCode: claim.employee.employeeCode,
      departmentName: claim.employee.department?.name,
      title: claim.title,
      description: claim.description,
      originalExpenseDate: formatIsoDate(claim.originalExpenseDate),
      currency: claim.currency,
      totalAmount: new Decimal(claim.totalAmount || 0).toNumber(),
      status: claim.status,
      managerId: claim.managerId,
      managerName: claim.manager?.fullName,
      managerApprovedAt: claim.managerApprovedAt ? formatIsoDateTime(claim.managerApprovedAt) : null,
      managerApprovedById: claim.managerApprovedById,
      accountsApprovedAt: claim.accountsApprovedAt ? formatIsoDateTime(claim.accountsApprovedAt) : null,
      accountsApprovedById: claim.accountsApprovedById,
      payableLedgerId: claim.payableLedgerId,
      payableLedgerName: claim.payableLedger?.name,
      journalEntryId: claim.journalEntryId,
      journalVoucherNumber: claim.journalEntry?.voucherNumber,
      paidAt: claim.paidAt ? formatIsoDateTime(claim.paidAt) : null,
      paidById: claim.paidById,
      paymentJournalEntryId: claim.paymentJournalEntryId,
      paymentJournalVoucherNumber: claim.paymentJournalEntry?.voucherNumber,
      paymentReference: claim.paymentReference,
      paymentMethod: claim.paymentMethod,
      bankAccountId: claim.bankAccountId,
      rejectionReason: claim.rejectionReason,
      returnReason: claim.returnReason,
      lines: (claim.lines || []).map((l) => ({
        id: l.id,
        claimId: l.claimId,
        companyId: l.companyId,
        category: l.category,
        description: l.description,
        expenseDate: formatIsoDate(l.expenseDate),
        amount: new Decimal(l.amount || 0).toNumber(),
        merchant: l.merchant,
        expenseLedgerId: l.expenseLedgerId,
        expenseLedgerName: l.expenseLedger?.name,
        attachmentId: l.attachmentId,
        attachment: l.attachment
          ? {
              id: l.attachment.id,
              claimId: l.attachment.claimId,
              companyId: l.attachment.companyId,
              fileName: l.attachment.fileName,
              mimeType: l.attachment.mimeType,
              fileSizeBytes: l.attachment.fileSizeBytes,
              sha256Hash: l.attachment.sha256Hash,
              uploadedByUserId: l.attachment.uploadedByUserId,
              createdAt: formatIsoDateTime(l.attachment.createdAt),
            }
          : null,
        createdAt: formatIsoDateTime(l.createdAt),
        updatedAt: formatIsoDateTime(l.updatedAt),
      })),
      attachments: (claim.attachments || []).map((a) => ({
        id: a.id,
        claimId: a.claimId,
        companyId: a.companyId,
        fileName: a.fileName,
        mimeType: a.mimeType,
        fileSizeBytes: a.fileSizeBytes,
        sha256Hash: a.sha256Hash,
        uploadedByUserId: a.uploadedByUserId,
        createdAt: formatIsoDateTime(a.createdAt),
      })),
      events: (claim.events || []).map((e) => ({
        id: e.id,
        claimId: e.claimId,
        companyId: e.companyId,
        action: e.action,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorUserId: e.actorUserId,
        actorName: e.actorUser?.fullName,
        notes: e.notes,
        createdAt: formatIsoDateTime(e.createdAt),
      })),
      createdAt: formatIsoDateTime(claim.createdAt),
      updatedAt: formatIsoDateTime(claim.updatedAt),
    }));
  }

  /**
   * Aggregates reporting summaries by status, category, and department
   * Strictly scoped to actor's own claims when actor is an EMPLOYEE.
   */
  static async getSummaryReport(actor: AuthUser): Promise<ExpenseSummaryReport> {
    const where: any = { companyId: actor.companyId };

    if (actor.role === 'EMPLOYEE') {
      const currentEmployee = await this.getEmployeeForUser(actor.companyId, actor.userId || actor.id);
      if (!currentEmployee) {
        return {
          totalClaimsCount: 0,
          draftCount: 0,
          submittedCount: 0,
          managerApprovedCount: 0,
          accountsApprovedCount: 0,
          paidCount: 0,
          rejectedCount: 0,
          totalPendingAmount: 0,
          totalApprovedUnpaidAmount: 0,
          totalReimbursedAmount: 0,
          byCategory: [],
          byDepartment: [],
        };
      }
      where.employeeId = currentEmployee.id;
    }

    const claims = await prisma.expenseClaim.findMany({
      where,
      include: {
        lines: true,
        employee: { include: { department: true } },
      },
    });

    let draftCount = 0;
    let submittedCount = 0;
    let managerApprovedCount = 0;
    let accountsApprovedCount = 0;
    let paidCount = 0;
    let rejectedCount = 0;

    let totalPendingAmount = new Decimal(0);
    let totalApprovedUnpaidAmount = new Decimal(0);
    let totalReimbursedAmount = new Decimal(0);

    const categoryMap = new Map<ExpenseCategory, { amount: Decimal; count: number }>();
    const departmentMap = new Map<string, { departmentName: string; amount: Decimal; count: number }>();

    for (const c of claims) {
      const amt = new Decimal(c.totalAmount || 0);

      switch (c.status) {
        case 'DRAFT':
          draftCount++;
          break;
        case 'SUBMITTED':
          submittedCount++;
          totalPendingAmount = totalPendingAmount.plus(amt);
          break;
        case 'MANAGER_APPROVED':
          managerApprovedCount++;
          totalPendingAmount = totalPendingAmount.plus(amt);
          break;
        case 'ACCOUNTS_APPROVED':
          accountsApprovedCount++;
          totalApprovedUnpaidAmount = totalApprovedUnpaidAmount.plus(amt);
          break;
        case 'PAID':
          paidCount++;
          totalReimbursedAmount = totalReimbursedAmount.plus(amt);
          break;
        case 'REJECTED':
          rejectedCount++;
          break;
      }

      // Department aggregation
      const deptId = c.employee?.departmentId || 'unassigned';
      const deptName = c.employee?.department?.name || 'Unassigned';
      const deptStat = departmentMap.get(deptId) || { departmentName: deptName, amount: new Decimal(0), count: 0 };
      deptStat.amount = deptStat.amount.plus(amt);
      deptStat.count += 1;
      departmentMap.set(deptId, deptStat);

      // Category aggregation from lines
      for (const line of c.lines || []) {
        const lineAmt = new Decimal(line.amount || 0);
        const catStat = categoryMap.get(line.category) || { amount: new Decimal(0), count: 0 };
        catStat.amount = catStat.amount.plus(lineAmt);
        catStat.count += 1;
        categoryMap.set(line.category, catStat);
      }
    }

    return {
      totalClaimsCount: claims.length,
      draftCount,
      submittedCount,
      managerApprovedCount,
      accountsApprovedCount,
      paidCount,
      rejectedCount,
      totalPendingAmount: totalPendingAmount.toNumber(),
      totalApprovedUnpaidAmount: totalApprovedUnpaidAmount.toNumber(),
      totalReimbursedAmount: totalReimbursedAmount.toNumber(),
      byCategory: Array.from(categoryMap.entries()).map(([cat, stat]) => ({
        category: cat,
        amount: stat.amount.toNumber(),
        count: stat.count,
      })),
      byDepartment: Array.from(departmentMap.entries()).map(([deptId, stat]) => ({
        departmentId: deptId,
        departmentName: stat.departmentName,
        amount: stat.amount.toNumber(),
        count: stat.count,
      })),
    };
  }
}
