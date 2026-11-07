/**
 * Centralized Document Sequence Engine (Phase 2.2)
 *
 * Provides atomic, concurrency-safe, gap-preventing document numbering for:
 * - INVOICE (e.g. INV-2026-00001)
 * - QUOTATION (e.g. QTN-2026-00001)
 * - RECEIPT (e.g. REC-2026-00001)
 * - JOURNAL_VOUCHER (e.g. JV-2026-00001)
 *
 * Guarantees:
 * 1. Atomicity: Executed inside a PostgreSQL interactive transaction with row-level locks
 *    using INSERT ... ON CONFLICT ("companyId", "documentType", "prefix", "fiscalYear")
 *    DO UPDATE SET "lastNumber" = "DocumentNumberSequence"."lastNumber" + 1 RETURNING ...
 * 2. Simultaneous First-Time Initialization: Conflict-safe against unique key collisions.
 * 3. Rollback Safety: When executed inside caller's transaction, sequence increment rolls
 *    back atomically if document creation fails.
 * 4. Multi-Tenant Scoping: Independent counters partitioned by (companyId, documentType, prefix, fiscalYear).
 * 5. Bounded Retries: Exponential backoff with jitter on PostgreSQL serialization / conflict errors.
 * 6. Immutability: Once allocated, numbers are deterministic and protected from client override.
 */

