import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { AuthUser, BiometricUserSyncJob } from '../../src/shared/types.js';
import { installUnitPrismaGuard } from '../helpers/unit-prisma-guard.js';
import { CheckpointStore } from '../../bridges/essl-x2008-bridge/src/checkpoint-store.js';
import { BiometricBridgeRunner } from '../../bridges/essl-x2008-bridge/src/bridge-runner.js';
import { BridgeLogger } from '../../bridges/essl-x2008-bridge/src/logger.js';
import { CoreErpApiError, ICoreErpClient } from '../../bridges/essl-x2008-bridge/src/coreerp-client.js';
import { BridgeInstanceLock, BridgeInstanceLockError } from '../../bridges/essl-x2008-bridge/src/instance-lock.js';
import {
  BridgeConfig,
  DeviceEnrolledUser,
  DeviceInfo,
  IBiometricProtocolAdapter,
} from '../../bridges/essl-x2008-bridge/src/types.js';

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTerminalRecord(overrides?: Partial<Record<string, unknown>>) {
  const apiKeyPlain = (overrides?.apiKeyPlain as string) || 'bio_live_test_secret_key_alpha_001';
  const apiKeyHash = crypto.createHash('sha256').update(apiKeyPlain).digest('hex');
  return {
    id: 'term-essl-main',
    companyId: 'company-alpha',
    deviceSerialNumber: 'NFZ8252800275',
    name: 'Main Entrance eSSL X2008',
    terminalModel: 'eSSL X2008',
    ipAddress: '192.168.1.201',
    port: 4370,
    location: 'Main Gate',
    apiKeyHash,
    apiKeyPrefix: apiKeyPlain.slice(0, 14),
    status: 'OFFLINE',
    lastHeartbeatAt: null as Date | null,
    lastSyncAt: null as Date | null,
    firmwareVersion: 'Ver 6.60 Apr 13 2022',
    registeredByUserId: 'user-sa-alpha',
    registeredByUser: { fullName: 'Alpha Super Admin' },
    isActive: true,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createBridgeConfig(tmpDir: string, overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    bridgeHost: 'WIN-OFFICE-01',
    bridgeVersion: '1.1.0-test',
    coreErpBaseUrl: 'http://127.0.0.1:3000',
    allowInsecureHttp: true,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 30_000,
    jobPollIntervalMs: 5_000,
    userSyncTimeoutMs: 5_000,
    connectTimeoutMs: 2_000,
    maxBackoffMs: 20_000,
    batchSize: 100,
    healthHost: '127.0.0.1',
    healthPort: 4379,
    dataDir: path.join(tmpDir, 'data'),
    logDir: path.join(tmpDir, 'logs'),
    logLevel: 'error',
    dpapiStorePath: path.join(tmpDir, 'data', 'credentials.dpapi.json'),
    terminals: [
      {
        id: 'essl-x2008-main',
        name: 'Main Gate X2008',
        serialNumber: 'NFZ8252800275',
        ipAddress: '192.168.1.201',
        port: 4370,
        commKey: 0,
        deviceTimezone: 'Asia/Kolkata',
        apiKey: 'bio_live_test_secret_key_alpha_001',
        enabled: true,
      },
    ],
    ...overrides,
  };
}

function createQuietLogger(logDir: string): BridgeLogger {
  return new BridgeLogger({ level: 'error', logDir, silentConsole: true });
}

describe('CoreERP Problem 2 — Automatic Biometric User Sync, Continuous Bridge & Windows Auto-Start', () => {
  const app = createApp();
  const tempDirs: string[] = [];

  const superAdminAlpha: AuthUser = {
    id: 'user-sa-alpha',
    userId: 'user-sa-alpha',
    companyId: 'company-alpha',
    email: 'admin@alpha.local',
    fullName: 'Alpha Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeAlpha: AuthUser = {
    id: 'user-emp-alpha',
    userId: 'user-emp-alpha',
    companyId: 'company-alpha',
    email: 'emp@alpha.local',
    fullName: 'Alpha Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const superAdminBeta: AuthUser = {
    id: 'user-sa-beta',
    userId: 'user-sa-beta',
    companyId: 'company-beta',
    email: 'admin@beta.local',
    fullName: 'Beta Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const signToken = (user: AuthUser) =>
    AuthService.generateSessionToken({
      userId: user.userId,
      companyId: user.companyId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    installUnitPrismaGuard();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  // =========================================================================
  // A. USER SYNC BACKEND API, LIFECYCLE, ISOLATION & TENANT SECURITY TESTS
  // =========================================================================
  describe('A. Backend User Sync Job Lifecycle, Isolation & Security', () => {
    it('A1. UI Sync Users click creates a QUEUED job, audits it, and NEVER triggers PunchReconciliationService', async () => {
      const term = makeTerminalRecord({ lastHeartbeatAt: new Date(), status: 'ONLINE' });
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(superAdminAlpha as any);
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(term as any);

      const res = await request(app)
        .post(`/api/biometric/devices/${term.id}/sync-users`)
        .set('Authorization', `Bearer ${signToken(superAdminAlpha)}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.bridgeUserSyncQueued).toBe(true);
      expect(res.body.deduplicated).toBe(false);
      expect(res.body.job).toBeDefined();
      expect(res.body.job.status).toBe('QUEUED');
      expect(res.body.job.jobId).toBeTruthy();
      expect(res.body.job.attempts).toBe(0);
      expect(res.body.job.maxAttempts).toBe(3);
      expect(res.body.job.timeoutAt).toBeTruthy();
      expect(res.body.terminal.userSyncStatus).toBe('QUEUED');
      expect(reconcileSpy).not.toHaveBeenCalled();

      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: 'company-alpha',
          action: 'BIOMETRIC_DEVICE_USER_SYNC_QUEUED',
          entityId: term.id,
        })
      );
    });

    it('A2. Duplicate UI click while QUEUED or RUNNING is idempotent and returns the same jobId', async () => {
      const term = makeTerminalRecord({ lastHeartbeatAt: new Date(), status: 'ONLINE' });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(superAdminAlpha as any);
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(term as any);

      const first = await request(app)
        .post(`/api/biometric/devices/${term.id}/sync-users`)
        .set('Authorization', `Bearer ${signToken(superAdminAlpha)}`)
        .send({});

      expect(first.status).toBe(200);
      expect(first.body.deduplicated).toBe(false);
      const originalJobId = first.body.job.jobId;

      const second = await request(app)
        .post(`/api/biometric/devices/${term.id}/sync-users`)
        .set('Authorization', `Bearer ${signToken(superAdminAlpha)}`)
        .send({});

      expect(second.status).toBe(200);
      expect(second.body.deduplicated).toBe(true);
      expect(second.body.job.jobId).toBe(originalJobId);
      expect(second.body.job.status).toBe('QUEUED');

      // Bridge claims it -> RUNNING; third click must STILL deduplicate
      const claim = await BiometricService.claimPendingUserSyncJob(term, {
        deviceSerialNumber: term.deviceSerialNumber,
        bridgeHost: 'WIN-HOST',
        bridgeVersion: '1.1.0',
      });
      expect(claim.claimed).toBe(true);
      expect(claim.job?.status).toBe('RUNNING');

      const third = await request(app)
        .post(`/api/biometric/devices/${term.id}/sync-users`)
        .set('Authorization', `Bearer ${signToken(superAdminAlpha)}`)
        .send({});

      expect(third.status).toBe(200);
      expect(third.body.deduplicated).toBe(true);
      expect(third.body.job.jobId).toBe(originalJobId);
      expect(third.body.job.status).toBe('RUNNING');
    });

    it('A3. Bridge atomically claims a QUEUED job and prevents double-claim while lease is active', async () => {
      const apiKey = 'bio_live_claim_secret_key_001';
      const term = makeTerminalRecord({ apiKeyPlain: apiKey });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(superAdminAlpha as any);
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(term as any);

      const queued = await BiometricService.triggerTerminalUserSync(superAdminAlpha, term.id);
      expect(queued.job.status).toBe('QUEUED');

      const claim1 = await request(app)
        .post('/api/biometric/users/jobs/claim')
        .set('X-Device-Api-Key', apiKey)
        .send({
          deviceSerialNumber: term.deviceSerialNumber,
          bridgeHost: 'WIN-BRIDGE-1',
          bridgeVersion: '1.1.0',
        });

      expect(claim1.status).toBe(200);
      expect(claim1.body.claimed).toBe(true);
      expect(claim1.body.job.jobId).toBe(queued.job.jobId);
      expect(claim1.body.job.status).toBe('RUNNING');
      expect(claim1.body.job.attempts).toBe(1);

      // Second concurrent claim must NOT steal active lease
      const claim2 = await request(app)
        .post('/api/biometric/users/jobs/claim')
        .set('X-Device-Api-Key', apiKey)
        .send({
          deviceSerialNumber: term.deviceSerialNumber,
          bridgeHost: 'WIN-BRIDGE-2',
          bridgeVersion: '1.1.0',
        });

      expect(claim2.status).toBe(200);
      expect(claim2.body.claimed).toBe(false);
      expect(claim2.body.job).toBeNull();
    });

    it('A4. Multi-terminal isolation: jobs and uploaded enrolled users stay strictly isolated per terminal', async () => {
      const termA = makeTerminalRecord({
        id: 'term-a',
        deviceSerialNumber: 'SN-A-001',
        name: 'Gate A',
        apiKeyPlain: 'bio_live_term_a_key_001',
      });
      const termB = makeTerminalRecord({
        id: 'term-b',
        deviceSerialNumber: 'SN-B-002',
        name: 'Gate B',
        apiKeyPlain: 'bio_live_term_b_key_002',
      });

      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockImplementation(((args: any) => {
        if (args?.where?.id === termA.id) return Promise.resolve(termA);
        if (args?.where?.id === termB.id) return Promise.resolve(termB);
        return Promise.resolve(null);
      }) as any);
      vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValue(termA as any);

      // Queue user sync on Terminal A ONLY
      const queueA = await BiometricService.triggerTerminalUserSync(superAdminAlpha, termA.id);
      expect(queueA.job.status).toBe('QUEUED');

      // Terminal B claiming should see NOTHING
      const claimB = await BiometricService.claimPendingUserSyncJob(termB, {
        deviceSerialNumber: termB.deviceSerialNumber,
        bridgeHost: 'WIN-HOST',
      });
      expect(claimB.claimed).toBe(false);

      // Terminal A claims and completes upload
      const claimA = await BiometricService.claimPendingUserSyncJob(termA, {
        deviceSerialNumber: termA.deviceSerialNumber,
        bridgeHost: 'WIN-HOST',
      });
      expect(claimA.claimed).toBe(true);

      const uploadA = await BiometricService.syncDeviceUsers(termA, {
        deviceSerialNumber: termA.deviceSerialNumber,
        jobId: claimA.job!.jobId,
        bridgeHost: 'WIN-HOST',
        bridgeVersion: '1.1.0',
        bridgeDaemonRunning: true,
        deviceUsers: [
          { uid: 1, enrollmentId: '101', name: 'Alice A', cardNo: null },
          { uid: 2, enrollmentId: '102', name: 'Bob A', cardNo: null },
        ],
      });
      expect(uploadA.success).toBe(true);
      expect(uploadA.syncedCount).toBe(2);
      expect(uploadA.job?.status).toBe('SUCCESS');

      const statusA = await BiometricService.getTerminalUserSyncStatus('company-alpha', termA.id);
      const statusB = await BiometricService.getTerminalUserSyncStatus('company-alpha', termB.id);

      expect(statusA.userSyncStatus).toBe('SUCCESS');
      expect(statusA.deviceUsers).toHaveLength(2);
      expect(statusB.userSyncStatus).toBe('IDLE');
      expect(statusB.deviceUsers).toHaveLength(0);
    });

    it('A5. Upload deduplicates users, marks job SUCCESS, and GET /user-sync-status returns updated state', async () => {
      const apiKey = 'bio_live_upload_secret_001';
      const term = makeTerminalRecord({ apiKeyPlain: apiKey, lastHeartbeatAt: new Date(), status: 'ONLINE' });
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(superAdminAlpha as any);
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(term as any);
      vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValue(term as any);

      const queued = await BiometricService.triggerTerminalUserSync(superAdminAlpha, term.id);
      const claimed = await BiometricService.claimPendingUserSyncJob(term, {
        deviceSerialNumber: term.deviceSerialNumber,
      });

      const uploadRes = await request(app)
        .post('/api/biometric/users')
        .set('X-Device-Api-Key', apiKey)
        .send({
          deviceSerialNumber: term.deviceSerialNumber,
          jobId: claimed.job!.jobId,
          bridgeHost: 'WIN-OFFICE-01',
          bridgeVersion: '1.1.0',
          bridgeDaemonRunning: true,
          deviceUsers: [
            { uid: 1, enrollmentId: '1', name: 'Ravi', cardNo: '111' },
            { uid: 2, enrollmentId: '1', name: 'Ravi Duplicate', cardNo: '111' },
            { uid: 3, enrollmentId: '2', name: 'Priya', cardNo: null },
          ],
        });

      expect(uploadRes.status).toBe(200);
      expect(uploadRes.body.success).toBe(true);
      expect(uploadRes.body.discoveredCount).toBe(3);
      expect(uploadRes.body.syncedCount).toBe(2);
      expect(uploadRes.body.job.status).toBe('SUCCESS');
      expect(uploadRes.body.job.jobId).toBe(queued.job.jobId);
      expect(reconcileSpy).not.toHaveBeenCalled();

      const statusRes = await request(app)
        .get(`/api/biometric/devices/${term.id}/user-sync-status`)
        .set('Authorization', `Bearer ${signToken(superAdminAlpha)}`);

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.userSyncStatus).toBe('SUCCESS');
      expect(statusRes.body.bridgeStatus).toBe('ONLINE');
      expect(statusRes.body.deviceConnectionStatus).toBe('CONNECTED');
      expect(statusRes.body.deviceUsers).toHaveLength(2);
    });

    it('A6. Retry & terminal failure behavior: retryable failures requeue up to maxAttempts, non-retryable fails immediately, secrets redacted', async () => {
      const apiKey = 'bio_live_retry_secret_001';
      const term = makeTerminalRecord({ apiKeyPlain: apiKey });

      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(term as any);
      vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValue(term as any);

      const queued = await BiometricService.triggerTerminalUserSync(superAdminAlpha, term.id);
      const jobId = queued.job.jobId;

      // Attempt 1: claim -> transient failure -> requeued to QUEUED
      const c1 = await BiometricService.claimPendingUserSyncJob(term, {
        deviceSerialNumber: term.deviceSerialNumber,
      });
      expect(c1.claimed).toBe(true);
      expect(c1.job!.attempts).toBe(1);

      const f1 = await request(app)
        .post('/api/biometric/users/jobs/fail')
        .set('X-Device-Api-Key', apiKey)
        .send({
          deviceSerialNumber: term.deviceSerialNumber,
          jobId,
          error: 'TCP ETIMEDOUT with leaked key bio_live_should_be_redacted_12345',
          retryable: true,
          deviceReachable: false,
        });

      expect(f1.status).toBe(200);
      expect(f1.body.success).toBe(true);
      expect(f1.body.job.status).toBe('QUEUED');
      expect(f1.body.job.error).not.toContain('bio_live_should_be_redacted_12345');

      // Attempt 2: claim -> non-retryable failure -> immediate FAILED
      const c2 = await BiometricService.claimPendingUserSyncJob(term, {
        deviceSerialNumber: term.deviceSerialNumber,
      });
      expect(c2.claimed).toBe(true);
      expect(c2.job!.attempts).toBe(2);

      const f2 = await BiometricService.reportUserSyncJobFailure(term, {
        deviceSerialNumber: term.deviceSerialNumber,
        jobId,
        error: 'Hardware serial mismatch',
        retryable: false,
        deviceReachable: false,
      });

      expect(f2.success).toBe(true);
      expect(f2.job?.status).toBe('FAILED');
      expect(f2.job?.completedAt).toBeTruthy();

      const status = await BiometricService.getTerminalUserSyncStatus('company-alpha', term.id);
      expect(status.userSyncStatus).toBe('FAILED');
      expect(status.deviceConnectionStatus).toBe('DISCONNECTED');
    });

    it('A7. Expired QUEUED/RUNNING job automatically evaluates as FAILED on timeout', async () => {
      const expiredQueued: BiometricUserSyncJob = {
        jobId: 'job-expired-1',
        status: 'QUEUED',
        requestedAt: '2026-01-01T00:00:00.000Z',
        requestedByUserId: 'user-sa-alpha',
        startedAt: null,
        completedAt: null,
        timeoutAt: '2026-01-01T00:02:00.000Z',
        attempts: 0,
        maxAttempts: 3,
        discoveredCount: null,
        syncedCount: null,
        error: null,
        bridgeHost: null,
      };

      const evaluated = BiometricService.evaluateUserSyncJob(
        expiredQueued,
        Date.parse('2026-01-01T00:05:00.000Z')
      );
      expect(evaluated?.status).toBe('FAILED');
      expect(evaluated?.completedAt).toBeTruthy();
      expect(evaluated?.error).toContain('timed out');
    });

    it('A8. Accurate separation of Bridge ONLINE/OFFLINE vs Physical Device CONNECTED/DISCONNECTED and one-shot CLI safety', async () => {
      const term = makeTerminalRecord();
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(term as any);
      vi.spyOn(prisma.biometricTerminal, 'update').mockImplementation(((args: any) =>
        Promise.resolve({
          ...term,
          status: args?.data?.status || term.status,
          lastHeartbeatAt: args?.data?.lastHeartbeatAt || term.lastHeartbeatAt,
        })) as any);

      // 1. Fresh heartbeat with deviceReachable: false -> Bridge ONLINE, Device DISCONNECTED, terminal status OFFLINE
      const hb = await BiometricService.recordHeartbeat(term, {
        deviceSerialNumber: term.deviceSerialNumber,
        bridgeHost: 'WIN-HOST',
        bridgeVersion: '1.1.0',
        bridgePid: 4321,
        deviceReachable: false,
        lastConnectionError: 'TCP ECONNREFUSED 192.168.1.201:4370',
      });

      expect(hb.bridgeStatus).toBe('ONLINE');
      expect(hb.deviceConnectionStatus).toBe('DISCONNECTED');
      expect(hb.status).toBe('ERROR');

      // 2. Stale/no heartbeat on a fresh terminal -> Bridge OFFLINE, Device DISCONNECTED
      const termOffline = makeTerminalRecord({
        id: 'term-offline',
        lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000),
      });
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValueOnce(termOffline as any);
      const offlineStatus = await BiometricService.getTerminalUserSyncStatus('company-alpha', termOffline.id);
      expect(offlineStatus.bridgeStatus).toBe('OFFLINE');
      expect(offlineStatus.deviceConnectionStatus).toBe('DISCONNECTED');

      // 3. One-shot CLI user sync (bridgeDaemonRunning: false) must NOT falsely report bridge ONLINE
      const termOneShot = makeTerminalRecord({ id: 'term-oneshot', lastHeartbeatAt: null, status: 'OFFLINE' });
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(termOneShot as any);
      vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValue(termOneShot as any);

      await BiometricService.syncDeviceUsers(termOneShot, {
        deviceSerialNumber: termOneShot.deviceSerialNumber,
        bridgeHost: 'WIN-HOST',
        bridgeDaemonRunning: false,
        deviceUsers: [{ uid: 5, enrollmentId: '5', name: 'OneShot User', cardNo: null }],
      });

      const oneShotStatus = await BiometricService.getTerminalUserSyncStatus('company-alpha', termOneShot.id);
      expect(oneShotStatus.bridgeStatus).toBe('OFFLINE');
      expect(oneShotStatus.terminal.bridgeConnected).toBe(false);
      expect(oneShotStatus.deviceUsers).toHaveLength(1);
    });

    it('A9. Enforces tenant isolation (404), RBAC (403 for EMPLOYEE), and serial mismatch rejection (403)', async () => {
      const apiKey = 'bio_live_sec_test_key_001';
      const termAlpha = makeTerminalRecord({ apiKeyPlain: apiKey });

      // EMPLOYEE cannot trigger sync-users or read user-sync-status
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(employeeAlpha as any);
      const empSync = await request(app)
        .post(`/api/biometric/devices/${termAlpha.id}/sync-users`)
        .set('Authorization', `Bearer ${signToken(employeeAlpha)}`)
        .send({});
      expect(empSync.status).toBe(403);

      const empStatus = await request(app)
        .get(`/api/biometric/devices/${termAlpha.id}/user-sync-status`)
        .set('Authorization', `Bearer ${signToken(employeeAlpha)}`);
      expect(empStatus.status).toBe(403);

      // Tenant Beta SUPER_ADMIN cannot access Tenant Alpha terminal
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(superAdminBeta as any);
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(null);
      const crossTenantRes = await request(app)
        .get(`/api/biometric/devices/${termAlpha.id}/user-sync-status`)
        .set('Authorization', `Bearer ${signToken(superAdminBeta)}`);
      expect(crossTenantRes.status).toBe(404);

      // Device serial mismatch rejected with 403 on claim and fail
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue(termAlpha as any);
      const badClaim = await request(app)
        .post('/api/biometric/users/jobs/claim')
        .set('X-Device-Api-Key', apiKey)
        .send({ deviceSerialNumber: 'WRONG-SERIAL-999' });
      expect(badClaim.status).toBe(403);

      const badFail = await request(app)
        .post('/api/biometric/users/jobs/fail')
        .set('X-Device-Api-Key', apiKey)
        .send({ deviceSerialNumber: 'WRONG-SERIAL-999', jobId: 'any', error: 'err' });
      expect(badFail.status).toBe(403);
    });
  });

  // =========================================================================
  // B. CONTINUOUS BRIDGE DAEMON, ISOLATION, SELF-RECOVERY & LOCK TESTS
  // =========================================================================
  describe('B. Continuous Bridge Daemon, Strict User-Sync Isolation & Self-Recovery', () => {
    function makeMockAdapter(overrides?: Partial<IBiometricProtocolAdapter>): IBiometricProtocolAdapter {
      const defaultInfo: DeviceInfo = {
        serialNumber: 'NFZ8252800275',
        firmwareVersion: 'Ver 6.60 Apr 13 2022',
        platform: 'ZLM60_TFT',
        fingerprintAlgorithm: 'VX10.0',
        deviceName: 'eSSL X2008',
        oemVendor: 'eSSL',
      };
      const defaultUsers: DeviceEnrolledUser[] = [
        { uid: 1, enrollmentId: '1', name: 'Alice', cardNo: '1001' },
        { uid: 2, enrollmentId: '2', name: 'Bob', cardNo: '1002' },
      ];
      return {
        protocolName: 'MOCK_ZK_TCP',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getDeviceInfo: vi.fn().mockResolvedValue(defaultInfo),
        getAttendanceLogs: vi.fn().mockResolvedValue([]),
        getUsers: vi.fn().mockResolvedValue(defaultUsers),
        ...overrides,
      };
    }

    function makeMockCoreErpClient(overrides?: Partial<ICoreErpClient>): ICoreErpClient {
      return {
        sendHeartbeat: vi.fn().mockResolvedValue({
          success: true,
          terminalId: 'term-essl-main',
          status: 'ONLINE',
          bridgeStatus: 'ONLINE',
          deviceConnectionStatus: 'CONNECTED',
          lastHeartbeatAt: new Date().toISOString(),
          syncRequestedAt: null,
          userSyncRequestedAt: null,
          pendingUserSyncJob: null,
        }),
        submitPunches: vi.fn().mockResolvedValue({
          success: true,
          totalReceived: 0,
          inserted: 0,
          duplicates: 0,
          unmappedEmployees: 0,
          terminalId: 'term-essl-main',
          terminalName: 'Main Gate X2008',
        }),
        syncUsers: vi.fn().mockResolvedValue({
          success: true,
          terminalId: 'term-essl-main',
          terminalName: 'Main Gate X2008',
          discoveredCount: 2,
          syncedCount: 2,
          syncedAt: new Date().toISOString(),
        }),
        claimUserSyncJob: vi.fn().mockResolvedValue({
          claimed: false,
          terminalId: 'term-essl-main',
          job: null,
        }),
        reportUserSyncJobFailure: vi.fn().mockResolvedValue({
          success: true,
          terminalId: 'term-essl-main',
          job: null,
        }),
        ...overrides,
      };
    }

    it('B1. Strict User-Sync Isolation: bridge user-sync job calls getUsers + syncUsers ONLY, NEVER getAttendanceLogs/submitPunches, and preserves punch checkpoints', async () => {
      const tmpDir = makeTempDir('coreerp-bridge-iso-');
      tempDirs.push(tmpDir);
      const cfg = createBridgeConfig(tmpDir);
      const logger = createQuietLogger(cfg.logDir);
      const checkpointStore = new CheckpointStore(cfg.dataDir);

      // Seed existing punch checkpoint state that MUST remain completely untouched
      const seededPunch = {
        devicePunchId: 'NFZ8252800275:1:2026-04-01 09:00:00:CHECK_IN',
        userEnrollmentId: '1',
        punchTime: '2026-04-01T03:30:00.000Z',
        verifyType: 'FINGERPRINT' as const,
        inOutMode: 'CHECK_IN' as const,
      };
      checkpointStore.enqueuePending('essl-x2008-main', 'NFZ8252800275', [seededPunch]);
      checkpointStore.markBatchAcknowledged('essl-x2008-main', 'NFZ8252800275', [seededPunch]);
      const beforeCp = JSON.parse(
        JSON.stringify(checkpointStore.getTerminal('essl-x2008-main', 'NFZ8252800275'))
      );

      const adapter = makeMockAdapter();
      const claimJob: BiometricUserSyncJob = {
        jobId: 'job-iso-001',
        status: 'RUNNING',
        requestedAt: new Date().toISOString(),
        requestedByUserId: 'user-sa-alpha',
        startedAt: new Date().toISOString(),
        completedAt: null,
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
        attempts: 1,
        maxAttempts: 3,
        discoveredCount: null,
        syncedCount: null,
        error: null,
        bridgeHost: 'WIN-OFFICE-01',
      };

      const coreErpClient = makeMockCoreErpClient({
        claimUserSyncJob: vi
          .fn()
          .mockResolvedValueOnce({ claimed: true, terminalId: 'term-essl-main', job: claimJob })
          .mockResolvedValue({ claimed: false, terminalId: 'term-essl-main', job: null }),
      });

      const runner = new BiometricBridgeRunner({
        config: cfg,
        logger,
        checkpointStore,
        coreErpClient,
        adapterFactory: () => adapter,
      });

      const syncOnceSpy = vi.spyOn(runner, 'syncTerminalOnce');
      const claimed = await runner.pollPendingUserSyncJob('essl-x2008-main');
      expect(claimed).toBe(true);

      expect(adapter.getUsers).toHaveBeenCalledTimes(1);
      expect(coreErpClient.syncUsers).toHaveBeenCalledTimes(1);
      expect(coreErpClient.syncUsers).toHaveBeenCalledWith(
        'bio_live_test_secret_key_alpha_001',
        'NFZ8252800275',
        expect.objectContaining({
          jobId: 'job-iso-001',
          bridgeDaemonRunning: true,
          deviceUsers: expect.arrayContaining([
            expect.objectContaining({ enrollmentId: '1', name: 'Alice' }),
          ]),
        })
      );

      // Strict isolation assertions
      expect(adapter.getAttendanceLogs).not.toHaveBeenCalled();
      expect(coreErpClient.submitPunches).not.toHaveBeenCalled();
      expect(syncOnceSpy).not.toHaveBeenCalled();

      const afterCp = checkpointStore.getTerminal('essl-x2008-main', 'NFZ8252800275');
      expect(afterCp.lastSyncedPunchTimeIso).toBe(beforeCp.lastSyncedPunchTimeIso);
      expect(afterCp.recentPunchIds).toEqual(beforeCp.recentPunchIds);
      expect(afterCp.pendingQueue).toEqual(beforeCp.pendingQueue);
    });

    it('B2. Continuous daemon stays running after completing a user-sync job and shuts down gracefully', async () => {
      const tmpDir = makeTempDir('coreerp-bridge-daemon-');
      tempDirs.push(tmpDir);
      const cfg = createBridgeConfig(tmpDir, {
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        jobPollIntervalMs: 50,
      });
      const logger = createQuietLogger(cfg.logDir);
      const checkpointStore = new CheckpointStore(cfg.dataDir);
      const adapter = makeMockAdapter();

      let jobServed = false;
      const coreErpClient = makeMockCoreErpClient({
        claimUserSyncJob: vi.fn().mockImplementation(async () => {
          if (!jobServed) {
            jobServed = true;
            return {
              claimed: true,
              terminalId: 'term-essl-main',
              job: {
                jobId: 'job-continuous-1',
                status: 'RUNNING',
                requestedAt: new Date().toISOString(),
                requestedByUserId: 'u1',
                startedAt: new Date().toISOString(),
                completedAt: null,
                timeoutAt: new Date(Date.now() + 60_000).toISOString(),
                attempts: 1,
                maxAttempts: 3,
                discoveredCount: null,
                syncedCount: null,
                error: null,
                bridgeHost: 'WIN-OFFICE-01',
              },
            };
          }
          return { claimed: false, terminalId: 'term-essl-main', job: null };
        }),
      });

      const runner = new BiometricBridgeRunner({
        config: cfg,
        logger,
        checkpointStore,
        coreErpClient,
        adapterFactory: () => adapter,
      });

      await runner.start();
      await new Promise((r) => setTimeout(r, 250));

      const snapshotDuring = runner.getStatusSnapshot();
      expect(snapshotDuring.running).toBe(true);
      expect(snapshotDuring.pid).toBe(process.pid);
      expect(jobServed).toBe(true);
      expect(coreErpClient.syncUsers).toHaveBeenCalled();
      expect(snapshotDuring.terminals[0].userSyncJobStatus).toBe('SUCCESS');

      await runner.stop(2000);
      const snapshotAfter = runner.getStatusSnapshot();
      expect(snapshotAfter.running).toBe(false);
    });

    it('B3. User-sync job timeout on hung device aborts and reports retryable failure to CoreERP', async () => {
      const tmpDir = makeTempDir('coreerp-bridge-timeout-');
      tempDirs.push(tmpDir);
      const cfg = createBridgeConfig(tmpDir, {
        userSyncTimeoutMs: 60,
      });
      const logger = createQuietLogger(cfg.logDir);
      const checkpointStore = new CheckpointStore(cfg.dataDir);
      const hungAdapter = makeMockAdapter({
        getUsers: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      const coreErpClient = makeMockCoreErpClient({
        claimUserSyncJob: vi.fn().mockResolvedValueOnce({
          claimed: true,
          terminalId: 'term-essl-main',
          job: {
            jobId: 'job-hung-1',
            status: 'RUNNING',
            requestedAt: new Date().toISOString(),
            requestedByUserId: 'u1',
            startedAt: new Date().toISOString(),
            completedAt: null,
            timeoutAt: new Date(Date.now() + 60_000).toISOString(),
            attempts: 1,
            maxAttempts: 3,
            discoveredCount: null,
            syncedCount: null,
            error: null,
            bridgeHost: 'WIN-OFFICE-01',
          },
        }),
      });

      const runner = new BiometricBridgeRunner({
        config: cfg,
        logger,
        checkpointStore,
        coreErpClient,
        adapterFactory: () => hungAdapter,
      });

      await runner.pollPendingUserSyncJob('essl-x2008-main');
      expect(coreErpClient.reportUserSyncJobFailure).toHaveBeenCalledWith(
        'bio_live_test_secret_key_alpha_001',
        'NFZ8252800275',
        expect.objectContaining({
          jobId: 'job-hung-1',
          retryable: true,
          deviceReachable: false,
        })
      );
      const status = runner.getStatusSnapshot().terminals[0];
      expect(status.userSyncJobStatus).toBe('FAILED');
      expect(status.lastUserSyncError).toContain('timed out');
    });

    it('B4. Device TCP outage & recovery: bridge stays alive, reports deviceReachable=false then recovers', async () => {
      const tmpDir = makeTempDir('coreerp-bridge-dev-outage-');
      tempDirs.push(tmpDir);
      const cfg = createBridgeConfig(tmpDir);
      const logger = createQuietLogger(cfg.logDir);
      const checkpointStore = new CheckpointStore(cfg.dataDir);

      let deviceOnline = false;
      const flakyAdapter = makeMockAdapter({
        connect: vi.fn().mockImplementation(async () => {
          if (!deviceOnline) throw new Error('ECONNREFUSED 192.168.1.201:4370');
        }),
      });
      const coreErpClient = makeMockCoreErpClient();

      const runner = new BiometricBridgeRunner({
        config: cfg,
        logger,
        checkpointStore,
        coreErpClient,
        adapterFactory: () => flakyAdapter,
      });

      // Outage phase
      await expect(runner.syncTerminalUsersOnce('essl-x2008-main')).rejects.toThrow(/ECONNREFUSED/);
      expect(runner.getStatusSnapshot().terminals[0].deviceReachable).toBe(false);

      await runner.sendTerminalHeartbeat('essl-x2008-main');
      expect(coreErpClient.sendHeartbeat).toHaveBeenLastCalledWith(
        'bio_live_test_secret_key_alpha_001',
        'NFZ8252800275',
        expect.objectContaining({
          deviceReachable: false,
          bridgePid: process.pid,
        })
      );

      // Recovery phase
      deviceOnline = true;
      const recovered = await runner.syncTerminalUsersOnce('essl-x2008-main');
      expect(recovered.discoveredCount).toBe(2);
      expect(runner.getStatusSnapshot().terminals[0].deviceReachable).toBe(true);
      expect(runner.getStatusSnapshot().terminals[0].lastDeviceContactAt).toBeTruthy();

      await runner.sendTerminalHeartbeat('essl-x2008-main');
      expect(coreErpClient.sendHeartbeat).toHaveBeenLastCalledWith(
        'bio_live_test_secret_key_alpha_001',
        'NFZ8252800275',
        expect.objectContaining({
          deviceReachable: true,
        })
      );
    });

    it('B5. CoreERP API outage & recovery: tracks heartbeatConsecutiveFailures and reconnects cleanly', async () => {
      const tmpDir = makeTempDir('coreerp-bridge-api-outage-');
      tempDirs.push(tmpDir);
      const cfg = createBridgeConfig(tmpDir);
      const logger = createQuietLogger(cfg.logDir);
      const checkpointStore = new CheckpointStore(cfg.dataDir);

      let apiAvailable = false;
      const coreErpClient = makeMockCoreErpClient({
        sendHeartbeat: vi.fn().mockImplementation(async () => {
          if (!apiAvailable) {
            throw new CoreErpApiError('CoreERP unreachable', 503, 'SERVICE_UNAVAILABLE');
          }
          return {
            success: true,
            terminalId: 'term-essl-main',
            status: 'ONLINE',
            lastHeartbeatAt: new Date().toISOString(),
            syncRequestedAt: null,
            userSyncRequestedAt: null,
            pendingUserSyncJob: null,
          };
        }),
      });

      const runner = new BiometricBridgeRunner({
        config: cfg,
        logger,
        checkpointStore,
        coreErpClient,
        adapterFactory: () => makeMockAdapter(),
      });

      // Outage: two failed heartbeats
      await runner.sendTerminalHeartbeat('essl-x2008-main');
      await runner.sendTerminalHeartbeat('essl-x2008-main');
      const duringOutage = runner.getStatusSnapshot().terminals[0];
      expect(duringOutage.bridgeConnected).toBe(false);
      expect(duringOutage.heartbeatConsecutiveFailures).toBe(2);

      // Recovery
      apiAvailable = true;
      await runner.sendTerminalHeartbeat('essl-x2008-main');
      const afterRecovery = runner.getStatusSnapshot().terminals[0];
      expect(afterRecovery.bridgeConnected).toBe(true);
      expect(afterRecovery.heartbeatConsecutiveFailures).toBe(0);
    });

    it('B6. Restart & sleep/wake recovery preserves checkpoints.json without deletion or reset', async () => {
      const tmpDir = makeTempDir('coreerp-bridge-restart-');
      tempDirs.push(tmpDir);
      const cfg = createBridgeConfig(tmpDir, { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000 });
      const logger = createQuietLogger(cfg.logDir);

      const store1 = new CheckpointStore(cfg.dataDir);
      store1.enqueuePending('essl-x2008-main', 'NFZ8252800275', [
        {
          devicePunchId: 'NFZ8252800275:7:2026-04-02 08:55:00:CHECK_IN',
          userEnrollmentId: '7',
          punchTime: '2026-04-02T03:25:00.000Z',
          verifyType: 'FINGERPRINT',
          inOutMode: 'CHECK_IN',
        },
      ]);
      store1.persist();

      // Simulate restart loading same dataDir
      const store2 = new CheckpointStore(cfg.dataDir);
      const loaded = store2.getTerminal('essl-x2008-main', 'NFZ8252800275');
      expect(loaded.pendingQueue).toHaveLength(1);
      expect(loaded.pendingQueue[0].devicePunchId).toBe('NFZ8252800275:7:2026-04-02 08:55:00:CHECK_IN');

      // Keep adapter disconnected during wake test so poll doesn't drain pendingQueue; verify checkpoint untouched
      const coreErpClient = makeMockCoreErpClient();
      const runner = new BiometricBridgeRunner({
        config: cfg,
        logger,
        checkpointStore: store2,
        coreErpClient,
        adapterFactory: () =>
          makeMockAdapter({
            connect: vi.fn().mockRejectedValue(new Error('device sleeping')),
          }),
      });

      await runner.start();
      runner.triggerImmediateRecoveryAll();
      await new Promise((r) => setTimeout(r, 80));
      await runner.stop(2000);

      // Re-verify persisted checkpoint file still contains the queued punch
      const store3 = new CheckpointStore(cfg.dataDir);
      const afterWake = store3.getTerminal('essl-x2008-main', 'NFZ8252800275');
      expect(afterWake.pendingQueue).toHaveLength(1);
    });

    it('B7. Multi-terminal concurrent bridge operation isolates terminal jobs and runtime state', async () => {
      const tmpDir = makeTempDir('coreerp-bridge-multi-');
      tempDirs.push(tmpDir);
      const cfg = createBridgeConfig(tmpDir, {
        terminals: [
          {
            id: 'term-1',
            name: 'Gate 1',
            serialNumber: 'SN-MULTI-1',
            ipAddress: '192.168.1.201',
            port: 4370,
            commKey: 0,
            deviceTimezone: 'Asia/Kolkata',
            apiKey: 'bio_live_multi_key_1',
            enabled: true,
          },
          {
            id: 'term-2',
            name: 'Gate 2',
            serialNumber: 'SN-MULTI-2',
            ipAddress: '192.168.1.202',
            port: 4370,
            commKey: 0,
            deviceTimezone: 'Asia/Kolkata',
            apiKey: 'bio_live_multi_key_2',
            enabled: true,
          },
        ],
      });
      const logger = createQuietLogger(cfg.logDir);
      const checkpointStore = new CheckpointStore(cfg.dataDir);

      const coreErpClient = makeMockCoreErpClient({
        claimUserSyncJob: vi.fn().mockImplementation(async (apiKey: string) => {
          if (apiKey === 'bio_live_multi_key_2') {
            return {
              claimed: true,
              terminalId: 'term-2',
              job: {
                jobId: 'job-term-2',
                status: 'RUNNING',
                requestedAt: new Date().toISOString(),
                requestedByUserId: 'u1',
                startedAt: new Date().toISOString(),
                completedAt: null,
                timeoutAt: new Date(Date.now() + 60_000).toISOString(),
                attempts: 1,
                maxAttempts: 3,
                discoveredCount: null,
                syncedCount: null,
                error: null,
                bridgeHost: 'WIN-OFFICE-01',
              },
            };
          }
          return { claimed: false, terminalId: 'term-1', job: null };
        }),
      });

      const runner = new BiometricBridgeRunner({
        config: cfg,
        logger,
        checkpointStore,
        coreErpClient,
        adapterFactory: (term) =>
          makeMockAdapter({
            getDeviceInfo: vi.fn().mockResolvedValue({
              serialNumber: term.serialNumber,
              firmwareVersion: 'Ver 6.60',
              platform: 'ZLM60_TFT',
              fingerprintAlgorithm: 'VX10.0',
              deviceName: 'eSSL X2008',
              oemVendor: 'eSSL',
            }),
            getUsers: vi.fn().mockResolvedValue([
              { uid: term.id === 'term-2' ? 22 : 11, enrollmentId: term.id === 'term-2' ? '22' : '11', name: `User-${term.id}`, cardNo: null },
            ]),
          }),
      });

      const r1 = await runner.pollPendingUserSyncJob('term-1');
      const r2 = await runner.pollPendingUserSyncJob('term-2');
      expect(r1).toBe(false);
      expect(r2).toBe(true);
      expect(coreErpClient.syncUsers).toHaveBeenCalledTimes(1);
      expect(coreErpClient.syncUsers).toHaveBeenCalledWith(
        'bio_live_multi_key_2',
        'SN-MULTI-2',
        expect.objectContaining({
          jobId: 'job-term-2',
          deviceUsers: [expect.objectContaining({ enrollmentId: '22', name: 'User-term-2' })],
        })
      );
    });

    it('B8. Single-instance PID lockfile prevents duplicate daemons and recovers from stale lockfiles', () => {
      const tmpDir = makeTempDir('coreerp-bridge-lock-');
      tempDirs.push(tmpDir);
      const dataDir = path.join(tmpDir, 'data');

      // 1. Live lock blocks second acquirer
      const lock1 = new BridgeInstanceLock(dataDir, { isPidAlive: () => true });
      const meta = lock1.acquire({ host: 'WIN-OFFICE-01' });
      expect(meta.pid).toBe(process.pid);
      expect(lock1.isAcquired()).toBe(true);

      // Write another live PID to simulate a second independent process
      fs.writeFileSync(
        lock1.getLockFilePath(),
        JSON.stringify({ pid: 999999, host: 'WIN-OFFICE-01', startedAt: new Date().toISOString(), workDir: tmpDir }),
        'utf8'
      );

      const lock2 = new BridgeInstanceLock(dataDir, { isPidAlive: (pid) => pid === 999999 });
      expect(() => lock2.acquire({ host: 'WIN-OFFICE-01' })).toThrow(BridgeInstanceLockError);

      // 2. Stale (dead) PID is cleaned up automatically
      const lock3 = new BridgeInstanceLock(dataDir, { isPidAlive: () => false });
      const recovered = lock3.acquire({ host: 'WIN-OFFICE-01' });
      expect(recovered.pid).toBe(process.pid);
      expect(lock3.isAcquired()).toBe(true);

      lock3.release();
      expect(fs.existsSync(lock3.getLockFilePath())).toBe(false);
    });
  });

  // =========================================================================
  // C. WINDOWS AUTO-START & DPAPI CURRENTUSER STATIC VERIFICATION TESTS
  // =========================================================================
  describe('C. Windows Auto-Start, Supervisor & DPAPI CurrentUser Script Verification', () => {
    const scriptsDir = path.resolve(process.cwd(), 'bridges', 'essl-x2008-bridge', 'scripts');

    it('C1. install-task-scheduler.ps1 runs under CurrentUser Interactive logon, rejects SYSTEM, uses absolute paths and prevents duplicates', () => {
      const content = fs.readFileSync(path.join(scriptsDir, 'install-task-scheduler.ps1'), 'utf8');
      expect(content).toContain('$env:USERDOMAIN\\$env:USERNAME');
      expect(content).toContain('-LogonType Interactive');
      expect(content).toContain('-AtLogOn');
      expect(content).toContain('-MultipleInstances IgnoreNew');
      expect(content).toContain('-WorkingDirectory $BridgeRoot');
      expect(content).toMatch(/SYSTEM|LocalSystem/);
      expect(content).toContain('run-bridge-supervised.ps1');
      // Must never pass raw API keys or secrets in Scheduled Task arguments
      expect(content).not.toMatch(/bio_live_/);
      expect(content).not.toMatch(/X-Device-Api-Key/i);
    });

    it('C2. run-bridge-supervised.ps1 enforces single-instance Windows Mutex, exponential crash backoff, and log redaction', () => {
      const content = fs.readFileSync(path.join(scriptsDir, 'run-bridge-supervised.ps1'), 'utf8');
      expect(content).toContain('System.Threading.Mutex');
      expect(content).toContain('Local\\CoreERPBiometricBridge_');
      expect(content).toContain('MaxRestartDelaySeconds');
      expect(content).toContain('HealthyUptimeResetSeconds');
      expect(content).toContain('bio_live_');
      expect(content).toContain('Set-Location $ResolvedRoot');
    });

    it('C3. uninstall-bridge.ps1, start-bridge.ps1, stop-bridge.ps1 preserve data/checkpoints & credentials and protect-credentials.ps1 defaults to CurrentUser', () => {
      const uninstall = fs.readFileSync(path.join(scriptsDir, 'uninstall-bridge.ps1'), 'utf8');
      const startScript = fs.readFileSync(path.join(scriptsDir, 'start-bridge.ps1'), 'utf8');
      const stopScript = fs.readFileSync(path.join(scriptsDir, 'stop-bridge.ps1'), 'utf8');
      const protectScript = fs.readFileSync(path.join(scriptsDir, 'protect-credentials.ps1'), 'utf8');

      expect(uninstall).toContain('Unregister-ScheduledTask');
      expect(uninstall).toContain('bridge.lock.json');
      expect(uninstall).not.toMatch(/Remove-Item[^\r\n]*(checkpoints\.json|credentials\.dpapi\.json)/i);
      expect(stopScript).not.toMatch(/Remove-Item[^\r\n]*(checkpoints\.json|credentials\.dpapi\.json)/i);
      expect(startScript).toContain('dist');
      expect(protectScript).toMatch(/\$Scope\s*=\s*"CurrentUser"/);
    });
  });
});
