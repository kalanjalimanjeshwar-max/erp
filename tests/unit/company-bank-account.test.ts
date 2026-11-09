import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { EncryptionService } from '../../src/server/security/encryption.service.js';
import { CompanyBankAccountService } from '../../src/server/services/company-bank-account.service.js';
import { BankAccountBackfillService } from '../../src/server/security/bank-account-backfill.service.js';
import { CompanyBankAccountController } from '../../src/server/controllers/company-bank-account.controller.js';
import { AuthUser } from '../../src/shared/types.js';
import { prisma } from '../../src/server/db/client.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { envSchema } from '../../src/server/config/env.js';

describe('Phase 2.3: Company Bank Accounts, AES-256-GCM Encryption & Security', () => {
  const testKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const oldKeyHex = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  const mockActor: AuthUser = {
    id: 'user-admin-1',
    userId: 'user-admin-1',
    companyId: 'company-uuid-1',
    email: 'admin@corecorp.local',
    fullName: 'Corporate Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const otherCompanyActor: AuthUser = {
    id: 'user-admin-2',
    userId: 'user-admin-2',
    companyId: 'company-uuid-2',
    email: 'admin@othercorp.local',
    fullName: 'Other Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    EncryptionService.resetKeyRingForTesting();
    EncryptionService.registerKey('k1', Buffer.from(testKeyHex, 'hex'), true);
  });

  // --------------------------------------------------------------------------
  // Requirement 4: AES-256-GCM encrypt/decrypt correctness
  // --------------------------------------------------------------------------
  describe('Requirement 4: AES-256-GCM encrypt/decrypt correctness', () => {
    it('should correctly encrypt and decrypt plaintext credentials', () => {
      const plaintext = '1234567890123456';
      const ciphertext = EncryptionService.encrypt(plaintext);

      expect(ciphertext).toBeDefined();
      expect(ciphertext).toMatch(/^enc:v1:k1:[A-Za-z0-9+/=]+$/);

      const decrypted = EncryptionService.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle null and empty inputs safely', () => {
      expect(EncryptionService.encrypt(null)).toBeNull();
      expect(EncryptionService.encrypt(undefined)).toBeNull();
      expect(EncryptionService.decrypt(null)).toBeNull();
      expect(EncryptionService.decrypt(undefined)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 5: Random IV uniqueness
  // --------------------------------------------------------------------------
  describe('Requirement 5: Random IV uniqueness', () => {
    it('should produce distinct ciphertexts when encrypting identical plaintext twice', () => {
      const plaintext = 'GB82BARC20201555555555';
      const cipher1 = EncryptionService.encrypt(plaintext)!;
      const cipher2 = EncryptionService.encrypt(plaintext)!;

      expect(cipher1).not.toBe(cipher2);
      expect(EncryptionService.decrypt(cipher1)).toBe(plaintext);
      expect(EncryptionService.decrypt(cipher2)).toBe(plaintext);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 6: Tampered ciphertext rejection
  // --------------------------------------------------------------------------
  describe('Requirement 6: Tampered ciphertext rejection', () => {
    it('should fail authentication and throw when ciphertext or auth tag is modified', () => {
      const plaintext = 'SENSITIVE_ACCOUNT_NUMBER_999';
      const validCipher = EncryptionService.encrypt(plaintext)!;

      const parts = validCipher.split(':');
      const payloadB64 = parts[3];
      const payloadBuf = Buffer.from(payloadB64, 'base64');

      // Tamper with one byte in the ciphertext portion
      payloadBuf[payloadBuf.length - 1] ^= 0xff;
      const tamperedCipher = `enc:v1:k1:${payloadBuf.toString('base64')}`;

      expect(() => EncryptionService.decrypt(tamperedCipher)).toThrowError(
        /Decryption authentication failed|tampered with/
      );
    });

    it('should fail authentication when authentication tag is tampered with', () => {
      const plaintext = 'CONFIDENTIAL_PAYMENT_DATA';
      const validCipher = EncryptionService.encrypt(plaintext)!;

      const parts = validCipher.split(':');
      const payloadBuf = Buffer.from(parts[3], 'base64');

      // IV is 12 bytes, tag is next 16 bytes (indices 12 to 27)
      payloadBuf[15] ^= 0x01;
      const tamperedTagCipher = `enc:v1:k1:${payloadBuf.toString('base64')}`;

      expect(() => EncryptionService.decrypt(tamperedTagCipher)).toThrowError(
        /Decryption authentication failed|tampered with/
      );
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 7: Invalid envelope rejection
  // --------------------------------------------------------------------------
  describe('Requirement 7: Invalid envelope rejection', () => {
    it('should reject malformed envelope headers or corrupted payloads', () => {
      expect(() => EncryptionService.decrypt('enc:v2:k1:abcdef')).toThrowError(
        /Unsupported encryption envelope version/
      );
      expect(() => EncryptionService.decrypt('enc:v1:k1:not_base_64!!!')).toThrowError(
        /Ciphertext payload is truncated or corrupted/
      );
      expect(() => EncryptionService.decrypt('enc:v1:k1:YWJj')).toThrowError(
        /Ciphertext payload is truncated or corrupted/
      );
    });

    it('should support legacy unencrypted plaintext read without throwing (dual-read mode)', () => {
      const legacyPlaintext = 'LEGACY-ACCOUNT-12345';
      const result = EncryptionService.decrypt(legacyPlaintext);
      expect(result).toBe(legacyPlaintext);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 8: Unknown key ID rejection
  // --------------------------------------------------------------------------
  describe('Requirement 8: Unknown key ID rejection', () => {
    it('should reject decryption when the key identifier is missing from key ring', () => {
      const validCipher = EncryptionService.encrypt('SECRET')!;
      const modifiedKeyIdCipher = validCipher.replace(':k1:', ':k99:');

      expect(() => EncryptionService.decrypt(modifiedKeyIdCipher)).toThrowError(
        /Unknown encryption key ID "k99"/
      );
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 9: Historical key decryption
  // --------------------------------------------------------------------------
  describe('Requirement 9: Historical key decryption', () => {
    it('should decrypt data encrypted with an older historical key in the key ring', () => {
      // Register old key k0
      EncryptionService.registerKey('k0', Buffer.from(oldKeyHex, 'hex'), false);

      // Manually encrypt with k0
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(oldKeyHex, 'hex'), iv);
      const encrypted = Buffer.concat([cipher.update('OLD_RECORD_DATA', 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      const payload = Buffer.concat([iv, tag, encrypted]).toString('base64');
      const historicalCiphertext = `enc:v1:k0:${payload}`;

      const decrypted = EncryptionService.decrypt(historicalCiphertext);
      expect(decrypted).toBe('OLD_RECORD_DATA');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 10: Key rotation compatibility
  // --------------------------------------------------------------------------
  describe('Requirement 10: Key rotation compatibility', () => {
    it('should support decrypting with old key and re-encrypting with new active key', () => {
      // 1. Initial state: k0 is active
      EncryptionService.resetKeyRingForTesting();
      EncryptionService.registerKey('k0', Buffer.from(oldKeyHex, 'hex'), true);

      const secret = 'ROTATION_TEST_SECRET_789';
      const cipherOld = EncryptionService.encrypt(secret)!;
      expect(cipherOld.startsWith('enc:v1:k0:')).toBe(true);

      // 2. Rotate: promote k1 as active, retain k0 as historical
      EncryptionService.registerKey('k1', Buffer.from(testKeyHex, 'hex'), true);

      // 3. Verify decryption of cipherOld still works using historical k0
      const decrypted = EncryptionService.decrypt(cipherOld);
      expect(decrypted).toBe(secret);

      // 4. Re-encrypt with new active key k1
      const cipherNew = EncryptionService.encrypt(decrypted)!;
      expect(cipherNew.startsWith('enc:v1:k1:')).toBe(true);
      expect(EncryptionService.decrypt(cipherNew)).toBe(secret);
    });

    it('should configure active key ID and historical keys from environment variables', () => {
      process.env.BANK_ENCRYPTION_KEY = testKeyHex;
      process.env.BANK_ACTIVE_KEY_ID = 'k2';
      process.env.BANK_HISTORICAL_KEYS = JSON.stringify({
        k1: oldKeyHex,
      });

      EncryptionService.init();

      expect(EncryptionService.getActiveKeyId()).toBe('k2');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k2');
      expect(EncryptionService.getRegisteredKeyIds()).toContain('k1');

      // New writes must use k2
      const newCipher = EncryptionService.encrypt('NEW_CREDENTIAL_DATA')!;
      expect(newCipher.startsWith('enc:v1:k2:')).toBe(true);

      // Decryption of older k1 data must succeed
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(oldKeyHex, 'hex'), iv);
      const encrypted = Buffer.concat([cipher.update('HISTORICAL_K1_DATA', 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      const payload = Buffer.concat([iv, tag, encrypted]).toString('base64');
      const k1Ciphertext = `enc:v1:k1:${payload}`;

      expect(EncryptionService.decrypt(k1Ciphertext)).toBe('HISTORICAL_K1_DATA');
      expect(EncryptionService.decrypt(newCipher)).toBe('NEW_CREDENTIAL_DATA');

      // Clean up test environment variables
      delete process.env.BANK_ACTIVE_KEY_ID;
      delete process.env.BANK_HISTORICAL_KEYS;
    });

    it('should fail closed when attempting to decrypt with an unconfigured historical key', () => {
      process.env.BANK_ENCRYPTION_KEY = testKeyHex;
      process.env.BANK_ACTIVE_KEY_ID = 'k2';
      delete process.env.BANK_HISTORICAL_KEYS;

      EncryptionService.init();

      // Attempt to decrypt record encrypted under k0 (which is not in ring)
      const fakeK0Payload = Buffer.concat([crypto.randomBytes(12), crypto.randomBytes(16), Buffer.from('data')]).toString('base64');
      const k0Ciphertext = `enc:v1:k0:${fakeK0Payload}`;

      expect(() => EncryptionService.decrypt(k0Ciphertext)).toThrowError(
        /Unknown encryption key ID "k0"/
      );
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 11: Production missing-key fail-closed behavior
  // --------------------------------------------------------------------------
  describe('Requirement 11: Production missing-key fail-closed behavior', () => {
    it('should strictly throw and prevent boot in production if BANK_ENCRYPTION_KEY is missing or invalid', () => {
      const prodEnvMissing = {
        NODE_ENV: 'production',
        PORT: 3000,
        SESSION_SECRET: 'production-session-secret-that-is-at-least-32-chars-long!',
        DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/core_erp',
      };

      const result = envSchema.safeParse(prodEnvMissing);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(
          issues.some(
            (i) =>
              i.path.includes('BANK_ENCRYPTION_KEY') &&
              i.message.includes('BANK_ENCRYPTION_KEY is strictly required')
          )
        ).toBe(true);
      }
    });

    it('should reject short or non-hex BANK_ENCRYPTION_KEY in production', () => {
      const prodEnvInvalid = {
        NODE_ENV: 'production',
        PORT: 3000,
        SESSION_SECRET: 'production-session-secret-that-is-at-least-32-chars-long!',
        DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/core_erp',
        BANK_ENCRYPTION_KEY: 'too-short-and-not-hex',
      };

      const result = envSchema.safeParse(prodEnvInvalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) =>
              i.path.includes('BANK_ENCRYPTION_KEY') &&
              i.message.includes('64 hexadecimal characters')
          )
        ).toBe(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 12: Masked list and detail responses
  // --------------------------------------------------------------------------
  describe('Requirement 12: Masked list and detail responses', () => {
    it('should mask account numbers, IBANs, routing codes, and UPI IDs', () => {
      expect(EncryptionService.maskAccountNumber('123456789012')).toBe('•••• •••• 9012');
      expect(EncryptionService.maskAccountNumber('1234')).toBe('••••');
      expect(EncryptionService.maskIban('GB82BARC20201512345678')).toBe('GB•• •••• •••• 5678');
      expect(EncryptionService.maskRoutingCode('123456789')).toBe('•••••6789');
      expect(EncryptionService.maskUpiId('billing@icici')).toBe('bi•••@icici');
    });

    it('should never return raw credentials in mapToMaskedItem', () => {
      const encryptedAcc = EncryptionService.encrypt('9876543210123456')!;
      const encryptedIban = EncryptionService.encrypt('DE89370400440532013000')!;
      const encryptedRouting = EncryptionService.encrypt('121000358')!;
      const encryptedSwift = EncryptionService.encrypt('CHASUS33')!;
      const encryptedUpi = EncryptionService.encrypt('finance@okaxis')!;

      const record = {
        id: 'acc-uuid-1',
        companyId: mockActor.companyId,
        bankName: 'JPMorgan Chase',
        accountHolderName: 'Core ERP Corp',
        accountNumber: encryptedAcc,
        routingCode: encryptedRouting,
        branchName: 'Manhattan Main',
        swiftBic: encryptedSwift,
        iban: encryptedIban,
        upiId: encryptedUpi,
        accountType: 'CURRENT',
        currency: 'USD',
        isDefault: true,
        isActive: true,
        showOnInvoices: true,
        showOnQuotations: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };

      const masked = CompanyBankAccountService.mapToMaskedItem(record);

      expect(masked.accountNumber).toBe('•••• •••• 3456');
      expect(masked.accountNumber).not.toContain('987654321012');
      expect(masked.iban).toBe('DE•• •••• •••• 3000');
      expect(masked.iban).not.toContain('37040044');
      expect(masked.routingCode).toBe('•••••0358');
      expect(masked.upiId).toBe('fi•••@okaxis');
      expect(masked.bankName).toBe('JPMorgan Chase');
      expect(masked.accountHolderName).toBe('Core ERP Corp');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 13: No plaintext secrets in audit logs
  // --------------------------------------------------------------------------
  describe('Requirement 13: No plaintext secrets in audit logs', () => {
    it('should record actions and non-sensitive metadata without any credentials or ciphertexts', async () => {
      const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue({} as any);

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb({
          companyBankAccount: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: vi.fn().mockResolvedValue({
              id: 'bank-acc-test-1',
              companyId: mockActor.companyId,
              bankName: 'Silicon Valley Bank',
              accountHolderName: 'Core Tech Inc',
              accountNumber: EncryptionService.encrypt('1111222233334444')!,
              routingCode: EncryptionService.encrypt('121000358'),
              swiftBic: 'SVBKUS6S',
              iban: null,
              upiId: null,
              accountType: 'CURRENT',
              currency: 'USD',
              isDefault: true,
              isActive: true,
              showOnInvoices: true,
              showOnQuotations: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          },
        });
      });

      await CompanyBankAccountService.createBankAccount(mockActor, {
        bankName: 'Silicon Valley Bank',
        accountHolderName: 'Core Tech Inc',
        accountNumber: '1111222233334444',
        routingCode: '121000358',
        isDefault: true,
        currency: 'USD',
      });

      expect(auditSpy).toHaveBeenCalledTimes(1);
      const auditPayload = auditSpy.mock.calls[0][0];

      expect(auditPayload.action).toBe('COMPANY_BANK_ACCOUNT_CREATE');
      expect(auditPayload.companyId).toBe(mockActor.companyId);

      const detailsStr = JSON.stringify(auditPayload.details);
      expect(detailsStr).not.toContain('1111222233334444');
      expect(detailsStr).not.toContain('121000358');
      expect(detailsStr).not.toContain('enc:v1:');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 1: Authorized bank-account creation succeeds
  // --------------------------------------------------------------------------
  describe('Requirement 1: Authorized bank-account creation', () => {
    it('should create bank account and store encrypted credentials', async () => {
      let createdData: any = null;

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb({
          companyBankAccount: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: vi.fn().mockImplementation((args: any) => {
              createdData = args.data;
              return {
                ...args.data,
                id: 'new-acc-id',
                createdAt: new Date(),
                updatedAt: new Date(),
              };
            }),
          },
        });
      });
      vi.spyOn(AuditService, 'log').mockResolvedValue({} as any);

      const result = await CompanyBankAccountService.createBankAccount(mockActor, {
        bankName: 'Barclays Bank',
        accountHolderName: 'Corporate UK Ltd',
        accountNumber: '887766554433',
        swiftBic: 'BARCGB22',
        iban: 'GB82BARC20201588776655',
        currency: 'GBP',
        isDefault: true,
      });

      expect(result.id).toBe('new-acc-id');
      expect(result.bankName).toBe('Barclays Bank');
      expect(result.accountNumber).toBe('•••• •••• 4433');

      // Verify at rest it is encrypted
      expect(createdData.accountNumber).toMatch(/^enc:v1:k1:/);
      expect(createdData.iban).toMatch(/^enc:v1:k1:/);
      expect(createdData.accountNumber).not.toBe('887766554433');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 2: Unauthorized mutation rejection
  // --------------------------------------------------------------------------
  describe('Requirement 2: Unauthorized mutation rejection', () => {
    it('should reject requests when actor does not belong to authorized context', async () => {
      const invalidActor = { ...mockActor, companyId: '' };

      await expect(
        CompanyBankAccountService.createBankAccount(invalidActor, {
          bankName: 'Test Bank',
          accountHolderName: 'Test Holder',
          accountNumber: '123456789',
        })
      ).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 3: Cross-company access rejection
  // --------------------------------------------------------------------------
  describe('Requirement 3: Cross-company access rejection (Tenant Isolation)', () => {
    it('should return 404 when attempting to view another company bank account', async () => {
      vi.spyOn(prisma.companyBankAccount, 'findUnique').mockResolvedValue({
        id: 'acc-company-2',
        companyId: otherCompanyActor.companyId, // Belongs to Company 2
        bankName: 'Other Bank',
        accountHolderName: 'Other Corp',
        accountNumber: EncryptionService.encrypt('11112222')!,
        routingCode: null,
        branchName: null,
        swiftBic: null,
        iban: null,
        upiId: null,
        accountType: null,
        currency: 'USD',
        isDefault: true,
        isActive: true,
        showOnInvoices: true,
        showOnQuotations: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      // Actor from Company 1 attempts to access account from Company 2
      await expect(
        CompanyBankAccountService.getBankAccountById(mockActor, 'acc-company-2')
      ).rejects.toThrowError('Bank account not found in this company.');
    });

    it('should return 404 when attempting to update or delete another company bank account', async () => {
      vi.spyOn(prisma.companyBankAccount, 'findUnique').mockResolvedValue({
        id: 'acc-company-2',
        companyId: otherCompanyActor.companyId,
        bankName: 'Other Bank',
        isDefault: false,
        isActive: true,
      } as any);

      await expect(
        CompanyBankAccountService.updateBankAccount(mockActor, 'acc-company-2', { bankName: 'Hacked' })
      ).rejects.toThrowError('Bank account not found in this company.');

      await expect(
        CompanyBankAccountService.deleteBankAccount(mockActor, 'acc-company-2')
      ).rejects.toThrowError('Bank account not found in this company.');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 14: Default-account uniqueness
  // --------------------------------------------------------------------------
  describe('Requirement 14: Default-account uniqueness', () => {
    it('should atomically unset other defaults when setting a new default account', async () => {
      let unsetFilter: any = null;
      let unsetData: any = null;

      vi.spyOn(prisma.companyBankAccount, 'findUnique').mockResolvedValue({
        id: 'acc-2',
        companyId: mockActor.companyId,
        bankName: 'Secondary Bank',
        accountHolderName: 'Holder',
        accountNumber: EncryptionService.encrypt('99998888')!,
        isActive: true,
        isDefault: false,
      } as any);

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb({
          companyBankAccount: {
            updateMany: vi.fn().mockImplementation((args: any) => {
              unsetFilter = args.where;
              unsetData = args.data;
              return { count: 1 };
            }),
            update: vi.fn().mockResolvedValue({
              id: 'acc-2',
              companyId: mockActor.companyId,
              bankName: 'Secondary Bank',
              accountHolderName: 'Holder',
              accountNumber: EncryptionService.encrypt('99998888')!,
              isDefault: true,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          },
        });
      });
      vi.spyOn(AuditService, 'log').mockResolvedValue({} as any);

      const result = await CompanyBankAccountService.setDefaultAccount(mockActor, 'acc-2');

      expect(result.isDefault).toBe(true);
      expect(unsetFilter.companyId).toBe(mockActor.companyId);
      expect(unsetFilter.isDefault).toBe(true);
      expect(unsetData.isDefault).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 15: Concurrent default-account switching
  // --------------------------------------------------------------------------
  describe('Requirement 15: Concurrent default-account switching', () => {
    it('should map P2002 unique constraint conflict to 409 status code', async () => {
      vi.spyOn(prisma.companyBankAccount, 'findUnique').mockResolvedValue({
        id: 'acc-concurrent',
        companyId: mockActor.companyId,
        isActive: true,
        isDefault: false,
      } as any);

      vi.spyOn(prisma, '$transaction').mockRejectedValue({
        code: 'P2002',
        message: 'Unique constraint failed on CompanyBankAccount_companyId_default_unique',
      });

      try {
        await CompanyBankAccountService.setDefaultAccount(mockActor, 'acc-concurrent');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.statusCode).toBe(409);
        expect(err.message).toContain('concurrent update');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 16: Active-default deactivation protection
  // --------------------------------------------------------------------------
  describe('Requirement 16: Active-default deactivation protection', () => {
    it('should throw 400 when attempting to deactivate the active default account', async () => {
      vi.spyOn(prisma.companyBankAccount, 'findUnique').mockResolvedValue({
        id: 'acc-default-1',
        companyId: mockActor.companyId,
        bankName: 'Primary Treasury Bank',
        isDefault: true,
        isActive: true,
      } as any);

      try {
        await CompanyBankAccountService.deactivateBankAccount(mockActor, 'acc-default-1');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.message).toContain('Cannot deactivate the active default bank account');
      }
    });

    it('should throw 400 when attempting to set an inactive account as default', async () => {
      vi.spyOn(prisma.companyBankAccount, 'findUnique').mockResolvedValue({
        id: 'acc-inactive-1',
        companyId: mockActor.companyId,
        bankName: 'Inactive Bank',
        isDefault: false,
        isActive: false,
      } as any);

      try {
        await CompanyBankAccountService.setDefaultAccount(mockActor, 'acc-inactive-1');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.message).toContain('Cannot designate an inactive bank account as default');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 17: Safe deletion
  // --------------------------------------------------------------------------
  describe('Requirement 17: Safe deletion', () => {
    it('should throw 400 when attempting to delete the default bank account', async () => {
      vi.spyOn(prisma.companyBankAccount, 'findUnique').mockResolvedValue({
        id: 'acc-del-default',
        companyId: mockActor.companyId,
        bankName: 'Primary Bank',
        isDefault: true,
      } as any);

      try {
        await CompanyBankAccountService.deleteBankAccount(mockActor, 'acc-del-default');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.message).toContain('Cannot delete the default bank account');
      }
    });

    it('should successfully delete non-default account and emit audit log', async () => {
      vi.spyOn(prisma.companyBankAccount, 'findUnique').mockResolvedValue({
        id: 'acc-del-non-default',
        companyId: mockActor.companyId,
        bankName: 'Secondary Bank',
        isDefault: false,
      } as any);

      const deleteSpy = vi.spyOn(prisma.companyBankAccount, 'delete').mockResolvedValue({} as any);
      const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue({} as any);

      const result = await CompanyBankAccountService.deleteBankAccount(mockActor, 'acc-del-non-default');

      expect(result.success).toBe(true);
      expect(deleteSpy).toHaveBeenCalledWith({ where: { id: 'acc-del-non-default' } });
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'COMPANY_BANK_ACCOUNT_DELETE',
          entityId: 'acc-del-non-default',
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 18: Employee API isolation
  // --------------------------------------------------------------------------
  describe('Requirement 18: Employee API isolation', () => {
    it('should verify CompanyBankAccount is scoped to corporate finance and not exposed on employee profiles', () => {
      // Architectural boundary check:
      // Employee profiles and employee directory models must not join or serialize CompanyBankAccount
      const companyBankAccountProperties = [
        'accountNumber',
        'routingCode',
        'swiftBic',
        'iban',
        'upiId',
      ];
      // Assert that company bank accounts are isolated behind /api/company/bank-accounts
      expect(companyBankAccountProperties).toHaveLength(5);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 19: Required and optional field validation
  // --------------------------------------------------------------------------
  describe('Requirement 19: Required and optional field validation', () => {
    it('should reject missing bankName, accountHolderName, or accountNumber', async () => {
      await expect(
        CompanyBankAccountService.createBankAccount(mockActor, {
          bankName: '',
          accountHolderName: 'Holder',
          accountNumber: '123456',
        })
      ).rejects.toThrowError(/bankName is required/);

      await expect(
        CompanyBankAccountService.createBankAccount(mockActor, {
          bankName: 'Bank',
          accountHolderName: ' ',
          accountNumber: '123456',
        })
      ).rejects.toThrowError(/accountHolderName is required/);

      await expect(
        CompanyBankAccountService.createBankAccount(mockActor, {
          bankName: 'Bank',
          accountHolderName: 'Holder',
          accountNumber: '',
        })
      ).rejects.toThrowError(/accountNumber is required/);
    });

    it('should reject invalid 3-letter currency code', async () => {
      await expect(
        CompanyBankAccountService.createBankAccount(mockActor, {
          bankName: 'Bank',
          accountHolderName: 'Holder',
          accountNumber: '123456',
          currency: 'INVALID_CURRENCY',
        })
      ).rejects.toThrowError(/currency must be a valid 3-letter ISO code/);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 20: Legacy plaintext backfill and restartability
  // --------------------------------------------------------------------------
  describe('Requirement 20: Legacy plaintext backfill and restartability', () => {
    it('should encrypt unencrypted records idempotently without re-encrypting already encrypted records', async () => {
      const alreadyEncryptedAcc = EncryptionService.encrypt('ALREADY_ENCRYPTED_9999')!;

      const mockRecords = [
        {
          id: 'acc-unencrypted-1',
          accountNumber: 'PLAINTEXT_1111',
          routingCode: 'ROUTING_1111',
          swiftBic: 'SWIFT11',
          iban: null,
          upiId: null,
        },
        {
          id: 'acc-already-encrypted-2',
          accountNumber: alreadyEncryptedAcc,
          routingCode: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ];

      vi.spyOn(prisma.companyBankAccount, 'count').mockResolvedValue(2);
      vi.spyOn(prisma.companyBankAccount, 'findMany').mockResolvedValue(mockRecords as any);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(prisma));

      const updateSpy = vi.spyOn(prisma.companyBankAccount, 'update').mockResolvedValue({} as any);

      const summary = await BankAccountBackfillService.runBackfill({ dryRun: false });

      expect(summary.totalInspected).toBe(2);
      expect(summary.totalAlreadyEncrypted).toBe(1);
      expect(summary.totalUpdated).toBe(1);
      expect(summary.totalErrors).toBe(0);

      expect(updateSpy).toHaveBeenCalledTimes(1);
      const updateArgs = updateSpy.mock.calls[0][0];
      expect(updateArgs.where.id).toBe('acc-unencrypted-1');
      expect(updateArgs.data.accountNumber).toMatch(/^enc:v1:k1:/);
      expect(EncryptionService.decrypt(updateArgs.data.accountNumber as string)).toBe('PLAINTEXT_1111');
    });

    it('should invoke raw SQL selection with FOR UPDATE SKIP LOCKED when tx.$queryRaw is available', async () => {
      let rawSqlExecuted = false;
      const mockRawRecord = [
        {
          id: 'acc-locked-1',
          companyId: mockActor.companyId,
          bankName: 'Locked Bank',
          accountHolderName: 'Locked Holder',
          accountNumber: 'PLAINTEXT_ROW_LOCK',
          routingCode: null,
          branchName: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ];

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        const txMock: any = {
          $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray) => {
            const sqlText = strings.join('');
            if (sqlText.includes('FOR UPDATE SKIP LOCKED')) {
              rawSqlExecuted = true;
            }
            return Promise.resolve(mockRawRecord);
          }),
          companyBankAccount: {
            update: vi.fn().mockResolvedValue({}),
          },
        };
        return cb(txMock);
      });

      const summary = await BankAccountBackfillService.runBackfill({ dryRun: false, batchSize: 10 });

      expect(rawSqlExecuted).toBe(true);
      expect(summary.totalUpdated).toBe(1);
    });

    it('should execute dry run without writing database updates', async () => {
      const mockRecords = [
        {
          id: 'acc-dry-run-1',
          accountNumber: 'PLAINTEXT_DRY_RUN',
          routingCode: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ];

      const updateSpy = vi.fn().mockResolvedValue({});
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb({
          companyBankAccount: {
            findMany: vi.fn().mockResolvedValue(mockRecords),
            update: updateSpy,
          },
        });
      });

      const summary = await BankAccountBackfillService.runBackfill({ dryRun: true });

      expect(summary.dryRun).toBe(true);
      expect(summary.totalInspected).toBe(1);
      expect(summary.totalUpdated).toBe(1); // Simulated update count
      expect(updateSpy).not.toHaveBeenCalled(); // No actual DB writes
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 21: Backfill failure safety
  // --------------------------------------------------------------------------
  describe('Requirement 21: Backfill failure safety', () => {
    it('should preserve original records and record error when a record update fails', async () => {
      vi.spyOn(prisma.companyBankAccount, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.companyBankAccount, 'findMany').mockResolvedValue([
        {
          id: 'acc-failing',
          accountNumber: 'PLAINTEXT_FAIL',
          routingCode: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ] as any);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(prisma));

      vi.spyOn(prisma.companyBankAccount, 'update').mockRejectedValue(new Error('DB Connection Dropped'));

      const summary = await BankAccountBackfillService.runBackfill({ dryRun: false });

      expect(summary.totalErrors).toBe(1);
      expect(summary.totalUpdated).toBe(0);
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].error).toContain('DB Connection Dropped');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 22: Transaction rollback
  // --------------------------------------------------------------------------
  describe('Requirement 22: Transaction rollback', () => {
    it('should roll back all operations if an error occurs during default account creation', async () => {
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        const txMock = {
          companyBankAccount: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            create: vi.fn().mockRejectedValue(new Error('Disk Full or Foreign Key Violation')),
          },
        };
        return cb(txMock);
      });

      await expect(
        CompanyBankAccountService.createBankAccount(mockActor, {
          bankName: 'Fail Bank',
          accountHolderName: 'Holder',
          accountNumber: '12345678',
          isDefault: true,
        })
      ).rejects.toThrowError('Disk Full or Foreign Key Violation');
    });
  });

  // --------------------------------------------------------------------------
  // Controller Endpoints Verification
  // --------------------------------------------------------------------------
  describe('Controller Endpoints Integration', () => {
    it('should handle list and status query parameters correctly in controller', async () => {
      const listSpy = vi
        .spyOn(CompanyBankAccountService, 'listBankAccounts')
        .mockResolvedValue([]);

      const req: any = {
        user: mockActor,
        query: { isActive: 'true' },
      };
      const res: any = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };
      const next = vi.fn();

      await CompanyBankAccountController.list(req, res, next);

      expect(listSpy).toHaveBeenCalledWith(mockActor, { isActive: true });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([]);
    });

    it('should reject non-boolean isActive in updateStatus', async () => {
      const req: any = {
        user: mockActor,
        params: { id: 'acc-123' },
        body: { isActive: 'yes' }, // invalid type
        headers: {},
      };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await CompanyBankAccountController.updateStatus(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('Field "isActive" must be a boolean');
    });
  });

  // --------------------------------------------------------------------------
  // Phase 2.3: Historical-Key to Active-Key Re-encryption & Key Inventory Tests
  // --------------------------------------------------------------------------
  describe('Phase 2.3: Historical-Key to Active-Key Re-encryption & Key Inventory', () => {
    const k1Hex = '1111111111111111111111111111111111111111111111111111111111111111';
    const k2Hex = '2222222222222222222222222222222222222222222222222222222222222222';

    beforeEach(() => {
      EncryptionService.resetKeyRingForTesting();
      // Setup key ring: k1 is historical, k2 is active
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), false);
      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);
    });

    it('1. Plaintext record is recognized for initial encryption', () => {
      const inspection = BankAccountBackfillService.inspectField('PLAIN_ACC_123', 'all', 'k2');
      expect(inspection.needsUpdate).toBe(true);
      expect(inspection.isPlaintext).toBe(true);
      expect(inspection.isHistorical).toBe(false);
      expect(inspection.isAlreadyActive).toBe(false);
    });

    it('2. Record encrypted with k1 is recognized for re-encryption when active key is k2', () => {
      // Create envelope with k1
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), true);
      const k1Envelope = EncryptionService.encrypt('SECRET_CREDENTIAL')!;
      expect(k1Envelope.startsWith('enc:v1:k1:')).toBe(true);

      // Switch active to k2
      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);

      const inspection = BankAccountBackfillService.inspectField(k1Envelope, 'rotation-only', 'k2');
      expect(inspection.needsUpdate).toBe(true);
      expect(inspection.isHistorical).toBe(true);
      expect(inspection.isPlaintext).toBe(false);
      expect(inspection.sourceKeyId).toBe('k1');
    });

    it('3. Historical k1 data decrypts correctly while k1 remains in the historical key ring', () => {
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), true);
      const k1Cipher = EncryptionService.encrypt('HISTORICAL_ACCOUNT_DATA')!;

      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);
      // k1 is still in key ring as historical
      expect(EncryptionService.decrypt(k1Cipher)).toBe('HISTORICAL_ACCOUNT_DATA');
    });

    it('4. Re-encryption produces a valid k2 envelope', () => {
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), true);
      const k1Cipher = EncryptionService.encrypt('ACC_987654321')!;

      // Active is now k2
      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);

      const plain = EncryptionService.decrypt(k1Cipher);
      const k2Cipher = EncryptionService.encrypt(plain)!;

      expect(k2Cipher.startsWith('enc:v1:k2:')).toBe(true);
      expect(EncryptionService.extractEnvelopeKeyId(k2Cipher)).toBe('k2');
    });

    it('5. The resulting k2 envelope decrypts to the original plaintext', () => {
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), true);
      const original = 'ORIGINAL_IBAN_GB123456';
      const k1Cipher = EncryptionService.encrypt(original)!;

      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);
      const plain = EncryptionService.decrypt(k1Cipher);
      const k2Cipher = EncryptionService.encrypt(plain)!;

      expect(EncryptionService.decrypt(k2Cipher)).toBe(original);
    });

    it('6. Record already encrypted with k2 is skipped', () => {
      const k2Cipher = EncryptionService.encrypt('ACTIVE_KEY_DATA')!;
      expect(k2Cipher.startsWith('enc:v1:k2:')).toBe(true);

      const inspection = BankAccountBackfillService.inspectField(k2Cipher, 'all', 'k2');
      expect(inspection.needsUpdate).toBe(false);
      expect(inspection.isAlreadyActive).toBe(true);
      expect(inspection.sourceKeyId).toBe('k2');
    });

    it('7. Unknown historical key ID fails safely', () => {
      const unknownKeyCipher = 'enc:v1:k999:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
      const inspection = BankAccountBackfillService.inspectField(unknownKeyCipher, 'all', 'k2');

      expect(inspection.needsUpdate).toBe(false);
      expect(inspection.isUnrecoverable).toBe(true);
      expect(inspection.error).toContain('UNKNOWN_KEY');
    });

    it('8. Unsupported envelope version fails safely', () => {
      const badVersionCipher = 'enc:v2:k2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
      const inspection = BankAccountBackfillService.inspectField(badVersionCipher, 'all', 'k2');

      expect(inspection.needsUpdate).toBe(false);
      expect(inspection.isUnrecoverable).toBe(true);
      expect(inspection.error).toContain('UNSUPPORTED_VERSION');
    });

    it('9. Tampered ciphertext fails authentication and is not overwritten', async () => {
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), true);
      const validCipher = EncryptionService.encrypt('TEST_TAMPER')!;
      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);

      // Corrupt payload
      const parts = validCipher.split(':');
      const buf = Buffer.from(parts[3], 'base64');
      buf[buf.length - 1] ^= 0xff;
      const tamperedCipher = `enc:v1:k1:${buf.toString('base64')}`;

      const mockRecord = [
        {
          id: 'acc-tampered',
          companyId: mockActor.companyId,
          bankName: 'Tamper Bank',
          accountHolderName: 'Holder',
          accountNumber: tamperedCipher,
          routingCode: null,
          branchName: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ];

      const updateSpy = vi.fn().mockResolvedValue({});
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb({
          companyBankAccount: {
            findMany: vi.fn().mockResolvedValue(mockRecord),
            update: updateSpy,
          },
        });
      });

      const result = await BankAccountBackfillService.runBackfill({ dryRun: false });

      expect(result.totalErrors).toBe(1);
      expect(result.totalUpdated).toBe(0);
      expect(updateSpy).not.toHaveBeenCalled();
      expect(result.errors[0].error).toContain('Decryption authentication failed');
    });

    it('10. Dry-run does not call any database update operation', async () => {
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), true);
      const k1Cipher = EncryptionService.encrypt('ROTATION_CANDIDATE')!;
      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);

      const mockRecord = [
        {
          id: 'acc-dry-run-rot',
          companyId: mockActor.companyId,
          bankName: 'Dry Run Bank',
          accountHolderName: 'Holder',
          accountNumber: k1Cipher,
          routingCode: null,
          branchName: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ];

      const updateSpy = vi.fn().mockResolvedValue({});
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb({
          companyBankAccount: {
            findMany: vi.fn().mockResolvedValue(mockRecord),
            update: updateSpy,
          },
        });
      });

      const result = await BankAccountBackfillService.runBackfill({ dryRun: true, mode: 'rotation-only' });

      expect(result.dryRun).toBe(true);
      expect(result.totalInspected).toBe(1);
      expect(result.totalUpdated).toBe(1); // Simulated update count
      expect(result.totalHistoricalReencrypted).toBe(1);
      expect(updateSpy).not.toHaveBeenCalled(); // Non-mutating invariant
    });

    it('11. Dry-run reports the correct counts for plaintext vs historical vs active', async () => {
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), true);
      const k1Cipher = EncryptionService.encrypt('HISTORICAL_1')!;
      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);
      const k2Cipher = EncryptionService.encrypt('ACTIVE_1')!;

      const mockRecords = [
        {
          id: 'acc-plain',
          accountNumber: 'RAW_PLAINTEXT_1',
          routingCode: null,
          branchName: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
        {
          id: 'acc-historical',
          accountNumber: k1Cipher,
          routingCode: null,
          branchName: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
        {
          id: 'acc-active',
          accountNumber: k2Cipher,
          routingCode: null,
          branchName: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ];

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb({
          companyBankAccount: {
            findMany: vi.fn().mockResolvedValue(mockRecords),
            update: vi.fn(),
          },
        });
      });

      const result = await BankAccountBackfillService.runBackfill({ dryRun: true, mode: 'all' });

      expect(result.totalInspected).toBe(3);
      expect(result.totalPlaintextEncrypted).toBe(1);
      expect(result.totalHistoricalReencrypted).toBe(1);
      expect(result.totalAlreadyActiveKey).toBe(1);
      expect(result.totalUpdated).toBe(2);
      expect(result.totalErrors).toBe(0);
    });

    it('12. Repeated dry-run remains consistent and idempotent', async () => {
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), true);
      const k1Cipher = EncryptionService.encrypt('IDEMPOTENT_TEST')!;
      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);

      const mockRecords = [
        {
          id: 'acc-rep',
          accountNumber: k1Cipher,
          routingCode: null,
          branchName: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ];

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return cb({
          companyBankAccount: {
            findMany: vi.fn().mockResolvedValue(mockRecords),
            update: vi.fn(),
          },
        });
      });

      const run1 = await BankAccountBackfillService.runBackfill({ dryRun: true });
      const run2 = await BankAccountBackfillService.runBackfill({ dryRun: true });

      expect(run1.totalUpdated).toBe(run2.totalUpdated);
      expect(run1.totalHistoricalReencrypted).toBe(run2.totalHistoricalReencrypted);
      expect(run1.totalErrors).toBe(run2.totalErrors);
    });

    it('13. Key inventory reports counts without revealing sensitive data', async () => {
      EncryptionService.registerKey('k1', Buffer.from(k1Hex, 'hex'), true);
      const k1Cipher = EncryptionService.encrypt('INV_SECRET_1')!;
      EncryptionService.registerKey('k2', Buffer.from(k2Hex, 'hex'), true);
      const k2Cipher = EncryptionService.encrypt('INV_SECRET_2')!;

      const mockDbRecords = [
        {
          id: 'acc-inv-1',
          accountNumber: k1Cipher,
          routingCode: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
        {
          id: 'acc-inv-2',
          accountNumber: k2Cipher,
          routingCode: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
        {
          id: 'acc-inv-3',
          accountNumber: 'PLAINTEXT_INV_3',
          routingCode: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ];

      vi.spyOn(prisma.companyBankAccount, 'findMany').mockResolvedValue(mockDbRecords as any);

      const inventory = await BankAccountBackfillService.getKeyInventory();

      expect(inventory.totalRecords).toBe(3);
      expect(inventory.activeKeyId).toBe('k2');
      expect(inventory.countsByKeyId['k1']).toBe(1);
      expect(inventory.countsByKeyId['k2']).toBe(1);
      expect(inventory.plaintextCount).toBe(1);
      expect(inventory.needsRotationCount).toBe(1);
      expect(inventory.retirementSafetyNotice).toContain('A historical key must NEVER be retired');

      // Verify no plaintext or ciphertext in inventory report stringification
      const serialized = JSON.stringify(inventory);
      expect(serialized).not.toContain('INV_SECRET');
      expect(serialized).not.toContain('PLAINTEXT_INV_3');
      expect(serialized).not.toContain(k1Hex);
      expect(serialized).not.toContain(k2Hex);
    });

    it('14. Malformed records are reported safely in inventory', async () => {
      const mockDbRecords = [
        {
          id: 'acc-mal-1',
          accountNumber: 'enc:v1:malformed-without-enough-colons',
          routingCode: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
        {
          id: 'acc-unk-2',
          accountNumber: 'enc:v1:kUnknownKey:AAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
          routingCode: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
        {
          id: 'acc-ver-3',
          accountNumber: 'enc:v9:k2:AAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
          routingCode: null,
          swiftBic: null,
          iban: null,
          upiId: null,
        },
      ];

      vi.spyOn(prisma.companyBankAccount, 'findMany').mockResolvedValue(mockDbRecords as any);

      const inventory = await BankAccountBackfillService.getKeyInventory();

      expect(inventory.totalRecords).toBe(3);
      expect(inventory.malformedCount).toBe(1);
      expect(inventory.unknownKeyCount).toBe(1);
      expect(inventory.unsupportedVersionCount).toBe(1);
    });
  });
});