import { DocumentNumberType, Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';

export const DEFAULT_DOCUMENT_PREFIXES: Readonly<Record<DocumentNumberType, string>> = Object.freeze({
  INVOICE: 'INV',
  QUOTATION: 'QTN',
  RECEIPT: 'REC',
  JOURNAL_VOUCHER: 'JV',
});

export const DEFAULT_PADDING_ZEROS = 5;
export const MAX_PADDING_ZEROS = 10;
export const MIN_PADDING_ZEROS = 1;
export const DEFAULT_MAX_RETRIES = 5;
export const BASE_RETRY_DELAY_MS = 25;

export interface AllocateDocumentNumberOptions {
  /** Optional transaction client for atomic document creation + sequence allocation */
  tx?: Prisma.TransactionClient;
  /** Explicit fiscal year string (e.g. "2026" or "2026-2027") or number */
  fiscalYear?: string | number;
  /** Transaction / document date used to resolve fiscal year if fiscalYear not provided */
  date?: Date | string;
  /** Custom prefix override (e.g. "QT" instead of default "QTN") */
  prefix?: string;
  /** Padding width for sequence number (default: 5) */
  paddingZeros?: number;
  /** Maximum retry attempts on concurrency conflict (default: 5) */
  maxRetries?: number;
}

export interface AllocatedDocumentNumber {
  /** Fully formatted document number, e.g. "INV-2026-00001" */
  formattedNumber: string;
  /** The assigned sequence integer (1-indexed) */
  sequenceNumber: number;
  /** Prefix used, e.g. "INV" */
  prefix: string;
  /** Fiscal year used, e.g. "2026" */
  fiscalYear: string;
  /** Target document type */
  documentType: DocumentNumberType;
  /** Owning tenant company UUID */
  companyId: string;
  /** Padding width applied */
  paddingZeros: number;
}

export interface ParsedDocumentNumber {
  prefix: string;
  fiscalYear: string;
  sequenceNumber: number;
  paddedSequence: string;
}

export class DocumentSequenceService {
  /**
   * Validates UUID string format
   */
  private static isValidUuid(id: string): boolean {
    if (!id || typeof id !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  }

  /**
   * Validates prefix format: 1-32 characters, uppercase alphanumeric, hyphens, and underscores only.
   */
  public static sanitizePrefix(prefix: string): string {
    const trimmed = (prefix || '').trim().toUpperCase();
    if (!trimmed || !/^[A-Z0-9_-]{1,32}$/.test(trimmed)) {
      throw new Error(
        `[INVALID_PREFIX] Document sequence prefix "${prefix}" is invalid. Must be 1-32 uppercase alphanumeric characters, hyphens, or underscores.`
      );
    }
    return trimmed;
  }

  /**
   * Resolves fiscal year string from explicit parameter, or company FY start month and date.
   */
  public static resolveFiscalYear(
    dateInput?: Date | string,
    customFiscalYear?: string | number,
    fiscalYearStartMonth: number = 1
  ): string {
    if (customFiscalYear !== undefined && customFiscalYear !== null) {
      const fyStr = String(customFiscalYear).trim();
      if (!/^[0-9]{4}(?:-[0-9]{2,4})?$/.test(fyStr)) {
        throw new Error(
          `[INVALID_FISCAL_YEAR] Fiscal year "${customFiscalYear}" is invalid. Expected format YYYY or YYYY-YYYY.`
        );
      }
      return fyStr;
    }

    const d = dateInput instanceof Date ? dateInput : dateInput ? new Date(dateInput) : new Date();
    if (isNaN(d.getTime())) {
      throw new Error(`[INVALID_DATE] Invalid document date provided for sequence allocation: "${dateInput}".`);
    }

    const startMonth = Math.max(1, Math.min(12, Math.floor(fiscalYearStartMonth)));
    if (startMonth === 1) {
      return d.getFullYear().toString();
    }

    // 1-indexed month (1 = Jan, 12 = Dec)
    const month = d.getMonth() + 1;
    if (month < startMonth) {
      return (d.getFullYear() - 1).toString();
    }
    return d.getFullYear().toString();
  }

  /**
   * Formats a document number string: {prefix}-{fiscalYear}-{paddedSequence}
   */
  public static formatDocumentNumber(
    prefix: string,
    fiscalYear: string,
    sequenceNumber: number,
    paddingZeros: number = DEFAULT_PADDING_ZEROS
  ): string {
    const cleanPrefix = DocumentSequenceService.sanitizePrefix(prefix);
    const cleanFy = String(fiscalYear).trim();
    const pad = Math.max(MIN_PADDING_ZEROS, Math.min(MAX_PADDING_ZEROS, Math.floor(paddingZeros)));
    const padded = String(sequenceNumber).padStart(pad, '0');
    return `${cleanPrefix}-${cleanFy}-${padded}`;
  }

  /**
   * Parses a formatted document number into its constituent components.
   */
  public static parseDocumentNumber(documentNumber: string): ParsedDocumentNumber | null {
    if (!documentNumber || typeof documentNumber !== 'string') return null;
    const match = documentNumber.trim().match(/^([A-Za-z0-9_-]+)-([0-9]{4}(?:-[0-9]{2,4})?)-([0-9]+)$/);
    if (!match) return null;

    return {
      prefix: match[1],
      fiscalYear: match[2],
      sequenceNumber: parseInt(match[3], 10),
      paddedSequence: match[3],
    };
  }

  /**
   * Allocates the next atomic, sequential document number.
   *
   * Must be called within a database transaction (either passing `options.tx` from caller's
   * document transaction, or creating a standalone transaction) to ensure:
   * 1. No race conditions under concurrent requests.
   * 2. Atomic rollback if document creation fails.
   */
  public static async allocateNextNumber(
    companyId: string,
    documentType: DocumentNumberType,
    options: AllocateDocumentNumberOptions = {}
  ): Promise<AllocatedDocumentNumber> {
    // 1. Multi-Tenant Validation
    if (!DocumentSequenceService.isValidUuid(companyId)) {
      throw new Error(`[INVALID_TENANT_ID] Valid companyId (UUID) is required for sequence allocation.`);
    }

    // 2. Document Type Validation
    const validTypes: DocumentNumberType[] = ['INVOICE', 'QUOTATION', 'RECEIPT', 'JOURNAL_VOUCHER'];
    if (!validTypes.includes(documentType)) {
      throw new Error(
        `[INVALID_DOCUMENT_TYPE] Unsupported document type "${documentType}". Must be one of: ${validTypes.join(', ')}`
      );
    }

    // 3. Prefix Resolution
    const rawPrefix = options.prefix || DEFAULT_DOCUMENT_PREFIXES[documentType];
    const prefix = DocumentSequenceService.sanitizePrefix(rawPrefix);

    // 4. Padding Resolution
    const requestedPadding = options.paddingZeros !== undefined
      ? Math.max(MIN_PADDING_ZEROS, Math.min(MAX_PADDING_ZEROS, Math.floor(options.paddingZeros)))
      : DEFAULT_PADDING_ZEROS;

    // 5. Fiscal Year Resolution
    let fiscalYear: string;
    if (options.fiscalYear !== undefined && options.fiscalYear !== null) {
      fiscalYear = DocumentSequenceService.resolveFiscalYear(undefined, options.fiscalYear);
    } else {
      // Lookup company fiscalYearStartMonth if not explicitly provided
      const client = options.tx || prisma;
      let startMonth = 1;
      try {
        const company = await client.company.findUnique({
          where: { id: companyId },
          select: { fiscalYearStartMonth: true },
        });
        if (company?.fiscalYearStartMonth) {
          startMonth = company.fiscalYearStartMonth;
        }
      } catch {
        // Fallback to month 1 (calendar year) if lookup unavailable
        startMonth = 1;
      }
      fiscalYear = DocumentSequenceService.resolveFiscalYear(options.date, undefined, startMonth);
    }

    // 6. Execute Atomic PostgreSQL Allocation
    if (options.tx) {
      return DocumentSequenceService.executeAtomicUpsert(
        options.tx,
        companyId,
        documentType,
        prefix,
        fiscalYear,
        requestedPadding,
        options.maxRetries ?? DEFAULT_MAX_RETRIES
      );
    }

    return prisma.$transaction(async (tx) => {
      return DocumentSequenceService.executeAtomicUpsert(
        tx,
        companyId,
        documentType,
        prefix,
        fiscalYear,
        requestedPadding,
        options.maxRetries ?? DEFAULT_MAX_RETRIES
      );
    });
  }

  /**
   * Internal worker executing atomic SQL upsert with row-level lock and retry handling.
   */
  private static async executeAtomicUpsert(
    tx: Prisma.TransactionClient,
    companyId: string,
    documentType: DocumentNumberType,
    prefix: string,
    fiscalYear: string,
    paddingZeros: number,
    maxRetries: number
  ): Promise<AllocatedDocumentNumber> {
    let attempt = 0;

    while (attempt < maxRetries) {
      attempt++;

      try {
        // Atomic PostgreSQL INSERT ... ON CONFLICT DO UPDATE RETURNING
        // Guarantees:
        // - Row exists: takes exclusive row lock, increments lastNumber by 1
        // - Row does not exist: inserts row with lastNumber = 1
        // - Concurrent race on initial insert: conflict handler detects existing row and updates
        const result = await tx.$queryRaw<
          Array<{
            id: string;
            companyId: string;
            documentType: string;
            prefix: string;
            fiscalYear: string;
            lastNumber: number | bigint;
            paddingZeros: number | null;
          }>
        >`
          INSERT INTO "DocumentNumberSequence" (
            "id",
            "companyId",
            "documentType",
            "prefix",
            "fiscalYear",
            "lastNumber",
            "paddingZeros",
            "createdAt",
            "updatedAt"
          )
          VALUES (
            gen_random_uuid(),
            ${companyId}::uuid,
            ${documentType}::"DocumentNumberType",
            ${prefix},
            ${fiscalYear},
            1,
            ${paddingZeros},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT ("companyId", "documentType", "prefix", "fiscalYear")
          DO UPDATE SET
            "lastNumber" = "DocumentNumberSequence"."lastNumber" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
          RETURNING
            "id",
            "companyId",
            "documentType",
            "prefix",
            "fiscalYear",
            "lastNumber",
            "paddingZeros";
        `;

        if (!result || result.length === 0) {
          throw new Error('[SEQUENCE_ALLOCATION_FAILED] Database returned 0 rows on atomic sequence upsert.');
        }

        const row = result[0];
        const assignedNumber = Number(row.lastNumber);
        const resolvedPadding = row.paddingZeros !== null && row.paddingZeros !== undefined
          ? Number(row.paddingZeros)
          : paddingZeros;

        const formatted = DocumentSequenceService.formatDocumentNumber(
          prefix,
          fiscalYear,
          assignedNumber,
          resolvedPadding
        );

        return {
          formattedNumber: formatted,
          sequenceNumber: assignedNumber,
          prefix,
          fiscalYear,
          documentType,
          companyId,
          paddingZeros: resolvedPadding,
        };
      } catch (err: any) {
        // Detect PostgreSQL concurrency conflict codes:
        // 40001 = serialization_failure
        // 40P01 = deadlock_detected
        // 23505 = unique_violation (in case of subtransaction race)
        const isConflict =
          err?.code === '40001' ||
          err?.code === '40P01' ||
          err?.code === '23505' ||
          err?.message?.includes('could not serialize') ||
          err?.message?.includes('deadlock') ||
          err?.message?.includes('conflict');

        if (isConflict && attempt < maxRetries) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 20;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (attempt >= maxRetries) {
          throw new Error(
            `[SEQUENCE_ALLOCATION_EXHAUSTED] Maximum retries (${maxRetries}) exhausted for ${documentType} (${prefix}-${fiscalYear}) in company ${companyId}: ${err?.message || err}`
          );
        }

        throw err;
      }
    }

    throw new Error(
      `[SEQUENCE_ALLOCATION_EXHAUSTED] Unable to allocate sequence number after ${maxRetries} attempts.`
    );
  }

  /**
   * Read-only inspection of current sequence counter for a company and document type.
   * Does NOT increment or mutate sequence counters.
   */
  public static async getSequenceStatus(
    companyId: string,
    documentType: DocumentNumberType,
    prefix?: string,
    fiscalYear?: string,
    tx?: Prisma.TransactionClient
  ) {
    if (!DocumentSequenceService.isValidUuid(companyId)) {
      throw new Error(`[INVALID_TENANT_ID] Valid companyId (UUID) is required.`);
    }

    const client = tx || prisma;
    const targetPrefix = prefix ? DocumentSequenceService.sanitizePrefix(prefix) : DEFAULT_DOCUMENT_PREFIXES[documentType];
    const targetFy = fiscalYear ? String(fiscalYear).trim() : DocumentSequenceService.resolveFiscalYear();

    return client.documentNumberSequence.findUnique({
      where: {
        companyId_documentType_prefix_fiscalYear: {
          companyId,
          documentType,
          prefix: targetPrefix,
          fiscalYear: targetFy,
        },
      },
    });
  }

  /**
   * Lists all active sequence counters for a tenant company (Administrative inspection).
   */
  public static async listCompanySequences(companyId: string, tx?: Prisma.TransactionClient) {
    if (!DocumentSequenceService.isValidUuid(companyId)) {
      throw new Error(`[INVALID_TENANT_ID] Valid companyId (UUID) is required.`);
    }

    const client = tx || prisma;
    return client.documentNumberSequence.findMany({
      where: { companyId },
      orderBy: [{ documentType: 'asc' }, { fiscalYear: 'desc' }, { prefix: 'asc' }],
    });
  }
}
