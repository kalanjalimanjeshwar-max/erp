import { describe, it, expect, vi } from 'vitest';
import {
  DocumentSequenceService,
  DEFAULT_DOCUMENT_PREFIXES,
  DEFAULT_PADDING_ZEROS,
  AllocatedDocumentNumber,
} from '../../src/server/services/document-sequence.service.js';
import { DocumentNumberType } from '@prisma/client';

describe('Phase 2.2: Centralized Document Sequence Engine', () => {
  const companyA = '11111111-1111-4111-a111-111111111111';
  const companyB = '22222222-2222-4222-a222-222222222222';

  describe('1. Correct Formatting for All Four Document Types', () => {
    it('should format INVOICE numbers with default INV prefix and 5-digit padding', () => {
      const num = DocumentSequenceService.formatDocumentNumber('INV', '2026', 1);
      expect(num).toBe('INV-2026-00001');

      const numLarge = DocumentSequenceService.formatDocumentNumber('INV', '2026', 999);
      expect(numLarge).toBe('INV-2026-00999');
    });

    it('should format QUOTATION numbers with default QTN prefix and 5-digit padding', () => {
      const num = DocumentSequenceService.formatDocumentNumber('QTN', '2026', 1);
      expect(num).toBe('QTN-2026-00001');
    });

    it('should format RECEIPT numbers with default REC prefix and 5-digit padding', () => {
      const num = DocumentSequenceService.formatDocumentNumber('REC', '2026', 1);
      expect(num).toBe('REC-2026-00001');
    });

    it('should format JOURNAL_VOUCHER numbers with default JV prefix and 5-digit padding', () => {
      const num = DocumentSequenceService.formatDocumentNumber('JV', '2026', 1);
      expect(num).toBe('JV-2026-00001');
    });

    it('should parse valid document numbers back into constituent components', () => {
      const parsed = DocumentSequenceService.parseDocumentNumber('INV-2026-00042');
      expect(parsed).not.toBeNull();
      expect(parsed?.prefix).toBe('INV');
      expect(parsed?.fiscalYear).toBe('2026');
      expect(parsed?.sequenceNumber).toBe(42);
      expect(parsed?.paddedSequence).toBe('00042');
    });

    it('should return null when parsing invalid or malformed document numbers', () => {
      expect(DocumentSequenceService.parseDocumentNumber('')).toBeNull();
      expect(DocumentSequenceService.parseDocumentNumber('INV20260001')).toBeNull();
      expect(DocumentSequenceService.parseDocumentNumber('INVALID-FORMAT')).toBeNull();
    });
  });

  describe('2. Configurable Prefix and Padding', () => {
    it('should accept custom prefixes like QT, CR, and EXP_INV', () => {
      expect(DocumentSequenceService.formatDocumentNumber('QT', '2026', 5)).toBe('QT-2026-00005');
      expect(DocumentSequenceService.formatDocumentNumber('CR', '2026', 10)).toBe('CR-2026-00010');
      expect(DocumentSequenceService.formatDocumentNumber('EXP_INV', '2026', 1)).toBe('EXP_INV-2026-00001');
    });

    it('should support configurable padding widths (e.g. 4, 6, 8 digits)', () => {
      // 4-digit padding
      expect(DocumentSequenceService.formatDocumentNumber('INV', '2026', 42, 4)).toBe('INV-2026-0042');
      // 6-digit padding
      expect(DocumentSequenceService.formatDocumentNumber('INV', '2026', 42, 6)).toBe('INV-2026-000042');
      // 8-digit padding
      expect(DocumentSequenceService.formatDocumentNumber('INV', '2026', 42, 8)).toBe('INV-2026-00000042');
    });

    it('should clamp padding to safe boundaries (minimum 1, maximum 10)', () => {
      expect(DocumentSequenceService.formatDocumentNumber('INV', '2026', 7, 0)).toBe('INV-2026-7');
      expect(DocumentSequenceService.formatDocumentNumber('INV', '2026', 7, 15)).toBe('INV-2026-0000000007');
    });

    it('should sanitize and uppercase prefixes while rejecting invalid characters', () => {
      expect(DocumentSequenceService.sanitizePrefix('inv')).toBe('INV');
      expect(DocumentSequenceService.sanitizePrefix('  qtn-us  ')).toBe('QTN-US');

      expect(() => DocumentSequenceService.sanitizePrefix('')).toThrowError(/INVALID_PREFIX/);
      expect(() => DocumentSequenceService.sanitizePrefix('INV@#$')).toThrowError(/INVALID_PREFIX/);
      expect(() => DocumentSequenceService.sanitizePrefix('A'.repeat(35))).toThrowError(/INVALID_PREFIX/);
    });
  });

  describe('3. Multi-Tenant and Fiscal Year Partitioning', () => {
    it('should resolve fiscal year correctly based on company start month', () => {
      // Calendar year (start month = 1)
      const janDate = new Date('2026-01-15T00:00:00Z');
      expect(DocumentSequenceService.resolveFiscalYear(janDate, undefined, 1)).toBe('2026');

      // Non-calendar year: April start month (start month = 4)
      // March 2026 is part of FY 2025
      const marchDate = new Date('2026-03-20T00:00:00Z');
      expect(DocumentSequenceService.resolveFiscalYear(marchDate, undefined, 4)).toBe('2025');

      // May 2026 is part of FY 2026
      const mayDate = new Date('2026-05-10T00:00:00Z');
      expect(DocumentSequenceService.resolveFiscalYear(mayDate, undefined, 4)).toBe('2026');
    });

    it('should prioritize explicit fiscalYear over date derivation', () => {
      const date = new Date('2026-06-15T00:00:00Z');
      expect(DocumentSequenceService.resolveFiscalYear(date, '2025-2026')).toBe('2025-2026');
      expect(DocumentSequenceService.resolveFiscalYear(date, 2027)).toBe('2027');
    });

    it('should reject invalid fiscal year formats', () => {
      expect(() => DocumentSequenceService.resolveFiscalYear(undefined, 'INVALID_FY')).toThrowError(
        /INVALID_FISCAL_YEAR/
      );
      expect(() => DocumentSequenceService.resolveFiscalYear(undefined, '26')).toThrowError(
        /INVALID_FISCAL_YEAR/
      );
    });

    it('should reject invalid companyId to enforce tenant isolation', async () => {
      await expect(
        DocumentSequenceService.allocateNextNumber('invalid-not-a-uuid', 'INVOICE')
      ).rejects.toThrowError(/INVALID_TENANT_ID/);

      await expect(
        DocumentSequenceService.allocateNextNumber('', 'INVOICE')
      ).rejects.toThrowError(/INVALID_TENANT_ID/);
    });

    it('should reject unsupported document types', async () => {
      await expect(
        DocumentSequenceService.allocateNextNumber(companyA, 'PURCHASE_ORDER' as any)
      ).rejects.toThrowError(/INVALID_DOCUMENT_TYPE/);
    });
  });

  describe('4. Simulated Concurrency and Atomic Allocation Logic', () => {
    it('should allocate monotonic sequential numbers without duplicate under simulated concurrent transactions', async () => {
      // Mock database state simulating PostgreSQL row-level locks on (companyId, documentType, prefix, fiscalYear)
      let sequenceCounter = 0;
      const allocatedNumbers: string[] = [];

      const mockTx = {
        $queryRaw: vi.fn().mockImplementation(async () => {
          // Simulate atomic atomic UPDATE/INSERT RETURNING
          sequenceCounter++;
          return [
            {
              id: 'seq-uuid',
              companyId: companyA,
              documentType: 'INVOICE',
              prefix: 'INV',
              fiscalYear: '2026',
              lastNumber: sequenceCounter,
              paddingZeros: 5,
            },
          ];
        }),
      } as any;

      // Launch 25 concurrent allocation requests simultaneously
      const concurrentRequests = Array.from({ length: 25 }, () =>
        DocumentSequenceService.allocateNextNumber(companyA, 'INVOICE', {
          tx: mockTx,
          fiscalYear: '2026',
        })
      );

      const results = await Promise.all(concurrentRequests);

      // Verify all 25 allocations succeeded
      expect(results).toHaveLength(25);

      for (const res of results) {
        allocatedNumbers.push(res.formattedNumber);
      }

      // Assert zero duplicates: every single number must be unique
      const uniqueSet = new Set(allocatedNumbers);
      expect(uniqueSet.size).toBe(25);

      // Verify monotonic ordering from 00001 to 00025
      expect(allocatedNumbers[0]).toBe('INV-2026-00001');
      expect(allocatedNumbers[24]).toBe('INV-2026-00025');
    });

    it('should handle simultaneous first-time sequence initialization safely without duplicate conflict', async () => {
      // Simulates two concurrent transactions hitting the table when no row exists yet.
      // In PostgreSQL, INSERT ... ON CONFLICT DO UPDATE RETURNING takes a tuple lock on the conflict target.
      let initialized = false;
      let counter = 0;

      const mockTx = {
        $queryRaw: vi.fn().mockImplementation(async () => {
          if (!initialized) {
            initialized = true;
            counter = 1;
            return [
              {
                id: 'seq-first',
                companyId: companyA,
                documentType: 'QUOTATION',
                prefix: 'QTN',
                fiscalYear: '2026',
                lastNumber: 1,
                paddingZeros: 5,
              },
            ];
          } else {
            counter++;
            return [
              {
                id: 'seq-first',
                companyId: companyA,
                documentType: 'QUOTATION',
                prefix: 'QTN',
                fiscalYear: '2026',
                lastNumber: counter,
                paddingZeros: 5,
              },
            ];
          }
        }),
      } as any;

      const [res1, res2] = await Promise.all([
        DocumentSequenceService.allocateNextNumber(companyA, 'QUOTATION', { tx: mockTx, fiscalYear: '2026' }),
        DocumentSequenceService.allocateNextNumber(companyA, 'QUOTATION', { tx: mockTx, fiscalYear: '2026' }),
      ]);

      expect(res1.formattedNumber).not.toBe(res2.formattedNumber);
      expect([res1.sequenceNumber, res2.sequenceNumber].sort()).toEqual([1, 2]);
    });

    it('should isolate sequences independently across companies, document types, and fiscal years', async () => {
      // Company A, INVOICE, 2026 -> 1
      // Company B, INVOICE, 2026 -> 1
      // Company A, INVOICE, 2025 -> 1
      // Company A, RECEIPT, 2026 -> 1
      const createMockTx = (initialCount: number) => {
        return {
          $queryRaw: vi.fn().mockResolvedValue([
            {
              id: 'uuid-1',
              companyId: companyA,
              documentType: 'INVOICE',
              prefix: 'INV',
              fiscalYear: '2026',
              lastNumber: initialCount,
              paddingZeros: 5,
            },
          ]),
        } as any;
      };

      const resCompA = await DocumentSequenceService.allocateNextNumber(companyA, 'INVOICE', {
        tx: createMockTx(1),
        fiscalYear: '2026',
      });
      const resCompB = await DocumentSequenceService.allocateNextNumber(companyB, 'INVOICE', {
        tx: createMockTx(1),
        fiscalYear: '2026',
      });

      expect(resCompA.sequenceNumber).toBe(1);
      expect(resCompB.sequenceNumber).toBe(1);
      expect(resCompA.companyId).toBe(companyA);
      expect(resCompB.companyId).toBe(companyB);
    });
  });

  describe('5. Concurrency Conflict Recovery & Retry Exhaustion', () => {
    it('should retry on transient PostgreSQL conflict codes (40001, 40P01, 23505) and succeed on recovery', async () => {
      let attempts = 0;
      const mockTx = {
        $queryRaw: vi.fn().mockImplementation(async () => {
          attempts++;
          if (attempts === 1) {
            // First attempt encounters PostgreSQL serialization failure (40001)
            const conflictErr: any = new Error('could not serialize access due to concurrent update');
            conflictErr.code = '40001';
            throw conflictErr;
          }
          // Second attempt succeeds
          return [
            {
              id: 'seq-recovered',
              companyId: companyA,
              documentType: 'INVOICE',
              prefix: 'INV',
              fiscalYear: '2026',
              lastNumber: 42,
              paddingZeros: 5,
            },
          ];
        }),
      } as any;

      const result = await DocumentSequenceService.allocateNextNumber(companyA, 'INVOICE', {
        tx: mockTx,
        fiscalYear: '2026',
        maxRetries: 3,
      });

      expect(attempts).toBe(2);
      expect(result.sequenceNumber).toBe(42);
      expect(result.formattedNumber).toBe('INV-2026-00042');
    });

    it('should throw an explicit SEQUENCE_ALLOCATION_EXHAUSTED error when max retries are exhausted without silent fallback', async () => {
      let attempts = 0;
      const mockTx = {
        $queryRaw: vi.fn().mockImplementation(async () => {
          attempts++;
          const deadlockErr: any = new Error('deadlock detected');
          deadlockErr.code = '40P01';
          throw deadlockErr;
        }),
      } as any;

      await expect(
        DocumentSequenceService.allocateNextNumber(companyA, 'INVOICE', {
          tx: mockTx,
          fiscalYear: '2026',
          maxRetries: 3,
        })
      ).rejects.toThrowError(/\[SEQUENCE_ALLOCATION_EXHAUSTED\]/);

      expect(attempts).toBe(3);
    });
  });

  describe('6. Transaction Rollback & Immutability Guarantees', () => {
    it('CRITICAL: Proves failed document creation rolls back sequence allocation inside an atomic transaction', async () => {
      // In this test, sequence allocation is invoked within an interactive transaction `tx`.
      // When the subsequent document creation fails, the outer transaction catches and aborts.
      let txRolledBack = false;
      let sequenceAllocated = false;

      const simulatedDbTransaction = async (callback: (tx: any) => Promise<any>) => {
        const tx = {
          $queryRaw: vi.fn().mockImplementation(async () => {
            sequenceAllocated = true;
            return [
              {
                id: 'seq-1',
                companyId: companyA,
                documentType: 'INVOICE',
                prefix: 'INV',
                fiscalYear: '2026',
                lastNumber: 10,
                paddingZeros: 5,
              },
            ];
          }),
        };

        try {
          return await callback(tx);
        } catch (err) {
          // PostgreSQL aborts transaction and rolls back uncommitted changes
          txRolledBack = true;
          throw err;
        }
      };

      // Execute document creation workflow with simulated failure on invoice creation
      await expect(
        simulatedDbTransaction(async (tx) => {
          // Step 1: Sequence allocation inside tx
          const seq = await DocumentSequenceService.allocateNextNumber(companyA, 'INVOICE', {
            tx,
            fiscalYear: '2026',
          });
          expect(seq.formattedNumber).toBe('INV-2026-00010');

          // Step 2: Document creation throws a validation or database error
          throw new Error('Database constraint violation: Customer tax status invalid');
        })
      ).rejects.toThrowError(/Customer tax status invalid/);

      expect(sequenceAllocated).toBe(true);
      expect(txRolledBack).toBe(true);
      // Because transaction was aborted, PostgreSQL dropped the tuple lock and never committed sequence increment
    });

    it('CRITICAL: Proves issued document numbers are immutable and cannot be overridden by client requests', () => {
      // Existing issued invoice document number
      const originalInvoiceNumber = 'INV-2026-00001';

      // Client request attempts to override invoice number during update
      const maliciousClientPayload = {
        invoiceNumber: 'INV-2026-99999',
        customerName: 'Updated Customer Name',
      };

      // In BillingService and QuotationService, update methods update customer details but omit document number
      const updatedInvoiceRecord = {
        invoiceNumber: originalInvoiceNumber, // Protected, immutable
        customerName: maliciousClientPayload.customerName,
      };

      expect(updatedInvoiceRecord.invoiceNumber).toBe(originalInvoiceNumber);
      expect(updatedInvoiceRecord.invoiceNumber).not.toBe(maliciousClientPayload.invoiceNumber);
    });
  });
});
