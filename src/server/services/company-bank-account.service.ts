/**
 * Company Bank Account Service (Phase 2.3)
 *
 * Implements corporate bank account management with:
 * 1. Strict Tenant Isolation: Every query and mutation is scoped to actor.companyId.
 * 2. Authenticated Encryption at Rest: AES-256-GCM via EncryptionService.
 * 3. Default Account Concurrency: Transactional default swap respecting partial unique index.
 * 4. Masked API Boundary: Never exposes full credentials in list or detail responses.
 * 5. Tamper-evident Audit Logging: Zero plaintext secrets or ciphertext payloads in audit logs.
 * 6. Business Invariants: Active default accounts cannot be deactivated or deleted without replacement.
 */

import { prisma } from '../db/client.js';
import type { PrismaClient } from '@prisma/client';
import {
  AuthUser,
  CompanyBankAccountItem,
  CreateCompanyBankAccountRequest,
  UpdateCompanyBankAccountRequest,
} from '../../shared/types.js';
import { EncryptionService } from '../security/encryption.service.js';
import { AuditService } from './audit.service.js';

export class CompanyBankAccountService {
  /**
   * Helper to format database record into masked API response
   */
  public static mapToMaskedItem(record: any): CompanyBankAccountItem {
    // Decrypt credentials internally, then apply safe masks for API boundary
    const plainAccountNumber = EncryptionService.decrypt(record.accountNumber);
    const plainIban = record.iban ? EncryptionService.decrypt(record.iban) : null;
    const plainRouting = record.routingCode ? EncryptionService.decrypt(record.routingCode) : null;
    const plainSwift = record.swiftBic ? EncryptionService.decrypt(record.swiftBic) : null;
    const plainUpi = record.upiId ? EncryptionService.decrypt(record.upiId) : null;

    return {
      id: record.id,
      companyId: record.companyId,
      bankName: record.bankName,
      accountHolderName: record.accountHolderName,
      accountNumber: EncryptionService.maskAccountNumber(plainAccountNumber),
      routingCode: EncryptionService.maskRoutingCode(plainRouting),
      branchName: record.branchName,
      swiftBic: plainSwift,
      iban: EncryptionService.maskIban(plainIban),
      upiId: EncryptionService.maskUpiId(plainUpi),
      accountType: record.accountType,
      currency: record.currency,
      isDefault: record.isDefault,
      isActive: record.isActive,
      showOnInvoices: record.showOnInvoices,
      showOnQuotations: record.showOnQuotations,
      createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
      updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : record.updatedAt,
    };
  }

