import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Request, Response } from 'express';
import { prisma } from '../../src/server/db/client.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { BiometricController } from '../../src/server/controllers/biometric.controller.js';
import { BiometricMappingService } from '../../src/server/services/biometric-mapping.service.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { WorkPolicyService } from '../../src/server/services/work-policy.service.js';
import {
  BiometricDevicesPage,
  BiometricHistoricalCutoffNotice,
  BiometricHistoricalConfirmationBanner,
  buildBiometricSyncPayload,
  parseLocalHistoricalCutoffInput,
} from '../../src/client/pages/BiometricDevicesPage.tsx';
import type { AuthUser, CompanyProfile } from '../../src/shared/types.js';

function createMockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    user: {
      id: 'user-admin-1',
      userId: 'user-admin-1',
      companyId: 'comp-alpha',
      role: 'ADMIN',
      fullName: 'Admin User',
      email: 'admin@alpha.test',
      isActive: true,
      tokenVersion: 1,
    } as AuthUser,
    params: {},
    query: {},
    body: {},
    correlationId: 'corr-scope5-test',
    ...overrides,
  } as unknown as Request;
}

describe('Step 3 Scope 5 — Biometric Sync Controller Validation & Tenant Isolation', () => {
  const mockSyncOutcome = {
    totalEvaluated: 0,
    processed: 0,
    pending: 0,
    ignored: 0,
    errors: 0,
    results: [],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/biometric/sync (BiometricController.triggerSync)', () => {
    it('passes fromPunchTime: undefined when omitted so Step 2 preserves today-only company-local cutoff', async () => {
      const reconcileSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
        .mockResolvedValue(mockSyncOutcome as any);

      const req = createMockRequest({ body: { batchSize: 50, retryErrors: false } });
      const res = createMockResponse();

      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      const [companyId, options] = reconcileSpy.mock.calls[0];
      expect(companyId).toBe('comp-alpha');
      expect(options?.fromPunchTime).toBeUndefined();
      expect(options?.batchSize).toBe(50);
      expect(options?.retryErrors).toBe(false);
    });

    it('normalizes YYYY-MM-DD fromPunchTime using company timezone (Asia/Kolkata +05:30)', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Asia/Kolkata' } as any);
      const reconcileSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
        .mockResolvedValue(mockSyncOutcome as any);

      const req = createMockRequest({ body: { fromPunchTime: '2026-05-10' } });
      const res = createMockResponse();

      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      const passedCutoff = reconcileSpy.mock.calls[0][1]?.fromPunchTime;
      expect(passedCutoff).toBeInstanceOf(Date);
      // 2026-05-10 00:00:00 Asia/Kolkata (+05:30) === 2026-05-09T18:30:00.000Z
      expect((passedCutoff as Date).toISOString()).toBe('2026-05-09T18:30:00.000Z');
    });

    it('normalizes YYYY-MM-DD fromPunchTime using negative-offset company timezone (America/New_York EDT -04:00)', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'America/New_York' } as any);
      const reconcileSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
        .mockResolvedValue(mockSyncOutcome as any);

      const req = createMockRequest({ body: { fromPunchTime: '2026-05-10' } });
      const res = createMockResponse();

      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      const passedCutoff = reconcileSpy.mock.calls[0][1]?.fromPunchTime as Date;
      // 2026-05-10 00:00:00 America/New_York (-04:00) === 2026-05-10T04:00:00.000Z
      expect(passedCutoff.toISOString()).toBe('2026-05-10T04:00:00.000Z');
    });

    it('preserves exact explicitly supplied instant for valid ISO-8601 datetime strings (Z and offset)', async () => {
      const resolveTzSpy = vi.spyOn(WorkPolicyService, 'resolveCompanyTimezone');
      const reconcileSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
        .mockResolvedValue(mockSyncOutcome as any);

      // Z suffix
      const reqUtc = createMockRequest({
        body: { fromPunchTime: '2026-05-10T03:45:12.500Z' },
      });
      const resUtc = createMockResponse();
      await BiometricController.triggerSync(reqUtc, resUtc as unknown as Response);

      expect(resUtc.statusCode).toBe(200);
      expect((reconcileSpy.mock.calls[0][1]?.fromPunchTime as Date).toISOString()).toBe(
        '2026-05-10T03:45:12.500Z'
      );

      // Offset suffix (+05:30)
      const reqOffset = createMockRequest({
        body: { fromPunchTime: '2026-05-10T09:15:00+05:30' },
      });
      const resOffset = createMockResponse();
      await BiometricController.triggerSync(reqOffset, resOffset as unknown as Response);

      expect(resOffset.statusCode).toBe(200);
      expect((reconcileSpy.mock.calls[1][1]?.fromPunchTime as Date).toISOString()).toBe(
        '2026-05-10T03:45:00.000Z'
      );
      expect(resolveTzSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['impossible calendar date Feb 30', '2026-02-30'],
      ['non-leap Feb 29', '2025-02-29'],
      ['invalid month 13', '2026-13-01'],
      ['invalid day Apr 31', '2026-04-31'],
      ['impossible ISO calendar date Feb 30', '2026-02-30T10:00:00Z'],
      ['invalid hour 25', '2026-05-10T25:00:00Z'],
      ['invalid offset hour 25', '2026-05-10T10:00:00+25:00'],
      ['timezone-less datetime', '2026-05-10T09:00:00'],
      ['slash-formatted date', '2026/05/10'],
      ['garbage string', 'not-a-date'],
      ['blank string', '   '],
      ['numeric timestamp', 1746835200000],
      ['boolean', true],
      ['null', null],
      ['object', { date: '2026-05-10' }],
      ['array', ['2026-05-10']],
    ])('rejects invalid fromPunchTime (%s) with HTTP 400 VALIDATION_ERROR', async (_label, badValue) => {
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');
      const req = createMockRequest({ body: { fromPunchTime: badValue } });
      const res = createMockResponse();

      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(res.statusCode).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(reconcileSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['zero', 0],
      ['negative integer', -5],
      ['float', 10.5],
      ['string number', '100'],
      ['null', null],
      ['boolean', true],
      ['NaN', Number.NaN],
    ])('rejects invalid batchSize (%s) with HTTP 400 VALIDATION_ERROR', async (_label, badBatchSize) => {
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');
      const req = createMockRequest({ body: { batchSize: badBatchSize } });
      const res = createMockResponse();

      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(res.statusCode).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(reconcileSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['retryErrors string', { retryErrors: 'true' }],
      ['retryErrors number', { retryErrors: 1 }],
      ['retryErrors null', { retryErrors: null }],
      ['keepUnmappedPending string', { keepUnmappedPending: 'false' }],
      ['keepUnmappedPending number', { keepUnmappedPending: 0 }],
      ['keepUnmappedPending null', { keepUnmappedPending: null }],
    ])('rejects non-boolean flag (%s) with HTTP 400 VALIDATION_ERROR', async (_label, body) => {
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');
      const req = createMockRequest({ body });
      const res = createMockResponse();

      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(res.statusCode).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(reconcileSpy).not.toHaveBeenCalled();
    });

    it('preserves BIOMETRIC_INVALID_RECONCILIATION_FILTER for invalid targeted filter values', async () => {
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');
      const req = createMockRequest({ body: { userEnrollmentId: '   ' } });
      const res = createMockResponse();

      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(res.statusCode).toBe(400);
      expect(res.body?.error?.code).toBe('BIOMETRIC_INVALID_RECONCILIATION_FILTER');
      expect(reconcileSpy).not.toHaveBeenCalled();
    });

    it('rejects cross-company terminalId with HTTP 404 TERMINAL_NOT_FOUND without calling reconciliation', async () => {
      const findFirstSpy = vi
        .spyOn(prisma.biometricTerminal, 'findFirst')
        .mockResolvedValue(null as any);
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');

      const req = createMockRequest({
        body: { terminalId: 'term-from-other-company', batchSize: 25 },
      });
      const res = createMockResponse();

      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(findFirstSpy).toHaveBeenCalledWith({
        where: { id: 'term-from-other-company', companyId: 'comp-alpha' },
        select: { id: true },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body?.error?.code).toBe('TERMINAL_NOT_FOUND');
      expect(reconcileSpy).not.toHaveBeenCalled();
    });

    it('allows owned terminalId alongside targeted filters and explicit fromPunchTime', async () => {
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue({
        id: 'term-alpha-1',
      } as any);
      const reconcileSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
        .mockResolvedValue(mockSyncOutcome as any);

      const req = createMockRequest({
        body: {
          terminalId: 'term-alpha-1',
          employeeId: 'emp-1',
          userEnrollmentId: '101',
          batchSize: 100,
          retryErrors: true,
          keepUnmappedPending: true,
          fromPunchTime: '2026-05-01T00:00:00Z',
        },
      });
      const res = createMockResponse();

      await BiometricController.triggerSync(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(reconcileSpy).toHaveBeenCalledWith(
        'comp-alpha',
        {
          batchSize: 100,
          terminalId: 'term-alpha-1',
          userEnrollmentId: '101',
          employeeId: 'emp-1',
          punchId: undefined,
          retryErrors: true,
          keepUnmappedPending: true,
          fromPunchTime: new Date('2026-05-01T00:00:00.000Z'),
          toPunchTime: undefined,
          allowHistorical: undefined,
        },
        expect.objectContaining({ userId: 'user-admin-1', role: 'ADMIN' }),
        'corr-scope5-test'
      );
    });
  });

  describe('POST /api/biometric/devices/:id/sync (BiometricController.syncTerminal)', () => {
    it('passes fromPunchTime: undefined when omitted so normal terminal sync keeps Step 2 today-only cutoff', async () => {
      const terminalSyncSpy = vi
        .spyOn(BiometricService, 'triggerTerminalSync')
        .mockResolvedValue({ success: true, message: 'Queued' } as any);

      const req = createMockRequest({
        params: { id: 'term-alpha-1' },
        body: { batchSize: 100 },
      });
      const res = createMockResponse();

      await BiometricController.syncTerminal(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(terminalSyncSpy).toHaveBeenCalledTimes(1);
      const [, terminalId, options] = terminalSyncSpy.mock.calls[0];
      expect(terminalId).toBe('term-alpha-1');
      expect(options?.fromPunchTime).toBeUndefined();
      expect(options?.batchSize).toBe(100);
    });

    it('normalizes YYYY-MM-DD fromPunchTime in company timezone and preserves ISO-8601 datetime', async () => {
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'Asia/Kolkata' } as any);
      const terminalSyncSpy = vi
        .spyOn(BiometricService, 'triggerTerminalSync')
        .mockResolvedValue({ success: true, message: 'Queued' } as any);

      const reqDate = createMockRequest({
        params: { id: 'term-alpha-1' },
        body: { fromPunchTime: '2026-05-12', retryErrors: true, keepUnmappedPending: false },
      });
      const resDate = createMockResponse();
      await BiometricController.syncTerminal(reqDate, resDate as unknown as Response);

      expect(resDate.statusCode).toBe(200);
      expect((terminalSyncSpy.mock.calls[0][2]?.fromPunchTime as Date).toISOString()).toBe(
        '2026-05-11T18:30:00.000Z'
      );
      expect(terminalSyncSpy.mock.calls[0][2]?.retryErrors).toBe(true);
      expect(terminalSyncSpy.mock.calls[0][2]?.keepUnmappedPending).toBe(false);

      const reqIso = createMockRequest({
        params: { id: 'term-alpha-1' },
        body: { fromPunchTime: '2026-05-12T06:00:00Z' },
      });
      const resIso = createMockResponse();
      await BiometricController.syncTerminal(reqIso, resIso as unknown as Response);

      expect(resIso.statusCode).toBe(200);
      expect((terminalSyncSpy.mock.calls[1][2]?.fromPunchTime as Date).toISOString()).toBe(
        '2026-05-12T06:00:00.000Z'
      );
    });

    it('rejects invalid fromPunchTime, batchSize, and boolean flags with HTTP 400 VALIDATION_ERROR', async () => {
      const terminalSyncSpy = vi.spyOn(BiometricService, 'triggerTerminalSync');

      for (const badBody of [
        { fromPunchTime: '2026-02-30' },
        { fromPunchTime: 9999 },
        { batchSize: 0 },
        { batchSize: '100' },
        { retryErrors: 'yes' },
        { keepUnmappedPending: 1 },
      ]) {
        const req = createMockRequest({
          params: { id: 'term-alpha-1' },
          body: badBody,
        });
        const res = createMockResponse();

        await BiometricController.syncTerminal(req, res as unknown as Response);

        expect(res.statusCode).toBe(400);
        expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      }

      expect(terminalSyncSpy).not.toHaveBeenCalled();
    });

    it('rejects cross-company terminal :id with HTTP 404 TERMINAL_NOT_FOUND', async () => {
      const findFirstSpy = vi
        .spyOn(prisma.biometricTerminal, 'findFirst')
        .mockResolvedValue(null as any);
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');

      const req = createMockRequest({
        params: { id: 'term-other-tenant' },
        body: { batchSize: 50 },
      });
      const res = createMockResponse();

      await BiometricController.syncTerminal(req, res as unknown as Response);

      expect(findFirstSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'term-other-tenant', companyId: 'comp-alpha' },
        })
      );
      expect(res.statusCode).toBe(404);
      expect(res.body?.error?.code).toBe('TERMINAL_NOT_FOUND');
      expect(reconcileSpy).not.toHaveBeenCalled();
    });

    describe('P2-1: keepUnmappedPending forwarding through BiometricService.triggerTerminalSync', () => {
      const makeActiveTerminal = () => ({
        id: 'term-alpha-1',
        companyId: 'comp-alpha',
        deviceSerialNumber: 'SN-ALPHA-1',
        name: 'Front Gate',
        terminalModel: 'eSSL-X2008',
        ipAddress: '192.168.1.201',
        port: 4370,
        location: 'Lobby',
        apiKeyPrefix: 'bio_live_123',
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
        lastSyncAt: null,
        firmwareVersion: '1.0',
        registeredByUserId: 'user-admin-1',
        registeredByUser: { fullName: 'Admin User' },
        isActive: true,
        notes: null,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        updatedAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      const setupTerminalMocks = () => {
        vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(makeActiveTerminal() as any);
        vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
        vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
        vi.spyOn(prisma.companySetting, 'upsert').mockResolvedValue({} as any);
        vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);
      };

      it('forwards keepUnmappedPending: true unchanged from syncTerminal through triggerTerminalSync to reconcilePendingPunches', async () => {
        setupTerminalMocks();
        const reconcileSpy = vi
          .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
          .mockResolvedValue(mockSyncOutcome as any);

        const req = createMockRequest({
          params: { id: 'term-alpha-1' },
          body: { batchSize: 50, retryErrors: false, keepUnmappedPending: true },
        });
        const res = createMockResponse();

        await BiometricController.syncTerminal(req, res as unknown as Response);

        expect(res.statusCode).toBe(200);
        expect(reconcileSpy).toHaveBeenCalledTimes(1);
        const [companyId, options, forwardedActor, correlationId] = reconcileSpy.mock.calls[0];
        expect(companyId).toBe('comp-alpha');
        expect(options?.terminalId).toBe('term-alpha-1');
        expect(options?.batchSize).toBe(50);
        expect(options?.retryErrors).toBe(false);
        expect(options?.keepUnmappedPending).toBe(true);
        expect(options?.fromPunchTime).toBeInstanceOf(Date);
        expect(forwardedActor).toEqual(expect.objectContaining({ userId: 'user-admin-1', role: 'ADMIN' }));
        expect(correlationId).toBe('corr-scope5-test');
      });

      it('forwards keepUnmappedPending: false unchanged from syncTerminal through triggerTerminalSync to reconcilePendingPunches', async () => {
        setupTerminalMocks();
        const reconcileSpy = vi
          .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
          .mockResolvedValue(mockSyncOutcome as any);

        const req = createMockRequest({
          params: { id: 'term-alpha-1' },
          body: { batchSize: 25, retryErrors: true, keepUnmappedPending: false },
        });
        const res = createMockResponse();

        await BiometricController.syncTerminal(req, res as unknown as Response);

        expect(res.statusCode).toBe(200);
        expect(reconcileSpy).toHaveBeenCalledTimes(1);
        const [, options] = reconcileSpy.mock.calls[0];
        expect(options?.terminalId).toBe('term-alpha-1');
        expect(options?.batchSize).toBe(25);
        expect(options?.retryErrors).toBe(true);
        expect(options?.keepUnmappedPending).toBe(false);
      });

      it('forwards keepUnmappedPending: undefined when omitted to preserve existing default behavior', async () => {
        setupTerminalMocks();
        const reconcileSpy = vi
          .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
          .mockResolvedValue(mockSyncOutcome as any);

        const req = createMockRequest({
          params: { id: 'term-alpha-1' },
          body: { batchSize: 100 },
        });
        const res = createMockResponse();

        await BiometricController.syncTerminal(req, res as unknown as Response);

        expect(res.statusCode).toBe(200);
        expect(reconcileSpy).toHaveBeenCalledTimes(1);
        const [, options] = reconcileSpy.mock.calls[0];
        expect(options?.terminalId).toBe('term-alpha-1');
        expect(options?.keepUnmappedPending).toBeUndefined();
      });

      it.each([
        {
          label: 'keepUnmappedPending: true keeps unmapped punches PENDING',
          body: { keepUnmappedPending: true },
          expectedStatus: 'PENDING',
          expectedPendingCount: 1,
          expectedErrorCount: 0,
          expectedMessagePattern: /Pending enrollment mapping/i,
        },
        {
          label: 'keepUnmappedPending: false marks unmapped punches as unmapped ERROR',
          body: { keepUnmappedPending: false },
          expectedStatus: 'ERROR',
          expectedPendingCount: 0,
          expectedErrorCount: 1,
          expectedMessagePattern: /Unmapped biometric enrollment ID/i,
        },
        {
          label: 'omitted keepUnmappedPending preserves default PENDING behavior for unmapped punches',
          body: {},
          expectedStatus: 'PENDING',
          expectedPendingCount: 1,
          expectedErrorCount: 0,
          expectedMessagePattern: /Pending enrollment mapping/i,
        },
      ])(
        'enforces unmapped punch status end-to-end through syncTerminal -> triggerTerminalSync -> reconcilePendingPunches: $label',
        async ({
          body,
          expectedStatus,
          expectedPendingCount,
          expectedErrorCount,
          expectedMessagePattern,
        }) => {
          setupTerminalMocks();

          const rawPunchRecord = {
            id: 'punch-unmapped-1',
            companyId: 'comp-alpha',
            terminalId: 'term-alpha-1',
            userEnrollmentId: 'UNMAPPED-999',
            punchTime: new Date(),
            inOutMode: 'CHECK_IN',
            syncStatus: 'PENDING',
            matchedEmployeeId: null,
            matchedEmployee: null,
            errorMessage: null,
          };

          vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValue([
            { id: rawPunchRecord.id },
          ] as any);
          vi.spyOn(prisma, '$transaction').mockImplementation((async (cb: any) => cb(prisma)) as any);
          vi.spyOn(prisma.rawPunchLog, 'findUnique').mockResolvedValue(rawPunchRecord as any);
          vi.spyOn(BiometricMappingService, 'resolveEmployeeForPunch').mockResolvedValue({
            employee: null,
            matchedVia: null,
          });
          const rawPunchUpdateSpy = vi
            .spyOn(prisma.rawPunchLog, 'update')
            .mockImplementation((async ({ data }: any) => {
              Object.assign(rawPunchRecord, data);
              return rawPunchRecord;
            }) as any);

          const req = createMockRequest({
            params: { id: 'term-alpha-1' },
            body,
          });
          const res = createMockResponse();

          await BiometricController.syncTerminal(req, res as unknown as Response);

          expect(res.statusCode).toBe(200);
          expect(res.body.reconciliation.totalEvaluated).toBe(1);
          expect(res.body.reconciliation.pending).toBe(expectedPendingCount);
          expect(res.body.reconciliation.errors).toBe(expectedErrorCount);
          expect(res.body.reconciliation.results[0].status).toBe(expectedStatus);
          expect(res.body.reconciliation.results[0].message).toMatch(expectedMessagePattern);
          expect(rawPunchUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              where: { id: 'punch-unmapped-1' },
              data: expect.objectContaining({
                syncStatus: expectedStatus,
                errorMessage: expect.stringMatching(expectedMessagePattern),
              }),
            })
          );
        }
      );
    });
  });
});

