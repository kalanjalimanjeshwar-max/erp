import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AuthUser, ExpenseClaimAttachmentItem } from '../../shared/types.js';
import { prisma } from '../db/client.js';

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export interface ReceiptValidationResult {
  valid: boolean;
  mimeType: string;
  error?: string;
}

export class ReceiptStorageService {
  private static readonly STORAGE_ROOT = path.resolve(process.cwd(), 'storage', 'receipts');

  /**
   * Validates file magic bytes to verify file authenticity and prevent MIME spoofing
   */
  static validateMagicBytes(buffer: Buffer, declaredMimeType: string): ReceiptValidationResult {
    if (!buffer || buffer.length < 4) {
      return { valid: false, mimeType: declaredMimeType, error: 'File is empty or too small.' };
    }

    if (buffer.length > MAX_ATTACHMENT_SIZE_BYTES) {
      return {
        valid: false,
        mimeType: declaredMimeType,
        error: `File size exceeds the 10MB limit (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB).`,
      };
    }

    // PDF Magic Bytes: %PDF- (0x25 0x50 0x44 0x46 0x2D)
    if (
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46
    ) {
      return { valid: true, mimeType: 'application/pdf' };
    }

    // PNG Magic Bytes: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { valid: true, mimeType: 'image/png' };
    }

    // JPEG Magic Bytes: FF D8 FF
    if (
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return { valid: true, mimeType: 'image/jpeg' };
    }

    // WebP: RIFF .... WEBP
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return { valid: true, mimeType: 'image/webp' };
    }

    return {
      valid: false,
      mimeType: declaredMimeType,
      error: 'File signature does not match allowed receipt formats (PDF, PNG, JPEG, WebP).',
    };
  }

  /**
   * Computes SHA-256 cryptographic hash of buffer
   */
  static computeHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Saves receipt file safely to company storage directory and records database metadata
   */
  static async storeReceipt(
    actor: AuthUser,
    fileName: string,
    buffer: Buffer,
    declaredMimeType: string,
    claimId?: string
  ): Promise<ExpenseClaimAttachmentItem> {
    if (!actor.companyId) {
      const err = new Error('Company context is required.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    const validation = this.validateMagicBytes(buffer, declaredMimeType);
    if (!validation.valid) {
      const err = new Error(validation.error || 'Invalid file format.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    // If claimId is provided during upload, verify claim exists in company, is DRAFT, and actor has access
    if (claimId) {
      const claim = await prisma.expenseClaim.findUnique({
        where: { id: claimId },
        include: { employee: { select: { userId: true } } },
      });

      if (!claim || claim.companyId !== actor.companyId) {
        const err = new Error('Referenced expense claim not found in this company.');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }

      if (actor.role === 'EMPLOYEE' && claim.employee.userId !== (actor.userId || actor.id)) {
        const err = new Error('You do not have permission to attach receipts to another employee\'s claim.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }

      if (claim.status !== 'DRAFT') {
        const err = new Error('Receipts can only be attached while an expense claim is in DRAFT status.');
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    const sha256Hash = this.computeHash(buffer);
    const sanitizedFileName = path.basename(fileName || 'receipt').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `${crypto.randomUUID()}_${sanitizedFileName}`;

    const companyDir = path.resolve(this.STORAGE_ROOT, actor.companyId);
    const targetFilePath = path.resolve(companyDir, storageKey);

    // Verify strictly inside company directory (prevent sibling prefix collision and traversal)
    if (!targetFilePath.startsWith(companyDir + path.sep)) {
      const err = new Error('Invalid path traversal attempt.');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    if (!fs.existsSync(companyDir)) {
      fs.mkdirSync(companyDir, { recursive: true });
    }

    await fs.promises.writeFile(targetFilePath, buffer);

    try {
      const record = await prisma.expenseClaimAttachment.create({
        data: {
          companyId: actor.companyId,
          claimId: claimId || null,
          fileName: sanitizedFileName,
          storageKey,
          mimeType: validation.mimeType,
          fileSizeBytes: buffer.length,
          sha256Hash,
          uploadedByUserId: actor.userId || actor.id,
        },
      });

      return {
        id: record.id,
        claimId: record.claimId,
        companyId: record.companyId,
        fileName: record.fileName,
        mimeType: record.mimeType,
        fileSizeBytes: record.fileSizeBytes,
        sha256Hash: record.sha256Hash,
        uploadedByUserId: record.uploadedByUserId,
        createdAt: record.createdAt.toISOString(),
      };
    } catch (err) {
      // Clean up orphaned file if DB persistence fails
      await fs.promises.unlink(targetFilePath).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Retrieves receipt file stream and metadata, verifying actor authorization
   */
  static async getReceiptFile(
    actor: AuthUser,
    attachmentId: string
  ): Promise<{
    filePath: string;
    attachment: ExpenseClaimAttachmentItem;
  }> {
    const attachment = await prisma.expenseClaimAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        claim: {
          select: {
            employeeId: true,
            managerId: true,
            status: true,
          },
        },
      },
    });

    if (!attachment || attachment.companyId !== actor.companyId) {
      const err = new Error('Receipt attachment not found.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    // Role and ownership check:
    // If EMPLOYEE, must be uploader OR claim owner OR assigned manager
    if (actor.role === 'EMPLOYEE') {
      const currentEmployee = await prisma.employee.findFirst({
        where: { companyId: actor.companyId, userId: actor.userId || actor.id },
        select: { id: true },
      });

      const isUploader = attachment.uploadedByUserId === (actor.userId || actor.id);
      const isOwner = currentEmployee && attachment.claim?.employeeId === currentEmployee.id;
      const isAssignedManager = currentEmployee && attachment.claim?.managerId === currentEmployee.id;

      if (!isUploader && !isOwner && !isAssignedManager) {
        const err = new Error('You do not have permission to access this receipt attachment.');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      }
    }

    const companyDir = path.resolve(this.STORAGE_ROOT, actor.companyId);
    const targetFilePath = path.resolve(companyDir, attachment.storageKey);

    if (
      path.basename(attachment.storageKey) !== attachment.storageKey ||
      !targetFilePath.startsWith(companyDir + path.sep) ||
      !fs.existsSync(targetFilePath)
    ) {
      const err = new Error('Receipt file content missing from storage.');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }

    return {
      filePath: targetFilePath,
      attachment: {
        id: attachment.id,
        claimId: attachment.claimId,
        companyId: attachment.companyId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileSizeBytes: attachment.fileSizeBytes,
        sha256Hash: attachment.sha256Hash,
        uploadedByUserId: attachment.uploadedByUserId,
        createdAt: attachment.createdAt.toISOString(),
      },
    };
  }
}