  /**
   * Creates a new company bank account with encrypted credentials
   */
  public static async createBankAccount(
    actor: AuthUser,
    input: CreateCompanyBankAccountRequest,
    correlationId?: string
  ): Promise<CompanyBankAccountItem> {
    if (!input.bankName || !input.bankName.trim()) {
      const err = new Error('bankName is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!input.accountHolderName || !input.accountHolderName.trim()) {
      const err = new Error('accountHolderName is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!input.accountNumber || !input.accountNumber.trim()) {
      const err = new Error('accountNumber is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const currency = (input.currency || 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      const err = new Error('currency must be a valid 3-letter ISO code (e.g. USD, EUR, INR).');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const shouldBeDefault = input.isDefault ?? false;

    // Encrypt sensitive values using AES-256-GCM
    const encryptedAccountNumber = EncryptionService.encrypt(input.accountNumber.trim())!;
    const encryptedRouting = input.routingCode ? EncryptionService.encrypt(input.routingCode.trim()) : null;
    const encryptedSwift = input.swiftBic ? EncryptionService.encrypt(input.swiftBic.trim().toUpperCase()) : null;
    const encryptedIban = input.iban ? EncryptionService.encrypt(input.iban.trim().toUpperCase()) : null;
    const encryptedUpi = input.upiId ? EncryptionService.encrypt(input.upiId.trim()) : null;

    try {
      const created = await prisma.$transaction(async (tx) => {
        // If new account is marked default, unset existing default for this company
        if (shouldBeDefault) {
          await tx.companyBankAccount.updateMany({
            where: {
              companyId: actor.companyId,
              isDefault: true,
            },
            data: { isDefault: false },
          });
        }

        return tx.companyBankAccount.create({
          data: {
            companyId: actor.companyId,
            bankName: input.bankName.trim(),
            accountHolderName: input.accountHolderName.trim(),
            accountNumber: encryptedAccountNumber,
            routingCode: encryptedRouting,
            branchName: input.branchName?.trim() || null,
            swiftBic: encryptedSwift,
            iban: encryptedIban,
            upiId: encryptedUpi,
            accountType: input.accountType?.trim() || null,
            currency,
            isDefault: shouldBeDefault,
            isActive: true,
            showOnInvoices: input.showOnInvoices ?? true,
            showOnQuotations: input.showOnQuotations ?? false,
          },
        });
      });

      // Audit log (never logs plaintext secrets or ciphertext envelopes)
      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'COMPANY_BANK_ACCOUNT_CREATE',
        entity: 'CompanyBankAccount',
        entityId: created.id,
        correlationId,
        details: {
          bankName: created.bankName,
          accountHolderName: created.accountHolderName,
          currency: created.currency,
          isDefault: created.isDefault,
          maskedAccountNumber: EncryptionService.maskAccountNumber(input.accountNumber),
        },
      });

      return this.mapToMaskedItem(created);
    } catch (err: any) {
      if (err?.code === 'P2002' || err?.message?.includes('23505') || err?.message?.includes('CompanyBankAccount_companyId_default_unique')) {
        const conflictErr = new Error(
          'A concurrent transaction modified the default bank account for this company. Please retry.'
        );
        (conflictErr as { statusCode?: number }).statusCode = 409;
        throw conflictErr;
      }
      throw err;
    }
  }

  /**
   * Lists bank accounts for the authenticated company
   */
  public static async listBankAccounts(
    actor: AuthUser,
    filters?: { isActive?: boolean }
  ): Promise<CompanyBankAccountItem[]> {
    const where: any = { companyId: actor.companyId };
    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    const accounts = await prisma.companyBankAccount.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    return accounts.map((acc) => this.mapToMaskedItem(acc));
  }

  /**
   * Retrieves single bank account by ID with strict tenant scoping
   */
  public static async getBankAccountById(actor: AuthUser, id: string): Promise<CompanyBankAccountItem> {
    const account = await prisma.companyBankAccount.findUnique({
      where: { id },
    });

    if (!account || account.companyId !== actor.companyId) {
      const err = new Error('Bank account not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return this.mapToMaskedItem(account);
  }

  /**
   * Updates an existing bank account
   */
  public static async updateBankAccount(
    actor: AuthUser,
    id: string,
    input: UpdateCompanyBankAccountRequest,
    correlationId?: string
  ): Promise<CompanyBankAccountItem> {
    const existing = await prisma.companyBankAccount.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Bank account not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const data: any = {};
    const changedFields: string[] = [];

    if (input.bankName !== undefined) {
      data.bankName = input.bankName.trim();
      changedFields.push('bankName');
    }
    if (input.accountHolderName !== undefined) {
      data.accountHolderName = input.accountHolderName.trim();
      changedFields.push('accountHolderName');
    }
    if (input.branchName !== undefined) {
      data.branchName = input.branchName?.trim() || null;
      changedFields.push('branchName');
    }
    if (input.accountType !== undefined) {
      data.accountType = input.accountType?.trim() || null;
      changedFields.push('accountType');
    }
    if (input.currency !== undefined) {
      const curr = input.currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(curr)) {
        const err = new Error('currency must be a valid 3-letter ISO code.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      data.currency = curr;
      changedFields.push('currency');
    }
    if (input.showOnInvoices !== undefined) {
      data.showOnInvoices = input.showOnInvoices;
      changedFields.push('showOnInvoices');
    }
    if (input.showOnQuotations !== undefined) {
      data.showOnQuotations = input.showOnQuotations;
      changedFields.push('showOnQuotations');
    }

    // Encrypt sensitive fields if updated
    if (input.accountNumber !== undefined) {
      data.accountNumber = EncryptionService.encrypt(input.accountNumber.trim());
      changedFields.push('accountNumber');
    }
    if (input.routingCode !== undefined) {
      data.routingCode = input.routingCode ? EncryptionService.encrypt(input.routingCode.trim()) : null;
      changedFields.push('routingCode');
    }
    if (input.swiftBic !== undefined) {
      data.swiftBic = input.swiftBic ? EncryptionService.encrypt(input.swiftBic.trim().toUpperCase()) : null;
      changedFields.push('swiftBic');
    }
    if (input.iban !== undefined) {
      data.iban = input.iban ? EncryptionService.encrypt(input.iban.trim().toUpperCase()) : null;
      changedFields.push('iban');
    }
    if (input.upiId !== undefined) {
      data.upiId = input.upiId ? EncryptionService.encrypt(input.upiId.trim()) : null;
      changedFields.push('upiId');
    }

    const wantsDefault = input.isDefault;

    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (wantsDefault === true) {
          // Unset any existing default account
          await tx.companyBankAccount.updateMany({
            where: {
              companyId: actor.companyId,
              isDefault: true,
            },
            data: { isDefault: false },
          });
          data.isDefault = true;
          data.isActive = true; // Default accounts must be active
          changedFields.push('isDefault');
        } else if (wantsDefault === false && existing.isDefault) {
          // Invariant: Cannot directly unset default without designating a replacement
          const err = new Error(
            'Cannot unset the active default account directly. Please designate another account as default.'
          );
          (err as { statusCode?: number }).statusCode = 400;
          throw err;
        }

        return tx.companyBankAccount.update({
          where: { id },
          data,
        });
      });

      // Audit log
      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'COMPANY_BANK_ACCOUNT_UPDATE',
        entity: 'CompanyBankAccount',
        entityId: id,
        correlationId,
        details: {
          changedFields,
          bankName: updated.bankName,
        },
      });

      return this.mapToMaskedItem(updated);
    } catch (err: any) {
      if (err?.code === 'P2002' || err?.message?.includes('23505')) {
        const conflictErr = new Error(
          'A concurrent transaction modified the default bank account. Please retry.'
        );
        (conflictErr as { statusCode?: number }).statusCode = 409;
        throw conflictErr;
      }
      throw err;
    }
  }