describe('Step 3 Scope 5 — BiometricDevicesPage Historical Cutoff UI & Payload Helpers', () => {
  const adminUser: AuthUser = {
    id: 'user-admin-1',
    userId: 'user-admin-1',
    companyId: 'comp-alpha',
    role: 'ADMIN',
    fullName: 'Admin User',
    email: 'admin@alpha.test',
    isActive: true,
    tokenVersion: 1,
  };

  const companyProfile: CompanyProfile = {
    id: 'comp-alpha',
    code: 'ALPHA',
    name: 'Alpha Corp',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
  };

  it('omits fromPunchTime completely when the From Punch Date/Time input is blank', () => {
    const payload = buildBiometricSyncPayload({
      batchSize: 100,
      retryErrors: false,
      fromPunchDateTime: '',
      timezone: 'Asia/Kolkata',
    });

    expect('fromPunchTime' in payload).toBe(false);
    expect(payload.fromPunchTime).toBeUndefined();
    expect(payload.batchSize).toBe(100);
    expect(payload.retryErrors).toBe(false);
  });

  it('converts local From Punch Date/Time using company timezone and preserves targeted filters', () => {
    const payload = buildBiometricSyncPayload({
      batchSize: 200,
      retryErrors: true,
      terminalId: 'term-1',
      userEnrollmentId: ' 101 ',
      employeeId: 'emp-42',
      fromPunchDateTime: '2026-05-10T09:30',
      timezone: 'Asia/Kolkata',
    });

    // 2026-05-10 09:30 IST (+05:30) === 2026-05-10T04:00:00.000Z
    expect(payload).toEqual({
      batchSize: 200,
      retryErrors: true,
      terminalId: 'term-1',
      userEnrollmentId: '101',
      employeeId: 'emp-42',
      fromPunchTime: '2026-05-10T04:00:00.000Z',
    });
  });

  it('preserves YYYY-MM-DD date-only cutoff and rejects invalid dates in client helper', () => {
    expect(parseLocalHistoricalCutoffInput('2026-05-10', 'Asia/Kolkata')).toBe('2026-05-10');
    expect(parseLocalHistoricalCutoffInput('   ', 'Asia/Kolkata')).toBeUndefined();
    expect(() => parseLocalHistoricalCutoffInput('2026-02-30', 'Asia/Kolkata')).toThrow();
    expect(() => parseLocalHistoricalCutoffInput('2026-02-30T09:00', 'Asia/Kolkata')).toThrow();
  });

  it('locks batchSize to 1 when targeting a specific punchId and omits fromPunchTime when blank', () => {
    const payload = buildBiometricSyncPayload({
      batchSize: 250,
      retryErrors: false,
      punchId: 'punch-99',
      fromPunchDateTime: '',
      timezone: 'Asia/Kolkata',
    });

    expect(payload).toEqual({
      batchSize: 1,
      retryErrors: false,
      punchId: 'punch-99',
    });
    expect('fromPunchTime' in payload).toBe(false);
  });

  it('renders clear notice on BiometricDevicesPage that normal sync only processes current company-local day and never auto-processes historical PENDING punches', () => {
    const html = renderToStaticMarkup(
      React.createElement(BiometricDevicesPage, {
        currentUser: adminUser,
        companyProfile,
      })
    );

    expect(html).toContain('Normal Sync Today-Only Cutoff (Asia/Kolkata)');
    expect(html).toContain('Normal biometric sync processes only punches from the beginning of the current company-local day');
    expect(html).toContain('PENDING');
    expect(html).toContain('never processed automatically by normal sync');
    expect(html).toContain('From Punch Date/Time');
  });

  it('renders compact BiometricHistoricalCutoffNotice for manual reconciliation modal', () => {
    const html = renderToStaticMarkup(
      React.createElement(BiometricHistoricalCutoffNotice, {
        timezone: 'America/New_York',
        compact: true,
      })
    );

    expect(html).toContain('Normal Sync Today-Only Cutoff (America/New_York)');
    expect(html).toContain('never processed automatically by normal sync');
  });

  it('renders explicit confirmation banner before initiating an explicitly requested historical reconciliation', () => {
    const html = renderToStaticMarkup(
      React.createElement(BiometricHistoricalConfirmationBanner, {
        fromPunchDateTime: '2026-05-01T09:00',
        resolvedCutoffIso: '2026-05-01T03:30:00.000Z',
        timezone: 'Asia/Kolkata',
        isSubmitting: false,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      })
    );

    expect(html).toContain('Confirm Historical Punch Reconciliation');
    expect(html).toContain('2026-05-01T03:30:00.000Z');
    expect(html).toContain('Asia/Kolkata');
    expect(html).toContain('Confirm Historical Reconciliation');
    expect(html).toContain('Cancel');
  });
});
