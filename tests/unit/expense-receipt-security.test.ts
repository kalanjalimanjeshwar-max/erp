import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { ReceiptStorageService } from '../../src/server/services/receipt-storage.service.js';
import { AuthUser } from '../../src/shared/types.js';
import { prisma } from '../../src/server/db/client.js';

vi.mock('../../src/server/db/client.js', () => ({
  prisma: {
    expenseClaim: {
      findUnique: vi.fn(),
    },
    expenseClaimAttachment: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    employee: {
      findFirst: vi.fn(),
    },
  },
}));

describe('ReceiptStorageService - Security & MIME Magic Bytes Validation', () => {
  const actor: AuthUser = {
    id: 'user-emp-01',
    userId: 'user-emp-01',
    companyId: '44444444-4444-4444-4444-444444444444',
    email: 'test@company.com',
    fullName: 'Test Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. should accept genuine PDF magic bytes (%PDF-)', () => {
    // Valid PDF signature: 0x25, 0x50, 0x44, 0x46, 0x2D
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
    const result = ReceiptStorageService.validateMagicBytes(pdfBuffer, 'application/pdf');

    expect(result.valid).toBe(true);
    expect(result.mimeType).toBe('application/pdf');
  });

  it('2. should accept genuine PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)', () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const result = ReceiptStorageService.validateMagicBytes(pngBuffer, 'image/png');

    expect(result.valid).toBe(true);
    expect(result.mimeType).toBe('image/png');
  });

  it('3. should accept genuine JPEG magic bytes (FF D8 FF)', () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const result = ReceiptStorageService.validateMagicBytes(jpegBuffer, 'image/jpeg');

    expect(result.valid).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('4. should accept genuine WebP magic bytes (RIFF....WEBP)', () => {
    const webpBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x24, 0x00, 0x00, 0x00, // Size
      0x57, 0x45, 0x42, 0x50, // WEBP
      0x56, 0x50, 0x38, 0x20, // VP8
    ]);
    const result = ReceiptStorageService.validateMagicBytes(webpBuffer, 'image/webp');

    expect(result.valid).toBe(true);
    expect(result.mimeType).toBe('image/webp');
  });

  it('5. should reject spoofed files (e.g. executable script renamed to .pdf)', () => {
    // Malicious shell script or text: "#!/bin/bash" or "MZ..."
    const fakePdfBuffer = Buffer.from('#!/bin/bash\necho "exploit"\n');
    const result = ReceiptStorageService.validateMagicBytes(fakePdfBuffer, 'application/pdf');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('File signature does not match allowed receipt formats');
  });

  it('6. should reject files exceeding the 10MB limit', () => {
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
    // Even if it starts with PDF magic bytes
    bigBuffer[0] = 0x25;
    bigBuffer[1] = 0x50;
    bigBuffer[2] = 0x44;
    bigBuffer[3] = 0x46;
    bigBuffer[4] = 0x2d;

    const result = ReceiptStorageService.validateMagicBytes(bigBuffer, 'application/pdf');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exceeds the 10MB limit');
  });

  it('7. should compute deterministic SHA-256 cryptographic hash of receipt buffer', () => {
    const sampleBuffer = Buffer.from('Receipt sample content for travel reimbursement 2026');
    const hash1 = ReceiptStorageService.computeHash(sampleBuffer);
    const hash2 = ReceiptStorageService.computeHash(sampleBuffer);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex string length
  });

  it('8. should reject uploading receipt to non-DRAFT claim or another employee claim before writing to disk', async () => {
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');

    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-other',
      companyId: actor.companyId,
      status: 'DRAFT',
      employee: { userId: 'another-user-id' },
    });

    await expect(
      ReceiptStorageService.storeReceipt(actor, 'receipt.pdf', pdfBuffer, 'application/pdf', 'claim-other')
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(writeSpy).not.toHaveBeenCalled();

    (prisma.expenseClaim.findUnique as any).mockResolvedValue({
      id: 'claim-submitted',
      companyId: actor.companyId,
      status: 'SUBMITTED',
      employee: { userId: actor.id },
    });

    await expect(
      ReceiptStorageService.storeReceipt(actor, 'receipt.pdf', pdfBuffer, 'application/pdf', 'claim-submitted')
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('9. should block path traversal / sibling prefix escape in getReceiptFile', async () => {
    (prisma.expenseClaimAttachment.findUnique as any).mockResolvedValue({
      id: 'att-traversal',
      companyId: actor.companyId,
      fileName: 'secret.pdf',
      storageKey: '../44444444-4444-4444-4444-444444444444-other/secret.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 128,
      sha256Hash: 'a'.repeat(64),
      uploadedByUserId: actor.id,
      createdAt: new Date(),
      claim: null,
    });

    await expect(
      ReceiptStorageService.getReceiptFile(actor, 'att-traversal')
    ).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('missing from storage'),
    });
  });

  it('10. should unlink orphaned file if attachment database creation fails', async () => {
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
    (prisma.expenseClaimAttachment.create as any).mockRejectedValue(new Error('DB write failure'));

    await expect(
      ReceiptStorageService.storeReceipt(actor, 'receipt.pdf', pdfBuffer, 'application/pdf')
    ).rejects.toThrow('DB write failure');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);

    writeSpy.mockRestore();
    unlinkSpy.mockRestore();
  });
});