  /**
   * Sets an account as the active default account transactionally
   */
  public static async setDefaultAccount(
    actor: AuthUser,
    id: string,
    correlationId?: string,
    client: PrismaClient = prisma
  ): Promise<CompanyBankAccountItem> {
    const existing = await client.companyBankAccount.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Bank account not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    if (!existing.isActive) {
      const err = new Error('Cannot designate an inactive bank account as default. Activate it first.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    try {
      const updated = await client.$transaction(async (tx) => {
        // Unset previous default
        await tx.companyBankAccount.updateMany({
          where: {
            companyId: actor.companyId,
            isDefault: true,
          },
          data: { isDefault: false },
        });

        // Set new default
        return tx.companyBankAccount.update({
          where: { id },
          data: { isDefault: true },
        });
      });

      await AuditService.log({
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'COMPANY_BANK_ACCOUNT_SET_DEFAULT',
        entity: 'CompanyBankAccount',
        entityId: id,
        correlationId,
        details: {
          bankName: updated.bankName,
          accountHolderName: updated.accountHolderName,
        },
      });

      return this.mapToMaskedItem(updated);
    } catch (err: any) {
      if (
        err?.code === 'P2002' ||
        err?.code === 'P2034' ||
        err?.message?.includes('23505') ||
        err?.message?.includes('40001') ||
        err?.message?.includes('40P01') ||
        err?.message?.includes('CompanyBankAccount_companyId_default_unique') ||
        err?.message?.includes('could not serialize') ||
        err?.message?.includes('deadlock')
      ) {
        const conflictErr = new Error(
          'A concurrent update modified the default bank account. Please refresh and try again.'
        );
        (conflictErr as { statusCode?: number }).statusCode = 409;
        throw conflictErr;
      }
      throw err;
    }
  }

  /**
   * Activates a bank account
   */
  public static async activateBankAccount(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<CompanyBankAccountItem> {
    const existing = await prisma.companyBankAccount.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Bank account not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    const updated = await prisma.companyBankAccount.update({
      where: { id },
      data: { isActive: true },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'COMPANY_BANK_ACCOUNT_ACTIVATE',
      entity: 'CompanyBankAccount',
      entityId: id,
      correlationId,
      details: { bankName: updated.bankName },
    });

    return this.mapToMaskedItem(updated);
  }

  /**
   * Deactivates a bank account.
   * Protects active default accounts from being deactivated without a designated replacement.
   */
  public static async deactivateBankAccount(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<CompanyBankAccountItem> {
    const existing = await prisma.companyBankAccount.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Bank account not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Invariant: Cannot deactivate the active default account
    if (existing.isDefault && existing.isActive) {
      const err = new Error(
        'Cannot deactivate the active default bank account. Please designate another active account as default before deactivating this account.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const updated = await prisma.companyBankAccount.update({
      where: { id },
      data: { isActive: false },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'COMPANY_BANK_ACCOUNT_DEACTIVATE',
      entity: 'CompanyBankAccount',
      entityId: id,
      correlationId,
      details: { bankName: updated.bankName },
    });

    return this.mapToMaskedItem(updated);
  }

  /**
   * Deletes a bank account with safety protections
   */
  public static async deleteBankAccount(
    actor: AuthUser,
    id: string,
    correlationId?: string
  ): Promise<{ success: boolean; id: string }> {
    const existing = await prisma.companyBankAccount.findUnique({
      where: { id },
    });

    if (!existing || existing.companyId !== actor.companyId) {
      const err = new Error('Bank account not found in this company.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Invariant: Cannot delete default account
    if (existing.isDefault) {
      const err = new Error(
        'Cannot delete the default bank account. Please designate another account as default first.'
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    await prisma.companyBankAccount.delete({
      where: { id },
    });

    await AuditService.log({
      companyId: actor.companyId,
      userId: actor.userId,
      action: 'COMPANY_BANK_ACCOUNT_DELETE',
      entity: 'CompanyBankAccount',
      entityId: id,
      correlationId,
      details: { bankName: existing.bankName },
    });

    return { success: true, id };
  }
}
